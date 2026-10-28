import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { executeGroupAdmin, registerGroupAdmin, type GroupAdminContext } from '../src/group-admin.ts';

const conversation = { type: 'group' as const, id: 'Group_OpenID-AbC' };
const key = 'group:Group_OpenID-AbC';
const base = '/v2/groups/Group_OpenID-AbC';
const now = Date.parse('2026-10-28T00:00:00Z');
const muteUntil = '2026-10-28T01:00:00Z';
type Request = GroupAdminContext['transport']['request'];
type Call = { method: Parameters<Request>[0]; path: string; body: unknown; signal?: AbortSignal };

function fixture(reply: () => unknown | Promise<unknown> = () => ({})) {
  const calls: Call[] = [];
  const controller = new AbortController();
  const bound: GroupAdminContext = { conversation, signal: controller.signal,
    transport: { request: async (method, path, body, signal) => { calls.push({ method, path, body, signal }); return await reply(); } } };
  return { calls, controller, bound };
}

test('read operations use documented group paths and preserve platform metadata', async () => {
  const cases: Array<{ input: Record<string, unknown>; suffix: string; query?: Record<string, unknown> }> = [
    { input: { action: 'info' }, suffix: '/info' },
    { input: { action: 'bot_state' }, suffix: '/bot_state' },
    { input: { action: 'members', cursor: 'opaque+/=cursor?' }, suffix: '/members', query: { cursor: 'opaque+/=cursor?' } },
    { input: { action: 'member', memberId: 'Member_OpenID-aB' }, suffix: '/members/Member_OpenID-aB' },
    { input: { action: 'blacklist_list', cursor: '', limit: 100 }, suffix: '/member_blacklist', query: { cursor: '', limit: 100 } },
    { input: { action: 'mute_list' }, suffix: '/restrict_chat_setting' },
    { input: { action: 'join_requests', cursor: 'request-next', limit: 50 }, suffix: '/join_request_list', query: { cursor: 'request-next', limit: 50 } },
  ];
  const metadata = { members: [{ member_openid: 'Member_OpenID-aB', username: '成员', member_role: 'member', future_field: 'retained' }], next_cursor: 'next-page' };
  for (const value of cases) {
    const f = fixture(() => metadata);
    const result = await executeGroupAdmin(f.bound, { conversation: key, ...value.input }, now);
    assert.deepEqual(f.calls, [{ method: 'GET', path: base + value.suffix, body: value.query, signal: f.controller.signal }]);
    assert.deepEqual(JSON.parse(result.content[0]!.text).data, metadata);
    assert.equal(result.details.truncated, false);
  }
});

test('member removal and blacklist changes dispatch one bounded mutation', async () => {
  const cases = [
    { input: { action: 'remove_members', memberIds: ['member-A', 'member-B'], addToBlacklist: true },
      suffix: '/batch_remove_members', body: { member_openids: ['member-A', 'member-B'], add_to_member_blacklist: true } },
    { input: { action: 'blacklist_add', memberIds: ['member-A'] }, suffix: '/member_blacklist', body: { op: 'add', member_openids: ['member-A'] } },
    { input: { action: 'blacklist_remove', memberIds: ['member-A'] }, suffix: '/member_blacklist', body: { op: 'del', member_openids: ['member-A'] } },
  ];
  for (const value of cases) {
    const partial = { fail_openids: ['member-A'], future_field: 'platform metadata' };
    const f = fixture(() => partial);
    const result = await executeGroupAdmin(f.bound, { conversation: key, ...value.input }, now);
    assert.deepEqual(f.calls, [{ method: 'POST', path: base + value.suffix, body: value.body, signal: f.controller.signal }]);
    assert.deepEqual(JSON.parse(result.content[0]!.text).data, partial, 'partial platform failures must remain visible');
  }
});

