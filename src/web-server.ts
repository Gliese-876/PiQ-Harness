import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { mkdir, readFile, readdir, realpath, lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { defaultMessagesRoot } from './cli.ts';
import { DEFAULTS, initializeGroup, listGroupConfigs, loadConfig, saveGroupConfig, validateConfig, validateGroupId, type GroupConfig } from './config.ts';
import { deleteGroup, listDeletedGroups, restoreGroup } from './group-management.ts';
import { conversationKey, conversationDirectory, parseConversationKey, type Conversation } from './conversations.ts';
import { credentialStatus, getRunningOwner, openGroupTerminal } from './web-terminal.ts';
import { getModelPreference, listModels, saveModelPreference, type ModelCatalog } from './web-models.ts';
import { readModelStatus, requestModelChange } from './model-control.ts';
import { clearInterruptedWork, readRuntimeStatus, requestRunAction } from './run-control.ts';
import { clearTerminalLaunch, stopTerminalRegistration } from './terminal-monitor.ts';
import { getProcessStatus } from './process-manager.ts';
import { parseStoredRecord } from './store.ts';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const DOCS = new Set(['AGENTS.md', 'PERSONA.md', 'MEMORY.md']);
const MAX_BODY = 512 * 1024;
const MAX_INDEX_RECORD = 8 * 1024 * 1024;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const revision = (content: string) => createHash('sha256').update(content).digest('hex');

/** Every path is resolved beneath the configured root, including existing symlinks. */
function contains(root: string, file: string): boolean {
  const part = relative(root, file);
  return part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part);
}

async function safeFile(cwd: string, file: string, allowMissing = false): Promise<string> {
  const path = join(cwd, file);
  const parent = await realpath(dirname(path));
  if (!contains(cwd, parent)) throw new HttpError(400, '文件路径不属于当前群。');
  try {
    const resolved = await realpath(path);
    if (!contains(cwd, resolved) || (await lstat(path)).isSymbolicLink()) throw new HttpError(400, '请使用本群目录内的普通文件。');
    return path;
  } catch (error) { if (allowMissing && missing(error)) return path; throw error; }
}

async function textFile(path: string, allowMissing = false): Promise<string> {
  try {
    if ((await lstat(path)).size > MAX_BODY) throw new HttpError(413, '文档超过 512 KB，请在本地编辑器中打开。');
    return await readFile(path, 'utf8');
  } catch (error) { if (allowMissing && missing(error)) return ''; throw error; }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '需要 JSON 请求。');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, '内容超过 512 KB。');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, 'JSON 格式无效。'); }
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

export interface WebOptions {
  root?: string;
  port?: number;
  openTerminal?: typeof openGroupTerminal;
  credentials?: typeof credentialStatus;
  models?: () => Promise<ModelCatalog>;
  action?: typeof requestRunAction;
}

