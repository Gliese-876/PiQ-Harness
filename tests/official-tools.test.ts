import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerOfficialTools, type OfficialToolContext } from '../src/official-tools.ts';
import { conversationKey, parseConversationKey } from '../src/conversations.ts';
import type { StoredMessage } from '../src/store.ts';

interface Tool {
  parameters: { additionalProperties?: boolean };
  execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, update: undefined,
    ctx: ExtensionContext): Promise<{ details: Record<string, unknown> }>;
}

function fixture() {
  const tools = new Map<string, Tool>();
  const records = new Map<string, StoredMessage>();
  const requests: Array<{ method: string; path: string; body: any }> = [];
  const sends: Array<{ conversation: string; input: unknown }> = [];
  const remembered: Array<{ messageId: string; text: string; kind?: string; raw?: Record<string, unknown> }> = [];
  let life = new AbortController();
  let paused = false, failRemember = false;
  let beforeRemember: (() => Promise<void>) | undefined;
  let intercept: ((path: string, signal: AbortSignal) => Promise<unknown>) | undefined;
  const cwd = resolve('.test-tmp', 'official-tools-memory-only');
  const key = (conversation: string, messageId: string) => conversation + ':' + messageId;
  const record = (conversation: string, messageId: string, outgoing = false) => {
    const value: StoredMessage = { v: 3, seq: records.size + 1, receivedAt: 1_793_000_000_000,
      conversation: parseConversationKey(conversation), messageId, userId: outgoing ? 'bot' : 'member', selfId: 'bot',
      sender: outgoing ? 'Pi' : 'Member', time: 1_793_000_000, rawText: 'recorded', outgoing, attachments: [], raw: {} };
    records.set(key(conversation, messageId), value);
    return value;
  };
  for (const conversation of ['group:Group_A', 'private:User_A']) {
    record(conversation, 'inbound'); record(conversation, 'own/id?value', true);
  }
  const interaction = record('private:User_A', 'event:INTERACTION_CREATE:observed');
  interaction.eventType = 'INTERACTION_CREATE';
  interaction.raw = { id: 'platform-event', eventType: 'INTERACTION_CREATE' };
  const transport: OfficialToolContext['transport'] = {
    async request(method, path, body, signal) {
      signal!.throwIfAborted();
      requests.push({ method, path, body: structuredClone(body) });
      if (intercept) return intercept(path, signal!);
      return method === 'DELETE' ? undefined : { id: path.endsWith('/stream_messages') ? 'stream-message' : 'wakeup-message', remain_msg_len: 3000 };
    },
    async sendRich(conversation, input, signal) {
      signal!.throwIfAborted(); sends.push({ conversation: conversationKey(conversation), input: structuredClone(input) });
      return { messageId: 'rich-message', raw: { id: 'rich-message' } };
    },
  };
  const lifecycle = registerOfficialTools({ registerTool(tool: unknown) {
    const value = tool as Tool & { name: string }; tools.set(value.name, value);
  } } as ExtensionAPI, (ctx, conversation, signal) => {
    if (paused) throw new Error('PiQ 已暂停。');
    if (!['group:Group_A', 'private:User_A'].includes(conversation)) throw new Error('对话不属于当前组。');
    return { cwd: ctx.cwd, conversation: parseConversationKey(conversation), transport,
      signal: AbortSignal.any([life.signal, ...(signal ? [signal] : [])]),
      ownsSent: async id => records.get(key(conversation, id))?.outgoing === true,
      findMessage: async id => records.get(key(conversation, id)),
      findEvent: async id => [...records.values()].find(record => conversationKey(record.conversation) === conversation
        && (record.raw?.id === id || record.raw?.event_id === id)),
      rememberSent: async value => { if (failRemember) throw new Error('PRIVATE_LOG_PATH'); await beforeRemember?.(); remembered.push(value); const sent = record(conversation, value.messageId, true); sent.raw = value.raw ?? {}; },
    };
  });
  const call = (name: string, params: Record<string, unknown>, directory = cwd, signal?: AbortSignal) =>
    tools.get(name)!.execute('test', params, signal, undefined, { cwd: directory } as ExtensionContext);
  return { tools, records, requests, sends, remembered, lifecycle, record, call,
    pause() { paused = true; life.abort(); }, resume() { paused = false; life = new AbortController(); },
    failLog() { failRemember = true; }, delayLog(value: () => Promise<void>) { beforeRemember = value; }, intercept(value: typeof intercept) { intercept = value; },
  };
}

