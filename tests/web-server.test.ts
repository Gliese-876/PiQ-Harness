import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, realpath, unlink, readdir } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { conversationDirectory } from '../src/conversations.ts';
import { initializeGroup, loadConfig, type GroupConfig } from '../src/config.ts';
import { startWebServer, type WebOptions } from '../src/web-server.ts';
import { createWebDiscovery, type WebDiscovery } from '../src/web-discovery.ts';
import type { ModelCatalog } from '../src/web-models.ts';
import { getProcessStatus } from '../src/process-manager.ts';
import { prepareTerminalLaunch, registerTerminal } from '../src/terminal-monitor.ts';
import { GroupStore } from '../src/store.ts';

interface State {
  root: string;
  csrfToken: string;
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
  return { v: 3, seq, receivedAt: 1793000000000 + seq, conversation: { type: 'group', id: 'GROUP_OPENID_A' },
    messageId: `official-message-${seq}`, selfId: '111111', userId: '222222',
    sender: '测试成员', time: 1793000000, rawText: text,
    attachments: [], raw: { content: text }, outgoing: false, ...changes };
}

const logLine = (record: ReturnType<typeof logRecord>) => JSON.stringify(record) + '\n';

async function fixture(t: TestContext, catalog: ModelCatalog = { models: [] }, overrides: Partial<WebOptions> = {}) {
  const parent = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'web-server-'));
  const cwd = await initializeGroup(root, '123456', { name: 'Test conversation group', conversations: [{ type: 'group', id: 'GROUP_OPENID_A' }] });
  const messageDir = join(cwd, conversationDirectory({ type: 'group', id: 'GROUP_OPENID_A' }));
  await mkdir(messageDir, { recursive: true });
  const launched: string[] = [];
  const launchOptions: Array<{ freshSession?: boolean }> = [];
  const actions: string[] = [];
  const app = await startWebServer({
    root, port: 0,
    openTerminal: async (path, options) => { launched.push(path); launchOptions.push({ freshSession: options?.freshSession }); return { message: '已请求打开测试终端。' }; },
    credentials: async () => ({ available: true, source: '测试凭据来源' }),
    models: async () => catalog,
    action: async (path, action) => {
      actions.push(action);
      if (action === 'shutdown' || action === 'handoff') {
        await unlink(join(path, '.piq', 'owner.lock'));

      }
      return { requestId: `mock-${action}` };
    },
    ...overrides,
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
  assert.equal('defaultAppIdEnv' in f.state, false);
  assert.equal('defaultAppSecretEnv' in f.state, false);
  assert.match(f.state.csrfToken, /^[0-9a-f]{64}$/);
  assert.deepEqual(f.state.groups.map(group => group.id), ['123456']);
  assert.equal(f.state.groups[0]?.name, 'Test conversation group');
  assert.deepEqual(f.state.groups[0]?.conversations, [{ type: 'group', id: 'GROUP_OPENID_A' }]);
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
  const config = { ...group.config, quietMs: 2500, maxWaitMs: 12000, groupMemberEvents: true };
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
    config: { ...config, appSecretEnv: 'invalid-secret-variable!' }, revision: refreshed.configRevision,
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
  assert.deepEqual(group.logs['group:GROUP_OPENID_A'], ['2026-10-26.jsonl', '2026-10-25.jsonl']);
  assert.deepEqual(await f.get('/api/groups/123456/logs/group:GROUP_OPENID_A/2026-10-25.jsonl'), { content: older, truncated: false });
  assert.equal(JSON.parse(older).rawText, text);
  assert.equal(older.split('\n').length, 2, 'embedded message newlines stay inside one JSONL record');
  assert.equal((await f.call('/api/groups/123456/logs/group:GROUP_OPENID_A/2026-10-27.md')).status, 404);
  assert.equal((await f.call('/api/groups/123456/logs/2026-10-25.jsonl')).status, 404);
  assert.equal((await f.call('/api/groups/123456/logs/group:GROUP_OPENID_A/2026-10-25.jsonl', 'PUT', { content: 'replacement' })).status, 404);
  assert.equal(await readFile(join(f.messageDir, '2026-10-25.jsonl'), 'utf8'), older);
});

