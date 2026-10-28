import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, initializeGroup, loadConfig, validateConfig, validateGroupId } from '../src/config.ts';
import { defaultMessagesRoot, parseArgs, resolvePiCommand } from '../src/cli.ts';

const members = [{ type: 'group' as const, id: 'Group_OpenID-A' }, { type: 'private' as const, id: 'User_OpenID-B' }];
const options = { name: '测试对话组', conversations: members };
const minimal = { id: 'friends', ...options };

async function temporary(fn: (root: string) => Promise<void>): Promise<void> {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'config-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('conversation-group configuration applies defaults and stays local to its directory', async () => temporary(async root => {
  const cwd = join(root, 'friends'); await mkdir(cwd);
  assert.equal(await loadConfig(cwd), null);
  await writeFile(join(cwd, 'PIQ.md'), '# 连接\n\n```json\n' + JSON.stringify(minimal) + '\n```\n');
  assert.deepEqual(await loadConfig(cwd), { ...DEFAULTS, ...minimal });
  assert.equal((await loadConfig(cwd))!.appIdEnv, 'QQBOT_APP_ID');
  assert.equal((await loadConfig(cwd))!.appSecretEnv, 'QQBOT_APP_SECRET');
  assert.equal((await loadConfig(cwd))!.groupMemberEvents, false);
  const child = join(cwd, 'child'); await mkdir(child);
  assert.equal(await loadConfig(child), null);
}));

test('new configuration rejects old single-group schemas and unsafe identifiers', async () => temporary(async root => {
  for (const id of ['../friends', 'UPPER', '-friends', 'has space', 'has.dot', 'con', 'nul', 'aux', 'prn', 'com1', 'lpt9', 'x'.repeat(65)]) assert.throws(() => validateGroupId(id));
  for (const id of ['friends', 'friends-1', 'family_2', '1234567890']) assert.equal(validateGroupId(id), id);
  assert.throws(() => validateGroupId(123456));
  assert.throws(() => validateConfig({ groupId: '123456' }));
  assert.throws(() => validateConfig({ ...minimal, groupId: '123456' }));
  for (const input of [{ id: 'friends', conversations: [] }, { id: 'friends', name: '朋友' }, { ...minimal, name: '' }, { ...minimal, name: 'x'.repeat(81) }, { ...minimal, conversations: [members[0], members[0]] }]) assert.throws(() => validateConfig(input));
  assert.deepEqual(validateConfig({ id: 'empty', name: '待配置', conversations: [] }).conversations, []);
  for (const legacy of [{ wsUrl: 'ws://localhost:3001' }, { accessTokenEnv: 'OLD_TOKEN' }, { accessToken: 'secret' },
    { conversations: [{ type: 'temporary', id: 'user', sourceGroupId: 'group' }] }]) assert.throws(() => validateConfig({ ...minimal, ...legacy }));
  for (const changed of [{ quietMs: 10_001 }, { maxWaitMs: 0 }, { quietMs: -1 }, { minIntervalMs: NaN },
    { appIdEnv: 'BAD NAME' }, { appSecretEnv: '1BAD' }, { appId: 'actual-id' }, { appSecret: 'actual-secret' },
    { groupMemberEvents: 'true' }, { groupMemberEvents: 1 }]) {
    assert.throws(() => validateConfig({ ...minimal, ...changed }));
  }
  assert.equal(validateConfig({ ...minimal, appIdEnv: 'FRIENDS_APP_ID', appSecretEnv: 'FRIENDS_APP_SECRET' }).appSecretEnv, 'FRIENDS_APP_SECRET');
  assert.equal(validateConfig({ ...minimal, groupMemberEvents: true }).groupMemberEvents, true);
  const cwd = join(root, 'friends'); await mkdir(cwd);
  await writeFile(join(cwd, 'PIQ.md'), '```json\n' + JSON.stringify(minimal) + '\n```\n```json\n{}\n```\n');
  await assert.rejects(loadConfig(cwd), /只包含一个/);
}));

