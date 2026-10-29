export interface Pending {
  count: number;
  firstAt: number;
  lastAt: number;
  through: number;
  files: string[];
  conversations: Array<{ conversation: import('./conversations.ts').Conversation; count: number; firstSeq: number; lastSeq: number; files: string[] }>;
}

export interface Timing {
  quietMs: number;
  maxWaitMs: number;
  minIntervalMs: number;
}

export function dueAt(pending: Pending, lastNotifiedAt: number, timing: Timing): number {
  return Math.max(
    Math.min(pending.lastAt + timing.quietMs, pending.firstAt + timing.maxWaitMs),
    lastNotifiedAt + timing.minIntervalMs,
  );
}

/** One outstanding signal; busy runs keep collecting on disk, without queuing prompts. */
export class Notifier {
  private timer?: ReturnType<typeof setTimeout>;
  private receiptTimer?: ReturnType<typeof setTimeout>;
  private inFlight?: number;
  private received = false;
  private turnSettled = false;
  private stopped = false;
  private paused = false;
  private readonly timing: Timing;
  private readonly host: {
    pending(): Pending | null;
    lastNotifiedAt(): number;
    isIdle(): boolean;
    isBusy(): boolean;
    send(pending: Pending): void;
    stalled(error: unknown): void;
  };

  constructor(timing: Timing, host: Notifier['host']) {
    this.timing = timing;
    this.host = host;
  }

  schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || this.paused || this.inFlight !== undefined) return;
    const pending = this.host.pending();
    if (!pending) return;
    // Manual compaction/tree summaries need not emit agent_settled. Recheck only
    // while messages are pending, so their completion cannot strand a signal.
    const delay = this.host.isIdle()
      ? Math.max(0, dueAt(pending, this.host.lastNotifiedAt(), this.timing) - Date.now())
      : 1_000;
    this.timer = setTimeout(() => this.flush(), delay);
    this.timer.unref?.();
  }

  private flush(): void {
    if (this.stopped || this.paused || this.inFlight !== undefined) return;
    if (!this.host.isIdle()) { this.schedule(); return; }
    const pending = this.host.pending();
    if (!pending) return;
    if (dueAt(pending, this.host.lastNotifiedAt(), this.timing) > Date.now()) {
      this.schedule();
      return;
    }
    this.inFlight = pending.through;
    this.received = false;
    this.turnSettled = false;
    this.waitForReceipt(pending.through);
    try { this.host.send(pending); } catch (error) { this.fail(error); }
  }

  private waitForReceipt(through: number): void {
    this.receiptTimer = setTimeout(() => {
      if (this.stopped || this.paused || this.inFlight !== through || this.received) return;
      // Pi may compact a long context before it appends the starting message.
      // Keep waiting on the same request while Pi is busy; never inject a retry.
      if (this.host.isBusy()) { this.waitForReceipt(through); return; }
      this.fail(new Error('Pi 未确认接收消息信号。待通知消息已保留；检查模型配置后运行 /piq retry。'));
    }, 60_000);
    this.receiptTimer.unref?.();
  }

  confirm(through: number): void {
    if (this.inFlight !== through || this.stopped) return;
    clearTimeout(this.receiptTimer);
    this.received = true;
    this.releaseIfComplete();
  }

  settle(through: number): void {
    if (this.inFlight !== through || this.stopped) return;
    this.turnSettled = true;
    this.releaseIfComplete();
  }

  private releaseIfComplete(): void {
    // Receipt only proves that the custom message reached Pi, not that its
    // model/tool loop finished. Either asynchronous callback can arrive first.
    if (!this.received || !this.turnSettled) return;
    this.inFlight = undefined;
    this.schedule();
  }

  fail(error: unknown): void {
    if (this.stopped) return;
    const alreadyPaused = this.paused;
    clearTimeout(this.receiptTimer);
    clearTimeout(this.timer);
    this.paused = true;
    this.inFlight = undefined;
    if (!alreadyPaused) this.host.stalled(error);
  }

  retry(): void {
    this.paused = false;
    this.schedule();
  }

  suspend(): void {
    clearTimeout(this.timer);
    clearTimeout(this.receiptTimer);
    this.inFlight = undefined;
    this.paused = true;
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.receiptTimer);
  }
}
