import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { ApiError, MediaFileType, QQBot, type QQBotOptions, type SendMessageOptions } from '@tencent-connect/qqbot-nodejs';
import { MEDIA_LIMITS, QQBotApiError, QQBotTransport, normalizeMessageEvent, normalizePlatformEvent, type ConversationEvent, type QQBotSdk, type ConnectionState } from '../src/transport.ts';

const GROUP = { type: 'group', id: 'group-openid_A1' } as const;
const PRIVATE = { type: 'private', id: 'user-openid_B2' } as const;
type Listener = (...args: any[]) => unknown;

function sdkMock(autoReady = true) {
  const listeners = new Map<string, Set<Listener>>();
  const sends: SendMessageOptions[] = [];
  const uploads: Array<Parameters<QQBotSdk['uploadMedia']>[0]> = [];
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  let starts = 0, stops = 0, finish: (() => void) | undefined, failStart: ((error: Error) => void) | undefined;
  let send = async (_options: SendMessageOptions): Promise<any> => ({ id: 'official-message_A1', timestamp: '2026-10-28T08:00:00+08:00', ext_info: { ref_idx: 'reference_A1' } });
  let upload = async (_options: Parameters<QQBotSdk['uploadMedia']>[0]): Promise<any> => ({ file_uuid: 'file-uuid', file_info: 'PRIVATE_FILE_INFO', ttl: 3600 });
  const apiClient = { async request(_token: string, method: string, path: string, body?: unknown) {
    requests.push({ method, path, body }); return { ok: true };
  } };
  const api = {
    get: async (path: string, query?: unknown) => apiClient.request('PRIVATE_ACCESS_TOKEN', 'GET', path, query),
    post: async (path: string, body?: unknown) => apiClient.request('PRIVATE_ACCESS_TOKEN', 'POST', path, body),
    put: async (path: string, body?: unknown) => apiClient.request('PRIVATE_ACCESS_TOKEN', 'PUT', path, body),
    patch: async (path: string, body?: unknown) => apiClient.request('PRIVATE_ACCESS_TOKEN', 'PATCH', path, body),
    delete: async (path: string) => apiClient.request('PRIVATE_ACCESS_TOKEN', 'DELETE', path),
    getToken: async () => 'PRIVATE_ACCESS_TOKEN',
  };
  const sdk = {
    on(event: string, handler: Listener) { const list = listeners.get(event) ?? new Set(); list.add(handler); listeners.set(event, list); return sdk; },
    off(event: string, handler: Listener) { listeners.get(event)?.delete(handler); return sdk; },
    start() {
      starts++;
      if (autoReady) queueMicrotask(() => { void emit('ready', {}); });
      return new Promise<void>((resolve, reject) => { finish = resolve; failStart = reject; });
    },
    stop() { stops++; finish?.(); },
    async send(options: SendMessageOptions) { sends.push(options); return send(options); },
    async uploadMedia(options: Parameters<QQBotSdk['uploadMedia']>[0]) { uploads.push(options); return upload(options); },
    api, apiClient,
  };
  async function emit(event: string, ...args: unknown[]) { await Promise.all([...(listeners.get(event) ?? [])].map(handler => handler(...args))); }
  return { sdk: sdk as unknown as QQBotSdk, sends, uploads, requests, api, apiClient, emit,
    starts: () => starts, stops: () => stops, failStart: (error: Error) => failStart!(error),
    respondSend(handler: typeof send) { send = handler; }, respondUpload(handler: typeof upload) { upload = handler; } };
}

function fixture(t: TestContext, autoReady = true, groupMemberEvents = false) {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Real network is disabled in transport tests'); });
  const f = sdkMock(autoReady), messages: ConversationEvent[] = [], statuses: ConnectionState[] = [], errors: Error[] = [];
  let options: QQBotOptions | undefined;
  const transport = new QQBotTransport({ appId: '123456789', appSecret: 'PRIVATE_APP_SECRET', groupMemberEvents,
    connectionTimeoutMs: 100, sdkFactory: value => { options = value; return f.sdk; },
    onMessage: event => { messages.push(event); }, onStatus: status => { statuses.push(status); }, onError: error => { errors.push(error); } });
  t.after(() => transport.close());
  return { ...f, transport, messages, statuses, errors, options: () => options! };
}

