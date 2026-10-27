import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, realpath, unlink } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { initializeGroup, loadConfig, type GroupConfig } from '../src/config.ts';
import { startWebServer } from '../src/web-server.ts';
import type { ModelCatalog } from '../src/web-models.ts';
import { getProcessStatus } from '../src/process-manager.ts';
import { prepareTerminalReturn, registerTerminal } from '../src/terminal-monitor.ts';

interface State {
  root: string;
  csrfToken: string;
  defaultWsUrl: string;
  groups: Array<{ id: string; name: string; conversations: GroupConfig['conversations']; path: string; running: boolean; pid: number | null }>;
}
interface Group {
  id: string;
  path: string;
  config: GroupConfig;
  configRevision: string;
  documents: string[];
  logs: Record<string, string[]>;
  credential: { available: boolean; source: string };
}
interface Document { content: string; revision: string }

function logRecord(seq: number, text = '测试消息', changes: Record<string, unknown> = {}) {
  return { v: 2, seq, receivedAt: 1793000000000 + seq, conversation: { type: 'group', id: '123456' },
    messageId: String(-seq), messageSeq: String(seq), selfId: '111111', userId: '222222',
    sender: '测试成员', time: 1793000000, rawText: text,
    segments: [{ type: 'text', data: { text } }], outgoing: false, ...changes };
}

function pokeRecord(seq: number, changes: Record<string, unknown> = {}) {
  return { v: 2, seq, receivedAt: 1793000000000 + seq, kind: 'poke',
    eventId: '4b5f875c-818b-4580-9445-505c43a832a0', source: 'notice',
    conversation: { type: 'group', id: '123456' }, selfId: '111111', userId: '222222', targetId: '111111',
    sender: '222222', time: 1793000000, rawText: '222222 戳了 111111',
    segments: [{ type: 'poke', data: { user_id: '222222', target_id: '111111' } }], outgoing: false, ...changes };
}

const logLine = (record: ReturnType<typeof logRecord>) => JSON.stringify(record) + '\n';