test('recall defaults to confirmed Pi sends and administrator recall verifies a stored group message', async () => {
  const f = fixture();
  for (const messageId of ['guess', 'inbound', 'event:GROUP_MEMBER_ADD:local']) {
    await assert.rejects(f.call('qq_recall', { conversation: 'group:Group_A', messageId }));
  }
  assert.equal(f.requests.length, 0);
  await f.call('qq_recall', { conversation: 'private:User_A', messageId: 'own/id?value' });
  assert.equal(f.requests[0]!.path, '/v2/users/User_A/messages/own%2Fid%3Fvalue');
  assert.equal(f.requests[0]!.method, 'DELETE');
  await f.call('qq_recall', { conversation: 'group:Group_A', messageId: 'inbound', moderate: true });
  assert.equal(f.requests[1]!.path, '/v2/groups/Group_A/messages/inbound');
  await assert.rejects(f.call('qq_recall', { conversation: 'private:User_A', messageId: 'inbound', moderate: true }), /群聊/);
  await assert.rejects(f.call('qq_recall', { conversation: 'group:Foreign', messageId: 'inbound', moderate: true }), /不属于/);
  await assert.rejects(f.call('qq_recall', { conversation: 'group:Group_A', messageId: 'own/id?value', moderate: true }), /真实已保存/);
  assert.equal(f.requests.length, 2);
});

test('rich messages preserve SDK payloads while rejecting arbitrary API fields and foreign reply anchors', async () => {
  const f = fixture();
  const payloads = [
    { markdown: { content: '# Hello', custom_template_id: 'template', params: [{ key: 'name', values: ['World'] }] } },
    { ark: { template_id: 23, kv: [{ key: '#DESC#', value: 'Card' }] } },
    { embed: { title: 'Embed', description: 'Details', fields: [{ name: 'Name', value: 'Value' }] } },
    { content: 'Choose', keyboard: { content: { rows: [{ buttons: [{ id: 'button', render_data: { label: 'Yes', visited_label: 'Selected', style: 1 },
      action: { type: 2, permission: { type: 2 }, data: 'yes' } }] }] } } },
  ];
  for (const payload of payloads) await f.call('qq_send_rich', { conversation: 'group:Group_A', ...payload, replyTo: 'inbound' });
  assert.equal(f.sends.length, 4);
  for (const [index, payload] of payloads.entries()) assert.deepEqual(f.sends[index]!.input, { ...payload, replyTo: 'inbound' });
  assert.equal(f.remembered.length, 4);
  for (const extra of [{ extra: { targetId: 'Foreign' } }, { url: 'https://foreign.invalid' }, { target: { targetId: 'Foreign' } }]) {
    await assert.rejects(f.call('qq_send_rich', { conversation: 'group:Group_A', markdown: { content: 'x' }, ...extra }), /未支持/);
  }
  await assert.rejects(f.call('qq_send_rich', { conversation: 'group:Group_A', markdown: { content: 'x' }, replyTo: 'foreign' }), /真实已保存/);
  await assert.rejects(f.call('qq_send_rich', { conversation: 'group:Group_A', markdown: { content: 'x' }, replyTo: 'event:local' }), /event:/);
  await assert.rejects(f.call('qq_send_rich', { conversation: 'group:Group_A', markdown: { content: 'x' }, embed: {} }), /一种/);
  assert.equal(f.sends.length, 4);
});

