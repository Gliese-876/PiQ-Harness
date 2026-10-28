import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Explicit media sends can read only ordinary files inside the selected group. */
export async function workspaceFile(cwd: string, value: string): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error('文件路径必须是当前对话组目录内的有效路径。');
  const root = await realpath(cwd);
  const candidate = resolve(root, value);
  const part = relative(root, candidate);
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)
    || part.split(/[\\/]/).some(segment => segment.includes(':'))) throw new Error('文件必须位于当前对话组目录内。');
  const file = await realpath(candidate);
  const actual = relative(root, file);
  if (!actual || actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual)) throw new Error('文件必须位于当前对话组目录内。');
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink > 1) throw new Error('文件必须是当前对话组目录内的普通文件。');
  return file;
}
