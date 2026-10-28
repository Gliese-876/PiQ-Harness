import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { claimBotAccount } from '../src/bot-owner.ts';
import { discoverGroup, type DiscoverOptions } from '../src/discover.ts';
import type { ConversationEvent, TransportOptions } from '../src/transport.ts';

const env = { QQBOT_APP_ID: 'synthetic-app-id', QQBOT_APP_SECRET: 'synthetic-app-secret' };

async function fixture(t: TestContext, config: Record<string, unknown> | null = { id: 'discovery', name: '发现会话', conversations: [] }) {
  const parent = resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(join(parent, 'discover-'));
  t.after(async () => {
    const part = relative(parent, cwd);
    assert.ok(part && !part.startsWith('..'));
    await rm(cwd, { recursive: true, force: true });
  });
  if (config) await writeFile(join(cwd, 'PIQ.md'), `# QQ 机器人\n\n\`\`\`json\n${JSON.stringify(config)}\n\`\`\`\n`);
  const lines: string[] = [];
  const controller = new AbortController();
  const options: DiscoverOptions = { env, output: line => { lines.push(line); }, signal: controller.signal, claimAccount: async () => async () => {} };
  return { cwd, lines, controller, options };
}

function event(type: 'group' | 'private', id: string, userId = 'Member_OpenID'): ConversationEvent {
  return {
    conversation: { type, id, name: 'PRIVATE-CONVERSATION-NAME' }, userId,
    selfId: 'PRIVATE-SELF-ID', messageId: 'PRIVATE-MESSAGE-ID', sender: 'PRIVATE-SENDER',
    time: 1_700_000_000, rawText: 'PRIVATE-MESSAGE-TEXT', outgoing: false,
    raw: { content: 'PRIVATE-RAW-CONTENT' },
    attachments: [],
  };
}

test('discovery requires a local configuration and never constructs a transport when it is absent', async t => {
  const f = await fixture(t, null);
  let created = 0;
  const result = await discoverGroup(f.cwd, { ...f.options, createTransport: () => { created++; throw new Error('unexpected'); } });
  assert.equal(result, 1);
  assert.equal(created, 0);
  assert.match(f.lines.join('\n'), /PIQ\.md/);
  assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
});

test('discovery reports invalid configuration without echoing its contents', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'PIQ.md'), '```json\n{"appSecret":"PRIVATE-CONFIG-SECRET"\n```\n');
  assert.equal(await discoverGroup(f.cwd, f.options), 1);
  assert.match(f.lines.join('\n'), /配置/);
  assert.doesNotMatch(f.lines.join('\n'), /PRIVATE-CONFIG-SECRET/);
});

test('discovery explains missing credential variables without printing available values', async t => {
  const f = await fixture(t, { id: 'discovery', name: '发现会话', conversations: [], appIdEnv: 'DISCOVERY_APP_ID', appSecretEnv: 'DISCOVERY_APP_SECRET' });
  let created = false;
  let claimed = false;
  assert.equal(await discoverGroup(f.cwd, {
    ...f.options, env: { DISCOVERY_APP_ID: 'PRIVATE-APP-ID' },
    claimAccount: async () => { claimed = true; return async () => {}; },
    createTransport: () => { created = true; throw new Error('unexpected'); },
  }), 1);
  assert.equal(created, false);
  assert.equal(claimed, false);
  assert.match(f.lines.join('\n'), /DISCOVERY_APP_SECRET/);
  assert.doesNotMatch(f.lines.join('\n'), /PRIVATE-APP-ID/);
});