async function fixture(t: TestContext, catalog: ModelCatalog = { models: [] }) {
  const parent = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'web-server-'));
  const cwd = await initializeGroup(root, '123456', { name: 'Test conversation group', conversations: [{ type: 'group', id: '123456' }], wsUrl: 'ws://127.0.0.1:3000/' });
  const messageDir = join(cwd, 'messages', 'group', '123456');
  await mkdir(messageDir, { recursive: true });
  const launched: string[] = [];
  const launchOptions: Array<{ freshSession?: boolean }> = [];
  const actions: string[] = [];
  const app = await startWebServer({
    root, port: 0,
    openTerminal: async (path, options) => { launched.push(path); launchOptions.push({ freshSession: options?.freshSession }); return { message: '已请求打开测试终端。' }; },
    credentials: async () => ({ available: true, source: '测试凭据来源' }),
    models: async () => catalog,
    ensure: async () => ({ ok: true, started: false, message: '模拟服务已连接', diagnostic: 'ready', canStart: false, canOpenManual: true }),
    manual: async () => ({ message: '已请求打开模拟恢复入口' }),
    action: async (path, action) => {
      actions.push(action);
      if (action === 'shutdown' || action === 'handoff') {
        await unlink(join(path, '.piq', 'owner.lock'));
        // A legacy worker publishes its stopped state before exiting. Keep the
        // mock's own PID alive without pretending its launch is still pending.
        const workerPath = join(path, '.piq', 'worker.json');
        const worker = await readFile(workerPath, 'utf8').then(JSON.parse).catch(error => {
          if (error.code === 'ENOENT') return null; throw error;
        });
        const launch = await readFile(join(path, '.piq', 'worker-launch.json'), 'utf8').then(JSON.parse).catch(error => {
          if (error.code === 'ENOENT') return null; throw error;
        });
        if (worker || launch) await writeFile(workerPath, JSON.stringify({
          ...(worker ?? launch), version: 1, mode: 'background', state: 'stopped',
        }));
      }
      return { requestId: `mock-${action}` };
    },
  });
  t.after(async () => {
    await app.close();
    const target = await realpath(root);
    const within = relative(await realpath(parent), target);
    assert.ok(within && within !== '..' && !within.startsWith('../') && !within.startsWith('..\\') && !isAbsolute(within));
    await rm(target, { recursive: true, force: true });
  });
  const initial = await fetch(`${app.url}/api/state`);
  assert.equal(initial.status, 200);
  const state = await initial.json() as State;
  const headers = { 'Content-Type': 'application/json', Origin: app.url, 'X-PiQ-Token': state.csrfToken };
  async function call(path: string, method = 'GET', body?: unknown) {
    return fetch(`${app.url}${path}`, {
      method,
      headers: method === 'GET' ? {} : headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function get<T>(path: string): Promise<T> {
    const response = await call(path);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<T>;
  }
  return { root, cwd, messageDir, app, state, headers, launched, launchOptions, actions, call, get };
}

test('WebUI exposes only local group metadata and serves its frontend with restrictive headers', async t => {
  const f = await fixture(t);
  const address = f.app.server.address();
  assert.ok(address && typeof address !== 'string');
  assert.equal(address.address, '127.0.0.1');
  assert.equal(f.state.root, await realpath(f.root));
  assert.equal(f.state.defaultWsUrl, 'ws://127.0.0.1:3000/');
  assert.match(f.state.csrfToken, /^[0-9a-f]{64}$/);
  assert.deepEqual(f.state.groups.map(group => group.id), ['123456']);
  assert.equal(f.state.groups[0]?.name, 'Test conversation group');
  assert.deepEqual(f.state.groups[0]?.conversations, [{ type: 'group', id: '123456' }]);
  assert.equal(f.state.groups[0]?.running, false);
  const group = await f.get<Group>('/api/groups/123456');
  assert.equal(group.path, await realpath(f.cwd));
  assert.deepEqual(group.documents, ['AGENTS.md', 'PERSONA.md', 'MEMORY.md']);
  assert.deepEqual(group.credential, { available: true, source: '测试凭据来源' });
  assert.equal('env' in group, false);
  const page = await f.call('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Type') ?? '', /text\/html/);
  assert.match(page.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(page.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(await page.text(), /PiQ/);
});

test('Markdown creation preserves content, and revision conflicts protect other edits', async t => {
  const f = await fixture(t);
  const memoryPath = '/api/groups/123456/documents/MEMORY.md';
  const empty = await f.get<Document>(memoryPath);
  assert.deepEqual(empty, { content: '', revision: createHash('sha256').update('').digest('hex') });
  const content = '# 本群记忆\n\n<script>alert("text only")</script>\n';
  const created = await f.call(memoryPath, 'PUT', { content, revision: empty.revision });
  assert.equal(created.status, 200);
  const saved = await f.get<Document>(memoryPath);
  assert.equal(saved.content, content);
  assert.equal(await readFile(join(f.cwd, 'MEMORY.md'), 'utf8'), content);
  await writeFile(join(f.cwd, 'MEMORY.md'), '# Agent 刚刚更新的内容\n');
  const conflict = await f.call(memoryPath, 'PUT', { content: 'stale', revision: saved.revision });
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json() as { error: string }).error, /重新加载/);
  assert.equal(await readFile(join(f.cwd, 'MEMORY.md'), 'utf8'), '# Agent 刚刚更新的内容\n');
  const noRevision = await f.call(memoryPath, 'PUT', { content: 'no revision' });
  assert.equal(noRevision.status, 409);
});

test('two simultaneous saves from the same revision cannot overwrite each other', async t => {
  const f = await fixture(t);
  const path = '/api/groups/123456/documents/PERSONA.md';
  const document = await f.get<Document>(path);
  const results = await Promise.all([
    f.call(path, 'PUT', { content: '# 第一份编辑', revision: document.revision }),
    f.call(path, 'PUT', { content: '# 第二份编辑', revision: document.revision }),
  ]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  const current = await readFile(join(f.cwd, 'PERSONA.md'), 'utf8');
  assert.ok(current === '# 第一份编辑' || current === '# 第二份编辑');
});

test('connection edits preserve Markdown around the JSON block and reject group changes', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'PIQ.md'), '# 自定义连接说明\n\n请保留这段。\n\n```json\n' + JSON.stringify(await loadConfig(f.cwd), null, 2) + '\n```\n\n尾部说明也需要保留。\n');
  const group = await f.get<Group>('/api/groups/123456');
  const config = { ...group.config, quietMs: 2500, maxWaitMs: 12000, wsUrl: 'ws://127.0.0.1:3010/' };
  const response = await f.call('/api/groups/123456/config', 'PUT', { config, revision: group.configRevision });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await loadConfig(f.cwd), config);
  const markdown = await readFile(join(f.cwd, 'PIQ.md'), 'utf8');
  assert.match(markdown, /^# 自定义连接说明\n\n请保留这段。/);
  assert.match(markdown, /尾部说明也需要保留。\n$/);
  const refreshed = await f.get<Group>('/api/groups/123456');
  assert.equal((await f.call('/api/groups/123456/config', 'PUT', {
    config: { ...config, id: '654321' }, revision: refreshed.configRevision,
  })).status, 400);
  assert.equal((await f.call('/api/groups/123456/config', 'PUT', {
    config: { ...config, wsUrl: 'ws://token:secret@localhost:3000/' }, revision: refreshed.configRevision,
  })).status, 400);
  assert.equal((await f.call('/api/groups/123456/config', 'PUT', { config, revision: group.configRevision })).status, 409);
  assert.equal(await readFile(join(f.cwd, 'PIQ.md'), 'utf8'), markdown);
});

test('JSONL logs are read-only, preserve multiline content, and exclude Markdown files', async t => {
  const f = await fixture(t);
  const text = '第一行\n第二行：你好 🐲\n```json\n{"external":"text"}\n```\n<script>text only</script>';
  const older = logLine(logRecord(1, text));
  await writeFile(join(f.messageDir, '2026-10-25.jsonl'), older);
  await writeFile(join(f.messageDir, '2026-10-26.jsonl'), logLine(logRecord(2)));
  await writeFile(join(f.messageDir, '2026-10-27.md'), '# Legacy journal should not be exposed\n');
  const group = await f.get<Group>('/api/groups/123456');
  assert.deepEqual(group.logs['group:123456'], ['2026-10-26.jsonl', '2026-10-25.jsonl']);
  assert.deepEqual(await f.get('/api/groups/123456/logs/group:123456/2026-10-25.jsonl'), { content: older, truncated: false });
  assert.equal(JSON.parse(older).rawText, text);
  assert.equal(older.split('\n').length, 2, 'embedded message newlines stay inside one JSONL record');
  assert.equal((await f.call('/api/groups/123456/logs/group:123456/2026-10-27.md')).status, 404);
  assert.equal((await f.call('/api/groups/123456/logs/2026-10-25.jsonl')).status, 404);
  assert.equal((await f.call('/api/groups/123456/logs/group:123456/2026-10-25.jsonl', 'PUT', { content: 'replacement' })).status, 404);
  assert.equal(await readFile(join(f.messageDir, '2026-10-25.jsonl'), 'utf8'), older);
});

