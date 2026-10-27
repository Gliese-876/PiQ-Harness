import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { conversationDirectory, conversationKey, parseConversationKey, type Conversation } from '../src/conversations.ts';
import { registerForwardSendTool, sendForwardMessages, type ForwardSendResult } from '../src/forward-send.ts';
import { OneBotApiError } from '../src/onebot-client.ts';
import type { ResourceContext, ResourceRequest } from '../src/resource-tools.ts';

const sourceConversation: Conversation = { type: 'group', id: '123456' };
const targetConversation: Conversation = { type: 'private', id: '654321' };
const receipt = { message_id: -999, res_id: 'resource-1', forward_id: 'forward-1' };

function record(messageId: number, seq: number, changes: Record<string, unknown> = {}) {
  return { v: 2, seq, receivedAt: 1793000000000 + seq, messageId: String(messageId), conversation: sourceConversation,
    userId: '88888', selfId: '99999', sender: 'Member', time: 1793000000,
    rawText: `message ${messageId}`, segments: [{ type: 'text', data: { text: `message ${messageId}` } }], outgoing: false, ...changes };
}

async function fixture(t: TestContext, rows = [record(-123, 1), record(456, 2)]) {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'forward-send-'));
  const cwd = join(root, 'friends');
  const directory = join(cwd, conversationDirectory(sourceConversation));
  await mkdir(directory, { recursive: true });
  const journal = join(directory, '2026-10-26.jsonl');
  await writeFile(journal, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const calls: Array<{ action: string; params: Record<string, unknown>; mutating: boolean }> = [];
  let response: unknown = receipt;
  let failure: Error | undefined;
  let beforeDispatch: (() => void) | undefined;
  const request: ResourceRequest = async (action, params, mutating = false) => {
    calls.push({ action, params, mutating });
    if (failure) throw failure;
    return response;
  };
  const transport = { async resources<T>(operation: (request: ResourceRequest) => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted(); beforeDispatch?.(); signal.throwIfAborted();
    return operation(request);
  } } as ResourceContext['transport'];
  const controller = new AbortController();
  const source: ResourceContext = { cwd, conversation: sourceConversation, transport, signal: controller.signal };
  const target: ResourceContext = { ...source, conversation: targetConversation };
  t.after(async () => {
    const target = await realpath(root), within = relative(await realpath(parent), target);
    assert.ok(within && within !== '..' && !within.startsWith('../') && !within.startsWith('..\\') && !isAbsolute(within));
    await rm(target, { recursive: true, force: true });
  });
  return { root, cwd, journal, source, target, calls, controller,
    respond(value: unknown) { response = value; }, fail(error: Error) { failure = error; },
    beforeDispatch(callback: () => void) { beforeDispatch = callback; } };
}

test('selected observed message ids are forwarded once as standard nodes to an explicit private target', async t => {
  const f = await fixture(t);
  const original = await readFile(f.journal, 'utf8');
  const result = await sendForwardMessages(f.source, f.target, [456, -123]);
  assert.deepEqual(f.calls, [{ action: 'send_private_forward_msg',
    params: { user_id: 654321, messages: [{ type: 'node', data: { id: '456' } }, { type: 'node', data: { id: '-123' } }] }, mutating: true }]);
  assert.deepEqual(result, { sourceConversation: 'group:123456', targetConversation: 'private:654321',
    messageIds: [456, -123], count: 2, messageId: '-999', resourceId: 'resource-1', forwardId: 'forward-1' });
  assert.equal(await readFile(f.journal, 'utf8'), original);
  assert.doesNotMatch(JSON.stringify(f.calls), /nickname|userId|rawText|message -123/);
});

test('group forwarding uses group_id and supports locally observed private or temporary sources', async t => {
  const f = await fixture(t);
  const target = { ...f.target, conversation: { type: 'group', id: '777777' } as Conversation };
  await sendForwardMessages(f.source, target, [-123]);
  assert.equal(f.calls[0]!.action, 'send_group_forward_msg');
  assert.equal(f.calls[0]!.params.group_id, 777777);
  assert.equal(f.calls[0]!.params.user_id, undefined);
  for (const conversation of [targetConversation, { type: 'temporary', sourceGroupId: '123456', id: '654321' } as Conversation]) {
    const directory = join(f.cwd, conversationDirectory(conversation));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '2026-10-26.jsonl'), JSON.stringify(record(-123, 3, { conversation })) + '\n');
    await sendForwardMessages({ ...f.source, conversation }, target, [-123]);
  }
  assert.equal(f.calls.length, 3);
});

test('invalid message selections, foreign roots, different backends and temporary targets never dispatch', async t => {
  const f = await fixture(t);
  for (const ids of [[], [-123, -123], [0], [1.5], [2_147_483_648], [-2_147_483_649], Array.from({ length: 51 }, (_, index) => index + 1)]) {
    await assert.rejects(sendForwardMessages(f.source, f.target, ids), /messageIds/);
  }
  await assert.rejects(sendForwardMessages(f.source, { ...f.target, cwd: join(f.root, 'other') }, [-123]), /同一个/);
  await assert.rejects(sendForwardMessages(f.source, { ...f.target, transport: {} as ResourceContext['transport'] }, [-123]), /同一个/);
  await assert.rejects(sendForwardMessages(f.source, { ...f.target, conversation: { type: 'temporary', id: '654321', sourceGroupId: '123456' } }, [-123]), /临时/);
  assert.deepEqual(f.calls, []);
});