test('large JSONL logs return a bounded tail made only of complete records', async t => {
  const f = await fixture(t);
  const records = Array.from({ length: 4000 }, (_, index) => logRecord(index + 1, index === 3999 ? '最后一条消息 🐲' : `普通消息 ${index + 1}`));
  const latest = records.map(logLine).join('');
  assert.ok(Buffer.byteLength(latest) > 512 * 1024);
  await writeFile(join(f.messageDir, '2026-10-26.jsonl'), latest);
  const tail = await f.get<{ content: string; truncated: boolean }>('/api/groups/123456/logs/group:GROUP_OPENID_A/2026-10-26.jsonl');
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
  const base = logRecord(2, '', { attachments: [] });
  const final = logLine({ ...base, rawText: 'x'.repeat(limit - Buffer.byteLength(logLine(base))) });
  assert.equal(Buffer.byteLength(final), limit);
  await writeFile(join(f.messageDir, '2026-10-26.jsonl'), logLine(logRecord(1)) + final);
  assert.deepEqual(await f.get('/api/groups/123456/logs/group:GROUP_OPENID_A/2026-10-26.jsonl'), { content: final, truncated: true });
});

test('oversized last records and malformed JSONL fail clearly instead of returning missing messages', async t => {
  const f = await fixture(t);
  const path = join(f.messageDir, '2026-10-26.jsonl');
  const route = '/api/groups/123456/logs/group:GROUP_OPENID_A/2026-10-26.jsonl';
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
    logLine(logRecord(1, 'wrong conversation in path', { conversation: { type: 'private', id: 'USER_OPENID_A' } })),
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
    f.call('/api/groups', 'POST', { id: '654321', name: 'Second group', conversations: [{ type: 'group', id: '654321' }] }),
    f.call('/api/groups', 'POST', { id: '654321', name: 'Second group', conversations: [{ type: 'group', id: '654321' }] }),
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
  const conflict = await f.call('/api/groups', 'POST', { id: 'conflict', name: 'Conflicting group', conversations: [{ type: 'group', id: 'GROUP_OPENID_A' }] });
  assert.equal(conflict.status, 409, await conflict.clone().text());
  assert.match((await conflict.json() as { error: string }).error, /123456/);
  const shared = await f.call('/api/groups', 'POST', { id: 'shared', name: 'Shared dialogs', conversations: [
    { type: 'group', id: '654321' }, { type: 'private', id: 'USER_OPENID_A' },
  ] });
  assert.equal(shared.status, 201, await shared.clone().text());
  const detail = await f.get<Group>('/api/groups/shared');
  assert.equal(detail.config.name, 'Shared dialogs');
  assert.deepEqual(detail.config.conversations, [{ type: 'group', id: '654321' }, { type: 'private', id: 'USER_OPENID_A' }]);
  assert.deepEqual(detail.logs, { 'group:654321': [], 'private:USER_OPENID_A': [] });
  const updated = await f.call('/api/groups/shared/config', 'PUT', {
    revision: detail.configRevision,
    config: { ...detail.config, conversations: [...detail.config.conversations, { type: 'group', id: 'GROUP_OPENID_A' }] },
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
    revision: detail.configRevision, config: { ...detail.config, conversations: [...detail.config.conversations, { type: 'private', id: 'USER_OPENID_A' }] },
  })).status, 200);
  const privateDir = join(f.cwd, conversationDirectory({ type: 'private', id: 'USER_OPENID_A' }));
  await mkdir(privateDir, { recursive: true });
  const groupContent = logLine(logRecord(1, 'GROUP_ONLY'));
  const privateContent = logLine(logRecord(2, 'PRIVATE_ONLY', { conversation: { type: 'private', id: 'USER_OPENID_A' } }));
  await writeFile(join(f.messageDir, '2026-10-26.jsonl'), groupContent);
  await writeFile(join(privateDir, '2026-10-26.jsonl'), privateContent);
  const refreshed = await f.get<Group>('/api/groups/123456');
  assert.deepEqual(refreshed.logs, { 'group:GROUP_OPENID_A': ['2026-10-26.jsonl'], 'private:USER_OPENID_A': ['2026-10-26.jsonl'] });
  assert.deepEqual(await f.get('/api/groups/123456/logs/group:GROUP_OPENID_A/2026-10-26.jsonl'), { content: groupContent, truncated: false });
  assert.deepEqual(await f.get('/api/groups/123456/logs/private:USER_OPENID_A/2026-10-26.jsonl'), { content: privateContent, truncated: false });
  assert.equal((await f.call('/api/groups/123456/logs/group:654321/2026-10-26.jsonl')).status, 404);
  assert.ok([400, 404].includes((await f.call('/api/groups/123456/logs/group%3A..%2F..%2F123456/2026-10-26.jsonl')).status));
});

