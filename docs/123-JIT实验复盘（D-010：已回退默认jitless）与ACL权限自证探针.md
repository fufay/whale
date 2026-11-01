# JIT 实验复盘（D-010：已回退，默认 jitless）+ ACL 权限自证探针

> 2026-10-27 ｜ 决策：`DECISIONS.md` **D-010**（撤销 D-009）｜ 历史：`docs/50` §4.4
> 结论一句话：**debug 签名包"去掉 `--jitless` 就有 JIT"只是安装/调试会话的临时态，系统重启后 Host/V8 初始化必崩；
> 已恢复默认 jitless。** 华为的 ACL / 调试 Profile 才是正式通道，不是摆设。
> 保留：ACL 自证探针（`host-ready.json.runtime.aclJitExecMem`）与本次实验的完整记录。

## 一、实验过程与实测读数

1. **安装后（系统未重启）**：JIT 可用——
   - `host-ready.json.runtime.jitless=false`；
   - `WebAssembly` 可用，fetch 走原生 undici（`WASM 可用，保留 Node 内建 undici`）；
   - `/proc/<host_pid>/maps`：2 个 ~255.75MB `rwxp` 匿名映射，其中一个 Rss **11.9MB**（已写入 JIT 代码）；
   - ACL 探针：`ohos.permission.kernel.ALLOW_EXECUTABLE_FORT_MEMORY` **granted=false**（没授予也照样 JIT）；
   - 启动 `BOOT_70_HTTP_READY` ≈ 7.4s（jitless 同机 ≈ 8.3s）。
2. **系统重启后（关键反例）**：
   - ArkTS 外壳能起：18:47:03 ACL 探针成功写盘（`acl-jit-probe.json`）；
   - **Host 毫无痕迹**：`dshm-host.log` 无 `runProfile`、`node-output.log` 无 boot 行、`diag-web-load` 无页面就绪；
   - 现象 = 白屏闪崩（进程级崩溃）；
   - 同签名的 **jitless** 包重启后完全正常（`jitless=true`、页面 200）。
3. **中间态证据**：重启前多次手动重启应用，JIT 一直正常（`diag-web-load` 15:43–17:02 多次「页面已就绪（200）」）。

## 二、结论（D-010）

- **调试签名/开发域对可执行内存的放行是"本次开机周期内"的临时许可**（由安装/调试会话建立），**重启即失效**；
- 因此"debug 域 = 白拿 JIT"不成立；ACL 受限权限/调试 Profile 的流程是必要的（正式发布仍受政策约束）；
- 日常唯一稳定形态：**jitless**（`buildHostArgv` 恒带 `--jitless`，恢复 D-009 之前的行为）；
- 本次实验包已归档，不再作为日常候选。

## 三、保留的 ACL 自证探针（与 JIT 无关，仍有价值）

- `entry/src/main/ets/runtime/AclProbe.ets`：`EntryAbility.onCreate` 里调
  `abilityAccessCtrl.checkAccessToken(tokenId, 'ohos.permission.kernel.ALLOW_EXECUTABLE_FORT_MEMORY')`；
- 结果写 `<files>/dsh/home/acl-jit-probe.json`，Host 的 `runtimeFacts()` 读回并写进
  `host-ready.json.runtime.aclJitExecMem`（`{permission, granted, tokenId, note, at}`）；
- 作用：以后任何"某权限到底有没有授予"的问题都有一手读数，不用靠现象反推。
- 当前签名是 DevEco 自动调试证书（不含 JIT ACL），**预期且实测 `granted=false`**。

## 四、相关产物与回退

| 产物 | 说明 |
|---|---|
| `whale-rc.2-jitless-aclprobe-signed.hap` | 本轮回退后构建：**默认 jitless** + ACL 探针（336,917,827 B） |
| `whale-rc.2-jit-expA-signed.hap` / `whale-rc.2-jit-official-signed.hap` / `whale-rc.2-jit-probe2-signed.hap` | 实验包（已归档，勿日常使用） |
| `whale-rc.2-restore-before-jit.hap`（`584267f2…`） | 最初的 jitless 回退包 |
