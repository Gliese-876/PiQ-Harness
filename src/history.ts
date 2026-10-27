import { setTimeout as delay } from 'node:timers/promises';
import { compareCursors, messageCursor, type ConversationEvent, type HistoryCursor } from './transport.ts';
import { conversationKey, validateConversation, type Conversation } from './conversations.ts';

export interface HistoryStore {
  freezeHistoryCursor(conversation: Conversation): Promise<HistoryCursor | null>;
  saveHistoryCursor(conversation: Conversation, cursor: HistoryCursor | null): Promise<void>;
  append(event: ConversationEvent): Promise<boolean>;
}

export interface HistoryOptions {
  conversation: Conversation;
  store: HistoryStore;
  fetch(cursor: HistoryCursor | null, count: number, signal: AbortSignal): Promise<ConversationEvent[]>;
  changed(): void;
  error(error: unknown): void;
  /** Tests can reduce these; production work is paced in batches. */
  pageSize?: number;
  batchPages?: number;
  batchDelayMs?: number;
  /** Connected failures retry on this schedule, repeating its final delay. */
  retryDelaysMs?: readonly number[];
}

function sameMessage(left: HistoryCursor, right: HistoryCursor): boolean {
  return left.messageId === right.messageId && (
    left.messageSeq === undefined || right.messageSeq === undefined || left.messageSeq === right.messageSeq
  );
}

/** Catch up to a snapshot, then let the live socket advance the durable cursor. */
export class HistorySync {
  private readonly options: HistoryOptions;
  private controller?: AbortController;
  private task?: Promise<void>;
  private connected = false;
  private synchronized = false;
  private latestLive?: HistoryCursor;
  private generation = 0;
  private currentCursor: HistoryCursor | null = null;
  private readonly retryDelaysMs: readonly number[];
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryFailures = 0;
  private errorMessage?: string;
  private retryDueAt?: number;
  running = false;

  constructor(options: HistoryOptions) {
    this.options = { ...options, conversation: validateConversation(options.conversation) };
    const retryDelays = options.retryDelaysMs ?? [2_000, 5_000, 10_000, 30_000];
    if (!Array.isArray(retryDelays) || !retryDelays.length || retryDelays.length > 16
      || retryDelays.some(value => !Number.isSafeInteger(value) || value < 1 || value > 3_600_000)) {
      throw new Error('History retry delays must contain 1 to 16 positive integer millisecond values, at most one hour each.');
    }
    this.retryDelaysMs = [...retryDelays];
  }

