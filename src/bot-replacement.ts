import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadConfig, withRootLock, type GroupConfig } from './config.ts';
import { withStoppedGroupDirectory } from './group-management.ts';
import { ManagedCredentialError, readBoundBotAccount, validateManagedCredentialInput, type ManagedCredentialMetadata } from './bot-credentials.ts';

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const equalPath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const revision = (text: string) => createHash('sha256').update(text).digest('hex');

/** An explicit account change archives account-scoped data; persona and assets stay in place. */
export async function replaceBotAccount(
  cwd: string,
  input: { appId: string; appSecret?: string },
  previousAccountId: string,
  saveCredentials: () => Promise<ManagedCredentialMetadata>,
): Promise<{ credential: ManagedCredentialMetadata; archivePath: string; config: GroupConfig; revision: string }> {
  const validated = validateManagedCredentialInput(input);
  if (!validated.appSecret) throw new ManagedCredentialError('更换机器人时请同时填写新的 AppID 和 AppSecret。');
  if (validated.appId === previousAccountId) throw new ManagedCredentialError('当前 AppID 未改变，无需更换机器人。');
  const root = await realpath(resolve(cwd));
  return withRootLock(dirname(root), async () => withStoppedGroupDirectory(root, async () => {
    async function localDirectory(part: string, create = false): Promise<string> {
      let current = root;
      for (const segment of part.split(/[\\/]/).filter(segment => segment && segment !== '.')) {
        if (segment === '..') throw new Error('Invalid account archive path.');
        current = join(current, segment);
        if (create) await mkdir(current).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !equalPath(current, await realpath(current))) throw new Error('Account data must use ordinary directories.');
      }
      const within = relative(root, current);
      if (within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) throw new Error('Account archive escaped its group.');
      return current;
    }
    async function ordinaryFile(part: string): Promise<string> {
      const parent = await localDirectory(dirname(part));
      const file = join(parent, basename(part)), stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || !equalPath(file, await realpath(file))) throw new Error('Account data must use ordinary files.');
      return file;
    }
    async function atomicFile(part: string, text: string): Promise<void> {
      await localDirectory(dirname(part), true);
      const file = join(root, part), temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, file);
      } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
    }
    const config = await loadConfig(root);
    if (!config || config.id !== basename(root)) throw new ManagedCredentialError('对话组配置无效，未更换机器人。', 409);
    const bound = await readBoundBotAccount(root);
    if (bound !== undefined && bound !== previousAccountId) throw new ManagedCredentialError('机器人配置已变更，请刷新后重试。', 409);
    const configPath = await ordinaryFile('PIQ.md'), originalConfig = await readFile(configPath, 'utf8');
    const nextConfig: GroupConfig = { ...config, conversations: [] };
    const nextText = originalConfig.replace(/^```json[^\S\r\n]*\r?\n[\s\S]*?^```[^\S\r\n]*\r?$/m,
      () => '```json\n' + JSON.stringify(nextConfig, null, 2) + '\n```');
    const archivePath = `archives/bot-accounts/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const archive = await localDirectory(archivePath, true);
    const moved: Array<{ part: string; directory: boolean }> = [];
    let wroteConfig = false, wroteBinding = false;
    try {
      await writeFile(join(archive, 'PIQ.md'), originalConfig, { flag: 'wx', mode: 0o600 });
      async function take(part: string, directory = false): Promise<void> {
        let from: string;
        try { from = directory ? await localDirectory(part) : await ordinaryFile(part); }
        catch (error) { if (missing(error)) return; throw error; }
        const parent = await localDirectory(`${archivePath}/${dirname(part)}`, true);
        await rename(from, join(parent, basename(part)));
        moved.push({ part, directory });
        if (directory) await localDirectory(part, true);
      }
      await take('messages/v3', true);
      await take('.pi/sessions', true);
      for (const file of ['bot-account.json', 'state-v3.json', 'sent-receipts-v3.json', 'conversations.json', 'run-preferences.json',
        'runtime.json', 'run-request.json', 'model-status.json', 'model-request.json', 'terminal-return.json']) await take(`.piq/${file}`);
      await atomicFile('PIQ.md', nextText); wroteConfig = true;
      await writeFile(join(root, '.piq/bot-account.json'), JSON.stringify({ version: 1, accountId: validated.appId }) + '\n', { flag: 'wx', mode: 0o600 }); wroteBinding = true;
      await writeFile(join(archive, 'manifest.json'), JSON.stringify({ version: 1, kind: 'bot-account-replacement', previousAccountId,
        accountId: validated.appId, createdAt: new Date().toISOString(), archivedPaths: moved.map(item => item.part),
        previousConversations: config.conversations }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      const credential = await saveCredentials();
      return { credential, archivePath, config: nextConfig, revision: revision(nextText) };
    } catch (error) {
      try {
        if (wroteBinding) await unlink(join(root, '.piq/bot-account.json'));
        if (wroteConfig) await atomicFile('PIQ.md', originalConfig);
        for (const item of moved.reverse()) {
          const target = join(root, item.part);
          if (item.directory) await rmdir(target).catch(failure => { if (!missing(failure)) throw failure; });
          await rename(join(archive, item.part), target);
        }
      } catch {
        throw new ManagedCredentialError(`更换机器人未完成，数据保留在 ${archivePath}，请检查归档后重试。`, 500);
      }
      if (error instanceof ManagedCredentialError) throw error;
      throw new ManagedCredentialError('更换机器人失败，原配置和数据已恢复，请重试。', 500);
    }
  }));
}
