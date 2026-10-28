import { resolve } from 'node:path';
import { conversationKey, parseConversationKey, validateOpenId } from './conversations.ts';
import { discoverGroup, DISCOVERY_BOT_STATE_ERROR } from './discover.ts';

export interface WebDiscoverySnapshot {
  state: 'idle' | 'connecting' | 'connected' | 'error';
  conversations: Array<{ type: 'group' | 'private'; id: string }>;
  error?: string;
}

export interface WebDiscoveryOptions {
  discover?: typeof discoverGroup;
  ttlMs?: number;
}

export interface WebDiscovery {
  start(cwd: string): Promise<WebDiscoverySnapshot>;
  snapshot(cwd: string): WebDiscoverySnapshot;
  stop(cwd: string): Promise<WebDiscoverySnapshot>;
  close(): Promise<void>;
}

interface Entry {
  state: WebDiscoverySnapshot['state'];
  conversations: WebDiscoverySnapshot['conversations'];
  seen: Set<string>;
  error?: string;
  cleanupFailed?: boolean;
  connectionError?: string;
  controller?: AbortController;
  run?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

const failed = '无法发现对话，请在连接设置检查机器人凭据，并检查平台权限、网络及是否已有实例占用。';
const failedStop = '发现连接未能正常关闭，请检查机器人运行占用后再启动 Pi。';
const directoryKey = (cwd: string) => process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function copy(entry?: Entry): WebDiscoverySnapshot {
  return { state: entry?.state ?? 'idle', conversations: entry?.conversations.map(value => ({ ...value })) ?? [],
    ...(entry?.error ? { error: entry.error } : {}) };
}

/** A discovery run exists only after an explicit start; its metadata stays in memory. */
export function createWebDiscovery(options: WebDiscoveryOptions = {}): WebDiscovery {
  const ttlMs = options.ttlMs ?? 180_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 180_000) throw new Error('发现对话时限须为 1 到 180000 毫秒。');
  const entries = new Map<string, Entry>();
  const discover = options.discover ?? discoverGroup;
  let closed = false;
  let closing: Promise<void> | undefined;

  function receive(key: string, entry: Entry, controller: AbortController, line: string): void {
    if (closed || entries.get(key) !== entry || !entry.run || controller.signal.aborted || entry.cleanupFailed
      || typeof line !== 'string' || line.length > 2048) return;
    const value = line.trim();
    switch (value) {
      case '正在监听 QQ 官方机器人事件；按 Ctrl+C 退出。':
      case '正在连接 QQ 官方机器人。':
      case 'QQ 官方机器人连接已断开，等待重新连接。':
        entry.state = 'connecting'; delete entry.error; return;
      case 'QQ 官方机器人已连接，等待会话事件。':
        entry.state = 'connected'; delete entry.error; delete entry.connectionError; return;
      case 'QQ 官方机器人连接发生错误，请检查应用配置和网络。':
        entry.state = 'connecting'; entry.error = entry.connectionError ?? '连接暂时异常，正在等待重新连接。'; return;
      case '无法启动 QQ 官方机器人连接，请检查应用配置和网络。':
        entry.state = 'error'; entry.error = entry.connectionError ?? failed; return;
      case DISCOVERY_BOT_STATE_ERROR:
        entry.connectionError = DISCOVERY_BOT_STATE_ERROR; entry.error = DISCOVERY_BOT_STATE_ERROR; return;
      case '无法读取 PIQ.md，请检查当前对话组配置。':
      case '当前对话组缺少 PIQ.md，请先初始化对话组。':
        entry.state = 'error'; entry.error = '无法读取当前对话组配置，请检查 PIQ.md。'; return;
      case '无法读取 QQ 机器人凭据，请检查工作台的连接设置。':
        entry.state = 'error'; entry.error = '无法读取机器人凭据，请在连接设置保存机器人凭据。'; return;
      case '无法取得 QQ 机器人运行占用；同一 AppID 可能已有 PiQ 对话组运行，请先结束相关组并检查本机 socket 占用。':
        entry.state = 'error'; entry.error = '机器人运行占用不可用，请先停止其他 PiQ 实例并检查本机 socket 权限。'; return;
      case '无法关闭 QQ 官方机器人连接，请结束当前进程。':
      case '无法释放 QQ 机器人的本机运行占用，请结束当前进程。':
        entry.state = 'error'; entry.error = failedStop; entry.cleanupFailed = true; return;
    }
    // Credential diagnostics are reduced to fixed text without exposing their contents.
    if (value.startsWith('无法连接 QQ 官方机器人：')) {
      entry.state = 'error'; entry.error = '机器人凭据不完整，请在连接设置保存机器人凭据。'; return;
    }
    if (!value.startsWith('{') || entry.conversations.length >= 128) return;
    try {
      const metadata: unknown = JSON.parse(value);
      if (!object(metadata) || Object.keys(metadata).length !== 2
        || !Object.hasOwn(metadata, 'conversationKey') || !Object.hasOwn(metadata, 'userId')) return;
      const conversation = parseConversationKey(metadata.conversationKey);
      validateOpenId(metadata.userId);
      const id = conversationKey(conversation);
      if (entry.seen.has(id)) return;
      entry.seen.add(id);
      entry.conversations.push({ type: conversation.type, id: conversation.id });
    } catch { /* Only the validated discovery metadata shape is accepted. */ }
  }

  async function stop(cwd: string): Promise<WebDiscoverySnapshot> {
    const entry = entries.get(directoryKey(cwd));
    if (!entry) return copy();
    if (entry.run) {
      if (!entry.cleanupFailed) { entry.state = 'idle'; delete entry.error; }
      entry.controller?.abort();
      await entry.run;
    } else if (!entry.cleanupFailed) {
      entry.state = 'idle'; delete entry.error;
    }
    if (entry.cleanupFailed) { entry.state = 'error'; entry.error = failedStop; }
    else { entry.state = 'idle'; delete entry.error; }
    return copy(entry);
  }

  return {
    async start(cwd) {
      const key = directoryKey(cwd);
      while (true) {
        if (closed) throw new Error('对话发现服务已关闭。');
        const previous = entries.get(key);
        if (previous?.cleanupFailed) return copy(previous);
        if (previous?.run) {
          if (!previous.controller?.signal.aborted) return copy(previous);
          await previous.run;
          continue;
        }
        const entry: Entry = { state: 'connecting', conversations: [], seen: new Set() };
        const controller = entry.controller = new AbortController();
        entries.set(key, entry);
        entry.run = Promise.resolve().then(() => discover(resolve(cwd), {
          signal: controller.signal,
          output: line => receive(key, entry, controller, line),
        })).then(code => {
          if (code === 0 && !entry.cleanupFailed) { entry.state = 'idle'; delete entry.error; }
          else {
            entry.state = 'error'; entry.error = entry.cleanupFailed ? failedStop : entry.error ?? failed;
          }
        }, () => {
          if (controller.signal.aborted) entry.cleanupFailed = true;
          entry.state = 'error'; entry.error = entry.cleanupFailed ? failedStop : failed;
        }).finally(() => {
          clearTimeout(entry.timer);
          entry.timer = undefined; entry.controller = undefined; entry.run = undefined;
        });
        entry.timer = setTimeout(() => { void stop(key); }, ttlMs);
        entry.timer.unref();
        return copy(entry);
      }
    },
    snapshot(cwd) { return copy(entries.get(directoryKey(cwd))); },
    stop,
    close() {
      closed = true;
      closing ??= Promise.all([...entries.keys()].map(key => stop(key))).then(() => { entries.clear(); });
      return closing;
    },
  };
}