test('mixed message and poke journals retain explicit events and isolated conversation routes', async t => {
  const f = await fixture(t);
  const path = join(f.messageDir, '2026-10-26.jsonl');
  const route = '/api/groups/123456/logs/group:123456/2026-10-26.jsonl';
  const records = [logRecord(1), pokeRecord(2), pokeRecord(3, {
    eventId: 'd0a3ca10-0d11-4f38-9626-ea66925be84c', source: 'action', userId: '111111', targetId: '222222', outgoing: true,
  })];
  const content = records.map(record => JSON.stringify(record) + '\n').join('');
  await writeFile(path, content);
  assert.deepEqual(await f.get(route), { content, truncated: false });
  assert.deepEqual((await f.get<Group>('/api/groups/123456')).logs['group:123456'], ['2026-10-26.jsonl']);
  assert.equal('messageId' in records[1]!, false);
  assert.equal('messageSeq' in records[1]!, false);
  await writeFile(path, JSON.stringify(pokeRecord(2, { conversation: { type: 'private', id: '123456' } })) + '\n');
  const mismatch = await f.call(route);
  assert.equal(mismatch.status, 400, await mismatch.clone().text());
  assert.match((await mismatch.json() as { error: string }).error, /来源对话/);
});

test('poke journals reject malformed identities and invented message identifiers without modifying the log', async t => {
  const f = await fixture(t);
  const path = join(f.messageDir, '2026-10-26.jsonl');
  const route = '/api/groups/123456/logs/group:123456/2026-10-26.jsonl';
  for (const changes of [
    { eventId: 'not-an-event-id' }, { source: 'unknown' }, { source: 'action' },
    { targetId: '' }, { userId: '-1' }, { outgoing: true },
    { messageId: '-123' }, { messageSeq: '123' }, { kind: 'unknown' },
    { conversation: { type: 'temporary', sourceGroupId: '123456', id: '222222' } },
  ]) {
    const content = JSON.stringify(pokeRecord(1, changes)) + '\n';
    await writeFile(path, content);
    const response = await f.call(route);
    assert.equal(response.status, 400, await response.clone().text());
    assert.equal(await readFile(path, 'utf8'), content);
  }
});

test('large JSONL logs return a bounded tail made only of complete records', async t => {
  const f = await fixture(t);
  const records = Array.from({ length: 4000 }, (_, index) => logRecord(index + 1, index === 3999 ? '最后一条消息 🐲' : `普通消息 ${index + 1}`));
  const latest = records.map(logLine).join('');
  assert.ok(Buffer.byteLength(latest) > 512 * 1024);
  await writeFile(join(f.messageDir, '2026-10-26.jsonl'), latest);
  const tail = await f.get<{ content: string; truncated: boolean }>('/api/groups/123456/logs/group:123456/2026-10-26.jsonl');
  assert.equal(tail.truncated, true);
  assert.ok(Buffer.byteLength(tail.content) <= 512 * 1024);
  assert.ok(tail.content.endsWith('\n'));
  const returned = tail.content.trimEnd().split('\n').map(line => JSON.parse(line) as ReturnType<typeof logRecord>);
  assert.ok(returned.length > 0 && returned.length < records.length);
  assert.ok(returned[0]!.seq > 1);
  assert.deepEqual(returned.at(-1), records.at(-1));
  assert.deepEqual(returned.map(record => record.seq), records.slice(-returned.length).map(record => record.seq));
  assert.doesNotMatch(tail.content, /\uFFFD/);
});

test('a complete record on the byte limit boundary is retained instead of being mistaken for a partial line', async t => {
  const f = await fixture(t);
  const limit = 512 * 1024;
  const base = logRecord(2, '', { segments: [] });
  const final = logLine({ ...base, rawText: 'x'.repeat(limit - Buffer.byteLength(logLine(base))) });
  assert.equal(Buffer.byteLength(final), limit);
  await writeFile(join(f.messageDir, '2026-10-26.jsonl'), logLine(logRecord(1)) + final);
  assert.deepEqual(await f.get('/api/groups/123456/logs/group:123456/2026-10-26.jsonl'), { content: final, truncated: true });
});

