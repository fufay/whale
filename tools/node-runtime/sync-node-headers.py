#!/usr/bin/env python3
"""
同步 Node 头文件到 entry/src/main/cpp/node-headers/（编 libdshhost/koffi/flock 用）。

【与同目录 sync-node-headers.sh 的关系】
  两者目标完全一致（同一批目录、同一份自检），差别只在**取用方式**：
  · sync-node-headers.sh（上游，Windows/WSL 环境）：`find -print0 | tar --null -cf - -T -`，
    依赖 GNU tar 的 `--null` / `-T -`。
  · 本脚本（2026-10-16 增加，OHOS PC / 任意 POSIX）：本机 `tar` 是 **toybox 0.8.12**，
    上述 GNU 参数不可用；故改用 Python 标准库 `tarfile` **按需解压**（不落整份 Node 源码，
    只抽 src/*.h + deps/v8/include + deps/uv/include），并用 `extractfile()` 逐字节写盘
    （天然规避 tar-slip 路径穿越）。
  两份脚本的产物必须等价；换 Node 版本时两者都要重跑。

用法：
    python3 tools/node-runtime/sync-node-headers.py <node 源码 tar.xz 或已解压的源码目录> [DEST]
    # DEST 缺省 = <repo>/entry/src/main/cpp/node-headers

自检：src/node.h / src/node_api.h / src/node_version.h / src/js_native_api.h /
      v8include/v8.h / uvinclude/uv.h 六项齐全，并打印 node_version.h 的 NODE_MAJOR/MINOR/PATCH。
"""
import os
import re
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/ohos/node-v22.23.2')
DEST = sys.argv[2] if len(sys.argv) > 2 else os.path.join(REPO, 'entry', 'src', 'main', 'cpp', 'node-headers')

REQUIRED = [
    'src/node.h', 'src/node_api.h', 'src/node_version.h', 'src/js_native_api.h',
    'v8include/v8.h', 'uvinclude/uv.h',
]

# tar 内顶层目录名（node-vX.Y.Z）——从成员名里剥掉，其余保留相对路径。
TOPDIR_RE = re.compile(r'^[^/]+/')

# 只抽这三处：其余（deps/openssl、test/、doc/ …）对编译无用且体积大。
def wanted(rel: str):
    if rel.startswith('src/') and rel.endswith('.h'):
        return 'src'
    if rel.startswith('deps/v8/include/'):
        return 'v8include'
    if rel.startswith('deps/uv/include/'):
        return 'uvinclude'
    return None


def sync_from_tar(path: str) -> dict:
    counts = {'src': 0, 'v8include': 0, 'uvinclude': 0}
    with tarfile.open(path, 'r:xz') as tf:
        for member in tf:
            if not member.isfile():
                continue
            rel = TOPDIR_RE.sub('', member.name)
            bucket = wanted(rel)
            if bucket is None:
                continue
            if bucket == 'src':
                rel_in_bucket = rel[len('src/'):]
            elif bucket == 'v8include':
                rel_in_bucket = rel[len('deps/v8/include/'):]
            else:
                rel_in_bucket = rel[len('deps/uv/include/'):]
            target = os.path.join(DEST, bucket, rel_in_bucket)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            payload = tf.extractfile(member)
            if payload is None:
                continue
            with open(target, 'wb') as out:
                out.write(payload.read())
            counts[bucket] += 1
    return counts


def sync_from_dir(path: str) -> dict:
    """已解压的源码目录：直接按同口径复制。"""
    import shutil
    counts = {'src': 0, 'v8include': 0, 'uvinclude': 0}
    for root, _dirs, files in os.walk(path):
        for name in files:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, path)
            bucket = wanted(rel)
            if bucket is None:
                continue
            rel_in_bucket = rel[len(bucket) + 1:] if bucket != 'src' else rel[len('src/'):]
            if bucket == 'v8include':
                rel_in_bucket = rel[len('deps/v8/include/'):]
            elif bucket == 'uvinclude':
                rel_in_bucket = rel[len('deps/uv/include/'):]
            target = os.path.join(DEST, bucket, rel_in_bucket)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy2(full, target)
            counts[bucket] += 1
    return counts


def main():
    if not os.path.exists(SRC):
        print(f'ERROR: 找不到 Node 源码：{SRC}', file=sys.stderr)
        sys.exit(1)
    print(f'源: {SRC}')
    print(f'目标: {DEST}')

    # 清理旧产物：避免"上一版残留 + 新版覆盖"混成半新半旧（上游 .sh 同样先 rm -rf）。
    if os.path.isdir(DEST):
        import shutil
        shutil.rmtree(DEST)
    os.makedirs(DEST, exist_ok=True)

    counts = sync_from_tar(SRC) if os.path.isfile(SRC) else sync_from_dir(SRC)
    print(f"抽取：src={counts['src']} 头文件，v8include={counts['v8include']}，uvinclude={counts['uvinclude']}")

    ok = True
    for rel in REQUIRED:
        f = os.path.join(DEST, rel)
        exists = os.path.isfile(f)
        ok = ok and exists
        print(('OK   ' if exists else 'MISS ') + rel)

    ver = os.path.join(DEST, 'src', 'node_version.h')
    if os.path.isfile(ver):
        text = open(ver, encoding='utf-8', errors='ignore').read()
        nums = {k: (re.search(rf'#define {k}\s+(\d+)', text) or [None, '?'])[1]
                for k in ('NODE_MAJOR_VERSION', 'NODE_MINOR_VERSION', 'NODE_PATCH_VERSION')}
        print(f"node_version.h: {nums['NODE_MAJOR_VERSION']}.{nums['NODE_MINOR_VERSION']}.{nums['NODE_PATCH_VERSION']}")

    print('=== 完成 ===' if ok else '=== 有缺项，见上 ===')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
