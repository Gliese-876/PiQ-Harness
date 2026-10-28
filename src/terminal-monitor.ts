import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.ts';

interface Lease {
  version: 1;
  kind: 'terminal-only';
  token: string;
  createdAt: number;
  launcherPid: number;
  wrapperPid?: number;
  piPid?: number;
  state: 'starting' | 'watching' | 'disabled';
}

interface Lock { pid: number; token: string }

const LEASE = 'terminal-return.json';
const LOCK = 'terminal-return.lock';
const SAFE_ERROR = '终端启动记录无效，请检查 .piq/terminal-return.json。';
export const TERMINAL_START_TIMEOUT_MS = 30_000;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

function alive(value?: number): boolean {
  if (!value) return false;
  try { process.kill(value, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return true; if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function directoryFor(cwd: string, create = false): Promise<string> {
  const root = await realpath(resolve(cwd));
  const directory = join(root, '.piq');
  if (create) await mkdir(directory, { recursive: true });
  const entry = await lstat(directory);
  const resolved = await realpath(directory);
  const part = relative(root, resolved);
  if (!entry.isDirectory() || entry.isSymbolicLink() || part === '..' || part.startsWith('../') || part.startsWith('..\\') || isAbsolute(part)) {
    throw new Error('终端启动记录必须位于本对话组的普通 .piq 目录。');
  }
  return directory;
}

async function ordinaryFile(path: string): Promise<void> {
  try { const entry = await lstat(path); if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('终端启动记录必须使用普通文件。'); }
  catch (error) { if (!missing(error)) throw error; }
}

async function fileTransition<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await delay(20 * (attempt + 1));
    }
  }
}

async function json(path: string): Promise<unknown | null> {
  return fileTransition(async () => {
    await ordinaryFile(path);
    try { if ((await lstat(path)).size > 16_384) throw new Error('终端启动记录过大。'); return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (missing(error)) return null; throw error; }
  });
}

async function write(path: string, value: unknown): Promise<void> {
  await fileTransition(() => ordinaryFile(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value) + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await ordinaryFile(path); await rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await delay(20 * (attempt + 1));
      }
    }
  } finally { await fileTransition(() => unlink(temporary)).catch(error => { if (!missing(error)) throw error; }); }
}

async function leaseAt(directory: string): Promise<Lease | null> {
  const value = await json(join(directory, LEASE));
  if (value === null) return null;
  if (!object(value) || value.version !== 1 || typeof value.token !== 'string' || !value.token
    || !pid(value.launcherPid) || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
    || value.kind !== 'terminal-only' || value.createdAt < 0
    || Object.keys(value).some(key => !['version', 'kind', 'token', 'createdAt', 'launcherPid', 'wrapperPid', 'piPid', 'state'].includes(key))
    || !['starting', 'watching', 'disabled'].includes(String(value.state))
    || [value.wrapperPid, value.piPid].some(value => value !== undefined && !pid(value))) {
    throw new Error(SAFE_ERROR);
  }
  return value as unknown as Lease;
}

async function lockAt(path: string): Promise<Lock | null> {
  const value = await json(path);
  if (value === null) return null;
  if (!object(value) || !pid(value.pid) || typeof value.token !== 'string' || !value.token) throw new Error('终端启动锁无效。');
  return value as unknown as Lock;
}

async function claim(path: string, owner: Lock): Promise<void> {
  await ordinaryFile(path);
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(owner)); await file.sync(); }
  finally { await file.close(); }
}

