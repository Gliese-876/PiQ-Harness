import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWebServer } from './web-server.ts';

export async function main(args = process.argv.slice(2)): Promise<void> {
  let root: string | undefined; let port = 3210;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') {
      console.log('PiQ WebUI\n\nnode src/web.ts [--root <群目录>] [--port 3210]\n默认仅监听本机 127.0.0.1，群目录为文档/PiQ-Messages。');
      return;
    }
    if (flag === '--root' && args[i + 1]) root = resolve(args[++i]!);
    else if (flag === '--port' && args[i + 1]) port = Number(args[++i]);
    else throw new Error(`未知或不完整的参数：${flag}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1 到 65535 的整数。');
  const app = await startWebServer({ root, port });
  console.log(`PiQ WebUI: ${app.url}\n使用 Ctrl+C 关闭 WebUI；Pi 终端独立运行。`);
  let closing = false;
  const shutdown = () => { if (closing) return; closing = true; void app.close().then(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`PiQ WebUI: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
