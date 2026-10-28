import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { conversationDirectory, conversationKey, parseConversationKey, validateConversation, validateOpenId, type Conversation } from '../src/conversations.ts';
import { assertAssignments, claimConversations, initializeGroup, listGroupConfigs, loadConfig, saveGroupConfig, type GroupConfig } from '../src/config.ts';

const group = (id: string): Conversation => ({ type: 'group', id });
const person = (id: string): Conversation => ({ type: 'private', id });
const revision = (text: string) => createHash('sha256').update(text).digest('hex');

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'conversations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function create(root: string, id: string, conversations: Conversation[]) {
  return initializeGroup(root, id, { name: id, conversations });
}
async function current(cwd: string) {
  const text = await readFile(join(cwd, 'PIQ.md'), 'utf8');
  return { config: (await loadConfig(cwd))!, revision: revision(text), text };
}
async function manuallyWrite(cwd: string, config: GroupConfig) {
  await writeFile(join(cwd, 'PIQ.md'), '# 手动编辑\n\n```json\n' + JSON.stringify(config) + '\n```\n');
}
async function own(cwd: string, token: string = randomUUID()) {
  await mkdir(join(cwd, '.piq'), { recursive: true });
  await writeFile(join(cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token }));
  return token;
}

test('official conversation identities preserve opaque OpenIDs and reject legacy temporary shapes', () => {
  assert.equal(conversationKey(group('A0_group-openid')), 'group:A0_group-openid');
  assert.equal(conversationKey(person('A0_group-openid')), 'private:A0_group-openid');
  assert.deepEqual(parseConversationKey('private:User_OpenID-1'), person('User_OpenID-1'));
  assert.deepEqual(validateConversation({ type: 'group', id: 'GroupOpenID', name: '工作群' }), { type: 'group', id: 'GroupOpenID', name: '工作群' });
  for (const value of ['0', '001', '9007199254740992', 'Ab_C-1', 'A'.repeat(128)]) assert.equal(validateOpenId(value), value);
  for (const value of ['', 'with space', 'a.b', 'a/b', 'a\\b', 'A'.repeat(129), 123, null]) assert.throws(() => validateOpenId(value));
  for (const value of ['GROUP:abc', 'other:abc', 'group:a:b', 'abc', 'private:../1', 'temporary:source:user']) assert.throws(() => parseConversationKey(value));
  for (const value of [
    { type: 'group', groupId: 'abc' }, { type: 'channel', id: 'abc' }, { type: 'private', id: 'abc', unexpected: true },
    { type: 'temporary', id: 'abc', sourceGroupId: 'source' }, { type: 'group', id: 'abc', sourceGroupId: 'source' },
  ]) assert.throws(() => validateConversation(value));
});

test('journal directories use v3 hashes so case-sensitive OpenIDs stay distinct on Windows', () => {
  const hash = createHash('sha256').update('A0_group-openid').digest('hex');
  assert.equal(conversationDirectory(group('A0_group-openid')), 'messages/v3/group/' + hash);
  assert.equal(conversationDirectory(person('A0_group-openid')), 'messages/v3/private/' + hash);
  assert.notEqual(conversationDirectory(group('CaseID')), conversationDirectory(group('caseid')));
  assert.match(conversationDirectory(group('CON')), /^messages\/v3\/group\/[a-f0-9]{64}$/);
  for (const invalid of ['../id', '..\\id', '/id', 'C:\\id', 'id.name', 'id:stream']) {
    assert.throws(() => conversationDirectory(group(invalid)));
    assert.throws(() => conversationDirectory(person(invalid)));
  }
});

test('distinct casing of official OpenIDs remains distinct in the group registry', async t => {
  const root = await fixture(t);
  await create(root, 'alpha', [group('CaseID')]);
  await create(root, 'beta', [group('caseid')]);
  assert.equal((await listGroupConfigs(root)).length, 2);
});

test('one conversation belongs to one group while different conversation kinds may share an OpenID', async t => {
  const root = await fixture(t);
  await create(root, 'alpha', [group('123'), person('456')]);
  await create(root, 'beta', [person('123'), group('456')]);
  await assert.rejects(create(root, 'duplicate', [group('123')]));
  await assert.rejects(create(root, 'duplicate-private', [person('456')]));
  const listed = await listGroupConfigs(root);
  assert.deepEqual(listed.map(item => item.id).sort(), ['alpha', 'beta']);
});

test('concurrent initialization cannot assign the same conversation twice', async t => {
  const root = await fixture(t);
  const results = await Promise.allSettled([create(root, 'alpha', [group('123')]), create(root, 'beta', [group('123')])]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const listed = await listGroupConfigs(root);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0]!.config.conversations, [group('123')]);
});

test('stopped groups can move a conversation after releasing its previous assignment', async t => {
  const root = await fixture(t);
  const alpha = await create(root, 'alpha', [group('123')]);
  const beta = await create(root, 'beta', []);
  let b = await current(beta);
  await assert.rejects(saveGroupConfig(beta, { ...b.config, conversations: [group('123')] }, b.revision));
  const a = await current(alpha);
  await saveGroupConfig(alpha, { ...a.config, conversations: [] }, a.revision);
  b = await current(beta);
  await saveGroupConfig(beta, { ...b.config, conversations: [group('123')] }, b.revision);
  assert.deepEqual((await loadConfig(alpha))!.conversations, []);
  assert.deepEqual((await loadConfig(beta))!.conversations, [group('123')]);
});