test('a confirmed send remains successful when the journal fails and is never repeated', async () => {
  const f = fixture(); f.failLog();
  const sent = await f.call('qq_send_rich', { conversation: 'private:User_A', markdown: { content: 'Explicit send' } });
  assert.equal(sent.details.messageId, 'rich-message');
  assert.match(String(sent.details.warning), /本地记录保存失败/);
  assert.doesNotMatch(JSON.stringify(sent), /PRIVATE_LOG_PATH/);
  assert.equal(f.sends.length, 1);
});

test('quoting resolves a stored message ID into the platform REFIDX rather than sending its ID as a reference', async () => {
  const f = fixture();
  f.record('group:Group_A', 'quoted-inbound').raw = { message_scene: { ext: ['auth_token=PRIVATE_TEST_TOKEN', 'ref_msg_idx=OTHER_REFIDX', 'msg_idx=INBOUND_REFIDX'] } };
  f.record('group:Group_A', 'quoted-own', true).raw = { ext_info: { ref_idx: 'OWN_REFIDX' } };
  for (const [messageId, reference] of [['quoted-inbound', 'INBOUND_REFIDX'], ['quoted-own', 'OWN_REFIDX']]) {
    await f.call('qq_send_rich', { conversation: 'group:Group_A', markdown: { content: 'Quote' }, quoteMessageId: messageId });
    assert.deepEqual((f.sends.at(-1)!.input as any).messageReference, { message_id: reference });
    assert.equal('quoteMessageId' in (f.sends.at(-1)!.input as any), false);
  }
  await assert.rejects(f.call('qq_send_rich', { conversation: 'group:Group_A', markdown: { content: 'Quote' }, quoteMessageId: 'inbound' }), /REFIDX/);
  assert.equal(f.sends.length, 2);
});

test('incoming quotes reject duplicate indexes and non-array scene extensions without leaking unrelated fields', async () => {
  const f = fixture();
  const record = f.record('private:User_A', 'quoted-inbound');
  for (const ext of [
    ['msg_idx=FIRST', 'msg_idx=FIRST', 'auth_token=PRIVATE_TEST_TOKEN'],
    ['msg_idx=FIRST', 'msg_idx=SECOND'],
    ['ref_msg_idx=OTHER_REFIDX'], ['msg_idx='],
    { msg_idx: 'OLD_OBJECT_SHAPE' }, ['msg_idx=FIRST', { msg_idx: 'INVALID_ELEMENT' }],
  ]) {
    record.raw = { message_scene: { ext } };
    await assert.rejects(f.call('qq_send_rich', { conversation: 'private:User_A', markdown: { content: 'Quote' }, quoteMessageId: 'quoted-inbound' }), error => {
      assert.match(String(error), /引用索引/);
      assert.doesNotMatch(String(error), /PRIVATE_TEST_TOKEN|FIRST|SECOND|OLD_OBJECT_SHAPE|INVALID_ELEMENT/);
      return true;
    });
  }
  assert.equal(f.sends.length, 0);
  record.raw = { message_scene: { ext: ['msg_idx=PRIVATE_REFIDX=='] } };
  await f.call('qq_send_rich', { conversation: 'private:User_A', markdown: { content: 'Quote' }, quoteMessageId: 'quoted-inbound' });
  assert.deepEqual((f.sends[0]!.input as any).messageReference, { message_id: 'PRIVATE_REFIDX==' });
});

