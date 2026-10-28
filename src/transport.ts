import { open, realpath } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  ApiError, CHUNKED_UPLOAD_MAX_SIZE, MediaFileType, MsgType, QQBot, getMaxUploadSize,
  type QQBotEventMap, type QQBotOptions, type ReplyTarget, type SendMessageOptions,
} from '@tencent-connect/qqbot-nodejs';
import { validateConversation, type Conversation } from './conversations.ts';

export interface ConversationEvent {
  conversation: Conversation;
  messageId: string;
  selfId: string;
  userId: string;
  time: number;
  sender: string;
  rawText: string;
  outgoing: boolean;
  botAuthored?: boolean;
  eventType?: string;
  attachments: Array<Record<string, unknown>>;
  raw: Record<string, unknown>;
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';
export type QQBotSdk = Pick<QQBot, 'on' | 'off' | 'start' | 'stop' | 'send' | 'uploadMedia' | 'api'> & Partial<Pick<QQBot, 'apiClient'>>;
export interface TransportOptions {
  appId: string;
  appSecret: string;
  onMessage(event: ConversationEvent): void | Promise<void>;
  onStatus?(status: ConnectionState): void;
  onError?(error: Error): void;
  connectionTimeoutMs?: number;
  groupMemberEvents?: boolean;
  sdkFactory?: (options: QQBotOptions) => QQBotSdk;
}
export interface SentMessage { messageId: string; raw: Record<string, unknown> }
export type RichMessageInput = Omit<SendMessageOptions, 'target'> & { replyTo?: string };
export type MediaKind = 'image' | 'voice' | 'video' | 'file';
export interface MediaInput { kind: MediaKind; path: string; fileName?: string; text?: string; replyTo?: string }
export const MAX_MEDIA_BYTES = CHUNKED_UPLOAD_MAX_SIZE;
const mediaTypes = { image: MediaFileType.IMAGE, voice: MediaFileType.VOICE, video: MediaFileType.VIDEO, file: MediaFileType.FILE } as const;
export const MEDIA_LIMITS: Readonly<Record<MediaKind, number>> = Object.fromEntries(
  Object.entries(mediaTypes).map(([kind, type]) => [kind, Math.min(CHUNKED_UPLOAD_MAX_SIZE, getMaxUploadSize(type))]),
) as Record<MediaKind, number>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value);
class TransportError extends Error {}
export class QQBotApiError extends Error {
  readonly httpStatus: number;
  readonly bizCode?: number;
  readonly resultUnknown: boolean;
  constructor(message: string, httpStatus: number, bizCode: number | undefined, resultUnknown: boolean) {
    super(message);
    this.name = 'QQBotApiError'; this.httpStatus = httpStatus; this.bizCode = bizCode; this.resultUnknown = resultUnknown;
  }
}