test('mute and update use RFC3339 deadlines while unmute immediately removes the restriction', async () => {
  const cases = [
    { input: { action: 'mute', memberId: 'member-A', muteUntil }, op: 'add', ids: ['member-A'], until: muteUntil },
    { input: { action: 'update_mute', memberIds: ['member-A', 'member-B'], muteUntil }, op: 'update', ids: ['member-A', 'member-B'], until: muteUntil },
    { input: { action: 'unmute', memberIds: ['member-A'] }, op: 'del', ids: ['member-A'], until: '' },
  ];
  for (const value of cases) {
    const f = fixture(() => undefined);
    const result = await executeGroupAdmin(f.bound, { conversation: key, ...value.input }, now);
    assert.deepEqual(f.calls, [{ method: 'POST', path: base + '/restrict_chat_setting', signal: f.controller.signal,
      body: { members: value.ids.map(member_openid => ({ op: value.op, member_openid, mute_expire_at: value.until })) } }]);
    assert.equal(JSON.parse(result.content[0]!.text).data, null);
  }
  const f = fixture();
  const boundary = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
  await executeGroupAdmin(f.bound, { conversation: key, action: 'mute', memberId: 'member-A', muteUntil: boundary }, now);
  assert.equal(f.calls.length, 1);
});

test('join approval and rejection retain the exact request identity and optional reason', async () => {
  const cases = [
    { input: { action: 'approve', memberId: 'member-A', joinRequestId: 'opaque_request+/=' },
      body: { op: 'approve', join_request_id: 'opaque_request+/=' } },
    { input: { action: 'reject', memberId: 'member-A', joinRequestId: 'opaque_request+/=', rejectReason: '请补充申请说明', addToBlacklist: false },
      body: { op: 'decline', join_request_id: 'opaque_request+/=', reject_reason: '请补充申请说明', add_to_member_blacklist: false } },
  ];
  for (const value of cases) {
    const f = fixture();
    await executeGroupAdmin(f.bound, { conversation: key, ...value.input }, now);
    assert.deepEqual(f.calls, [{ method: 'POST', path: base + '/approval_join_request/member-A', body: value.body, signal: f.controller.signal }]);
  }
});

test('invalid action fields, identifiers and batches fail before contacting the platform', async () => {
  const f = fixture();
  const invalid = [
    { action: 'send_group_msg' }, { action: 'info', path: '/other' }, { action: 'info', body: { token: 'unsafe' } },
    { action: 'member', memberId: '../other' }, { action: 'member', memberId: 'member%2Fother' },
    { action: 'member' }, { action: 'remove_members', memberIds: [] },
    { action: 'remove_members', memberIds: ['member-A', 'member-A'] },
    { action: 'remove_members', memberIds: Array.from({ length: 21 }, (_, i) => `member-${i}`) },
    { action: 'blacklist_add', memberIds: ['member-A', 'outside/path'] },
    { action: 'blacklist_remove', memberIds: 'member-A' },
    { action: 'remove_members', memberIds: ['member-A'], addToBlacklist: 'true' },
    { action: 'approve', memberId: 'member-A', rejectReason: 'not applicable' },
    { action: 'approve', memberId: 'member-A', joinRequestId: '' },
    { action: 'reject', memberId: 'member-A', rejectReason: 'x'.repeat(501) },
    { action: 'reject', memberId: 'member-A', joinRequestId: 'id\nother' },
    { action: 'mute_list', global_rule: { mode: 'always' } },
    { action: 'mute', memberId: 'member-A', memberIds: ['member-B'], muteUntil },
    { action: 'unmute', memberId: 'member-A', muteUntil },
    { action: 'members', limit: 30 },
  ];
  for (const input of invalid) await assert.rejects(executeGroupAdmin(f.bound, { conversation: key, ...input }, now));
  assert.equal(f.calls.length, 0);
  await executeGroupAdmin(f.bound, { conversation: key, action: 'remove_members', memberIds: Array.from({ length: 20 }, (_, i) => `member-${i}`) }, now);
  assert.equal(f.calls.length, 1, 'the official 20-member boundary remains usable');
});

