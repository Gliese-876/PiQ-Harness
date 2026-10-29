import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { conversationDirectory, conversationKey, validateConversation, validateOpenId, type Conversation } from './conversations.ts';
import { validateGroupId, type GroupConfig } from './config.ts';

export interface IncomingRecord {
  messageId: string;
  conversation: Conversation;
  userId: string;
  /** Stable official bot account/AppID namespace. */
  selfId: string;
  sender: string;
  /** Official event time in seconds since the Unix epoch. */
  time: number;
  rawText: string;
  outgoing: boolean;
  /** Set only after this PiQ instance has received an official send receipt. */
  sentByPi?: boolean;
  /** Official author.bot flag; source metadata, independent of local send ownership. */
  botAuthored?: boolean;
  eventType?: string;
  attachments?: Record<string, unknown>[];
  /** The unmodified official event payload, including its account/source metadata. */
  raw?: Record<string, unknown>;
}

/** One newline commits the original official message and local ordering metadata. */
export interface StoredMessage extends IncomingRecord {
  v: 3;
  seq: number;
  receivedAt: number;
}
export type StoredRecord = StoredMessage;

export interface PendingMessages {
  count: number;
  firstAt: number;
  lastAt: number;
  through: number;
  files: string[];
  conversations: Array<{ conversation: Conversation; count: number; firstSeq: number; lastSeq: number; files: string[] }>;
}

interface Receipt {
  seq: number;
  key: string;
  at: number;
  incoming: boolean;
  file: string;
  conversation: Conversation;
}
interface State { version: 3; groupId: string; notifiedThrough: number; lastNotifiedAt: number }
interface Owner { version: 1; pid: number; token: string }
interface ConfirmedSend {
  conversation: Conversation;
  selfId: string;
  messageId: string;
  confirmedAt: number;
  raw?: Record<string, unknown>;
}

const STATE_FILE = 'state-v3.json';
const ACCOUNT_FILE = 'bot-account.json';
const SENT_RECEIPTS_FILE = 'sent-receipts-v3.json';
const MAX_LOOKUP_LINE_BYTES = 8 * 1024 * 1024;
const isCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const samePath = (left: string, right: string) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (isCode(error, 'ESRCH')) return false; if (isCode(error, 'EPERM')) return true; throw error; }
}

async function requireDirectory(directory: string): Promise<void> {
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || !samePath(directory, await realpath(directory))) {
    throw new Error(`Message directory must be an ordinary directory: ${directory}`);
  }
}

async function requireFile(filename: string) {
  const entry = await lstat(filename);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink > 1 || !samePath(filename, await realpath(filename))) {
    throw new Error(`Message/state path must be an ordinary file: ${filename}`);
  }
  return entry;
}

async function ensureDirectory(directory: string): Promise<void> {
  try { await mkdir(directory); } catch (error) { if (!isCode(error, 'EEXIST')) throw error; }
  await requireDirectory(directory);
}

function parseOwner(contents: string, filename: string): Owner {
  let owner: unknown;
  try { owner = JSON.parse(contents); }
  catch { throw new Error(`Cannot read group lock ${filename}; inspect it before removing it.`); }
  if (!object(owner) || owner.version !== 1 || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0
    || typeof owner.token !== 'string' || !owner.token) throw new Error(`Invalid group lock ${filename}; inspect it before removing it.`);
  return owner as unknown as Owner;
}

