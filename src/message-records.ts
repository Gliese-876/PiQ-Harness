import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { conversationDirectory, conversationKey } from './conversations.ts';
import type { ResourceContext } from './resource-tools.ts';
import { parseStoredRecord, type StoredMessage, type StoredRecord } from './store.ts';

type MessageRecordContext = Pick<ResourceContext, 'cwd' | 'conversation' | 'signal'>;
export interface StoredMessageSelection {
  messageIds?: readonly number[];
  seqs?: readonly number[];
}

export class HistoryError extends Error {}
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const samePath = (left: string, right: string) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
const messageId = (value: unknown): value is number => Number.isInteger(value) && Number(value) !== 0
  && Number(value) >= -2_147_483_648 && Number(value) <= 2_147_483_647;
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1;
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Do not expose backend credentials embedded in message metadata or signed links. */
export function redactChatText(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\[CQ:[\s\S]*?(?:\]|$)/gi, '[消息段]')
    .replace(/https?:\/\/[^\s<>"']+/gi, raw => {
      if (/^https?:\/\/[^/\s]*@/i.test(raw)) return '[带凭据链接已隐藏]';
      try {
        const url = new URL(raw);
        if (url.username || url.password || [...url.searchParams.keys()].some(key =>
          /(?:^|[_-])(?:token|rkey|sig|sign|signature|secret|password|passwd|credential|auth|authorization|key)(?:$|[_-])/i.test(key)
          || /^(?:accessToken|apiKey|securityToken)$/i.test(key))) return '[带凭据链接已隐藏]';
      } catch { /* Ordinary message text is retained when it is not a URL. */ }
      return raw;
    })
    .replace(/\b(Authorization\s*[:=]\s*)(?:Basic|Bearer|Digest|Negotiate|Token)[ \t]+[^\r\n]*/gi, '$1[已隐藏]')
    .replace(/\bBearer[ \t]+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
    .replace(/\b((?:access[_-]?token|api[_-]?key|token|rkey|secret|password|passwd|authorization)["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;，；]+)/gi,
      (_match, prefix: string, secret: string) => prefix + (secret.startsWith('"') ? '"[已隐藏]"' : secret.startsWith("'") ? "'[已隐藏]'" : '[已隐藏]'));
}

async function ordinary(path: string, directory: boolean) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !samePath(path, await realpath(path))
    || (directory ? !info.isDirectory() : !info.isFile() || info.nlink > 1)) {
    throw new HistoryError('聊天记录路径须为本组内的普通目录或文件。');
  }
  return info;
}

/** Read a stable byte prefix backwards, ignoring an unfinished last append. */
async function* committedLines(path: string, signal: AbortSignal): AsyncGenerator<string> {
  const checked = await ordinary(path, false);
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1 || opened.dev !== checked.dev || opened.ino !== checked.ino) {
      throw new HistoryError('聊天记录文件在读取前已变化，请重试。');
    }
    let position = opened.size, pending = Buffer.alloc(0), uncommitted = true;
    while (position > 0) {
      signal.throwIfAborted();
      const length = Math.min(64 * 1024, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead !== length) throw new HistoryError('聊天记录在读取期间被截断，请重试。');
      const bytes = Buffer.concat([chunk, pending]);
      let end = bytes.length;
      for (let index = bytes.length - 1; index >= 0; index--) {
        if (bytes[index] !== 10) continue;
        if (uncommitted) { uncommitted = false; end = index; continue; }
        const line = bytes.subarray(index + 1, end);
        if (line.length > MAX_LINE_BYTES) throw new HistoryError('单条聊天记录过大，请检查原日志。');
        if (line.length) yield line.toString('utf8').replace(/\r$/, '');
        end = index;
      }
      pending = Buffer.from(bytes.subarray(0, end));
      if (pending.length > MAX_LINE_BYTES) throw new HistoryError('单条聊天记录过大，请检查原日志。');
    }
    signal.throwIfAborted();
    if (!uncommitted && pending.length) yield pending.toString('utf8').replace(/\r$/, '');
  } finally { await handle.close(); }
}

async function* journalRecords(bound: MessageRecordContext, signal: AbortSignal): AsyncGenerator<StoredRecord> {
  signal.throwIfAborted();
  await ordinary(bound.cwd, true);
  let directory = resolve(bound.cwd);
  for (const part of conversationDirectory(bound.conversation).split('/')) {
    directory = join(directory, part);
    try { await ordinary(directory, true); }
    catch (error) { if (missing(error)) return; throw error; }
  }
  const names = (await readdir(directory)).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse();
  const seen = new Set<number>();
  const target = conversationKey(bound.conversation);
  for (const name of names) {
    for await (const line of committedLines(join(directory, name), signal)) {
      signal.throwIfAborted();
      if (!line.trim()) continue;
      const record = parseStoredRecord(line, name);
      if (conversationKey(record.conversation) !== target) throw new HistoryError('消息日志包含其他对话的记录。');
      if (seen.has(record.seq)) throw new HistoryError('消息日志包含重复 seq，请先检查原日志。');
      seen.add(record.seq);
      yield record;
    }
  }
}

function failure(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw new HistoryError('聊天记录读取已取消或超时。');
  if (error instanceof HistoryError) throw error;
  throw new HistoryError('聊天记录读取失败，请检查原日志后重试。');
}

/** Internal proof lookup used by forwarding tools, rather than a model-facing history reader. */
export async function lookupStoredMessages(bound: MessageRecordContext, selection: StoredMessageSelection): Promise<StoredMessage[]> {
  const ids = selection.messageIds, seqs = selection.seqs;
  if ((ids === undefined) === (seqs === undefined)) throw new HistoryError('须且只能提供 messageIds 或 seqs 中的一项。');
  const values = ids ?? seqs!;
  if (!Array.isArray(values) || !values.length || values.length > 100 || new Set(values).size !== values.length
    || values.some(value => ids ? !messageId(value) : !sequence(value))) {
    throw new HistoryError('请选择 1 到 100 条不同的真实消息；messageIds 须为非零 32 位整数，seqs 须为正整数。');
  }
  const signal = AbortSignal.any([bound.signal, AbortSignal.timeout(20_000)]);
  try {
    const wanted = new Set<number>(values), found = new Map<number, StoredMessage>();
    for await (const record of journalRecords(bound, signal)) {
      if (record.kind === 'poke') continue;
      const key = ids ? Number(record.messageId) : record.seq;
      if (!wanted.has(key)) continue;
      if (found.has(key)) throw new HistoryError('所选消息标识对应多条记录，无法确定要转发的消息。');
      found.set(key, record);
    }
    signal.throwIfAborted();
    if (found.size !== wanted.size) throw new HistoryError('在该对话已保存的日志中找不到全部指定消息；戳一戳记录不能转发。');
    return values.map(value => found.get(value)!);
  } catch (error) { failure(error, signal); }
}