test('paging bounds and mute deadlines reject malformed or out-of-range values', async () => {
  const f = fixture();
  for (const limit of [0, -1, 1.5, 101, '20']) {
    await assert.rejects(executeGroupAdmin(f.bound, { action: 'blacklist_list', conversation: key, limit }, now));
  }
  await assert.rejects(executeGroupAdmin(f.bound, { action: 'join_requests', conversation: key, limit: 51 }, now));
  for (const cursor of ['x'.repeat(4097), 'next\npage', 1]) {
    await assert.rejects(executeGroupAdmin(f.bound, { action: 'members', conversation: key, cursor }, now));
  }
  for (const muteUntil of ['2026-10-28', '2026-10-28T01:00:00', '2026-02-30T01:00:00Z',
    '2026-10-28T25:00:00Z', '2026-10-28T01:00:00+24:00', '2026-10-27T01:00:00Z',
    new Date(now).toISOString(), new Date(now + 30 * 24 * 60 * 60 * 1000 + 1).toISOString()]) {
    await assert.rejects(executeGroupAdmin(f.bound, { action: 'mute', conversation: key, memberId: 'member-A', muteUntil }, now));
  }
  await assert.rejects(executeGroupAdmin(f.bound, { action: 'mute', conversation: key, memberId: 'member-A', muteUntil: '2026-02-30T01:00:00Z' }, Date.parse('2026-02-27T00:00:00Z')));
  assert.equal(f.calls.length, 0);
});

test('private and mismatched conversations cannot use the group administration channel', async () => {
  const f = fixture();
  await assert.rejects(executeGroupAdmin(f.bound, { action: 'info', conversation: 'private:user-A' }, now), /官方群聊/);
  await assert.rejects(executeGroupAdmin(f.bound, { action: 'info', conversation: 'group:OtherGroup' }, now), /不属于/);
  await assert.rejects(executeGroupAdmin({ ...f.bound, conversation: { type: 'private', id: 'user-A' } }, { action: 'info', conversation: key }, now), /不属于/);
  assert.equal(f.calls.length, 0);
});

test('permission and transport errors expose safe explanations and never retry a mutation', async () => {
  for (const details of [{ bizCode: 11253 }, { bizCode: 11282 }, { httpStatus: 403 }]) {
    const error = Object.assign(new Error('PRIVATE_TOKEN https://private.invalid/?secret=SECRET'), details);
    const f = fixture(() => { throw error; });
    await assert.rejects(executeGroupAdmin(f.bound, { action: 'remove_members', conversation: key, memberIds: ['member-A'] }, now), value => {
      assert.ok(value instanceof Error); assert.match(value.message, /权限/);
      assert.doesNotMatch(value.message, /PRIVATE_TOKEN|private.invalid|SECRET/); return true;
    });
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(() => { throw new Error('PRIVATE_CONNECTION_DETAILS'); });
  await assert.rejects(executeGroupAdmin(f.bound, { action: 'blacklist_add', conversation: key, memberIds: ['member-A'] }, now), /结果未确认/);
  assert.equal(f.calls.length, 1);
  await assert.rejects(executeGroupAdmin(f.bound, { action: 'members', conversation: key }, now), value => {
    assert.ok(value instanceof Error); assert.match(value.message, /查询失败/); assert.doesNotMatch(value.message, /PRIVATE_CONNECTION_DETAILS/); return true;
  });
  assert.equal(f.calls.length, 2);
});

test('HTTP-success responses with a business error remain failures without leaking error text', async () => {
  for (const body of [{ code: 11253, message: 'PRIVATE_PLATFORM_TOKEN' }, { err_code: 11282, msg: 'PRIVATE_PLATFORM_TOKEN' }]) {
    const f = fixture(() => body);
    await assert.rejects(executeGroupAdmin(f.bound, { action: 'members', conversation: key }, now), value => {
      assert.ok(value instanceof Error); assert.match(value.message, /权限/);
      assert.doesNotMatch(value.message, /PRIVATE_PLATFORM_TOKEN/); return true;
    });
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(() => ({ code: 987654, message: 'PRIVATE_PLATFORM_TOKEN' }));
  await assert.rejects(executeGroupAdmin(f.bound, { action: 'blacklist_add', conversation: key, memberIds: ['member-A'] }, now), /结果未确认/);
  assert.equal(f.calls.length, 1);
});

test('cancellation before dispatch prevents writes and cancellation in flight does not retry', async () => {
  const cancelled = fixture(); cancelled.controller.abort();
  await assert.rejects(executeGroupAdmin(cancelled.bound, { action: 'blacklist_add', conversation: key, memberIds: ['member-A'] }, now));
  assert.equal(cancelled.calls.length, 0);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async () => { await gate; return {}; });
  const active = executeGroupAdmin(f.bound, { action: 'unmute', conversation: key, memberId: 'member-A' }, now);
  f.controller.abort(new Error('PRIVATE_ABORT_REASON')); release();
  await assert.rejects(active, value => {
    assert.ok(value instanceof Error); assert.match(value.message, /取消/); assert.doesNotMatch(value.message, /PRIVATE_ABORT_REASON/); return true;
  });
  assert.equal(f.calls.length, 1);
});

test('oversized platform metadata has an explicit preview and a total 32 KiB result bound', async () => {
  const original = { members: [{ username: '中文😀\\\"'.repeat(30_000) }], next_cursor: 'real-next-cursor' };
  const f = fixture(() => original);
  const result = await executeGroupAdmin(f.bound, { action: 'members', conversation: key }, now);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32 * 1024);
  assert.equal(result.details.truncated, true);
  const displayed = JSON.parse(result.content[0]!.text);
  assert.equal(displayed.truncated, true);
  assert.equal(displayed.next_cursor, 'real-next-cursor');
  assert.ok(displayed.originalBytes > 32 * 1024);
  assert.ok(displayed.preview.length > 0);
  assert.ok(original.members[0]!.username.length > 100_000, 'output bounds must not mutate returned platform metadata');
});

