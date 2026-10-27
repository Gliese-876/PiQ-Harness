import { resolve as resolvePath } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { conversationKey, validateConversation, type Conversation } from './conversations.ts';
import { lookupStoredMessages } from './chat-history.ts';
import { OneBotApiError } from './onebot-client.ts';
import type { ResourceContext, ResolveResourceContext } from './resource-tools.ts';

const MAX_MESSAGES = 50;
const MIN_MESSAGE_ID = -2_147_483_648;
const MAX_MESSAGE_ID = 2_147_483_647;
class ForwardSendError extends Error {}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameDirectory = (left: string, right: string) => process.platform === 'win32'
  ? resolvePath(left).toLowerCase() === resolvePath(right).toLowerCase() : resolvePath(left) === resolvePath(right);

export interface ForwardSendResult {
  sourceConversation: string;
  targetConversation: string;
  messageIds: number[];
  count: number;
  messageId: string;
  resourceId: string;
  forwardId: string;
}

export type RememberForward = (ctx: ExtensionContext, target: Conversation, result: ForwardSendResult) => Promise<string | void>;

function selectedMessageIds(input: readonly number[]): number[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_MESSAGES
    || input.some(id => !Number.isSafeInteger(id) || id === 0 || id < MIN_MESSAGE_ID || id > MAX_MESSAGE_ID)
    || new Set(input).size !== input.length) {
    throw new ForwardSendError('messageIds 须包含 1 到 50 个不重复的非零 QQ 消息 ID，范围为有符号 32 位整数。');
  }
  return [...input];
}

function receiptId(value: unknown): string | undefined {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^-?\d+$/.test(String(value))) return;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id === 0 || id < MIN_MESSAGE_ID || id > MAX_MESSAGE_ID) return;
  return String(id);
}

function resourceId(value: unknown): value is string {
  // Resource ids are opaque, but a response must not echo a URL, markup or credentials.
  return typeof value === 'string' && /^[A-Za-z0-9_+\/=.-]{1,512}$/.test(value);
}

/** OneBot node ids refer to locally observed messages; only the selected target receives them. */
export async function sendForwardMessages(source: ResourceContext, target: ResourceContext, input: readonly number[]): Promise<ForwardSendResult> {
  const messageIds = selectedMessageIds(input);
  const sourceConversation = validateConversation(source.conversation);
  const targetConversation = validateConversation(target.conversation);
  if (!sameDirectory(source.cwd, target.cwd) || source.transport !== target.transport) {
    throw new ForwardSendError('来源和目标必须属于同一个 PiQ 对话组及后端连接。');
  }
  if (targetConversation.type === 'temporary') throw new ForwardSendError('合并转发目前仅支持群聊和好友私聊，不能发送到群临时会话。');
  const signal = AbortSignal.any([source.signal, target.signal]);
  signal.throwIfAborted();
  const records = await lookupStoredMessages({ ...source, conversation: sourceConversation, signal }, { messageIds });
  signal.throwIfAborted();
  if (records.length !== messageIds.length || records.some((record, index) => record.messageId !== String(messageIds[index]))) {
    throw new ForwardSendError('来源记录与所选 QQ 消息 ID 不一致，已取消转发。');
  }
  // Public protocol references:
  // https://github.com/botuniverse/onebot-11/blob/master/message/segment.md#合并转发节点-badge-text发
  // https://github.com/SnowLuma/SnowLuma/blob/main/packages/mcp/src/generated/catalog.json
  const messages = records.map(record => ({ type: 'node', data: { id: record.messageId } }));
  const action = targetConversation.type === 'group' ? 'send_group_forward_msg' : 'send_private_forward_msg';
  const params = { ...(targetConversation.type === 'group' ? { group_id: Number(targetConversation.id) } : { user_id: Number(targetConversation.id) }), messages };
  let dispatched = false;
  let response: unknown;
  try {
    response = await target.transport.resources(async request => {
      signal.throwIfAborted();
      dispatched = true;
      return request(action, params, true);
    }, signal);
  } catch (error) {
    if (error instanceof OneBotApiError) throw error;
    if (dispatched) throw new ForwardSendError('合并转发结果未知，请先检查目标对话再决定是否重试；未自动重发。');
    if (signal.aborted) throw new ForwardSendError('合并转发已取消，尚未发送。');
    throw new ForwardSendError('合并转发尚未发送，请检查后端连接后重试。');
  }
  const messageId = object(response) ? receiptId(response.message_id) : undefined;
  if (!object(response) || !messageId || !resourceId(response.res_id) || !resourceId(response.forward_id)) {
    throw new ForwardSendError('合并转发回执无效，发送结果未知，请先检查目标对话；未自动重发。');
  }
  return { sourceConversation: conversationKey(sourceConversation), targetConversation: conversationKey(targetConversation),
    messageIds, count: records.length, messageId, resourceId: response.res_id, forwardId: response.forward_id };
}

export function registerForwardSendTool(pi: ExtensionAPI, resolve: ResolveResourceContext, remember?: RememberForward): void {
  pi.registerTool({
    name: 'qq_forward', label: '转发聊天记录',
    description: '把本组已保存的真实聊天记录作为 QQ 合并转发显式发送。先读取并选择记录，sourceConversation 指定来源，messageIds 为 1 到 50 个真实 QQ 消息 ID（可为负数），targetConversation 明确指定本组群聊或好友私聊；不支持临时会话作为目标。保留原消息内容，不接受编造的节点或任意转发 ID。跨对话分享前核对内容和接收对象；不会自动重发结果未知的请求。',
    parameters: Type.Object({ sourceConversation: Type.String(), targetConversation: Type.String(),
      messageIds: Type.Array(Type.Integer({ minimum: MIN_MESSAGE_ID, maximum: MAX_MESSAGE_ID }), { minItems: 1, maxItems: MAX_MESSAGES, uniqueItems: true }) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const source = resolve(ctx, params.sourceConversation, signal);
      const target = resolve(ctx, params.targetConversation, signal);
      const result = await sendForwardMessages(source, target, params.messageIds);
      let warning = '';
      if (remember) {
        try { warning = await remember(ctx, target.conversation, result) || ''; }
        catch { warning = '已发送，但本地发送记录保存失败；请勿为补记记录而重发。'; }
      }
      return { content: [{ type: 'text', text: `已向 ${result.targetConversation} 合并转发 ${result.count} 条聊天记录，message_id=${result.messageId}${warning ? `\n${warning}` : ''}` }],
        details: { ...result, ...(warning ? { warning } : {}) } };
    },
  });
}