async function writeExclusive(filename: string, contents: string): Promise<void> {
  const handle = await open(filename, 'wx', 0o600);
  try { await handle.writeFile(contents, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}

async function releaseOwnedLock(filename: string, token: string): Promise<void> {
  try {
    await requireDirectory(path.dirname(filename));
    await requireFile(filename);
    const owner = parseOwner(await readFile(filename, 'utf8'), filename);
    if (owner.token === token) await unlink(filename);
  } catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
}

async function acquireLock(directory: string): Promise<{ filename: string; token: string }> {
  const filename = path.join(directory, 'owner.lock');
  const token = randomUUID();
  const contents = JSON.stringify({ version: 1, pid: process.pid, token } satisfies Owner);
  try { await writeExclusive(filename, contents); return { filename, token }; }
  catch (error) { if (!isCode(error, 'EEXIST')) throw error; }
  const recoveryFile = path.join(directory, 'recovery.lock');
  try { await writeExclusive(recoveryFile, contents); }
  catch (error) {
    if (isCode(error, 'EEXIST')) throw new Error(`Group lock recovery is already in progress: ${recoveryFile}. Inspect its owner if it persists.`);
    throw error;
  }
  try {
    let owner: Owner | undefined;
    try { await requireFile(filename); owner = parseOwner(await readFile(filename, 'utf8'), filename); }
    catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
    if (owner && processExists(owner.pid)) throw new Error(`This group is already open in process ${owner.pid}: ${filename}`);
    if (owner) await unlink(filename);
    await writeExclusive(filename, contents);
    return { filename, token };
  } finally { await releaseOwnedLock(recoveryFile, token); }
}

async function atomicJson(filename: string, data: unknown): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeExclusive(temporary, `${JSON.stringify(data, null, 2)}\n`);
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, filename); break; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].some(code => isCode(error, code))) throw error;
        await delay(20 * (attempt + 1));
      }
    }
  } finally { await unlink(temporary).catch(error => { if (!isCode(error, 'ENOENT')) throw error; }); }
}

function journalDate(timestamp: number): string {
  const date = new Date(timestamp);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function validateMessageId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Message ID must be an opaque nonempty string without whitespace or control characters.');
  }
}

async function readAccount(cwd: string): Promise<string | undefined> {
  await requireDirectory(path.join(cwd, '.piq'));
  const filename = path.join(cwd, '.piq', ACCOUNT_FILE);
  try {
    const info = await requireFile(filename);
    if (info.size > 4_096) throw new Error('Account marker is too large.');
    const value: unknown = JSON.parse(await readFile(filename, 'utf8'));
    if (!object(value) || value.version !== 1 || Object.keys(value).some(key => key !== 'version' && key !== 'accountId')) {
      throw new Error('Invalid account marker.');
    }
    return validateOpenId(value.accountId);
  } catch (cause) {
    if (isCode(cause, 'ENOENT')) return undefined;
    throw new Error('Cannot read bot account binding; inspect .piq/bot-account.json before continuing.', { cause });
  }
}

async function createAccountBinding(cwd: string, accountId: string): Promise<void> {
  await requireDirectory(path.join(cwd, '.piq'));
  const filename = path.join(cwd, '.piq', ACCOUNT_FILE);
  try { await writeExclusive(filename, JSON.stringify({ version: 1, accountId }) + '\n'); }
  catch (error) {
    if (!isCode(error, 'EEXIST')) throw error;
    if (await readAccount(cwd) !== accountId) throw new Error('Bot account binding changed; create a new conversation group for a different AppID.');
  }
}

/** Read only a stable, fully committed prefix without keeping whole daily files in memory. */
async function* lookupRecords(filename: string, signal: AbortSignal): AsyncGenerator<StoredMessage> {
  const checked = await requireFile(filename);
  const handle = await open(filename, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1 || checked.dev !== opened.dev || checked.ino !== opened.ino) {
      throw new Error('Message journal changed before lookup; retry the operation.');
    }
    let offset = 0, pending = Buffer.alloc(0);
    while (offset < opened.size) {
      signal.throwIfAborted();
      const length = Math.min(64 * 1024, opened.size - offset);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (bytesRead !== length) throw new Error('Message journal was truncated during lookup.');
      offset += length;
      const bytes = Buffer.concat([pending, chunk]);
      let start = 0;
      for (let end = bytes.indexOf(10, start); end >= 0; end = bytes.indexOf(10, start)) {
        const line = bytes.subarray(start, end);
        if (line.length > MAX_LOOKUP_LINE_BYTES) throw new Error('Message lookup record exceeds the 8 MiB limit.');
        yield parseStoredMessage(line.toString('utf8'), filename);
        start = end + 1;
      }
      pending = Buffer.from(bytes.subarray(start));
      if (pending.length > MAX_LOOKUP_LINE_BYTES) throw new Error('Message lookup record exceeds the 8 MiB limit.');
    }
    signal.throwIfAborted();
    // An unfinished final append is not proof of a received message.
  } finally { await handle.close(); }
}

