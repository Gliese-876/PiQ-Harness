import { createHash } from 'node:crypto';

export interface Conversation {
  type: 'group' | 'private';
  id: string;
  name?: string;
}

/** Official QQ OpenIDs are opaque and case-sensitive; never convert them to numbers. */
export function validateOpenId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('OpenID 须为 1 到 128 位字母、数字、下划线或连字符，不能包含路径字符。');
  }
  return value;
}

export function validateConversation(value: unknown): Conversation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('对话必须是对象。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['type', 'id', 'name'].includes(key))) throw new Error('对话含未知配置项。');
  if (input.type !== 'group' && input.type !== 'private') throw new Error('官方机器人对话类型必须是 group 或 private。');
  const id = validateOpenId(input.id);
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim()
    || input.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(input.name))) throw new Error('对话名称须为 1 到 80 个字符。');
  return { type: input.type, id, ...(input.name === undefined ? {} : { name: (input.name as string).trim() }) };
}

export function conversationKey(conversation: Pick<Conversation, 'type' | 'id'>): string {
  const value = validateConversation(conversation);
  return `${value.type}:${value.id}`;
}

export function parseConversationKey(value: unknown): Conversation {
  if (typeof value !== 'string') throw new Error('对话标识须为 group:群OpenID 或 private:用户OpenID。');
  const matched = /^(group|private):(.+)$/.exec(value);
  if (!matched) throw new Error('对话标识须为 group:群OpenID 或 private:用户OpenID。');
  return validateConversation({ type: matched[1], id: matched[2] });
}

/** Hashes keep case-sensitive OpenIDs distinct on Windows and never become raw filenames. */
export function conversationDirectory(conversation: Conversation): string {
  const value = validateConversation(conversation);
  const hash = createHash('sha256').update(value.id, 'utf8').digest('hex');
  return `messages/v3/${value.type}/${hash}`;
}
