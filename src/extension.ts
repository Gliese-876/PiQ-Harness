import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { adoptTemporaryConversation, claimConversations, loadConfig, type GroupConfig } from './config.ts';
import { conversationKey, parseConversationKey, type Conversation } from './conversations.ts';
import { Notifier } from './notifier.ts';
import { GroupStore } from './store.ts';
import { SnowLumaTransport, type ConversationEvent, type PokeEvent } from './transport.ts';
import { HistorySync } from './history.ts';
import { registerModelControl } from './model-control.ts';
import { resolveGroupEnvironment } from './web-terminal.ts';
import { RunController, type ConnectionState } from './run-control.ts';
import { ensureSnowLuma } from './snowluma-service.ts';
import { registerGroupFileTool } from './group-files.ts';
import { registerAlbumTool } from './albums.ts';
import { registerChatHistoryTool } from './chat-history.ts';
import { registerForwardMessageTool } from './forward-messages.ts';
import { registerForwardSendTool } from './forward-send.ts';
import { manageSticker } from './sticker-management.ts';
import { workspaceFile } from './workspace-files.ts';
import { registerTerminal } from './terminal-monitor.ts';

const SIGNAL = 'piq:messages';

interface Binding {
  id: string;
  cwd: string;
  config: GroupConfig;
  ctx: ExtensionContext;
  store: GroupStore;
  transport: SnowLumaTransport;
  notifier: Notifier;
  histories: Map<string, HistorySync>;
  releaseConversations?: () => Promise<void>;
  closed: boolean;
  selfId?: string;
  status: ConnectionState;
  control?: RunController;
  sendAbort: AbortController;
  resumeTurn: boolean;
  lastError?: string;
  recovering?: Promise<void>;
  receiving: Promise<void>;
}

/** Asset paths belong to this workspace, including the resolved symlink target. */
export async function resolveImage(cwd: string, path: string): Promise<string> {
  const root = await realpath(cwd);
  const file = await realpath(resolve(root, path));
  const fromRoot = relative(root, file);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(fromRoot) || !(await stat(file)).isFile()) {
    throw new Error('图片须为当前对话组目录内的文件。请先将图片保存到本组 assets/。');
  }
  return file;
}

