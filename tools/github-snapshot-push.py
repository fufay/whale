#!/usr/bin/env python3
"""把当前 HEAD 快照推送到 GitHub（绕开本机 `git push` 的 SIGABRT）。

## 为什么不用 git push
本机 git 的 `push` / `fetch` **每次都 SIGABRT（exit 134）**，且崩在派生子进程
（`run_command: git remote-https`）**任何网络 I/O 之前** —— 与代理/网络无关；
而 `git clone`、`git ls-remote` 正常。所以推送只能走 **GitHub Git Data API**
（blobs → trees → commits → refs），传输用 curl（本机 python3 的 SSL 缺 CA 证书）。

## 它做什么（增量）
1. 读远端 `refs/heads/<branch>` → head commit → 其 tree；
2. `GET /git/trees/<tree>?recursive=1` 拿远端全量树，与本地 `git ls-tree -r HEAD` 比对；
3. 只上传**新增/改动**的 blob，删除项以 `sha: null` 表达；`base_tree` 用远端树；
4. 建 commit（parent = 远端 head）→ PATCH ref；
5. **树上一致性断言**：新 commit 的 tree 必须等于本地 `HEAD^{tree}`，否则报错（exit 2）。

## 用法
```sh
export GH_TOKEN_FILE=/path/to/gh_token.txt     # 默认: <repo>/../../tmp/gh_token.txt
python3 tools/github-snapshot-push.py          # 推当前 HEAD
python3 tools/github-snapshot-push.py --dry-run   # 只打印将要推的差异
GH_REPO=owner/name GH_BRANCH=main python3 tools/github-snapshot-push.py
```
需要本机代理（github.com 直连超时）：默认 `http://127.0.0.1:17890`，可用 `GH_PROXY` 覆盖。

## 边界
- **不做历史回放**：远端是"每次推送一个快照提交"，本地完整历史仍在本地/gitcode；
- 不做本地 `reset`（本地分支与远端提交是**两条独立历史**，只保证**树一致**）；
- 首次推送（远端为空）不在本工具范围：GitHub 对空仓禁用 Git Data API，
  需先用 Contents API 落一个初始提交（见 `docs/117` 同期的首推记录）。
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def env(name, default):
    value = os.environ.get(name)
    return value if value else default


TOKEN_FILE = env('GH_TOKEN_FILE', os.path.join(REPO, '..', '..', 'tmp', 'gh_token.txt'))
FULL = env('GH_REPO', 'fufay/whale')
BRANCH = env('GH_BRANCH', 'main')
PROXY = env('GH_PROXY', 'http://127.0.0.1:17890')
# 【CA 证书（2026-10-24 实操踩坑）】本机 curl 是 musl 版、默认没有可用的系统 CA，
# 直连/挂代理访问 api.github.com 都会 `SSL certificate verify result: … (20)`。
# brew 自带一份 CA 包；有 CURL_CA_BUNDLE 时尊重它，否则用这份已知可用的。
CA_BUNDLE = env('CURL_CA_BUNDLE', '/storage/Users/currentUser/.harmonybrew/etc/ca-certificates/cert.pem')
DRY = '--dry-run' in sys.argv
MAX_WORKERS = int(env('GH_PUSH_WORKERS', '6'))

TOKEN = open(TOKEN_FILE).read().strip()
HEADERS = [
    '-H', f'Authorization: token {TOKEN}',
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'User-Agent: whale-snapshot-push',
]


def curl(args, stdin=None):
    """带重试的 curl。

    【为什么必须重试】本机只能经代理访问 github.com，而代理节点会**间歇性 TLS 抖动**
    （实测现象：`curl: (35) TLS connect error: ... unexpected eof while reading`，
    AGENTS.md §七 也记了"经代理节点时 TLS 会抖"）。这类错误是瞬时的、与请求内容无关，
    直接重试即可；否则一个 500+ 文件的推送会在随机一个 blob 上失败。
    """
    last = ('', '')
    for attempt in range(4):
        cmd = ['curl', '-sS', '--max-time', '180', '-x', PROXY]
        if os.path.exists(CA_BUNDLE):
            cmd += ['--cacert', CA_BUNDLE]
        cmd += args
        done = subprocess.run(cmd, input=stdin, capture_output=True)
        out = done.stdout.decode(errors='replace')
        err = done.stderr.decode(errors='replace')
        if done.returncode == 0 and out.strip():
            return out, err
        last = (out, err)
        time.sleep(2 + attempt * 2)
    return last


def api(method, path, data=None, allow_missing=False):
    args = ['-X', method] + HEADERS + [f'https://api.github.com{path}']
    stdin = None
    if data is not None:
        args += ['--data-binary', '@-']
        stdin = json.dumps(data).encode()
    out, err = curl(args, stdin)
    try:
        payload = json.loads(out)
    except Exception:
        raise SystemExit(f'❌ API 响应无法解析 {method} {path}: {out[:300]} | {err[:200]}')
    if isinstance(payload, dict) and payload.get('message') and 'sha' not in payload and 'id' not in payload:
        if allow_missing and payload.get('status') == '404':
            return None
        raise SystemExit(f'❌ API 报错 {method} {path}: {str(payload)[:300]}')
    return payload


def git(*args, binary=False):
    done = subprocess.run(['git', '-C', REPO, '-c', 'core.quotePath=false'] + list(args),
                          capture_output=True)
    if done.returncode != 0:
        raise SystemExit(f'❌ git {args[0]} 失败: {done.stderr.decode(errors="replace")[:200]}')
    return done.stdout if binary else done.stdout.decode()


def local_tree():
    """HEAD 的全量树：path → (mode, blob sha)。"""
    listing = git('ls-tree', '-r', 'HEAD')
    entries = {}
    for line in listing.splitlines():
        meta, path = line.split('\t', 1)
        mode, kind, sha = meta.split()
        if kind == 'blob':
            entries[path] = (mode, sha)
    return entries


def remote_tree(tree_sha):
    """远端全量树（递归）：path → (mode, sha)。"""
    payload = api('GET', f'/repos/{FULL}/git/trees/{tree_sha}?recursive=1')
    entries = {}
    for item in payload.get('tree', []):
        if item.get('type') == 'blob':
            entries[item['path']] = (item['mode'], item['sha'])
    if payload.get('truncated'):
        raise SystemExit('❌ 远端树被截断（truncated=true），本工具不支持超大仓库')
    return entries


def main():
    ref = api('GET', f'/repos/{FULL}/git/ref/heads/{BRANCH}', allow_missing=True)
    if ref is None:
        raise SystemExit('❌ 远端没有该分支 —— 首次推送请先用 Contents API 落初始提交（见脚本头注）')
    remote_head = ref['object']['sha']
    remote_commit = api('GET', f'/repos/{FULL}/git/commits/{remote_head}')
    base_tree = remote_commit['tree']['sha']

    local = local_tree()
    remote = remote_tree(base_tree)

    upload = [p for p, (mode, sha) in local.items()
              if remote.get(p) != (mode, sha)]
    remove = [p for p in remote if p not in local]
    print(f'远端 HEAD: {remote_head[:12]} | 本地文件 {len(local)} | 远端文件 {len(remote)}')
    print(f'待上传 {len(upload)} 个、待删除 {len(remove)} 个')
    for path in upload[:20]:
        print('  ↑', path)
    for path in remove[:20]:
        print('  ✗', path)
    if DRY:
        print('（--dry-run：不写远端）')
        return

    local_tree_sha = git('rev-parse', 'HEAD^{tree}').strip()
    if not upload and not remove:
        print('✓ 远端树与本地一致，无需推送')
        if remote_commit['tree']['sha'] != local_tree_sha:
            print(f'⚠ 但远端提交的树 {remote_commit["tree"]["sha"][:12]} ≠ 本地树 {local_tree_sha[:12]}')
        return

    def put(path):
        mode, sha = local[path]
        data = git('cat-file', 'blob', sha, binary=True)
        blob = api('POST', f'/repos/{FULL}/git/blobs',
                   {'content': base64.b64encode(data).decode(), 'encoding': 'base64'})
        return {'path': path, 'mode': mode, 'type': 'blob', 'sha': blob['sha']}

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        entries = list(pool.map(put, upload))
    for path in remove:
        entries.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': None})
    print(f'✓ blob 上传完成（{len(entries)} 条树变更）')

    tree = api('POST', f'/repos/{FULL}/git/trees', {'base_tree': base_tree, 'tree': entries})
    message = git('log', '-1', '--format=%B', 'HEAD')
    commit = api('POST', f'/repos/{FULL}/git/commits',
                 {'message': message, 'tree': tree['sha'], 'parents': [remote_head]})
    api('PATCH', f'/repos/{FULL}/git/refs/heads/{BRANCH}', {'sha': commit['sha'], 'force': False})
    print(f'✓ 远端已更新：{commit["sha"][:12]}')

    if tree['sha'] != local_tree_sha:
        raise SystemExit(f'❌ 树上一致性失败：远端树 {tree["sha"][:12]} ≠ 本地树 {local_tree_sha[:12]}')
    print('✓ 树上一致性：远端树 == 本地 HEAD^{tree}')


if __name__ == '__main__':
    main()