function wireFixture(t: TestContext, respond: (path: string, body: Record<string, unknown>) => Response) {
  const wire: Array<{ url: string; method: string; body: Record<string, unknown>; headers: Headers }> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.ok(['bots.qq.com', 'api.bot.qq.com'].includes(url.hostname), 'No external network destination is permitted');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    wire.push({ url: url.href, method: init?.method ?? 'GET', body, headers: new Headers(init?.headers) });
    if (url.pathname === '/app/getAppAccessToken') {
      assert.equal(url.origin, 'https://bots.qq.com');
      return Response.json({ access_token: 'MOCK_ACCESS_TOKEN', expires_in: '7200' });
    }
    assert.equal(url.origin, 'https://api.bot.qq.com');
    return respond(url.pathname, body);
  });
  const gateway = sdkMock();
  let sdk!: QQBot;
  const transport = new QQBotTransport({ appId: '123456789', appSecret: 'MOCK_APP_SECRET', onMessage() {}, sdkFactory: settings => {
    sdk = new QQBot(settings);
    return { ...gateway.sdk, api: sdk.api, apiClient: sdk.apiClient,
      send: sdk.send.bind(sdk), uploadMedia: sdk.uploadMedia.bind(sdk) };
  } });
  t.after(() => { transport.close(); sdk.stop(); });
  return { transport, wire };
}

function event(overrides: Record<string, unknown> = {}) {
  const raw = { id: 'received-message_X1', content: '原始正文 <faceType=1,faceId=66>', timestamp: '2026-10-28T08:00:00+08:00',
    group_openid: GROUP.id, author: { member_openid: 'member-openid_C3', username: '成员' }, message_type: 102,
    attachments: [{ content_type: 'image/png', url: 'https://qq.example/image?rkey=SIGNED_VALUE', filename: 'image.png' }],
    msg_elements: [{ msg_idx: 'original-index', message_type: 103, content: '引用', msg_elements: [
      { message_type: 0, content: '最内层原文', attachments: [{ content_type: 'audio/silk', url: 'https://qq.example/audio', asr_refer_text: '已有转写' }] },
    ] }], future_field: { retained: true } };
  return { kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', senderId: 'member-openid_C3', senderName: '成员',
    messageId: raw.id, content: 'SDK投影文字', timestamp: raw.timestamp, groupOpenid: GROUP.id, raw, ...overrides };
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) { if (Date.now() >= deadline) assert.fail('Timed out waiting for mock SDK'); await delay(2); }
}

async function mediaFixture(t: TestContext, filename = 'image.png') {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'qqbot-transport-'));
  t.after(async () => {
    const resolvedRoot = await realpath(root), within = relative(await realpath(parent), resolvedRoot);
    assert.ok(within && within !== '..' && !within.startsWith('../') && !within.startsWith('..\\') && !isAbsolute(within));
    await rm(resolvedRoot, { recursive: true, force: true });
  });
  const path = join(root, filename); await writeFile(path, 'LOCAL_MEDIA_BYTES');
  return { root, path };
}