test('oversized last records and malformed JSONL fail clearly instead of returning missing messages', async t => {
  const f = await fixture(t);
  const path = join(f.messageDir, '2026-10-26.jsonl');
  const route = '/api/groups/123456/logs/group:123456/2026-10-26.jsonl';
  await writeFile(path, logLine(logRecord(1)) + logLine(logRecord(2, 'x'.repeat(512 * 1024 + 100))));
  const tooLarge = await f.call(route);
  assert.equal(tooLarge.status, 413, await tooLarge.clone().text());
  assert.match((await tooLarge.json() as { error: string }).error, /512|KB|过大|超|large/i);
  const invalid = [
    '{broken}\n',
    '{"v":1}\n',
    logLine(logRecord(1)) + '{"v":1,"seq":2',
    JSON.stringify(logRecord(1)),
    logLine(logRecord(1, 'invalid conversation type', { conversation: { type: 'unknown', id: '654321' } })),
    logLine(logRecord(1, 'wrong conversation in path', { conversation: { type: 'private', id: '123456' } })),
    logLine(logRecord(1, 'old schema', { v: 1, groupId: '123456' })),
  ];
  for (const content of invalid) {
    await writeFile(path, content);
    const response = await f.call(route);
    assert.equal(response.status, 400, await response.clone().text());
    assert.ok((await response.json() as { error: string }).error.length > 0);
    assert.equal(await readFile(path, 'utf8'), content, 'reading a broken log must not rewrite it');
  }
});

test('group creation is isolated and duplicate requests cannot replace existing documents', async t => {
  const f = await fixture(t);
  const existing = await readFile(join(f.cwd, 'PERSONA.md'), 'utf8');
  const results = await Promise.all([
    f.call('/api/groups', 'POST', { id: '654321', name: 'Second group', conversations: [{ type: 'group', id: '654321' }], wsUrl: 'ws://127.0.0.1:3333/' }),
    f.call('/api/groups', 'POST', { id: '654321', name: 'Second group', conversations: [{ type: 'group', id: '654321' }], wsUrl: 'ws://127.0.0.1:4444/' }),
  ]);
  assert.deepEqual(results.map(response => response.status).sort(), [201, 409]);
  assert.equal((await loadConfig(join(f.root, '654321')))?.id, '654321');
  assert.equal((await f.call('/api/groups', 'POST', { id: '123456', name: 'Duplicate', conversations: [] })).status, 409);
  assert.equal(await readFile(join(f.cwd, 'PERSONA.md'), 'utf8'), existing);
  for (const id of ['../escape', '..\\escape', 'Uppercase', '-start', 'con']) {
    assert.equal((await f.call('/api/groups', 'POST', { id, name: 'Invalid id', conversations: [] })).status, 400);
  }
  assert.equal((await f.call('/api/groups', 'POST', { groupId: '777777' })).status, 400);
});

test('conversation membership is exclusive across group creation and updates', async t => {
  const f = await fixture(t);
  const conflict = await f.call('/api/groups', 'POST', { id: 'conflict', name: 'Conflicting group', conversations: [{ type: 'group', id: '123456' }] });
  assert.equal(conflict.status, 409, await conflict.clone().text());
  assert.match((await conflict.json() as { error: string }).error, /123456/);
  const shared = await f.call('/api/groups', 'POST', { id: 'shared', name: 'Shared dialogs', conversations: [
    { type: 'group', id: '654321' }, { type: 'private', id: '123456' },
  ] });
  assert.equal(shared.status, 201, await shared.clone().text());
  const detail = await f.get<Group>('/api/groups/shared');
  assert.equal(detail.config.name, 'Shared dialogs');
  assert.deepEqual(detail.config.conversations, [{ type: 'group', id: '654321' }, { type: 'private', id: '123456' }]);
  assert.deepEqual(detail.logs, { 'group:654321': [], 'private:123456': [] });
  const updated = await f.call('/api/groups/shared/config', 'PUT', {
    revision: detail.configRevision,
    config: { ...detail.config, conversations: [...detail.config.conversations, { type: 'group', id: '123456' }] },
  });
  assert.equal(updated.status, 409, await updated.clone().text());
  assert.deepEqual((await loadConfig(join(f.root, 'shared')))!.conversations, detail.config.conversations);
  const oldBody = await f.call('/api/groups/shared/config', 'PUT', { revision: detail.configRevision,
    config: { groupId: 'shared', wsUrl: 'ws://127.0.0.1:3000/' } });
  assert.equal(oldBody.status, 400);
});

test('concurrent creation cannot assign one dialog to two groups', async t => {
  const f = await fixture(t);
  const responses = await Promise.all(['one', 'two'].map(id => f.call('/api/groups', 'POST', {
    id, name: id, conversations: [{ type: 'private', id: '777777' }],
  })));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const state = await f.get<State>('/api/state');
  assert.equal(state.groups.filter(group => group.conversations.some(conversation => conversation.type === 'private' && conversation.id === '777777')).length, 1);
});

test('conversation membership changes require a stopped group while labels remain editable', async t => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, '.piq'));
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: 'live-owner' }));
  const detail = await f.get<Group>('/api/groups/123456');
  const changed = await f.call('/api/groups/123456/config', 'PUT', {
    revision: detail.configRevision,
    config: { ...detail.config, conversations: [...detail.config.conversations, { type: 'private', id: '777777' }] },
  });
  assert.equal(changed.status, 409, await changed.clone().text());
  const renamed = await f.call('/api/groups/123456/config', 'PUT', {
    revision: detail.configRevision, config: { ...detail.config, name: 'Shared title' },
  });
  assert.equal(renamed.status, 200, await renamed.clone().text());
  assert.equal((await loadConfig(f.cwd))!.name, 'Shared title');
});

