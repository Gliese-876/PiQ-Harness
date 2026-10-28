import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SendMessageOptions } from '@tencent-connect/qqbot-nodejs';
import { getNextMsgSeq } from '@tencent-connect/qqbot-nodejs/protocol';
import { Type } from 'typebox';
import { conversationKey, type Conversation } from './conversations.ts';
import type { StoredMessage } from './store.ts';

type RichInput = Pick<SendMessageOptions, 'content' | 'markdown' | 'ark' | 'embed' | 'keyboard' | 'messageReference'> & { replyTo?: string };
export interface OfficialToolContext {
  cwd: string;
  conversation: Conversation;
  signal: AbortSignal;
  transport: {
    request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<unknown>;
    sendRich(conversation: Conversation, input: RichInput, signal?: AbortSignal): Promise<{ messageId: string; raw: Record<string, unknown> }>;
  };
  ownsSent(messageId: string): Promise<boolean>;
  findMessage(messageId: string): Promise<StoredMessage | undefined>;
  findEvent(eventId: string): Promise<StoredMessage | undefined>;
  rememberSent(result: { messageId: string; text: string; kind?: string; raw?: Record<string, unknown> }): Promise<void>;
}
export type ResolveOfficialContext = (ctx: ExtensionContext, conversation: string, signal?: AbortSignal) => OfficialToolContext;
class ToolError extends Error {}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value);
const sameDirectory = (a: string, b: string) => process.platform === 'win32' ? resolvePath(a).toLowerCase() === resolvePath(b).toLowerCase() : resolvePath(a) === resolvePath(b);
const idSchema = Type.String({ minLength: 1, maxLength: 512, pattern: '^\\S+$' });
const textSchema = Type.String({ maxLength: 4_500 });
const markdownSchema = Type.Object({ content: Type.Optional(textSchema), custom_template_id: Type.Optional(idSchema),
  params: Type.Optional(Type.Array(Type.Object({ key: Type.String(), values: Type.Array(Type.String()) }, { additionalProperties: false }))) }, { additionalProperties: false });
const arkSchema = Type.Object({ template_id: Type.Integer({ minimum: 1 }), kv: Type.Array(Type.Object({ key: Type.String(), value: Type.Optional(Type.String()),
  obj: Type.Optional(Type.Array(Type.Unknown())) }, { additionalProperties: false })) }, { additionalProperties: false });
const keyboardSchema = Type.Object({ content: Type.Object({ rows: Type.Array(Type.Object({ buttons: Type.Array(Type.Object({ id: Type.String(),
  render_data: Type.Object({ label: Type.String(), visited_label: Type.String(), style: Type.Integer() }, { additionalProperties: false }),
  action: Type.Object({ type: Type.Integer(), permission: Type.Object({ type: Type.Integer() }, { additionalProperties: false }),
    data: Type.String(), click_limit: Type.Optional(Type.Integer()) }, { additionalProperties: false }), group_id: Type.Optional(Type.String()) }, { additionalProperties: false })) }, { additionalProperties: false })) }, { additionalProperties: false }) }, { additionalProperties: false });

