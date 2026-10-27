import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { HistorySync, type HistoryStore } from '../src/history.ts';
import { Notifier, type Pending } from '../src/notifier.ts';
import { messageCursor, type ConversationEvent, type HistoryCursor } from '../src/transport.ts';

const conversation = { type: 'group', id: '123456' } as const;
function message(sequence: number): ConversationEvent {
  return {
    conversation, messageId: String(-sequence), messageSeq: String(sequence), time: 1_700_000_000 + sequence,
    selfId: '99999', userId: '88888', sender: 'Test member', outgoing: false,
    rawText: `incoming ${sequence}`, segments: [{ type: 'text', data: { text: `incoming ${sequence}` } }],
  };
}

async function eventually(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${description}`);
    await delay(5);
  }
}

test('a failed live history checkpoint cannot strand durable messages or later notifications', async t => {
  const original = message(1);
  const remote: ConversationEvent[] = [original];
  const saved = new Map<number, { event: ConversationEvent; receivedAt: number }>([[1, { event: original, receivedAt: Date.now() }]]);
  let durableCursor: HistoryCursor | null = messageCursor(original);
  let failCheckpoint = true, fetches = 0, acknowledged = 1;
  const historyErrors: string[] = [], notificationErrors: string[] = [];
  const sends: Array<{ through: number; count: number }> = [];
  const store: HistoryStore = {
    async freezeHistoryCursor() { return durableCursor; },
    async saveHistoryCursor(_conversation, cursor) {
      if (cursor?.messageId === '-2' && failCheckpoint) {
        failCheckpoint = false;
        throw Object.assign(new Error('simulated transient checkpoint EPERM'), { code: 'EPERM' });
      }
      durableCursor = cursor;
    },
    async append(event) {
      const sequence = Number(event.messageSeq);
      if (saved.has(sequence)) return false;
      saved.set(sequence, { event, receivedAt: Date.now() });
      return true;
    },
  };
  const pending = (): Pending | null => {
    const entries = [...saved].filter(([sequence]) => sequence > acknowledged).sort(([a], [b]) => a - b);
    if (!entries.length) return null;
    const first = entries[0]!, last = entries.at(-1)!;
    const files = ['messages/group/123456/simulated.jsonl'];
    return { count: entries.length, firstAt: first[1].receivedAt, lastAt: last[1].receivedAt, through: last[0], files,
      conversations: [{ conversation, count: entries.length, firstSeq: first[0], lastSeq: last[0], files }] };
  };
  let history: HistorySync;
  const notifier = new Notifier({ quietMs: 5, maxWaitMs: 10, minIntervalMs: 0 }, {
    pending, lastNotifiedAt: () => 0, isIdle: () => !history.running,
    send(batch) {
      sends.push({ through: batch.through, count: batch.count });
      // Model acceptance is simulated; no QQ endpoint or model is invoked.
      acknowledged = batch.through;
      notifier.confirm(batch.through);
    },
    stalled: error => { notificationErrors.push(String(error)); },
  });
  history = new HistorySync({
    conversation, store, retryDelaysMs: [40],
    async fetch(cursor, count) {
      fetches++;
      if (!cursor) return remote.slice(-count);
      const start = remote.findIndex(event => event.messageId === cursor.messageId);
      return start < 0 ? [] : remote.slice(start, start + count);
    },
    changed: () => notifier.schedule(),
    error: error => { historyErrors.push(String(error)); },
  });
  t.after(() => { history.close(); notifier.close(); });
  history.connect(); await history.wait();
  assert.equal(fetches, 1);
  assert.equal(pending(), null);

  remote.push(message(2));
  await history.receive(remote[1]!);
  assert.equal(saved.has(2), true, 'the incoming record was durable before its checkpoint failed');
  assert.equal(durableCursor?.messageId, '-1', 'a failed checkpoint must not replace the last durable cursor');
  remote.push(message(3));
  await history.receive(remote[2]!);

  await eventually(() => sends.length > 0 && durableCursor?.messageId === '-3' && !history.running, 'automatic notification and checkpoint recovery');
  assert.deepEqual(sends, [{ through: 3, count: 2 }]);
  assert.ok(fetches >= 2, 'the saved cursor catches up through an automatic history retry');
  assert.equal(historyErrors.length, 1);
  assert.match(historyErrors[0]!, /EPERM/);
  assert.deepEqual(notificationErrors, [], 'history metadata failures must not pause the notifier');
  assert.equal(history.lastError, undefined);
  assert.equal(pending(), null);

  remote.push(message(4));
  await history.receive(remote[3]!);
  await eventually(() => sends.length === 2, 'the next incoming message without a manual notification retry');
  assert.deepEqual(sends[1], { through: 4, count: 1 });
  assert.equal(durableCursor?.messageId, '-4');
});
