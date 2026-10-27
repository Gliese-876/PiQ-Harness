import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from 'node:timers/promises';
import { compareCursors, messageCursor, type HistoryCursor, type PokeEvent } from './transport.ts';
import { conversationKey, parseConversationKey, validateConversation, type Conversation } from './conversations.ts';
import { validateGroupId, type GroupConfig } from './config.ts';

export interface IncomingRecord {
  kind?: 'message';
  messageId: string;
  messageSeq?: string;
  conversation: Conversation;
  userId: string;
  selfId: string;
  sender: string;
  /** OneBot event time, in seconds. */
  time: number;
  rawText: string;
  segments: Array<{ type: string; data: Record<string, unknown> }>;
  outgoing: boolean;
}

/** One committed JSONL line: local ordering plus the complete QQ message. */
export interface StoredMessage extends IncomingRecord {
  v: 2;
  seq: number;
  /** Time PiQ received this message, in milliseconds. */
  receivedAt: number;
}

export interface StoredPoke extends PokeEvent {
  v: 2;
  seq: number;
  receivedAt: number;
  messageId?: never;
  messageSeq?: never;
}

export type StoredRecord = StoredMessage | StoredPoke;

export interface PendingMessages {
  count: number;
  firstAt: number;
  lastAt: number;
  through: number;
  /** Paths relative to this group's directory. */
  files: string[];
  conversations: Array<{ conversation: Conversation; count: number; firstSeq: number; lastSeq: number; files: string[] }>;
}

interface Receipt {
  seq: number;
  key: string;
  at: number;
  incoming: boolean;
  messageId?: string;
  file: string;
  remote?: HistoryCursor;
  conversation: Conversation;
}

interface State {
  version: 2;
  groupId: string;
  notifiedThrough: number;
  lastNotifiedAt: number;
}

interface Owner {
  version: 1;
  pid: number;
  token: string;
}

const OWN_ECHO_WINDOW_MS = 5 * 60_000;

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isCode(error, "ESRCH")) return false;
    if (isCode(error, "EPERM")) return true;
    throw error;
  }
}

function parseOwner(contents: string, filename: string): Owner {
  let owner: Partial<Owner>;
  try {
    owner = JSON.parse(contents) as Partial<Owner>;
  } catch {
    throw new Error(`Cannot read group lock ${filename}; inspect it before removing it.`);
  }
  if (
    !owner || owner.version !== 1 || !Number.isSafeInteger(owner.pid) ||
    (owner.pid ?? 0) <= 0 || typeof owner.token !== "string" || !owner.token
  ) {
    throw new Error(`Invalid group lock ${filename}; inspect it before removing it.`);
  }
  return owner as Owner;
}

async function writeExclusive(filename: string, contents: string): Promise<void> {
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function releaseOwnedLock(filename: string, token: string): Promise<void> {
  try {
    const owner = parseOwner(await readFile(filename, "utf8"), filename);
    if (owner.token === token) await unlink(filename);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

async function acquireLock(directory: string): Promise<{ filename: string; token: string }> {
  const filename = path.join(directory, "owner.lock");
  const token = randomUUID();
  const contents = JSON.stringify({ version: 1, pid: process.pid, token } satisfies Owner);
  try {
    await writeExclusive(filename, contents);
    return { filename, token };
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  }

  // Serialize stale-owner recovery. A live lock is never replaced. If a process
  // crashes during this short recovery step, leave an inspectable recovery lock.
  const recoveryFile = path.join(directory, "recovery.lock");
  try {
    await writeExclusive(recoveryFile, contents);
  } catch (error) {
    if (isCode(error, "EEXIST")) {
      throw new Error(`Group lock recovery is already in progress: ${recoveryFile}. Inspect its owner if it persists.`);
    }
    throw error;
  }
  try {
    let owner: Owner | undefined;
    try {
      owner = parseOwner(await readFile(filename, "utf8"), filename);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
    if (owner && processExists(owner.pid)) {
      throw new Error(`This group is already open in process ${owner.pid}: ${filename}`);
    }
    if (owner) await unlink(filename);
    await writeExclusive(filename, contents);
    return { filename, token };
  } finally {
    await releaseOwnedLock(recoveryFile, token);
  }
}

async function atomicJson(filename: string, data: unknown): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeExclusive(temporary, `${JSON.stringify(data, null, 2)}\n`);
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, filename); break; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 5
          || !['EPERM', 'EACCES', 'EBUSY'].some(code => isCode(error, code))) throw error;
        await delay(20 * (attempt + 1));
      }
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isCode(error, "ENOENT")) throw error;
    });
  }
}