export async function startWebServer(options: WebOptions = {}): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  await mkdir(options.root ?? defaultMessagesRoot(), { recursive: true });
  const root = await realpath(options.root ?? defaultMessagesRoot());
  const csrfToken = randomBytes(32).toString('hex');
  const launch = options.openTerminal ?? openGroupTerminal;
  const credentials = options.credentials ?? credentialStatus;
  const models = options.models ?? (() => listModels());
  const action = options.action ?? requestRunAction;
  const launching = new Map<string, number>();
  const operations = new Map<string, Promise<unknown>>();
  let port = 0;

  async function runtime(cwd: string) {
    const process = await getProcessStatus(cwd);
    const status = process.running ? await readRuntimeStatus(cwd) : null;
    return { ...process, runtime: status ? { ...status, mode: process.mode ?? status.mode } : null };
  }

  async function groupPath(id: string): Promise<string> {
    validateGroupId(id);
    const path = await realpath(join(root, id));
    if (!contains(root, path) || relative(root, path).split(/[\\/]/).length !== 1) throw new HttpError(400, '群目录必须位于 PiQ-Messages 中。');
    const config = await loadConfig(path);
    if (!config || config.id !== id) throw new HttpError(400, '目录与 PIQ.md 的对话组标识不一致。');
    return path;
  }

  async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = operations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    operations.set(key, current);
    try { return await current; } finally { if (operations.get(key) === current) operations.delete(key); }
  }

  async function stopSession(cwd: string, preserveContext = false): Promise<{ requestId?: string }> {
    // Reject late terminal registration while retaining live PIDs until they exit.
    const terminalToken = await stopTerminalRegistration(cwd);
    const deadline = Date.now() + 10_000;
    while (!(await getRunningOwner(cwd)).running && (await getProcessStatus(cwd)).starting) {
      if (Date.now() >= deadline) throw new HttpError(409, 'Pi 仍在启动，请稍后重试停止。');
      await delay(100);
    }
    if (!(await getRunningOwner(cwd)).running) {
      const status = await getProcessStatus(cwd);
      if (status.running || status.starting) throw new HttpError(409, 'Pi 终端进程仍在运行但尚未取得本组运行锁，请关闭原终端后重试。');
      if (terminalToken) await clearTerminalLaunch(cwd, terminalToken);
      if (!preserveContext) await clearInterruptedWork(cwd);
      return {};
    }
    const result = await action(cwd, preserveContext ? 'handoff' : 'shutdown');
    while ((await getRunningOwner(cwd)).running || (await getProcessStatus(cwd)).running || (await getProcessStatus(cwd)).starting) {
      if (Date.now() >= deadline) throw new HttpError(409, 'Pi 尚未退出，请在原终端结束会话后重试。');
      await delay(100);
    }
    if (terminalToken) await clearTerminalLaunch(cwd, terminalToken);
    if (!preserveContext) await clearInterruptedWork(cwd);
    return result;
  }

  async function openSession(id: string, freshSession: boolean) {
    const cwd = await groupPath(id);
    if (!(await loadConfig(cwd))!.conversations.length) throw new HttpError(400, '请先添加至少一个对话。');
    if ((launching.get(id) ?? 0) > Date.now()) {
      if (freshSession) throw new HttpError(409, '终端正在打开，请等启动完成后重开会话。');
      return { alreadyRunning: true, message: '终端正在打开，请稍候。' };
    }
    const process = await getProcessStatus(cwd);
    if (!freshSession && process.running) {
      return { alreadyRunning: true, message: `本组 Pi 已在终端运行（PID ${process.pid}），请切换到原终端。` };
    }
    if (process.starting) throw new HttpError(409, 'Pi 正在启动，请等启动完成后重试。');
    if (freshSession || process.running) await stopSession(cwd, !freshSession);
    const result = await launch(cwd, { freshSession });
    if (!result.alreadyRunning) launching.set(id, Date.now() + 10_000);
    return { ...result, ...(freshSession ? { freshSession: true } : {}) };
  }

  async function save(cwd: string, filename: string, content: unknown, expected: unknown): Promise<string> {
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BODY) throw new HttpError(400, '文档内容无效或过大。');
    return exclusive(join(cwd, filename), async () => {
      const path = await safeFile(cwd, filename, true);
      const original = await textFile(path, true);
      if (typeof expected !== 'string' || revision(original) !== expected) throw new HttpError(409, '文件已在其他位置修改，请重新加载后再保存。');
      const temporary = join(cwd, `.piq-web-${randomBytes(8).toString('hex')}.tmp`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        if (await textFile(path, true) !== original) throw new HttpError(409, '文件已在其他位置修改，请重新加载后再保存。');
        await safeFile(cwd, filename, true);
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
      return revision(content);
    });
  }

  async function groups() {
    return Promise.all((await listGroupConfigs(root)).map(async ({id,path,config}) => ({
      id, name: config.name, conversations: config.conversations, path, ...await runtime(path),
    })));
  }

  async function logIndex(cwd: string, config: GroupConfig): Promise<Record<string, string[]>> {
    const logs: Record<string,string[]> = Object.fromEntries(config.conversations.map(item => [conversationKey(item), []]));
    const known = new Map(config.conversations.map(item => [conversationDirectory(item), item]));
    const directories = async (path: string) => {
      try { return (await readdir(await safeFile(cwd,path), {withFileTypes:true})).filter(item=>item.isDirectory() && /^[a-f0-9]{64}$/.test(item.name)); }
      catch(error) { if(missing(error)) return []; throw error; }
    };
    const add = async (directory: string) => {
      const path = await safeFile(cwd, directory);
      const files = (await readdir(path)).filter(file=>/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort().reverse();
      let conversation = known.get(directory);
      // Removed members retain their logs. Their opaque OpenID cannot be inferred
      // from the hashed directory; recover it from one complete stored record.
      if (!conversation) {
        for (const file of files) {
          const handle = await open(await safeFile(cwd, `${directory}/${file}`), 'r');
          try {
            const buffer = Buffer.alloc(Math.min((await handle.stat()).size, MAX_INDEX_RECORD));
            let read = 0;
            while (read < buffer.length && buffer.subarray(0, read).indexOf(10) < 0) {
              const result = await handle.read(buffer, read, buffer.length - read, read);
              if (!result.bytesRead) break;
              read += result.bytesRead;
            }
            const end = buffer.subarray(0, read).indexOf(10);
            if (end < 0) {
              if (read === MAX_INDEX_RECORD) throw new HttpError(413, '历史日志首条记录超过 8 MiB，请在本地检查该日志。');
              continue;
            }
            const record = parseStoredRecord(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end)), file);
            if (conversationDirectory(record.conversation) !== directory) throw new HttpError(400, '日志目录与来源 OpenID 不一致。');
            conversation = record.conversation;
            break;
          } finally { await handle.close(); }
        }
      }
      if (conversation) logs[conversationKey(conversation)] = files;
    };
    for (const type of ['group','private'] as const) {
      for (const item of await directories(`messages/v3/${type}`)) await add(`messages/v3/${type}/${item.name}`);
    }
    return logs;
  }

  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    void (async () => {
      const host = request.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, '仅允许从本机地址访问。');
      if (!request.url?.startsWith('/')) throw new HttpError(400, '无效路径。');
      const url = new URL(request.url, `http://${host}`);
      const method = request.method ?? 'GET';
      if (method !== 'GET') {
        if (request.headers.origin !== `http://${host}` || request.headers['x-piq-token'] !== csrfToken) throw new HttpError(403, '页面凭据已失效，请刷新后重试。');
      }
      const parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
      if (parts[0] !== 'api') {
        if (method !== 'GET') throw new HttpError(405, '不支持的方法。');
        const assets: Record<string, string> = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/theme.js': 'theme.js', '/style.css': 'style.css' };
        const filename = assets[url.pathname];
        if (!filename) throw new HttpError(404, '未找到页面。');
        const type = filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html';
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        response.end(await readFile(join(WEB, filename)));
        return;
      }
      if (method === 'GET' && url.pathname === '/api/state') {
        const list = await groups();
        json(response, { root, csrfToken, groups: list, defaultAppIdEnv: DEFAULTS.appIdEnv, defaultAppSecretEnv: DEFAULTS.appSecretEnv }); return;
      }
      if (method === 'GET' && url.pathname === '/api/models') { json(response, await models()); return; }
      if (method === 'GET' && url.pathname === '/api/trash') {
        json(response, { entries: await listDeletedGroups(root) }); return;
      }
      if (method === 'POST' && parts.length === 4 && parts[1] === 'trash' && parts[3] === 'restore') {
        await readBody(request);
        json(response, await restoreGroup(root, parts[2]!)); return;
      }
      if (url.pathname === '/api/root/agents') {
        if (method === 'GET') {
          const content = await textFile(await safeFile(root, 'AGENTS.md', true), true);
          json(response, { content, revision: revision(content) }); return;
        }
        if (method === 'PUT') {
          const body = await readBody(request);
          json(response, { revision: await save(root, 'AGENTS.md', body.content, body.revision) }); return;
        }
      }
      if (method === 'POST' && url.pathname === '/api/groups') {
        const body = await readBody(request);
        if (Object.keys(body).some(key=>!['id','name','conversations','appIdEnv','appSecretEnv'].includes(key))) throw new HttpError(400,'请使用对话组创建格式。');
        const id = validateGroupId(body.id ?? `cg-${randomBytes(4).toString('hex')}`);
        await exclusive(`init:${id}`, async () => {
          try { await lstat(join(root, id)); throw new HttpError(409, '该群目录已存在。'); }
          catch (error) { if (!missing(error)) throw error; }
          await initializeGroup(root, id, { name: body.name as string, conversations: body.conversations as Conversation[],
            appIdEnv: body.appIdEnv as string | undefined, appSecretEnv: body.appSecretEnv as string | undefined });
        });
        json(response, { id }, 201); return;
      }
      if (parts[1] !== 'groups' || !parts[2]) throw new HttpError(404, '未找到接口。');
      const id = validateGroupId(parts[2]);
      if (method === 'DELETE' && parts.length === 3) {
        await exclusive(`run:${id}`, async () => {
          if ((launching.get(id) ?? 0) > Date.now()) throw new HttpError(409, '终端正在打开，请等启动完成并停止后重试。');
          const result = await deleteGroup(join(root, id));
          launching.delete(id);
          json(response, result);
        });
        return;
      }
      const cwd = await groupPath(id);
      if (parts[3] === 'model' && parts.length === 4) {
        const runtimeState = async () => {
          const owner = await getRunningOwner(cwd);
          const status = await readModelStatus(cwd);
          return owner.running && status?.pid === owner.pid ? status : null;
        };
        if (method === 'GET') { json(response, { ...await getModelPreference(cwd), runtime: await runtimeState() }); return; }
        if (method === 'PUT') {
          const body = await readBody(request);
          await exclusive(`model:${id}`, async () => {
            const selected = await saveModelPreference(cwd, body as unknown as Parameters<typeof saveModelPreference>[1], models);
            let requestId: string | undefined; let applyError: string | undefined;
            if ((await getRunningOwner(cwd)).running) {
              try { ({ requestId } = await requestModelChange(cwd, selected)); }
              catch { applyError = '选择已保存，但当前会话未接收变更；请检查 Pi 终端，或重新打开本群会话。'; }
            }
            json(response, { ...selected, requestId, applyError, runtime: await runtimeState() });
          });
          return;
        }
      }
      if (method === 'GET' && parts.length === 3) {
        const config = (await loadConfig(cwd))!;
        const logs = await logIndex(cwd, config);
        json(response, { id, name: config.name, conversations: config.conversations, path: cwd, ...await runtime(cwd), config,
          configRevision: revision(await textFile(await safeFile(cwd, 'PIQ.md'))),
          documents: [...DOCS], logs, credential: await credentials(config) }); return;
      }
      if (parts[3] === 'documents' && parts.length === 5 && DOCS.has(parts[4]!)) {
        const file = parts[4]!;
        if (method === 'GET') { const content = await textFile(await safeFile(cwd, file, true), true); json(response, { content, revision: revision(content) }); return; }
        if (method === 'PUT') { const body = await readBody(request); json(response, { revision: await save(cwd, file, body.content, body.revision) }); return; }
      }
      if (parts[3] === 'logs' && parts.length === 6 && method === 'GET' && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(parts[5]!)) {
        const conversation = parseConversationKey(parts[4]);
        const file = await safeFile(cwd, `${conversationDirectory(conversation)}/${parts[5]}`);
        const handle = await open(file, 'r');
        try {
          const size = (await handle.stat()).size;
          const start = Math.max(0, size - MAX_BODY);
          // Include one preceding byte to distinguish an exact record boundary
          // from a partial first line, including when a record fills the limit.
          const readStart = Math.max(0, start - 1);
          const buffer = Buffer.alloc(size - readStart);
          let bytesRead = 0;
          while (bytesRead < buffer.length) {
            const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, readStart + bytesRead);
            if (!result.bytesRead) throw new HttpError(409, '日志在读取期间发生变化，请刷新后重试。');
            bytesRead += result.bytesRead;
          }
          if (size && buffer.at(-1) !== 10) throw new HttpError(400, 'JSONL 日志末尾记录尚未写完，请稍后刷新或检查该文件。');
          let offset = 0;
          if (start > 0) {
            offset = buffer[0] === 10 ? 1 : buffer.indexOf(10, 1) + 1;
            if (!offset || offset >= buffer.length) throw new HttpError(413, '最后一条消息超过 512 KB，请在本地读取完整 JSONL 日志。');
          }
          let content: string;
          try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(offset)); }
          catch { throw new HttpError(400, 'JSONL 日志含无效的 UTF-8 内容，请检查该文件。'); }
          if (content) {
            for (const line of content.slice(0, -1).split(/\r?\n/)) {
              const record = parseStoredRecord(line, parts[5]);
              if (conversationKey(record.conversation) !== conversationKey(conversation)) throw new HttpError(400, '日志路径与消息来源对话不一致。');
            }
          }
          json(response, { content, truncated: start > 0 });
        } finally { await handle.close(); }
        return;
      }
      if (method === 'PUT' && parts[3] === 'config' && parts.length === 4) {
        const body = await readBody(request);
        const config = validateConfig(body.config);
        if (config.id !== id) throw new HttpError(400, '此处不能更改对话组标识。');
        const saved = await saveGroupConfig(cwd,config,body.revision as string);
        json(response, { ...saved, credential: await credentials(saved.config) }); return;
      }
      if (method === 'POST' && parts.length === 4 && ['open', 'start', 'new-session'].includes(parts[3]!)) {
        const body = await readBody(request);
        if (Object.keys(body).some(key => key !== 'freshSession')
          || (body.freshSession !== undefined && typeof body.freshSession !== 'boolean')) throw new HttpError(400, '终端参数无效。');
        const fresh = parts[3] === 'new-session' || body.freshSession === true;
        await exclusive(`run:${id}`, async () => { json(response, await openSession(id, fresh)); });
        return;
      }
      if (method === 'POST' && parts.length === 4 && ['pause', 'resume', 'stop'].includes(parts[3]!)) {
        await readBody(request);
        await exclusive(`run:${id}`, async () => {
          if (parts[3] === 'stop') {
            const result = await stopSession(cwd);
            launching.delete(id);
            json(response, { ...result, message: '对话组已停止。' });
          } else {
            const requested = parts[3] as 'pause' | 'resume';
            const state = await runtime(cwd);
            if (!state.running) throw new HttpError(409, '本群 Pi 尚未运行，请先启动。');
            if (!state.runtime) throw new HttpError(409, '当前 Pi 尚未加载运行控制，请在已有终端执行 /reload 后重试。');
            json(response, { ...await action(cwd, requested), message: requested === 'pause' ? '正在暂停，消息会继续保存。' : '正在恢复本群 Pi。' });
          }
        });
        return;
      }
      throw new HttpError(404, '未找到接口。');
    })().catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      const suppliedStatus = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
      const status = suppliedStatus >= 400 && suppliedStatus <= 599 ? suppliedStatus : missing(error) ? 404 : 400;
      json(response, { error: error instanceof Error ? error.message : '请求失败。' }, status);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 3210, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('WebUI 启动失败。');
  port = address.port;
  return { server, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
