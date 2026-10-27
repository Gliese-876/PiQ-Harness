import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import filesystem from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { initializeGroup, listGroupConfigs, loadConfig } from '../src/config.ts';
import { deleteGroup, listDeletedGroups, restoreGroup } from '../src/group-management.ts';
import { GroupStore } from '../src/store.ts';
import { registerTerminal } from '../src/terminal-monitor.ts';

const conversation = { type: 'group' as const, id: '123456' };
const deadPid = 2_147_483_647;

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'group-management-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(parent + sep));
    await rm(root, { recursive: true, force: true });
  });
  const cwd = await initializeGroup(root, 'friends', { name: '朋友', conversations: [conversation] });
  return { root, cwd };
}

async function runtime(cwd: string, file: string, value: unknown): Promise<void> {
  await mkdir(join(cwd, '.piq'), { recursive: true });
  await writeFile(join(cwd, '.piq', file), typeof value === 'string' ? value : JSON.stringify(value));
}

const conflict = (error: unknown) => (error as { status?: number }).status === 409;
const badRequest = (error: unknown) => (error as { status?: number }).status === 400;

test('deletion and restoration preserve documents, assets, journals and Pi sessions byte for byte', async t => {
  const { root, cwd } = await fixture(t);
  const files = {
    'PIQ.md': await readFile(join(cwd, 'PIQ.md')),
    'PERSONA.md': Buffer.from('# 人设\n原样保留\n'),
    'MEMORY.md': Buffer.from('本组记忆'),
    'assets/example.bin': Buffer.from([0, 1, 2, 255]),
    'messages/history.jsonl': Buffer.from('{"original":"journal"}\n'),
    '.pi/sessions/history.jsonl': Buffer.from('{"original":"session"}\n'),
  };
  for (const [path, bytes] of Object.entries(files)) await writeFile(join(cwd, path), bytes);
  assert.deepEqual(await listDeletedGroups(root), []);
  const before = Date.now();
  const deleted = await deleteGroup(cwd);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.id, 'friends');
  assert.equal(deleted.name, '朋友');
  assert.ok(deleted.deletedAt >= before && deleted.deletedAt <= Date.now());
  assert.match(deleted.token, /^friends-\d+-[a-f0-9-]{36}$/);
  assert.equal(deleted.recoveryPath, join(root, '.trash', deleted.token));
  assert.deepEqual(await listGroupConfigs(root), []);
  assert.deepEqual(await listDeletedGroups(root), [{ token: deleted.token, id: 'friends', name: '朋友', deletedAt: deleted.deletedAt }]);
  for (const [path, bytes] of Object.entries(files)) assert.deepEqual(await readFile(join(deleted.recoveryPath, path)), bytes, path);
  for (const file of ['start.lock', 'terminal-return.lock', 'owner.lock']) {
    await assert.rejects(readFile(join(deleted.recoveryPath, '.piq', file)), { code: 'ENOENT' });
  }
  const restored = await restoreGroup(root, deleted.token);
  assert.deepEqual(restored, { restored: true, id: 'friends', name: '朋友', path: cwd });
  assert.deepEqual(await listDeletedGroups(root), []);
  assert.equal((await listGroupConfigs(root)).length, 1);
  for (const [path, bytes] of Object.entries(files)) assert.deepEqual(await readFile(join(cwd, path)), bytes, path);
});