test('registered tool rejects unknown properties and resolves scope and pause before each request', async () => {
  const f = fixture(); let registered: unknown; let resolutions = 0;
  registerGroupAdmin({ registerTool: (tool: unknown) => { registered = tool; } } as unknown as ExtensionAPI,
    (_ctx, requested, signal) => { resolutions++; assert.equal(requested, key); assert.equal(signal, f.controller.signal); return f.bound; });
  const tool = registered as { name: string; parameters: { additionalProperties?: boolean }; execute(id: string, params: unknown, signal: AbortSignal, update: undefined, ctx: ExtensionContext): Promise<unknown> };
  assert.equal(tool.name, 'qq_group_manage'); assert.equal(tool.parameters.additionalProperties, false);
  await tool.execute('first', { action: 'members', conversation: key }, f.controller.signal, undefined, {} as ExtensionContext);
  await tool.execute('second', { action: 'info', conversation: key }, f.controller.signal, undefined, {} as ExtensionContext);
  assert.equal(resolutions, 2); assert.equal(f.calls.length, 2);
  await assert.rejects(tool.execute('invalid', { action: 'info', conversation: key, extra: true }, f.controller.signal, undefined, {} as ExtensionContext));
  assert.equal(f.calls.length, 2);
  registerGroupAdmin({ registerTool: (tool: unknown) => { registered = tool; } } as unknown as ExtensionAPI,
    () => { throw new Error('PiQ 已暂停'); });
  await assert.rejects((registered as typeof tool).execute('paused', { action: 'mute_list', conversation: key }, f.controller.signal, undefined, {} as ExtensionContext), /已暂停/);
  assert.equal(f.calls.length, 2);
});

const strategiesPath = '/v2/groups/join_approval_strategy';
const scopedStrategy = (strategy_id = 'st_current') => ({ strategy_id, group_openids: [conversation.id], group_ids: [],
  whitelist_user_count: 2, is_enable: 'on', expire_at: '2027-10-28T00:00:00Z', remark: '当前群策略' });

