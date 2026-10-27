import { mkdir, readFile, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getRunningOwner, openGroupTerminal, type TerminalOptions } from './web-terminal.ts';
import { getTerminalLaunchStatus, getTerminalReturnError } from './terminal-monitor.ts';

interface Worker {
  version: 1;
  mode: 'background';
  pid: number;
  launchId: string;
  startedAt: number;
  state: 'starting' | 'running' | 'stopped' | 'error';
  ownerToken?: string;
  error?: string;
  lastError?: string;
}

interface PendingLaunch {
  version: 1;
  pid: number;
  launchId: string;
  startedAt: number;
}

export interface ProcessStatus {
  running: boolean;
  pid: number | null;
  mode: 'background' | 'terminal' | null;
  starting: boolean;
  error?: string;
}

const queues = new Map<string, Promise<unknown>>();
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part);
}

async function localPath(cwd: string, file: string, create = false): Promise<string> {
  const root = await realpath(cwd);
  const directory = join(root, '.piq');
  if (create) await mkdir(directory, { recursive: true });
  if (!within(root, await realpath(directory))) throw new Error('Pi 运行记录必须位于本群目录。');
  const path = join(directory, file);
  try {
    if ((await lstat(path)).isSymbolicLink() || !within(root, await realpath(path))) throw new Error('请使用本群目录内的普通运行记录文件。');
  } catch (error) { if (!missing(error)) throw error; }
  return path;
}

async function worker(cwd: string): Promise<Worker | null> {
  try {
    const path = await localPath(cwd, 'worker.json');
    if ((await lstat(path)).size > 16_384) throw new Error();
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!object(value) || value.version !== 1 || value.mode !== 'background' || !Number.isSafeInteger(value.pid)
      || Number(value.pid) <= 0 || typeof value.launchId !== 'string' || !Number.isFinite(value.startedAt)
      || !['starting', 'running', 'stopped', 'error'].includes(String(value.state))) throw new Error();
    return value as unknown as Worker;
  } catch (error) { if (missing(error)) return null; throw new Error('后台运行记录无效，请检查本群 .piq/worker.json。'); }
}

async function pendingLaunch(cwd: string): Promise<PendingLaunch | null> {
  try {
    const path = await localPath(cwd, 'worker-launch.json');
    if ((await lstat(path)).size > 16_384) throw new Error();
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
      || typeof value.launchId !== 'string' || !value.launchId || typeof value.startedAt !== 'number'
      || !Number.isFinite(value.startedAt) || value.startedAt < 0) throw new Error();
    return value as unknown as PendingLaunch;
  } catch (error) { if (missing(error)) return null; throw new Error('后台启动记录无效，请检查本群 .piq/worker-launch.json。'); }
}

async function ownerToken(cwd: string): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(await localPath(cwd, 'owner.lock'), 'utf8'));
    return object(value) && typeof value.token === 'string' ? value.token : undefined;
  } catch (error) { if (missing(error)) return undefined; throw error; }
}

export async function getProcessStatus(cwd: string): Promise<ProcessStatus> {
  const owner = await getRunningOwner(cwd);
  const record = await worker(cwd);
  if (owner.running) {
    const background = record?.pid === owner.pid && record.ownerToken === await ownerToken(cwd)
      && record.state === 'running';
    return { ...owner, mode: background ? 'background' : 'terminal', starting: false,
      ...(background && record.lastError ? { error: '后台 Pi 扩展运行出现错误；进程仍在运行，可切换到终端查看。' } : {}) };
  }
  const pending = await pendingLaunch(cwd);
  // The parent publishes this before the child has imported its modules or
  // written worker.json. A matching ready/terminal record supersedes it.
  if (pending && alive(pending.pid) && (!record
    || (record.launchId !== pending.launchId && record.startedAt < pending.startedAt))) {
    return { running: false, pid: pending.pid, mode: 'background', starting: true };
  }
  if (record && record.state === 'starting' && alive(record.pid)) {
    return { running: false, pid: record.pid, mode: 'background', starting: true };
  }
  const terminal = await getTerminalLaunchStatus(cwd);
  if (terminal.running || terminal.starting) return { ...terminal, mode: 'terminal' };
  const terminalError = await getTerminalReturnError(cwd);
  return { running: false, pid: null, mode: null, starting: false,
    ...(terminalError ? { error: terminalError }
      : record?.state === 'error' ? { error: '后台 Pi 启动失败，请检查本群模型配置和扩展加载情况。' } : {}) };
}

async function exclusive<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(cwd) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(operation);
  queues.set(cwd, task);
  try { return await task; } finally { if (queues.get(cwd) === task) queues.delete(cwd); }
}

export interface ProcessResult { message: string; alreadyRunning?: boolean; starting?: boolean; pid?: number }

/** Starting a group always opens a user-owned terminal. */
export async function startGroup(cwd: string, options: TerminalOptions = {}): Promise<ProcessResult> {
  const status = await getProcessStatus(cwd);
  if (status.running || status.starting) return { message: status.starting ? '本组 Pi 正在启动。' : '本组 Pi 已运行。',
    alreadyRunning: true, starting: status.starting, pid: status.pid ?? undefined };
  return openGroupTerminal(cwd, options);
}

export interface HandoffOptions {
  shutdown?: (cwd: string) => Promise<unknown>;
  openTerminal?: typeof openGroupTerminal;
  timeoutMs?: number;
}

/** Gracefully release the background owner before the terminal resumes the same session files. */
export async function handoffToTerminal(cwd: string, options: HandoffOptions = {}): Promise<ProcessResult> {
  const directory = await realpath(resolve(cwd));
  return exclusive(directory, async () => {
    const status = await getProcessStatus(directory);
    if (status.starting) return { message: '后台 Pi 正在启动，请等启动完成后再切换到终端。', alreadyRunning: true, starting: true };
    if (status.running && status.mode === 'background') {
      const expectedToken = await ownerToken(directory);
      const shutdown = options.shutdown ?? (async path => {
        const { requestRunAction } = await import('./run-control.ts');
        return requestRunAction(path, 'handoff');
      });
      await shutdown(directory);
      const deadline = Date.now() + (options.timeoutMs ?? 8_000);
      while (true) {
        const owner = await getRunningOwner(directory);
        if (!owner.running) break;
        const token = await ownerToken(directory);
        // The owner may finish releasing its lock between these two reads.
        if (token === undefined && !(await getRunningOwner(directory)).running) break;
        if (owner.pid !== status.pid || token !== expectedToken) throw new Error('本群会话已由其他实例接管，请刷新状态。');
        if (Date.now() >= deadline) throw new Error('后台 Pi 尚未退出，请等待当前工作结束后重试。');
        await delay(100);
      }
    }
    return await (options.openTerminal ?? openGroupTerminal)(directory);
  });
}
