#!/system/bin/sh
# 调试双包（com.jwhsoft.whale）出包一条龙：
#   1) hvigor debug 构建（工程里 signingConfig 是 DevEco 自动签名，生成的是“自动证书”签名 HAP）
#   2) 去掉签名块、按 HAP 要求全部条目 STORED 重打包（DEFLATE 会导致图标/资源加载不出来）
#   3) 用开发者证书 whale + 带 ACL 的调试 Profile（whale-dev-debug-full）手工重签
#
# 为什么不能直接用 hvigor 产出的 signed HAP：自动签名的 Profile 是空 ACL，
# 装机会报 grant request permissions failed（ACCESS_USER_FULL_DISK 等）。
# 为什么必须重打包：hvigor 产出的 HAP 可能带签名块；且 py zipfile 若用 ZIP_DEFLATED
# 会破坏鸿蒙资源读取（实测图标全空），必须 ZIP_STORED。
#
# 用法：sh tools/build-dev-hap.sh [out.hap]
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
DC_CLI=/storage/Users/currentUser/npm/lib/node_modules/@deveco/deveco-cli/cli.js
OUT="${1:-$REPO/dist/signing/dev-profile/whale-dev-latest-signed.hap}"
mkdir -p "$(dirname "$OUT")"

cd "$REPO"
# 1) 构建（先删旧产物，避免"构建失败却静默用上一次的 HAP"——2026-10-28 踩过：
#    旧脚本把 "node cli.js" 当整条命令名，构建其实没跑，结果把 rc.2 旧核打进了 alpha.2 调试包）
OUT_DIR="$REPO/entry/build/default/outputs/default"
rm -f "$OUT_DIR"/entry-default-signed.hap "$OUT_DIR"/entry-default-unsigned.hap
"$NODE_BIN" "$DC_CLI" build --build-mode debug > /tmp/whale-dev-build.log 2>&1
BUILD_RC=$?
SRC="$OUT_DIR/entry-default-signed.hap"
[ -f "$SRC" ] || SRC="$OUT_DIR/entry-default-unsigned.hap"
if [ ! -f "$SRC" ]; then
  echo "ERROR: 构建失败且没有产物（rc=$BUILD_RC，看 /tmp/whale-dev-build.log）" >&2
  tail -5 /tmp/whale-dev-build.log >&2
  exit 1
fi
echo "build rc=$BUILD_RC, src=$(basename "$SRC") $(stat -c %y "$SRC")"

# 2) 去签名 + 全 STORED 重打包
TMP="$REPO/dist/signing/dev-profile/.repack-unsigned.hap"
python3 - "$SRC" "$TMP" <<'PY'
import sys, zipfile
src, out = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(src)
entries = []
for n in z.namelist():
    if n.startswith('META-INF') or 'signature' in n.lower():
        continue
    entries.append((n, z.read(n)))
with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED) as w:
    for n, b in entries:
        w.writestr(n, b)
print('repacked stored:', out, len(entries), 'entries')
PY

# 3) 手工签名（默认用 **365 天**的 `whale-dev-debug`；可用 WHALE_DEV_PROFILE 覆盖）
#
# 【为什么不用带 ACL 的 `whale-dev-debug-full`（2026-11-03 实测纠正）】
# 曾以为"全功能包必须带 ACL 的 Profile"，于是用 AGC 的 ACL 调试 Profile —— AGC 对"带受限权限
# 的调试 Profile"只签发 **5–7 天**，导致应用反复"应用已过期"。
# 实测对照（同一 HAP、只换 Profile，用 `atm dump -t -b com.jwhsoft.whale` 读 token 权限状态）：
#   带 ACL  vs  无 ACL：
#     ALLOW_EXTERNAL_NATIVE_CODE / CUSTOM_SANDBOX / READ_WRITE_USER_FILE  两者都是 grantStatus=0（已授予）
#     ACCESS_USER_FULL_DISK                                              两者都是 -1（本机系统无此权限定义，`atm perm -g` 报 "does not exist"）
#   ⇒ **ACL Profile 没有带来任何额外权限**，纯属白折腾；用 365 天的无 ACL Profile 即可。
# 恢复"带 ACL"只需：WHALE_DEV_PROFILE=dist/signing/dev-profile/whale-dev-debug-full.p7b
WHALE_DEV_PROFILE="${WHALE_DEV_PROFILE:-$REPO/dist/signing/dev-profile/whale-dev-debug.p7b}" \
  sh "$REPO/tools/sign-dev-hap.sh" "$TMP" "$OUT"
rm -f "$TMP"
echo "OK: $OUT"