test('each dialog has separate JSONL paths inside the shared group', async t => {
  const f = await fixture(t);
  const detail = await f.get<Group>('/api/groups/123456');
  assert.equal((await f.call('/api/groups/123456/config', 'PUT', {
    revision: detail.configRevision, config: { ...detail.config, conversations: [...detail.config.conversations, { type: 'private', id: '123456' }] },
  })).status, 200);
  const privateDir = join(f.cwd, 'messages', 'private', '123456');
  await mkdir(privateDir, { recursive: true });
  const groupContent = logLine(logRecord(1, 'GROUP_ONLY'));
  const privateContent = logLine(logRecord(2, 'PRIVATE_ONLY', { conversation: { type: 'private', id: '123456' } }));
  await writeFile(join(f.messageDir, '2026-10-26.jsonl'), groupContent);
  await writeFile(join(privateDir, '2026-10-26.jsonl'), privateContent);
  const refreshed = await f.get<Group>('/api/groups/123456');
  assert.deepEqual(refreshed.logs, { 'group:123456': ['2026-10-26.jsonl'], 'private:123456': ['2026-10-26.jsonl'] });
  assert.deepEqual(await f.get('/api/groups/123456/logs/group:123456/2026-10-26.jsonl'), { content: groupContent, truncated: false });
  assert.deepEqual(await f.get('/api/groups/123456/logs/private:123456/2026-10-26.jsonl'), { content: privateContent, truncated: false });
  assert.equal((await f.call('/api/groups/123456/logs/group:654321/2026-10-26.jsonl')).status, 404);
  assert.ok([400, 404].includes((await f.call('/api/groups/123456/logs/group%3A..%2F..%2F123456/2026-10-26.jsonl')).status));
});

test('temporary dialog logs include their source group and stay separate from direct private logs', async t => {
  const f = await fixture(t);
  const detail = await f.get<Group>('/api/groups/123456');
  const temporary = { type: 'temporary', id: '777777', sourceGroupId: '123456' };
  assert.equal((await f.call('/api/groups/123456/config', 'PUT', {
    revision: detail.configRevision,
    config: { ...detail.config, conversations: [...detail.config.conversations, temporary, { type: 'private', id: '777777' }] },
  })).status, 200);
  const temporaryDir = join(f.cwd, 'messages', 'temporary', '123456', '777777');
  const privateDir = join(f.cwd, 'messages', 'private', '777777');
  await mkdir(temporaryDir, { recursive: true }); await mkdir(privateDir, { recursive: true });
  const content = logLine(logRecord(1, 'TEMPORARY_ONLY', { conversation: temporary }));
  const direct = logLine(logRecord(2, 'DIRECT_ONLY', { conversation: { type: 'private', id: '777777' } }));
  await writeFile(join(temporaryDir, '2026-10-26.jsonl'), content);
  await writeFile(join(privateDir, '2026-10-26.jsonl'), direct);
  const current = await f.get<Group>('/api/groups/123456');
  assert.deepEqual(current.logs['temporary:123456:777777'], ['2026-10-26.jsonl']);
  assert.deepEqual(await f.get('/api/groups/123456/logs/temporary:123456:777777/2026-10-26.jsonl'), { content, truncated: false });
  assert.deepEqual(await f.get('/api/groups/123456/logs/private:777777/2026-10-26.jsonl'), { content: direct, truncated: false });
});

test('empty groups can be created for setup, and stop releases a live owner before membership edits', async t => {
  const f = await fixture(t);
  const created = await f.call('/api/groups', 'POST', { name: 'Empty setup group', conversations: [] });
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = await created.json() as { id: string };
  assert.match(id, /^[a-z0-9][a-z0-9_-]*$/);
  assert.equal((await f.call(`/api/groups/${id}/start`, 'POST', {})).status, 400);
  assert.deepEqual(f.launched, []);
  assert.equal((await f.call(`/api/groups/${id}/stop`, 'POST', {})).status, 200);
  await mkdir(join(f.cwd, '.piq'), { recursive: true });
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: 'stop-owner' }));
  assert.equal((await f.call('/api/groups/123456/stop', 'POST', {})).status, 200);
  assert.deepEqual(f.actions, ['shutdown']);
  const detail = await f.get<Group>('/api/groups/123456');
  assert.equal((await f.call('/api/groups/123456/config', 'PUT', {
    revision: detail.configRevision, config: { ...detail.config, conversations: [{ type: 'private', id: '999999' }] },
  })).status, 200);
});

test('stop cancels a pending terminal return even after the terminal owner has disappeared', async t => {
  const f = await fixture(t);
  const directory = join(f.cwd, '.piq');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'terminal-return.json'), JSON.stringify({
    version: 1, token: 'pending-terminal-return', launcherPid: process.pid, monitorPid: process.pid,
    createdAt: Date.now(), state: 'watching',
  }));
  await writeFile(join(directory, 'run-preferences.json'), JSON.stringify({ version: 1, paused: true, interrupted: true }));
  const response = await f.call('/api/groups/123456/stop', 'POST', {});
  assert.equal(response.status, 200);
  await assert.rejects(readFile(join(directory, 'terminal-return.json')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'run-preferences.json'), 'utf8')),
    { version: 1, paused: true, interrupted: false });
  assert.deepEqual(f.actions, []);
});

test('opening a background group uses a handoff rather than an explicit stop', async t => {
  const f = await fixture(t);
  const directory = join(f.cwd, '.piq');
  await mkdir(directory, { recursive: true });
  const token = 'handoff-owner';
  await writeFile(join(directory, 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token }));
  await writeFile(join(directory, 'worker.json'), JSON.stringify({ version: 1, mode: 'background', pid: process.pid,
    launchId: 'test-launch', startedAt: Date.now(), state: 'running', ownerToken: token }));
  const response = await f.call('/api/groups/123456/open', 'POST', {});
  assert.equal(response.status, 200);
  assert.deepEqual(f.actions, ['handoff']);
  assert.equal(f.launched.length, 1);
});

