#!/system/bin/sh
# build-verify-hap.sh —— 本机验证包「一条龙」：读设备已装 versionCode → 用同一个号出调试包 → 覆盖安装 → 核对设备核心树。
#
# 为什么需要它（2026-11-12 定案）：
#   本机调试 Profile 是**无 ACL** 的，`hdc install -r` 在 versionCode 变大时会走 ACL 权限校验，
#   必然 `grant request permissions failed`（docs/125 §八/§九）。所以本机验证一律用
#   **与设备已装包相同的 versionCode** 覆盖安装，避免每次发版都额外手工出包/讨论版本号。
#
# 约定（见 AGENTS.md「出包与本机验证」）：
#   · 发布件 versionCode = 10100N（随 v1.1.N 递增）；本机验证件 = **设备已装 versionCode**；
#   · 本机验证装机属于常规步骤，**默认授权**，不再逐次请示。
#
# 用法：
#   sh tools/build-verify-hap.sh                 # 出包并覆盖安装（versionName 取 AppScope 当前值）
#   sh tools/build-verify-hap.sh --name 1.1.9    # 指定 versionName
#   sh tools/build-verify-hap.sh --no-install    # 只出包不装
#   sh tools/build-verify-hap.sh --wait-core 180 # 装完等你在设备上重启应用，最多等 180s 核对新核心树
#
# 依赖：hdc（可用 HDC=/path/to/hdc 覆盖）、node（读 AppScope/core-recipe）、tools/build-dev-hap.sh。
set -eu

REPO="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
BUNDLE="com.jwhsoft.whale"
CORES="/data/app/el2/100/base/$BUNDLE/haps/entry/files/dsh/cores"
HDC="${HDC:-hdc}"

NAME=""
INSTALL=1
WAIT_CORE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:?--name 需要值}"; shift 2 ;;
    --no-install) INSTALL=0; shift ;;
    --wait-core) WAIT_CORE="${2:?--wait-core 需要秒数}"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（-h 看用法）" >&2; exit 2 ;;
  esac
done

die() { echo "[verify-hap] ✗ $*" >&2; exit 1; }
say() { echo "[verify-hap] $*"; }

# ① 设备已装 versionCode
say "① 读设备已装版本（$BUNDLE）"
DUMP=$("$HDC" shell "bm dump -n $BUNDLE" 2>/dev/null || true)
VC=$(printf '%s\n' "$DUMP" | tr -d '\r' | grep -o '"versionCode": *[0-9]\+' | grep -o '[0-9]\+' | awk '$1 > 100000' | sort -n | tail -1)
[ -n "$VC" ] || die "读不到设备已装 versionCode（hdc 连上了吗？先跑 hdc list targets / 起桥；或用 HDC= 指定）"
say "   已装 versionCode = $VC"

if [ -z "$NAME" ]; then
  NAME=$(node -e "const s=require('fs').readFileSync('$REPO/AppScope/app.json5','utf8');const m=/\"versionName\"\\s*:\\s*\"([^\"]*)\"/.exec(s);process.stdout.write(m?m[1]:'')")
fi
[ -n "$NAME" ] || die "读不到 versionName（用 --name 指定）"
CORE_VERSION=$(node -e "const s=require('fs').readFileSync('$REPO/hostcore/core-recipe.json','utf8');const m=/\"coreVersion\"\\s*:\\s*\"([^\"]*)\"/.exec(s);process.stdout.write(m?m[1]:'')")
[ -n "$CORE_VERSION" ] || die "读不到 coreVersion"
say "   目标 versionName = $NAME（versionCode 固定 $VC），核心树 = $CORE_VERSION"

# ② 出包（复用 build-dev-hap.sh 的版本号临时覆盖 + 去签名 + STORED 重打包 + 调试 Profile 签名）
OUT="$REPO/dist/signing/dev-profile/whale-verify-$NAME-vc$VC.hap"
say "② 构建 $OUT"
cd "$REPO"
WHALE_DEV_VERSIONCODE="$VC" WHALE_DEV_VERSIONNAME="$NAME" sh tools/build-dev-hap.sh "$OUT"

if [ "$INSTALL" = "0" ]; then
  say "③ 跳过安装（--no-install）；产物：$OUT"
  exit 0
fi

# ③ 覆盖安装（同 versionCode ⇒ 不走 ACL 权限校验；el2 用户数据原地保留）
say "③ hdc install -r（同 versionCode 覆盖）"
"$HDC" install -r "$OUT" 2>&1 | grep -vi 'HiLogBase' || true
INSTALLED=$("$HDC" shell "bm dump -n $BUNDLE" 2>/dev/null | tr -d '\r' | grep -o '"versionCode": *[0-9]\+' | grep -o '[0-9]\+' | awk '$1 > 100000' | sort -n | tail -1)
[ -n "$INSTALLED" ] || die "安装后读不到 versionCode"
[ "$INSTALLED" = "$VC" ] || die "安装后 versionCode=$INSTALLED ≠ 期望 $VC"
say "   ✓ 已装机（versionCode $INSTALLED）"

# ④ 可选：等用户重启应用后核对核心树是否换到目标版本
if [ "$WAIT_CORE" -gt 0 ]; then
  say "④ 等新核心树解包（最多 ${WAIT_CORE}s）：请现在**重启 WhaleX**，脚本会轮询 $CORES"
  i=0
  while [ "$i" -lt "$WAIT_CORE" ]; do
    if "$HDC" shell "grep -q '\"coreVersion\": *\"$CORE_VERSION\"' $CORES/*/dshm-core.json 2>/dev/null" 2>/dev/null; then
      say "   ✓ 设备核心树已切到 $CORE_VERSION"
      exit 0
    fi
    sleep 5
    i=$((i + 5))
  done
  say "   ⚠ 超时未看到 $CORE_VERSION 树；设备现有树："
  "$HDC" shell "ls -1 $CORES 2>/dev/null" 2>/dev/null || true
  die "核心树未切换（应用没重启？或安装后未到首启解包阶段）"
fi

say "完成。请在设备上**重启 WhaleX**，首启会解包核心树（约 2–4 分钟）；之后应用内「关于/dsh 版本」应显示 $CORE_VERSION"