test('append streams keep one message sequence, ordered indexes and log only the confirmed final text', async () => {
  const f = fixture();
  const created = await f.call('qq_stream', { action: 'create', conversation: 'private:User_A', replyTo: 'inbound', inputMode: 'append', contentType: 'text', text: 'Hello' });
  const streamId = created.details.streamId;
  assert.equal(f.remembered.length, 0);
  await f.call('qq_stream', { action: 'update', conversation: 'private:User_A', streamId, text: ' world' });
  const result = await f.call('qq_stream', { action: 'complete', conversation: 'private:User_A', streamId });
  assert.equal(result.details.state, 'completed');
  assert.deepEqual(f.requests.map(item => item.body.index), [0, 1, 2]);
  assert.equal(new Set(f.requests.map(item => item.body.msg_seq)).size, 1);
  assert.deepEqual(f.requests.map(item => item.body.input_state), [1, 1, 10]);
  assert.deepEqual(f.requests.map(item => item.body.content_raw), ['Hello', ' world', '']);
  assert.equal(f.requests[0]!.body.stream_msg_id, undefined);
  assert.ok(f.requests.slice(1).every(item => item.body.stream_msg_id === 'stream-message'));
  assert.ok(f.requests.every(item => item.body.msg_id === 'inbound' && item.body.event_id === undefined && item.body.content_type === 'text'));
  assert.deepEqual(f.remembered, [{ messageId: 'stream-message', text: 'Hello world', kind: 'stream', raw: { id: 'stream-message', remain_msg_len: 3000 } }]);
  await assert.rejects(f.call('qq_stream', { action: 'update', conversation: 'private:User_A', streamId, text: 'more' }), /已经结束/);
});

test('replace streams enforce the sent prefix and cannot cross a workspace or target', async () => {
  const f = fixture();
  const first = await f.call('qq_stream', { action: 'create', conversation: 'private:User_A', eventId: 'platform-event', text: 'Start' });
  const streamId = first.details.streamId;
  await assert.rejects(f.call('qq_stream', { action: 'update', conversation: 'private:User_A', streamId, text: 'Changed' }), /前缀/);
  await assert.rejects(f.call('qq_stream', { action: 'update', conversation: 'private:User_A', streamId, text: 'Start more' }, resolve('.test-tmp/other-group')), /不属于/);
  await assert.rejects(f.call('qq_stream', { action: 'update', conversation: 'group:Group_A', streamId, text: 'Start more' }), /仅支持/);
  assert.equal(f.requests.length, 1);
  await f.call('qq_stream', { action: 'complete', conversation: 'private:User_A', streamId, text: 'Start complete' });
  assert.equal(f.requests[1]!.body.msg_id, undefined);
  assert.equal(f.requests[1]!.body.event_id, 'platform-event');
  assert.equal(f.remembered[0]!.text, 'Start complete');
});

test('cancellation preserves confirmed text, sends no DONE and allows the next Pi session to start fresh', async () => {
  const f = fixture();
  const created = await f.call('qq_stream', { action: 'create', conversation: 'private:User_A', replyTo: 'inbound', text: 'Visible portion' });
  f.pause(); await f.lifecycle.cancelOutstanding();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.remembered, [{ messageId: 'stream-message', text: 'Visible portion', kind: 'stream', raw: { id: 'stream-message', remain_msg_len: 3000 } }]);
  f.resume();
  await assert.rejects(f.call('qq_stream', { action: 'complete', conversation: 'private:User_A', streamId: created.details.streamId }), /已经结束/);
  await f.call('qq_stream', { action: 'create', conversation: 'private:User_A', replyTo: 'inbound', text: 'New context' });
  await f.lifecycle.dispose();
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(item => item.body.input_state === 1));
});

test('explicit stream cancellation stops locally without claiming to recall displayed content', async () => {
  const f = fixture();
  const created = await f.call('qq_stream', { action: 'create', conversation: 'private:User_A', replyTo: 'inbound', text: 'Visible' });
  const cancelled = await f.call('qq_stream', { action: 'cancel', conversation: 'private:User_A', streamId: created.details.streamId });
  assert.equal(cancelled.details.state, 'cancelled');
  assert.match(String(cancelled.details.note), /不会因此撤回/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.remembered.length, 1);
  await assert.rejects(f.call('qq_stream', { action: 'complete', conversation: 'private:User_A', streamId: created.details.streamId }), /已经结束/);
});