test('strategy listing consumes every page and returns only verified current-group metadata', async () => {
  const pages = [
    { strategies: [
      { strategy_id: 'st_other', group_openids: ['OTHER_PRIVATE_GROUP'], remark: 'OTHER_PRIVATE_METADATA' },
      { strategy_id: 'st_shared', group_openids: [conversation.id, 'OTHER_PRIVATE_GROUP'], remark: 'SHARED_PRIVATE_METADATA' },
      { strategy_id: 'st_numeric', group_ids: ['123456'], remark: 'NUMERIC_PRIVATE_METADATA' },
      { strategy_id: 'st_unknown', remark: 'UNSCOPED_PRIVATE_METADATA' },
    ], next_cursor: 'INTERNAL_GLOBAL_CURSOR' },
    { strategies: [
      { ...scopedStrategy(), undisclosed_future_field: 'OTHER_PRIVATE_METADATA' },
      { strategy_id: 'st_ambiguous', group_openids: [conversation.id], group_ids: ['123456'], remark: 'AMBIGUOUS_PRIVATE_METADATA' },
    ], next_cursor: '' },
  ];
  let index = 0;
  const f = fixture(() => pages[index++]);
  const result = await executeGroupAdmin(f.bound, { action: 'strategy_list', conversation: key }, now);
  assert.deepEqual(f.calls.map(({ method, path, body }) => ({ method, path, body })), [
    { method: 'GET', path: strategiesPath, body: { limit: 50 } },
    { method: 'GET', path: strategiesPath, body: { limit: 50, cursor: 'INTERNAL_GLOBAL_CURSOR' } },
  ]);
  assert.deepEqual(JSON.parse(result.content[0]!.text).data, { strategies: [scopedStrategy()], next_cursor: '' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_METADATA|OTHER_PRIVATE_GROUP|INTERNAL_GLOBAL_CURSOR|st_other|st_shared|st_numeric|st_unknown|st_ambiguous/);
});

test('strategy creation fixes its group OpenID and sends only documented settings', async () => {
  const response = { strategy_id: 'st_created', is_enable: 'off', expire_at: '2027-10-28T00:00:00Z' };
  const f = fixture(() => response);
  const result = await executeGroupAdmin(f.bound, { action: 'strategy_create', conversation: key,
    isEnable: 'off', expireAt: '2027-10-28T00:00:00Z', remark: '等待确认后开启' }, now);
  assert.deepEqual(f.calls, [{ method: 'POST', path: strategiesPath, body: {
    group_openids: [conversation.id], is_enable: 'off', expire_at: '2027-10-28T00:00:00Z', remark: '等待确认后开启',
  }, signal: f.controller.signal }]);
  assert.deepEqual(JSON.parse(result.content[0]!.text).data, response);
  const defaults = fixture();
  await executeGroupAdmin(defaults.bound, { action: 'strategy_create', conversation: key }, now);
  assert.deepEqual(defaults.calls[0]!.body, { group_openids: [conversation.id] }, 'server defaults remain available');
});

test('every strategy mutation completes scope verification before one fixed-path write', async () => {
  const cases: Array<{ input: Record<string, unknown>; method: Call['method']; suffix: string; body?: unknown }> = [
    { input: { action: 'strategy_update', isEnable: 'off', remark: '' }, method: 'PATCH', suffix: '', body: { is_enable: 'off', remark: '' } },
    { input: { action: 'strategy_delete' }, method: 'DELETE', suffix: '' },
    { input: { action: 'strategy_execute' }, method: 'POST', suffix: '/execute' },
    { input: { action: 'strategy_whitelist', whitelistOp: 'add', whitelistUsers: ['123456789', '18446744073709551615'] },
      method: 'POST', suffix: '/whitelist_users', body: { op: 'add', whitelist_users: ['123456789', '18446744073709551615'] } },
    { input: { action: 'strategy_whitelist', whitelistOp: 'del', whitelistUsers: ['123456789'] },
      method: 'POST', suffix: '/whitelist_users', body: { op: 'del', whitelist_users: ['123456789'] } },
  ];
  for (const value of cases) {
    const responses = [
      { strategies: [scopedStrategy()], next_cursor: 'second-page' },
      { strategies: [{ strategy_id: 'st_other', group_openids: ['other-group'] }], next_cursor: '' },
      { strategy_id: 'st_current', is_enable: 'off' },
    ];
    let index = 0;
    const f = fixture(() => responses[index++]);
    await executeGroupAdmin(f.bound, { conversation: key, strategyId: 'st_current', ...value.input }, now);
    assert.equal(f.calls.length, 3);
    assert.deepEqual(f.calls.slice(0, 2).map(call => call.method), ['GET', 'GET']);
    assert.deepEqual(f.calls[2], { method: value.method, path: strategiesPath + '/st_current' + value.suffix, body: value.body, signal: f.controller.signal });
  }
});

test('cross-group, numeric-group and missing strategy scopes never dispatch mutations', async () => {
  const scopes = [
    { group_openids: ['other-group'], remark: 'PRIVATE_OTHER_GROUP' },
    { group_openids: [conversation.id, 'other-group'], remark: 'PRIVATE_SHARED_GROUP' },
    { group_openids: [conversation.id, conversation.id] },
    { group_ids: ['123456'] }, { group_openids: [], group_ids: ['123456'] },
    { group_openids: [conversation.id], group_ids: ['123456'] },
    { group_openids: [conversation.id], group_ids: null }, {},
    { group_openids: conversation.id }, { group_openids: [conversation.id.toLowerCase()] },
  ];
  for (const scope of scopes) for (const action of ['strategy_update', 'strategy_delete', 'strategy_execute', 'strategy_whitelist']) {
    const f = fixture(() => ({ strategies: [{ strategy_id: 'st_current', ...scope }], next_cursor: '' }));
    const extra = action === 'strategy_update' ? { isEnable: 'off' }
      : action === 'strategy_whitelist' ? { whitelistOp: 'add', whitelistUsers: ['123456'] } : {};
    await assert.rejects(executeGroupAdmin(f.bound, { action, conversation: key, strategyId: 'st_current', ...extra }, now), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /无法确认/);
      assert.doesNotMatch(error.message, /PRIVATE_OTHER_GROUP|PRIVATE_SHARED_GROUP|other-group/); return true;
    });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.method, 'GET');
  }
  const missing = fixture(() => ({ strategies: [], next_cursor: '' }));
  await assert.rejects(executeGroupAdmin(missing.bound, { action: 'strategy_delete', conversation: key, strategyId: 'st_missing' }, now), /无法确认/);
  assert.equal(missing.calls.length, 1);
});

