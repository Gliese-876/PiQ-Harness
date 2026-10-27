import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { conversationDirectory, conversationKey, type Conversation } from '../src/conversations.ts';
import { lookupStoredMessages, readChatHistory, redactChatText, registerChatHistoryTool } from '../src/chat-history.ts';
import type { ResourceContext } from '../src/resource-tools.ts';

const conversation: Conversation = { type: 'group', id: '123456' };
function message(seq: number, source = conversation, changes: Record<string, unknown> = {}) {
  return { v: 2, seq, receivedAt: 1793000000000 + seq, messageId: String(-seq), conversation: source,
    userId: '234567', selfId: '345678', sender: '成员', time: 1793000000 + seq,
    rawText: `消息 ${seq}`, segments: [{ type: 'text', data: { text: `消息 ${seq}` } }], outgoing: false, ...changes };
}

async function fixture(t: TestContext, source = conversation) {
  const parent = resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'chat-history-'));
  const cwd = join(root, 'friends');
  const directory = join(cwd, conversationDirectory(source));
  await mkdir(directory, { recursive: true });
  const journal = join(directory, '2026-10-26.jsonl');
  const links: string[] = [];
  t.after(async () => {
    for (const path of links) { if (process.platform === 'win32') await rmdir(path); else await unlink(path); }
    assert.ok(resolve(root).startsWith(parent + sep));
    await rm(root, { recursive: true, force: true });
  });
  const bound: ResourceContext = { cwd, conversation: source, signal: new AbortController().signal,
    transport: { resources: async () => { throw new Error('Local history must not contact QQ'); } } as unknown as ResourceContext['transport'] };
  const write = (rows: unknown[], path = journal) => writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { root, cwd, directory, journal, links, bound, write };
}

test('history returns a bounded chronological page and an older-page cursor without network calls', async t => {
  const f = await fixture(t);
  await f.write(Array.from({ length: 45 }, (_, index) => message(index + 1)));
  const before = await readFile(f.journal);
  const result = await readChatHistory(f.bound);
  assert.equal(result.conversation, 'group:123456');
  assert.deepEqual(result.records.map(record => record.seq), Array.from({ length: 40 }, (_, index) => index + 6));
  assert.equal(result.hasMore, true);
  assert.equal(result.nextBeforeSeq, 6);
  const older = await readChatHistory(f.bound, { beforeSeq: result.nextBeforeSeq });
  assert.deepEqual(older.records.map(record => record.seq), [1, 2, 3, 4, 5]);
  assert.equal(older.hasMore, false);
  assert.equal(older.nextBeforeSeq, undefined);
  assert.deepEqual(await readFile(f.journal), before);
});

test('dates, exclusive seq bounds and signed QQ message ids select only matching records', async t => {
  const f = await fixture(t);
  await f.write([message(3), message(4), message(5, conversation, { messageId: '-2147483648' })]);
  await f.write([message(1), message(2, conversation, { messageId: '2147483647' })], join(f.directory, '2026-10-25.jsonl'));
  assert.deepEqual((await readChatHistory(f.bound, { date: '2026-10-25' })).records.map(record => record.seq), [1, 2]);
  assert.deepEqual((await readChatHistory(f.bound, { afterSeq: 1, beforeSeq: 5 })).records.map(record => record.seq), [2, 3, 4]);
  assert.equal((await readChatHistory(f.bound, { messageId: -2_147_483_648 })).records[0]!.seq, 5);
  assert.equal((await readChatHistory(f.bound, { messageId: 2_147_483_647 })).records[0]!.seq, 2);
  assert.deepEqual((await readChatHistory(f.bound, { date: '2026-10-24' })).records, []);
  assert.deepEqual((await readChatHistory(f.bound, { limit: 1 })).records.map(record => record.seq), [5]);
});

test('recent selection follows seq across files even when receipt dates move backwards', async t => {
  const f = await fixture(t);
  await f.write([message(1), message(2)]);
  await f.write([message(3), message(4)], join(f.directory, '2026-10-25.jsonl'));
  const result = await readChatHistory(f.bound, { limit: 2 });
  assert.deepEqual(result.records.map(record => record.seq), [3, 4]);
  assert.equal(result.nextBeforeSeq, 3);
});