test('restoration refuses an existing id, directory or file and leaves recycled data intact', async t => {
  const { root, cwd } = await fixture(t);
  const deleted = await deleteGroup(cwd);
  const original = await readFile(join(deleted.recoveryPath, 'PIQ.md'), 'utf8');
  await initializeGroup(root, 'friends', { name: '新的朋友', conversations: [] });
  await assert.rejects(restoreGroup(root, deleted.token), conflict);
  assert.equal((await loadConfig(cwd))!.name, '新的朋友');
  const newer = await deleteGroup(cwd);
  await writeFile(cwd, 'An ordinary unrelated file');
  await assert.rejects(restoreGroup(root, deleted.token), conflict);
  assert.equal(await readFile(cwd, 'utf8'), 'An ordinary unrelated file');
  await unlink(cwd);
  await mkdir(cwd);
  await assert.rejects(restoreGroup(root, deleted.token), conflict);
  await rmdir(cwd);
  assert.equal(await readFile(join(deleted.recoveryPath, 'PIQ.md'), 'utf8'), original);
  assert.equal((await listDeletedGroups(root)).length, 2);
  await restoreGroup(root, deleted.token);
  assert.equal((await listDeletedGroups(root))[0]!.token, newer.token);
});

test('restoration checks conversation ownership against the current registry', async t => {
  const { root, cwd } = await fixture(t);
  const deleted = await deleteGroup(cwd);
  const other = await initializeGroup(root, 'other', { name: '新归属', conversations: [conversation] });
  await assert.rejects(restoreGroup(root, deleted.token), conflict);
  assert.equal((await loadConfig(other))!.conversations[0]!.id, conversation.id);
  assert.ok(await readFile(join(deleted.recoveryPath, 'PIQ.md')));
  await deleteGroup(other);
  await restoreGroup(root, deleted.token);
  assert.equal((await listGroupConfigs(root))[0]!.id, 'friends');
});

test('restore accepts only a generated token and confirms its original group id', async t => {
  const { root, cwd } = await fixture(t);
  const deleted = await deleteGroup(cwd);
  for (const token of ['', '../friends', '..\\friends', deleted.recoveryPath, '%2e%2e', 'friends', `con-1-${randomUUID()}`]) {
    await assert.rejects(restoreGroup(root, token), badRequest);
  }
  const forged = `other-${deleted.deletedAt}-${randomUUID()}`;
  await rename(deleted.recoveryPath, join(root, '.trash', forged));
  await assert.rejects(restoreGroup(root, forged), /标识不一致/);
  await assert.rejects(listDeletedGroups(root), /标识不一致/);
  assert.ok(await readFile(join(root, '.trash', forged, 'PIQ.md')));
});

test('live runtime and launcher leases refuse deletion without changing their records', async t => {
  for (const [file, value] of [
    ['owner.lock', { version: 1, pid: process.pid, token: 'live' }],
    ['start.lock', { pid: process.pid, token: 'live' }],
    ['terminal-return.lock', { pid: process.pid, token: 'live' }],
    ['worker.json', { version: 1, mode: 'background', pid: process.pid, launchId: 'live', startedAt: Date.now(), state: 'running' }],
    ['worker-launch.json', { version: 1, pid: process.pid, launchId: 'live', startedAt: Date.now() }],
    ['launch.json', { version: 1, pid: process.pid, launchId: 'live', startedAt: Date.now() }],
    ['terminal-return.json', { version: 1, token: 'live', launcherPid: process.pid, createdAt: Date.now(), state: 'starting' }],
    ['terminal-return.json', { version: 1, token: 'live', launcherPid: deadPid, piPid: process.pid, createdAt: Date.now(), state: 'error' }],
  ] as const) {
    const { cwd } = await fixture(t);
    await runtime(cwd, file, value);
    await assert.rejects(deleteGroup(cwd), conflict, file);
    assert.deepEqual(JSON.parse(await readFile(join(cwd, '.piq', file), 'utf8')), value, file);
    assert.ok(await loadConfig(cwd));
  }
});

test('a live Pi store holds its owner lease until it closes', async t => {
  const { cwd } = await fixture(t);
  const store = await GroupStore.open(cwd, (await loadConfig(cwd))!);
  try { await assert.rejects(deleteGroup(cwd), conflict); }
  finally { await store.close(); }
  assert.equal((await deleteGroup(cwd)).deleted, true);
});