test('a strategy scope is freshly checked on every operation instead of reusing an earlier grant', async () => {
  const replies = [
    { strategies: [scopedStrategy()], next_cursor: '' }, {},
    { strategies: [{ ...scopedStrategy(), group_openids: [conversation.id, 'new-other-group'] }], next_cursor: '' },
  ];
  let index = 0;
  const f = fixture(() => replies[index++]);
  await executeGroupAdmin(f.bound, { action: 'strategy_update', conversation: key, strategyId: 'st_current', isEnable: 'off' }, now);
  await assert.rejects(executeGroupAdmin(f.bound, { action: 'strategy_execute', conversation: key, strategyId: 'st_current' }, now), /无法确认/);
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'PATCH', 'GET']);
});

test('strategy settings and whitelist inputs cannot smuggle group identifiers or arbitrary operations', async () => {
  const f = fixture();
  const invalid = [
    { action: 'strategy_create', group_openids: ['other'] }, { action: 'strategy_create', group_ids: ['123456'] },
    { action: 'strategy_create', groupIds: ['123456'] }, { action: 'strategy_create', isEnable: true },
    { action: 'strategy_create', expireAt: '2027-02-30T10:00:00Z' }, { action: 'strategy_create', remark: '字'.repeat(256) },
    { action: 'strategy_update', strategyId: 'st_current' },
    { action: 'strategy_update', strategyId: 'st_current', isEnable: 'on', group_action: { op: 'add', group_openids: ['other'] } },
    { action: 'strategy_delete', strategyId: '../outside' }, { action: 'strategy_execute', strategyId: 'st_current', body: {} },
    { action: 'strategy_list', cursor: 'global-cursor' },
    { action: 'strategy_whitelist', strategyId: 'st_current', whitelistOp: 'replace', whitelistUsers: ['123456'] },
    { action: 'strategy_whitelist', strategyId: 'st_current', whitelistOp: 'add', whitelistUsers: [] },
    { action: 'strategy_whitelist', strategyId: 'st_current', whitelistOp: 'add', whitelistUsers: ['123456', '123456'] },
    { action: 'strategy_whitelist', strategyId: 'st_current', whitelistOp: 'add', whitelistUsers: [123456] },
    { action: 'strategy_whitelist', strategyId: 'st_current', whitelistOp: 'add', whitelistUsers: ['group:123456'] },
    { action: 'strategy_whitelist', strategyId: 'st_current', whitelistOp: 'add', whitelistUsers: ['123456789012345678901'] },
    { action: 'strategy_whitelist', strategyId: 'st_current', whitelistOp: 'add', whitelistUsers: Array.from({ length: 10001 }, (_, index) => String(index + 10000)) },
  ];
  for (const input of invalid) await assert.rejects(executeGroupAdmin(f.bound, { conversation: key, ...input }, now));
  assert.equal(f.calls.length, 0);
});