async function withLock<T>(filename: string, operation: () => Promise<T>): Promise<T> {
  const owner = { pid: process.pid, token: randomUUID() };
  const deadline = Date.now() + 5_000;
  while (true) {
    try { await claim(filename, owner); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    let existing: Lock | null;
    try { existing = await lockAt(filename); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; existing = null; }
    if (existing && !alive(existing.pid)) {
      const recovery = `${filename}.recover`;
      let recovered = false;
      try { await claim(recovery, owner); recovered = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (recovered) {
        try {
          const current = await lockAt(filename);
          if (current?.token === existing.token && !alive(current.pid)) await fileTransition(() => unlink(filename));
        } finally { if ((await lockAt(recovery))?.token === owner.token) await fileTransition(() => unlink(recovery)); }
        continue;
      }
    }
    if (Date.now() >= deadline) throw new Error('本组正在启动或进行管理操作，请稍后重试。');
    await delay(20);
  }
  try { return await operation(); }
  finally { if ((await lockAt(filename))?.token === owner.token) await fileTransition(() => unlink(filename)); }
}

export async function withTerminalStartupLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  return withLock(join(await directoryFor(cwd, true), 'start.lock'), operation);
}

function status(lease: Lease | null): { running: boolean; starting: boolean; pid: number | null } {
  if (!lease) return { running: false, starting: false, pid: null };
  if (alive(lease.piPid)) return { running: true, starting: false, pid: lease.piPid! };
  if (alive(lease.wrapperPid)) return { running: false, starting: true, pid: lease.wrapperPid! };
  const starting = lease.state === 'starting' && Date.now() - lease.createdAt < TERMINAL_START_TIMEOUT_MS && alive(lease.launcherPid);
  return { running: false, starting, pid: starting ? lease.launcherPid : null };
}

/** Publish one terminal launch lease before opening its window. */
export async function prepareTerminalLaunch(cwd: string): Promise<{ token: string; alreadyRunning?: boolean }> {
  const root = await realpath(resolve(cwd));
  const config = await loadConfig(root);
  if (!config?.conversations.length) throw new Error('请先配置本对话组的对话，再打开终端。');
  const directory = await directoryFor(root, true);
  return withLock(join(directory, LOCK), async () => {
    const existing = await leaseAt(directory);
    const current = status(existing);
    if (existing && (current.running || current.starting)) return { token: existing.token, alreadyRunning: true };
    const lease: Lease = { version: 1, kind: 'terminal-only', token: randomUUID(), createdAt: Date.now(), launcherPid: process.pid, state: 'starting' };
    await write(join(directory, LEASE), lease);
    return { token: lease.token };
  });
}

export async function registerTerminal(cwd: string, token: string, wrapperPid = process.pid, piPid?: number): Promise<void> {
  if (!token || !pid(wrapperPid) || (piPid !== undefined && !pid(piPid))) throw new Error('终端进程登记无效。');
  const directory = await directoryFor(cwd);
  await withLock(join(directory, LOCK), async () => {
    const lease = await leaseAt(directory);
    if (!lease || lease.token !== token || !['starting', 'watching'].includes(lease.state)
      || (lease.state === 'starting' && Date.now() - lease.createdAt >= TERMINAL_START_TIMEOUT_MS)
      || (lease.state === 'watching' && !alive(lease.wrapperPid) && !alive(lease.piPid))) {
      throw new Error('终端启动登记已失效，请从 WebUI 重新打开。');
    }
    if (lease.wrapperPid !== undefined && lease.wrapperPid !== wrapperPid) throw new Error('本次终端已由另一进程接管。');
    if (lease.piPid !== undefined && piPid !== undefined && lease.piPid !== piPid) throw new Error('本次终端的 Pi 进程已登记。');
    await write(join(directory, LEASE), { ...lease, state: 'watching', wrapperPid, ...(piPid === undefined ? {} : { piPid }) });
  });
}

export async function clearTerminalLaunch(cwd: string, expectedToken?: string): Promise<void> {
  let directory: string;
  try { directory = await directoryFor(cwd); } catch (error) { if (missing(error)) return; throw error; }
  await withLock(join(directory, LOCK), async () => {
    const lease = await leaseAt(directory);
    if (lease && (expectedToken === undefined || lease.token === expectedToken)) await fileTransition(() => unlink(join(directory, LEASE)));
  });
}

/** Reject late registration while retaining every running PID until it exits. */
export async function stopTerminalRegistration(cwd: string, expectedToken?: string): Promise<string | undefined> {
  let directory: string;
  try { directory = await directoryFor(cwd); } catch (error) { if (missing(error)) return; throw error; }
  return withLock(join(directory, LOCK), async () => {
    const lease = await leaseAt(directory);
    if (!lease || (expectedToken !== undefined && lease.token !== expectedToken)) return;
    await write(join(directory, LEASE), { ...lease, state: 'disabled' });
    return lease.token;
  });
}

/** A wrapper may exit before a custom launcher child; keep that actual Pi trace alive. */
export async function finishTerminal(cwd: string, expectedToken: string): Promise<void> {
  let directory: string;
  try { directory = await directoryFor(cwd); } catch (error) { if (missing(error)) return; throw error; }
  await withLock(join(directory, LOCK), async () => {
    const lease = await leaseAt(directory);
    if (!lease || lease.token !== expectedToken) return;
    if (alive(lease.piPid)) {
      await write(join(directory, LEASE), { ...lease, state: 'disabled' });
    } else await fileTransition(() => unlink(join(directory, LEASE)));
  });
}

export async function getTerminalLaunchStatus(cwd: string): Promise<{ running: boolean; starting: boolean; pid: number | null }> {
  try { return status(await leaseAt(await directoryFor(cwd))); }
  catch (error) { if (missing(error)) return { running: false, starting: false, pid: null }; throw error; }
}

export async function getTerminalLaunchError(cwd: string): Promise<string | undefined> {
  try { await leaseAt(await directoryFor(cwd)); return undefined; }
  catch (error) { if (missing(error)) return undefined; return SAFE_ERROR; }
}