test('dead owner and startup locks are recovered, while incomplete recovery markers remain inspectable', async t => {
  const { root, cwd } = await fixture(t);
  for (const file of ['owner.lock', 'start.lock', 'terminal-return.lock']) {
    await runtime(cwd, file, { version: 1, pid: deadPid, token: 'dead' });
  }
  const deleted = await deleteGroup(cwd);
  await restoreGroup(root, deleted.token);
  for (const file of ['start.lock.recover', 'recovery.lock', 'terminal-return.lock.recover']) {
    await runtime(cwd, file, { pid: deadPid, token: 'interrupted-recovery' });
    await assert.rejects(deleteGroup(cwd), /未完成的运行锁恢复/);
    assert.ok(await readFile(join(cwd, '.piq', file)));
    await unlink(join(cwd, '.piq', file));
  }
});

test('finished worker records supersede old pending launches and damaged records never disappear', async t => {
  const { cwd } = await fixture(t);
  const startedAt = Date.now();
  await runtime(cwd, 'worker-launch.json', { version: 1, pid: process.pid, launchId: 'finished', startedAt });
  await runtime(cwd, 'worker.json', { version: 1, mode: 'background', pid: deadPid, launchId: 'finished', startedAt, state: 'stopped' });
  await runtime(cwd, 'terminal-return.json', { version: 1, token: 'finished', launcherPid: process.pid, createdAt: startedAt, state: 'error' });
  const deleted = await deleteGroup(cwd);
  assert.ok(await readFile(join(deleted.recoveryPath, '.piq', 'worker.json')));
  for (const file of ['owner.lock', 'worker.json', 'worker-launch.json', 'terminal-return.json']) {
    const next = await fixture(t);
    await runtime(next.cwd, file, '{broken');
    await assert.rejects(deleteGroup(next.cwd), conflict);
    assert.equal(await readFile(join(next.cwd, '.piq', file), 'utf8'), '{broken');
  }
});

test('terminal-only leases permit deletion after window exit even while the WebUI launcher lives', async t => {
  for (const state of ['watching', 'starting'] as const) {
    const { cwd } = await fixture(t);
    await runtime(cwd, 'terminal-return.json', {
      version: 1, kind: 'terminal-only', token: randomUUID(), launcherPid: process.pid,
      wrapperPid: deadPid, piPid: deadPid, createdAt: Date.now() - 60_000, state,
    });
    assert.equal((await deleteGroup(cwd)).deleted, true);
  }
  const { cwd } = await fixture(t);
  await runtime(cwd, 'terminal-return.json', {
    version: 1, kind: 'terminal-only', token: randomUUID(), launcherPid: process.pid,
    createdAt: Date.now(), state: 'starting',
  });
  await assert.rejects(deleteGroup(cwd), conflict);
});

