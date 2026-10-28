import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { checkAssignments, ConfigError, loadConfig, validateGroupId, withRootLock, type GroupConfig } from './config.ts';

export interface DeletedGroup {
  token: string;
  id: string;
  name: string;
  deletedAt: number;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const codeIs = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const validPid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const samePath = (left: string, right: string) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (codeIs(error, 'ESRCH')) return false; if (codeIs(error, 'EPERM')) return true; throw error; }
}

async function ordinary(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !samePath(path, await realpath(path))
    || (directory ? !info.isDirectory() : !info.isFile())) {
    throw new ConfigError(400, '对话组和回收站必须使用普通目录或文件，不能通过符号链接或目录联接访问。');
  }
}

async function json(path: string): Promise<Record<string, unknown> | null> {
  try {
    await ordinary(path, false);
    if ((await lstat(path)).size > 16_384) throw new Error();
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!object(value)) throw new Error();
    return value;
  } catch (error) {
    if (missing(error)) return null;
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(409, `运行记录无效，请检查 .piq/${basename(path)}；原文件已保留。`);
  }
}

interface Lock { pid: number; token: string }

async function lockAt(path: string): Promise<Lock | null> {
  const value = await json(path);
  if (!value) return null;
  if (!validPid(value.pid) || typeof value.token !== 'string' || !value.token
    || (basename(path) === 'owner.lock' && value.version !== 1)) {
    throw new ConfigError(409, `运行锁无效，请检查 .piq/${basename(path)}；原文件已保留。`);
  }
  return { pid: value.pid, token: value.token };
}

async function claim(path: string, token: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let claimed = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, token }) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
    // Terminal registration reads occupied locks immediately. Publish a complete
    // immutable file so those readers never observe a partly written record.
    await link(temporary, path);
    claimed = true;
  } finally {
    try { await unlink(temporary); }
    catch (error) {
      if (!missing(error)) {
        if (claimed) await unlink(path);
        throw error;
      }
    }
  }
}

/** Use the same recovery lease as each runtime writer before replacing a dead owner. */
async function acquire(path: string, token: string, recoveryHeld = false): Promise<void> {
  try { await claim(path, token); return; }
  catch (error) { if (!codeIs(error, 'EEXIST')) throw error; }
  const previous = await lockAt(path);
  if (!previous || alive(previous.pid)) throw new ConfigError(409, '对话组正在运行或启动，请先停止后重试。');
  const recovery = basename(path) === 'owner.lock' ? join(dirname(path), 'recovery.lock') : `${path}.recover`;
  if (!recoveryHeld) {
    try { await claim(recovery, token); }
    catch (error) {
      if (codeIs(error, 'EEXIST')) throw new ConfigError(409, `运行锁正在恢复，请检查 .piq/${basename(recovery)} 后重试。`);
      throw error;
    }
  }
  try {
    const latest = await lockAt(path);
    if (!latest || latest.pid !== previous.pid || latest.token !== previous.token || alive(latest.pid)) {
      throw new ConfigError(409, '对话组运行状态已变化，请稍后重试。');
    }
    await unlink(path);
    await claim(path, token);
  } finally { if (!recoveryHeld && (await lockAt(recovery))?.token === token) await unlink(recovery); }
}

async function stoppedRuntime(directory: string): Promise<void> {
  const terminal = await json(join(directory, 'terminal-return.json'));
  if (terminal) {
    if (terminal.version !== 1 || typeof terminal.token !== 'string' || !terminal.token || !validPid(terminal.launcherPid)
      || typeof terminal.createdAt !== 'number' || !Number.isFinite(terminal.createdAt)
      || terminal.kind !== 'terminal-only'
      || !['starting', 'watching', 'disabled'].includes(String(terminal.state))
      || [terminal.wrapperPid, terminal.piPid].some(value => value !== undefined && !validPid(value))) {
      throw new ConfigError(409, '终端运行记录无效，请检查 .piq/terminal-return.json。');
    }
    const liveTerminal = [terminal.wrapperPid, terminal.piPid].some(value => validPid(value) && alive(value));
    const pendingLaunch = terminal.state === 'starting' && Date.now() - terminal.createdAt < 30_000 && alive(terminal.launcherPid);
    if (liveTerminal || pendingLaunch) throw new ConfigError(409, '终端 Pi 正在运行或启动，请先停止后重试。');
  }
}