test('official dispatch preserves opaque identities and complete raw recursive message payloads', async t => {
  const f = fixture(t); await f.transport.connect();
  const original = event();
  await f.emit('message', {}, original);
  const received = f.messages[0]!;
  assert.deepEqual(received.conversation, GROUP);
  assert.equal(received.selfId, '123456789');
  assert.equal(received.messageId, 'received-message_X1');
  assert.equal(received.rawText, original.raw.content);
  assert.deepEqual(received.raw, original.raw);
  assert.deepEqual(received.attachments, original.raw.attachments);
  assert.notEqual(received.raw, original.raw);
  assert.equal(received.eventType, 'GROUP_MESSAGE_CREATE');
  const privateRaw = { id: 'private-message', content: '', timestamp: original.timestamp, author: { user_openid: PRIVATE.id, bot: true }, message_type: 101, attachments: [] };
  const privateEvent = event({ kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE', senderId: PRIVATE.id, messageId: privateRaw.id, raw: privateRaw });
  await f.emit('message', {}, privateEvent);
  assert.deepEqual(f.messages[1]!.conversation, PRIVATE);
  assert.equal(f.messages[1]!.botAuthored, true, 'C2C raw author.bot survives the SDK missing senderIsBot projection');
  assert.equal(f.messages[1]!.outgoing, false, 'a bot author alone is not proof of our own send');
  await f.emit('message', {}, event({ rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderIsBot: true }));
  assert.equal(f.messages[2]!.outgoing, false, 'another bot is not this bot sending a message');
  assert.equal(f.messages[2]!.botAuthored, true);
  for (const value of [event({ kind: 'guild' }), event({ groupOpenid: undefined }), event({ messageId: 123 }), event({ timestamp: 'invalid' }), event({ raw: null })]) {
    assert.equal(normalizeMessageEvent(value, '123456789'), undefined);
  }
});

test('only a confirmed send in the same target marks a received echo as outgoing', async t => {
  const f = fixture(t); await f.transport.send(GROUP, { text: 'explicit send' });
  const original = event();
  const echo = event({ messageId: 'official-message_A1', raw: { ...original.raw, id: 'official-message_A1' }, senderIsBot: true });
  await f.emit('message', {}, echo);
  assert.equal(f.messages[0]!.outgoing, true);
  assert.equal(f.messages[0]!.botAuthored, true);
  await f.emit('message', {}, { ...echo, groupOpenid: 'another-group', raw: { ...echo.raw, group_openid: 'another-group' } });
  assert.equal(f.messages[1]!.outgoing, false, 'message ids from another group cannot borrow our sent proof');
});

test('gateway startup errors retain numeric platform codes without returning the SDK response text', async t => {
  const f = fixture(t, false);
  const connecting = f.transport.connect();
  void connecting.catch(() => {});
  await eventually(() => f.starts() === 1);
  const error = new ApiError('PRIVATE-SDK-RESPONSE', 400, '/gateway', 11700);
  await f.emit('error', error);
  assert.ok(f.errors.at(-1) instanceof QQBotApiError);
  assert.match(f.errors.at(-1)!.message, /11700/);
  assert.doesNotMatch(f.errors.at(-1)!.message, /PRIVATE-SDK-RESPONSE/);
  f.failStart(new Error('PRIVATE-WRAPPER', { cause: error }));
  await assert.rejects(connecting, result => result instanceof QQBotApiError && result.bizCode === 11700);
});

test('gateway creation uses fixed official hosts and only the requested group/C2C intents', async t => {
  const f = fixture(t);
  await Promise.all([f.transport.connect(), f.transport.connect()]);
  assert.equal(f.starts(), 1); assert.equal(f.transport.isConnected, true);
  assert.equal(f.options().baseUrl, 'https://api.bot.qq.com');
  assert.equal(f.options().tokenBaseUrl, 'https://bots.qq.com');
  assert.equal(f.options().intents, (1 << 25) | (1 << 26));
  assert.equal(f.options().logger, undefined);
  const enabled = fixture(t, true, true); await enabled.transport.connect();
  assert.equal(enabled.options().intents, (1 << 25) | (1 << 26) | (1 << 24));
});

test('SDK reconnection keeps sends waiting and close cancels pending connection work', async t => {
  const f = fixture(t); await f.transport.connect();
  await f.emit('disconnected', { code: 1006, reason: 'test', willReconnect: true });
  const pending = f.transport.send(GROUP, { text: '待重连发送' });
  await delay(5); assert.equal(f.sends.length, 0);
  await f.emit('resumed', {});
  assert.equal((await pending).messageId, 'official-message_A1');
  assert.equal(f.starts(), 1);
  await f.emit('disconnected', { code: 1006, reason: 'test', willReconnect: true });
  const waiting = f.transport.connect(); f.transport.close();
  await assert.rejects(waiting, /取消/);
  f.transport.close(); assert.equal(f.stops(), 1);
  assert.equal(f.transport.isConnected, false);
});

test('startup failures and SDK diagnostics never expose credentials or untrusted error text', async t => {
  const f = fixture(t, false);
  const starting = f.transport.connect(); await eventually(() => f.starts() === 1);
  f.failStart(new Error('PRIVATE_APP_SECRET https://bad.example/?token=SECRET'));
  await assert.rejects(starting, error => { assert.doesNotMatch(String(error), /SECRET|bad\.example/); return true; });
  assert.ok(f.statuses.includes('error'));
  assert.doesNotMatch(f.errors.map(error => error.message).join('\n'), /SECRET|bad\.example/);
  await assert.rejects(f.transport.connect(), /启动或连接失败/);
});

test('text sends use explicit opaque targets and passive reply ids without automatic fallbacks', async t => {
  const f = fixture(t);
  await f.transport.send(GROUP, { text: '文字', replyTo: 'opaque/reply:message' });
  await f.transport.send(PRIVATE, { text: '主动文字' });
  assert.deepEqual(f.sends, [
    { target: { scope: 'group', targetId: GROUP.id, msgId: 'opaque/reply:message' }, msgType: 0, content: '文字' },
    { target: { scope: 'c2c', targetId: PRIVATE.id }, msgType: 0, content: '主动文字' },
  ]);
  f.respondSend(async () => { throw new ApiError('SECRET response', 400, '/private/path', 11253); });
  await assert.rejects(f.transport.send(GROUP, { text: '权限测试' }), error => {
    assert.ok(error instanceof QQBotApiError); assert.equal(error.bizCode, 11253); assert.equal(error.resultUnknown, false);
    assert.match(error.message, /权限/); assert.doesNotMatch(error.message, /SECRET|private\/path/); return true;
  });
  assert.equal(f.sends.length, 3);
});

test('media uploads bytes first and dispatches exactly one captioned message after the receipt', async t => {
  const f = fixture(t), file = await mediaFixture(t);
  await f.transport.send(GROUP, { text: '图片说明', images: [file.path], replyTo: 'received-message_X1' });
  assert.equal(f.uploads.length, 1); assert.equal(f.uploads[0]!.srvSendMsg, false);
  assert.equal(f.uploads[0]!.fileType, MediaFileType.IMAGE);
  assert.equal(f.uploads[0]!.buffer!.toString(), 'LOCAL_MEDIA_BYTES');
  assert.deepEqual(f.sends, [{ target: { scope: 'group', targetId: GROUP.id, msgId: 'received-message_X1' }, msgType: 7,
    media: { file_info: 'PRIVATE_FILE_INFO' }, content: '图片说明' }]);
  for (const [kind, extension, fileType] of [['voice', '.wav', 3], ['voice', '.mp3', 3], ['voice', '.silk', 3], ['video', '.mp4', 2], ['file', '.pdf', 4]] as const) {
    const path = join(file.root, `sample${extension}`); await writeFile(path, 'OTHER_MEDIA');
    await f.transport.sendMedia(PRIVATE, { kind, path, fileName: `sent${extension}`, text: '说明' });
    assert.equal(f.uploads.at(-1)!.fileType, fileType);
    assert.equal(f.uploads.at(-1)!.fileName, `sent${extension}`);
  }
});

test('invalid media and input bounds fail before upload or send', async t => {
  const f = fixture(t), file = await mediaFixture(t, 'sample.wav');
  for (const input of [{}, { text: ' ' }, { text: 'x'.repeat(4501) }, { images: [file.path, file.path] }, { text: 'x', replyTo: '' }]) {
    await assert.rejects(f.transport.send(GROUP, input));
  }
  await assert.rejects(f.transport.sendMedia(GROUP, { kind: 'voice', path: join(file.root, 'sample.ogg') }), /WAV/);
  await assert.rejects(f.transport.sendMedia(GROUP, { kind: 'file', path: file.path, fileName: '../file' }), /文件名/);
  const handle = await open(file.path, 'r+'); try { await handle.truncate(MEDIA_LIMITS.voice + 1); } finally { await handle.close(); }
  await assert.rejects(f.transport.sendMedia(GROUP, { kind: 'voice', path: file.path }), /20 MiB/);
  assert.deepEqual(f.uploads, []); assert.deepEqual(f.sends, []);
});

test('cancellation during media upload prevents the message from being dispatched', async t => {
  const f = fixture(t), file = await mediaFixture(t), controller = new AbortController();
  let finish!: (value: any) => void;
  f.respondUpload(() => new Promise(resolve => { finish = resolve; }));
  const sending = f.transport.sendMedia(GROUP, { kind: 'image', path: file.path }, controller.signal);
  await eventually(() => f.uploads.length === 1); controller.abort(new Error('SECRET_ABORT'));
  await assert.rejects(sending, /尚未发送/);
  finish({ file_info: 'late-file', file_uuid: 'late', ttl: 1 }); await delay(5);
  assert.deepEqual(f.sends, []);
});

test('a cancellation or malformed receipt after send dispatch stays unknown and is never replayed', async t => {
  const f = fixture(t), controller = new AbortController();
  let finish!: (value: any) => void;
  f.respondSend(() => new Promise(resolve => { finish = resolve; }));
  const sending = f.transport.send(GROUP, { text: '一次' }, controller.signal);
  await eventually(() => f.sends.length === 1); controller.abort();
  await assert.rejects(sending, /结果未知/);
  finish({ id: 'late-receipt', timestamp: 0 }); await delay(5);
  assert.equal(f.sends.length, 1);
  f.respondSend(async () => ({ id: 123 }));
  await assert.rejects(f.transport.send(GROUP, { text: '无效回执' }), /回执无效/);
  assert.equal(f.sends.length, 2);
});

test('fixed-host REST guards cancellation even after a delayed SDK token refresh', async t => {
  const f = fixture(t); await f.transport.connect();
  for (const path of ['https://outside.example', '//outside.example', '/v2/groups/../token', '/bad\\path']) {
    await assert.rejects(f.transport.request('GET', path), /路径无效/);
  }
  assert.deepEqual(await f.transport.request('GET', '/v2/groups/group-openid_A1/members', { cursor: 'opaque', limit: 10 }), { ok: true });
  assert.deepEqual(f.requests, [{ method: 'GET', path: '/v2/groups/group-openid_A1/members', body: { cursor: 'opaque', limit: 10 } }]);
  let release!: () => void, tokenWaitStarted = false;
  const token = new Promise<void>(resolve => { release = resolve; });
  f.api.post = async (path, body) => { tokenWaitStarted = true; await token; return f.apiClient.request('secret', 'POST', path, body); };
  const controller = new AbortController();
  const pending = f.transport.request('POST', '/v2/groups/group-openid_A1/messages', { content: 'not dispatched' }, controller.signal);
  await eventually(() => tokenWaitStarted); controller.abort();
  await assert.rejects(pending, /结果未知/);
  release(); await delay(5);
  assert.equal(f.requests.length, 1, 'late mutation is blocked before SDK HTTP dispatch');
});

test('official notices preserve raw payloads and interactions only acknowledge protocol receipt', async t => {
  const f = fixture(t, true, true); await f.transport.connect();
  const joinRequest = { group_openid: GROUP.id, member_openid: 'applicant', join_request_id: 'request-abc', username: '申请人',
    apply_at: '2026-10-28T08:00:00+08:00', verify_info: { method: 'admin_review_qa', review_qa_list: [{ question: '问题', answer: '答案' }] } };
  await f.emit('rawEvent', { eventType: 'GROUP_JOIN_REQUEST', data: joinRequest });
  await f.emit('rawEvent', { eventType: 'GROUP_JOIN_REQUEST', data: joinRequest });
  assert.equal(f.messages[0]!.messageId, f.messages[1]!.messageId);
  assert.match(f.messages[0]!.messageId, /^event:GROUP_JOIN_REQUEST:/);
  assert.deepEqual(f.messages[0]!.raw, joinRequest);
  const added = { group_openid: GROUP.id, member_openid: 'member', timestamp: 1793145600 };
  const first = normalizePlatformEvent('GROUP_MEMBER_ADD', added, '123456789')!;
  const second = normalizePlatformEvent('GROUP_MEMBER_ADD', added, '123456789')!;
  assert.notEqual(first.messageId, second.messageId, 'without a platform id every delivered notice is retained');
  await f.emit('interaction', {}, { id: 'interaction-1', type: 11, scene: 'group', group_openid: GROUP.id, user_openid: PRIVATE.id, data: { resolved: { button_data: 'untrusted' } } });
  assert.equal(f.messages.at(-1)!.eventType, 'INTERACTION_CREATE');
  await f.emit('interaction', {}, { id: 'menu-1', type: 12, scene: 'c2c', user_openid: PRIVATE.id, data: { resolved: { feature_id: 'untrusted-menu' } } });
  assert.equal(normalizePlatformEvent('GROUP_JOIN_REQUEST', { join_request_id: 'request' }, '123456789'), undefined);
  assert.equal(normalizePlatformEvent('INTERACTION_CREATE', { id: 'i', user_openid: PRIVATE.id }, '123456789'), undefined);
  await f.emit('interaction', {}, { id: 'interaction-ignored', type: 11, scene: 'unknown', user_openid: PRIVATE.id, data: { resolved: { button_data: 'do not execute' } } });
  assert.deepEqual(f.sends, []);
  assert.deepEqual(f.requests, [
    { method: 'PUT', path: '/interactions/interaction-1', body: { code: 0 } },
    { method: 'PUT', path: '/interactions/menu-1', body: { code: 0 } },
    { method: 'PUT', path: '/interactions/interaction-ignored', body: { code: 3 } },
  ]);
});

test('authorization and clear-session notices are retained without confirming an unperformed action', async t => {
  const f = fixture(t); await f.transport.connect();
  const types = [13, 14, 15, 16, 18, 19, 20, 999, undefined];
  for (const [index, type] of types.entries()) {
    const notice = { id: `notice-${index}`, ...(type === undefined ? {} : { type }), scene: 'group', group_openid: GROUP.id,
      data: { type: type === 20 ? 2001 : type, resolved: {} } };
    await f.emit('interaction', {}, notice);
    assert.deepEqual(f.messages.at(-1)!.raw, notice);
  }
  assert.equal(f.messages.length, types.length);
  assert.deepEqual(f.requests, [], 'no acknowledgement that could report a clear-session or authorization operation as completed');
  assert.deepEqual(f.sends, []);
});

test('HTTP 200 business failures remain failures and documented empty 204 responses succeed', async t => {
  const f = fixture(t); await f.transport.connect();
  for (const body of [{ code: 11253, message: 'SECRET_AUTH' }, { code: 0, err_code: 11282, message: 'SECRET_AUTH' }]) {
    f.api.post = async () => body as any;
    await assert.rejects(f.transport.request('POST', '/v2/groups/group-openid_A1/test', {}), error => {
      assert.ok(error instanceof QQBotApiError); assert.equal(error.httpStatus, 200); assert.equal(error.resultUnknown, false);
      assert.ok([11253, 11282].includes(error.bizCode!)); assert.doesNotMatch(error.message, /SECRET_AUTH/); return true;
    });
    f.respondSend(async () => body);
    await assert.rejects(f.transport.send(GROUP, { text: '业务失败' }), QQBotApiError);
  }
  f.api.delete = async () => { throw new ApiError('JSON parse failed on empty body', 204, '/v2/groups/group-openid_A1/messages/id'); };
  assert.equal(await f.transport.request('DELETE', '/v2/groups/group-openid_A1/messages/id'), null);
});

test('real SDK requests accept only documented empty 200 results without hiding malformed or rejected responses', async t => {
  let response = () => new Response('', { status: 200 });
  const f = wireFixture(t, () => response());
  const bareSdk = new QQBot({ appId: '123456789', appSecret: 'MOCK_APP_SECRET',
    baseUrl: 'https://api.bot.qq.com', tokenBaseUrl: 'https://bots.qq.com' });
  t.after(() => bareSdk.stop());
  await assert.rejects(bareSdk.api.delete('/v2/groups/group/messages/message'), error => error instanceof ApiError && error.httpStatus === 200);
  for (const [method, path] of [
    ['DELETE', '/v2/groups/group/messages/message'], ['DELETE', '/v2/users/user/messages/message'],
    ['DELETE', '/v2/groups/join_approval_strategy/strategy'], ['POST', '/v2/groups/join_approval_strategy/strategy/execute'],
  ] as const) {
    const before = f.wire.filter(item => item.url.startsWith('https://api.bot.qq.com')).length;
    assert.equal(await f.transport.request(method, path, method === 'POST' ? {} : undefined), null);
    assert.equal(f.wire.filter(item => item.url.startsWith('https://api.bot.qq.com')).length, before + 1, 'one request and no retry');
    assert.equal(f.wire.at(-1)!.headers.get('authorization'), 'QQBot MOCK_ACCESS_TOKEN');
  }
  await assert.rejects(f.transport.request('DELETE', '/v2/groups/group/unlisted'), QQBotApiError);
  for (const body of ['broken JSON', '<html>upstream failure</html>', ' ']) {
    response = () => new Response(body, { status: 200 });
    await assert.rejects(f.transport.request('DELETE', '/v2/users/user/messages/message'), error => error instanceof QQBotApiError && error.resultUnknown);
  }
  for (const body of [{ code: 11253, message: 'PRIVATE_ERROR' }, { code: 0, err_code: 11282, message: 'PRIVATE_ERROR' }]) {
    response = () => Response.json(body);
    await assert.rejects(f.transport.request('DELETE', '/v2/groups/group/messages/message'), error => {
      assert.ok(error instanceof QQBotApiError); assert.equal(error.resultUnknown, false);
      assert.ok([11253, 11282].includes(error.bizCode!)); assert.doesNotMatch(error.message, /PRIVATE_ERROR/); return true;
    });
  }
  response = () => new Response('', { status: 403 });
  await assert.rejects(f.transport.request('DELETE', '/v2/groups/group/messages/message'), error => error instanceof QQBotApiError && error.httpStatus === 403 && !error.resultUnknown);
  response = () => new Response(null, { status: 204 });
  assert.equal(await f.transport.request('DELETE', '/v2/users/user/messages/message'), null);
});

test('real SDK binary and chunk completion uploads include the required filename on the wire', async t => {
  let messageNumber = 0;
  const f = wireFixture(t, (path, body) => {
    if (path.endsWith('/upload_prepare')) return Response.json({ upload_id: 'mock-upload-id', block_size: 5 * 1024 * 1024, parts: [] });
    if (path.endsWith('/files')) {
      assert.equal(typeof body.file_name, 'string');
      assert.ok(typeof body.file_data === 'string' || body.upload_id === 'mock-upload-id');
      return Response.json({ file_uuid: 'mock-file', file_info: 'MOCK_FILE_INFO', ttl: 3600 });
    }
    assert.ok(path.endsWith('/messages'));
    return Response.json({ id: `mock-message-${++messageNumber}`, timestamp: '2026-10-28T08:00:00+08:00' });
  });
  const file = await mediaFixture(t);
  for (const [kind, extension, target] of [['image', '.png', GROUP], ['voice', '.wav', PRIVATE], ['video', '.mp4', GROUP], ['file', '.pdf', PRIVATE]] as const) {
    const path = join(file.root, `local${extension}`); await writeFile(path, `synthetic-${kind}`);
    await f.transport.sendMedia(target, { kind, path, fileName: `sent${extension}`, text: '说明' });
    const upload = f.wire.filter(item => item.url.endsWith('/files')).at(-1)!;
    assert.equal(upload.body.file_name, `sent${extension}`);
    assert.equal(upload.body.srv_send_msg, false);
  }
  const largePath = join(file.root, 'large.mp4');
  const handle = await open(largePath, 'w'); try { await handle.truncate(6 * 1024 * 1024); } finally { await handle.close(); }
  await f.transport.sendMedia(GROUP, { kind: 'video', path: largePath, fileName: 'large-sent.mp4' });
  const complete = f.wire.filter(item => item.url.endsWith('/files')).at(-1)!;
  assert.deepEqual(complete.body, { upload_id: 'mock-upload-id', file_name: 'large-sent.mp4' });
  assert.equal(f.wire.filter(item => item.url.endsWith('/messages')).length, 5);
});
