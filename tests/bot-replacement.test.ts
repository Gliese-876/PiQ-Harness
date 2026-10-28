import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { test, type TestContext } from 'node:test';
import { initializeGroup, loadConfig } from '../src/config.ts';
import { GroupStore } from '../src/store.ts';
import { conversationDirectory } from '../src/conversations.ts';
import { managedCredentialNames, readManagedCredentials, saveManagedCredentials, type ManagedCredentialStorage } from '../src/bot-credentials.ts';
import { replaceBotAccount } from '../src/bot-replacement.ts';

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'bot-replacement-'));
  const links: string[] = [];
  t.after(async () => {
    for (const link of links) await (process.platform === 'win32' ? rmdir(link) : unlink(link));
    const canonical = await realpath(root), part = relative(await realpath(parent), canonical);
    assert.ok(part && part !== '..' && !part.startsWith('..\\') && !part.startsWith('../') && !isAbsolute(part));
    await rm(canonical, { recursive: true, force: true });
  });
  const conversation = { type: 'group' as const, id: 'Old_Group_OpenID' };
  const cwd = await initializeGroup(root, 'dragon', { name: '龙娘 $& 对话组', conversations: [conversation] });
  const config = (await loadConfig(cwd))!;
  const store = await GroupStore.open(cwd, config, 'OLD_APP');
  await store.append({ conversation, selfId: 'OLD_APP', userId: 'Synthetic_User', messageId: 'old-message', rawText: 'Old body',
    sender: 'Synthetic', outgoing: false, time: 1700000000, raw: { content: 'Old body' } });
  await store.acknowledge(1); await store.close();
  await writeFile(join(cwd, '.pi/sessions/old-session.jsonl'), 'SYNTHETIC_OLD_SESSION\n');
  await writeFile(join(cwd, 'PERSONA.md'), 'PERSONA_CONTENT');
  await writeFile(join(cwd, 'MEMORY.md'), 'MEMORY_CONTENT');
  await writeFile(join(cwd, 'assets/asset.bin'), 'ASSET_CONTENT');
  const configText = await readFile(join(cwd, 'PIQ.md'), 'utf8');
  const names = await managedCredentialNames(cwd);
  const values: Record<string, string | undefined> = { [names.appIdEnv]: 'OLD_APP', [names.appSecretEnv]: 'old-synthetic-secret' };
  const storage: ManagedCredentialStorage = { read: async keys => Object.fromEntries(keys.map(key => [key, values[key]])),
    write: async next => { Object.assign(values, next); } };
  const options = { platform: 'win32' as const, storage };
  const input = { appId: 'NEW_APP', appSecret: 'new-synthetic-secret' };
  const save = () => saveManagedCredentials(cwd, input, options);
  return { root, cwd, config, conversation, configText, names, values, storage, options, input, save, links };
}

test('explicit bot replacement archives old account data and keeps persona, memory, assets and settings', async t => {
  const f = await fixture(t);
  const settings = await readFile(join(f.cwd, '.pi/settings.json'), 'utf8');
  const result = await replaceBotAccount(f.cwd, f.input, 'OLD_APP', f.save);
  assert.equal(result.credential.appId, 'NEW_APP');
  assert.deepEqual(result.config.conversations, []);
  assert.equal((await loadConfig(f.cwd))!.name, '龙娘 $& 对话组');
  assert.equal((await readManagedCredentials(f.cwd, f.options)).appSecret, 'new-synthetic-secret');
  assert.equal(JSON.parse(await readFile(join(f.cwd, '.piq/bot-account.json'), 'utf8')).accountId, 'NEW_APP');
  const archive = join(f.cwd, result.archivePath);
  assert.equal(await readFile(join(archive, 'PIQ.md'), 'utf8'), f.configText);
  assert.equal(await readFile(join(archive, '.pi/sessions/old-session.jsonl'), 'utf8'), 'SYNTHETIC_OLD_SESSION\n');
  const oldLogs = await readdir(join(archive, conversationDirectory(f.conversation)));
  assert.equal(JSON.parse((await readFile(join(archive, conversationDirectory(f.conversation), oldLogs[0]!), 'utf8')).trim()).selfId, 'OLD_APP');
  assert.deepEqual(await readdir(join(f.cwd, '.pi/sessions')), []);
  for (const [file, content] of [['PERSONA.md', 'PERSONA_CONTENT'], ['MEMORY.md', 'MEMORY_CONTENT'], ['assets/asset.bin', 'ASSET_CONTENT']]) {
    assert.equal(await readFile(join(f.cwd, file!), 'utf8'), content);
  }
  assert.equal(await readFile(join(f.cwd, '.pi/settings.json'), 'utf8'), settings);
  assert.doesNotMatch(await readFile(join(archive, 'manifest.json'), 'utf8'), /synthetic-secret/);
  const next = await GroupStore.open(f.cwd, result.config, 'NEW_APP');
  assert.equal(next.pending(), null); await next.close();
});

test('failed credential persistence restores the old binding, conversations, journals and session', async t => {
  const f = await fixture(t), originalWrite = f.storage.write;
  let failOnce = true;
  f.storage.write = async values => { await originalWrite(values); if (failOnce) { failOnce = false; throw new Error('PRIVATE-WRITE-ERROR'); } };
  await assert.rejects(replaceBotAccount(f.cwd, f.input, 'OLD_APP', f.save), error => {
    assert.doesNotMatch(String(error), /PRIVATE-WRITE-ERROR|synthetic-secret/); return true;
  });
  assert.equal(await readFile(join(f.cwd, 'PIQ.md'), 'utf8'), f.configText);
  assert.equal(JSON.parse(await readFile(join(f.cwd, '.piq/bot-account.json'), 'utf8')).accountId, 'OLD_APP');
  assert.equal((await readManagedCredentials(f.cwd, f.options)).appId, 'OLD_APP');
  assert.equal((await readManagedCredentials(f.cwd, f.options)).appSecret, 'old-synthetic-secret');
  assert.equal(await readFile(join(f.cwd, '.pi/sessions/old-session.jsonl'), 'utf8'), 'SYNTHETIC_OLD_SESSION\n');
  const old = await GroupStore.open(f.cwd, f.config, 'OLD_APP'); await old.close();
});

test('replacement refuses live groups and missing new secrets without touching stored data', async t => {
  const f = await fixture(t);
  await assert.rejects(replaceBotAccount(f.cwd, { appId: 'NEW_APP' }, 'OLD_APP', f.save), /同时填写/);
  const running = await GroupStore.open(f.cwd, f.config, 'OLD_APP');
  try { await assert.rejects(replaceBotAccount(f.cwd, f.input, 'OLD_APP', f.save), /运行|启动/); }
  finally { await running.close(); }
  assert.equal(await readFile(join(f.cwd, 'PIQ.md'), 'utf8'), f.configText);
  assert.equal(f.values[f.names.appIdEnv], 'OLD_APP');
});

test('an archive junction cannot move account data outside the group', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside'); await mkdir(outside);
  const link = join(f.cwd, 'archives');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); f.links.push(link);
  await assert.rejects(replaceBotAccount(f.cwd, f.input, 'OLD_APP', f.save));
  assert.deepEqual(await readdir(outside), []);
  assert.equal(f.values[f.names.appIdEnv], 'OLD_APP');
  assert.equal(await readFile(join(f.cwd, 'PIQ.md'), 'utf8'), f.configText);
});
