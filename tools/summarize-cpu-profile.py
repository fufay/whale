#!/usr/bin/env python3
"""汇总 V8 CPU profile（`.cpuprofile`）——找出启动耗时的热点。

配合 `enable-host-cpu-prof` 开关使用（见 entry/src/main/ets/runtime/NodeRuntime.ets）：
Host 以 `--cpu-prof --cpu-prof-dir <home>/prof` 启动后，会产出
`<home>/prof/*.cpuprofile`（JSON）。本工具按「自耗时」聚合：
  1) 顶层函数（function + url 的 file:line）；
  2) 按 npm 包聚合（URL 里的 `node_modules/(@scope/)?pkg`）；
  3) 按「内置 / 树内包 / 本仓入口脚本」粗分类。

用法：
    python3 tools/summarize-cpu-profile.py [profile 目录或文件...] [--top 30]

默认目录：/data/storage/el2/base/haps/entry/files/dsh/home/prof
"""
import argparse
import glob
import json
import os
import re
import sys
from collections import defaultdict

DEFAULT_DIR = '/data/storage/el2/base/haps/entry/files/dsh/home/prof'


def pkg_of(url):
    m = re.search(r'node_modules/(@[^/]+/[^/]+|[^/]+)/', url)
    if m:
        return m.group(1)
    if url.startswith('node:') or url.startswith('internal/'):
        return '<node-internal>'
    if not url:
        return '<native/no-url>'
    if 'resources/app/' in url or '/app/' in url:
        return '<host-entry-scripts>'
    return url.split('/')[0] + '/…'


def load(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        return json.load(fh)


def summarize(path, top):
    data = load(path)
    nodes = {n['id']: n for n in data.get('nodes', [])}
    samples = data.get('samples', [])
    deltas = data.get('timeDeltas', [])
    if not samples:
        print(f'  （{os.path.basename(path)} 无 samples；可能 --jitless 下采样不可用）')
        return None
    self_us = defaultdict(int)
    for i, nid in enumerate(samples):
        d = deltas[i] if i < len(deltas) else 0
        self_us[nid] += d
    total = sum(self_us.values())
    print(f'\n=== {os.path.basename(path)} ===')
    print(f'采样总时长 ≈ {total/1000:.1f} ms，样本 {len(samples)} 个')

    rows = []
    for nid, us in self_us.items():
        n = nodes.get(nid, {})
        cf = n.get('callFrame', {})
        fn = cf.get('functionName') or '(anonymous)'
        url = cf.get('url', '')
        line = cf.get('lineNumber', -1) + 1
        rows.append((us, fn, url, line))
    rows.sort(reverse=True)

    print(f'\n-- 自耗时 Top {top} 函数 --')
    for us, fn, url, line in rows[:top]:
        short = url
        short = re.sub(r'^.*/node_modules/', 'nm/', short)
        short = re.sub(r'^.*/dsh/cores/[^/]+/', 'tree/', short)
        if len(short) > 70:
            short = '…' + short[-69:]
        print(f'{us/1000:8.1f} ms  {us/total*100:5.1f}%  {fn:<40} {short}:{line}')

    print(f'\n-- 按 npm 包聚合 --')
    by_pkg = defaultdict(int)
    for nid, us in self_us.items():
        url = nodes.get(nid, {}).get('callFrame', {}).get('url', '')
        by_pkg[pkg_of(url)] += us
    for pkg, us in sorted(by_pkg.items(), key=lambda x: -x[1])[:top]:
        print(f'{us/1000:8.1f} ms  {us/total*100:5.1f}%  {pkg}')
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('paths', nargs='*')
    ap.add_argument('--top', type=int, default=30)
    args = ap.parse_args()

    files = []
    for p in (args.paths or [DEFAULT_DIR]):
        if os.path.isdir(p):
            files.extend(sorted(glob.glob(os.path.join(p, '*.cpuprofile'))))
        elif os.path.isfile(p):
            files.append(p)
    if not files:
        print('没有找到 .cpuprofile：')
        print('  1) 先创建开关文件 <files>/enable-host-cpu-prof')
        print('  2) 重启 App（Host 会以 --cpu-prof 启动）')
        print(f'  3) 再跑本脚本（默认目录 {DEFAULT_DIR}）')
        return 1
    files.sort(key=os.path.getmtime)
    print(f'发现 {len(files)} 个 profile：')
    for f in files:
        print(f'  {os.path.getsize(f):>10,} B  {f}')
    for f in files[-1:]:  # 只分析最新一份（一次重启一份）
        summarize(f, args.top)
    return 0


if __name__ == '__main__':
    sys.exit(main())
