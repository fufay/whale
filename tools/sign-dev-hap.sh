#!/system/bin/sh
# 本地调试签名（com.jwhsoft.whale 专用）：hvigor 的 SignHap 用的是旧包名 DevEco Profile，
# 换包名后无法用它签名；这里用「AGC 调试证书 whale + 新包名调试 Profile」手动签 unsigned HAP。
#
# 用法：
#   sh tools/sign-dev-hap.sh <unsigned.hap> [out.hap]
# 依赖（路径固定，材料在 dist/ 与 certificate/ 下，均不入库）：
#   p12      dist/signing/csr-<id>/key_<id>.p12（密码在同目录 password.txt）
#   cert     certificate/whale-debug/whale.cer
#   profile  dist/signing/dev-profile/whale-dev-debug.p7b
# 可覆盖：WHALE_DEV_P12 / WHALE_DEV_PWD_FILE / WHALE_DEV_CERT / WHALE_DEV_PROFILE
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TC=/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0/sdk/default/openharmony/toolchains/lib
HAP_IN="${1:?usage: sign-dev-hap.sh <unsigned.hap> [out.hap]}"
HAP_OUT="${2:-${HAP_IN%-unsigned.hap}-devsigned.hap}"
P12="${WHALE_DEV_P12:-$(ls "$REPO"/dist/signing/csr-*/key_*.p12 2>/dev/null | head -1)}"
PWD_FILE="${WHALE_DEV_PWD_FILE:-$(dirname "$P12")/password.txt}"
CERT="${WHALE_DEV_CERT:-$REPO/../../certificate/whale-debug/whale.cer}"
PROFILE="${WHALE_DEV_PROFILE:-$REPO/dist/signing/dev-profile/whale-dev-debug-full.p7b}"
[ -f "$P12" ] && [ -f "$PWD_FILE" ] && [ -f "$CERT" ] && [ -f "$PROFILE" ] || { echo "签名材料缺失（检查 $P12 / $PWD_FILE / $CERT / $PROFILE）" >&2; exit 1; }
PW=$(cat "$PWD_FILE")
"$TC/hap-sign-tool" sign-app -mode localSign -inFile "$HAP_IN" -outFile "$HAP_OUT" \
  -signAlg SHA256withECDSA -keyAlias whale-debug -keyPwd "$PW" \
  -keystoreFile "$P12" -keystorePwd "$PW" -appCertFile "$CERT" -profileFile "$PROFILE"
sha256sum "$HAP_OUT"
