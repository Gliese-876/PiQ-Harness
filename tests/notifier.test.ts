import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dueAt, Notifier, type Pending } from '../src/notifier.ts';

const timing = { quietMs: 1500, maxWaitMs: 10000, minIntervalMs: 15000 };
const pending = (at = 100000): Pending => ({ count: 1, firstAt: at, lastAt: at, through: 1,
  files: ['messages/group/123456/today.jsonl'],
  conversations: [{ conversation: { type: 'group', id: '123456' }, count: 1, firstSeq: 1, lastSeq: 1, files: ['messages/group/123456/today.jsonl'] }] });

test('quiet bursts, sustained traffic and cooldown have bounded due times', () => {
  const p = pending();
  assert.equal(dueAt(p, 0, timing), 101500);
  p.lastAt = 109900;
  assert.equal(dueAt(p, 0, timing), 110000);
  assert.equal(dueAt(p, 108000, timing), 123000);
});

test('coalesces a burst, waits through busy runs, and caps one outstanding signal', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let queue: Pending | null = pending();
  let idle = true;
  let last = 0;
  const sent: Pending[] = [];
  const notifier = new Notifier(timing, {
    pending: () => queue, lastNotifiedAt: () => last, isIdle: () => idle, isBusy: () => !idle,
    send: p => sent.push({ ...p }), stalled: error => assert.fail(String(error)),
  });
  t.after(() => notifier.close());
  notifier.schedule();
  t.mock.timers.tick(1000);
  queue = { ...queue, count: 100, lastAt: Date.now(), through: 100 };
  notifier.schedule();
  t.mock.timers.tick(1499);
  assert.equal(sent.length, 0);
  t.mock.timers.tick(1);
  assert.equal(sent[0].count, 100);
  queue = { ...pending(Date.now()), through: 101 };
  notifier.schedule();
  t.mock.timers.tick(1000);
  assert.equal(sent.length, 1);
  last = Date.now(); idle = false;
  notifier.confirm(100);
  t.mock.timers.tick(20000);
  assert.equal(sent.length, 1);
  idle = true; notifier.settle(100); notifier.schedule(); t.mock.timers.tick(0);
  assert.equal(sent.length, 2);
  queue = null; notifier.confirm(101); notifier.settle(101);
});

test('a receipt cannot release the next batch while the previous turn is settling', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let queue = pending(); let sent = 0;
  const notifier = new Notifier(timing, {
    pending: () => queue, lastNotifiedAt: () => 0, isIdle: () => true, isBusy: () => false,
    send: () => sent++, stalled: error => assert.fail(String(error)),
  });
  t.after(() => notifier.close());
  notifier.schedule(); t.mock.timers.tick(1500);
  queue = { ...pending(Date.now()), through: 2 };
  notifier.confirm(1); notifier.schedule(); t.mock.timers.tick(120000);
  assert.equal(sent, 1, 'an early idle indication cannot override the outstanding turn');
  notifier.settle(999); t.mock.timers.tick(0); assert.equal(sent, 1);
  notifier.settle(1); t.mock.timers.tick(0); assert.equal(sent, 2);
});

test('settlement before asynchronous receipt persistence still waits for that receipt', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let queue = pending(); let sent = 0;
  const notifier = new Notifier(timing, {
    pending: () => queue, lastNotifiedAt: () => 0, isIdle: () => true, isBusy: () => false,
    send: () => sent++, stalled: error => assert.fail(String(error)),
  });
  t.after(() => notifier.close());
  notifier.schedule(); t.mock.timers.tick(1500);
  queue = { ...pending(Date.now()), through: 2 };
  notifier.settle(1); notifier.schedule(); t.mock.timers.tick(2000);
  assert.equal(sent, 1);
  notifier.confirm(1); t.mock.timers.tick(0); assert.equal(sent, 2);
});

test('continuous arrivals cannot keep resetting max wait', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const queue = pending();
  let count = 0;
  const notifier = new Notifier(timing, {
    pending: () => queue, lastNotifiedAt: () => 0, isIdle: () => true, isBusy: () => false,
    send: () => count++, stalled: () => {},
  });
  t.after(() => notifier.close());
  for (let i = 0; i < 100; i++) {
    queue.lastAt = Date.now(); queue.count++;
    notifier.schedule(); t.mock.timers.tick(100);
  }
  assert.equal(count, 1);
});

test('pending messages resume after manual compaction without a settled event', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let idle = false; let count = 0;
  const notifier = new Notifier(timing, {
    pending: () => pending(), lastNotifiedAt: () => 0, isIdle: () => idle, isBusy: () => !idle,
    send: () => count++, stalled: error => assert.fail(String(error)),
  });
  t.after(() => notifier.close());
  notifier.schedule(); t.mock.timers.tick(2000);
  assert.equal(count, 0);
  idle = true;
  t.mock.timers.tick(1000);
  assert.equal(count, 1);
});

test('missing Pi receipt pauses retries, preserves pending, and closes timers', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let sent = 0; let errors = 0;
  const notifier = new Notifier(timing, {
    pending: () => pending(), lastNotifiedAt: () => 0, isIdle: () => true, isBusy: () => false,
    send: () => sent++, stalled: () => errors++,
  });
  notifier.schedule(); t.mock.timers.tick(1500);
  t.mock.timers.tick(60000);
  notifier.fail(new Error('Another incoming event encountered the same failure.'));
  notifier.schedule(); t.mock.timers.tick(60000);
  assert.equal(sent, 1); assert.equal(errors, 1);
  notifier.retry(); t.mock.timers.tick(0); assert.equal(sent, 2);
  notifier.close(); t.mock.timers.tick(60000); assert.equal(errors, 1);
});

test('long pre-turn compaction waits for the original receipt without losing later arrivals', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let queue = pending(), idle = true, sent = 0, errors = 0;
  const notifier = new Notifier(timing, {
    pending: () => queue, lastNotifiedAt: () => 0,
    isIdle: () => idle, isBusy: () => !idle,
    send: () => sent++, stalled: () => errors++,
  });
  t.after(() => notifier.close());
  notifier.schedule(); t.mock.timers.tick(1500);
  idle = false;
  queue = { ...pending(Date.now()), through: 2 };
  t.mock.timers.tick(60000); t.mock.timers.tick(60000);
  assert.equal(errors, 0, 'normal long preparation must not pause notifications');
  assert.equal(sent, 1, 'keep waiting on the same request rather than inject a duplicate');
  notifier.confirm(1); idle = true; notifier.settle(1); t.mock.timers.tick(0);
  assert.equal(sent, 2, 'later arrivals remain deliverable after the delayed receipt');
  t.mock.timers.tick(60000);
  assert.equal(errors, 1, 'a genuinely missing receipt while idle still fails visibly');
  assert.equal(sent, 2);
});
