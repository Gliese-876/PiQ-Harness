import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { claimConversations, loadConfig, type GroupConfig } from './config.ts';
import { conversationKey, parseConversationKey, type Conversation } from './conversations.ts';
import { Notifier } from './notifier.ts';
import { GroupStore } from './store.ts';
import { QQBotTransport, type ConversationEvent } from './transport.ts';
import { registerModelControl } from './model-control.ts';
import { resolveGroupEnvironment } from './web-terminal.ts';
import { RunController, type ConnectionState } from './run-control.ts';
import { workspaceFile } from './workspace-files.ts';
import { registerTerminal } from './terminal-monitor.ts';
import { claimBotAccount } from './bot-owner.ts';
import { registerOfficialTools } from './official-tools.ts';
import { registerGroupAdmin } from './group-admin.ts';

const SIGNAL = 'piq:messages';
type Channel = Pick<QQBotTransport, 'connect' | 'close' | 'isConnected' | 'send' | 'sendMedia' | 'request' | 'sendRich'>;
export interface PiQOptions {
  createTransport?: (options: ConstructorParameters<typeof QQBotTransport>[0]) => Channel;
  claimAccount?: typeof claimBotAccount;
}
interface Binding {
  id: string; cwd: string; config: GroupConfig; ctx: ExtensionContext; store: GroupStore;
  transport?: Channel; notifier: Notifier; members: Set<string>; releaseConversations: () => Promise<void>;
  releaseAccount?: () => Promise<void>;
  closed: boolean; selfId: string; status: ConnectionState; control?: RunController;
  sendAbort: AbortController; resumeTurn: boolean; lastError?: string;
  notificationError?: string; receiveError?: string; receiving: Promise<void>;
  confirmedSends: Set<string>;
}

export async function resolveImage(cwd: string, path: string): Promise<string> { return workspaceFile(cwd, path); }