test('incomplete or contradictory strategy pagination cannot authorize a write', async () => {
  for (const replies of [
    [{ strategies: [scopedStrategy()] }],
    [{ strategies: [scopedStrategy()], next_cursor: 'same' }, { strategies: [], next_cursor: 'same' }],
    [{ strategies: [scopedStrategy()], next_cursor: 'next' }, { strategies: [{ ...scopedStrategy(), group_openids: ['other'] }], next_cursor: '' }],
  ]) {
    let index = 0;
    const f = fixture(() => replies[index++]);
    await assert.rejects(executeGroupAdmin(f.bound, { action: 'strategy_execute', conversation: key, strategyId: 'st_current' }, now), /无法确认/);
    assert.ok(f.calls.every(call => call.method === 'GET'));
  }
  let page = 0;
  const endless = fixture(() => ({ strategies: [], next_cursor: String(++page) }));
  await assert.rejects(executeGroupAdmin(endless.bound, { action: 'strategy_delete', conversation: key, strategyId: 'st_current' }, now), /查询上限/);
  assert.equal(endless.calls.length, 20);
  assert.ok(endless.calls.every(call => call.method === 'GET'));
});

test('strategy business failures are safely reported and a rejected write is not retried', async () => {
  const denied = fixture(() => ({ code: 11253, message: 'PRIVATE_GLOBAL_STRATEGIES' }));
  await assert.rejects(executeGroupAdmin(denied.bound, { action: 'strategy_list', conversation: key }, now), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /权限/); assert.doesNotMatch(error.message, /PRIVATE_GLOBAL_STRATEGIES/); return true;
  });
  const replies = [{ strategies: [scopedStrategy()], next_cursor: '' }, { code: 98765, message: 'PRIVATE_WRITE_FAILURE' }];
  let index = 0;
  const f = fixture(() => replies[index++]);
  await assert.rejects(executeGroupAdmin(f.bound, { action: 'strategy_execute', conversation: key, strategyId: 'st_current' }, now), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /结果未确认/); assert.doesNotMatch(error.message, /PRIVATE_WRITE_FAILURE/); return true;
  });
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'POST']);
});

test('cancellation during strategy scope verification prevents the later mutation', async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture(() => { f.controller.abort(); return { strategies: [scopedStrategy()], next_cursor: '' }; });
  await assert.rejects(executeGroupAdmin(f.bound, { action: 'strategy_delete', conversation: key, strategyId: 'st_current' }, now), /取消/);
  assert.deepEqual(f.calls.map(call => call.method), ['GET']);
});