for (const startupFile of ['worker.json', 'worker-launch.json']) test(`stop waits through ${startupFile} before stopping its newly acquired owner`, async t => {
  const f = await fixture(t);
  const directory = join(f.cwd, '.piq');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, startupFile), JSON.stringify({ version: 1, pid: process.pid,
    launchId: 'test-starting', startedAt: Date.now(),
    ...(startupFile === 'worker.json' ? { mode: 'background', state: 'starting' } : {}) }));
  const stopping = f.call('/api/groups/123456/stop', 'POST', {});
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(f.actions, []);
  await writeFile(join(directory, 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: 'late-owner' }));
  assert.equal((await stopping).status, 200);
  assert.deepEqual(f.actions, ['shutdown']);
  await assert.rejects(readFile(join(directory, 'owner.lock')), { code: 'ENOENT' });
});

test('terminal requests are deduplicated and an existing group owner is respected', async t => {
  const f = await fixture(t);
  const responses = await Promise.all([
    f.call('/api/groups/123456/open', 'POST', {}),
    f.call('/api/groups/123456/open', 'POST', {}),
  ]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(f.launched.length, 1);
  assert.equal(f.launched[0], await realpath(f.cwd));
  const bodies = await Promise.all(responses.map(response => response.json())) as Array<{ alreadyRunning?: boolean }>;
  assert.equal(bodies.filter(body => body.alreadyRunning).length, 1);
  const second = await initializeGroup(f.root, '654321', { name: 'Other group', conversations: [{ type: 'group', id: '654321' }] });
  await mkdir(join(second, '.piq'));
  await writeFile(join(second, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: 'test-owner' }));
  const active = await f.call('/api/groups/654321/open', 'POST', {});
  assert.equal(active.status, 200);
  assert.equal((await active.json() as { alreadyRunning: boolean }).alreadyRunning, true);
  assert.equal(f.launched.length, 1);
});

test('start and open share one terminal launch without creating a background worker', async t => {
  const f = await fixture(t);
  const responses = await Promise.all([
    f.call('/api/groups/123456/start', 'POST', {}),
    f.call('/api/groups/123456/open', 'POST', {}),
  ]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(f.launched.length, 1);
  assert.deepEqual(f.launchOptions, [{ freshSession: false }]);
  await assert.rejects(readFile(join(f.cwd, '.piq', 'worker.json')), { code: 'ENOENT' });
  assert.equal((await f.call('/api/groups/123456', 'DELETE')).status, 409, 'a pending launch cannot be moved to trash');
});

test('stop retains a live terminal without an owner lock and prevents deletion or replacement', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  try {
    assert.ok(child.pid);
    const lease = await prepareTerminalReturn(f.cwd);
    await registerTerminal(f.cwd, lease.token, child.pid, child.pid);
    assert.equal((await getProcessStatus(f.cwd)).running, true);
    const stop = await f.call('/api/groups/123456/stop', 'POST', {});
    assert.equal(stop.status, 409, await stop.clone().text());
    assert.equal((await getProcessStatus(f.cwd)).running, true);
    assert.ok(await readFile(join(f.cwd, '.piq', 'terminal-return.json'), 'utf8'));
    assert.equal((await f.call('/api/groups/123456', 'DELETE')).status, 409);
    assert.equal((await f.call('/api/groups/123456/new-session', 'POST', {})).status, 409);
    assert.deepEqual(f.launched, []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); });
      child.kill();
      await exited;
    }
  }
  assert.equal((await f.call('/api/groups/123456/stop', 'POST', {})).status, 200);
  assert.equal((await getProcessStatus(f.cwd)).running, false);
});

test('stop waits for the tracked Pi process after its owner lock is released', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  try {
    assert.ok(child.pid);
    const lease = await prepareTerminalReturn(f.cwd);
    await registerTerminal(f.cwd, lease.token, child.pid, child.pid);
    await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: child.pid, token: 'exiting-owner' }));
    let settled = false;
    const stopping = f.call('/api/groups/123456/stop', 'POST', {}).then(response => { settled = true; return response; });
    const deadline = Date.now() + 2_000;
    while (!f.actions.includes('shutdown')) {
      assert.ok(Date.now() < deadline, 'shutdown request should be issued');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(settled, false, 'releasing owner.lock alone is not process exit');
    assert.equal((await getProcessStatus(f.cwd)).running, true);
    const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); });
    child.kill(); await exited;
    const response = await stopping;
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await getProcessStatus(f.cwd)).running, false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); });
      child.kill(); await exited;
    }
  }
});

