import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { OneBotClient } from './onebot-client.ts';
import { defaultMessagesRoot } from './cli.ts';
import { loadConfig, type GroupConfig } from './config.ts';
import { resolveGroupEnvironment } from './web-terminal.ts';

export interface SnowLumaServiceResult {
  ok: boolean;
  started: boolean;
  message: string;
  diagnostic: 'ready' | 'service-down' | 'account-offline' | 'auth-failed' | 'unavailable';
  /** Safe to launch a new local service. An occupied endpoint is never replaced. */
  canStart: boolean;
  canOpenManual: boolean;
  manualUrl?: string;
}

export interface SnowLumaLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  visible: boolean;
}

export interface SnowLumaServiceOptions {
  installDir?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  probe?: (cwd: string, options: SnowLumaServiceOptions) => Promise<SnowLumaServiceResult>;
  launch?: (specification: SnowLumaLaunch) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  createClient?: (options: { url: string; accessToken?: string; reconnect: false; requestTimeoutMs: number }) =>
    Pick<OneBotClient, 'connect' | 'close' | 'raw'>;
}

interface Installation { directory: string; node: string; entry: string; port: number; url: string }
const active = new Map<string, Promise<SnowLumaServiceResult>>();
const cooldowns = new Map<string, number>();
const launches = new Map<string, { promise: Promise<void>; users: number }>();
const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host.toLowerCase());
const endpointPort = (url: URL) => Number(url.port || (url.protocol === 'wss:' ? 443 : 80));

function result(
  diagnostic: SnowLumaServiceResult['diagnostic'], message: string,
  installation: Installation | null, canStart = false,
): SnowLumaServiceResult {
  return { ok: diagnostic === 'ready', started: false, diagnostic, message, canStart,
    canOpenManual: Boolean(installation), ...(installation ? { manualUrl: installation.url } : {}) };
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part);
}

async function installationFor(options: SnowLumaServiceOptions): Promise<Installation | null> {
  const candidate = options.installDir ?? join(dirname(defaultMessagesRoot()), 'SnowLuma');
  try {
    const directory = await realpath(candidate);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (manifest.name !== '@snowluma/runtime' || manifest.main !== 'index.mjs') return null;
    const entry = await realpath(join(directory, 'index.mjs'));
    if (!inside(directory, entry) || !(await stat(entry)).isFile()) return null;
    let node = process.execPath;
    if (process.platform === 'win32') {
      try {
        const bundled = await realpath(join(directory, 'node.exe'));
        if (!inside(directory, bundled) || !(await stat(bundled)).isFile()) return null;
        node = bundled;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
    }
    let port = 5099; let tls = false;
    try {
      const runtime = JSON.parse(await readFile(join(directory, 'config', 'runtime.json'), 'utf8'));
      if (Number.isInteger(runtime.webuiPort) && runtime.webuiPort > 0 && runtime.webuiPort <= 65535) port = runtime.webuiPort;
      tls = runtime.webuiTls === true || runtime.webuiTls?.enabled === true;
    } catch { /* The official default remains usable when a fresh installation has no runtime file. */ }
    return { directory, node, entry, port, url: `${tls ? 'https' : 'http'}://127.0.0.1:${port}` };
  } catch { return null; }
}

async function tcpStatus(host: string, port: number, timeoutMs: number): Promise<'open' | 'closed' | 'unknown'> {
  return new Promise(resolveStatus => {
    const socket = createConnection({ host: host.replace(/^\[|\]$/g, ''), port });
    let finished = false;
    const finish = (status: 'open' | 'closed' | 'unknown') => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolveStatus(status);
    };
    socket.once('connect', () => finish('open'));
    socket.once('error', error => finish((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'closed' : 'unknown'));
    socket.setTimeout(Math.max(1, timeoutMs), () => finish('unknown'));
  });
}

async function handshakeIsUnauthorized(config: GroupConfig, token: string | undefined, timeoutMs: number): Promise<boolean> {
  const endpoint = new URL(config.wsUrl);
  endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
  endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + '/get_status';
  try {
    const response = await fetch(endpoint, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)), redirect: 'error',
    });
    await response.body?.cancel();
    return response.status === 401 || response.status === 403;
  } catch { return false; }
}