test('an opening Pi cannot strand its recovery lease while a group moves into the recycle bin', async t => {
  const { root, cwd } = await fixture(t);
  const config = (await loadConfig(cwd))!;
  const originalRename = filesystem.rename;
  let reachedMove!: () => void, releaseMove!: () => void;
  const moving = new Promise<void>(resolve => { reachedMove = resolve; });
  const released = new Promise<void>(resolve => { releaseMove = resolve; });
  t.mock.method(filesystem, 'rename', async (...args: Parameters<typeof filesystem.rename>) => {
    if (String(args[0]) === cwd && String(args[1]).startsWith(join(root, '.trash') + sep)) {
      reachedMove();
      await released;
    }
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  const deletion = deleteGroup(cwd);
  try {
    await moving;
    await assert.rejects(GroupStore.open(cwd, config), /recovery is already in progress/);
  } finally {
    releaseMove();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  const deleted = await deletion;
  assert.deepEqual(await readdir(join(deleted.recoveryPath, '.piq')), []);
  await restoreGroup(root, deleted.token);
});

test('terminal registration never observes a partially written management lock', async t => {
  const { cwd } = await fixture(t);
  const token = randomUUID();
  await runtime(cwd, 'terminal-return.json', {
    version: 1, kind: 'terminal-only', token, launcherPid: process.pid, createdAt: Date.now(), state: 'starting',
  });
  const originalOpen = filesystem.open;
  let reachedWrite!: () => void, releaseWrite!: () => void;
  const writing = new Promise<void>(resolve => { reachedWrite = resolve; });
  const released = new Promise<void>(resolve => { releaseWrite = resolve; });
  let paused = false;
  t.mock.method(filesystem, 'open', async (...args: Parameters<typeof filesystem.open>) => {
    const handle = await originalOpen(...args);
    if (!paused && String(args[0]).startsWith(join(cwd, '.piq', 'terminal-return.lock')) && args[1] === 'wx') {
      paused = true;
      const originalWrite = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        reachedWrite();
        await released;
        return originalWrite(...writeArgs);
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  const deletion = deleteGroup(cwd);
  const rejected = assert.rejects(deletion, conflict);
  try {
    await writing;
    await registerTerminal(cwd, token, process.pid);
  } finally {
    releaseWrite();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  await rejected;
  assert.equal(JSON.parse(await readFile(join(cwd, '.piq', 'terminal-return.json'), 'utf8')).wrapperPid, process.pid);
});

test('competing restore and initialization cannot assign the same conversation twice', async t => {
  const { root, cwd } = await fixture(t);
  const deleted = await deleteGroup(cwd);
  const results = await Promise.allSettled([
    restoreGroup(root, deleted.token),
    initializeGroup(root, 'other', { name: '竞争归属', conversations: [conversation] }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await listGroupConfigs(root)).length, 1);
});

test('concurrent deletion moves the original group once and leaves no management locks', async t => {
  const { root, cwd } = await fixture(t);
  const results = await Promise.allSettled([deleteGroup(cwd), deleteGroup(cwd)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const entries = await listDeletedGroups(root);
  assert.equal(entries.length, 1);
  const files = await readdir(join(root, '.trash', entries[0]!.token, '.piq'));
  assert.ok(!files.some(name => name.endsWith('.lock') || name.endsWith('.recover')));
});

test('junctions cannot redirect a group, recycle bin, restored entry or runtime records', async t => {
  const { root, cwd } = await fixture(t);
  const outside = join(root, 'outside');
  await mkdir(outside);
  const directoryLink = async (target: string, path: string) => {
    await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
  };
  const removeLink = async (path: string) => process.platform === 'win32' ? rmdir(path) : unlink(path);
  const alias = join(root, 'alias');
  try { await directoryLink(cwd, alias); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Directory links unavailable'); return; }
    throw error;
  }
  try { await assert.rejects(deleteGroup(alias), /普通目录/); }
  finally { await removeLink(alias); }
  await directoryLink(outside, join(root, '.trash'));
  try {
    await assert.rejects(deleteGroup(cwd), /普通目录/);
    await assert.rejects(listDeletedGroups(root), /普通目录/);
  } finally { await removeLink(join(root, '.trash')); }
  const deleted = await deleteGroup(cwd);
  const kept = join(root, '.trash', 'saved-entry');
  await rename(deleted.recoveryPath, kept);
  await directoryLink(kept, deleted.recoveryPath);
  try { await assert.rejects(restoreGroup(root, deleted.token), /普通目录/); }
  finally { await removeLink(deleted.recoveryPath); }
  await rename(kept, deleted.recoveryPath);
  await restoreGroup(root, deleted.token);
  await rmdir(join(cwd, '.piq'));
  await directoryLink(outside, join(cwd, '.piq'));
  try { await assert.rejects(deleteGroup(cwd), /普通目录/); }
  finally { await removeLink(join(cwd, '.piq')); }
  assert.deepEqual(await readdir(outside), []);
  assert.ok(await loadConfig(cwd));
});