test('a new session stops its owner and requests fresh context while preserving local records', async t => {
  const f = await fixture(t);
  const directory = join(f.cwd, '.piq');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: 'old-session-owner' }));
  await writeFile(join(directory, 'run-preferences.json'), JSON.stringify({ version: 1, paused: true, interrupted: true }));
  await mkdir(join(f.cwd, '.pi', 'sessions'), { recursive: true });
  const previous = join(f.cwd, '.pi', 'sessions', 'previous.jsonl');
  await writeFile(previous, 'PREVIOUS_CONTEXT');
  await writeFile(join(f.cwd, 'MEMORY.md'), 'RETAINED_MEMORY');
  const journal = join(f.messageDir, '2026-10-26.jsonl');
  const contents = logLine(logRecord(1));
  await writeFile(journal, contents);
  const response = await f.call('/api/groups/123456/new-session', 'POST', {});
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json() as { freshSession: boolean }).freshSession, true);
  assert.deepEqual(f.actions, ['shutdown']);
  assert.deepEqual(f.launchOptions, [{ freshSession: true }]);
  assert.equal(await readFile(previous, 'utf8'), 'PREVIOUS_CONTEXT');
  assert.equal(await readFile(join(f.cwd, 'MEMORY.md'), 'utf8'), 'RETAINED_MEMORY');
  assert.equal(await readFile(journal, 'utf8'), contents);
  assert.equal(JSON.parse(await readFile(join(directory, 'run-preferences.json'), 'utf8')).interrupted, false);
  assert.equal((await f.call('/api/groups/123456/new-session', 'POST', {})).status, 409, 'cannot replace a session still launching');
});

test('recycle bin endpoints preserve the whole group and restore it with its original identity', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'MEMORY.md'), 'KEEP_MEMORY');
  const journal = join(f.messageDir, '2026-10-26.jsonl');
  const contents = logLine(logRecord(1));
  await writeFile(journal, contents);
  const deletedResponse = await f.call('/api/groups/123456', 'DELETE');
  assert.equal(deletedResponse.status, 200, await deletedResponse.clone().text());
  const deleted = await deletedResponse.json() as { token: string; recoveryPath: string; id: string };
  assert.equal(deleted.id, '123456');
  assert.equal((await f.get<State>('/api/state')).groups.length, 0);
  const trash = await f.get<{ entries: Array<{ token: string; id: string; name: string; deletedAt: number }> }>('/api/trash');
  assert.equal(trash.entries.length, 1);
  assert.equal(trash.entries[0]!.token, deleted.token);
  assert.equal(trash.entries[0]!.name, 'Test conversation group');
  assert.equal(await readFile(join(deleted.recoveryPath, 'MEMORY.md'), 'utf8'), 'KEEP_MEMORY');
  const restored = await f.call(`/api/trash/${encodeURIComponent(deleted.token)}/restore`, 'POST', {});
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.equal((await restored.json() as { id: string }).id, '123456');
  assert.equal(await readFile(join(f.cwd, 'MEMORY.md'), 'utf8'), 'KEEP_MEMORY');
  assert.equal(await readFile(journal, 'utf8'), contents);
  assert.deepEqual(await f.get('/api/trash'), { entries: [] });
});

test('trash mutations require local authorization and restoration refuses assignment conflicts', async t => {
  const f = await fixture(t);
  const unauthorized = await fetch(`${f.app.url}/api/groups/123456`, { method: 'DELETE' });
  assert.equal(unauthorized.status, 403);
  await mkdir(join(f.cwd, '.piq'), { recursive: true });
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: 'live-owner' }));
  assert.equal((await f.call('/api/groups/123456', 'DELETE')).status, 409);
  await unlink(join(f.cwd, '.piq', 'owner.lock'));
  const deleted = await (await f.call('/api/groups/123456', 'DELETE')).json() as { token: string; recoveryPath: string };
  const endpoint = `/api/trash/${encodeURIComponent(deleted.token)}/restore`;
  assert.equal((await fetch(f.app.url + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  for (const token of ['..', '..%2F123456', '..%5C123456', 'invalid']) {
    assert.ok([400, 404].includes((await f.call(`/api/trash/${token}/restore`, 'POST', {})).status));
  }
  await initializeGroup(f.root, 'replacement', { name: 'New owner', conversations: [{ type: 'group', id: '123456' }] });
  assert.equal((await f.call(endpoint, 'POST', {})).status, 409);
  assert.equal((await f.get<{ entries: unknown[] }>('/api/trash')).entries.length, 1);
  assert.ok(await readFile(join(deleted.recoveryPath, 'PIQ.md'), 'utf8'));
});

test('foreign origins, missing CSRF tokens, spoofed hosts and escaped paths are rejected', async t => {
  const f = await fixture(t);
  const rejectedHeaders: Record<string, string>[] = [
    { 'Content-Type': 'application/json', Origin: 'https://foreign.example', 'X-PiQ-Token': f.state.csrfToken },
    { 'Content-Type': 'application/json', Origin: f.app.url },
    { 'Content-Type': 'application/json', Origin: f.app.url, 'X-PiQ-Token': 'invalid' },
  ];
  for (const headers of rejectedHeaders) {
    const response = await fetch(`${f.app.url}/api/groups/123456/open`, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 403);
  }
  assert.equal(f.launched.length, 0);
  const spoofed = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(f.app.url + '/api/state', { headers: { Host: 'attacker.example' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject); request.end();
  });
  assert.equal(spoofed, 403);
  for (const path of [
    '/api/groups/123456/documents/PIQ.md',
    '/api/groups/123456/documents/..%2FPIQ.md',
    '/api/groups/123456/documents/..%5CPIQ.md',
    '/api/groups/%2e%2e/documents/PERSONA.md',
    '/api/groups/123456/logs/..%2FAGENTS.md',
    '/..%2Fpackage.json',
  ]) {
    const response = await f.call(path);
    assert.ok([400, 404].includes(response.status), `${path}: ${response.status}`);
  }
});

test('a document symlink cannot expose a file outside its group', async t => {
  const f = await fixture(t);
  const other = await initializeGroup(f.root, '654321', { name: 'Other group', conversations: [{ type: 'group', id: '654321' }] });
  const privatePath = join(other, 'MEMORY.md');
  await writeFile(privatePath, 'OTHER_GROUP_PRIVATE_DATA');
  try { await symlink(privatePath, join(f.cwd, 'MEMORY.md'), 'file'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('This OS sandbox does not permit symlink creation.'); return; }
    throw error;
  }
  const response = await f.call('/api/groups/123456/documents/MEMORY.md');
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /OTHER_GROUP_PRIVATE_DATA/);
  const save = await f.call('/api/groups/123456/documents/MEMORY.md', 'PUT', { content: 'overwrite', revision: 'irrelevant' });
  assert.equal(save.status, 400);
  assert.equal(await readFile(privatePath, 'utf8'), 'OTHER_GROUP_PRIVATE_DATA');
});

