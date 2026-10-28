import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseConversationKey } from './conversations.ts';

export type RunAction = 'pause' | 'resume' | 'shutdown' | 'handoff';
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';
export interface RuntimeStatus {
  pid: number;
  mode: 'terminal';
  paused: boolean;
  connection: ConnectionState;
  pendingCount: number;
  pendingConversations: Array<{key:string;count:number}>;
  updatedAt: number;
  requestId?: string;
  lastError?: string;
}
interface Owner { version: 1; pid: number; token: string }
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

async function pathFor(cwd: string, filename: string): Promise<string> {
  const root = await realpath(cwd);
  const directory = await realpath(join(root, '.piq'));
  const part = relative(root, directory);
  if (part === '..' || part.startsWith('../') || part.startsWith('..\\') || isAbsolute(part)) throw new Error('运行控制必须位于本群目录。');
  const path = join(directory, filename);
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('运行控制文件不能是符号链接。'); }
  catch (error) { if (!missing(error)) throw error; }
  return path;
}

async function read(cwd: string, filename: string): Promise<any> {
  try {
    const path = await pathFor(cwd, filename);
    if ((await lstat(path)).size > 32_768) throw new Error('运行控制文件过大。');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (missing(error)) return null; throw error; }
}

async function write(cwd: string, filename: string, data: unknown, expectedOwner?: Owner): Promise<void> {
  const path = await pathFor(cwd, filename);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(data, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      if (expectedOwner) {
        const current = await owner(cwd);
        if (current?.token !== expectedOwner.token || current.pid !== expectedOwner.pid) return;
      }
      try { await rename(temp, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await delay(15 * (attempt + 1));
      }
    }
  } finally { await unlink(temp).catch(error => { if (!missing(error)) throw error; }); }
}

async function owner(cwd: string): Promise<Owner | null> {
  const value = await read(cwd, 'owner.lock');
  if (value === null) return null;
  if (value?.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== 'string') throw new Error('本群运行锁无效。');
  return value;
}

export async function readRuntimeStatus(cwd: string): Promise<RuntimeStatus | null> {
  const [lock, status] = await Promise.all([owner(cwd), read(cwd, 'runtime.json')]);
  if (!lock || status?.ownerToken !== lock.token || status?.pid !== lock.pid) return null;
  if (typeof status.paused !== 'boolean' || !['connecting', 'connected', 'disconnected', 'error'].includes(status.connection)) return null;
  const pendingConversations = Array.isArray(status.pendingConversations) ? status.pendingConversations.filter((item:unknown): item is {key:string;count:number} => {
    if (!item || typeof item !== 'object' || !('key' in item) || !('count' in item) || !Number.isSafeInteger(item.count) || Number(item.count)<0) return false;
    try { parseConversationKey(item.key); return true; } catch { return false; }
  }).map((item:{key:string;count:number})=>({key:item.key,count:item.count})) : [];
  return { pid: lock.pid, mode: 'terminal', paused: status.paused,
    connection: status.connection, pendingCount: Number(status.pendingCount) || 0, pendingConversations, updatedAt: Number(status.updatedAt),
    requestId: typeof status.requestId === 'string' ? status.requestId : undefined,
    lastError: typeof status.lastError === 'string' ? status.lastError : undefined };
}