test('cancelOutstanding synchronously fences a queued DONE while an update is in flight', async () => {
  const f = fixture();
  const first = await f.call('qq_stream', { action: 'create', conversation: 'private:User_A', replyTo: 'inbound', text: 'A' });
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  f.intercept(async (_path, signal) => {
    started(); await new Promise<void>(resolve => { release = resolve; }); signal.throwIfAborted();
    return { id: 'stream-message' };
  });
  const updating = f.call('qq_stream', { action: 'update', conversation: 'private:User_A', streamId: first.details.streamId, text: 'AB' });
  await ready;
  const completing = f.call('qq_stream', { action: 'complete', conversation: 'private:User_A', streamId: first.details.streamId, text: 'ABC' });
  const collected = Promise.allSettled([updating, completing]);
  await f.lifecycle.cancelOutstanding(); release();
  assert.ok((await collected).every(result => result.status === 'rejected'));
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(item => item.body.input_state === 1));
  assert.deepEqual(f.remembered, [{ messageId: 'stream-message', text: 'A', kind: 'stream', raw: { id: 'stream-message', remain_msg_len: 3000 } }]);
});

test('shutdown waits for logs already started by a lifecycle abort and saves a cancelled stream only once', async () => {
  const f = fixture();
  await f.call('qq_stream', { action: 'create', conversation: 'private:User_A', replyTo: 'inbound', text: 'Confirmed' });
  let release!: () => void;
  f.delayLog(() => new Promise<void>(resolve => { release = resolve; }));
  f.pause();
  let finished = false;
  const closing = f.lifecycle.cancelOutstanding().then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  release(); await closing;
  await f.lifecycle.dispose();
  assert.equal(f.remembered.length, 1);
  assert.equal(f.remembered[0]!.text, 'Confirmed');
  assert.equal(f.requests.length, 1);
});

test('a confirmed active stream can be explicitly recalled and then cannot send more frames', async () => {
  const f = fixture();
  const first = await f.call('qq_stream', { action: 'create', conversation: 'private:User_A', replyTo: 'inbound', text: 'Confirmed' });
  await f.call('qq_recall', { conversation: 'private:User_A', messageId: 'stream-message' });
  assert.equal(f.requests[1]!.method, 'DELETE');
  await assert.rejects(f.call('qq_stream', { action: 'complete', conversation: 'private:User_A', streamId: first.details.streamId }), /已经结束/);
  assert.equal(f.requests.length, 2);
});

test('stream event anchors require a recorded interaction from the selected conversation', async () => {
  const f = fixture();
  const foreign = f.record('group:Group_A', 'event:INTERACTION_CREATE:foreign');
  foreign.eventType = 'INTERACTION_CREATE'; foreign.raw = { id: 'FOREIGN_EVENT' };
  const unsupported = f.record('private:User_A', 'event:FRIEND_ADD:known');
  unsupported.eventType = 'FRIEND_ADD'; unsupported.raw = { event_id: 'UNSUPPORTED_EVENT' };
  for (const eventId of ['FOREIGN_UNOBSERVED_EVENT', 'FOREIGN_EVENT', 'UNSUPPORTED_EVENT']) {
    await assert.rejects(f.call('qq_stream', { action: 'create', conversation: 'private:User_A', eventId, text: 'must not send' }), /真实已保存/);
  }
  assert.equal(f.requests.length, 0);
  const allowed = await f.call('qq_stream', { action: 'create', conversation: 'private:User_A', eventId: 'platform-event', text: 'Confirmed anchor' });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.body.event_id, 'platform-event');
  await f.call('qq_stream', { action: 'cancel', conversation: 'private:User_A', streamId: allowed.details.streamId });
});