test('missing, mixed-source and incomplete journal records cannot become a forwarding reference', async t => {
  const f = await fixture(t);
  await assert.rejects(sendForwardMessages(f.source, f.target, [-777]));
  assert.deepEqual(f.calls, []);
  await writeFile(f.journal, JSON.stringify(record(-123, 1, { conversation: targetConversation })) + '\n');
  await assert.rejects(sendForwardMessages(f.source, f.target, [-123]));
  assert.deepEqual(f.calls, []);
  await writeFile(f.journal, JSON.stringify(record(-123, 1)));
  await assert.rejects(sendForwardMessages(f.source, f.target, [-123]));
  assert.deepEqual(f.calls, []);
});

test('cancelled source or target stops forwarding, including cancellation while awaiting a connection', async t => {
  const f = await fixture(t);
  const targetSignal = new AbortController(); targetSignal.abort();
  await assert.rejects(sendForwardMessages(f.source, { ...f.target, signal: targetSignal.signal }, [-123]));
  f.beforeDispatch(() => f.controller.abort());
  await assert.rejects(sendForwardMessages(f.source, f.target, [-123]), /取消/);
  assert.deepEqual(f.calls, []);
});

test('unknown receipts and transport errors stay explicit and cannot cause an automatic resend', async t => {
  const f = await fixture(t);
  for (const value of [null, {}, { ...receipt, message_id: 0 }, { ...receipt, message_id: 2_147_483_648 },
    { message_id: -999 }, { ...receipt, res_id: 'https://secret.example/?token=SECRET' }]) {
    f.respond(value);
    const before = f.calls.length;
    await assert.rejects(sendForwardMessages(f.source, f.target, [-123]), error => {
      assert.match(String(error), /结果未知/); assert.doesNotMatch(String(error), /SECRET|secret\.example/); return true;
    });
    assert.equal(f.calls.length, before + 1);
  }
  f.fail(new Error('https://secret.example/?token=SECRET'));
  const before = f.calls.length;
  await assert.rejects(sendForwardMessages(f.source, f.target, [-123]), error => {
    assert.match(String(error), /结果未知/); assert.doesNotMatch(String(error), /SECRET|secret\.example/); return true;
  });
  assert.equal(f.calls.length, before + 1);
  f.fail(new OneBotApiError('send_private_forward_msg', 1404));
  await assert.rejects(sendForwardMessages(f.source, f.target, [-123]), OneBotApiError);
  assert.equal(f.calls.length, before + 2);
});

interface RegisteredForwardTool {
  name: string;
  execute(id: string, params: { sourceConversation: string; targetConversation: string; messageIds: number[] },
    signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext): Promise<{ details: ForwardSendResult & { warning?: string } }>;
}

test('the registered tool resolves both members and records confirmed sends without retrying a journal failure', async t => {
  const f = await fixture(t);
  let tool: RegisteredForwardTool | undefined;
  const api = { registerTool(value: unknown) { tool = value as RegisteredForwardTool; } } as ExtensionAPI;
  const resolved: string[] = [];
  let paused = false, rememberFails = false;
  const remembered: Array<{ target: Conversation; result: ForwardSendResult }> = [];
  registerForwardSendTool(api, (_ctx, key) => {
    if (paused) throw new Error('PiQ 已暂停');
    if (!['group:123456', 'private:654321'].includes(key)) throw new Error('目标对话不属于当前对话组');
    resolved.push(key);
    return { ...f.source, conversation: parseConversationKey(key) };
  }, async (_ctx, target, result) => {
    remembered.push({ target, result });
    if (rememberFails) throw new Error('private disk details');
  });
  assert.equal(tool!.name, 'qq_forward');
  const params = { sourceConversation: 'group:123456', targetConversation: 'private:654321', messageIds: [-123] };
  const ctx = { cwd: f.cwd } as ExtensionContext;
  const result = await tool!.execute('test', params, undefined, undefined, ctx);
  assert.deepEqual(resolved, ['group:123456', 'private:654321']);
  assert.equal(remembered.length, 1);
  assert.equal(conversationKey(remembered[0]!.target), params.targetConversation);
  assert.equal(result.details.messageId, '-999');
  await assert.rejects(tool!.execute('test', { ...params, sourceConversation: 'group:999999' }, undefined, undefined, ctx), /不属于/);
  await assert.rejects(tool!.execute('test', { ...params, targetConversation: 'group:999999' }, undefined, undefined, ctx), /不属于/);
  paused = true;
  await assert.rejects(tool!.execute('test', params, undefined, undefined, ctx), /暂停/);
  assert.equal(f.calls.length, 1);
  paused = false; rememberFails = true;
  const partial = await tool!.execute('test', params, undefined, undefined, ctx);
  assert.match(partial.details.warning!, /已发送.*保存失败/);
  assert.doesNotMatch(partial.details.warning!, /private disk/);
  assert.equal(f.calls.length, 2);
});
