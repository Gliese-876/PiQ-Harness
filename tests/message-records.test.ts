import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { conversationDirectory, type Conversation } from '../src/conversations.ts';
import { lookupStoredMessages, redactChatText } from '../src/message-records.ts';
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
  const root = await mkdtemp(join(parent, 'message-records-'));
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
    transport: { resources: async () => { throw new Error('Message proof lookup must not contact QQ'); } } as unknown as ResourceContext['transport'] };
  const write = (rows: unknown[], path = journal) => writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { root, cwd, directory, journal, links, bound, write };
}

test('verified lookup retains selected records in explicit order across receipt dates without changing logs', async t => {
  const f = await fixture(t);
  await f.write([message(1), message(2, conversation, { messageId: '2147483647' })]);
  await f.write([message(3), message(4, conversation, { messageId: '-2147483648', segments: [
    { type: 'face', data: { id: '66' } }, { type: 'forward', data: { id: 'observed-forward' } },
  ] })], join(f.directory, '2026-10-25.jsonl'));
  const before = await readFile(f.journal);
  const byId = await lookupStoredMessages(f.bound, { messageIds: [-2_147_483_648, -1, 2_147_483_647] });
  assert.deepEqual(byId.map(record => record.seq), [4, 1, 2]);
  assert.deepEqual(byId[0]!.segments, [{ type: 'face', data: { id: '66' } }, { type: 'forward', data: { id: 'observed-forward' } }]);
  assert.deepEqual((await lookupStoredMessages(f.bound, { seqs: [3, 1] })).map(record => record.messageId), ['-3', '-1']);
  assert.deepEqual(await readFile(f.journal), before);
});

test('group, private and source-specific temporary journals provide separate proofs', async t => {
  const f = await fixture(t);
  const sources: Conversation[] = [conversation, { type: 'private', id: conversation.id },
    { type: 'temporary', id: conversation.id, sourceGroupId: '456789' },
    { type: 'temporary', id: conversation.id, sourceGroupId: '567890' }];
  for (const [index, source] of sources.entries()) {
    const directory = join(f.cwd, conversationDirectory(source));
    await mkdir(directory, { recursive: true });
    await f.write([message(index + 1, source, { messageId: '-99' })], join(directory, '2026-10-26.jsonl'));
  }
  for (const [index, source] of sources.entries()) {
    const records = await lookupStoredMessages({ ...f.bound, conversation: source }, { messageIds: [-99] });
    assert.deepEqual(records.map(record => record.seq), [index + 1]);
    assert.deepEqual(records[0]!.conversation, source);
  }
});

test('forwarded text redacts credentials and unfinished CQ attributes while retaining ordinary text', () => {
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

test('lookup accepts only committed JSONL lines and retains UTF-8 records across read blocks', async t => {
  const f = await fixture(t);
  const text = '跨块中文'.repeat(10_000);
  const first = JSON.stringify(message(1, conversation, { rawText: text, segments: [{ type: 'text', data: { text } }] }));
  await writeFile(f.journal, first + '\r\n' + JSON.stringify(message(2)) + '\r\n' + '{"unfinished":');
  const records = await lookupStoredMessages(f.bound, { messageIds: [-2, -1] });
  assert.deepEqual(records.map(record => record.seq), [2, 1]);
  assert.equal(records[1]!.rawText, text);
  assert.equal(records[1]!.segments[0]!.data.text, text);
  await writeFile(f.journal, JSON.stringify(message(3)));
  await assert.rejects(lookupStoredMessages(f.bound, { messageIds: [-3] }), /找不到/);
});

test('oversized individual log records cannot be used as forwarding proof', async t => {
  const f = await fixture(t);
  await writeFile(f.journal, 'x'.repeat(8 * 1024 * 1024 + 1) + '\n');
  await assert.rejects(lookupStoredMessages(f.bound, { messageIds: [-1] }), /单条聊天记录过大/);
});

test('lookup cannot invent missing messages or turn poke notices into message references', async t => {
  const f = await fixture(t);
  await f.write([message(1), { v: 2, seq: 2, receivedAt: 1793000000002, kind: 'poke', eventId: randomUUID(), source: 'notice', conversation,
    selfId: '345678', userId: '234567', targetId: '345678', sender: '成员', time: 1793000002,
    rawText: 'poke', segments: [], outgoing: false }]);
  assert.equal((await lookupStoredMessages(f.bound, { seqs: [1] }))[0]!.messageId, '-1');
  await assert.rejects(lookupStoredMessages(f.bound, { messageIds: [-1, -99] }), /找不到全部/);
  await assert.rejects(lookupStoredMessages(f.bound, { seqs: [2] }), /戳一戳/);
  const other = { ...f.bound, conversation: { type: 'private' as const, id: '987654' } };
  await assert.rejects(lookupStoredMessages(other, { messageIds: [-1] }), /找不到/);
});

test('foreign records, duplicate identities and damaged logs fail without leaking their contents', async t => {
  const f = await fixture(t);
  await f.write([message(1, { type: 'group', id: '999999' })]);
  await assert.rejects(lookupStoredMessages(f.bound, { messageIds: [-1] }), /其他对话/);
  await f.write([message(1), message(1)]);
  await assert.rejects(lookupStoredMessages(f.bound, { messageIds: [-1] }), /重复 seq/);
  await f.write([message(1), message(2, conversation, { messageId: '-1' })]);
  await assert.rejects(lookupStoredMessages(f.bound, { messageIds: [-1] }), /多条记录/);
  await writeFile(f.journal, '{broken SECRET_TOKEN}\n');
  await assert.rejects(lookupStoredMessages(f.bound, { messageIds: [-1] }), error => error instanceof Error
    && /读取失败/.test(error.message) && !error.message.includes('SECRET_TOKEN'));
});

test('invalid selections and cancellation are rejected without changing records', async t => {
  const f = await fixture(t);
  await f.write([message(1)]);
  for (const selection of [{}, { messageIds: [], seqs: [1] }, { messageIds: [] }, { messageIds: [-1, -1] },
    { messageIds: [0] }, { messageIds: [2_147_483_648] }, { messageIds: [-2_147_483_649] },
    { seqs: [0] }, { seqs: [1.5] }, { seqs: [1, 1] }, { seqs: Array.from({ length: 101 }, (_, index) => index + 1) }]) {
    await assert.rejects(lookupStoredMessages(f.bound, selection));
  }
  const before = await readFile(f.journal);
  f.bound.signal = AbortSignal.abort(new Error('SECRET_ABORT_REASON'));
  await assert.rejects(lookupStoredMessages(f.bound, { messageIds: [-1] }), error => error instanceof Error
    && /取消或超时/.test(error.message) && !error.message.includes('SECRET_ABORT_REASON'));
  assert.deepEqual(await readFile(f.journal), before);
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
  await assert.rejects(lookupStoredMessages(f.bound, { messageIds: [-1] }), /普通目录或文件/);
  await unlink(external);
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, '2026-10-26.jsonl'), JSON.stringify(message(1)) + '\n');
  assert.ok(resolve(f.directory).startsWith(resolve(f.root) + sep));
  await rm(f.directory, { recursive: true });
  await symlink(outside, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
  f.links.push(f.directory);
  await assert.rejects(lookupStoredMessages(f.bound, { messageIds: [-1] }), /普通目录或文件/);
  assert.deepEqual(await readdir(outside), ['2026-10-26.jsonl']);
});