test('discovery prints each observed conversation once and never persists or replies', async t => {
  const f = await fixture(t);
  let closed = 0;
  const lifecycle: string[] = [];
  let received: TransportOptions | undefined;
  assert.equal(await discoverGroup(f.cwd, {
    ...f.options,
    claimAccount: async appId => {
      assert.equal(appId, env.QQBOT_APP_ID);
      lifecycle.push('claim');
      return async () => { lifecycle.push('release'); };
    },
    createTransport: specification => {
      lifecycle.push('create');
      received = specification;
      return {
        async connect() {
          lifecycle.push('connect');
          specification.onStatus?.('connecting');
          specification.onStatus?.('connected');
          specification.onStatus?.('connected');
          specification.onError?.(new Error('PRIVATE-ERROR-SECRET'));
          await specification.onMessage(event('group', 'Opaque_Group-ID'));
          await specification.onMessage(event('group', 'Opaque_Group-ID', 'Second_Member'));
          await specification.onMessage(event('private', 'Opaque_Group-ID', 'Private_Member'));
          await specification.onMessage(event('group', 'opaque_group-id'));
          await specification.onMessage(event('group', 'unsafe\nterminal'));
          await specification.onMessage(event('private', 'Other_ID', 'unsafe\nuser'));
          f.controller.abort();
        },
        close() { closed++; lifecycle.push('close'); },
      };
    },
  }), 0);
  assert.equal(received?.appId, env.QQBOT_APP_ID);
  assert.equal(received?.appSecret, env.QQBOT_APP_SECRET);
  assert.equal(closed, 1);
  assert.deepEqual(lifecycle, ['claim', 'create', 'connect', 'close', 'release']);
  assert.deepEqual(f.lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line)), [
    { conversationKey: 'group:Opaque_Group-ID', userId: 'Member_OpenID' },
    { conversationKey: 'private:Opaque_Group-ID', userId: 'Private_Member' },
    { conversationKey: 'group:opaque_group-id', userId: 'Member_OpenID' },
  ]);
  assert.equal(f.lines.filter(line => line.includes('已连接')).length, 1);
  assert.doesNotMatch(f.lines.join('\n'), /PRIVATE-|synthetic-app/);
  assert.deepEqual(await readdir(f.cwd), ['PIQ.md']);
});

test('discovery resolves the configured credential names through the supplied environment reader', async t => {
  const f = await fixture(t, { id: 'discovery', name: '发现会话', conversations: [], appIdEnv: 'DISCOVERY_APP_ID', appSecretEnv: 'DISCOVERY_APP_SECRET' });
  const requested: string[][] = [];
  const parentEnv = Object.freeze({ DISCOVERY_APP_ID: 'PRIVATE-CUSTOM-ID' });
  assert.equal(await discoverGroup(f.cwd, {
    ...f.options, env: parentEnv,
    readUserEnvironment: async names => { requested.push([...names]); return { DISCOVERY_APP_SECRET: 'PRIVATE-CUSTOM-SECRET' }; },
    createTransport: specification => ({
      async connect() {
        assert.equal(specification.appId, 'PRIVATE-CUSTOM-ID');
        assert.equal(specification.appSecret, 'PRIVATE-CUSTOM-SECRET');
        f.controller.abort();
      },
      close() {},
    }),
  }), 0);
  assert.deepEqual(requested, [['DISCOVERY_APP_SECRET']]);
  assert.deepEqual(parentEnv, { DISCOVERY_APP_ID: 'PRIVATE-CUSTOM-ID' });
  assert.doesNotMatch(f.lines.join('\n'), /PRIVATE-CUSTOM/);
});

test('discovery hides startup errors and closes a failed transport', async t => {
  const f = await fixture(t);
  let closed = 0;
  assert.equal(await discoverGroup(f.cwd, {
    ...f.options, createTransport: () => ({
      async connect() { throw new Error('PRIVATE-STARTUP-SECRET'); },
      close() { closed++; },
    }),
  }), 1);
  assert.equal(closed, 1);
  assert.match(f.lines.join('\n'), /无法启动/);
  assert.doesNotMatch(f.lines.join('\n'), /PRIVATE-STARTUP-SECRET/);
});