test('group, private and source-specific temporary journals remain separate', async t => {
  const f = await fixture(t);
  const sources: Conversation[] = [conversation, { type: 'private', id: conversation.id },
    { type: 'temporary', id: conversation.id, sourceGroupId: '456789' },
    { type: 'temporary', id: conversation.id, sourceGroupId: '567890' }];
  for (const [index, source] of sources.entries()) {
    const directory = join(f.cwd, conversationDirectory(source));
    await mkdir(directory, { recursive: true });
    await f.write([message(index + 1, source)], join(directory, '2026-10-26.jsonl'));
  }
  for (const [index, source] of sources.entries()) {
    const result = await readChatHistory({ ...f.bound, conversation: source });
    assert.equal(result.conversation, conversationKey(source));
    assert.deepEqual(result.records.map(record => record.seq), [index + 1]);
  }
});

test('history summarizes messages and pokes without exposing media URLs, CQ attributes or credentials', async t => {
  const f = await fixture(t);
  await f.write([
    message(1, conversation, { sender: '成员 https://example.com/?token=SENDER_TOKEN', segments: [
      { type: 'text', data: { text: '正文 https://example.com/public?q=normal https://qpic.cn/image?rkey=TEXT_SECRET' } },
      { type: 'image', data: { url: 'https://qpic.cn/private?rkey=IMAGE_SECRET', file: 'PRIVATE_LOCAL_FILE' } },
      { type: 'forward', data: { id: 'PRIVATE_FORWARD_ID' } },
      { type: 'https://private.invalid/?token=TYPE_SECRET', data: {} },
    ] }),
    { v: 2, seq: 2, receivedAt: 1793000000002, kind: 'poke', eventId: randomUUID(), source: 'notice', conversation,
      selfId: '345678', userId: '234567', targetId: '345678', sender: '成员', time: 1793000002,
      rawText: '戳一戳', segments: [], outgoing: false },
    message(3, conversation, { segments: [], rawText: '文字[CQ:image,url=https://qpic.cn/?rkey=CQ_SECRET]尾部' }),
  ]);
  const result = await readChatHistory(f.bound);
  const encoded = JSON.stringify(result);
  assert.doesNotMatch(encoded, /TEXT_SECRET|IMAGE_SECRET|SENDER_TOKEN|TYPE_SECRET|CQ_SECRET|PRIVATE_LOCAL_FILE|PRIVATE_FORWARD_ID/);
  assert.match(result.records[0]!.text, /https:\/\/example.com\/public\?q=normal/);
  assert.deepEqual(result.records[0]!.segments, [{ type: 'text', count: 1 }, { type: 'image', count: 1 }, { type: 'forward', count: 1 }, { type: 'unknown', count: 1 }]);
  assert.equal(result.records[1]!.kind, 'poke');
  const poke = result.records[1]!;
  assert.ok('targetId' in poke);
  assert.equal(poke.targetId, '345678');
  assert.ok(!('messageId' in poke));
  assert.equal(result.records[2]!.text, '文字[消息段]尾部');
});

test('obvious credentials and unfinished CQ tags are redacted while ordinary text remains readable', () => {
  for (const text of [
    'hello[CQ:image,url=https://qpic.cn/?rkey=SECRET',
    'https://user:SECRET@example.com/path',
    'https://user:SECRET@',
    'https://example.com/?sign=SECRET',
    'https://example.com/?X-Amz-Credential=SECRET',
    'https://example.com/?apiKey=SECRET',
    'Authorization: Bearer SECRET',
    'api_key="SECRET" access_token=SECRET',
    '{"access_token":"JSON_SECRET","api_key":"JSON_SECRET","password":"JSON_SECRET"}',
  ]) assert.doesNotMatch(redactChatText(text), /SECRET/);
  assert.doesNotMatch(redactChatText('Authorization: Basic dXNlcjpTRUNSRVQ='), /dXNlcjpTRUNSRVQ=/);
  assert.doesNotMatch(redactChatText('{"Authorization":"Basic dXNlcjpTRUNSRVQ="}'), /dXNlcjpTRUNSRVQ=/);
  assert.equal(redactChatText('普通文字\nhttps://example.com/docs?page=2'), '普通文字\nhttps://example.com/docs?page=2');
});