test('recall fences stream updates and DONE before a delayed DELETE can complete', async () => {
  const f = fixture();
  const created = await f.call('qq_stream', { action: 'create', conversation: 'private:User_A', replyTo: 'inbound', text: 'A' });
  let entered!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  f.intercept(async path => {
    assert.equal(path, '/v2/users/User_A/messages/stream-message');
    entered(); await new Promise<void>(resolve => { release = resolve; });
    return undefined;
  });
  const recalling = f.call('qq_recall', { conversation: 'private:User_A', messageId: 'stream-message' });
  await pending;
  for (const action of ['update', 'complete']) await assert.rejects(f.call('qq_stream', {
    action, conversation: 'private:User_A', streamId: created.details.streamId, text: 'AB',
  }), /已经结束/);
  assert.deepEqual(f.requests.map(item => item.method), ['POST', 'DELETE']);
  release(); await recalling;
  assert.equal(f.remembered.length, 1);
  assert.equal(f.remembered[0]!.text, 'A');
});

test('invalid or failed stream receipts stop the stream without leaking API details or retrying', async () => {
  const f = fixture();
  f.intercept(async () => { throw new Error('HTTP 403，业务码 11282 https://private.invalid?token=SECRET'); });
  await assert.rejects(f.call('qq_stream', { action: 'create', conversation: 'private:User_A', replyTo: 'inbound', text: 'A' }), error => {
    assert.match(String(error), /11282/); assert.doesNotMatch(String(error), /SECRET|private.invalid/); return true;
  });
  assert.equal(f.requests.length, 1);
  f.intercept(async () => ({ id: '' }));
  await assert.rejects(f.call('qq_stream', { action: 'create', conversation: 'private:User_A', replyTo: 'inbound', text: 'B' }), /回执无效/);
  assert.equal(f.requests.length, 2);
  assert.equal(f.remembered.length, 0);
  await f.lifecycle.dispose();
});

test('typing and wakeup use only the explicit private target and platform-controlled payload', async () => {
  const f = fixture();
  await f.call('qq_typing', { conversation: 'private:User_A', replyTo: 'inbound', durationSec: 45 });
  assert.equal(f.requests[0]!.path, '/v2/users/User_A/messages');
  assert.equal(f.requests[0]!.body.msg_type, 6);
  assert.deepEqual(f.requests[0]!.body.input_notify, { input_type: 1, input_second: 45 });
  await f.call('qq_wakeup', { conversation: 'private:User_A', text: 'A deliberate wakeup' });
  assert.equal(f.requests[1]!.body.is_wakeup, true);
  assert.equal(f.requests[1]!.body.msg_id, undefined);
  assert.equal(f.requests[1]!.body.event_id, undefined);
  assert.equal(f.remembered[0]!.messageId, 'wakeup-message');
  await assert.rejects(f.call('qq_typing', { conversation: 'group:Group_A' }), /仅支持/);
  await assert.rejects(f.call('qq_wakeup', { conversation: 'group:Group_A', text: 'no' }), /仅支持/);
  await assert.rejects(f.call('qq_typing', { conversation: 'private:User_A', durationSec: 61 }), /1 到 60/);
  assert.equal(f.requests.length, 2);
});

test('stream creation rejects synthetic anchors, conflicting anchoring and excess active sessions', async () => {
  const f = fixture();
  for (const fields of [{ replyTo: 'event:C2C:local' }, { replyTo: 'inbound', eventId: 'event' },
    { replyTo: 'inbound', wakeup: true }, {}, { replyTo: 'foreign' }]) {
    await assert.rejects(f.call('qq_stream', { action: 'create', conversation: 'private:User_A', text: 'A', ...fields }));
  }
  assert.equal(f.requests.length, 0);
  for (let i = 0; i < 16; i++) await f.call('qq_stream', { action: 'create', conversation: 'private:User_A', wakeup: true, text: 'A' });
  await assert.rejects(f.call('qq_stream', { action: 'create', conversation: 'private:User_A', wakeup: true, text: 'A' }), /16/);
  assert.equal(f.requests.length, 16);
  assert.ok(f.requests.every(item => item.body.is_wakeup === true && item.body.msg_id === undefined && item.body.event_id === undefined));
  await f.lifecycle.dispose();
});