export default function piq(pi: ExtensionAPI): void {
  let binding: Binding | undefined;
  let generation = 0;

  function report(current: Binding, message: string): void {
    if (current.closed) return;
    current.ctx.ui.notify(`PiQ: ${message}`, 'error');
  }

  function syncing(current: Binding): boolean {
    return [...current.histories.values()].some(history => history.running);
  }

  function addHistory(current: Binding, conversation: Conversation): HistorySync {
    const key = conversationKey(conversation);
    const existing = current.histories.get(key);
    if (existing) return existing;
    const history = new HistorySync({
      conversation, store: current.store,
      fetch: (cursor,count,signal) => current.transport.fetchHistory(conversation,cursor,count,signal),
      changed: () => { if (!current.closed) { current.notifier.schedule(); current.control?.refresh(); resumeIfReady(current); } },
      error: error => report(current, `${key} 历史补拉：${error instanceof Error ? error.message : String(error)}`),
    });
    current.histories.set(key,history);
    return history;
  }

  async function receive(current: Binding, event: ConversationEvent): Promise<void> {
    const key = conversationKey(event.conversation);
    let history = current.histories.get(key);
    if (!history && event.conversation.type === 'temporary') {
      const adopted = await adoptTemporaryConversation(current.cwd,event.conversation);
      if (!adopted) return;
      current.config = adopted;
      current.store.addConversation(event.conversation);
      history = addHistory(current,event.conversation);
      if (!current.closed && current.transport.isConnected) history.connect();
    }
    if (!history) return;
    current.selfId = event.selfId;
    await history.receive(event);
  }

  async function receivePoke(current: Binding, event: PokeEvent): Promise<void> {
    if (!current.histories.has(conversationKey(event.conversation))) return;
    current.selfId = event.selfId;
    await current.store.appendPoke(event);
    current.notifier.schedule();
    current.control?.refresh();
  }

  function active(ctx: ExtensionContext): Binding {
    const current = binding;
    if (!current || current.closed || resolve(ctx.cwd) !== resolve(current.cwd)) throw new Error('当前会话未连接本对话组。');
    if (current.control?.paused) throw new Error('PiQ 已暂停，请在 WebUI 恢复运行。');
    return current;
  }

  function action(ctx: ExtensionContext, key: string, signal?: AbortSignal) {
    const current = active(ctx);
    const target = parseConversationKey(key);
    if (!current.histories.has(conversationKey(target))) throw new Error('目标对话不属于当前对话组。');
    const sendSignal = signal ? AbortSignal.any([signal, current.sendAbort.signal]) : current.sendAbort.signal;
    return { current, target, sendSignal };
  }

  function resourceContext(ctx: ExtensionContext, key: string, signal?: AbortSignal) {
    const { current, target, sendSignal } = action(ctx, key, signal);
    return { cwd: current.cwd, conversation: target, signal: sendSignal, transport: current.transport };
  }

  async function rememberSend(current: Binding, target: Conversation, messageId: string, rawText: string, segments: ConversationEvent['segments']): Promise<string> {
    try {
      await current.store.append({ conversation: target, messageId, rawText, segments, outgoing: true,
        selfId: current.selfId ?? 'self', userId: current.selfId ?? 'self', sender: 'Pi', time: Math.floor(Date.now() / 1000) });
      return '';
    } catch { return '；发送已成功，但本地日志写入失败，请勿因日志错误重发'; }
  }

  function resumeIfReady(current: Binding): void {
    if (current.closed || !current.resumeTurn || current.control?.paused || !current.transport.isConnected || syncing(current) || !current.ctx.isIdle()) return;
    current.resumeTurn = false;
    if (current.store.pending()) { current.notifier.schedule(); return; }
    pi.sendMessage({ customType: 'piq:resume', content: 'PiQ 已恢复，可继续处理刚才中断的对话任务。', display: true }, { triggerTurn: true, deliverAs: 'followUp' });
  }

  function recoverConnection(current: Binding): void {
    if (current.closed || current.recovering || process.env.PIQ_SNOWLUMA_AUTOSTART === '0') return;
    current.recovering = ensureSnowLuma(current.cwd).then(result => {
      if (current.closed) return;
      if (!result.ok && !current.transport.isConnected) current.lastError = result.message;
      current.control?.refresh();
    }).catch(() => {
      if (!current.closed) { current.lastError = 'SnowLuma 自动恢复失败，请在 WebUI 使用手动恢复入口。'; current.control?.refresh(); }
    }).finally(() => { current.recovering = undefined; });
  }

  async function stop(): Promise<void> {
    generation++;
    const current = binding;
    binding = undefined;
    if (!current) return;
    current.closed = true;
    current.sendAbort.abort(new Error('本对话组会话已关闭。'));
    current.notifier.close();
    current.transport.close();
    await current.receiving;
    await current.control?.close();
    for (const history of current.histories.values()) history.close();
    await current.releaseConversations?.();
    current.ctx.ui.setStatus('piq', undefined);
    await current.store.close();
  }

  pi.on('session_start', async (_event, ctx) => {
    await stop();
    const startGeneration = generation;
    let store: GroupStore | undefined;
    let releaseConversations: (() => Promise<void>) | undefined;
    try {
      const config = await loadConfig(ctx.cwd);
      if (!config || startGeneration !== generation) return;
      if (!config.conversations.length) throw new Error('请先给本对话组添加至少一个对话。');
      const credentials = await resolveGroupEnvironment(ctx.cwd, config);
      if (startGeneration !== generation) return;
      store = await GroupStore.open(ctx.cwd, config);
      if (startGeneration !== generation) { await store.close(); return; }
      releaseConversations = await claimConversations(ctx.cwd, config);
      if (startGeneration !== generation) { await releaseConversations(); await store.close(); return; }
      const terminalToken = process.env.PIQ_TERMINAL_RETURN_TOKEN;
      const wrapperPid = Number(process.env.PIQ_TERMINAL_WRAPPER_PID);
      if (terminalToken && Number.isSafeInteger(wrapperPid) && wrapperPid > 0 && process.env.PIQ_RUN_MODE !== 'background') {
        await registerTerminal(ctx.cwd, terminalToken, wrapperPid, process.pid);
        if (startGeneration !== generation) { await releaseConversations(); await store.close(); return; }
      }
      const current = {
        id: randomUUID(), cwd: ctx.cwd, ctx, config, store,
        releaseConversations, histories: new Map<string, HistorySync>(),
        closed: false, status: 'connecting', sendAbort: new AbortController(), resumeTurn: false, receiving: Promise.resolve(),
      } as Binding;
      current.notifier = new Notifier(config, {
        pending: () => current.store.pending(),
        lastNotifiedAt: () => current.store.lastNotifiedAt,
        isIdle: () => !current.closed && !current.control?.paused && current.transport?.isConnected && !syncing(current) && current.ctx.isIdle(),
        send: pending => {
          current.resumeTurn = false;
          pi.sendMessage({
            customType: SIGNAL,
            content: `对话组 ${current.config.name} 有 ${pending.count} 条新消息，来自 ${pending.conversations.length} 个对话（至 #${pending.through}）：\n`
              + pending.conversations.map(item => `${conversationKey(item.conversation)}：${item.count} 条，#${item.firstSeq}–#${item.lastSeq}，日志 ${item.files.join('、')}`).join('\n'),
            display: true,
            details: { bindingId: current.id, groupId: config.id, through: pending.through, conversations: pending.conversations },
          }, { triggerTurn: true, deliverAs: 'followUp' });
        },
        stalled: error => report(current, error instanceof Error ? error.message : String(error)),
      });
      current.transport = new SnowLumaTransport({
        url: config.wsUrl,
        accessToken: credentials.env[config.accessTokenEnv],
        onMessage: event => {
          if (current.closed) return;
          current.receiving = current.receiving.then(()=>receive(current,event)).catch(error=>current.notifier.fail(error));
        },
        onPoke: event => {
          if (current.closed) return;
          current.receiving = current.receiving.then(()=>receivePoke(current,event)).catch(error=>current.notifier.fail(error));
        },
        onStatus: status => {
          if (current.closed) return;
          current.status = status;
          current.lastError = status === 'connected' ? undefined : `SnowLuma 未连接（${config.wsUrl}）。请确认服务、QQ 登录和令牌配置。`;
          if (status === 'connected') { for (const history of current.histories.values()) history.connect(); resumeIfReady(current); }
          if (status === 'disconnected') { for (const history of current.histories.values()) history.disconnect(); recoverConnection(current); }
          current.control?.refresh();
          ctx.ui.setStatus('piq', `${config.name} · ${status}`);
        },
      });
      for (const conversation of config.conversations) addHistory(current,conversation);
      current.control = await RunController.open(ctx.cwd, {
        snapshot: () => {
          const pending = current.store.pending();
          return { connection: current.status, pendingCount: pending?.count ?? 0,
            pendingConversations: pending?.conversations.map(item=>({key:conversationKey(item.conversation),count:item.count})) ?? [], lastError: current.lastError };
        },
        isBusy: () => !current.ctx.isIdle(),
        pause: () => {
          current.notifier.suspend();
          current.sendAbort.abort(new Error('PiQ 已暂停，发送已取消。'));
          current.ctx.abort();
        },
        resume: interrupted => {
          current.sendAbort = new AbortController();
          current.resumeTurn ||= interrupted;
          current.notifier.retry();
          resumeIfReady(current);
        },
        shutdown: () => current.ctx.shutdown(),
        error: error => report(current, `运行控制：${error instanceof Error ? error.message : String(error)}`),
      });
      current.resumeTurn ||= current.control.needsResume;
      if (current.control.paused) current.notifier.suspend();
      binding = current;
      current.notifier.schedule();
      recoverConnection(current);
      // A failed first connection leaves the OneBot reconnect loop alive.
      void current.transport.connect().catch(() => {
        if (!current.closed) ctx.ui.setStatus('piq', `${config.name} · 等待连接（检查 SnowLuma 与 ${config.accessTokenEnv}）`);
      });
    } catch (error) {
      await releaseConversations?.();
      await store?.close();
      ctx.ui.notify(`PiQ 启动失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  });

  pi.on('session_shutdown', stop);
  pi.on('agent_start', async (_event, ctx) => {
    if (!binding || binding.closed) return;
    binding.ctx = ctx;
    await binding.control?.markBusy(true);
  });
  pi.on('agent_settled', async (_event, ctx) => {
    if (!binding || binding.closed) return;
    const current = binding;
    current.ctx = ctx;
    await current.control?.markBusy(false);
    resumeIfReady(current);
    current.notifier.schedule();
  });

  pi.on('message_end', async event => {
    const current = binding;
    if (!current || current.closed || event.message.role !== 'custom' || event.message.customType !== SIGNAL) return;
    const details = event.message.details as { bindingId?: string; groupId?: string; through?: number } | undefined;
    if (details?.bindingId !== current.id || details.groupId !== current.config.id || !Number.isSafeInteger(details.through)) return;
    try {
      await current.store.acknowledge(details.through!);
      current.notifier.confirm(details.through!);
    } catch (error) { current.notifier.fail(error); }
  });

  pi.registerCommand('piq', {
    description: '查看本对话组状态；/piq retry 恢复通知；/piq sync 重试离线历史补拉',
    handler: async (args, ctx) => {
      if (!binding) { ctx.ui.notify('当前目录未接入 PiQ；先运行 piq init。', 'info'); return; }
      if (args.trim() === 'retry' && !binding.control?.paused) binding.notifier.retry();
      if (args.trim() === 'sync') for (const history of binding.histories.values()) history.retry();
      ctx.ui.notify(`对话组 ${binding.config.name} · ${binding.control?.paused ? '已暂停 · ' : ''}${binding.status}${syncing(binding) ? ' · 正在补拉历史' : ''} · 待通知 ${binding.store.pending()?.count ?? 0} 条`, 'info');
    },
  });

  pi.registerTool({
    name: 'qq_send',
    label: '发送 QQ 消息',
    description: '向本对话组配置的指定对话发送文字、图片。conversation 为 PIQ.md 中的 group:群号、private:QQ号 或 temporary:来源群:QQ号。根据目标对话自己的日志回复。发送结果未知时先查记录再决定是否重发。',
    parameters: Type.Object({
      conversation: Type.String({ description: '目标对话标识：group:群号、private:QQ号 或 temporary:来源群:QQ号，必须属于本对话组。' }),
      text: Type.Optional(Type.String({ description: '发送的文字（作为普通文本）。' })),
      images: Type.Optional(Type.Array(Type.String(), { description: '当前对话组内图片的相对或绝对路径，可自行保存表情包后发送。' })),
      replyTo: Type.Optional(Type.Integer({ description: '引用的 QQ message_id，可能是负数。' })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const current = binding;
      if (!current || current.closed || resolve(ctx.cwd) !== resolve(current.cwd)) throw new Error('当前会话未连接本对话组。');
      const target = parseConversationKey(params.conversation);
      if (!current.histories.has(conversationKey(target))) throw new Error('目标对话不属于当前对话组，消息未发送。');
      if (current.control?.paused) throw new Error('PiQ 已暂停，消息未发送。请在 WebUI 恢复运行。');
      const sendSignal = signal ? AbortSignal.any([signal, current.sendAbort.signal]) : current.sendAbort.signal;
      const images = await Promise.all((params.images ?? []).map(path => resolveImage(current.cwd, path)));
      if (current.closed || binding !== current) throw new Error('会话已切换，消息未发送。');
      if (current.control?.paused) throw new Error('PiQ 已暂停，消息未发送。');
      const result = await current.transport.send(target, { text: params.text, replyTo: params.replyTo, images }, sendSignal);
      const outgoing: ConversationEvent = {
        conversation: target, selfId: current.selfId ?? 'self', userId: current.selfId ?? 'self',
        messageId: result.messageId, time: Math.floor(Date.now() / 1000), sender: 'Pi',
        rawText: params.text ?? '', outgoing: true,
        segments: [
          ...(params.replyTo === undefined ? [] : [{ type: 'reply', data: { id: String(params.replyTo) } }]),
          ...(params.text ? [{ type: 'text', data: { text: params.text } }] : []),
          ...images.map(file => ({ type: 'image', data: { file } })),
        ],
      };
      let warning = '';
      try { await current.store.append(outgoing); }
      catch { warning = '；发送已成功，但本地日志写入失败，请勿因日志错误重发'; }
      return {
        content: [{ type: 'text', text: `已发送到 ${conversationKey(target)}，message_id=${result.messageId}${warning}` }],
        details: { conversation: target, ...result, warning: warning || undefined },
      };
    },
  });
  pi.registerTool({
    name: 'qq_poke', label: 'QQ 戳一戳',
    description: '在指定群聊中戳一个成员，或在好友私聊中戳对方。临时私聊不支持。只在明确调用时执行，结果未知时不要自动重试。',
    parameters: Type.Object({
      conversation: Type.String({ description: '本对话组内的目标对话标识。' }),
      userId: Type.Optional(Type.String({ description: '群聊中必填目标成员 QQ；好友私聊默认对方，只能戳该对方。' })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const { current, target, sendSignal } = action(ctx, params.conversation, signal);
      const result = await current.transport.poke(target, params.userId, sendSignal);
      current.selfId = result.selfId;
      let warning = '';
      try {
        await current.store.appendPoke({ kind: 'poke', eventId: randomUUID(), source: 'action', conversation: target,
          selfId: result.selfId, userId: result.selfId, targetId: result.userId, sender: 'Pi',
          time: Math.floor(Date.now() / 1000), rawText: `${result.selfId} 戳了 ${result.userId}`, outgoing: true,
          segments: [{ type: 'poke', data: { user_id: result.selfId, target_id: result.userId } }] });
      } catch { warning = '；动作已成功，但本地日志写入失败，请勿因此重试'; }
      return { content: [{ type: 'text', text: `已在 ${conversationKey(target)} 戳了 ${result.userId}${warning}` }],
        details: { conversation: target, userId: result.userId, warning: warning || undefined } };
    },
  });
  pi.registerTool({
    name: 'qq_react', label: 'QQ 表情回应',
    description: '为指定群消息添加或取消表情回应。仅支持群聊，messageId 是 QQ 消息 ID；emojiId 是 QQ 表情编号或后端接受的表情代码。',
    parameters: Type.Object({
      conversation: Type.String(), messageId: Type.Integer(), emojiId: Type.String(),
      set: Type.Optional(Type.Boolean({ description: '默认 true 添加，false 取消。' })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const { current, target, sendSignal } = action(ctx, params.conversation, signal);
      await current.transport.react(target, params.messageId, params.emojiId, params.set ?? true, sendSignal);
      return { content: [{ type: 'text', text: `已${params.set === false ? '取消' : '添加'} ${conversationKey(target)} 消息 ${params.messageId} 的表情回应 ${params.emojiId}` }],
        details: { conversation: target, messageId: params.messageId, emojiId: params.emojiId, set: params.set ?? true } };
    },
  });
  pi.registerTool({
    name: 'qq_recall', label: '撤回 QQ 消息',
    description: '撤回本账号在指定对话中发送的消息。使用 QQ messageId；会核验所属对话和发送者，QQ 时间窗口或权限限制可能导致失败。',
    parameters: Type.Object({ conversation: Type.String(), messageId: Type.Integer() }),
    async execute(_id, params, signal, _update, ctx) {
      const { current, target, sendSignal } = action(ctx, params.conversation, signal);
      await current.transport.recall(target, params.messageId, sendSignal);
      return { content: [{ type: 'text', text: `已撤回 ${conversationKey(target)} 的消息 ${params.messageId}` }],
        details: { conversation: target, messageId: params.messageId } };
    },
  });
  pi.registerTool({
    name: 'qq_sticker', label: 'QQ 收藏表情',
    description: 'list 查询当前 QQ 账号的收藏表情；send 按 emojiId 发送到本组群聊或好友私聊，可引用消息。add 从本组 path 添加收藏，remove 删除，rename 用 name 改备注，promote 置顶。收藏管理影响本 QQ 账号的共用收藏；发送必须指定 conversation，临时私聊不支持。',
    parameters: Type.Object({
      action: Type.Union(['list', 'send', 'add', 'remove', 'rename', 'promote'].map(value => Type.Literal(value))),
      conversation: Type.Optional(Type.String()), emojiId: Type.Optional(Type.String()),
      replyTo: Type.Optional(Type.Integer()), count: Type.Optional(Type.Integer({ minimum: 0 })),
      path: Type.Optional(Type.String()), name: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (params.action === 'list') {
        const current = params.conversation ? action(ctx, params.conversation, signal).current : active(ctx);
        const listSignal = signal ? AbortSignal.any([signal, current.sendAbort.signal]) : current.sendAbort.signal;
        const stickers = await current.transport.listStickers(params.count ?? 48, listSignal);
        return { content: [{ type: 'text', text: JSON.stringify(stickers) }], details: { stickers } };
      }
      if (params.action !== 'send') {
        const current = params.conversation ? action(ctx, params.conversation, signal).current : active(ctx);
        const resourceSignal = signal ? AbortSignal.any([signal, current.sendAbort.signal]) : current.sendAbort.signal;
        const result = await current.transport.resources(request => manageSticker(request, current.cwd, {
          action: params.action as 'add' | 'remove' | 'rename' | 'promote', path: params.path, emojiId: params.emojiId, name: params.name,
        }, resourceSignal), resourceSignal);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { result } };
      }
      if (!params.conversation || !params.emojiId) throw new Error('发送收藏表情需要 conversation 和 emojiId。');
      const { current, target, sendSignal } = action(ctx, params.conversation, signal);
      const result = await current.transport.sendSticker(target, params.emojiId, params.replyTo, sendSignal);
      const warning = await rememberSend(current, target, result.messageId, '[收藏表情]', [
        ...(params.replyTo === undefined ? [] : [{ type: 'reply', data: { id: String(params.replyTo) } }]),
        { type: 'custom_face', data: { emoji_id: params.emojiId } },
      ]);
      return { content: [{ type: 'text', text: `已发送收藏表情到 ${conversationKey(target)}，message_id=${result.messageId}${warning}` }],
        details: { conversation: target, ...result, emojiId: params.emojiId, warning: warning || undefined } };
    },
  });
  pi.registerTool({
    name: 'qq_voice', label: 'QQ 语音',
    description: 'send_file 将本组 path 音频文件作为语音消息发送，支持群聊、好友和临时私聊，最大 32 MiB。list 查询群 QQ AI 音色；send 用 text 和 characterId 发送群 AI 语音；transcribe 按 messageId 获取语音转文字结果。',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('list'), Type.Literal('send'), Type.Literal('send_file'), Type.Literal('transcribe')]),
      conversation: Type.String(), text: Type.Optional(Type.String()), characterId: Type.Optional(Type.String()),
      messageId: Type.Optional(Type.Integer()), path: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const { current, target, sendSignal } = action(ctx, params.conversation, signal);
      if (params.action === 'send_file') {
        if (!params.path) throw new Error('发送语音文件需要 path。');
        const file = await workspaceFile(current.cwd, params.path);
        const result = await current.transport.sendRecord(target, file, sendSignal);
        const warning = await rememberSend(current, target, result.messageId, '[语音]', [{ type: 'record', data: { file } }]);
        return { content: [{ type: 'text', text: `已发送语音到 ${conversationKey(target)}，message_id=${result.messageId}${warning}` }],
          details: { conversation: target, ...result, warning: warning || undefined } };
      }
      if (params.action === 'list') {
        const voices = await current.transport.getVoices(target, sendSignal);
        return { content: [{ type: 'text', text: JSON.stringify(voices) }], details: { conversation: target, voices } };
      }
      if (params.action === 'transcribe') {
        if (params.messageId === undefined) throw new Error('语音转文字需要 messageId。');
        const result = await current.transport.transcribe(target, params.messageId, sendSignal);
        return { content: [{ type: 'text', text: result.text || 'QQ 暂未返回语音转文字结果。' }],
          details: { conversation: target, messageId: params.messageId, text: result.text } };
      }
      if (!params.text?.trim() || !params.characterId) throw new Error('发送 AI 语音需要 text 和 characterId。');
      const result = await current.transport.speak(target, params.text, params.characterId, sendSignal);
      const warning = await rememberSend(current, target, result.messageId, `[AI语音] ${params.text}`, [
        { type: 'record', data: { text: params.text, character_id: params.characterId, provider: 'qq' } },
      ]);
      return { content: [{ type: 'text', text: `已发送 AI 语音到 ${conversationKey(target)}，message_id=${result.messageId}${warning}` }],
        details: { conversation: target, ...result, characterId: params.characterId, warning: warning || undefined } };
    },
  });
  registerGroupFileTool(pi, resourceContext);
  registerAlbumTool(pi, resourceContext);
  registerChatHistoryTool(pi, resourceContext);
  registerForwardMessageTool(pi, resourceContext);
  registerForwardSendTool(pi, resourceContext, async (ctx, target, result) => {
    const current = binding;
    if (!current || current.closed || resolve(ctx.cwd) !== resolve(current.cwd)) throw new Error('发送后原会话已关闭。');
    return rememberSend(current, target, result.messageId, `[合并转发 ${result.count} 条聊天记录]`,
      [{ type: 'forward', data: { id: result.forwardId } }]);
  });
  registerModelControl(pi);
}