test('only completed JSONL lines count, including UTF-8 records that span read blocks', async t => {
  const f = await fixture(t);
  const text = '跨块中文'.repeat(10_000);
  const first = JSON.stringify(message(1, conversation, { rawText: text, segments: [{ type: 'text', data: { text } }] }));
  await writeFile(f.journal, first + '\r\n' + JSON.stringify(message(2)) + '\r\n' + '{"unfinished":');
  const result = await readChatHistory(f.bound);
  assert.deepEqual(result.records.map(record => record.seq), [1, 2]);
  assert.equal(result.records[0]!.text.length, 2_000);
  assert.equal(result.records[0]!.textTruncated, true);
  assert.doesNotMatch(result.records[0]!.text, /\ufffd/);
  await writeFile(f.journal, JSON.stringify(message(3)));
  assert.deepEqual((await readChatHistory(f.bound)).records, []);
  await assert.rejects(lookupStoredMessages(f.bound, { messageIds: [-3] }), /找不到/);
});

test('history bounds total response text and rejects oversized individual log records', async t => {
  const f = await fixture(t);
  const long = '长'.repeat(2_100);
  await f.write(Array.from({ length: 30 }, (_, index) => message(index + 1, conversation, {
    rawText: long, segments: [{ type: 'text', data: { text: long } }],
  })));
  const result = await readChatHistory(f.bound, { limit: 100 });
  assert.equal(result.records.reduce((size, record) => size + record.text.length, 0), 50_000);
  assert.equal(result.truncated, true);
  await writeFile(f.journal, 'x'.repeat(8 * 1024 * 1024 + 1) + '\n');
  await assert.rejects(readChatHistory(f.bound), /单条聊天记录过大/);
});

test('verified lookup returns selected messages in request order and cannot fabricate or forward poke records', async t => {
  const f = await fixture(t);
  await f.write([message(1), message(2), message(3)]);
  assert.deepEqual((await lookupStoredMessages(f.bound, { messageIds: [-3, -1] })).map(record => record.seq), [3, 1]);
  assert.deepEqual((await lookupStoredMessages(f.bound, { seqs: [2, 1] })).map(record => record.messageId), ['-2', '-1']);
  await assert.rejects(lookupStoredMessages(f.bound, { messageIds: [-1, -99] }), /找不到全部/);
  await f.write([{ v: 2, seq: 4, receivedAt: 1793000000002, kind: 'poke', eventId: randomUUID(), source: 'notice', conversation,
    selfId: '345678', userId: '234567', targetId: '345678', sender: '成员', time: 1793000002,
    rawText: 'poke', segments: [], outgoing: false }]);
  await assert.rejects(lookupStoredMessages(f.bound, { seqs: [4] }), /戳一戳/);
});

test('foreign records, duplicate identities and damaged logs fail without leaking their contents', async t => {
  const f = await fixture(t);
  await f.write([message(1, { type: 'group', id: '999999' })]);
  await assert.rejects(readChatHistory(f.bound), /其他对话/);
  await assert.rejects(lookupStoredMessages(f.bound, { messageIds: [-1] }), /其他对话/);
  await f.write([message(1), message(1)]);
  await assert.rejects(readChatHistory(f.bound), /重复 seq/);
  await f.write([message(1), message(2, conversation, { messageId: '-1' })]);
  await assert.rejects(lookupStoredMessages(f.bound, { messageIds: [-1] }), /多条记录/);
  await assert.rejects(readChatHistory(f.bound, { messageId: -1 }), /多条记录/);
  await writeFile(f.journal, '{broken SECRET_TOKEN}\n');
  await assert.rejects(readChatHistory(f.bound), error => error instanceof Error && /读取失败/.test(error.message) && !error.message.includes('SECRET_TOKEN'));
});

