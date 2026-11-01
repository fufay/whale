/**
 * ACL 探针（D-009 / 2026-10-27）：确认 `ohos.permission.kernel.ALLOW_EXECUTABLE_FORT_MEMORY`
 * 是否**真的被系统授予**。
 *
 * 【为什么需要它】"JIT 能开"不能证明 ACL 拿到了：A 实验里没声明权限、没 ACL，JIT 照样
 * 可用（debug 域允许可执行内存）。要回答"权限到底有没有"，只能问系统的权限服务——
 * `abilityAccessCtrl.checkAccessToken()` 是唯一权威判据（返回 0=已授予，-1=未授予）。
 *
 * 【为什么放在 ArkTS】Host 跑在 libnode 里，只有 node API，拿不到 HarmonyOS 的权限服务；
 * 本探针在 EntryAbility 启动早期跑，把结果写盘，Host 的 `runtimeFacts()` 再读进
 * `host-ready.json` 的 `runtime.aclJitExecMem`（每次启动自证，不必再靠猜或 hdc）。
 *
 * 【失败不阻断启动】探针整体 try/catch，写不出文件时 Host 侧会显示"未探测"——绝不因为
 * 一个诊断项把应用搞挂。
 */
import { abilityAccessCtrl, bundleManager, Permissions } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG: string = 'DSHM-AclProbe';
const JIT_PERMISSION_NAME: string = 'ohos.permission.kernel.ALLOW_EXECUTABLE_FORT_MEMORY';
const PROBE_FILE_NAME: string = 'acl-jit-probe.json';

export interface AclJitProbe {
  /** 被查询的权限名（写死，便于与 Profile 的 allowed-acls 对照） */
  permission: string;
  /** true=已授予 / false=未授予 / null=无法判定（异常，见 note） */
  granted: boolean | null;
  /** 本应用 accessTokenId；-1 = 取不到 */
  tokenId: number;
  /** 人话原因（异常时非空） */
  note: string;
  /** 探针时间（ISO） */
  at: string;
}

/** 查询一次 ACL 授予状态（不写盘；供测试/诊断复用）。 */
export async function probeAclJit(): Promise<AclJitProbe> {
  const at: string = new Date().toISOString();
  let tokenId: number = -1;
  try {
    const info = bundleManager.getBundleInfoForSelfSync(
      bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
    tokenId = info.appInfo.accessTokenId;
  } catch (e) {
    return {
      permission: JIT_PERMISSION_NAME, granted: null, tokenId: -1,
      note: '取 accessTokenId 失败：' + String(e), at: at,
    };
  }
  try {
    const atManager = abilityAccessCtrl.createAtManager();
    // SDK 的 `permissions.d.ts` 已收录该权限（API 26），直接按 Permissions 联合类型使用；
    // 不用 `as unknown as`（ArkTS 规则 arkts-no-any-unknown 会直接编译失败）。
    const permission: Permissions = 'ohos.permission.kernel.ALLOW_EXECUTABLE_FORT_MEMORY';
    const status = await atManager.checkAccessToken(tokenId, permission);
    const granted: boolean = status === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED;
    hilog.info(DOMAIN, TAG, 'ACL 探针：%{public}s → %{public}s（tokenId=%{public}d）',
      JIT_PERMISSION_NAME, granted ? 'granted' : 'denied', tokenId);
    return { permission: JIT_PERMISSION_NAME, granted: granted, tokenId: tokenId, note: '', at: at };
  } catch (e) {
    hilog.warn(DOMAIN, TAG, 'ACL 探针失败：%{public}s', String(e));
    return {
      permission: JIT_PERMISSION_NAME, granted: null, tokenId: tokenId,
      note: 'checkAccessToken 失败：' + String(e), at: at,
    };
  }
}

/**
 * 跑一次探针并写 `<files>/dsh/home/acl-jit-probe.json`（Host 的 runtimeFacts 读这个文件）。
 * 刻意做成 fire-and-forget：EntryAbility 的启动链不能被诊断项 await 拖慢。
 */
function writeProbeFile(filesDir: string, probe: AclJitProbe): void {
  const dir: string = `${filesDir}/dsh/home`;
  try {
    // 目录已存在时部分系统版本的 mkdirSync 会抛 EEXIST：那不是错误，继续写。
    fs.mkdirSync(dir, true);
  } catch (e) {
    // 忽略：目录已存在（或建不了，后面的 open 会给出真实原因）
  }
  const path: string = `${dir}/${PROBE_FILE_NAME}`;
  const f = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.WRITE_ONLY);
  fs.writeSync(f.fd, JSON.stringify(probe, null, 2) + '\n');
  fs.closeSync(f);
}

/**
 * 跑一次探针并写 `<files>/dsh/home/acl-jit-probe.json`（Host 的 runtimeFacts 读这个文件）。
 *
 * 【为什么先写占位、再异步覆盖】`checkAccessToken()` 是异步 API，且它可能慢/被拦；若只在
 * then 里写盘，"探针到底跑没跑"在 Host 侧就完全不可见（实测一次安装后文件根本不存在）。
 * 先同步写 `granted:null, note:'探测中'`，Host 至少有读数；异步结果再覆盖成 granted/denied。
 */
export function writeAclJitProbe(filesDir: string): void {
  const started: AclJitProbe = {
    permission: JIT_PERMISSION_NAME, granted: null, tokenId: -1,
    note: '探针已启动，异步结果稍后覆盖（若一直如此，说明 checkAccessToken 未返回）',
    at: new Date().toISOString(),
  };
  try {
    writeProbeFile(filesDir, started);
  } catch (e) {
    hilog.warn(DOMAIN, TAG, 'ACL 探针占位写盘失败（忽略）：%{public}s', String(e));
  }
  probeAclJit().then((probe: AclJitProbe) => {
    try {
      writeProbeFile(filesDir, probe);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'ACL 探针结果写盘失败（忽略）：%{public}s', String(e));
    }
  }).catch((e: Object) => {
    hilog.warn(DOMAIN, TAG, 'ACL 探针异常（忽略）：%{public}s', String(e));
    try {
      writeProbeFile(filesDir, {
        permission: JIT_PERMISSION_NAME, granted: null, tokenId: -1,
        note: '探针异常：' + String(e), at: new Date().toISOString(),
      });
    } catch (e2) {
      // 连错误都写不出来：只剩 hilog
    }
  });
}