test('discovery hides errors thrown while constructing or closing a transport', async t => {
  const f = await fixture(t);
  let released = 0;
  const claimAccount = async () => async () => { released++; };
  assert.equal(await discoverGroup(f.cwd, { ...f.options, claimAccount, createTransport: () => { throw new Error('PRIVATE-FACTORY-SECRET'); } }), 1);
  assert.equal(released, 1);
  assert.doesNotMatch(f.lines.join('\n'), /PRIVATE-FACTORY-SECRET/);
  assert.equal(await discoverGroup(f.cwd, {
    ...f.options, claimAccount, createTransport: () => ({
      async connect() { f.controller.abort(); },
      close() { throw new Error('PRIVATE-CLOSE-SECRET'); },
    }),
  }), 1);
  assert.match(f.lines.join('\n'), /无法关闭/);
  assert.doesNotMatch(f.lines.join('\n'), /PRIVATE-CLOSE-SECRET/);
  assert.equal(released, 2);
});

test('discovery aborts pending startup, closes once, and ignores later callbacks', async t => {
  const f = await fixture(t);
  let closed = 0;
  let released = 0;
  let received: TransportOptions | undefined;
  assert.equal(await discoverGroup(f.cwd, {
    ...f.options,
    claimAccount: async () => async () => { released++; },
    createTransport: specification => {
      received = specification;
      return {
        connect() { queueMicrotask(() => f.controller.abort()); return new Promise<void>(() => {}); },
        close() { closed++; },
      };
    },
  }), 0);
  assert.equal(closed, 1);
  assert.equal(released, 1);
  const before = [...f.lines];
  await received!.onMessage(event('group', 'Late_Group'));
  received!.onStatus?.('error');
  assert.deepEqual(f.lines, before);
  assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
});

test('an already aborted discovery exits without connecting or writing files', async t => {
  const f = await fixture(t, null);
  f.controller.abort();
  assert.equal(await discoverGroup(f.cwd, { ...f.options, createTransport: () => { throw new Error('unexpected'); } }), 0);
  assert.deepEqual(f.lines, []);
  assert.deepEqual(await readdir(f.cwd), []);
});

test('SIGINT and SIGTERM close discovery and remove their process listeners', async t => {
  const f = await fixture(t);
  const source = pathToFileURL(resolve('src/discover.ts')).href;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const script = join(f.cwd, `signal-${signal}.mjs`);
    await writeFile(script, [
      `import { discoverGroup } from ${JSON.stringify(source)};`,
      'const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];',
      'let closed = 0;',
      'let released = 0;',
      `const code = await discoverGroup(process.cwd(), { env: ${JSON.stringify(env)}, output() {},`,
      '  claimAccount: async () => async () => { released++; },',
      '  createTransport: () => ({',
      `    async connect() { queueMicrotask(() => process.emit(${JSON.stringify(signal)})); },`,
      '    close() { closed++; },',
      '  }),',
      '});',
      'console.log(JSON.stringify({ code, closed, released, before, after: [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")] }));',
    ].join('\n'));
    const child = spawnSync(process.execPath, [script], { cwd: f.cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.code, 0);
    assert.equal(result.closed, 1);
    assert.equal(result.released, 1);
    assert.deepEqual(result.after, result.before);
  }
});

test('discovery refuses an owned application before creating the SDK and keeps its error private', async t => {
  const f = await fixture(t);
  const namespace = `discovery-conflict-${randomUUID()}`;
  const release = await claimBotAccount(env.QQBOT_APP_ID, { namespace });
  t.after(release);
  let created = false;
  assert.equal(await discoverGroup(f.cwd, {
    ...f.options,
    claimAccount: appId => claimBotAccount(appId, { namespace }),
    createTransport: () => { created = true; throw new Error('unexpected'); },
  }), 1);
  assert.equal(created, false);
  assert.match(f.lines.join('\n'), /同一 AppID/);
  assert.doesNotMatch(f.lines.join('\n'), /synthetic-app-id|synthetic-app-secret|piq-qqbot-|discovery-conflict-/);
});

test('discovery releases an account when cancellation happens during its claim', async t => {
  const f = await fixture(t);
  let released = 0, created = false;
  assert.equal(await discoverGroup(f.cwd, {
    ...f.options,
    claimAccount: async () => {
      f.controller.abort();
      return async () => { released++; };
    },
    createTransport: () => { created = true; throw new Error('unexpected'); },
  }), 0);
  assert.equal(created, false);
  assert.equal(released, 1);
});
