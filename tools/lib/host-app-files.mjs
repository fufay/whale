/*
 * Host 入口脚本清单（**唯一真源**）：随 HAP 放进 `entry/src/main/resources/resfile/resources/app/` 的文件。
 *
 * 【为什么抽成单独模块】这份清单原本在 `tools/place-host-app.mjs` 与 `tools/assert-resfile-sync.mjs`
 * 各抄一份（后者注释写着"新增文件两处一起改"）。2026-11-04 加 `dshm-hdc-bridge.js` 时正好验证了
 * 这个隐患的反面：门禁清单没跟着改 ⇒ 新文件可以被静默漏拷/漏检。改成单一清单后两处不可能漂移。
 */
export const HOST_APP_FILES = [
  'main.js',
  'tar-gz.cjs',
  'jitless-env.cjs',
  'worker-bootstrap.cjs',
  'fetch-shim.js',
  'undici-shim.mjs',
  'undici-loader.mjs',
  'require-builtin-shim.cjs',
  'internal-undici-shim.cjs',
  'dshm-installer.js',
  'dshm-user-rows.js',
  'dshm-yaml-check.js',
  'dshm-profile-check.js',
  'dshm-skills.js',
  'dshm-compat.js',
  'dshm-restore.js',
  'dshm-hdc-bridge.js',
  'hdc-bridge-assets.js',
];