/** Preserve the original platform payload, including nested message elements and future fields. */
export function normalizeMessageEvent(input: unknown, appId: string): ConversationEvent | undefined {
  if (!object(input) || !object(input.raw) || !id(appId) || !id(input.senderId) || !id(input.messageId)) return;
  const eventType = input.rawEventType;
  if (input.kind === 'c2c' ? eventType !== 'C2C_MESSAGE_CREATE'
    : input.kind === 'group' ? !['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(String(eventType)) : true) return;
  const targetId = input.kind === 'group' ? input.groupOpenid : input.senderId;
  if (!id(targetId) || typeof input.timestamp !== 'string') return;
  const timestamp = Date.parse(input.timestamp);
  if (!Number.isFinite(timestamp) || timestamp < 0) return;
  let conversation: Conversation;
  try { conversation = validateConversation({ type: input.kind === 'group' ? 'group' : 'private', id: targetId }); }
  catch { return; }
  const raw = structuredClone(input.raw);
  const attachments = Array.isArray(raw.attachments) ? raw.attachments.filter(object).map(item => structuredClone(item)) : [];
  return {
    conversation, messageId: input.messageId, selfId: appId, userId: input.senderId,
    time: timestamp / 1_000, sender: typeof input.senderName === 'string' && input.senderName ? input.senderName : input.senderId,
    rawText: typeof raw.content === 'string' ? raw.content : typeof input.content === 'string' ? input.content : '',
    outgoing: false, botAuthored: input.senderIsBot === true || (object(raw.author) && raw.author.bot === true),
    eventType: String(eventType), attachments, raw,
  };
}

/** Notice identifiers are namespaced so they cannot be mistaken for replyable chat messages. */
export function normalizePlatformEvent(eventType: string, input: unknown, appId: string): ConversationEvent | undefined {
  if (!object(input) || !id(appId) || !/^[A-Z][A-Z0-9_]{0,79}$/.test(eventType)) return;
  let conversation: Conversation;
  try {
    if (eventType === 'INTERACTION_CREATE') {
      if ((input.scene === undefined || input.scene === 'group') && id(input.group_openid)) conversation = validateConversation({ type: 'group', id: input.group_openid });
      else if (input.scene === 'c2c' && id(input.user_openid)) conversation = validateConversation({ type: 'private', id: input.user_openid });
      else return;
    } else if (eventType.startsWith('GROUP_') && id(input.group_openid)) {
      conversation = validateConversation({ type: 'group', id: input.group_openid });
    } else if (['FRIEND_ADD', 'FRIEND_DEL', 'C2C_MSG_REJECT', 'C2C_MSG_RECEIVE'].includes(eventType)) {
      const peer = input.user_openid ?? input.openid;
      if (!id(peer)) return;
      conversation = validateConversation({ type: 'private', id: peer });
    } else return;
  } catch { return; }
  const actualId = eventType === 'GROUP_JOIN_REQUEST' ? input.join_request_id : input.id ?? input.event_id;
  const stable = id(actualId) ? actualId : undefined;
  let messageId = `event:${eventType}:${stable ?? randomUUID()}`;
  if (messageId.length > 512) messageId = `event:${eventType}:sha256:${createHash('sha256').update(stable!).digest('hex')}`;
  const actor = [input.member_openid, input.group_member_openid, input.op_member_openid, input.user_openid, input.openid].find(id);
  const raw = structuredClone(input);
  const parsedTime = typeof input.timestamp === 'number' ? input.timestamp
    : typeof (input.apply_at ?? input.timestamp) === 'string' ? Date.parse(String(input.apply_at ?? input.timestamp)) / 1_000 : Number.NaN;
  return {
    conversation, messageId, selfId: appId, userId: actor ?? appId,
    time: Number.isFinite(parsedTime) && parsedTime >= 0 ? parsedTime : Date.now() / 1_000,
    sender: typeof input.username === 'string' && input.username ? input.username : actor ?? 'QQ 平台',
    rawText: typeof input.content === 'string' ? input.content : `[QQ 平台事件 ${eventType}]`,
    outgoing: false, eventType, raw,
    attachments: Array.isArray(input.attachments) ? input.attachments.filter(object).map(item => structuredClone(item)) : [],
  };
}

function targetFor(input: Conversation, replyTo?: string): ReplyTarget {
  const conversation = validateConversation(input);
  if (conversation.type !== 'group' && conversation.type !== 'private') throw new TransportError('官方机器人仅支持已配置的群聊和机器人单聊。');
  if (replyTo !== undefined && !id(replyTo)) throw new TransportError('replyTo 须为有效的官方消息 ID 字符串。');
  return { scope: conversation.type === 'group' ? 'group' : 'c2c', targetId: encodeURIComponent(conversation.id),
    ...(replyTo === undefined ? {} : { msgId: replyTo }) };
}

function textValue(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > 4_500 || value.includes('\0')) {
    throw new TransportError('文字须为最多 4500 个字符的有效文本。');
  }
  return value;
}

function safeFailure(error: unknown, operation: string, uncertain: boolean): Error {
  if (error instanceof ApiError) {
    const business = Number.isSafeInteger(error.bizCode) ? `，业务码 ${error.bizCode}` : '';
    const permission = error.httpStatus === 403 || error.bizCode === 11253 || error.bizCode === 11282;
    const rejected = permission || (error.httpStatus >= 400 && error.httpStatus < 500)
      || (Number.isSafeInteger(error.bizCode) && error.bizCode !== 0);
    const message = rejected
      ? `QQ 机器人接口拒绝${operation}（HTTP ${error.httpStatus}${business}）${permission ? '：机器人未获得该能力或操作权限，请检查平台能力和目标群权限。' : '，未自动重试。'}`
      : uncertain ? `${operation}结果未知（HTTP ${error.httpStatus}${business}），请先确认目标对话；未自动重发。` : `${operation}失败（HTTP ${error.httpStatus}${business}），本次尚未发送 QQ 消息。`;
    return new QQBotApiError(message, error.httpStatus, Number.isSafeInteger(error.bizCode) ? error.bizCode : undefined, uncertain && !rejected);
  }
  return new TransportError(uncertain ? `${operation}结果未知，请先确认目标对话；未自动重发。` : `${operation}失败，本次尚未发送 QQ 消息。`);
}

function connectionFailure(error: unknown, fallback: string): Error {
  let cause = error;
  for (let depth = 0; depth < 4; depth++) {
    if (cause instanceof ApiError) {
      const code = Number.isSafeInteger(cause.bizCode) ? cause.bizCode : undefined;
      const status = Number.isInteger(cause.httpStatus) && cause.httpStatus >= 0 && cause.httpStatus <= 599 ? cause.httpStatus : 0;
      return new QQBotApiError(`QQ 机器人连接失败（HTTP ${status}${code === undefined ? '' : `，业务码 ${code}`}），请检查机器人配置与平台状态。`, status, code, false);
    }
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return new TransportError(fallback);
}

function checkBusinessResult(value: unknown): void {
  if (!object(value)) return;
  for (const field of ['err_code', 'code']) {
    const raw = value[field];
    if (raw === undefined) continue;
    const code = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : undefined;
    if (Number.isSafeInteger(code) && code !== 0) throw new ApiError('QQ business request rejected', 200, '', code);
  }
}

function allowsEmptySuccess(method: string, path: string): boolean {
  return (method === 'DELETE' && (/^\/v2\/(?:groups|users)\/[^/?#]+\/messages\/[^/?#]+$/.test(path)
    || /^\/v2\/groups\/join_approval_strategy\/[^/?#]+$/.test(path)))
    || (method === 'POST' && /^\/v2\/groups\/join_approval_strategy\/[^/?#]+\/execute$/.test(path));
}

/** SDK 1.0.5 discards failed JSON bodies; inspect these documented empty-success responses directly. */
async function requestAllowingEmpty(token: string, method: string, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  try {
    const response = await fetch(`https://api.bot.qq.com${path}`, {
      method, headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'PiQ-Harness/0.1.0' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    const raw = await response.text();
    if ((response.status === 200 || response.status === 204) && raw === '') return null;
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new ApiError('Invalid QQ response body', response.status, path); }
    if (!response.ok) {
      let code: number | undefined;
      try { checkBusinessResult(value); }
      catch (error) { if (error instanceof ApiError) code = error.bizCode; }
      throw new ApiError('QQ request rejected', response.status, path, code);
    }
    checkBusinessResult(value);
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('QQ request interrupted', 0, path);
  }
}

function waitFor<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new TransportError('操作已取消。'));
    signal.addEventListener('abort', aborted, { once: true });
    let operation: Promise<T>;
    try { operation = start(); }
    catch (error) { signal.removeEventListener('abort', aborted); reject(error); return; }
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
}

/** The SDK owns token refresh, WebSocket authentication, heartbeat and reconnect. */
export class QQBotTransport {
  private readonly options: TransportOptions;
  private readonly sdk: QQBotSdk;
  private readonly shutdown = new AbortController();
  private readonly timeoutMs: number;
  private readonly waiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  private readonly listeners: Array<() => void> = [];
  private readonly sentIds = new Set<string>();
  private readonly requestSignals = new AsyncLocalStorage<AbortSignal>();
  private readonly uploadNames = new AsyncLocalStorage<{ path: string; fileName: string }>();
  private status: ConnectionState = 'disconnected';
  private connected = false;
  private started = false;
  private closed = false;
  private terminalError?: Error;

  constructor(options: TransportOptions) {
    if (!id(options.appId) || typeof options.appSecret !== 'string' || !options.appSecret.trim()) throw new TransportError('请配置 QQ 机器人 AppID 和 AppSecret 环境变量。');
    this.options = options;
    this.timeoutMs = options.connectionTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) throw new TransportError('连接超时须为 1 到 300000 毫秒。');
    this.sdk = (options.sdkFactory ?? (settings => new QQBot(settings)))({
      appId: options.appId, appSecret: options.appSecret, transport: 'websocket',
      baseUrl: 'https://api.bot.qq.com', tokenBaseUrl: 'https://bots.qq.com',
      userAgent: 'PiQ-Harness/0.1.0',
      intents: (1 << 25) | (1 << 26) | (options.groupMemberEvents ? 1 << 24 : 0),
    });
    // The public SDK has no per-send AbortSignal. Recheck before each REST call,
    // including calls delayed by token refresh or an SDK upload retry.
    if (this.sdk.apiClient) {
      const client = this.sdk.apiClient;
      const original = client.request.bind(client);
      client.request = ((...args: Parameters<QQBot['apiClient']['request']>) => {
        this.shutdown.signal.throwIfAborted();
        const active = this.requestSignals.getStore() ?? this.shutdown.signal;
        active.throwIfAborted();
        const [token, method, path, body] = args;
        if (allowsEmptySuccess(method, path)) return requestAllowingEmpty(token, method, path, body, active);
        const upload = this.uploadNames.getStore();
        // Current QQ binary and chunk-completion uploads require file_name for every media kind.
        if (upload && method === 'POST' && path === upload.path && object(body)
          && (typeof body.file_data === 'string' || typeof body.upload_id === 'string') && body.file_name === undefined) {
          args[3] = { ...body, file_name: upload.fileName };
        }
        return original(...args);
      }) as QQBot['apiClient']['request'];
    }
    this.listen('ready', () => this.ready());
    this.listen('resumed', () => this.ready());
    this.listen('disconnected', event => {
      if (this.closed) return;
      this.connected = false;
      this.updateStatus(event.willReconnect ? 'disconnected' : 'error');
      if (!event.willReconnect) this.failRun(new TransportError('QQ 机器人连接已停止，请检查凭据和平台权限后重新打开会话。'));
    });
    this.listen('error', error => {
      if (!this.closed && !this.connected) this.updateStatus('error');
      this.report(connectionFailure(error, 'QQ 机器人网关暂时异常；请检查连接与平台权限。'));
    });
    this.listen('message', async (_ctx, message) => {
      if (this.closed) return;
      const event = normalizeMessageEvent(message, options.appId);
      if (!event) return;
      const scope = event.conversation.type === 'group' ? 'group' : 'c2c';
      if (this.sentIds.has(JSON.stringify([scope, encodeURIComponent(event.conversation.id), event.messageId]))) event.outgoing = true;
      try { await options.onMessage(event); }
      catch { this.report(new TransportError('QQ 消息已收到，但本地处理失败；请检查对话日志和目录权限。')); }
    });
    this.listen('rawEvent', async ctx => {
      if (this.closed) return;
      const event = normalizePlatformEvent(ctx.eventType, ctx.data, options.appId);
      if (!event) return;
      try { await options.onMessage(event); }
      catch { this.report(new TransportError('QQ 事件已收到，但本地记录失败。')); }
    });
    this.listen('interaction', async (_ctx, data) => {
      if (this.closed) return;
      const event = normalizePlatformEvent('INTERACTION_CREATE', data, options.appId);
      let code = 3;
      if (event) {
        try { await options.onMessage(event); code = 0; }
        catch { this.report(new TransportError('QQ 互动事件已收到，但本地记录失败。')); }
      }
      // QQ requires replies only for buttons and menus. Other types include
      // authorization queries and clear-session notices; acknowledging those
      // can falsely confirm an action we have not performed.
      // Never evaluate or execute button_data.
      if (!this.closed && (data.type === 11 || data.type === 12) && id(data.id)) {
        try { await this.request('PUT', `/interactions/${encodeURIComponent(data.id)}`, { code }); }
        catch { if (!this.closed) this.report(new TransportError('QQ 互动事件的平台接收确认失败；未自动重试。')); }
      }
    });
  }

  private listen<K extends keyof QQBotEventMap>(event: K, listener: QQBotEventMap[K]): void {
    this.sdk.on(event, listener);
    this.listeners.push(() => { this.sdk.off(event, listener); });
  }

  private report(error: Error): void { try { this.options.onError?.(error); } catch { /* Diagnostics cannot interrupt transport. */ } }
  private updateStatus(status: ConnectionState): void {
    if (this.status === status) return;
    this.status = status;
    try { this.options.onStatus?.(status); } catch { /* Status observers do not own the connection. */ }
  }
  private ready(): void {
    if (this.closed) return;
    this.connected = true;
    this.updateStatus('connected');
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
  }
  private failRun(error: Error): void {
    if (this.closed) return;
    this.connected = false;
    this.terminalError = error;
    this.updateStatus('error');
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
    this.report(error);
  }
  private ensureStarted(): void {
    if (this.closed) throw new TransportError('QQ 机器人连接已关闭。');
    if (this.terminalError) throw this.terminalError;
    if (this.started) return;
    this.started = true;
    this.updateStatus('connecting');
    void Promise.resolve().then(() => {
      if (this.closed) return;
      return this.sdk.start(this.shutdown.signal);
    }).then(() => {
      if (!this.closed) this.failRun(new TransportError('QQ 机器人网关已结束，请重新打开会话。'));
    }, error => this.failRun(connectionFailure(error, 'QQ 机器人启动或连接失败，请检查 AppID、AppSecret 和平台权限。')));
  }

  get isConnected(): boolean { return this.connected && !this.closed; }
  connect(): Promise<void> { return this.waitUntilConnected(this.shutdown.signal); }

  private async waitUntilConnected(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.ensureStarted();
    if (this.isConnected) return;
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        this.waiters.delete(waiter);
        if (error) reject(error); else resolve();
      };
      const waiter = { resolve: () => finish(), reject: (error: Error) => finish(error) };
      const aborted = () => finish(new TransportError('等待 QQ 连接已取消。'));
      const timer = setTimeout(() => finish(new TransportError('等待 QQ 机器人连接超时，请检查网络和凭据。')), this.timeoutMs);
      this.waiters.add(waiter);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.shutdown.abort();
    for (const remove of this.listeners) remove();
    this.listeners.length = 0;
    try { this.sdk.stop(); } finally { this.updateStatus('disconnected'); }
  }

  private signal(signal?: AbortSignal): AbortSignal {
    const active = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    active.throwIfAborted();
    return active;
  }

  private async dispatch(message: SendMessageOptions, signal: AbortSignal): Promise<SentMessage> {
    signal.throwIfAborted();
    let value: unknown;
    try {
      value = await this.requestSignals.run(signal, () => waitFor(() => this.sdk.send(message), signal));
      checkBusinessResult(value);
    }
    catch (error) { throw safeFailure(error, '消息发送', true); }
    if (!object(value) || !id(value.id)) throw new TransportError('QQ 消息发送回执无效，结果未知；请检查目标对话，未自动重发。');
    this.sentIds.add(JSON.stringify([message.target.scope, message.target.targetId, value.id]));
    if (this.sentIds.size > 10_000) this.sentIds.delete(this.sentIds.values().next().value!);
    return { messageId: value.id, raw: structuredClone(value) };
  }

  async send(conversation: Conversation, input: { text?: string; images?: string[]; replyTo?: string }, signal?: AbortSignal): Promise<SentMessage> {
    const target = targetFor(conversation, input.replyTo);
    if (input.images !== undefined && (!Array.isArray(input.images) || input.images.length > 1)) throw new TransportError('每次最多发送一张图片，请分次调用。');
    const images = input.images ?? [];
    const content = textValue(input.text, images.length === 0);
    if (images.length) return this.sendMedia(conversation, { kind: 'image', path: images[0]!, text: content, replyTo: input.replyTo }, signal);
    const active = this.signal(signal);
    await this.waitUntilConnected(active);
    return this.dispatch({ target, msgType: MsgType.TEXT, content }, active);
  }

  async sendRich(conversation: Conversation, input: RichMessageInput, signal?: AbortSignal): Promise<SentMessage> {
    const { replyTo, ...message } = input;
    const target = targetFor(conversation, replyTo);
    textValue(message.content, false);
    const active = this.signal(signal);
    await this.waitUntilConnected(active);
    return this.dispatch({ ...message, target }, active);
  }

  async sendMedia(conversation: Conversation, input: MediaInput, signal?: AbortSignal): Promise<SentMessage> {
    const target = targetFor(conversation, input.replyTo);
    if (!Object.hasOwn(mediaTypes, input.kind)) throw new TransportError('媒体类型须为 image、voice、video 或 file。');
    if (typeof input.path !== 'string' || !input.path.trim() || /[\x00-\x1f\x7f]/.test(input.path)) throw new TransportError('请提供有效的本地媒体文件路径。');
    if (input.kind === 'voice' && !['.wav', '.mp3', '.silk'].includes(extname(input.path).toLowerCase())) {
      throw new TransportError('语音仅支持 WAV、MP3、SILK；其他格式请先转换或作为普通文件发送。');
    }
    const fileName = input.fileName ?? basename(input.path);
    if (!fileName.trim() || fileName.length > 255 || /[\\/\x00-\x1f\x7f]/.test(fileName)) throw new TransportError('文件名须为不含路径分隔符的有效名称。');
    const content = textValue(input.text, false);
    const active = this.signal(signal);
    const maxBytes = MEDIA_LIMITS[input.kind];
    let buffer: Buffer;
    try {
      const handle = await open(await realpath(input.path), 'r');
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size < 1 || before.size > maxBytes) throw new TransportError(`媒体须为非空普通文件，${input.kind} 上限 ${maxBytes / 1024 / 1024} MiB。`);
        buffer = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < buffer.length) {
          active.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) throw new TransportError('媒体文件读取期间发生变化，请重试。');
          offset += bytesRead;
        }
        const after = await handle.stat();
        if (after.size !== buffer.length || buffer.byteLength > maxBytes) throw new TransportError('媒体文件读取期间发生变化或超出大小上限。');
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof TransportError) throw error;
      throw new TransportError(active.aborted ? '媒体读取已取消，尚未发送。' : '无法读取本地媒体文件，尚未发送。');
    }
    await this.waitUntilConnected(active);
    let upload: unknown;
    try {
      upload = await this.uploadNames.run({ path: `/v2/${target.scope === 'group' ? 'groups' : 'users'}/${target.targetId}/files`, fileName },
        () => this.requestSignals.run(active, () => waitFor(() => this.sdk.uploadMedia({ target, fileType: mediaTypes[input.kind], buffer, fileName, srvSendMsg: false }), active)));
      checkBusinessResult(upload);
    }
    catch (error) { throw safeFailure(error, '媒体上传', false); }
    active.throwIfAborted();
    if (!object(upload) || typeof upload.file_info !== 'string' || !upload.file_info) throw new TransportError('媒体上传回执无效，尚未发送 QQ 消息。');
    return this.dispatch({ target, msgType: MsgType.MEDIA, media: { file_info: upload.file_info }, ...(content === undefined ? {} : { content }) }, active);
  }

  /** Internal fixed-host REST access for explicit official capabilities, never a model-facing URL tool. */
  async request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || typeof path !== 'string' || !path.startsWith('/')
      || path.startsWith('//') || /[\\\x00-\x20\x7f]/.test(path) || path.split(/[/?#]/).some(part => part === '..')) throw new TransportError('官方 API 路径无效。');
    const active = this.signal(signal);
    await this.waitUntilConnected(active);
    let operation: () => Promise<unknown>;
    if (method === 'GET') {
      if (body !== undefined && (!object(body) || Object.values(body).some(value => !['string', 'number', 'boolean'].includes(typeof value)))) throw new TransportError('GET 查询参数无效。');
      operation = () => this.sdk.api.get(path, body as Record<string, string | number | boolean> | undefined);
    } else if (method === 'DELETE') operation = () => this.sdk.api.delete(path);
    else if (method === 'POST') operation = () => this.sdk.api.post(path, body);
    else if (method === 'PUT') operation = () => this.sdk.api.put(path, body);
    else operation = () => this.sdk.api.patch(path, body);
    try {
      const result = await this.requestSignals.run(active, () => waitFor(operation, active));
      checkBusinessResult(result);
      return result;
    } catch (error) {
      // SDK 1.0.5 parses every successful body as JSON, including valid HTTP 204.
      if (error instanceof ApiError && error.httpStatus === 204) return null;
      throw safeFailure(error, '官方接口请求', method !== 'GET');
    }
  }
}