test('initialization preserves documents, configuration and existing Pi resources', async () => temporary(async root => {
  const cwd = join(root, 'friends'); await mkdir(join(cwd, '.pi'), { recursive: true });
  await writeFile(join(cwd, '.pi', 'settings.json'), JSON.stringify({ model: 'kept', packages: ['other-package'] }));
  const packageRoot = resolve('.');
  assert.equal(await initializeGroup(root, 'friends', { ...options, extensionPath: packageRoot }), cwd);
  await writeFile(join(cwd, 'PERSONA.md'), '# 我的共享人设\n'); await writeFile(join(cwd, 'AGENTS.md'), '对话组自己的约定\n');
  const before = await readFile(join(cwd, 'PIQ.md'), 'utf8');
  await initializeGroup(root, 'friends', { ...options, extensionPath: packageRoot, appIdEnv: 'OTHER_APP_ID' });
  assert.equal(await readFile(join(cwd, 'PERSONA.md'), 'utf8'), '# 我的共享人设\n');
  assert.equal(await readFile(join(cwd, 'AGENTS.md'), 'utf8'), '对话组自己的约定\n');
  assert.equal(await readFile(join(cwd, 'PIQ.md'), 'utf8'), before);
  assert.deepEqual(JSON.parse(await readFile(join(cwd, '.pi', 'settings.json'), 'utf8')), { model: 'kept', packages: ['other-package', packageRoot] });
  assert.deepEqual(JSON.parse(await readFile(join(cwd, '.pi', 'settings.json.before-piq'), 'utf8')), { model: 'kept', packages: ['other-package'] });
  await initializeGroup(root, 'other', { name: '另一个对话组', conversations: [], extensionPath: packageRoot });
  assert.equal((await loadConfig(join(root, 'other')))?.id, 'other');
  await writeFile(join(cwd, 'PIQ.md'), '```json\n' + JSON.stringify({ ...minimal, id: 'wrong' }) + '\n```\n');
  await assert.rejects(initializeGroup(root, 'friends', options));
}));

test('malformed existing Pi settings fail before templates are created', async () => temporary(async root => {
  const cwd = join(root, 'friends'); await mkdir(join(cwd, '.pi'), { recursive: true });
  await writeFile(join(cwd, '.pi', 'settings.json'), 'broken');
  await assert.rejects(initializeGroup(root, 'friends', options), /settings.json/);
  await assert.rejects(readFile(join(cwd, 'AGENTS.md')), { code: 'ENOENT' });
}));

test('an existing filtered package declaration is preserved byte-for-byte', async () => temporary(async root => {
  const cwd = join(root, 'friends'); await mkdir(join(cwd, '.pi'), { recursive: true });
  const packageRoot = resolve('.');
  const settings = `{"packages":[{"source":${JSON.stringify(packageRoot)},"skills":[]}],"quietStartup":true}\n`;
  await writeFile(join(cwd, '.pi', 'settings.json'), settings);
  await initializeGroup(root, 'friends', { ...options, extensionPath: packageRoot });
  assert.equal(await readFile(join(cwd, '.pi', 'settings.json'), 'utf8'), settings);
}));