test('invalid filters, selection bounds and cancellation are rejected without side effects', async t => {
  const f = await fixture(t);
  await f.write([message(1)]);
  for (const query of [{ limit: 0 }, { limit: 101 }, { date: '../2026-10-26' }, { date: '2026-02-30' },
    { beforeSeq: 0 }, { afterSeq: 1.5 }, { beforeSeq: 2, afterSeq: 2 }, { messageId: 0 },
    { messageId: 2_147_483_648 }, { messageId: -2_147_483_649 }]) await assert.rejects(readChatHistory(f.bound, query));
  for (const selection of [{}, { messageIds: [], seqs: [1] }, { messageIds: [] }, { messageIds: [-1, -1] },
    { messageIds: [0] }, { messageIds: [2_147_483_648] }, { seqs: [0] }, { seqs: Array.from({ length: 101 }, (_, index) => index + 1) }]) {
    await assert.rejects(lookupStoredMessages(f.bound, selection));
  }
  const before = await readFile(f.journal);
  f.bound.signal = AbortSignal.abort(new Error('SECRET_ABORT_REASON'));
  await assert.rejects(readChatHistory(f.bound), /取消或超时/);
  await assert.rejects(lookupStoredMessages(f.bound, { messageIds: [-1] }), /取消或超时/);
  assert.deepEqual(await readFile(f.journal), before);
});

test('missing conversation journals return empty history and cannot prove selected messages', async t => {
  const f = await fixture(t);
  const other = { ...f.bound, conversation: { type: 'private' as const, id: '987654' } };
  assert.deepEqual((await readChatHistory(other)).records, []);
  await assert.rejects(lookupStoredMessages(other, { messageIds: [-1] }), /找不到/);
});

test('the registered tool resolves current membership, pause and cancellation through the shared resource context', async t => {
  const f = await fixture(t);
  await f.write([message(1)]);
  let registered: unknown;
  let paused = false;
  const controller = new AbortController();
  registerChatHistoryTool({ registerTool(tool: unknown) { registered = tool; } } as unknown as ExtensionAPI, (_ctx, key, signal) => {
    if (key !== 'group:123456') throw new Error('目标对话不属于当前对话组。');
    if (paused) throw new Error('PiQ 已暂停。');
    return { ...f.bound, signal: AbortSignal.any([f.bound.signal, ...(signal ? [signal] : [])]) };
  });
  const tool = registered as { name: string; parameters: { additionalProperties: boolean }; execute(id: string, params: { conversation: string }, signal: AbortSignal, update: undefined, ctx: ExtensionContext): Promise<{ details: Awaited<ReturnType<typeof readChatHistory>> }> };
  assert.equal(tool.name, 'qq_read_history');
  assert.equal(tool.parameters.additionalProperties, false);
  const call = (key = 'group:123456') => tool.execute('test', { conversation: key }, controller.signal, undefined, {} as ExtensionContext);
  assert.equal((await call()).details.records.length, 1);
  await assert.rejects(call('group:999999'), /不属于/);
  paused = true; await assert.rejects(call(), /暂停/);
  paused = false; controller.abort(); await assert.rejects(call(), /取消/);
});

test('hard-linked files and junctioned journals cannot provide foreign message proof', async t => {
  const f = await fixture(t);
  await f.write([message(1)]);
  const external = join(f.root, 'external.jsonl');
  try { await link(f.journal, external); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('File links unavailable'); return; }
    throw error;
  }
  await assert.rejects(readChatHistory(f.bound), /普通目录或文件/);
  await assert.rejects(lookupStoredMessages(f.bound, { messageIds: [-1] }), /普通目录或文件/);
  await unlink(external);
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, '2026-10-26.jsonl'), JSON.stringify(message(1)) + '\n');
  assert.ok(resolve(f.directory).startsWith(resolve(f.root) + sep));
  await rm(f.directory, { recursive: true });
  await symlink(outside, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
  f.links.push(f.directory);
  await assert.rejects(readChatHistory(f.bound), /普通目录或文件/);
  assert.deepEqual(await readdir(outside), ['2026-10-26.jsonl']);
});
