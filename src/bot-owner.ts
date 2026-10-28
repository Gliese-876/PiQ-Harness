import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { userInfo } from 'node:os';

export interface BotAccountOptions {
  /** Isolates simulated accounts in tests without changing the user's identity. */
  namespace?: string;
}

function socketPath(appId: string, namespace: string): string {
  const user = userInfo();
  const hash = createHash('sha256').update(JSON.stringify([user.uid, user.username, user.homedir, namespace, appId])).digest('hex');
  if (process.platform === 'win32') return `\\\\.\\pipe\\piq-qqbot-${hash}`;
  if (process.platform === 'linux') return `\0piq-qqbot-${hash}`;
  // Use one system location across groups, independent of each group's TEMP setting.
  // Existing filesystem sockets are never removed here: a crashed owner fails closed.
  return `/tmp/piq-qqbot-${hash}`;
}

function safeListenError(error: unknown): Error {
  if ((error as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
    return new Error(process.platform === 'win32' || process.platform === 'linux'
      ? '同一 AppID 已有 PiQ 对话组运行，请先结束该组后再启动。'
      : '同一 AppID 已有 PiQ 对话组运行，或存在上次异常退出遗留的 socket 占用；请确认相关进程退出后手工清理占用。');
  }
  return new Error('无法取得 QQ 机器人运行占用，请检查当前用户的本机 socket 权限。');
}

/** One local QQ gateway per actual application, held by the operating system. */
export async function claimBotAccount(appId: string, options: BotAccountOptions = {}): Promise<() => Promise<void>> {
  if (typeof appId !== 'string' || !appId || appId.length > 512 || /[\s\x00-\x1f\x7f]/.test(appId)) {
    throw new Error('请配置有效的 QQ 机器人 AppID 环境变量。');
  }
  const namespace = options.namespace ?? 'piq';
  if (typeof namespace !== 'string' || !namespace || namespace.length > 512) throw new Error('机器人运行占用命名空间无效。');
  let path: string;
  try { path = socketPath(appId, namespace); }
  catch { throw new Error('无法确定当前用户的 QQ 机器人运行占用。'); }

  // The endpoint is an ownership marker. It accepts no messages or credentials.
  const server = createServer(socket => { socket.destroy(); });
  try {
    await listen(server, path);
    server.unref();
  } catch (error) {
    server.close(() => {});
    throw safeListenError(error);
  }

  let release: Promise<void> | undefined;
  return () => {
    release ??= new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolve();
        else reject(new Error('无法释放 QQ 机器人的本机运行占用。'));
      });
    });
    return release;
  };
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => { reject(error); };
    server.once('error', failed);
    server.listen({ path, exclusive: true }, () => {
      server.removeListener('error', failed);
      // A server error must never expose a pipe name or become an uncaught raw error.
      server.on('error', () => {});
      resolve();
    });
  });
}
