#!/bin/sh
# 构建 office2pdf 的 C ABI 动态库（liboffice2pdf_capi.so），放进 entry/libs/arm64-v8a/。
#
# ── 为什么需要这个脚本 ──────────────────────────────────────────────────────
# 侧栏 Office 预览的转换引擎是 **HAP 内置**的：Rust/Typst 的 office2pdf 编成纯 C ABI
# cdylib（本文件的产物），由 CMake 构建的 NAPI 外壳 `office2pdf_ext.cpp` 运行时 dlopen 调用。
# 而 `entry/libs/` 整个目录是 **gitignore** 的（几十 MB 的二进制不入库）⇒ 干净克隆里
# 没有这个 .so，必须先跑本脚本才能出包。
#
# ── 前置 ────────────────────────────────────────────────────────────────────
# 1) office2pdf 源码树（钉死版本）：
#      git clone https://github.com/developer0hye/office2pdf <dir>
#      cd <dir> && git checkout 7ddb65db49211d560878353824f6644a2bddb191   # 评估时的钉死提交
# 2) Harmonybrew 的 cargo（本机 rustc host 就是 aarch64-unknown-linux-ohos，
#    **不需要** --target；也不要加 musl/gnu target，本机没有那些 std）：
#      export PATH=/storage/Users/currentUser/.harmonybrew/bin:$PATH
# 3) crates.io 直连不可用 ⇒ 脚本内置 rsproxy 源替换。
#
# ── 用法 ────────────────────────────────────────────────────────────────────
#   sh tools/office2pdf/build-capi.sh [office2pdf 源码目录]
# 缺省源码目录：$OFFICE2PDF_SRC，或本机评估项目里的那份。
#
# ── 产物 ────────────────────────────────────────────────────────────────────
#   entry/libs/arm64-v8a/liboffice2pdf_capi.so   （约 52 MB）
#   该文件由 CMake 外壳 dlopen；不进 git。
set -eu
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BREW=${HARMONYBREW_PREFIX:-/storage/Users/currentUser/.harmonybrew}

SRC=${1:-${OFFICE2PDF_SRC:-/storage/Users/currentUser/projects/DSH_Proj/Eva-Research/2026-10-29-office2pdf-rust评估/_refer/office2pdf-src}}
if [ ! -d "$SRC/crates/office2pdf" ]; then
  echo "ERROR: 找不到 office2pdf 源码树：$SRC" >&2
  echo "       先按文件头「前置」克隆并 checkout 钉死提交，然后用 \$OFFICE2PDF_SRC 或第一个参数指定。" >&2
  exit 1
fi
if [ ! -x "$BREW/bin/cargo" ]; then
  echo "ERROR: 找不到 Harmonybrew cargo：$BREW/bin/cargo" >&2
  exit 1
fi

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/office2pdf-capi.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/src"
cp "$REPO/tools/office2pdf/capi/src/lib.rs" "$STAGE/src/lib.rs"
sed "s#__OFFICE2PDF_SRC__#$SRC#g" "$REPO/tools/office2pdf/capi/Cargo.toml.template" > "$STAGE/Cargo.toml"

export PATH="$BREW/bin:$PATH"
export CARGO_TARGET_DIR="$STAGE/target"
echo "[build-capi] 源码：$SRC"
echo "[build-capi] 构建（首次约 5 分钟，依赖 500+ crate）…"
( cd "$STAGE" && cargo build --release \
    --config 'source.crates-io.replace-with="rsproxy"' \
    --config 'source.rsproxy.registry="sparse+https://rsproxy.cn/index/"' )

OUT="$REPO/entry/libs/arm64-v8a/liboffice2pdf_capi.so"
mkdir -p "$REPO/entry/libs/arm64-v8a"
cp "$STAGE/target/release/liboffice2pdf_capi.so" "$OUT"
echo "[build-capi] 已写入：$OUT"
ls -lh "$OUT"
echo "[build-capi] 校验导出符号（应有 office2pdf_convert / office2pdf_version / office2pdf_selfcheck）："
"$BREW/opt/llvm@22/bin/llvm-nm" -D "$OUT" 2>/dev/null | grep -E "office2pdf_(convert|version|selfcheck)" || true