test('official identities reject temporary conversations and old endpoint configuration', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/groups', 'POST', { id: 'invalid', name: 'Invalid', conversations: [{ type: 'temporary', id: 'OPENID_A', sourceGroupId: 'OPENID_B' }] })).status, 400);
  assert.equal((await f.call('/api/groups', 'POST', { id: 'invalid', name: 'Invalid', conversations: [], wsUrl: 'ws://localhost:3001/' })).status, 400);
  for (const suffix of ['recover', 'snowluma']) assert.equal((await f.call('/api/groups/123456/' + suffix, 'POST', {})).status, 404);
  for (const fields of [{ appId: 'ACTUAL_APP_ID' }, { appSecret: 'ACTUAL_SECRET' }, { appSecretEnv: 'not a variable' }]) {
    assert.equal((await f.call('/api/groups', 'POST', { id: 'invalid', name: 'Invalid', conversations: [], ...fields })).status, 400);
  }
});

test('case-sensitive OpenIDs use separate hashed logs and removed members retain their official history', async t => {
  const f = await fixture(t);
  const before = await f.get<Group>('/api/groups/123456');
  const sources = [{ type: 'group' as const, id: 'Case_OpenID' }, { type: 'group' as const, id: 'case_openid' }];
  assert.equal((await f.call('/api/groups/123456/config', 'PUT', {
    config: { ...before.config, conversations: sources }, revision: before.configRevision,
  })).status, 200);
  assert.notEqual(conversationDirectory(sources[0]!), conversationDirectory(sources[1]!));
  for (const [index, conversation] of sources.entries()) {
    const directory = join(f.cwd, conversationDirectory(conversation));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '2026-10-26.jsonl'), logLine(logRecord(index + 1, conversation.id, { conversation })));
  }
  const configured = await f.get<Group>('/api/groups/123456');
  assert.deepEqual(configured.logs, { 'group:Case_OpenID': ['2026-10-26.jsonl'], 'group:case_openid': ['2026-10-26.jsonl'] });
  assert.equal((await f.call('/api/groups/123456/config', 'PUT', {
    config: { ...configured.config, conversations: [] }, revision: configured.configRevision,
  })).status, 200);
  const retained = await f.get<Group>('/api/groups/123456');
  assert.deepEqual(retained.logs, configured.logs);
  for (const conversation of sources) {
    const log = await f.get<{ content: string }>(`/api/groups/123456/logs/${encodeURIComponent(`group:${conversation.id}`)}/2026-10-26.jsonl`);
    assert.equal(JSON.parse(log.content).conversation.id, conversation.id);
  }
  const legacy = join(f.cwd, 'messages', 'group', '999999');
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, '2026-10-26.jsonl'), '{"v":2,"legacy":"do not expose"}\n');
  assert.deepEqual((await f.get<Group>('/api/groups/123456')).logs, configured.logs);
});

test('an unassigned journal cannot impersonate a different OpenID from its hashed directory', async t => {
  const f = await fixture(t);
  const directory = join(f.cwd, conversationDirectory({ type: 'private', id: 'Expected_OpenID' }));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, '2026-10-26.jsonl'), logLine(logRecord(1, 'foreign', { conversation: { type: 'private', id: 'Different_OpenID' } })));
  const response = await f.call('/api/groups/123456');
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /OpenID/);
});

