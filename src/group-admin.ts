import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { conversationKey, parseConversationKey, validateOpenId, type Conversation } from './conversations.ts';

type Method = 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
export interface GroupAdminContext {
  conversation: Conversation;
  transport: { request(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> };
  signal: AbortSignal;
}
export type ResolveGroupAdminContext = (ctx: ExtensionContext, conversation: string, signal?: AbortSignal) => GroupAdminContext;

export const GROUP_ADMIN_ACTIONS = ['info', 'bot_state', 'members', 'member', 'remove_members',
  'blacklist_list', 'blacklist_add', 'blacklist_remove', 'mute_list', 'mute', 'update_mute', 'unmute',
  'join_requests', 'approve', 'reject', 'strategy_list', 'strategy_create', 'strategy_update',
  'strategy_delete', 'strategy_execute', 'strategy_whitelist'] as const;
type Action = typeof GROUP_ADMIN_ACTIONS[number];
const fields: Record<Action, readonly string[]> = {
  info: [], bot_state: [], members: ['cursor'], member: ['memberId'],
  remove_members: ['memberIds', 'addToBlacklist'], blacklist_list: ['cursor', 'limit'],
  blacklist_add: ['memberIds'], blacklist_remove: ['memberIds'], mute_list: [],
  mute: ['memberId', 'memberIds', 'muteUntil'], update_mute: ['memberId', 'memberIds', 'muteUntil'],
  unmute: ['memberId', 'memberIds'], join_requests: ['cursor', 'limit'],
  approve: ['memberId', 'joinRequestId'], reject: ['memberId', 'joinRequestId', 'rejectReason', 'addToBlacklist'],
  strategy_list: [], strategy_create: ['isEnable', 'expireAt', 'remark'],
  strategy_update: ['strategyId', 'isEnable', 'expireAt', 'remark'],
  strategy_delete: ['strategyId'], strategy_execute: ['strategyId'],
  strategy_whitelist: ['strategyId', 'whitelistOp', 'whitelistUsers'],
};
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_MUTE_MS = 30 * 24 * 60 * 60 * 1000;
const STRATEGIES_PATH = '/v2/groups/join_approval_strategy';
const MAX_STRATEGY_PAGES = 20;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
class StrategyScopeError extends Error {}

function text(value: unknown, name: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} 须为${allowEmpty ? '不超过' : '非空且不超过'} ${max} 个字符的单行文字。`);
  }
  return value;
}
function memberIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new Error('memberIds 须包含 1 到 20 个成员 OpenID。');
  const ids = value.map(validateOpenId);
  if (new Set(ids).size !== ids.length) throw new Error('memberIds 不能包含重复成员。');
  return ids;
}
function selectedMembers(input: Record<string, unknown>): string[] {
  if (input.memberId !== undefined && input.memberIds !== undefined) throw new Error('memberId 和 memberIds 只能选择一个。');
  return input.memberId === undefined ? memberIds(input.memberIds) : [validateOpenId(input.memberId)];
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} 须为布尔值。`);
  return value;
}
function page(input: Record<string, unknown>, maximum?: number): Record<string, string | number> | undefined {
  const query: Record<string, string | number> = {};
  if (input.cursor !== undefined) query.cursor = text(input.cursor, 'cursor', 4096, true);
  if (input.limit !== undefined) {
    if (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > (maximum ?? 100)) {
      throw new Error(`limit 须为 1 到 ${maximum ?? 100} 的整数。`);
    }
    query.limit = Number(input.limit);
  }
  return Object.keys(query).length ? query : undefined;
}
function timestamp(value: unknown, name: string): string {
  const timestamp = text(value, name, 64);
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(timestamp);
  if (!match) throw new Error(`${name} 须为带时区的 RFC3339 时间。`);
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1]! || !Number.isFinite(Date.parse(timestamp))) throw new Error(`${name} 须为有效的 RFC3339 时间。`);
  return timestamp;
}
function muteTime(value: unknown, now: number): string {
  const result = timestamp(value, 'muteUntil');
  const until = Date.parse(result);
  if (until <= now || until - now > MAX_MUTE_MS) {
    throw new Error('muteUntil 须为有效的未来时间，且距现在不超过 30 天。');
  }
  return result;
}
function strategyId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('strategyId 须为平台返回的有效策略标识。');
  return value;
}
function strategySettings(input: Record<string, unknown>): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  if (input.isEnable !== undefined) {
    if (input.isEnable !== 'on' && input.isEnable !== 'off') throw new Error('isEnable 须为 on 或 off。');
    settings.is_enable = input.isEnable;
  }
  if (input.expireAt !== undefined) settings.expire_at = timestamp(input.expireAt, 'expireAt');
  if (input.remark !== undefined) settings.remark = text(input.remark, 'remark', 255, true);
  return settings;
}
function whitelistNumbers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000
    || value.some(number => typeof number !== 'string' || !/^[1-9]\d{0,19}$/.test(number))) {
    throw new Error('whitelistUsers 须包含 1 到 10000 个 QQ 号码字符串，每个号码最多 20 位；此字段不是对话 OpenID。');
  }
  if (new Set(value).size !== value.length) throw new Error('whitelistUsers 不能包含重复号码。');
  return value as string[];
}

