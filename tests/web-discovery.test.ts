import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { discoverGroup } from '../src/discover.ts';
import { createWebDiscovery } from '../src/web-discovery.ts';

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(join(parent, 'web-discovery-'));
  t.after(async () => {
    const part = relative(parent, cwd); assert.ok(part && !part.startsWith('..'));
    await rm(cwd, { recursive: true, force: true });
  });
  return cwd;
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function simulated(autoFinish = true) {
  const runs: Array<{ cwd: string; signal: AbortSignal; emit(line: string): void; finish(code?: number): void; fail(error: unknown): void }> = [];
  const discover: typeof discoverGroup = (cwd, options = {}) => {
    const result = deferred<number>();
    const signal = options.signal!;
    const aborted = () => { if (autoFinish) result.resolve(0); };
    signal.addEventListener('abort', aborted, { once: true });
    runs.push({ cwd, signal, emit: line => options.output!(line), finish: (code = 0) => result.resolve(code), fail: result.reject });
    if (signal.aborted) aborted();
    return result.promise.finally(() => signal.removeEventListener('abort', aborted));
  };
  return { runs, discover };
}

const metadata = (type: 'group' | 'private', id: string) => JSON.stringify({ conversationKey: `${type}:${id}`, userId: 'Synthetic_Member' });

test('snapshots do not start discovery and repeated explicit starts share one run per directory', async t => {
  const cwd = await fixture(t), fake = simulated();
  const discovery = createWebDiscovery({ discover: fake.discover }); t.after(() => discovery.close());
  assert.deepEqual(discovery.snapshot(cwd), { state: 'idle', conversations: [] });
  assert.equal(fake.runs.length, 0);
  const starts = await Promise.all([discovery.start(cwd), discovery.start(join(cwd, '.'))]);
  assert.ok(starts.every(value => value.state === 'connecting'));
  assert.equal(fake.runs.length, 1);
  assert.equal(fake.runs[0]!.cwd, cwd);
  fake.runs[0]!.emit('QQ 官方机器人已连接，等待会话事件。');
  assert.equal((await discovery.start(cwd)).state, 'connected');
  assert.equal(fake.runs.length, 1);
  assert.deepEqual(await readdir(cwd), []);
});

test('discovery retains validated OpenIDs only, deduplicates per kind, and returns detached snapshots', async t => {
  const cwd = await fixture(t), fake = simulated();
  const discovery = createWebDiscovery({ discover: fake.discover }); t.after(() => discovery.close());
  await discovery.start(cwd);
  const run = fake.runs[0]!;
  for (const [type, id] of [['group', 'Case_Sensitive'], ['group', 'Case_Sensitive'], ['private', 'Case_Sensitive'], ['group', 'case_sensitive']] as const) run.emit(metadata(type, id));
  for (const line of [
    'PRIVATE-MESSAGE-TEXT', '{broken PRIVATE-SECRET',
    JSON.stringify({ conversationKey: 'group:Other_Group', userId: 'Synthetic_Member', rawText: 'PRIVATE-MESSAGE-TEXT' }),
    JSON.stringify({ conversationKey: 'group:unsafe/path', userId: 'Synthetic_Member' }),
    JSON.stringify({ conversationKey: 'temporary:Other_Group', userId: 'Synthetic_Member' }),
    JSON.stringify({ conversationKey: 'group:Other_Group', userId: 'unsafe\nuser' }),
    JSON.stringify({ conversationKey: 'group:Other_Group' }),
    JSON.stringify({ conversationKey: `group:${'x'.repeat(3000)}`, userId: 'Synthetic_Member' }),
  ]) run.emit(line);
  const expected = [{ type: 'group', id: 'Case_Sensitive' }, { type: 'private', id: 'Case_Sensitive' }, { type: 'group', id: 'case_sensitive' }];
  assert.deepEqual(discovery.snapshot(cwd).conversations, expected);
  const snapshot = discovery.snapshot(cwd); snapshot.conversations[0]!.id = 'tampered'; snapshot.conversations.push({ type: 'group', id: 'tampered' });
  assert.deepEqual(discovery.snapshot(cwd).conversations, expected);
  assert.doesNotMatch(JSON.stringify(discovery.snapshot(cwd)), /PRIVATE-|Synthetic_Member|userId|rawText/);
  assert.deepEqual((await discovery.stop(cwd)).conversations, expected);
});