function validateRecord(value: unknown): asserts value is IncomingRecord {
  if (!object(value)) throw new Error('Message must be an object.');
  if (['kind', 'segments', 'messageSeq', 'groupId', 'sourceGroupId'].some(key => key in value)) {
    throw new Error('Only official QQ message records are supported; legacy records must remain archived.');
  }
  validateConversation(value.conversation);
  validateMessageId(value.messageId);
  validateOpenId(value.userId); validateOpenId(value.selfId);
  if (typeof value.time !== 'number' || !Number.isFinite(value.time) || value.time < 0) throw new Error('Message time must be seconds since the Unix epoch.');
  if (typeof value.sender !== 'string' || typeof value.rawText !== 'string' || typeof value.outgoing !== 'boolean'
    || (value.sentByPi !== undefined && (typeof value.sentByPi !== 'boolean' || (value.sentByPi && !value.outgoing)))
    || (value.botAuthored !== undefined && typeof value.botAuthored !== 'boolean')) throw new Error('Invalid message content.');
  if (value.eventType !== undefined && (typeof value.eventType !== 'string' || !value.eventType || value.eventType.length > 100 || /[\x00-\x1f\x7f]/.test(value.eventType))) {
    throw new Error('Invalid official event type.');
  }
  if (value.raw !== undefined && !object(value.raw)) throw new Error('Official raw event must be an object.');
  if (value.attachments !== undefined && (!Array.isArray(value.attachments) || value.attachments.some(item => !object(item)))) {
    throw new Error('Official attachments must be an array of objects.');
  }
}

function conversationRef(conversation: Conversation): Conversation {
  const { name: _name, ...ref } = validateConversation(conversation);
  return ref;
}

function receiptKey(record: IncomingRecord): string {
  return JSON.stringify([record.conversation.type, record.conversation.id, record.selfId, record.messageId]);
}

function confirmedSend(value: unknown): ConfirmedSend {
  if (!object(value) || Object.keys(value).some(key => !['conversation', 'selfId', 'messageId', 'confirmedAt', 'raw'].includes(key))) {
    throw new Error('Invalid confirmed send receipt.');
  }
  const conversation = conversationRef(validateConversation(value.conversation));
  const selfId = validateOpenId(value.selfId);
  validateMessageId(value.messageId);
  if (value.messageId.startsWith('event:') || typeof value.confirmedAt !== 'number' || !Number.isFinite(value.confirmedAt)
    || value.confirmedAt < 0 || (value.raw !== undefined && (!object(value.raw) || value.raw.id !== value.messageId))) {
    throw new Error('Invalid confirmed send receipt identity or metadata.');
  }
  return { conversation, selfId, messageId: value.messageId, confirmedAt: value.confirmedAt,
    ...(value.raw === undefined ? {} : { raw: value.raw as Record<string, unknown> }) };
}

function confirmedSendKey(receipt: ConfirmedSend): string {
  return JSON.stringify([receipt.conversation.type, receipt.conversation.id, receipt.selfId, receipt.messageId]);
}

export function parseStoredMessage(line: string, filename = 'message record'): StoredMessage {
  try {
    const value: unknown = JSON.parse(line);
    validateRecord(value);
    const stored = value as Partial<StoredMessage>;
    if (stored.v !== 3 || !Number.isSafeInteger(stored.seq) || Number(stored.seq) < 1
      || typeof stored.receivedAt !== 'number' || !Number.isFinite(stored.receivedAt) || stored.receivedAt < 0) {
      throw new Error('Invalid v3 local message metadata; previous formats must remain archived.');
    }
    return value as StoredMessage;
  } catch (cause) { throw new Error(`Invalid JSONL message in ${filename}; restore or repair this journal before continuing.`, { cause }); }
}

export const parseStoredRecord = parseStoredMessage;

function receiptFor(record: StoredMessage, file: string): Receipt {
  return { seq: record.seq, key: receiptKey(record), at: record.receivedAt,
    incoming: !record.outgoing && record.userId !== record.selfId, file, conversation: conversationRef(record.conversation) };
}

