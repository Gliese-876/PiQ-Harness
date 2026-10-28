import { claimBotAccount } from './bot-owner.ts';
import { loadConfig } from './config.ts';
import { conversationKey, validateOpenId } from './conversations.ts';
import { QQBotTransport, QQBotApiError, type TransportOptions } from './transport.ts';
import { resolveGroupEnvironment, type CredentialOptions } from './web-terminal.ts';

export interface DiscoverOptions extends CredentialOptions {
  claimAccount?: typeof claimBotAccount;
  createTransport?: (options: TransportOptions) => Pick<QQBotTransport, 'connect' | 'close'>;
  output?: (line: string) => void;
  signal?: AbortSignal;
}

const statusMessages = {
  connecting: '正在连接 QQ 官方机器人。',
  connected: 'QQ 官方机器人已连接，等待会话事件。',
  disconnected: 'QQ 官方机器人连接已断开，等待重新连接。',
  error: 'QQ 官方机器人连接发生错误，请检查应用配置和网络。',
} as const;
export const DISCOVERY_BOT_STATE_ERROR = 'QQ 平台返回 11700：机器人状态异常。请核对当前机器人的启用状态和 WebSocket 接入方式。';

/** Discover conversation OpenIDs from incoming events without persisting or replying. */
export async function discoverGroup(cwd: string, options: DiscoverOptions = {}): Promise<number> {
  const output = options.output ?? ((line: string) => console.log(line));
  let stopped = false;
  let stopListening!: () => void;
  const stoppedPromise = new Promise<void>(resolve => { stopListening = resolve; });
  const stop = () => { stopped = true; stopListening(); };
  if (options.signal) {
    options.signal.addEventListener('abort', stop, { once: true });
    if (options.signal.aborted) stop();
  } else {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }

  let transport: Pick<QQBotTransport, 'connect' | 'close'> | undefined;
  let releaseAccount: (() => Promise<void>) | undefined;
  let exitCode = 0;
  try {
    exitCode = await (async () => {
      if (stopped) return 0;
      let config;
      try { config = await loadConfig(cwd); }
      catch {
        output('无法读取 PIQ.md，请检查当前对话组配置。');
        return 1;
      }
      if (stopped) return 0;
      if (!config) {
        output('当前对话组缺少 PIQ.md，请先初始化对话组。');
        return 1;
      }

      let resolved;
      try { resolved = await resolveGroupEnvironment(cwd, config, options); }
      catch {
        output('无法读取 QQ 机器人凭据，请检查工作台的连接设置。');
        return 1;
      }
      if (stopped) return 0;
      if (!resolved.credential.available || !resolved.credentials) {
        output(`无法连接 QQ 官方机器人：${resolved.credential.source}。`);
        return 1;
      }
      const credentials = resolved.credentials;
      try { releaseAccount = await (options.claimAccount ?? claimBotAccount)(credentials.appId); }
      catch {
        if (stopped) return 0;
        output('无法取得 QQ 机器人运行占用；同一 AppID 可能已有 PiQ 对话组运行，请先结束相关组并检查本机 socket 占用。');
        return 1;
      }
      if (stopped) return 0;

      const seen = new Set<string>();
      let lastStatus: string | undefined;
      const reportStatus = (status: keyof typeof statusMessages) => {
        if (stopped || status === lastStatus || !Object.hasOwn(statusMessages, status)) return;
        lastStatus = status;
        output(statusMessages[status]);
      };
      output('正在监听 QQ 官方机器人事件；按 Ctrl+C 退出。');
      try {
        transport = (options.createTransport ?? (specification => new QQBotTransport(specification)))({
          appId: credentials.appId,
          appSecret: credentials.appSecret,
          onMessage(event) {
            if (stopped) return;
            let key: string, userId: string;
            try {
              key = conversationKey({ type: event.conversation.type, id: event.conversation.id });
              userId = validateOpenId(event.userId);
            } catch { return; }
            if (seen.has(key)) return;
            seen.add(key);
            output(JSON.stringify({ conversationKey: key, userId }));
          },
          onStatus: reportStatus,
          onError: error => {
            if (lastStatus === 'connected') return;
            reportStatus('error');
            if (error instanceof QQBotApiError && error.bizCode === 11700) output(DISCOVERY_BOT_STATE_ERROR);
          },
        });
        if (stopped) return 0;
        const connected = Promise.resolve().then(() => transport!.connect()).then(
          () => 'connected' as const,
          () => 'failed' as const,
        );
        const result = await Promise.race([connected, stoppedPromise.then(() => 'stopped' as const)]);
        if (stopped || result === 'stopped') return 0;
        if (result === 'failed') {
          output('无法启动 QQ 官方机器人连接，请检查应用配置和网络。');
          return 1;
        }
        await stoppedPromise;
        return 0;
      } catch {
        if (stopped) return 0;
        output('无法启动 QQ 官方机器人连接，请检查应用配置和网络。');
        return 1;
      }
    })();
  } finally {
    stopped = true;
    if (options.signal) options.signal.removeEventListener('abort', stop);
    else {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
    try { await transport?.close(); }
    catch {
      output('无法关闭 QQ 官方机器人连接，请结束当前进程。');
      exitCode = 1;
    }
    try { await releaseAccount?.(); }
    catch {
      output('无法释放 QQ 机器人的本机运行占用，请结束当前进程。');
      exitCode = 1;
    }
  }
  return exitCode;
}