  get lastError(): string | undefined { return this.errorMessage; }
  get nextRetryAt(): number | undefined { return this.retryDueAt; }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const changed = message !== this.errorMessage;
    this.errorMessage = message;
    if (changed) this.options.error(error);
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryDueAt = undefined;
  }

  private scheduleRetry(generation: number): void {
    this.clearRetry();
    const delayMs = this.retryDelaysMs[Math.min(this.retryFailures, this.retryDelaysMs.length - 1)]!;
    this.retryFailures = Math.min(this.retryFailures + 1, this.retryDelaysMs.length - 1);
    this.retryDueAt = Date.now() + delayMs;
    this.retryTimer = setTimeout(() => {
      if (!this.connected || generation !== this.generation) return;
      this.retryTimer = undefined;
      this.retryDueAt = undefined;
      this.retry();
    }, delayMs);
    this.retryTimer.unref();
  }

  private compare(left: HistoryCursor, right: HistoryCursor): number {
    return compareCursors(left, right, this.options.conversation.type);
  }

  private reached(cursor: HistoryCursor, target: HistoryCursor): boolean {
    return sameMessage(cursor, target) || this.compare(cursor, target) > 0;
  }

  private async fetch(cursor: HistoryCursor | null, count: number, signal: AbortSignal): Promise<ConversationEvent[]> {
    const events = await this.options.fetch(cursor, count, signal);
    const key = conversationKey(this.options.conversation);
    if (events.some(event => conversationKey(event.conversation) !== key)) {
      throw new Error(`历史接口返回了不属于 ${key} 的消息，已保留补拉位置。`);
    }
    return events;
  }

  connect(): void {
    this.disconnect();
    this.connected = true;
    this.retry();
  }

  disconnect(): void {
    this.clearRetry();
    this.retryFailures = 0;
    this.generation++;
    this.connected = false;
    this.synchronized = false;
    this.running = false;
    this.latestLive = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }

  close(): void { this.disconnect(); }

  retry(): void {
    if (!this.connected || this.running) return;
    this.clearRetry();
    this.running = true;
    this.synchronized = false;
    const generation = this.generation;
    const controller = this.controller = new AbortController();
    let failed = false;
    this.task = this.catchUp(controller.signal).then(() => {
      if (generation === this.generation && this.connected && !controller.signal.aborted) {
        this.synchronized = true;
        this.retryFailures = 0;
        this.errorMessage = undefined;
      }
    }).catch(error => {
      if (!controller.signal.aborted && generation === this.generation && this.connected) {
        failed = true;
        this.reportError(error);
      }
    }).finally(() => {
      if (generation !== this.generation) return;
      this.running = false;
      if (failed && this.connected && !controller.signal.aborted) this.scheduleRetry(generation);
      this.options.changed();
    });
  }

  async receive(event: ConversationEvent): Promise<void> {
    if (conversationKey(event.conversation) !== conversationKey(this.options.conversation)) return;
    const generation = this.generation;
    try { await this.options.store.append(event); }
    catch (error) {
      if (generation === this.generation) this.synchronized = false;
      throw error;
    }
    if (generation !== this.generation || !this.connected) return;
    const cursor = messageCursor(event);
    if (!this.latestLive || this.compare(cursor, this.latestLive) >= 0) this.latestLive = cursor;
    try {
      if (this.synchronized && !this.running && (!this.currentCursor || this.compare(this.latestLive, this.currentCursor) >= 0)) {
        const checkpoint = this.latestLive;
        await this.options.store.saveHistoryCursor(this.options.conversation, checkpoint);
        if (generation === this.generation) this.currentCursor = checkpoint;
      }
    } catch (error) {
      if (generation === this.generation && this.connected) {
        this.synchronized = false;
        this.reportError(error);
        if (!this.running) this.scheduleRetry(generation);
      }
    } finally {
      // The journal append already succeeded. A cursor checkpoint failure must
      // not hide that pending message from the notification scheduler.
      if (generation === this.generation) this.options.changed();
    }
  }

  /** Wait for the current attempt; a connected failure may still have a scheduled retry. */
  async wait(): Promise<void> { await this.task; }

  private async catchUp(signal: AbortSignal): Promise<void> {
    let cursor = await this.options.store.freezeHistoryCursor(this.options.conversation);
    signal.throwIfAborted();
    if (this.options.conversation.type === 'temporary') {
      // QQ group temporary sessions have no dependable friend-history endpoint.
      // Existing local records still participate in the ordinary pending signal.
      this.currentCursor = cursor;
      return;
    }
    // A fixed target prevents an active group from extending this job forever.
    const recent = await this.fetch(null, 20, signal);
    signal.throwIfAborted();
    const target = recent.at(-1);
    if (cursor && !target) throw new Error('SnowLuma 暂未返回可获取历史，已保留补拉位置；运行 /piq sync 可重试。');
    if (!cursor) {
      for (const event of recent) {
        signal.throwIfAborted();
        await this.options.store.append(event);
      }
      cursor = target ? messageCursor(target) : null;
      await this.options.store.saveHistoryCursor(this.options.conversation, cursor);
    } else if (target && !this.reached(cursor, target)) {
      let pages = 0;
      let complete = false;
      while (!complete && !this.reached(cursor, target)) {
        signal.throwIfAborted();
        const page = await this.fetch(cursor, this.options.pageSize ?? 100, signal);
        signal.throwIfAborted();
        const anchor = page.findIndex(event => sameMessage(event, cursor!));
        if (anchor < 0) throw new Error('离线历史锚点暂不可获取，已保留补拉位置。可在 SnowLuma 历史同步完成后运行 /piq sync 重试。');
        const newer = page.slice(anchor + 1).filter(event => !sameMessage(event, cursor!) && this.compare(event, cursor!) >= 0);
        if (!newer.length) throw new Error('SnowLuma 历史页暂未前进，已保留补拉位置；运行 /piq sync 可继续。');
        for (const event of newer) {
          signal.throwIfAborted();
          await this.options.store.append(event);
          complete ||= sameMessage(event, target);
        }
        cursor = messageCursor(newer.at(-1)!);
        signal.throwIfAborted();
        await this.options.store.saveHistoryCursor(this.options.conversation, cursor);
        // Bound each burst of API work, while continuing automatically to the snapshot.
        if (++pages % (this.options.batchPages ?? 10) === 0 && !complete && !this.reached(cursor, target)) {
          await delay(this.options.batchDelayMs ?? 1_000, undefined, { signal });
        }
      }
    }
    signal.throwIfAborted();
    if (this.latestLive && (!cursor || this.compare(this.latestLive, cursor) > 0)) cursor = this.latestLive;
    this.currentCursor = cursor;
    await this.options.store.saveHistoryCursor(this.options.conversation, cursor);
  }
}
