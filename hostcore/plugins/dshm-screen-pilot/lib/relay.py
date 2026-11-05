#!/usr/bin/env python3
"""dsh-screen-pilot 长连 relay：python 自己开 PTY 跑交互式 `hdc shell`，通过 unix socket 供插件使用。

为什么不是插件直接 spawnTerminal（PTY）：
  Host 进程里 node-pty 起的子进程不加载 LD_PRELOAD（实测 maps=0，桥的 shim 失效）；
  而 ctx.shell 起的进程里 python 再 pty.fork 出来的 hdc 能正常加载（maps=4）。
  所以把 PTY 放在 python 这一层。

协议（换行分隔 JSON）：
  插件 → relay: {"op":"run","id":"<nonce>","cmd":"<设备 shell 命令>","timeoutMs":15000}
   relay → 插件: {"op":"ready"} | {"op":"result","id":...,"out":...,"code":N}
               | {"op":"error","id":...,"message":...}
  插件 → relay: {"op":"close"}（relay 清掉 PTY 子进程后退出）

启动方式：python3 -u relay.py <socket-path> <bridge-hdc-path>
"""
import json
import os
import pty
import re
import select
import signal
import socket
import sys
import time
import traceback
import fcntl
import struct
import termios

SOCKET_PATH = sys.argv[1]
BRIDGE = sys.argv[2]
OPEN_TIMEOUT = 15.0
DEFAULT_TIMEOUT = 15.0


def log(*args):
    try:
        sys.stderr.write('[sp-relay] ' + ' '.join(str(a) for a in args) + '\n')
        sys.stderr.flush()
    except Exception:
        pass


def cleanup_socket():
    try:
        os.unlink(SOCKET_PATH)
    except OSError:
        pass


def main():
    try:
        os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)
    except Exception:
        pass
    cleanup_socket()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET_PATH)
    server.listen(1)
    server.settimeout(OPEN_TIMEOUT)

    pid, fd = pty.fork()
    if pid == 0:
        # 子进程：exec 桥壳 hdc shell（交互式）
        try:
            os.execv('/system/bin/sh', ['sh', '-c', 'exec ' + BRIDGE + ' shell'])
        except Exception as e:  # noqa: BLE001
            log('exec failed', e)
            os._exit(127)

    # 固定一个足够宽的 PTY，避免长命令回显被换行打断（影响回显行剔除）。
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 400, 0, 0))
    except Exception:
        pass

    def kill_child():
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass

    try:
        conn, _ = server.accept()
    except socket.timeout:
        log('accept timeout')
        kill_child()
        cleanup_socket()
        return 2

    conn.settimeout(None)
    file = conn.makefile('rwb', buffering=0)
    buf = b''

    def send(obj):
        try:
            conn.sendall((json.dumps(obj) + '\n').encode())
        except OSError as e:
            log('send failed', e)

    def read_more(timeout):
        nonlocal buf
        end = time.time() + timeout
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if not r:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return False
            if not chunk:
                return False
            buf += chunk
            return True
        return True

    def read_until(pattern, timeout):
        nonlocal buf
        end = time.time() + timeout
        while time.time() < end:
            m = pattern.search(buf)
            if m:
                text = buf[:m.start()]
                buf = buf[m.end():]
                return m, text
            if not read_more(min(0.2, max(0.01, end - time.time()))):
                return None, None
        return None, None

    # 等 `$ ` 提示符（hdcb 检查 + 真 hdc 进入交互需要一点时间）
    prompt_marker = re.compile(rb'\$ ')
    m, _ = read_until(prompt_marker, OPEN_TIMEOUT)
    if m is None:
        log('no prompt; buf=', buf[:200])
        send({'op': 'error', 'open': True, 'message': 'hdc shell 未出现提示符'})
        kill_child()
        cleanup_socket()
        return 3
    send({'op': 'ready', 'relayPid': os.getpid(), 'shellPid': pid})
    log('ready pid=', pid)

    try:
        for raw in file:
            if not raw.strip():
                continue
            try:
                req = json.loads(raw.decode('utf-8'))
            except Exception:
                continue
            op = req.get('op')
            if op == 'close':
                break
            if op != 'run':
                continue
            cmd = str(req.get('cmd') or '')
            nonce = str(req.get('id') or 'x')
            timeout = float(req.get('timeoutMs') or DEFAULT_TIMEOUT) / 1000.0
            marker = '__SP_' + nonce + '_'
            frame = cmd + "; printf '\\n" + marker + "%s\\n' \"$?\"\n"
            try:
                os.write(fd, frame.encode('utf-8'))
            except OSError as e:
                send({'op': 'error', 'id': nonce, 'message': 'pty write failed: ' + str(e)})
                break
            # 哨兵行：__SP_<nonce>_<code>（要求行首 + 后跟数字，避免误匹配回显里的 %s）
            pattern = re.compile(b'(?:^|\\n)' + re.escape(marker.encode()) + rb'(\d+)\r?\n')
            m2, body = read_until(pattern, timeout)
            if m2 is None:
                send({'op': 'error', 'id': nonce, 'message': 'command timeout'})
                log('timeout cmd=', cmd[:80])
                break
            code = int(m2.group(1))
            # body 是哨兵之前的输出；第一行是远端交互 shell 的回显（可能带换行/重绘控制符，
            # 但一定以第一个 \n 结束），直接丢掉第一行。
            raw = body or b''
            # 远端交互 shell 的回显行以 \r\r\n 结束（短命令也是）；输出行以 \r\n 结束。
            idx = raw.find(b'\r\r\n')
            if idx >= 0:
                out_bytes = raw[idx + 3:]
            else:
                nl = raw.find(b'\n')
                out_bytes = raw[nl + 1:] if nl >= 0 else b''
            out = out_bytes.decode('utf-8', errors='replace').strip('\r\n')
            send({'op': 'result', 'id': nonce, 'out': out, 'code': code})
    except Exception as e:  # noqa: BLE001
        log('relay loop error', e)
        traceback.print_exc()
    finally:
        kill_child()
        try:
            conn.close()
        except OSError:
            pass
        try:
            server.close()
        except OSError:
            pass
        cleanup_socket()
    return 0


if __name__ == '__main__':
    sys.exit(main())