/** Durable official-bot inbox. Previous protocol journals and watermarks stay untouched. */
export class GroupStore {
  private readonly receipts: Receipt[] = [];
  private readonly keys = new Set<string>();
  private readonly sentKeys = new Set<string>();
  private readonly confirmedReceipts = new Map<string, ConfirmedSend>();
  private state: State;
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private writeFault?: Error;
  private closePromise?: Promise<void>;
  private readonly cwd: string;
  private readonly groupId: string;
  private readonly conversations: Map<string, Conversation>;
  private readonly lock: { filename: string; token: string };
  private readonly boundAccountId?: string;

  private constructor(cwd: string, config: Pick<GroupConfig, 'id' | 'conversations'>, lock: { filename: string; token: string }, accountId?: string) {
    this.cwd = cwd;
    this.groupId = config.id;
    this.conversations = new Map(config.conversations.map(conversation => [conversationKey(conversation), { ...conversation }]));
    this.lock = lock;
    this.boundAccountId = accountId;
    this.state = { version: 3, groupId: config.id, notifiedThrough: 0, lastNotifiedAt: 0 };
  }

  static async open(cwd: string, config: Pick<GroupConfig, 'id' | 'conversations'>, accountId?: string): Promise<GroupStore> {
    validateGroupId(config.id);
    if (accountId !== undefined) validateOpenId(accountId);
    if (!Array.isArray(config.conversations)) throw new Error('Conversation group needs a conversation list.');
    const keys = config.conversations.map(conversation => conversationKey(validateConversation(conversation)));
    if (new Set(keys).size !== keys.length) throw new Error('Conversation group has duplicate members.');
    const root = path.resolve(cwd);
    await requireDirectory(root);
    await ensureDirectory(path.join(root, '.piq'));
    await ensureDirectory(path.join(root, 'messages'));
    await ensureDirectory(path.join(root, 'messages', 'v3'));
    const lock = await acquireLock(path.join(root, '.piq'));
    try {
      const existingAccount = await readAccount(root);
      if (accountId !== undefined && existingAccount !== undefined && existingAccount !== accountId) {
        throw new Error('This group is bound to a different bot AppID; create a new conversation group for the other account.');
      }
      const store = new GroupStore(root, config, lock, existingAccount ?? accountId);
      await store.restore();
      if (accountId !== undefined && existingAccount === undefined) await createAccountBinding(root, accountId);
      return store;
    }
    catch (error) { await releaseOwnedLock(lock.filename, lock.token); throw error; }
  }

  get lastNotifiedAt(): number { return this.state.lastNotifiedAt; }
  get accountId(): string | undefined { return this.boundAccountId; }

  private async assertAccountBinding(): Promise<void> {
    if (await readAccount(this.cwd) !== this.boundAccountId) {
      throw new Error('Bot account binding changed; reopen this group and use a new group for a different AppID.');
    }
  }

  /** Internal source proof for explicit message actions; never exposes arbitrary history to the model. */
  async findMessage(conversation: Conversation, messageId: string, signal?: AbortSignal): Promise<StoredMessage | undefined> {
    validateMessageId(messageId);
    return this.findRecord(conversation, record => record.messageId === messageId, 'message', signal);
  }

  /** Only a received platform event can authorize an event_id reply anchor. */
  async findEvent(conversation: Conversation, eventId: string, signal?: AbortSignal): Promise<StoredMessage | undefined> {
    validateMessageId(eventId);
    const messages = new Set(['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE']);
    const privateEvents = new Set(['FRIEND_ADD', 'FRIEND_DEL', 'C2C_MSG_REJECT', 'C2C_MSG_RECEIVE']);
    return this.findRecord(conversation, record => {
      const type = record.eventType;
      if (record.outgoing || record.sentByPi || !type || !/^[A-Z][A-Z0-9_]{0,79}$/.test(type) || messages.has(type)
        || !record.messageId.startsWith(`event:${type}:`)
        || !(type === 'INTERACTION_CREATE' || type.startsWith('GROUP_') || privateEvents.has(type))) return false;
      return record.raw?.id === eventId || record.raw?.event_id === eventId;
    }, 'event', signal);
  }