/** The root registry lock must be held by the caller throughout this operation. */
async function withStoppedDirectory<T>(cwd: string, operation: (relocated: (path: string) => void) => Promise<T>): Promise<T> {
  const directory = join(cwd, '.piq');
  try { await ordinary(directory, true); }
  catch (error) { if (!missing(error)) throw error; await mkdir(directory); }
  for (const file of ['start.lock.recover', 'recovery.lock', 'terminal-return.lock.recover']) {
    try { await ordinary(join(directory, file), false); }
    catch (error) { if (missing(error)) continue; throw error; }
    throw new ConfigError(409, `存在未完成的运行锁恢复，请检查 .piq/${file} 后重试。`);
  }
  const token = randomUUID();
  const acquired: string[] = [];
  let location = cwd;
  try {
    for (const file of ['start.lock', 'terminal-return.lock', 'recovery.lock', 'owner.lock']) {
      if (file === 'recovery.lock') {
        // GroupStore takes this before inspecting any occupied owner.lock. Keep
        // it across the move so a competing opener cannot strand a recovery
        // marker in the recycled directory after its pathname changes.
        try { await claim(join(directory, file), token); }
        catch (error) {
          if (codeIs(error, 'EEXIST')) throw new ConfigError(409, '对话组运行锁正在恢复，请稍后重试。');
          throw error;
        }
      } else await acquire(join(directory, file), token, file === 'owner.lock');
      acquired.push(file);
    }
    await stoppedRuntime(directory);
    return await operation(path => { location = path; });
  } finally {
    for (const file of acquired.reverse()) {
      const path = join(location, '.piq', file);
      if ((await lockAt(path))?.token === token) await unlink(path);
    }
  }
}

function parseToken(value: unknown): { token: string; id: string; deletedAt: number } {
  if (typeof value !== 'string') throw new ConfigError(400, '回收站标识无效。');
  const match = /^([a-z0-9][a-z0-9_-]{0,63})-([1-9][0-9]{0,15})-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new ConfigError(400, '回收站标识无效。');
  try { validateGroupId(match[1]); } catch { throw new ConfigError(400, '回收站标识无效。'); }
  return { token: value, id: match[1]!, deletedAt: Number(match[2]) };
}

async function groupConfig(path: string, id: string): Promise<GroupConfig> {
  await ordinary(path, true);
  await ordinary(join(path, 'PIQ.md'), false);
  const config = await loadConfig(path);
  if (!config || config.id !== id) throw new ConfigError(400, '目录与 PIQ.md 的对话组标识不一致。');
  return config;
}

/** Move the complete stopped group into the recycle bin; no contents are discarded. */
export async function deleteGroup(cwd: string): Promise<DeletedGroup & { deleted: true; recoveryPath: string }> {
  const requested = resolve(cwd);
  const id = validateGroupId(basename(requested));
  await ordinary(dirname(requested), true);
  return withRootLock(dirname(requested), async root => {
    const config = await groupConfig(requested, id);
    return withStoppedDirectory(requested, async relocated => {
      const trash = join(root, '.trash');
      await mkdir(trash, { recursive: true });
      await ordinary(trash, true);
      const deletedAt = Date.now();
      const token = `${id}-${deletedAt}-${randomUUID()}`;
      const recoveryPath = join(trash, token);
      await ordinary(requested, true);
      await rename(requested, recoveryPath);
      relocated(recoveryPath);
      return { deleted: true, token, id, name: config.name, deletedAt, recoveryPath };
    });
  });
}

/** Entries use opaque, validated directory tokens; no path supplied by the browser is opened. */
export async function listDeletedGroups(rootInput: string): Promise<DeletedGroup[]> {
  await ordinary(resolve(rootInput), true);
  return withRootLock(rootInput, async root => {
    const trash = join(root, '.trash');
    try { await ordinary(trash, true); }
    catch (error) { if (missing(error)) return []; throw error; }
    const groups: DeletedGroup[] = [];
    for (const entry of await readdir(trash, { withFileTypes: true })) {
      let metadata: ReturnType<typeof parseToken>;
      try { metadata = parseToken(entry.name); } catch { continue; }
      const config = await groupConfig(join(trash, metadata.token), metadata.id);
      groups.push({ ...metadata, name: config.name });
    }
    return groups.sort((a, b) => b.deletedAt - a.deletedAt || a.token.localeCompare(b.token));
  });
}

/** Restore the original id only when its directory and conversation assignments remain free. */
export async function restoreGroup(rootInput: string, tokenInput: string): Promise<{ restored: true; id: string; name: string; path: string }> {
  const metadata = parseToken(tokenInput);
  await ordinary(resolve(rootInput), true);
  return withRootLock(rootInput, async root => {
    const trash = join(root, '.trash');
    await ordinary(trash, true);
    const source = join(trash, metadata.token);
    const config = await groupConfig(source, metadata.id);
    const path = join(root, config.id);
    try { await lstat(path); throw new ConfigError(409, '同标识的对话组或目录已经存在，请先处理后再恢复。'); }
    catch (error) { if (!missing(error)) throw error; }
    await checkAssignments(root, config);
    return withStoppedDirectory(source, async relocated => {
      await ordinary(source, true);
      await rename(source, path);
      relocated(path);
      return { restored: true, id: config.id, name: config.name, path };
    });
  });
}