test('a retained conversation remains listed when its first message exceeds the log preview limit', async t => {
  const f = await fixture(t);
  const conversation = { type: 'private' as const, id: 'Retained_OpenID' };
  const directory = join(f.cwd, conversationDirectory(conversation));
  await mkdir(directory, { recursive: true });
  const content = logLine(logRecord(1, 'x'.repeat(600_000), { conversation }));
  await writeFile(join(directory, '2026-10-26.jsonl'), content);
  assert.deepEqual((await f.get<Group>('/api/groups/123456')).logs['private:Retained_OpenID'], ['2026-10-26.jsonl']);
  assert.equal((await f.call('/api/groups/123456/logs/private:Retained_OpenID/2026-10-26.jsonl')).status, 413);
  assert.equal(await readFile(join(directory, '2026-10-26.jsonl'), 'utf8'), content);
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
    version: 1, kind: 'terminal-only', token: 'pending-terminal-return', launcherPid: process.pid,
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

test('start and open share one terminal launch', async t => {
  const f = await fixture(t);
  const responses = await Promise.all([
    f.call('/api/groups/123456/start', 'POST', {}),
    f.call('/api/groups/123456/open', 'POST', {}),
  ]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(f.launched.length, 1);
  assert.deepEqual(f.launchOptions, [{ freshSession: false }]);
  assert.equal((await f.call('/api/groups/123456', 'DELETE')).status, 409, 'a pending launch cannot be moved to trash');
});

test('stop retains a live terminal without an owner lock and prevents deletion or replacement', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  try {
    assert.ok(child.pid);
    const lease = await prepareTerminalLaunch(f.cwd);
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
    const lease = await prepareTerminalLaunch(f.cwd);
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
  await initializeGroup(f.root, 'replacement', { name: 'New owner', conversations: [{ type: 'group', id: 'GROUP_OPENID_A' }] });
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


test('credential save is local and returns only safe metadata without changing group configuration', async t => {
  const privateSecret = 'SYNTHETIC_PRIVATE_SECRET';
  let stored: { appId: string; appSecret?: string } | undefined;
  const f = await fixture(t, { models: [] }, {
    saveCredentials: async (_cwd, input) => {
      if (input.appSecret === undefined) input = { ...input, appSecret: stored?.appSecret };
      stored = input;
      return { appId: input.appId, hasSecret: true, available: true, appSecret: privateSecret };
    },
    credentials: async () => ({ appId: stored?.appId ?? '', hasSecret: !!stored, available: !!stored, managed: true, source: '本机' }),
  });
  const original = await readFile(join(f.cwd, 'PIQ.md'), 'utf8');
  const response = await f.call('/api/groups/123456/credentials', 'PUT', { appId: 'synthetic-app', appSecret: privateSecret });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /SYNTHETIC_PRIVATE_SECRET|appSecret/);
  assert.equal(JSON.parse(body).credential.appId, 'synthetic-app');
  assert.equal((await f.call('/api/groups/123456/credentials', 'PUT', { appId: 'synthetic-app' })).status, 200);
  assert.equal(stored?.appSecret, privateSecret);
  assert.equal(await readFile(join(f.cwd, 'PIQ.md'), 'utf8'), original);
  assert.doesNotMatch(JSON.stringify(await f.get<Group>('/api/groups/123456')), /SYNTHETIC_PRIVATE_SECRET|appSecretEnv/);
  assert.equal((await f.call('/api/groups/123456/credentials/configure', 'POST', {})).status, 404);
});

test('credential API enforces local authorization and never echoes storage failures or extra fields', async t => {
  let writes = 0;
  const f = await fixture(t, { models: [] }, { saveCredentials: async () => { writes++; throw new Error('SYNTHETIC_SECRET_IN_FAILURE'); } });
  const denied = await fetch(f.app.url + '/api/groups/123456/credentials', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: 'synthetic-app', appSecret: 'SYNTHETIC_SECRET_IN_FAILURE' }) });
  assert.equal(denied.status, 403); assert.equal(writes, 0);
  assert.equal((await f.call('/api/groups/123456/credentials', 'PUT', { appId: 'synthetic-app', appSecret: 'secret', extra: true })).status, 400);
  assert.equal(writes, 0);
  const response = await f.call('/api/groups/123456/credentials', 'PUT', { appId: 'synthetic-app', appSecret: 'SYNTHETIC_SECRET_IN_FAILURE' });
  assert.equal(response.status, 400); assert.equal(writes, 1);
  assert.doesNotMatch(await response.text(), /SYNTHETIC_SECRET_IN_FAILURE/);
});

test('workbench discovers conversations on demand and releases discovery before opening Pi', async t => {
  const lifecycle: string[] = [];
  const discovery = createWebDiscovery({ discover: async (_cwd, options) => {
    lifecycle.push('discover');
    options?.output?.('QQ 官方机器人已连接，等待会话事件。');
    options?.output?.(JSON.stringify({ conversationKey: 'private:Discovered_User', userId: 'Discovered_User' }));
    await new Promise<void>(resolve => options!.signal!.addEventListener('abort', () => resolve(), { once: true }));
    lifecycle.push('released'); return 0;
  } });
  const f = await fixture(t, { models: [] }, { discovery, openTerminal: async () => { lifecycle.push('open'); return { message: '模拟终端' }; } });
  assert.deepEqual(lifecycle, []);
  assert.equal((await f.call('/api/groups/123456/discovery', 'POST', {})).status, 200);
  assert.equal((await f.call('/api/groups/123456/discovery', 'POST', {})).status, 200);
  const found = await f.get<{ state: string; conversations: GroupConfig['conversations'] }>('/api/groups/123456/discovery');
  assert.equal(found.state, 'connected');
  assert.deepEqual(found.conversations, [{ type: 'private', id: 'Discovered_User' }]);
  const group = await f.get<Group>('/api/groups/123456');
  const selected = await f.call('/api/groups/123456/config', 'PUT', {
    config: { ...group.config, conversations: [...group.config.conversations, ...found.conversations] }, revision: group.configRevision,
  });
  assert.equal(selected.status, 200);
  const stopped = await f.call('/api/groups/123456/discovery', 'DELETE');
  assert.equal(stopped.status, 200, 'the browser stops discovery without a JSON body');
  assert.equal((await stopped.json() as { state: string }).state, 'idle');
  assert.deepEqual(lifecycle, ['discover', 'released']);
  assert.equal((await f.call('/api/groups/123456/discovery', 'POST', {})).status, 200);
  assert.equal((await f.call('/api/groups/123456/open', 'POST', {})).status, 200);
  assert.deepEqual(lifecycle, ['discover', 'released', 'discover', 'released', 'open']);
  assert.equal((await f.call('/api/groups/123456/discovery', 'POST', {})).status, 409, 'a pending Pi launch prevents a competing discovery');
});

test('discovery requires configured credentials and a stopped Pi', async t => {
  let starts = 0;
  const discovery: WebDiscovery = { start: async () => { starts++; return { state: 'connecting', conversations: [] }; },
    snapshot: () => ({ state: 'idle', conversations: [] }), stop: async () => ({ state: 'idle', conversations: [] }), close: async () => {} };
  let available = false;
  const f = await fixture(t, { models: [] }, { discovery, credentials: async () => ({ available, source: '模拟' }) });
  assert.equal((await f.call('/api/groups/123456/discovery', 'POST', {})).status, 400);
  available = true;
  await mkdir(join(f.cwd, '.piq'), { recursive: true });
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: 'test-owner' }));
  assert.equal((await f.call('/api/groups/123456/discovery', 'POST', {})).status, 409);
  assert.equal(starts, 0);
});

