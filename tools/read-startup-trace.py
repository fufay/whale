#!/usr/bin/env python3
"""读「启动计时链」并打印时间线（ArkTS 侧 + Host 侧合并）。

数据来源（两个小文件，见 system/StartupTrace.ets 与 hostcore/app/main.js 的 stage()）：
  - <files>/diag-startup-ui         ArkTS 侧打点（EntryAbility / NodeRuntime / WebApp）
  - <dsh-home>/diag-startup-host    Host 侧打点（BOOT_00 … BOOT_70，每次冷启动截断）
每行格式：`<epoch ms>\t+<相对该侧起点的 ms>\t<阶段名>[\t<附加信息>]`

用法（默认路径就是本机设备沙箱里的真实位置；从宿主运行请传 --ui/--host）：
    python3 tools/read-startup-trace.py
    python3 tools/read-startup-trace.py --ui <path> --host <path> [--top 40]
"""
import argparse
import os
import sys

DEFAULT_FILES = '/data/storage/el2/base/haps/entry/files'
DEFAULT_UI = os.path.join(DEFAULT_FILES, 'diag-startup-ui')
DEFAULT_HOST = os.path.join(DEFAULT_FILES, 'dsh', 'home', 'diag-startup-host')


def parse(path, src):
    rows = []
    if not os.path.isfile(path):
        return rows
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        for line in fh:
            line = line.rstrip('\n')
            if not line or line.startswith('#'):
                continue
            parts = line.split('\t')
            if len(parts) < 3:
                continue
            try:
                epoch = int(parts[0])
            except ValueError:
                continue
            rows.append({
                'epoch': epoch,
                'delta': parts[1],
                'name': parts[2],
                'extra': parts[3] if len(parts) > 3 else '',
                'src': src,
            })
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ui', default=DEFAULT_UI)
    ap.add_argument('--host', default=DEFAULT_HOST)
    ap.add_argument('--top', type=int, default=0, help='只打印总耗时超过该毫秒的阶段（0=全打）')
    args = ap.parse_args()

    rows = parse(args.ui, 'ui') + parse(args.host, 'host')
    if not rows:
        print('没有找到计时文件。先让 App 冷启动一次，再检查：')
        print('  ', args.ui)
        print('  ', args.host)
        return 1

    rows.sort(key=lambda r: r['epoch'])
    t0 = rows[0]['epoch']
    print(f'启动计时：{len(rows)} 个时间点；t0={t0}（{rows[0]["src"]}:{rows[0]["name"]}）')
    print()
    print(f'{"rel(ms)":>9}  {"src":<4} {"阶段":<26} 附加')
    print('-' * 100)
    for r in rows:
        rel = r['epoch'] - t0
        print(f'{rel:>9}  {r["src"]:<4} {r["name"]:<26} {r["extra"]}')
    print()

    # 关键分段摘要（相邻两个打点之间的耗时）
    print('关键分段（相邻打点差）：')
    segs = []
    for prev, cur in zip(rows, rows[1:]):
        gap = cur['epoch'] - prev['epoch']
        if gap >= 50:  # 50ms 以上才报，避免噪声
            segs.append((gap, prev['name'], cur['name']))
    for gap, a, b in sorted(segs, reverse=True)[:15]:
        print(f'  {gap:>6} ms  {a} → {b}')
    ready = [r for r in rows if r['name'] == 'APP_READY_TOTAL']
    if ready:
        print(f'\nApp 完全就绪总耗时：{ready[0]["epoch"] - t0} ms（{ready[0]["extra"]}）')
    host_ready = [r for r in rows if r['name'].startswith('BOOT_70')]
    if host_ready:
        print(f'Host 端口自探通过：{host_ready[0]["epoch"] - t0} ms（Host 自身 +{host_ready[0]["delta"]}）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