test('one run keeps at most 128 conversations and its stopped callbacks cannot add more', async t => {
  const cwd = await fixture(t), fake = simulated();
  const discovery = createWebDiscovery({ discover: fake.discover }); t.after(() => discovery.close());
  await discovery.start(cwd);
  const run = fake.runs[0]!;
  for (let index = 0; index < 140; index++) run.emit(metadata('group', `Synthetic_Group_${index}`));
  assert.equal(discovery.snapshot(cwd).conversations.length, 128);
  assert.equal(discovery.snapshot(cwd).conversations.at(-1)!.id, 'Synthetic_Group_127');
  await discovery.stop(cwd);
  run.emit('QQ 官方机器人已连接，等待会话事件。'); run.emit(metadata('private', 'Late_User'));
  assert.equal(discovery.snapshot(cwd).state, 'idle');
  assert.equal(discovery.snapshot(cwd).conversations.length, 128);
});

test('known status transitions are recognized and untrusted errors never reach snapshots', async t => {
  const cwd = await fixture(t), fake = simulated();
  const discovery = createWebDiscovery({ discover: fake.discover }); t.after(() => discovery.close());
  await discovery.start(cwd);
  const run = fake.runs[0]!;
  run.emit('QQ 官方机器人已连接，等待会话事件。'); assert.equal(discovery.snapshot(cwd).state, 'connected');
  run.emit('QQ 官方机器人连接已断开，等待重新连接。'); assert.equal(discovery.snapshot(cwd).state, 'connecting');
  run.emit('QQ 官方机器人连接发生错误，请检查应用配置和网络。'); assert.equal(discovery.snapshot(cwd).state, 'error');
  run.emit('QQ 官方机器人已连接，等待会话事件。'); assert.equal(discovery.snapshot(cwd).error, undefined);
  run.emit('无法连接 QQ 官方机器人：PRIVATE-CREDENTIAL。');
  assert.equal(discovery.snapshot(cwd).state, 'error');
  assert.match(discovery.snapshot(cwd).error!, /请在连接设置保存机器人凭据/);
  assert.doesNotMatch(JSON.stringify(discovery.snapshot(cwd)), /PRIVATE-CREDENTIAL/);
  run.fail(new Error('PRIVATE-SECRET https://private.example/token'));
  await flush();
  assert.equal(discovery.snapshot(cwd).state, 'error');
  assert.doesNotMatch(JSON.stringify(discovery.snapshot(cwd)), /PRIVATE-|private\.example/);
});

test('a nonzero discovery result is a safe error and an explicit restart gets a fresh list', async t => {
  const cwd = await fixture(t), fake = simulated();
  const discovery = createWebDiscovery({ discover: fake.discover }); t.after(() => discovery.close());
  await discovery.start(cwd);
  fake.runs[0]!.emit(metadata('group', 'Previous_Group')); fake.runs[0]!.finish(1);
  await flush();
  assert.equal(discovery.snapshot(cwd).state, 'error');
  assert.equal((await discovery.stop(cwd)).state, 'idle', 'ordinary startup failures allow credentials to be corrected');
  await discovery.start(cwd);
  assert.equal(fake.runs.length, 2);
  assert.deepEqual(discovery.snapshot(cwd), { state: 'connecting', conversations: [] });
  fake.runs[0]!.emit(metadata('private', 'Late_User'));
  assert.deepEqual(discovery.snapshot(cwd).conversations, []);
});

test('TTL aborts the run automatically and completes its cleanup', async t => {
  const cwd = await fixture(t), fake = simulated();
  const discovery = createWebDiscovery({ discover: fake.discover, ttlMs: 25 }); t.after(() => discovery.close());
  await discovery.start(cwd);
  const run = fake.runs[0]!;
  const aborted = once(run.signal, 'abort');
  const deadline = deferred<void>();
  const timer = setTimeout(() => { deadline.reject(new Error('Discovery did not stop at its configured deadline.')); }, 2000);
  try { await Promise.race([aborted, deadline.promise]); await flush(); }
  finally { clearTimeout(timer); }
  assert.equal(run.signal.aborted, true);
  assert.equal(discovery.snapshot(cwd).state, 'idle');
});

test('a restart waits for the old discovery cleanup and concurrent starts still create one replacement', async t => {
  const cwd = await fixture(t), fake = simulated(false);
  const discovery = createWebDiscovery({ discover: fake.discover });
  t.after(async () => { for (const run of fake.runs) run.finish(); await discovery.close(); });
  await discovery.start(cwd);
  let stopped = false;
  const stopping = discovery.stop(cwd).then(() => { stopped = true; });
  const restarting = Promise.all([discovery.start(cwd), discovery.start(cwd)]);
  await flush();
  assert.equal(stopped, false); assert.equal(fake.runs.length, 1); assert.equal(fake.runs[0]!.signal.aborted, true);
  fake.runs[0]!.finish(); await stopping; await restarting;
  assert.equal(fake.runs.length, 2);
});