test('model API preserves Pi settings and safely addresses live changes to the current owner', async t => {
  const catalog: ModelCatalog = { models: [{ provider: 'test-provider', id: 'test-model', name: 'Test Model', thinkingLevels: ['off', 'low', 'medium', 'high'] }] };
  const f = await fixture(t, catalog);
  const settingsPath = join(f.cwd, '.pi', 'settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  const originalPackages = settings.packages;
  await writeFile(settingsPath, JSON.stringify({ ...settings, theme: 'existing-theme', privateTestToken: 'KEEP_ON_DISK_ONLY' }, null, 2));

  const publicCatalog = await f.get<ModelCatalog>('/api/models');
  assert.deepEqual(publicCatalog, catalog);
  assert.deepEqual(Object.keys(publicCatalog.models[0]!).sort(), ['id', 'name', 'provider', 'thinkingLevels']);
  assert.doesNotMatch(JSON.stringify(publicCatalog), /KEEP_ON_DISK_ONLY/);
  const path = '/api/groups/123456/model';
  const initial = await f.get<{ revision: string; runtime: null }>(path);
  assert.equal(initial.runtime, null);
  assert.doesNotMatch(JSON.stringify(initial), /KEEP_ON_DISK_ONLY|packages|existing-theme/);

  const thinkingOnly = await f.call(path, 'PUT', { thinkingLevel: 'medium', revision: initial.revision });
  assert.equal(thinkingOnly.status, 200, await thinkingOnly.clone().text());
  const thought = await thinkingOnly.json() as { revision: string; thinkingLevel: string; provider?: string; model?: string };
  assert.equal(thought.thinkingLevel, 'medium');
  assert.equal(thought.provider, undefined);
  assert.equal(thought.model, undefined);
  const afterThinking = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(afterThinking.packages, originalPackages);
  assert.equal(afterThinking.theme, 'existing-theme');
  assert.equal(afterThinking.privateTestToken, 'KEEP_ON_DISK_ONLY');
  assert.equal(afterThinking.defaultThinkingLevel, 'medium');
  assert.equal((await f.call(path, 'PUT', { thinkingLevel: 'low', revision: initial.revision })).status, 409);

  await mkdir(join(f.cwd, '.piq'));
  const ownerToken = 'INTERNAL_OWNER_TOKEN';
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: ownerToken }));
  const updatedAt = Date.now();
  await writeFile(join(f.cwd, '.piq', 'model-status.json'), JSON.stringify({
    version: 1, pid: process.pid, ownerToken, provider: 'old-provider', model: 'old-model',
    thinkingLevel: 'low', status: 'ready', updatedAt, extraSecret: 'OMIT_RUNTIME_EXTRA',
  }));
  const withRuntime = await f.get<{ runtime: Record<string, unknown>; revision: string }>(path);
  assert.deepEqual(withRuntime.runtime, {
    pid: process.pid, status: 'ready', updatedAt, provider: 'old-provider', model: 'old-model', thinkingLevel: 'low',
  });
  assert.doesNotMatch(JSON.stringify(withRuntime), /INTERNAL_OWNER_TOKEN|ownerToken|OMIT_RUNTIME_EXTRA|KEEP_ON_DISK_ONLY/);

  const response = await f.call(path, 'PUT', { provider: 'test-provider', model: 'test-model', thinkingLevel: 'high', revision: withRuntime.revision });
  assert.equal(response.status, 200, await response.clone().text());
  const selected = await response.json() as { requestId: string; provider: string; model: string; thinkingLevel: string; revision: string };
  assert.match(selected.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(selected.model, 'test-model');
  assert.doesNotMatch(JSON.stringify(selected), /INTERNAL_OWNER_TOKEN|ownerToken|OMIT_RUNTIME_EXTRA|KEEP_ON_DISK_ONLY/);
  const request = JSON.parse(await readFile(join(f.cwd, '.piq', 'model-request.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(request, {
    version: 1, requestId: selected.requestId, targetPid: process.pid, ownerToken,
    provider: 'test-provider', model: 'test-model', thinkingLevel: 'high',
  });
  const finalSettings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(finalSettings.packages, originalPackages);
  assert.equal(finalSettings.theme, 'existing-theme');
  assert.equal(finalSettings.privateTestToken, 'KEEP_ON_DISK_ONLY');
});