export async function requestRunAction(cwd: string, action: RunAction): Promise<{ requestId: string }> {
  if (!['pause', 'resume', 'shutdown', 'handoff'].includes(action)) throw new Error('未知运行操作。');
  const lock = await owner(cwd);
  if (!lock) throw new Error('本群 Pi 当前未运行。');
  try { process.kill(lock.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw new Error('本群 Pi 已退出。'); }
  const requestId = randomUUID();
  await write(cwd, 'run-request.json', { version: 1, requestId, targetPid: lock.pid, ownerToken: lock.token, action }, lock);
  return { requestId };
}

/** Stop can also cancel unfinished work after a terminal has already exited. */
export async function clearInterruptedWork(cwd: string): Promise<void> {
  const saved = await read(cwd, 'run-preferences.json');
  if (saved === null) return;
  if (saved.version !== 1 || typeof saved.paused !== 'boolean') throw new Error('本群暂停状态格式无效。');
  await write(cwd, 'run-preferences.json', { version: 1, paused: saved.paused, interrupted: false });
}

export interface RunCallbacks {
  snapshot(): { connection: ConnectionState; pendingCount: number; pendingConversations?: Array<{key:string;count:number}>; lastError?: string };
  pause(): void | Promise<void>;
  resume(interrupted: boolean): void | Promise<void>;
  isBusy(): boolean;
  shutdown(): void;
  error(error: unknown): void;
}

/** Pause holds automatic work while the same Pi process keeps receiving group records. */
export class RunController {
  paused = false;
  private interrupted = false;
  private closed = false;
  private exiting = false;
  private lastRequest?: string;
  private lastSerialized = '';
  private timer?: ReturnType<typeof setInterval>;
  private task: Promise<void> = Promise.resolve();
  private scheduled = false;
  private readonly cwd: string;
  private readonly lock: Owner;
  private readonly callbacks: RunCallbacks;

  private constructor(cwd: string, lock: Owner, callbacks: RunCallbacks) {
    this.cwd = cwd; this.lock = lock; this.callbacks = callbacks;
  }

  static async open(cwd: string, callbacks: RunCallbacks, pollMs = 500): Promise<RunController> {
    const lock = await owner(cwd);
    if (!lock || lock.pid !== process.pid) throw new Error('当前 Pi 尚未取得本群运行锁。');
    const controller = new RunController(cwd, lock, callbacks);
    const saved = await read(cwd, 'run-preferences.json');
    if (saved && (saved.version !== 1 || typeof saved.paused !== 'boolean')) throw new Error('本群暂停状态格式无效。');
    controller.paused = saved?.paused ?? false;
    controller.interrupted = saved?.interrupted === true;
    if (process.env.PIQ_START_RUNNING === '1') {
      delete process.env.PIQ_START_RUNNING;
      controller.paused = false;
      await write(cwd, 'run-preferences.json', { version: 1, paused: false, interrupted: controller.interrupted }, lock);
    }
    await controller.publish();
    controller.timer = setInterval(() => controller.refresh(), pollMs);
    controller.timer.unref();
    controller.refresh();
    return controller;
  }

  get needsResume(): boolean { return !this.paused && this.interrupted; }

  /** Commit before a model turn starts, so an abrupt process exit leaves a restart point. */
  markBusy(busy: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (this.paused || this.exiting || !await this.ownsGroup()) return;
      this.interrupted = busy;
      await this.savePreferences();
    });
  }

  private async ownsGroup(): Promise<boolean> {
    if (this.closed) return false;
    const lock = await owner(this.cwd);
    return !this.closed && lock?.token === this.lock.token && lock.pid === this.lock.pid;
  }

  private savePreferences(): Promise<void> {
    return write(this.cwd, 'run-preferences.json', { version: 1, paused: this.paused, interrupted: this.interrupted }, this.lock);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.task.then(operation);
    this.task = result.catch(error => { if (!this.closed) this.callbacks.error(error); });
    return result;
  }

  refresh(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    void this.enqueue(async () => {
      if (!await this.ownsGroup()) return;
      const request = await read(this.cwd, 'run-request.json');
      if (request?.version === 1 && request.targetPid === this.lock.pid && request.ownerToken === this.lock.token
        && typeof request.requestId === 'string' && request.requestId !== this.lastRequest
        && ['pause', 'resume', 'shutdown', 'handoff'].includes(request.action)) {
        this.lastRequest = request.requestId;
        if (request.action === 'shutdown' || request.action === 'handoff') {
          this.exiting = true;
          this.interrupted = request.action === 'handoff' && (this.interrupted || this.callbacks.isBusy());
          await this.savePreferences();
          await this.publish();
          if (!this.closed) this.callbacks.shutdown();
          return;
        }
        if (request.action === 'pause') {
          this.interrupted ||= this.callbacks.isBusy();
          this.paused = true;
          await this.savePreferences();
          if (!this.closed) await this.callbacks.pause();
        } else {
          const interrupted = this.interrupted;
          this.paused = false;
          await this.savePreferences();
          if (!this.closed) await this.callbacks.resume(interrupted);
        }
      }
      if (!this.closed) await this.publish();
    }).catch(() => {}).finally(() => { this.scheduled = false; });
  }

  private async publish(): Promise<void> {
    const values = { version: 1, ownerToken: this.lock.token, pid: this.lock.pid,
      mode: 'terminal',
      paused: this.paused, ...this.callbacks.snapshot(), requestId: this.lastRequest };
    const serialized = JSON.stringify(values);
    if (serialized === this.lastSerialized) return;
    await write(this.cwd, 'runtime.json', { ...values, updatedAt: Date.now() }, this.lock);
    this.lastSerialized = serialized;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.task;
  }
}