function journalDate(timestamp: number): string {
  const date = new Date(timestamp);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

async function requireDirectory(directory: string): Promise<void> {
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Message directory must be an ordinary directory: ${directory}`);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateCursor(value: unknown): asserts value is HistoryCursor | null {
  if (value === null) return;
  if (!object(value) || typeof value.messageId !== 'string' || !/^-?\d+$/.test(value.messageId)
    || !Number.isSafeInteger(Number(value.messageId)) || typeof value.time !== 'number'
    || !Number.isFinite(value.time) || value.time < 0 || (value.messageSeq !== undefined
      && (typeof value.messageSeq !== 'string' || !/^\d+$/.test(value.messageSeq)
        || !Number.isSafeInteger(Number(value.messageSeq))))) throw new Error('Invalid PiQ history cursor.');
}

function validateRecord(value: unknown): asserts value is IncomingRecord {
  if (!object(value)) throw new Error('Message must be an object.');
  if (value.kind !== undefined && value.kind !== 'message') throw new Error('Invalid message kind.');
  if (!object(value.conversation) || typeof value.conversation.id !== 'string') throw new Error('Message conversation ID must be a string.');
  if (value.conversation.type === 'temporary' && typeof value.conversation.sourceGroupId !== 'string') {
    throw new Error('Temporary conversation source group must be a string.');
  }
  validateConversation(value.conversation);
  if ('groupId' in value || 'sourceGroupId' in value) throw new Error('Messages must use an explicit conversation.');
  if (typeof value.messageId !== 'string' || !/^-?\d+$/.test(value.messageId) || !Number.isSafeInteger(Number(value.messageId))) {
    throw new Error('Message ID must be an integer string.');
  }
  if (value.messageSeq !== undefined && (typeof value.messageSeq !== 'string' || !/^\d+$/.test(value.messageSeq)
    || !Number.isSafeInteger(Number(value.messageSeq)))) throw new Error('Message sequence must be a nonnegative integer string.');
  if (typeof value.time !== 'number' || !Number.isFinite(value.time) || value.time < 0) throw new Error('Message time must be seconds since the Unix epoch.');
  if (typeof value.userId !== 'string' || !value.userId || typeof value.selfId !== 'string' || !value.selfId) {
    throw new Error('Message user IDs must be nonempty strings.');
  }
  if (typeof value.sender !== 'string' || typeof value.rawText !== 'string' || typeof value.outgoing !== 'boolean'
    || !Array.isArray(value.segments) || value.segments.some(segment => !object(segment)
      || typeof segment.type !== 'string' || !segment.type || !object(segment.data))) {
    throw new Error('Invalid message content.');
  }
}

function validatePoke(value: unknown): asserts value is PokeEvent {
  if (!object(value) || value.kind !== 'poke') throw new Error('Invalid poke kind.');
  if ('messageId' in value || 'messageSeq' in value) throw new Error('Pokes do not have QQ message IDs or sequences.');
  if (value.source !== 'notice' && value.source !== 'action') throw new Error('Invalid poke source.');
  if (typeof value.eventId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.eventId)) {
    throw new Error('Poke event ID must be a local UUID.');
  }
  if (!object(value.conversation) || typeof value.conversation.id !== 'string'
    || !['group', 'private'].includes(String(value.conversation.type))) throw new Error('Invalid poke conversation.');
  validateConversation(value.conversation);
  if ('groupId' in value || 'sourceGroupId' in value) throw new Error('Pokes must use an explicit conversation.');
  for (const field of ['userId', 'selfId', 'targetId']) {
    const identifier = value[field];
    if (typeof identifier !== 'string' || !/^[1-9]\d*$/.test(identifier) || !Number.isSafeInteger(Number(identifier))) {
      throw new Error('Poke user IDs must be positive integer strings.');
    }
  }
  if (typeof value.time !== 'number' || !Number.isFinite(value.time) || value.time < 0) throw new Error('Invalid poke time.');
  if (typeof value.outgoing !== 'boolean' || value.outgoing !== (value.userId === value.selfId)) throw new Error('Invalid poke direction.');
  if (value.source === 'action' && !value.outgoing) throw new Error('A local poke action must be outgoing.');
  if (typeof value.sender !== 'string' || typeof value.rawText !== 'string'
    || !Array.isArray(value.segments) || value.segments.some(segment => !object(segment)
      || typeof segment.type !== 'string' || !segment.type || !object(segment.data))) throw new Error('Invalid poke content.');
}

function receiptKey(record: IncomingRecord | PokeEvent): string {
  const identity = conversationKey(record.conversation);
  if (record.kind === 'poke') return `${identity}:self:${record.selfId}:poke:${record.eventId}`;
  const scope = record.conversation.type !== 'group' ? `${identity}:self:${record.selfId}:sender:${record.userId}` : identity;
  return record.messageSeq === undefined
    ? `${scope}:id:${record.messageId}:time:${record.time}`
    : `${scope}:seq:${record.messageSeq}`;
}

function ownKey(record: Pick<IncomingRecord, 'conversation' | 'messageId'>): string {
  return `${conversationKey(record.conversation)}:${record.messageId}`;
}

function conversationRef(conversation: Conversation): Conversation {
  const { name: _name, ...ref } = validateConversation(conversation);
  return ref;
}

function conversationPath(conversation: Conversation): string {
  return conversation.type === 'temporary'
    ? `messages/temporary/${conversation.sourceGroupId}/${conversation.id}`
    : `messages/${conversation.type}/${conversation.id}`;
}

export function parseStoredRecord(line: string, filename = 'message record'): StoredRecord {
  try {
    const value: unknown = JSON.parse(line);
    if (object(value) && value.kind === 'poke') validatePoke(value); else validateRecord(value);
    const stored = value as Partial<StoredRecord>;
    if (stored.v !== 2 || !Number.isSafeInteger(stored.seq) || (stored.seq ?? 0) < 1
      || typeof stored.receivedAt !== 'number' || !Number.isFinite(stored.receivedAt) || stored.receivedAt < 0) {
      throw new Error('Invalid local message metadata.');
    }
    return value as StoredRecord;
  } catch (cause) {
    throw new Error(`Invalid JSONL message in ${filename}; restore or repair this journal before continuing.`, { cause });
  }
}

export function parseStoredMessage(line: string, filename = 'message record'): StoredMessage {
  const record = parseStoredRecord(line, filename);
  if (record.kind === 'poke') throw new Error(`Expected a QQ message in ${filename}, received a poke event.`);
  return record;
}

function receiptFor(record: StoredRecord, filename: string): Receipt {
  return {
    seq: record.seq, key: receiptKey(record), at: record.receivedAt,
    incoming: !record.outgoing && record.userId !== record.selfId,
    ...(record.kind === 'poke' ? {} : { messageId: record.messageId, remote: messageCursor(record) }), file: filename,
    conversation: conversationRef(record.conversation),
  };
}

/** Durable group inbox. Each newline commits one complete JSON message. */
export class GroupStore {
  private readonly receipts: Receipt[] = [];
  private readonly keys = new Set<string>();
  private readonly ownIds = new Map<string, { at: number; messageSeq?: string }>();
  private state: State;
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private writeFault?: Error;
  private closePromise?: Promise<void>;
  private readonly cwd: string;
  private readonly groupId: string;
  private readonly conversations: Map<string, Conversation>;
  private readonly lock: { filename: string; token: string };
  private readonly historyCursors = new Map<string, HistoryCursor | null>();
  private readonly frozenHistoryCursors = new Map<string, HistoryCursor | null>();

  private constructor(
    cwd: string,
    config: Pick<GroupConfig, 'id' | 'conversations'>,
    lock: { filename: string; token: string },
  ) {
    this.cwd = cwd;
    this.groupId = config.id;
    this.conversations = new Map(config.conversations.map(conversation => [conversationKey(conversation), { ...conversation }]));
    this.lock = lock;
    this.state = { version: 2, groupId: config.id, notifiedThrough: 0, lastNotifiedAt: 0 };
  }

  static async open(cwd: string, config: Pick<GroupConfig, 'id' | 'conversations'>): Promise<GroupStore> {
    validateGroupId(config.id);
    if (!Array.isArray(config.conversations)) throw new Error('Conversation group needs a conversation list.');
    const keys = config.conversations.map(conversation => conversationKey(validateConversation(conversation)));
    if (new Set(keys).size !== keys.length) throw new Error('Conversation group has duplicate members.');
    const root = path.resolve(cwd);
    await mkdir(path.join(root, ".piq"), { recursive: true });
    await mkdir(path.join(root, "messages"), { recursive: true });
    await requireDirectory(path.join(root, 'messages'));
    const lock = await acquireLock(path.join(root, ".piq"));
    const store = new GroupStore(root, config, lock);
    try {
      await store.restore();
      return store;
    } catch (error) {
      await releaseOwnedLock(lock.filename, lock.token);
      throw error;
    }
  }

  get lastNotifiedAt(): number {
    return this.state.lastNotifiedAt;
  }

  /** The caller must persist and claim membership before admitting live events. */
  addConversation(conversation: Conversation): void {
    if (this.closing) throw new Error('Group store is closed.');
    const validated = validateConversation(conversation);
    this.conversations.set(conversationKey(validated), { ...validated });
  }

  /** Freeze the restart position before newly arriving live messages can move it. */
  freezeHistoryCursor(conversation: Conversation): Promise<HistoryCursor | null> {
    if (this.closing) return Promise.reject(new Error('Group store is closed.'));
    return this.enqueue(async () => {
      const key = this.memberKey(conversation);
      if (this.historyCursors.has(key)) return this.historyCursors.get(key)!;
      if (this.frozenHistoryCursors.has(key)) {
        const frozen = this.frozenHistoryCursors.get(key)!;
        await this.writeHistoryCursor(key, frozen);
        return frozen;
      }
      let latest: HistoryCursor | null = null;
      for (const receipt of this.receipts) {
        if (conversationKey(receipt.conversation) !== key) continue;
        const cursor = receipt.remote;
        if (!cursor) continue;
        if (!latest || compareCursors(cursor, latest, conversation.type) >= 0) latest = cursor;
      }
      // Retain the original snapshot if persistence fails. Live arrivals must
      // not shift a later retry past an offline gap.
      this.frozenHistoryCursors.set(key, latest);
      await this.writeHistoryCursor(key, latest);
      return latest;
    });
  }

  saveHistoryCursor(conversation: Conversation, cursor: HistoryCursor | null): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Group store is closed.'));
    return this.enqueue(() => this.writeHistoryCursor(this.memberKey(conversation), cursor));
  }

  private memberKey(conversation: Conversation): string {
    const key = conversationKey(validateConversation(conversation));
    if (!this.conversations.has(key)) throw new Error(`Conversation ${key} does not belong to this conversation group.`);
    return key;
  }

  private async writeHistoryCursor(key: string, cursor: HistoryCursor | null): Promise<void> {
    validateCursor(cursor);
    const cursors = Object.fromEntries(this.historyCursors);
    cursors[key] = cursor;
    await atomicJson(path.join(this.cwd, '.piq', 'history.json'), { version: 2, groupId: this.groupId, cursors });
    this.historyCursors.set(key, cursor);
    this.frozenHistoryCursors.delete(key);
  }

  pending(): PendingMessages | null {
    const pending = this.receipts.slice(this.state.notifiedThrough).filter((receipt) => receipt.incoming
      && this.conversations.has(conversationKey(receipt.conversation)));
    if (!pending.length) return null;
    const byConversation = new Map<string, PendingMessages['conversations'][number]>();
    for (const receipt of pending) {
      const key = conversationKey(receipt.conversation);
      const item = byConversation.get(key) ?? { conversation: this.conversations.get(key)!, count: 0,
        firstSeq: receipt.seq, lastSeq: receipt.seq, files: [] };
      item.count++;
      item.lastSeq = receipt.seq;
      if (!item.files.includes(receipt.file)) item.files.push(receipt.file);
      byConversation.set(key, item);
    }
    return {
      count: pending.length,
      firstAt: pending[0]!.at,
      lastAt: pending[pending.length - 1]!.at,
      through: pending[pending.length - 1]!.seq,
      files: [...new Set(pending.map((receipt) => receipt.file))],
      conversations: [...byConversation.values()],
    };
  }

  append(record: IncomingRecord): Promise<boolean> {
    return this.appendRecord(record, false);
  }

  appendPoke(record: PokeEvent): Promise<boolean> {
    return this.appendRecord(record, true);
  }

  private appendRecord(record: IncomingRecord | PokeEvent, poke: boolean): Promise<boolean> {
    if (this.closing) return Promise.reject(new Error("Group store is closed."));
    return this.enqueue(async () => {
      if (this.writeFault) throw this.writeFault;
      if (poke) validatePoke(record); else validateRecord(record);
      this.memberKey(record.conversation);
      const key = receiptKey(record);
      if (this.keys.has(key)) return false;
      const at = Date.now();
      const incoming = !record.outgoing && record.userId !== record.selfId;
      const ownIdentity = record.kind === 'poke' ? undefined : ownKey(record);
      const previousOwn = ownIdentity === undefined ? undefined : this.ownIds.get(ownIdentity);
      if (record.kind !== 'poke' && ownIdentity !== undefined && !incoming && previousOwn && Math.abs(at - previousOwn.at) <= OWN_ECHO_WINDOW_MS
        && (record.messageSeq === undefined || previousOwn.messageSeq === undefined || record.messageSeq === previousOwn.messageSeq)) {
        // A confirmed local send has no QQ sequence yet. Remember its echo's
        // sequence so another message with a colliding 32-bit ID stays distinct.
        if (record.messageSeq !== undefined) this.ownIds.set(ownIdentity, { at: previousOwn.at, messageSeq: record.messageSeq });
        return false;
      }
      const directoryName = conversationPath(record.conversation);
      const filename = `${directoryName}/${journalDate(at)}.jsonl`;
      const common = {
        v: 2 as const, seq: (this.receipts.at(-1)?.seq ?? 0) + 1, receivedAt: at,
        conversation: conversationRef(record.conversation),
        userId: record.userId, selfId: record.selfId, sender: record.sender, time: record.time,
        rawText: record.rawText, segments: record.segments, outgoing: record.outgoing,
      };
      const stored: StoredRecord = record.kind === 'poke'
        ? { ...common, kind: 'poke', eventId: record.eventId, source: record.source, targetId: record.targetId }
        : { ...common, messageId: record.messageId, messageSeq: record.messageSeq };
      const receipt = receiptFor(stored, filename);
      const entry = JSON.stringify(stored) + '\n';
      try {
        await requireDirectory(path.join(this.cwd, 'messages'));
        let directory = path.join(this.cwd, 'messages');
        for (const segment of directoryName.split('/').slice(1)) {
          directory = path.join(directory, segment);
          await mkdir(directory, { recursive: true });
          await requireDirectory(directory);
        }
        const target = path.join(this.cwd, filename);
        try { const entry = await lstat(target); if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Message journal must be an ordinary file.'); }
        catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
        const handle = await open(target, "a", 0o600);
        try {
          await handle.writeFile(entry, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        // A failed append may have written part or all of its record. Reopen
        // and reconstruct the journal before assigning another sequence number.
        this.writeFault = new Error("Journal write did not complete; reopen this group before accepting more messages.", { cause: error });
        throw this.writeFault;
      }
      this.receipts.push(receipt);
      this.keys.add(key);
      if (record.kind !== 'poke' && ownIdentity !== undefined && !incoming) this.ownIds.set(ownIdentity, { at, messageSeq: record.messageSeq });
      return true;
    });
  }

  acknowledge(through: number, at = Date.now()): Promise<void> {
    if (this.closing) return Promise.reject(new Error("Group store is closed."));
    return this.enqueue(async () => {
      const lastSeq = this.receipts.at(-1)?.seq ?? 0;
      if (!Number.isSafeInteger(through) || through < 0 || through > lastSeq) throw new Error("Invalid notification watermark.");
      if (!Number.isFinite(at) || at < 0) throw new Error("Invalid notification timestamp.");
      if (through <= this.state.notifiedThrough) return;
      const next: State = { ...this.state, notifiedThrough: through, lastNotifiedAt: at };
      await atomicJson(path.join(this.cwd, ".piq", "state.json"), next);
      this.state = next;
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.tail.then(() => releaseOwnedLock(this.lock.filename, this.lock.token));
    return this.closePromise;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async restore(): Promise<void> {
    try {
      const history = JSON.parse(await readFile(path.join(this.cwd, '.piq', 'history.json'), 'utf8'));
      if (history?.version !== 2 || history.groupId !== this.groupId || !object(history.cursors)) {
        throw new Error('Invalid PiQ history cursors; restore or repair .piq/history.json.');
      }
      for (const [key, cursor] of Object.entries(history.cursors)) {
        parseConversationKey(key);
        validateCursor(cursor);
        this.historyCursors.set(key, cursor as HistoryCursor | null);
      }
    } catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
    for (const type of ['group', 'private', 'temporary'] as const) {
      const typeDirectory = path.join(this.cwd, 'messages', type);
      let members: string[];
      try { await requireDirectory(typeDirectory); members = (await readdir(typeDirectory)).sort(); }
      catch (error) { if (isCode(error, 'ENOENT')) continue; throw error; }
      for (const id of members) {
        if (type === 'temporary') {
          const sourceGroupId = id;
          // Validate the outer source group before using it as a path segment.
          validateConversation({ type, sourceGroupId, id: '1' });
          const sourceDirectory = path.join(typeDirectory, sourceGroupId);
          await requireDirectory(sourceDirectory);
          for (const peerId of (await readdir(sourceDirectory)).sort()) {
            await this.restoreConversation(validateConversation({ type, id: peerId, sourceGroupId }));
          }
        } else {
          await this.restoreConversation(validateConversation({ type, id }));
        }
      }
    }
    this.receipts.sort((left, right) => left.seq - right.seq);
    for (let index = 0; index < this.receipts.length; index++) {
      const receipt = this.receipts[index]!;
      if (receipt.seq !== index + 1 || this.keys.has(receipt.key)) {
        throw new Error("PiQ journals have duplicate or missing message sequences; restore or repair them before continuing.");
      }
      this.keys.add(receipt.key);
      if (!receipt.incoming && receipt.remote) this.ownIds.set(ownKey({ conversation: receipt.conversation, messageId: receipt.remote.messageId }), { at: receipt.at, messageSeq: receipt.remote.messageSeq });
    }
    const filename = path.join(this.cwd, ".piq", "state.json");
    let saved: Partial<State>;
    try {
      saved = JSON.parse(await readFile(filename, "utf8")) as Partial<State>;
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw new Error(`Cannot read PiQ notification state ${filename}.`, { cause: error });
    }
    if (
      !saved || saved.version !== 2 || saved.groupId !== this.groupId ||
      !Number.isSafeInteger(saved.notifiedThrough) || (saved.notifiedThrough ?? -1) < 0 ||
      (saved.notifiedThrough ?? 0) > (this.receipts.at(-1)?.seq ?? 0) ||
      !Number.isFinite(saved.lastNotifiedAt) || (saved.lastNotifiedAt ?? -1) < 0
    ) {
      throw new Error(`Invalid PiQ notification state ${filename}; restore or repair it before continuing.`);
    }
    this.state = saved as State;
  }

  private async restoreConversation(conversation: Conversation): Promise<void> {
    const directoryName = conversationPath(conversation);
    const directory = path.join(this.cwd, directoryName);
    await requireDirectory(directory);
    const files = (await readdir(directory)).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort();
    for (const file of files) {
      const relative = `${directoryName}/${file}`;
      const target = path.join(directory, file);
      const entry = await lstat(target);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Message journal must be an ordinary file: ${relative}`);
      const contents = await readFile(target, 'utf8');
      if (contents && !contents.endsWith('\n')) {
        throw new Error(`Incomplete JSONL record in ${relative}; restore or repair its final line before continuing.`);
      }
      const lines = contents ? contents.slice(0, -1).split('\n') : [];
      for (let index = 0; index < lines.length; index++) {
        const record = parseStoredRecord(lines[index]!, `${relative}:${index + 1}`);
        if (conversationKey(record.conversation) !== conversationKey(conversation)) {
          throw new Error(`Journal ${relative} contains a message from another conversation.`);
        }
        this.receipts.push(receiptFor(record, relative));
      }
    }
  }
}