  private async findRecord(conversation: Conversation, matches: (record: StoredMessage) => boolean,
    identity: 'message' | 'event', signal?: AbortSignal): Promise<StoredMessage | undefined> {
    if (this.closing) throw new Error('Group store is closed.');
    const key = this.memberKey(conversation);
    await this.tail;
    await this.assertAccountBinding();
    if (this.boundAccountId === undefined) throw new Error('Bind this group to its bot account before looking up message proof.');
    const lookupSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
    try {
      lookupSignal.throwIfAborted();
      const relative = conversationDirectory(conversation);
      let directory = this.cwd;
      await requireDirectory(directory);
      for (const segment of relative.split('/')) {
        directory = path.join(directory, segment);
        try { await requireDirectory(directory); }
        catch (error) { if (isCode(error, 'ENOENT')) return undefined; throw error; }
      }
      let found: StoredMessage | undefined;
      const files = (await readdir(directory)).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
      for (const file of files) {
        for await (const record of lookupRecords(path.join(directory, file), lookupSignal)) {
          if (conversationKey(record.conversation) !== key) throw new Error('Message journal contains another conversation.');
          if (record.selfId !== this.boundAccountId) throw new Error('Message journal belongs to a different bot account.');
          if (!matches(record)) continue;
          if (found) throw new Error(`Duplicate ${identity} ID in this conversation; the source is ambiguous.`);
          found = record;
        }
      }
      await this.assertAccountBinding();
      lookupSignal.throwIfAborted();
      if (!found) return undefined;
      const confirmation = this.confirmedReceipts.get(receiptKey(found));
      return confirmation ? { ...found, outgoing: true, sentByPi: true,
        ...(confirmation.raw === undefined ? {} : { raw: structuredClone(confirmation.raw) }) } : found;
    } catch (error) {
      if (lookupSignal.aborted) throw new Error('Message lookup was cancelled or timed out.');
      throw error;
    }
  }

  /** Membership must have been persisted and claimed before the caller admits an event. */
  addConversation(conversation: Conversation): void {
    if (this.closing) throw new Error('Group store is closed.');
    const validated = validateConversation(conversation);
    this.conversations.set(conversationKey(validated), { ...validated });
  }

  private memberKey(conversation: Conversation): string {
    const key = conversationKey(validateConversation(conversation));
    if (!this.conversations.has(key)) throw new Error(`Conversation ${key} does not belong to this conversation group.`);
    return key;
  }

  pending(): PendingMessages | null {
    const pending = this.receipts.slice(this.state.notifiedThrough).filter(receipt => receipt.incoming
      && this.conversations.has(conversationKey(receipt.conversation)));
    if (!pending.length) return null;
    const byConversation = new Map<string, PendingMessages['conversations'][number]>();
    for (const receipt of pending) {
      const key = conversationKey(receipt.conversation);
      const item = byConversation.get(key) ?? { conversation: this.conversations.get(key)!, count: 0,
        firstSeq: receipt.seq, lastSeq: receipt.seq, files: [] };
      item.count++; item.lastSeq = receipt.seq;
      if (!item.files.includes(receipt.file)) item.files.push(receipt.file);
      byConversation.set(key, item);
    }
    return { count: pending.length, firstAt: pending[0]!.at, lastAt: pending.at(-1)!.at, through: pending.at(-1)!.seq,
      files: [...new Set(pending.map(receipt => receipt.file))], conversations: [...byConversation.values()] };
  }