function keys(value: object, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ToolError('工具参数含未支持字段。');
}
function text(value: unknown, required = true): string {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > 4_500 || value.includes('\0')) throw new ToolError('文字须为最多 4500 个字符的有效文本。');
  return value;
}
function identifier(value: unknown, name: string): string {
  if (!validId(value) || value.startsWith('event:')) throw new ToolError(`${name} 须为有效的官方标识字符串，不能使用本地 event: 通知标识。`);
  return value;
}
function boundedJson(value: unknown, depth = 0): void {
  if (depth > 10) throw new ToolError('富消息内容嵌套过深。');
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value === 'string') { if (value.length > 8_192 || value.includes('\0')) throw new ToolError('富消息字段过长或含无效字符。'); return; }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new ToolError('富消息数组最多 100 项。');
    for (const item of value) boundedJson(item, depth + 1);
    return;
  }
  if (!object(value) || Object.keys(value).length > 64 || Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key) || key.length > 128)) throw new ToolError('富消息对象无效。');
  for (const item of Object.values(value)) boundedJson(item, depth + 1);
}
function failed(error: unknown): never {
  if (error instanceof ToolError) throw error;
  // Transport errors are sanitized already; retain only numeric platform status.
  const status = error instanceof Error ? /HTTP (\d{3})(?:，业务码 (\d+))?/.exec(error.message) : undefined;
  throw new ToolError(`QQ 官方操作失败或结果未知${status ? `（HTTP ${status[1]}${status[2] ? `，业务码 ${status[2]}` : ''}）` : ''}；请检查平台权限及目标对话后再决定是否重试，未自动重发。`);
}
function output(details: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }], details };
}
async function remember(bound: OfficialToolContext, result: { messageId: string; text: string; kind?: string; raw?: Record<string, unknown> }): Promise<string | undefined> {
  try { await bound.rememberSent(result); return; }
  catch { return '平台已确认发送，但本地记录保存失败；请勿为补记日志而重发。'; }
}
function messageReceipt(value: unknown): string {
  if (!object(value) || !validId(value.id) || value.id.startsWith('event:')) throw new ToolError('官方消息回执无效，发送结果未知；请检查目标对话，未自动重发。');
  return value.id;
}
function messagePath(bound: OfficialToolContext): string {
  return `/v2/${bound.conversation.type === 'group' ? 'groups' : 'users'}/${encodeURIComponent(bound.conversation.id)}/messages`;
}
function privateOnly(bound: OfficialToolContext): void {
  if (bound.conversation.type !== 'private') throw new ToolError('此功能仅支持官方机器人单聊（private）。');
}
async function observed(bound: OfficialToolContext, messageId: string, incoming: boolean): Promise<StoredMessage> {
  identifier(messageId, 'messageId');
  let record: StoredMessage | undefined;
  try { record = await bound.findMessage(messageId); } catch (error) { failed(error); }
  if (!record || record.messageId !== messageId || (incoming && record.outgoing)
    || (!record.outgoing && record.eventType !== undefined && !['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(record.eventType))
    || conversationKey(record.conversation) !== conversationKey(bound.conversation)) throw new ToolError('找不到当前对话中符合条件的真实已保存消息。');
  return record;
}

interface Stream {
  id: string;
  bound: OfficialToolContext;
  controller: AbortController;
  signal: AbortSignal;
  anchor: { msg_id?: string; event_id?: string; is_wakeup?: true };
  mode: 'append' | 'replace';
  contentType: 'text' | 'markdown';
  sequence: number;
  index: number;
  messageId?: string;
  confirmedText: string;
  receipt?: Record<string, unknown>;
  tail: Promise<unknown>;
  cancellation?: Promise<string | undefined>;
  removeAbort(): void;
}

/** Explicit tools only. Ordinary assistant output never starts or updates a stream. */
export function registerOfficialTools(pi: ExtensionAPI, resolve: ResolveOfficialContext) {
  const streams = new Map<string, Stream>();
  const pendingLogs = new Set<Promise<string | undefined>>();
  let epoch = 0;
  function remove(stream: Stream): void {
    streams.delete(stream.id); stream.removeAbort(); stream.controller.abort();
  }
  function cancel(stream: Stream): Promise<string | undefined> {
    if (stream.cancellation) return stream.cancellation;
    remove(stream);
    const saved = stream.cancellation = stream.messageId
      ? remember(stream.bound, { messageId: stream.messageId, text: stream.confirmedText, kind: 'stream', raw: stream.receipt }) : Promise.resolve(undefined);
    pendingLogs.add(saved);
    void saved.finally(() => pendingLogs.delete(saved));
    return saved;
  }
  function cancelOutstanding(): Promise<void> {
    epoch++;
    for (const stream of [...streams.values()]) void cancel(stream);
    return Promise.allSettled([...pendingLogs]).then(() => {});
  }
  function active(stream: Stream, bound: OfficialToolContext): void {
    if (streams.get(stream.id) !== stream || stream.signal.aborted || bound.signal.aborted) throw new ToolError('流式会话已取消或关闭；不会发送后续分片。');
    if (!sameDirectory(stream.bound.cwd, bound.cwd) || stream.bound.transport !== bound.transport
      || conversationKey(stream.bound.conversation) !== conversationKey(bound.conversation)) throw new ToolError('流式会话不属于当前对话或当前 Pi 实例。');
  }
  async function frame(stream: Stream, bound: OfficialToolContext, value: string | undefined, done: boolean) {
    active(stream, bound);
    const content = value === undefined ? (stream.mode === 'replace' ? stream.confirmedText : '') : text(value, !done);
    if (stream.mode === 'replace' && !content.startsWith(stream.confirmedText)) throw new ToolError('replace 的全量正文须保留已确认发送的前缀。');
    const completeText = stream.mode === 'replace' ? content : stream.confirmedText + content;
    if (completeText.length > 4_500) throw new ToolError('单条流式消息最多 4500 个字符。');
    const body = { input_mode: stream.mode, input_state: done ? 10 : 1, index: stream.index,
      content_type: stream.contentType, content_raw: content, ...stream.anchor, msg_seq: stream.sequence,
      ...(stream.messageId ? { stream_msg_id: stream.messageId } : {}) };
    let response: unknown;
    try {
      response = await bound.transport.request('POST', `/v2/users/${encodeURIComponent(bound.conversation.id)}/stream_messages`, body,
        AbortSignal.any([bound.signal, stream.signal]));
    } catch (error) { await cancel(stream); failed(error); }
    // Cancellation may have arrived while the request was already in flight.
    if (stream.signal.aborted || bound.signal.aborted) throw new ToolError('流式发送在派发后被取消，结果未知；不会发送后续分片或自动重发。');
    let messageId: string;
    try { messageId = messageReceipt(response); }
    catch (error) { await cancel(stream); throw error; }
    if (stream.messageId && messageId !== stream.messageId) { await cancel(stream); throw new ToolError('流式回执标识发生变化，结果未知；已停止后续发送。'); }
    stream.messageId = messageId; stream.confirmedText = completeText; stream.receipt = structuredClone(response as Record<string, unknown>); stream.index++;
    const warning = done ? await cancel(stream) : undefined;
    return output({ streamId: stream.id, messageId, state: done ? 'completed' : 'generating', index: body.index,
      ...(object(response) && Number.isSafeInteger(response.remain_msg_len) ? { remainingCharacters: response.remain_msg_len } : {}), ...(warning ? { warning } : {}) });
  }

  pi.registerTool({
    name: 'qq_recall', label: '撤回官方 QQ 消息',
    description: '显式撤回当前对话的真实消息。默认仅允许本组已确认由 Pi 发出的消息；moderate=true 仅群聊，可撤回本组日志中真实收到的成员消息，管理员权限和时间窗口由腾讯平台判断。',
    parameters: Type.Object({ conversation: Type.String(), messageId: idSchema, moderate: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      keys(params, ['conversation', 'messageId', 'moderate']);
      const bound = resolve(ctx, params.conversation, signal);
      const messageId = identifier(params.messageId, 'messageId');
      if (params.moderate !== undefined && typeof params.moderate !== 'boolean') throw new ToolError('moderate 须为布尔值。');
      try {
        if (params.moderate) {
          if (bound.conversation.type !== 'group') throw new ToolError('管理员撤回只支持群聊。');
          await observed(bound, messageId, true);
        } else if (!(await bound.ownsSent(messageId)) && ![...streams.values()].some(stream => stream.messageId === messageId
          && sameDirectory(stream.bound.cwd, bound.cwd) && stream.bound.transport === bound.transport
          && conversationKey(stream.bound.conversation) === conversationKey(bound.conversation))) {
          throw new ToolError('只允许撤回本组在当前对话中已确认由 Pi 发出的消息。');
        }
        // Fence every matching stream synchronously before DELETE can yield.
        // A concurrent complete must never recreate content while recall waits.
        const cancelling = [...streams.values()].filter(stream => stream.messageId === messageId && stream.bound.transport === bound.transport
            && sameDirectory(stream.bound.cwd, bound.cwd)
            && conversationKey(stream.bound.conversation) === conversationKey(bound.conversation)).map(stream => cancel(stream));
        await Promise.all(cancelling);
        bound.signal.throwIfAborted();
        await bound.transport.request('DELETE', `${messagePath(bound)}/${encodeURIComponent(messageId)}`, undefined, bound.signal);
        return output({ conversation: conversationKey(bound.conversation), messageId, recalled: true, moderate: params.moderate === true });
      } catch (error) { failed(error); }
    },
  });

  pi.registerTool({
    name: 'qq_send_rich', label: '发送官方 QQ 富消息',
    description: '向本组明确目标发送腾讯官方 SDK 支持的 markdown、ark、embed 或带 keyboard 的文字消息。平台权限决定可用类型；每次选择一种主体。quoteMessageId 指定本组真实消息，工具从其原始记录取得引用索引；replyTo 是被动回复的入站消息ID。仅显式调用发送，不开放任意 API 地址或 extra 字段。',
    parameters: Type.Object({ conversation: Type.String(), content: Type.Optional(textSchema), replyTo: Type.Optional(idSchema),
      markdown: Type.Optional(markdownSchema), ark: Type.Optional(arkSchema), embed: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      keyboard: Type.Optional(keyboardSchema), quoteMessageId: Type.Optional(idSchema) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      keys(params, ['conversation', 'content', 'replyTo', 'markdown', 'ark', 'embed', 'keyboard', 'quoteMessageId']);
      const bound = resolve(ctx, params.conversation, signal);
      const { conversation: _conversation, quoteMessageId, ...input } = params;
      boundedJson(input);
      if (Buffer.byteLength(JSON.stringify(input)) > 32_768) throw new ToolError('富消息参数最多 32 KiB。');
      if (input.replyTo !== undefined) identifier(input.replyTo, 'replyTo');
      if (input.content !== undefined) text(input.content, false);
      const bodies = [input.markdown, input.ark, input.embed].filter(value => value !== undefined);
      if (bodies.length > 1 || (!bodies.length && !(input.keyboard && input.content?.trim()))) throw new ToolError('请选择一种 markdown、ark、embed 主体，或提供带 keyboard 的文字。');
      if (input.markdown) {
        keys(input.markdown, ['content', 'custom_template_id', 'params']);
        if (!input.markdown.content?.trim() && !input.markdown.custom_template_id) throw new ToolError('markdown 需要正文或 custom_template_id。');
        input.markdown.content ??= '';
      }
      try {
        if (input.replyTo !== undefined) await observed(bound, input.replyTo, true);
        let messageReference: RichInput['messageReference'];
        if (quoteMessageId !== undefined) {
          const record = await observed(bound, identifier(quoteMessageId, 'quoteMessageId'), false);
          const raw = record.raw;
          const scene = object(raw?.message_scene) ? raw.message_scene : undefined;
          const sentExt = object(raw?.ext_info) ? raw.ext_info : undefined;
          let reference: unknown;
          if (record.outgoing) reference = sentExt?.ref_idx;
          else if (Array.isArray(scene?.ext) && scene.ext.every(item => typeof item === 'string')) {
            const indexes = scene.ext.filter(item => item.startsWith('msg_idx='));
            if (indexes.length > 1) throw new ToolError('该消息包含重复或冲突的官方引用索引，无法确定引用目标。');
            reference = indexes[0]?.slice('msg_idx='.length);
          }
          if (!validId(reference) || reference.startsWith('event:')) throw new ToolError('该消息的本地记录缺少官方引用索引 REFIDX，无法引用。');
          messageReference = { message_id: reference };
        }
        bound.signal.throwIfAborted();
        const sent = await bound.transport.sendRich(bound.conversation, { ...input, ...(messageReference ? { messageReference } : {}) } as RichInput, bound.signal);
        const warning = await remember(bound, { messageId: sent.messageId,
          text: input.markdown?.content || input.content || (input.ark ? '[ARK消息]' : '[Embed消息]'), kind: 'rich', raw: sent.raw });
        return output({ conversation: conversationKey(bound.conversation), messageId: sent.messageId, ...(warning ? { warning } : {}) });
      } catch (error) { failed(error); }
    },
  });

  pi.registerTool({
    name: 'qq_stream', label: '官方 QQ 单聊流式消息',
    description: '显式发送单聊流式分片。create 发送首片并返回 streamId；update/complete/cancel 必须使用同一 conversation 和 streamId。create 指定 text、contentType(text/markdown)、inputMode(replace/append)，replyTo 与 eventId 二选一；wakeup=true 时不带这两个锚点且需平台召回权限。replace 每次提供保留已发前缀的全量正文；append 提供新增文字。complete 发送结束帧，cancel 仅停止后续分片，不撤回已显示内容。暂停/关会话自动取消，不转发普通回答。',
    parameters: Type.Object({ action: Type.Union(['create', 'update', 'complete', 'cancel'].map(value => Type.Literal(value))),
      conversation: Type.String(), streamId: Type.Optional(idSchema), text: Type.Optional(textSchema),
      replyTo: Type.Optional(idSchema), eventId: Type.Optional(idSchema), wakeup: Type.Optional(Type.Boolean()),
      inputMode: Type.Optional(Type.Union([Type.Literal('replace'), Type.Literal('append')])),
      contentType: Type.Optional(Type.Union([Type.Literal('text'), Type.Literal('markdown')])) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      keys(params, ['action', 'conversation', 'streamId', 'text', 'replyTo', 'eventId', 'wakeup', 'inputMode', 'contentType']);
      const bound = resolve(ctx, params.conversation, signal); privateOnly(bound);
      if (params.inputMode !== undefined && !['append', 'replace'].includes(params.inputMode)) throw new ToolError('inputMode 须为 append 或 replace。');
      if (params.contentType !== undefined && !['text', 'markdown'].includes(params.contentType)) throw new ToolError('contentType 须为 text 或 markdown。');
      if (params.wakeup !== undefined && typeof params.wakeup !== 'boolean') throw new ToolError('wakeup 须为布尔值。');
      if (params.action === 'create') {
        if (params.streamId !== undefined) throw new ToolError('create 不接受已有 streamId。');
        if (streams.size >= 16) throw new ToolError('请先完成或取消已有流式会话（最多 16 个）。');
        if (params.wakeup ? params.replyTo !== undefined || params.eventId !== undefined : Number(params.replyTo !== undefined) + Number(params.eventId !== undefined) !== 1) throw new ToolError('普通流须提供 replyTo 或 eventId 中的一项；wakeup 流不接受这两个锚点。');
        const content = text(params.text);
        const generation = epoch;
        if (params.replyTo !== undefined) {
          await observed(bound, params.replyTo, true);
        }
        if (params.eventId !== undefined) {
          identifier(params.eventId, 'eventId');
          let original: StoredMessage | undefined;
          try { original = await bound.findEvent(params.eventId); } catch (error) { failed(error); }
          const eventType = original?.eventType ?? original?.raw?.eventType;
          if (!original || original.outgoing || conversationKey(original.conversation) !== conversationKey(bound.conversation)
            || eventType !== 'INTERACTION_CREATE'
            || (original.raw?.id !== params.eventId && original.raw?.event_id !== params.eventId)) {
            throw new ToolError('eventId 必须是当前单聊真实已保存且支持回复的官方交互事件。');
          }
        }
        if (generation !== epoch || bound.signal.aborted) throw new ToolError('会话已暂停或关闭，流式消息尚未发送。');
        if (streams.size >= 16) throw new ToolError('请先完成或取消已有流式会话（最多 16 个）。');
        const controller = new AbortController();
        const stream: Stream = { id: randomUUID(), bound, controller, signal: AbortSignal.any([bound.signal, controller.signal]),
          anchor: params.wakeup ? { is_wakeup: true } : params.replyTo ? { msg_id: params.replyTo } : { event_id: params.eventId! },
          mode: params.inputMode ?? 'replace', contentType: params.contentType ?? 'markdown', sequence: getNextMsgSeq(params.replyTo ?? params.eventId ?? ''),
          index: 0, confirmedText: '', tail: Promise.resolve(), removeAbort() {} };
        const abort = () => { void cancel(stream); };
        bound.signal.addEventListener('abort', abort, { once: true });
        stream.removeAbort = () => bound.signal.removeEventListener('abort', abort);
        streams.set(stream.id, stream);
        const result = frame(stream, bound, content, false);
        stream.tail = result.catch(() => {});
        return result;
      }
      if (params.replyTo !== undefined || params.eventId !== undefined || params.wakeup !== undefined || params.inputMode !== undefined || params.contentType !== undefined) throw new ToolError('流式锚点、模式和格式只能在 create 时指定。');
      const stream = streams.get(identifier(params.streamId, 'streamId'));
      if (!stream) throw new ToolError('流式会话不存在或已经结束。');
      active(stream, bound);
      if (params.action === 'cancel') {
        if (params.text !== undefined) throw new ToolError('cancel 不接受正文。');
        const warning = await cancel(stream);
        return output({ streamId: stream.id, state: 'cancelled', note: '已停止后续分片；已显示的内容不会因此撤回。', ...(warning ? { warning } : {}) });
      }
      if (params.action !== 'update' && params.action !== 'complete') throw new ToolError('流式操作无效。');
      if (params.action === 'update') text(params.text);
      const result = stream.tail.then(() => frame(stream, bound, params.text, params.action === 'complete'));
      stream.tail = result.catch(() => {});
      return result;
    },
  });

  pi.registerTool({
    name: 'qq_typing', label: 'QQ 单聊输入状态', description: '显式显示当前单聊的输入中状态，durationSec 为 1 到 60 秒（默认 30），平台权限决定是否可用。',
    parameters: Type.Object({ conversation: Type.String(), replyTo: Type.Optional(idSchema), durationSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      keys(params, ['conversation', 'replyTo', 'durationSec']);
      const bound = resolve(ctx, params.conversation, signal); privateOnly(bound);
      const duration = params.durationSec ?? 30;
      if (!Number.isInteger(duration) || duration < 1 || duration > 60) throw new ToolError('durationSec 须为 1 到 60。');
      if (params.replyTo !== undefined) identifier(params.replyTo, 'replyTo');
      try {
        if (params.replyTo !== undefined) await observed(bound, params.replyTo, true);
        bound.signal.throwIfAborted();
        await bound.transport.request('POST', messagePath(bound), { msg_type: 6, input_notify: { input_type: 1, input_second: duration },
          msg_seq: getNextMsgSeq(params.replyTo ?? ''), ...(params.replyTo ? { msg_id: params.replyTo } : {}) }, bound.signal);
        return output({ conversation: conversationKey(bound.conversation), durationSec: duration });
      } catch (error) { failed(error); }
    },
  });
  pi.registerTool({
    name: 'qq_wakeup', label: 'QQ 单聊主动唤醒', description: '显式发送官方单聊召回文字。需机器人开通权限并满足用户近期主动联系和频次限制；由腾讯平台判断资格，不自动发送或重试。',
    parameters: Type.Object({ conversation: Type.String(), text: textSchema }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      keys(params, ['conversation', 'text']);
      const bound = resolve(ctx, params.conversation, signal); privateOnly(bound);
      const content = text(params.text);
      try {
        bound.signal.throwIfAborted();
        const response = await bound.transport.request('POST', messagePath(bound), { content, msg_type: 0, is_wakeup: true, msg_seq: getNextMsgSeq('') }, bound.signal);
        const messageId = messageReceipt(response);
        const warning = await remember(bound, { messageId, text: content, kind: 'wakeup', raw: structuredClone(response as Record<string, unknown>) });
        return output({ conversation: conversationKey(bound.conversation), messageId, ...(warning ? { warning } : {}) });
      } catch (error) { failed(error); }
    },
  });
  return { cancelOutstanding, dispose: cancelOutstanding };
}