/** Only read-only OneBot actions are used. A listening port alone is not considered ready. */
export async function probeSnowLuma(cwd: string, options: SnowLumaServiceOptions = {}): Promise<SnowLumaServiceResult> {
  let installation = await installationFor(options);
  let config: GroupConfig | null;
  try { config = await loadConfig(cwd); } catch { return result('unavailable', '无法读取本群连接配置，请检查 PIQ.md。', installation); }
  if (!config) return result('unavailable', '当前群尚未配置 SnowLuma。', installation);
  const url = new URL(config.wsUrl);
  const local = loopback(url.hostname);
  if (!local) installation = null;
  const budget = Math.max(50, Math.min(options.timeoutMs ?? 3_000, 10_000));
  const deadline = Date.now() + budget;
  const tcp = await tcpStatus(url.hostname, endpointPort(url), Math.min(500, budget));
  if (tcp !== 'open') {
    if (local && installation) {
      const management = await tcpStatus('127.0.0.1', installation.port, Math.min(300, Math.max(1, deadline - Date.now())));
      if (management === 'open') {
        return result('account-offline', 'SnowLuma 管理服务已运行，但本群账号接口未就绪。请在管理界面连接已登录的 QQ 账号，并检查本群端点。', installation);
      }
      if (tcp === 'closed' && management === 'closed') {
        return result('service-down', 'SnowLuma 尚未启动，可以自动启动本机服务。', installation, true);
      }
    }
    return result(local ? 'service-down' : 'unavailable', local
      ? 'SnowLuma 端点尚未响应，请确认安装位置、服务状态和 PIQ.md 地址。'
      : '远程 SnowLuma 端点尚未响应，请在远程主机检查服务。', installation);
  }
  let token: string | undefined;
  try {
    const resolved = await resolveGroupEnvironment(cwd, config, {
      env: options.env, ...(installation ? { configDirectory: join(installation.directory, 'config') } : {}),
    });
    token = resolved.env[config.accessTokenEnv];
  } catch { return result('unavailable', '无法读取 SnowLuma 凭据，请检查本机配置或环境变量。', installation); }
  const clientOptions = {
    url: config.wsUrl, accessToken: token, reconnect: false,
    requestTimeoutMs: Math.max(1, deadline - Date.now()),
    connectionTimeoutMs: Math.max(1, deadline - Date.now()),
  } as const;
  const client = options.createClient?.(clientOptions) ?? new OneBotClient(clientOptions);
  const timeout = setTimeout(() => client.close(), Math.max(1, deadline - Date.now()));
  try {
    await client.connect();
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const [login, status] = await Promise.all([
      client.raw('get_login_info', {}, { signal }),
      client.raw('get_status', {}, { signal }),
    ]);
    if (!Number.isSafeInteger(Number(login.user_id)) || Number(login.user_id) <= 0 || status.online !== true || status.good === false) {
      return result('account-offline', 'SnowLuma 已连接，QQ 账号尚未在线。请登录或在 SnowLuma 中重新连接账号。', installation);
    }
    return result('ready', 'SnowLuma 已连接，QQ 账号在线。', installation);
  } catch (error) {
    const code = error && typeof error === 'object' && 'retcode' in error ? Number(error.retcode) : undefined;
    if (code === 401 || code === 403 || await handshakeIsUnauthorized(config, token, Math.min(500, Math.max(1, deadline - Date.now())))) {
      return result('auth-failed', 'SnowLuma 鉴权失败，请检查 WebSocket 节点的 token 与本群凭据配置。', installation);
    }
    return result('unavailable', '端口已响应，但 SnowLuma 群消息接口未就绪。请检查 WebSocket 开关、端点角色和 QQ 连接状态。', installation);
  } finally { clearTimeout(timeout); client.close(); }
}