test('closing aborts every directory, waits for cleanup, and refuses later starts', async t => {
  const cwd = await fixture(t), other = await fixture(t), fake = simulated(false);
  const discovery = createWebDiscovery({ discover: fake.discover });
  await discovery.start(cwd); await discovery.start(other);
  let closed = false;
  const closing = discovery.close().then(() => { closed = true; });
  assert.ok(fake.runs.every(run => run.signal.aborted));
  await flush(); assert.equal(closed, false);
  for (const run of fake.runs) run.finish();
  await closing; await discovery.close();
  assert.equal(closed, true);
  assert.deepEqual(discovery.snapshot(cwd), { state: 'idle', conversations: [] });
  await assert.rejects(discovery.start(cwd), /已关闭/);
});

async function config(cwd: string) {
  await writeFile(join(cwd, 'PIQ.md'), '```json\n' + JSON.stringify({ id: 'discovery', name: '发现对话', conversations: [] }) + '\n```\n');
}

test('closing during credential resolution waits for discovery and never creates a channel or exposes credentials', async t => {
  const cwd = await fixture(t); await config(cwd);
  const ready = deferred<void>(), credentials = deferred<{ appId: string; appSecret: string; available: boolean; hasSecret: boolean }>();
  let claimed = false, created = false;
  const discovery = createWebDiscovery({ discover: (directory, options) => discoverGroup(directory, {
    ...options, readManagedCredentials: async () => { ready.resolve(); return credentials.promise; },
    claimAccount: async () => { claimed = true; return async () => {}; },
    createTransport: () => { created = true; throw new Error('PRIVATE-SECRET'); },
  }) });
  await discovery.start(cwd); await ready.promise;
  let closed = false;
  const closing = discovery.close().then(() => { closed = true; });
  await flush(); assert.equal(closed, false);
  credentials.resolve({ appId: 'synthetic-app-id', appSecret: 'PRIVATE-SECRET', available: true, hasSecret: true });
  await closing;
  assert.equal(claimed, false); assert.equal(created, false);
  assert.doesNotMatch(JSON.stringify(discovery.snapshot(cwd)), /synthetic-app-id|PRIVATE-SECRET/);
  assert.deepEqual(await readdir(cwd), ['PIQ.md']);
});

test('stopping during account acquisition waits for and releases that account before returning', async t => {
  const cwd = await fixture(t); await config(cwd);
  const ready = deferred<void>(), account = deferred<() => Promise<void>>();
  let released = false, created = false;
  const discovery = createWebDiscovery({ discover: (directory, options) => discoverGroup(directory, {
    ...options, readManagedCredentials: async () => ({ appId: 'synthetic-app-id', appSecret: 'PRIVATE-SECRET', available: true, hasSecret: true }),
    claimAccount: async () => { ready.resolve(); return account.promise; },
    createTransport: () => { created = true; throw new Error('PRIVATE-SECRET'); },
  }) });
  t.after(() => discovery.close());
  await discovery.start(cwd); await ready.promise;
  let stopped = false;
  const stopping = discovery.stop(cwd).then(value => { stopped = true; return value; });
  await flush(); assert.equal(stopped, false);
  account.resolve(async () => { released = true; });
  const result = await stopping;
  assert.equal(released, true); assert.equal(created, false);
  assert.deepEqual(result, { state: 'idle', conversations: [] });
});

test('cleanup failures are visible through fixed text without leaking the thrown error', async t => {
  const cwd = await fixture(t), fake = simulated(false);
  const discovery = createWebDiscovery({ discover: fake.discover }); t.after(() => discovery.close());
  await discovery.start(cwd);
  const stopping = discovery.stop(cwd);
  fake.runs[0]!.fail(new Error('PRIVATE-CLEANUP-SECRET'));
  const result = await stopping;
  assert.equal(result.state, 'error');
  assert.match(result.error!, /未能正常关闭/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-CLEANUP-SECRET/);
  assert.deepEqual(await discovery.stop(cwd), result);
  assert.deepEqual(await discovery.start(cwd), result);
  assert.equal(fake.runs.length, 1, 'uncertain cleanup cannot create another channel');
});