function plan(value: unknown, now: number): { action: Action; key: string; method: Method; path: string; body?: unknown; strategyId?: string } {
  if (!object(value) || typeof value.action !== 'string' || !GROUP_ADMIN_ACTIONS.includes(value.action as Action)) throw new Error('未知群管理操作。');
  const action = value.action as Action;
  if (Object.keys(value).some(key => !['action', 'conversation', ...fields[action]].includes(key))) throw new Error('群管理参数包含该操作不支持的字段。');
  const conversation = parseConversationKey(value.conversation);
  if (conversation.type !== 'group') throw new Error('群管理仅支持本组的官方群聊。');
  const key = conversationKey(conversation);
  const base = `/v2/groups/${encodeURIComponent(conversation.id)}`;
  let method: Method = 'GET', path: string, body: unknown;
  let selectedStrategy: string | undefined;
  switch (action) {
    case 'info': path = `${base}/info`; break;
    case 'bot_state': path = `${base}/bot_state`; break;
    case 'members': path = `${base}/members`; body = page(value); break;
    case 'member': path = `${base}/members/${encodeURIComponent(validateOpenId(value.memberId))}`; break;
    case 'remove_members':
      method = 'POST'; path = `${base}/batch_remove_members`;
      body = { member_openids: memberIds(value.memberIds), ...(value.addToBlacklist === undefined ? {} : { add_to_member_blacklist: boolean(value.addToBlacklist, 'addToBlacklist') }) };
      break;
    case 'blacklist_list': path = `${base}/member_blacklist`; body = page(value, 100); break;
    case 'blacklist_add': case 'blacklist_remove':
      method = 'POST'; path = `${base}/member_blacklist`;
      body = { op: action === 'blacklist_add' ? 'add' : 'del', member_openids: memberIds(value.memberIds) }; break;
    case 'mute_list': path = `${base}/restrict_chat_setting`; break;
    case 'mute': case 'update_mute': case 'unmute': {
      method = 'POST'; path = `${base}/restrict_chat_setting`;
      const until = action === 'unmute' ? '' : muteTime(value.muteUntil, now);
      body = { members: selectedMembers(value).map(id => ({ op: action === 'mute' ? 'add' : action === 'update_mute' ? 'update' : 'del', member_openid: id, mute_expire_at: until })) };
      break;
    }
    case 'join_requests': path = `${base}/join_request_list`; body = page(value, 50); break;
    case 'approve': case 'reject':
      method = 'POST'; path = `${base}/approval_join_request/${encodeURIComponent(validateOpenId(value.memberId))}`;
      body = { op: action === 'approve' ? 'approve' : 'decline',
        ...(value.joinRequestId === undefined ? {} : { join_request_id: text(value.joinRequestId, 'joinRequestId', 4096) }),
        ...(value.rejectReason === undefined ? {} : { reject_reason: text(value.rejectReason, 'rejectReason', 500, true) }),
        ...(value.addToBlacklist === undefined ? {} : { add_to_member_blacklist: boolean(value.addToBlacklist, 'addToBlacklist') }) };
      break;
    case 'strategy_list': path = STRATEGIES_PATH; break;
    case 'strategy_create':
      method = 'POST'; path = STRATEGIES_PATH;
      body = { group_openids: [conversation.id], ...strategySettings(value) }; break;
    case 'strategy_update': case 'strategy_delete': case 'strategy_execute': case 'strategy_whitelist':
      selectedStrategy = strategyId(value.strategyId);
      path = `${STRATEGIES_PATH}/${encodeURIComponent(selectedStrategy)}`;
      if (action === 'strategy_update') {
        method = 'PATCH'; body = strategySettings(value);
        if (!Object.keys(body as Record<string, unknown>).length) throw new Error('修改策略至少需要 isEnable、expireAt 或 remark 之一。');
      } else if (action === 'strategy_delete') method = 'DELETE';
      else if (action === 'strategy_execute') { method = 'POST'; path += '/execute'; }
      else {
        method = 'POST'; path += '/whitelist_users';
        if (value.whitelistOp !== 'add' && value.whitelistOp !== 'del') throw new Error('whitelistOp 须为 add 或 del。');
        body = { op: value.whitelistOp, whitelist_users: whitelistNumbers(value.whitelistUsers) };
      }
      break;
  }
  return { action, key, method, path, ...(body === undefined ? {} : { body }), ...(selectedStrategy === undefined ? {} : { strategyId: selectedStrategy }) };
}