test('uncertain discovery cleanup prevents credential changes, terminal launch and recycling', async t => {
  const blocked = { state: 'error' as const, conversations: [], error: '发现连接尚未关闭。' };
  const discovery: WebDiscovery = { start: async () => blocked, snapshot: () => blocked, stop: async () => blocked, close: async () => {} };
  const f = await fixture(t, { models: [] }, { discovery, saveCredentials: async () => { assert.fail('must not change credentials'); } });
  assert.equal((await f.call('/api/groups/123456/open', 'POST', {})).status, 409);
  assert.equal((await f.call('/api/groups/123456/credentials', 'PUT', { appId: 'synthetic', appSecret: 'secret' })).status, 409);
  assert.equal((await f.call('/api/groups/123456', 'DELETE')).status, 409);
  assert.deepEqual(f.launched, []);
  assert.ok(await loadConfig(f.cwd));
});


test('an active Pi permits secret rotation but blocks an application change before storage is touched', async t => {
  let writes = 0;
  const f = await fixture(t, { models: [] }, {
    credentials: async () => ({ appId: 'current-app', available: true, hasSecret: true, managed: true, source: '本机' }),
    saveCredentials: async (_cwd, input) => { writes++; return { appId: input.appId, available: true, hasSecret: true }; },
  });
  await mkdir(join(f.cwd, '.piq'), { recursive: true });
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: 'active-owner' }));
  assert.equal((await f.call('/api/groups/123456/credentials', 'PUT', { appId: 'different-app', appSecret: 'secret' })).status, 409);
  assert.equal(writes, 0);
  const rotated = await f.call('/api/groups/123456/credentials', 'PUT', { appId: 'current-app', appSecret: 'new-secret' });
  assert.equal(rotated.status, 200); assert.equal(writes, 1);
  assert.equal((await rotated.json() as { restartRequired: boolean }).restartRequired, true);
});