export default function piq(pi: ExtensionAPI, options: PiQOptions = {}): void {
  let binding: Binding | undefined;
  let generation = 0;
  function report(current: Binding, message: string): void {
    if (!current.closed) current.ctx.ui.notify(`PiQ: ${message}`, 'error');
  }
  function resumeIfReady(current: Binding): void {
    if (current.closed || !current.resumeTurn || current.control?.paused || !current.transport?.isConnected || !current.ctx.isIdle()) return;
    current.resumeTurn = false;
    if (current.store.pending()) { current.notifier.schedule(); return; }
    pi.sendMessage({ customType: 'piq:resume', content: 'PiQ 已恢复，可继续处理刚才中断的对话任务。', display: true },
      { triggerTurn: true, deliverAs: 'followUp' });
  }
  async function receive(current: Binding, event: ConversationEvent): Promise<void> {
    if (current.closed || !current.members.has(conversationKey(event.conversation))) return;
    await current.store.append(event);
    current.selfId = event.selfId; current.receiveError = undefined;
    current.notifier.schedule(); current.control?.refresh();
  }
  function active(ctx: ExtensionContext, key: string, signal?: AbortSignal) {
    const current = binding;
    if (!current || current.closed || resolve(ctx.cwd) !== resolve(current.cwd)) throw new Error('当前会话未连接本对话组。');
    if (current.control?.paused) throw new Error('PiQ 已暂停，请在工作台恢复运行。');
    const conversation = parseConversationKey(key);
    if (!current.members.has(conversationKey(conversation))) throw new Error('目标对话不属于当前对话组。');
    if (!current.transport) throw new Error('官方 QQ Bot 凭据尚未配置。');
    const sendSignal = signal ? AbortSignal.any([signal, current.sendAbort.signal]) : current.sendAbort.signal;
    return { current, conversation, transport: current.transport, sendSignal };
  }
  async function rememberSend(current: Binding, conversation: Conversation, messageId: string, rawText: string,
    attachments: Record<string, unknown>[] = [], raw?: Record<string, unknown>): Promise<string> {
    current.confirmedSends.add(JSON.stringify([conversationKey(conversation), messageId]));
    if (current.confirmedSends.size > 1_024) current.confirmedSends.delete(current.confirmedSends.values().next().value!);
    try {
      await current.store.append({ conversation, messageId, rawText, attachments, raw, outgoing: true, sentByPi: true,
        selfId: current.selfId, userId: current.selfId, sender: 'Pi', time: Math.floor(Date.now() / 1000) });
      return '';
    } catch { return '；发送已成功，但本地日志写入失败，请勿因日志错误重发'; }
  }
  async function checkReply(current: Binding, conversation: Conversation, id: string | undefined, signal: AbortSignal): Promise<void> {
    if (id === undefined) return;
    const record = await current.store.findMessage(conversation, id, signal);
    if (!record || record.outgoing || id.startsWith('event:')) throw new Error('replyTo 须来自目标对话已保存的真实入站消息。');
  }
  async function close(current: Binding): Promise<void> {
    current.closed = true; current.sendAbort.abort(new Error('本对话组会话已关闭。'));
    current.notifier.close();
    let failure: unknown;
    for (const cleanup of [() => current.transport?.close(), () => current.receiving,
      () => official.cancelOutstanding(), () => current.control?.close(), () => current.releaseAccount?.(),
      () => current.releaseConversations(), () => current.store.close()]) {
      try { await cleanup(); } catch (error) { failure ??= error; }
    }
    current.ctx.ui.setStatus('piq', undefined);
    if (failure) throw failure;
  }
  async function stop(): Promise<void> {
    generation++; const current = binding; binding = undefined; if (current) await close(current);
  }
  pi.on('session_start', async (_event, ctx) => {
    await stop(); const starting = generation;
    let store: GroupStore | undefined; let release: (() => Promise<void>) | undefined; let current: Binding | undefined;
    try {
      const config = await loadConfig(ctx.cwd);
      if (!config || starting !== generation) return;
      if (!config.conversations.length) throw new Error('请先添加官方群聊或私聊 OpenID；可用 piq discover 查看收到的对话标识。');
      const credentials = await resolveGroupEnvironment(ctx.cwd, config);
      if (starting !== generation) return;
      store = await GroupStore.open(ctx.cwd, config, credentials.env[config.appIdEnv]);
      if (starting !== generation) { await store.close(); return; }
      release = await claimConversations(ctx.cwd, config);
      if (starting !== generation) { await release(); await store.close(); return; }
      const terminalToken = process.env.PIQ_TERMINAL_RETURN_TOKEN, wrapperPid = Number(process.env.PIQ_TERMINAL_WRAPPER_PID);
      if (terminalToken && Number.isSafeInteger(wrapperPid) && wrapperPid > 0) {
        await registerTerminal(ctx.cwd, terminalToken, wrapperPid, process.pid);
      }
      if (starting !== generation) { await release(); await store.close(); return; }
      current = { id: randomUUID(), cwd: ctx.cwd, ctx, config, store, releaseConversations: release,
        members: new Set(config.conversations.map(conversationKey)), closed: false, selfId: credentials.env[config.appIdEnv] ?? config.id,
        status: 'connecting', sendAbort: new AbortController(), resumeTurn: false, receiving: Promise.resolve(), confirmedSends: new Set<string>() } as Binding;
      const owner = current;
      owner.notifier = new Notifier(config, {
        pending: () => owner.store.pending(), lastNotifiedAt: () => owner.store.lastNotifiedAt,
        isIdle: () => !owner.closed && !owner.control?.paused && !!owner.transport?.isConnected && owner.ctx.isIdle(),
        send: pending => {
          owner.resumeTurn = false;
          pi.sendMessage({ customType: SIGNAL, display: true,
            content: `对话组 ${owner.config.name} 有 ${pending.count} 条新消息，来自 ${pending.conversations.length} 个对话（至 #${pending.through}）：\n`
              + pending.conversations.map(item => `${conversationKey(item.conversation)}：${item.count} 条，#${item.firstSeq}–#${item.lastSeq}，日志 ${item.files.join('、')}`).join('\n'),
            details: { bindingId: owner.id, groupId: config.id, through: pending.through, conversations: pending.conversations },
          }, { triggerTurn: true, deliverAs: 'followUp' });
        },
        stalled: error => { owner.notificationError = error instanceof Error ? error.message : String(error);
          report(owner, owner.notificationError); owner.control?.refresh(); },
      });
      owner.control = await RunController.open(ctx.cwd, {
        snapshot: () => {
          const pending = owner.store.pending();
          return { connection: owner.status, pendingCount: pending?.count ?? 0,
            pendingConversations: pending?.conversations.map(item => ({ key: conversationKey(item.conversation), count: item.count })) ?? [],
            lastError: [owner.lastError, owner.receiveError, owner.notificationError].filter(Boolean).join('\n') || undefined };
        },
        isBusy: () => !owner.ctx.isIdle(),
        pause: async () => { owner.notifier.suspend(); owner.sendAbort.abort(new Error('PiQ 已暂停，发送已取消。'));
          await official.cancelOutstanding(); owner.ctx.abort(); },
        resume: interrupted => { owner.sendAbort = new AbortController(); owner.resumeTurn ||= interrupted;
          owner.notificationError = undefined; owner.notifier.retry(); resumeIfReady(owner); },
        shutdown: () => owner.ctx.shutdown(), error: error => report(owner, `运行控制：${error instanceof Error ? error.message : String(error)}`),
      });
      owner.resumeTurn ||= owner.control.needsResume;
      if (owner.control.paused) owner.notifier.suspend();
      binding = owner;
      if (starting !== generation) { binding = undefined; await close(owner); return; }
      if (!credentials.credential.available) {
        owner.status = 'error'; owner.lastError = credentials.credential.source; owner.control.refresh(); report(owner, owner.lastError); return;
      }
      let releaseAccount: () => Promise<void>;
      try { releaseAccount = await (options.claimAccount ?? claimBotAccount)(owner.selfId); }
      catch (error) {
        if (owner.closed || starting !== generation || binding !== owner) return;
        owner.status = 'error'; owner.lastError = error instanceof Error ? error.message : '官方机器人已被其他对话组占用。';
        owner.control.refresh(); report(owner, owner.lastError); return;
      }
      if (owner.closed || starting !== generation || binding !== owner) { await releaseAccount(); return; }
      owner.releaseAccount = releaseAccount;
      owner.transport = (options.createTransport ?? (settings => new QQBotTransport(settings)))({
        appId: credentials.env[config.appIdEnv]!, appSecret: credentials.env[config.appSecretEnv]!, groupMemberEvents: config.groupMemberEvents,
        onMessage: event => {
          if (owner.closed) return;
          const delivery = owner.receiving.then(() => receive(owner, event));
          owner.receiving = delivery.catch(error => {
            const message = `接收消息：${error instanceof Error ? error.message : String(error)}`;
            if (message !== owner.receiveError) report(owner, message);
            owner.receiveError = message; owner.notifier.schedule(); owner.control?.refresh();
          });
          return delivery;
        },
        onStatus: status => {
          if (owner.closed) return;
          owner.status = status;
          owner.lastError = status === 'connected' ? undefined : '官方 QQ Bot 尚未连接，请检查应用凭据、网络和平台权限。';
          if (status === 'connected') { owner.notifier.schedule(); resumeIfReady(owner); }
          owner.control?.refresh(); ctx.ui.setStatus('piq', `${config.name} · ${status}`);
        },
        onError: error => {
          if (owner.closed) return;
          if (owner.lastError !== error.message) report(owner, error.message);
          owner.lastError = error.message; owner.control?.refresh();
        },
      });
      void owner.transport.connect().catch(() => {
        if (!owner.closed && !owner.transport?.isConnected) { owner.status = 'error'; owner.lastError = '官方 QQ Bot 连接失败，请检查凭据、网络和平台权限。';
          owner.control?.refresh(); ctx.ui.setStatus('piq', `${config.name} · 等待官方 QQ Bot 连接`); }
      });
    } catch (error) {
      if (current?.notifier) { if (binding === current) binding = undefined; await close(current); }
      else { await release?.(); await store?.close(); }
      ctx.ui.notify(`PiQ 启动失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  });
  pi.on('session_shutdown', stop);
  pi.on('agent_start', async (_event, ctx) => { if (binding && !binding.closed) { binding.ctx = ctx; await binding.control?.markBusy(true); } });
  pi.on('agent_settled', async (_event, ctx) => {
    const current = binding;
    if (!current || current.closed) return;
    current.ctx = ctx;
    await current.control?.markBusy(false);
    if (current.closed || binding !== current) return;
    resumeIfReady(current); current.notifier.schedule();
  });
  pi.on('message_end', async event => {
    const current = binding;
    if (!current || current.closed || event.message.role !== 'custom' || event.message.customType !== SIGNAL) return;
    const details = event.message.details as { bindingId?: string; groupId?: string; through?: number } | undefined;
    if (details?.bindingId !== current.id || details.groupId !== current.config.id || !Number.isSafeInteger(details.through)) return;
    try { await current.store.acknowledge(details.through!); current.notifier.confirm(details.through!); }
    catch (error) { current.notifier.fail(error); }
  });
  pi.registerCommand('piq', {
    description: '查看本对话组状态；/piq retry 恢复未确认的消息通知',
    handler: async (args, ctx) => {
      if (!binding) { ctx.ui.notify('当前目录未接入 PiQ；先初始化对话组。', 'info'); return; }
      if (args.trim() === 'retry' && !binding.control?.paused) { binding.notificationError = undefined; binding.notifier.retry(); binding.control?.refresh(); }
      ctx.ui.notify(`对话组 ${binding.config.name} · ${binding.control?.paused ? '已暂停 · ' : ''}${binding.status} · 待通知 ${binding.store.pending()?.count ?? 0} 条`, 'info');
    },
  });
  pi.registerTool({
    name: 'qq_send', label: '发送 QQ 消息',
    description: '向本组明确指定的 group:OpenID 或 private:OpenID 发送文字、至多一张图片。replyTo 为该对话真实平台消息字符串 ID，受平台回复时效和频控约束。结果未知时先检查记录，不自动重发。',
    parameters: Type.Object({ conversation: Type.String(), text: Type.Optional(Type.String()),
      images: Type.Optional(Type.Array(Type.String(), { maxItems: 1 })), replyTo: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const { current, conversation, transport, sendSignal } = active(ctx, params.conversation, signal);
      const images: string[] = [];
      for (const path of params.images ?? []) images.push(await resolveImage(current.cwd, path));
      await checkReply(current, conversation, params.replyTo, sendSignal);
      sendSignal.throwIfAborted();
      const result = await transport.send(conversation, { text: params.text, images, replyTo: params.replyTo }, sendSignal);
      const warning = await rememberSend(current, conversation, result.messageId, params.text ?? '', images.map(path => ({ type: 'image', path: relative(current.cwd, path) })), result.raw);
      return { content: [{ type: 'text', text: `已发送到 ${conversationKey(conversation)}，messageId=${result.messageId}${warning}` }], details: { conversation, messageId: result.messageId } };
    },
  });
  pi.registerTool({
    name: 'qq_send_file', label: '发送 QQ 媒体或文件',
    description: '向本组明确指定的对话发送组内本地图片、语音、视频或文件附件。kind 为 image/voice/video/file；voice 支持 WAV、MP3、SILK。平台回复权限和频控仍适用；不会管理 QQ 群文件库。',
    parameters: Type.Object({ conversation: Type.String(), kind: Type.Union(['image', 'voice', 'video', 'file'].map(value => Type.Literal(value))),
      path: Type.String(), fileName: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), replyTo: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const { current, conversation, transport, sendSignal } = active(ctx, params.conversation, signal);
      const file = await workspaceFile(current.cwd, params.path); sendSignal.throwIfAborted();
      await checkReply(current, conversation, params.replyTo, sendSignal);
      const result = await transport.sendMedia(conversation, { kind: params.kind as 'image' | 'voice' | 'video' | 'file', path: file, fileName: params.fileName, replyTo: params.replyTo }, sendSignal);
      const warning = await rememberSend(current, conversation, result.messageId, `[${params.kind}]`, [{ type: params.kind, path: relative(current.cwd, file), ...(params.fileName ? { name: params.fileName } : {}) }], result.raw);
      return { content: [{ type: 'text', text: `已发送${params.kind}到 ${conversationKey(conversation)}，messageId=${result.messageId}${warning}` }], details: { conversation, messageId: result.messageId, kind: params.kind } };
    },
  });
  const official = registerOfficialTools(pi, (ctx, key, signal) => {
    const { current, conversation, transport, sendSignal } = active(ctx, key, signal);
    return { cwd: current.cwd, conversation, transport, signal: sendSignal,
      findMessage: id => current.store.findMessage(conversation, id, sendSignal),
      findEvent: id => current.store.findEvent(conversation, id, sendSignal),
      ownsSent: async id => {
        const record = await current.store.findMessage(conversation, id, sendSignal);
        return !id.startsWith('event:') && (current.confirmedSends.has(JSON.stringify([conversationKey(conversation), id]))
          || (!!record && record.outgoing && record.sentByPi === true));
      },
      rememberSent: async result => {
        const warning = await rememberSend(current, conversation, result.messageId, result.text,
          result.kind ? [{ type: result.kind }] : [], result.raw);
        if (warning) throw new Error(warning);
      },
    };
  });
  registerGroupAdmin(pi, (ctx, key, signal) => {
    const { conversation, transport, sendSignal } = active(ctx, key, signal);
    return { conversation, transport, signal: sendSignal };
  });
  registerModelControl(pi);
}