type Request = (method: Method, path: string, body?: unknown) => Promise<unknown>;
/** Complete the application list internally so no unverified strategy can be selected. */
async function strategyList(request: Request): Promise<Record<string, unknown>[]> {
  const strategies: Record<string, unknown>[] = [];
  const ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_STRATEGY_PAGES; page++) {
    const result = await request('GET', STRATEGIES_PATH, { limit: 50, ...(cursor === undefined ? {} : { cursor }) });
    if (!object(result) || !Array.isArray(result.strategies) || result.strategies.length > 50
      || typeof result.next_cursor !== 'string' || result.next_cursor.length > 4096 || /[\x00-\x1f\x7f]/.test(result.next_cursor)) {
      throw new StrategyScopeError('平台策略列表格式不完整，无法确认策略作用范围，未执行写入。');
    }
    for (const item of result.strategies) {
      if (!object(item) || typeof item.strategy_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.strategy_id)
        || ids.has(item.strategy_id)) throw new StrategyScopeError('平台策略列表含无效或重复标识，无法确认策略作用范围，未执行写入。');
      ids.add(item.strategy_id); strategies.push(item);
    }
    if (!result.next_cursor) return strategies;
    if (cursors.has(result.next_cursor)) throw new StrategyScopeError('平台策略列表分页重复，无法确认完整作用范围，未执行写入。');
    cursors.add(result.next_cursor); cursor = result.next_cursor;
  }
  throw new StrategyScopeError('平台策略列表超过查询上限，无法确认完整作用范围，未执行写入。');
}
function onlyThisGroup(strategy: Record<string, unknown>, groupId: string): boolean {
  return Array.isArray(strategy.group_openids) && strategy.group_openids.length === 1 && strategy.group_openids[0] === groupId
    && (strategy.group_ids === undefined || (Array.isArray(strategy.group_ids) && strategy.group_ids.length === 0));
}
function visibleStrategy(strategy: Record<string, unknown>): Record<string, unknown> {
  const keys = ['strategy_id', 'group_openids', 'group_ids', 'whitelist_user_count', 'is_enable', 'expire_at', 'created_at', 'updated_at', 'remark'];
  return Object.fromEntries(keys.filter(key => strategy[key] !== undefined).map(key => [key, strategy[key]]));
}

function limitedResult(action: Action, key: string, data: unknown) {
  const serialized = JSON.stringify(data ?? null);
  if (serialized === undefined) throw new Error('群管理响应格式无效。');
  const make = (text: string, truncated: boolean) => ({ content: [{ type: 'text' as const, text }], details: { action, conversation: key, truncated } });
  const whole = make(JSON.stringify({ action, conversation: key, data: data ?? null, truncated: false }), false);
  if (Buffer.byteLength(JSON.stringify(whole)) <= MAX_OUTPUT_BYTES) return whole;
  const originalBytes = Buffer.byteLength(serialized);
  const nextCursor = object(data) && typeof data.next_cursor === 'string' && data.next_cursor.length <= 4096 ? data.next_cursor : undefined;
  const preview = (length: number) => make(JSON.stringify({ action, conversation: key, truncated: true, originalBytes,
    note: '官方响应过长，以下仅为截断预览；支持分页的操作请使用游标继续查询。',
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }), preview: serialized.slice(0, length) }), true);
  let low = 0, high = Math.min(serialized.length, MAX_OUTPUT_BYTES);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(preview(middle))) <= MAX_OUTPUT_BYTES) low = middle;
    else high = middle - 1;
  }
  return preview(low);
}