test('replacing a bound bot needs confirmation and archives its data before saving new credentials', async t => {
  let account = 'OLD_APP', writes = 0;
  const f = await fixture(t, { models: [] }, {
    credentials: async () => ({ appId: account, available: true, hasSecret: true, managed: true, source: '模拟' }),
    saveCredentials: async (cwd, input) => {
      writes++;
      assert.equal(JSON.parse(await readFile(join(cwd, '.piq/bot-account.json'), 'utf8')).accountId, 'NEW_APP');
      account = input.appId;
      return { appId: account, hasSecret: true, available: true };
    },
  });
  const config = (await loadConfig(f.cwd))!;
  const store = await GroupStore.open(f.cwd, config, 'OLD_APP');
  await store.append({ conversation: config.conversations[0]!, messageId: 'old-message', selfId: 'OLD_APP', userId: 'Synthetic_User',
    sender: 'Synthetic', time: 1700000000, rawText: 'old account body', outgoing: false });
  await store.close();
  await writeFile(join(f.cwd, 'MEMORY.md'), 'KEEP_MEMORY');
  const input = { appId: 'NEW_APP', appSecret: 'NEW_SYNTHETIC_SECRET' };
  assert.equal((await f.call('/api/groups/123456/credentials', 'PUT', input)).status, 409);
  assert.equal(writes, 0);
  const replaced = await f.call('/api/groups/123456/credentials', 'PUT', { ...input, replaceAccount: true });
  assert.equal(replaced.status, 200, await replaced.clone().text());
  const result = await replaced.json() as { replacedAccount: boolean; archivePath: string; credential: { appId: string }; config: GroupConfig };
  assert.equal(result.replacedAccount, true); assert.equal(result.credential.appId, 'NEW_APP');
  assert.deepEqual(result.config.conversations, []); assert.equal(writes, 1);
  assert.doesNotMatch(JSON.stringify(result), /NEW_SYNTHETIC_SECRET/);
  assert.equal(await readFile(join(f.cwd, 'MEMORY.md'), 'utf8'), 'KEEP_MEMORY');
  const archived = join(f.cwd, result.archivePath, conversationDirectory(config.conversations[0]!));
  const logs = await readdir(archived);
  assert.equal(JSON.parse((await readFile(join(archived, logs[0]!), 'utf8')).trim()).selfId, 'OLD_APP');
});

test('failed bot replacement does not leave new binding or cleared conversations behind', async t => {
  const f = await fixture(t, { models: [] }, {
    credentials: async () => ({ appId: 'OLD_APP', available: true, hasSecret: true, source: '模拟' }),
    saveCredentials: async () => { throw new Error('PRIVATE_CREDENTIAL_ERROR'); },
  });
  const original = await readFile(join(f.cwd, 'PIQ.md'), 'utf8');
  const store = await GroupStore.open(f.cwd, (await loadConfig(f.cwd))!, 'OLD_APP'); await store.close();
  const failed = await f.call('/api/groups/123456/credentials', 'PUT', { appId: 'NEW_APP', appSecret: 'NEW_SYNTHETIC_SECRET', replaceAccount: true });
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /PRIVATE_CREDENTIAL_ERROR|NEW_SYNTHETIC_SECRET/);
  assert.equal(await readFile(join(f.cwd, 'PIQ.md'), 'utf8'), original);
  assert.equal(JSON.parse(await readFile(join(f.cwd, '.piq/bot-account.json'), 'utf8')).accountId, 'OLD_APP');
});