test('configuration saves preserve prose and reject stale or competing revisions', async t => {
  const root = await fixture(t); const cwd = await create(root, 'alpha', [group('123')]);
  const initial = await current(cwd);
  await writeFile(join(cwd, 'PIQ.md'), '# 自定义说明\n\n保留前言。\n\n```json\n' + JSON.stringify(initial.config, null, 2) + '\n```\n\n保留结尾。\n');
  const before = await current(cwd);
  const outcomes = await Promise.allSettled([
    saveGroupConfig(cwd, { ...before.config, name: '第一版' }, before.revision),
    saveGroupConfig(cwd, { ...before.config, name: '第二版' }, before.revision),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.status, 409);
  const final = await current(cwd);
  assert.match(final.text, /保留前言/); assert.match(final.text, /保留结尾/);
  await assert.rejects(saveGroupConfig(cwd, { ...final.config, id: 'different' }, final.revision));
});

test('membership edits require the group to stop but ordinary shared settings can be saved', async t => {
  const root = await fixture(t); const cwd = await create(root, 'alpha', [group('123')]);
  await own(cwd);
  const before = await current(cwd);
  await assert.rejects(saveGroupConfig(cwd, { ...before.config, conversations: [] }, before.revision));
  await saveGroupConfig(cwd, { ...before.config, name: '运行中的新名称' }, before.revision);
  assert.equal((await loadConfig(cwd))!.name, '运行中的新名称');
});

test('active ownership prevents a manually edited configuration from freeing a live conversation', async t => {
  const root = await fixture(t);
  const alpha = await create(root, 'alpha', [group('123')]);
  const beta = await create(root, 'beta', []);
  await own(alpha);
  const a = (await current(alpha)).config;
  const releaseA = await claimConversations(alpha, a);
  try {
    await manuallyWrite(alpha, { ...a, conversations: [] });
    const b = await current(beta);
    await assert.rejects(saveGroupConfig(beta, { ...b.config, conversations: [group('123')] }, b.revision));
    await assert.rejects(assertAssignments(beta, { ...b.config, conversations: [group('123')] }));
    await manuallyWrite(beta, { ...b.config, conversations: [group('123')] });
    await own(beta);
    await assert.rejects(claimConversations(beta, (await loadConfig(beta))!));
  } finally { await releaseA(); }
  const releaseB = await claimConversations(beta, (await loadConfig(beta))!);
  await releaseB();
});

test('stale owner tokens do not retain claims and an old release cannot erase a new claim', async t => {
  const root = await fixture(t); const cwd = await create(root, 'alpha', [group('123')]);
  await own(cwd, 'old-owner');
  const config = (await loadConfig(cwd))!;
  const releaseOld = await claimConversations(cwd, config);
  await own(cwd, 'new-owner');
  const releaseNew = await claimConversations(cwd, config);
  await releaseOld();
  const active = JSON.parse(await readFile(join(cwd, '.piq', 'conversations.json'), 'utf8'));
  assert.equal(active.ownerToken, 'new-owner');
  await releaseNew();
  await assert.rejects(readFile(join(cwd, '.piq', 'conversations.json')), { code: 'ENOENT' });
  await own(cwd, 'stale-token');
  const releaseStale = await claimConversations(cwd, config);
  await own(cwd, 'replacement-token');
  await manuallyWrite(cwd, { ...config, conversations: [] });
  await create(root, 'beta', [group('123')]);
  await releaseStale();
});

test('removing an active group configuration cannot release its live conversation assignment', async t => {
  const root = await fixture(t); const cwd = await create(root, 'alpha', [group('123')]);
  await own(cwd);
  const before = await current(cwd);
  const release = await claimConversations(cwd, before.config);
  try {
    await unlink(join(cwd, 'PIQ.md'));
    await assert.rejects(create(root, 'beta', [group('123')]));
  } finally {
    await writeFile(join(cwd, 'PIQ.md'), before.text);
    await release();
  }
});

test('claims require the current process owner and malformed sibling configs stop registry writes', async t => {
  const root = await fixture(t); const cwd = await create(root, 'alpha', [group('123')]);
  await assert.rejects(claimConversations(cwd, (await loadConfig(cwd))!));
  await mkdir(join(cwd, '.piq'), { recursive: true });
  await writeFile(join(cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: 2147483647, token: 'not-this-process' }));
  await assert.rejects(claimConversations(cwd, (await loadConfig(cwd))!));
  await unlink(join(cwd, '.piq', 'owner.lock'));
  await mkdir(join(root, 'broken')); await writeFile(join(root, 'broken', 'PIQ.md'), '# invalid');
  await assert.rejects(create(root, 'beta', [group('456')]));
});

test('registry rejects group-directory symlinks that escape the configured root', async t => {
  const base = await fixture(t); const root = join(base, 'root'); const outside = join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(join(outside, 'PIQ.md'), '# External\n```json\n' + JSON.stringify({ id: 'escape', name: '外部', conversations: [] }) + '\n```\n');
  try { await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('The OS sandbox does not permit symlinks.'); return; } throw error; }
  await assert.rejects(listGroupConfigs(root));
  await assert.rejects(create(root, 'beta', [group('456')]));
});