  append(record: IncomingRecord): Promise<boolean> {
    if (this.closing) return Promise.reject(new Error('Group store is closed.'));
    return this.enqueue(async () => {
      if (this.writeFault) throw this.writeFault;
      validateRecord(record); this.memberKey(record.conversation);
      await this.assertAccountBinding();
      if (this.boundAccountId !== undefined && record.selfId !== this.boundAccountId) {
        throw new Error('Message belongs to a different bot account than this conversation group.');
      }
      const key = receiptKey(record);
      if (this.keys.has(key)) {
        if (record.sentByPi === true && !this.sentKeys.has(key)) await this.confirmExistingSend(record, key);
        return false;
      }
      const at = Date.now();
      const directoryName = conversationDirectory(record.conversation);
      const filename = `${directoryName}/${journalDate(at)}.jsonl`;
      const stored: StoredMessage = { v: 3, seq: (this.receipts.at(-1)?.seq ?? 0) + 1, receivedAt: at,
        conversation: conversationRef(record.conversation), messageId: record.messageId,
        userId: record.userId, selfId: record.selfId, sender: record.sender, time: record.time,
        rawText: record.rawText, outgoing: record.outgoing, ...(record.sentByPi ? { sentByPi: true } : {}),
        ...(record.botAuthored !== undefined ? { botAuthored: record.botAuthored } : {}),
        ...(record.eventType === undefined ? {} : { eventType: record.eventType }),
        ...(record.attachments === undefined ? {} : { attachments: record.attachments }),
        ...(record.raw === undefined ? {} : { raw: record.raw }) };
      const entry = JSON.stringify(stored) + '\n';
      const receipt = receiptFor(parseStoredMessage(entry, filename), filename);
      try {
        let directory = this.cwd;
        for (const segment of directoryName.split('/')) { directory = path.join(directory, segment); await ensureDirectory(directory); }
        const target = path.join(this.cwd, filename);
        try { await requireFile(target); } catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
        const handle = await open(target, 'a', 0o600);
        try { await handle.writeFile(entry, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      } catch (cause) {
        this.writeFault = new Error('Journal write did not complete; reopen this group before accepting more messages.', { cause });
        throw this.writeFault;
      }
      this.receipts.push(receipt); this.keys.add(key);
      if (record.sentByPi === true) this.sentKeys.add(key);
      return true;
    });
  }

  /** An echo can win the race to the journal. Keep the local send receipt separately. */
  private async confirmExistingSend(record: IncomingRecord, key: string): Promise<void> {
    const receipt = confirmedSend(JSON.parse(JSON.stringify({ conversation: conversationRef(record.conversation),
      selfId: record.selfId, messageId: record.messageId, confirmedAt: Date.now(),
      ...(record.raw === undefined ? {} : { raw: record.raw }) })));
    const filename = path.join(this.cwd, '.piq', SENT_RECEIPTS_FILE);
    await requireDirectory(path.join(this.cwd, '.piq'));
    try { await requireFile(filename); } catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
    const next = new Map(this.confirmedReceipts);
    next.set(key, receipt);
    await atomicJson(filename, { version: 3, groupId: this.groupId, entries: [...next.values()] });
    this.confirmedReceipts.set(key, receipt);
    this.sentKeys.add(key);
    const original = this.receipts.find(item => item.key === key);
    if (original) original.incoming = false;
  }

  private async restoreConfirmedSends(): Promise<void> {
    const filename = path.join(this.cwd, '.piq', SENT_RECEIPTS_FILE);
    try {
      await requireFile(filename);
      const value: unknown = JSON.parse(await readFile(filename, 'utf8'));
      if (!object(value) || value.version !== 3 || value.groupId !== this.groupId || !Array.isArray(value.entries)
        || Object.keys(value).some(key => !['version', 'groupId', 'entries'].includes(key))) throw new Error('Invalid confirmed send receipt state.');
      for (const item of value.entries) {
        const receipt = confirmedSend(item);
        if (this.boundAccountId !== undefined && receipt.selfId !== this.boundAccountId) throw new Error('Confirmed send receipt belongs to another bot account.');
        const key = confirmedSendKey(receipt);
        if (!this.keys.has(key)) throw new Error('Confirmed send receipt has no matching journal message.');
        if (this.confirmedReceipts.has(key)) throw new Error('Duplicate confirmed send receipt.');
        this.confirmedReceipts.set(key, receipt);
        this.sentKeys.add(key);
      }
      for (const receipt of this.receipts) if (this.confirmedReceipts.has(receipt.key)) receipt.incoming = false;
    } catch (cause) {
      if (isCode(cause, 'ENOENT')) return;
      throw new Error('Cannot read confirmed send receipts; inspect .piq/sent-receipts-v3.json before continuing.', { cause });
    }
  }

  acknowledge(through: number, at = Date.now()): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Group store is closed.'));
    return this.enqueue(async () => {
      const lastSeq = this.receipts.at(-1)?.seq ?? 0;
      if (!Number.isSafeInteger(through) || through < 0 || through > lastSeq) throw new Error('Invalid notification watermark.');
      if (!Number.isFinite(at) || at < 0) throw new Error('Invalid notification timestamp.');
      if (through <= this.state.notifiedThrough) return;
      const next: State = { ...this.state, notifiedThrough: through, lastNotifiedAt: at };
      const filename = path.join(this.cwd, '.piq', STATE_FILE);
      await requireDirectory(path.join(this.cwd, '.piq'));
      try { await requireFile(filename); } catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
      await atomicJson(filename, next);
      this.state = next;
    });
  }

  private async restore(): Promise<void> {
    try {
      const filename = path.join(this.cwd, '.piq', STATE_FILE);
      await requireFile(filename);
      const state: unknown = JSON.parse(await readFile(filename, 'utf8'));
      if (!object(state) || state.version !== 3 || state.groupId !== this.groupId || !Number.isSafeInteger(state.notifiedThrough)
        || Number(state.notifiedThrough) < 0 || typeof state.lastNotifiedAt !== 'number' || !Number.isFinite(state.lastNotifiedAt)
        || state.lastNotifiedAt < 0) throw new Error('Invalid notification state; restore or repair .piq/state-v3.json.');
      this.state = state as unknown as State;
    } catch (cause) {
      if (!isCode(cause, 'ENOENT')) throw new Error('Cannot read notification state; restore or repair .piq/state-v3.json.', { cause });
    }
    const root = path.join(this.cwd, 'messages', 'v3');
    for (const typeEntry of await readdir(root, { withFileTypes: true })) {
      if (typeEntry.name !== 'group' && typeEntry.name !== 'private') throw new Error('Invalid official conversation journal directory.');
      const typeDirectory = path.join(root, typeEntry.name);
      await requireDirectory(typeDirectory);
      for (const entry of await readdir(typeDirectory, { withFileTypes: true })) {
        if (!/^[a-f0-9]{64}$/.test(entry.name)) throw new Error('Invalid official OpenID journal directory.');
        const directory = path.join(typeDirectory, entry.name);
        await requireDirectory(directory);
        for (const file of (await readdir(directory)).sort()) {
          if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) continue;
          const filename = path.join(directory, file);
          await requireFile(filename);
          const contents = await readFile(filename, 'utf8');
          if (contents && !contents.endsWith('\n')) throw new Error(`Uncommitted final JSONL record in ${filename}; restore or repair this journal.`);
          const relative = `messages/v3/${typeEntry.name}/${entry.name}/${file}`;
          for (const line of contents ? contents.slice(0, -1).split('\n') : []) {
            const record = parseStoredMessage(line, relative);
            if (this.boundAccountId !== undefined && record.selfId !== this.boundAccountId) {
              throw new Error('Existing v3 messages belong to a different bot account; create a new conversation group for another AppID.');
            }
            if (conversationDirectory(record.conversation) !== `messages/v3/${typeEntry.name}/${entry.name}`) {
              throw new Error(`Journal contains a message from another conversation: ${relative}`);
            }
            const receipt = receiptFor(record, relative);
            if (this.keys.has(receipt.key)) throw new Error(`Duplicate official message identity in ${relative}.`);
            this.keys.add(receipt.key); this.receipts.push(receipt);
            if (record.sentByPi === true) this.sentKeys.add(receipt.key);
          }
        }
      }
    }
    this.receipts.sort((a, b) => a.seq - b.seq);
    if (this.receipts.some((receipt, index) => receipt.seq !== index + 1)) throw new Error('Journal sequence is duplicated or missing; restore or repair the logs.');
    if (this.state.notifiedThrough > this.receipts.length) throw new Error('Notification watermark is ahead of the available journal; restore or repair the logs.');
    await this.restoreConfirmedSends();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation);
    this.tail = task.catch(() => {});
    return task;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.tail.then(() => releaseOwnedLock(this.lock.filename, this.lock.token));
    return this.closePromise;
  }
}