/** A real hidden console remains available for a runtime's own child processes to inherit. */
async function launchHiddenWindows(specification: SnowLumaLaunch): Promise<void> {
  if (specification.args.length !== 1) throw new Error('SnowLuma 隐藏启动参数无效。');
  const root = await realpath(specification.cwd);
  const logs = join(root, 'logs');
  await mkdir(logs, { recursive: true });
  const actualLogs = await realpath(logs);
  if ((await lstat(logs)).isSymbolicLink() || actualLogs.toLowerCase() !== logs.toLowerCase()) {
    throw new Error('SnowLuma 启动日志须保存在安装目录内的普通 logs 目录。');
  }
  const logBase = join(logs, `piq-launch-${Date.now()}-${randomUUID()}`);
  const systemRoot = specification.env.SystemRoot ?? specification.env.SYSTEMROOT ?? process.env.SystemRoot ?? 'C:\\Windows';
  const shell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = fileURLToPath(new URL('../scripts/start-hidden-process.ps1', import.meta.url));
  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...specification.env, PIQ_HIDDEN_NODE: specification.command, PIQ_HIDDEN_ENTRY: specification.args[0],
        PIQ_HIDDEN_DIRECTORY: root, PIQ_HIDDEN_STDOUT: `${logBase}.stdout.log`, PIQ_HIDDEN_STDERR: `${logBase}.stderr.log` },
    });
    let output = '', settled = false, acknowledged = false, exited = false, outputEnded = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.stdout.destroy(); child.stderr.destroy();
      if (success) resolveLaunch();
      else reject(new Error('SnowLuma 隐藏启动未完成，请检查安装目录 logs 下的启动日志或使用手动入口。'));
    };
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); finish(false); }, 10_000);
    const inspectReceipt = () => {
      try {
        const receipt: unknown = JSON.parse(output.trim());
        acknowledged = Boolean(receipt && typeof receipt === 'object' && 'pid' in receipt
          && Number.isSafeInteger(receipt.pid) && Number(receipt.pid) > 0);
      } catch { /* Wait for the complete acknowledgement rather than parsing a partial pipe read. */ }
      if (exited && acknowledged) finish(true);
      else if (exited && outputEnded) finish(false);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (output.length < 4_096) output += String(chunk).slice(0, 4_096 - output.length);
      inspectReceipt();
    });
    child.stdout.once('end', () => { outputEnded = true; inspectReceipt(); });
    // Do not forward diagnostics that could contain paths or runtime credentials to the WebUI.
    child.stderr.on('data', () => {});
    child.once('error', () => finish(false));
    // Windows descendants can retain inherited copies of the helper's pipe handles.
    // Its exit and PID receipt confirm startup; waiting for pipe close would wait for the service.
    child.once('exit', code => {
      if (code !== 0) { finish(false); return; }
      exited = true; inspectReceipt();
    });
  });
}

async function launch(specification: SnowLumaLaunch): Promise<void> {
  if (process.platform === 'win32' && !specification.visible) return launchHiddenWindows(specification);
  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn(specification.command, specification.args, {
      cwd: specification.cwd, env: specification.env, shell: false,
      detached: true, stdio: 'ignore', windowsHide: !specification.visible,
    });
    child.once('error', () => reject(new Error('SnowLuma 启动失败，请使用手动恢复入口查看。')));
    child.once('spawn', () => { child.unref(); resolveLaunch(); });
  });
}

