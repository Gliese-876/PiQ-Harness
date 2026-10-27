import { realpath } from 'node:fs/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Optional local policy: load explicitly beside the external sandbox package. */
export default function noEscalation(pi: ExtensionAPI): void {
  const tempVariables = ['TEMP', 'TMP', 'TMPDIR'] as const;
  let previousTemp: Record<string, string | undefined> | undefined;
  let appliedDirectory: string | undefined;

  pi.on('session_start', async (_event, ctx) => {
    if (process.platform !== 'win32') return;
    // yuru7 0.4.1 rejects a temp root nested inside the workspace. The same
    // canonical root is accepted and keeps both writable roots within this group.
    const directory = await realpath(ctx.cwd);
    previousTemp ??= Object.fromEntries(tempVariables.map(name => [name, process.env[name]]));
    for (const name of tempVariables) process.env[name] = directory;
    appliedDirectory = directory;
  });

  pi.on('session_shutdown', () => {
    if (!previousTemp || !appliedDirectory) return;
    for (const name of tempVariables) {
      // Do not overwrite a later environment choice made by another component.
      if (process.env[name] !== appliedDirectory) continue;
      if (previousTemp[name] === undefined) delete process.env[name];
      else process.env[name] = previousTemp[name];
    }
    previousTemp = undefined;
    appliedDirectory = undefined;
  });

  pi.on('tool_call', event => {
    if (event.toolName === 'sandbox_grant_write') {
      return { block: true, reason: '本组不允许 Agent 扩大可写目录；请把文件保存在当前对话组内。' };
    }
    const input: unknown = event.input;
    if (input !== null && typeof input === 'object' && 'sandbox_permissions' in input
      && typeof input.sandbox_permissions === 'string'
      && input.sandbox_permissions.trim() === 'danger-full-access') {
      return { block: true, reason: '本组不允许 Agent 绕过写入沙箱；请保持受限执行并使用当前对话组内的路径。' };
    }
  });
}
