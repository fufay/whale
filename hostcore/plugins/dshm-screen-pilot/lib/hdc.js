// hdc 调用封装：优先 $HOME/bin/hdc（自动过桥转发器），回退 PATH 上的 hdc。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

let resolved = null;

function resolveHdc() {
  if (resolved) return resolved;
  const candidates = [];
  const home = process.env.HOME || '';
  if (home) candidates.push(join(home, 'bin', 'hdc'));
  candidates.push('hdc');
  for (const c of candidates) {
    if (c !== 'hdc' ? existsSync(c) : true) {
      resolved = c;
      break;
    }
  }
  return resolved;
}

/** 执行 hdc 子命令，返回 stdout（utf8）。失败抛错并携带 stdout/stderr。 */
export function hdcRun(args, opts = {}) {
  const bin = resolveHdc();
  const execOpts = {
    encoding: 'utf8',
    timeout: opts.timeout || 90000,
    maxBuffer: 256 * 1024 * 1024,
    ...opts.exec,
  };
  try {
    return execFileSync(bin, args, execOpts);
  } catch (e) {
    const err = new Error('hdc 调用失败: ' + (e.stderr || e.message || String(e)));
    err.stdout = e.stdout || '';
    err.stderr = e.stderr || '';
    err.exitCode = e.status;
    throw err;
  }
}

/** hdc shell "<cmd>"（单条字符串命令）。 */
export function shell(cmd) {
  return hdcRun(['shell', cmd]);
}

/** hdc shell <arg1> <arg2> ...（参数自动拼接，避免二次转义）。 */
export function shellArgs(...args) {
  return hdcRun(['shell', ...args.map(String)]);
}

/** hdc file recv <remote> <local>。 */
export function fileRecv(remote, local) {
  const out = hdcRun(['file', 'recv', remote, local]);
  if (!existsSync(local)) throw new Error('file recv 未生成文件: ' + out);
  return out;
}