/** Try one local launch, then report a bounded failure. Existing settings are never changed. */
export async function ensureSnowLuma(cwd: string, options: SnowLumaServiceOptions = {}): Promise<SnowLumaServiceResult> {
  const config = await loadConfig(cwd);
  if (!config) return result('unavailable', '当前群尚未配置 SnowLuma。', null);
  const installation = await installationFor(options);
  const key = `${installation?.directory ?? ''}\n${config.wsUrl}`;
  const existing = active.get(key);
  if (existing) return existing;
  const task = (async () => {
    const now = options.now ?? Date.now;
    const deadline = now() + Math.min(10_000, Math.max(50, options.timeoutMs ?? 10_000));
    const probe = options.probe ?? probeSnowLuma;
    const initial = await probe(cwd, { ...options, timeoutMs: Math.max(1, Math.min(3_000, deadline - now())) });
    if (initial.ok || !initial.canStart || !loopback(new URL(config.wsUrl).hostname) || !installation) return initial;
    const installKey = installation.directory;
    let launchJob = launches.get(installKey);
    if (!launchJob && (cooldowns.get(installKey) ?? 0) > now()) {
      return { ...initial, message: '上次自动启动尚未成功；请稍后重试，或使用手动恢复入口查看 SnowLuma。' };
    }
    if (!launchJob) {
      cooldowns.set(installKey, now() + 30_000);
      launchJob = { users: 0, promise: Promise.resolve().then(() => (options.launch ?? launch)({
        command: installation.node, args: [installation.entry], cwd: installation.directory,
        env: { ...(options.env ?? process.env) }, visible: false,
      })) };
      launches.set(installKey, launchJob);
    }
    launchJob.users++;
    try {
      try { await launchJob.promise; }
      catch { return { ...initial, message: '自动启动 SnowLuma 失败，请使用手动恢复入口查看。' }; }
      let last = initial;
      while (now() < deadline) {
        await (options.sleep ?? wait)(Math.min(400, Math.max(1, deadline - now())));
        if (now() >= deadline) break;
        last = await probe(cwd, { ...options, timeoutMs: Math.max(1, Math.min(2_000, deadline - now())) });
        if (last.ok) { cooldowns.delete(installKey); return { ...last, started: true, message: 'SnowLuma 已自动启动，QQ 账号已连接。' }; }
        if (last.diagnostic === 'auth-failed') return { ...last, started: true };
      }
      return { ...last, started: true, message: last.diagnostic === 'account-offline' ? last.message
        : '已尝试启动 SnowLuma，但账号接口仍未就绪。请使用手动恢复入口查看启动提示。' };
    } finally {
      if (--launchJob.users === 0 && launches.get(installKey) === launchJob) launches.delete(installKey);
    }
  })();
  active.set(key, task);
  try { return await task; } finally { if (active.get(key) === task) active.delete(key); }
}

/** An explicit user action: open the existing management UI, or a visible official runtime. */
export async function openSnowLumaManual(
  cwd: string, options: SnowLumaServiceOptions = {},
): Promise<{ message: string; manualUrl?: string }> {
  const config = await loadConfig(cwd);
  if (!config || !loopback(new URL(config.wsUrl).hostname)) throw new Error('远程 SnowLuma 请在对应主机手动恢复。');
  const installation = await installationFor(options);
  if (!installation) throw new Error('未找到本机 SnowLuma 安装，请先安装或在原安装目录运行 launcher.bat。');
  if (process.platform !== 'win32' && !options.launch) return { message: '请在 SnowLuma 安装目录运行启动器并登录 QQ。', manualUrl: installation.url };
  const env = { ...(options.env ?? process.env) };
  if (await tcpStatus('127.0.0.1', installation.port, 300) === 'open') {
    await (options.launch ?? launch)({ command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', installation.url],
      cwd: installation.directory, env, visible: true });
    return { message: '已打开 SnowLuma 管理界面，请检查 QQ 账号连接后返回重试。', manualUrl: installation.url };
  }
  await (options.launch ?? launch)({
    command: 'wt.exe', args: ['-w', 'new', 'new-tab', '--inheritEnvironment', '--title', 'SnowLuma',
      'powershell.exe', '-NoLogo', '-NoProfile', '-NoExit', '-Command',
      'Set-Location -LiteralPath $env:PIQ_SNOWLUMA_DIRECTORY; & $env:PIQ_SNOWLUMA_NODE $env:PIQ_SNOWLUMA_ENTRY'],
    cwd: installation.directory, visible: true,
    env: { ...env, PIQ_SNOWLUMA_DIRECTORY: installation.directory, PIQ_SNOWLUMA_NODE: installation.node, PIQ_SNOWLUMA_ENTRY: installation.entry },
  });
  return { message: '已打开 SnowLuma 启动窗口，请根据提示完成 QQ 账号连接后返回重试。', manualUrl: installation.url };
}