test('CLI requires named conversation groups and accepts explicit conversation keys', () => {
  const cliMembers = [{ type: 'group', id: 'opaque-group_123456' }, { type: 'private', id: 'opaque-user_234567' }];
  const parsed = parseArgs(['init', 'friends', '--name', '朋友们', '--conversation', 'group:opaque-group_123456', '--conversation', 'private:opaque-user_234567', '--root', 'C:/A Folder',
    '--app-id-env', 'FRIENDS_APP_ID', '--app-secret-env', 'FRIENDS_APP_SECRET']);
  assert.equal(parsed.action, 'init'); assert.equal(parsed.id, 'friends'); assert.equal(parsed.name, '朋友们');
  assert.deepEqual(parsed.conversations, cliMembers); assert.equal(parsed.root, 'C:/A Folder');
  assert.equal(parsed.appIdEnv, 'FRIENDS_APP_ID'); assert.equal(parsed.appSecretEnv, 'FRIENDS_APP_SECRET');
  assert.throws(() => parseArgs(['init', 'visitors', '--name', '临时会话', '--conversation', 'temporary:123456:234567']));
  assert.throws(() => parseArgs(['init', 'visitors', '--name', '临时会话', '--conversation', 'temporary:234567']));
  const opened = parseArgs(['open', 'friends', '--root', 'C:/A Folder', '--', '--model', 'some/model', 'literal $() `text`']);
  assert.equal(opened.id, 'friends'); assert.deepEqual(opened.piArgs, ['--model', 'some/model', 'literal $() `text`']);
  assert.equal(parseArgs(['open', 'friends', '--new-session']).freshSession, true);
  assert.deepEqual(parseArgs(['discover', 'friends', '--root', 'C:/A Folder']), {
    action: 'discover', id: 'friends', root: 'C:/A Folder', piArgs: [],
  });
  assert.throws(() => parseArgs(['discover', 'friends', '--', '--model', 'some/model']));
  assert.throws(() => parseArgs(['discover', 'friends', '--new-session']));
  assert.throws(() => parseArgs(['path', 'friends', '--new-session']));
  assert.throws(() => parseArgs(['init', 'friends']));
  assert.throws(() => parseArgs(['init', 'friends', '--name', '朋友', '--root']));
  assert.throws(() => parseArgs(['init', 'friends', '--name', '朋友', '--app-id-env']));
  assert.throws(() => parseArgs(['init', 'friends', '--name', '朋友', '--app-secret-env']));
  assert.throws(() => parseArgs(['init', 'friends', '--name', '朋友', '--url', 'ws://localhost:3001']));
  assert.throws(() => parseArgs(['init', 'friends', '--name', '朋友', '--token-env', 'OLD_TOKEN']));
  assert.throws(() => parseArgs(['open', 'friends', '--url', 'ws://localhost:3001']));
  assert.throws(() => parseArgs(['open', 'friends', '--app-id-env', 'FRIENDS_APP_ID']));
  assert.throws(() => parseArgs(['path', 'friends', '--app-secret-env', 'FRIENDS_APP_SECRET']));
  assert.throws(() => parseArgs(['open', '../other']));
  assert.match(defaultMessagesRoot(), /PiQ-Messages$/);
});

test('CLI initialization persists configured QQBot variable names without credentials', async () => temporary(async root => {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'init', 'friends', '--root', root, '--name', 'Friends',
    '--conversation', 'group:opaque-group_123456', '--app-id-env', 'PIQ_TEST_APP_ID', '--app-secret-env', 'PIQ_TEST_APP_SECRET'], {
    env: { ...process.env, PIQ_TEST_APP_ID: 'synthetic-id-value', PIQ_TEST_APP_SECRET: 'synthetic-secret-value' },
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const cwd = join(root, 'friends');
  const config = (await loadConfig(cwd))!;
  assert.equal(config.appIdEnv, 'PIQ_TEST_APP_ID'); assert.equal(config.appSecretEnv, 'PIQ_TEST_APP_SECRET');
  assert.deepEqual(config.conversations, [{ type: 'group', id: 'opaque-group_123456' }]);
  assert.doesNotMatch(await readFile(join(cwd, 'PIQ.md'), 'utf8'), /synthetic-id-value|synthetic-secret-value|wsUrl|accessTokenEnv/);
}));

test('CLI starts the shared session through Node with literal arguments', async () => temporary(async root => {
  const cwd = await initializeGroup(root, 'friends', options);
  const output = join(root, 'launch-output.json'); const entry = join(root, 'fake pi.cjs');
  await writeFile(entry, 'require("node:fs").writeFileSync(process.env.PIQ_TEST_OUTPUT, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));');
  assert.deepEqual(await resolvePiCommand({ PIQ_PI_ENTRY: entry }), { command: process.execPath, args: [entry] });
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const literal = 'literal $(not executed) `text` "quotes"';
  const result = spawnSync(process.execPath, [cli, 'open', 'friends', '--root', root, '--', '--model', 'test/model', literal], {
    env: { ...process.env, PIQ_PI_ENTRY: entry, PIQ_TEST_OUTPUT: output, QQBOT_APP_ID: 'synthetic-app-id', QQBOT_APP_SECRET: 'synthetic-test-secret' },
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { cwd, args: ['--continue', '--session-dir', join(cwd, '.pi', 'sessions'), '--model', 'test/model', literal] });
}));