function requestError(error: unknown, signal: AbortSignal, mutating: boolean): Error {
  if (signal.aborted) return new Error(mutating ? '群管理操作已取消；若请求已派发，请先核对群状态再重试。' : '群管理查询已取消。');
  const code = object(error) ? error.bizCode : undefined;
  const status = object(error) ? error.httpStatus : undefined;
  const numericCode = typeof code === 'number' ? code : typeof code === 'string' && /^\d+$/.test(code) ? Number(code) : undefined;
  if ((numericCode !== undefined && [11253, 11282].includes(numericCode)) || status === 403) {
    return new Error('机器人没有该群管理能力或操作权限，请检查平台能力白名单及目标群管理员权限。');
  }
  return new Error(mutating ? '群管理请求失败或结果未确认，请先查询群状态再决定是否重试。' : '群管理查询失败，请检查连接和平台权限后重试。');
}

/** All remote paths are selected here from documented group APIs; writes are dispatched once. */
export async function executeGroupAdmin(bound: GroupAdminContext, value: unknown, now = Date.now()) {
  const request = plan(value, now);
  if (bound.conversation.type !== 'group' || conversationKey(bound.conversation) !== request.key) throw new Error('目标群聊不属于当前对话组。');
  bound.signal.throwIfAborted();
  let data: unknown;
  let mutationDispatched = false;
  const send: Request = async (method, path, body) => {
    bound.signal.throwIfAborted();
    mutationDispatched ||= method !== 'GET';
    const result = await bound.transport.request(method, path, body, bound.signal);
    bound.signal.throwIfAborted();
    if (object(result)) {
      const code = [result.err_code, result.code].find(value => value !== undefined && value !== 0 && value !== '0');
      if (code !== undefined) throw Object.assign(new Error('平台拒绝了群管理请求。'), { bizCode: code });
    }
    return result;
  };
  try {
    if (request.action === 'strategy_list' || request.strategyId !== undefined) {
      const strategies = await strategyList(send);
      if (request.action === 'strategy_list') {
        data = { strategies: strategies.filter(strategy => onlyThisGroup(strategy, bound.conversation.id)).map(visibleStrategy), next_cursor: '' };
      } else {
        const selected = strategies.find(strategy => strategy.strategy_id === request.strategyId);
        if (!selected || !onlyThisGroup(selected, bound.conversation.id)) {
          throw new StrategyScopeError('无法确认所选策略仅关联当前群，已拒绝操作；多群、数字群号或缺少范围信息的策略不能在此管理。');
        }
        data = await send(request.method, request.path, request.body);
      }
    } else {
      data = await send(request.method, request.path, request.body);
    }
  } catch (error) {
    if (error instanceof StrategyScopeError) throw error;
    throw requestError(error, bound.signal, mutationDispatched);
  }
  try { return limitedResult(request.action, request.key, data); }
  catch { throw new Error('群管理响应无法安全显示，请先核对平台状态；写入操作请勿自动重发。'); }
}

export function registerGroupAdmin(pi: ExtensionAPI, resolveContext: ResolveGroupAdminContext): void {
  pi.registerTool({
    name: 'qq_group_manage', label: '官方 QQ 群管理',
    description: '显式查询或管理本组官方群聊。info/bot_state/members/member 查询资料；remove_members 移除成员；blacklist_list/blacklist_add/blacklist_remove 管理黑名单；mute_list/mute/update_mute/unmute 管理禁言；join_requests/approve/reject 读取或审批入群请求。strategy_list/create/update/delete/execute/whitelist 管理入群自动审批策略，仅支持明确单独关联当前群的策略，创建时固定本群，修改前重新核验。isEnable为on/off，expireAt为RFC3339；whitelistOp为add/del，whitelistUsers是官方策略所需QQ号码字符串。部分能力需平台白名单，禁言与审批需群管理员；禁言最多30天，每批最多20人。读取结果可能截断；写操作不自动重试。',
    parameters: Type.Object({
      action: Type.Union(GROUP_ADMIN_ACTIONS.map(action => Type.Literal(action))), conversation: Type.String(),
      memberIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 20 })),
      memberId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      cursor: Type.Optional(Type.String({ maxLength: 4096 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      muteUntil: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      joinRequestId: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
      rejectReason: Type.Optional(Type.String({ maxLength: 500 })), addToBlacklist: Type.Optional(Type.Boolean()),
      strategyId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' })),
      isEnable: Type.Optional(Type.Union([Type.Literal('on'), Type.Literal('off')])),
      expireAt: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })), remark: Type.Optional(Type.String({ maxLength: 255 })),
      whitelistOp: Type.Optional(Type.Union([Type.Literal('add'), Type.Literal('del')])),
      whitelistUsers: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 20, pattern: '^[1-9][0-9]*$' }), { minItems: 1, maxItems: 10_000 })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      plan(params, Date.now());
      const bound = resolveContext(ctx, params.conversation, signal);
      return executeGroupAdmin(bound, params);
    },
  });
}
