/**
 * 系统字体桥（一次性探针 2026-10-29，验证后并入正式实现）
 *
 * 目的：Office→PDF 转换需要中文字体。**不随 HAP 带字体**（体积 + 许可），改成从系统取：
 *   ① 用 ArkUI 官方 API `UIContext.getFont().getFontByName(name)` 拿系统字体的**真实路径**
 *      （`@ohos.font` 的 `FontInfo.path`）；
 *   ② 把它**复制**到 `<filesDir>/office2pdf-fonts/`（单个文件，避免 office2pdf 扫整个
 *      `/system/fonts`（263 字体 / 497 MB）带来的 +1.5s 开销，见评估报告 §7.3）；
 *   ③ 写 `<filesDir>/office2pdf-fonts.json` 给 Host 读（Host 与 ArkTS 同进程、同一权限域，
 *      但 Host 走 Node fs，所以只认**真实文件路径**，不认资源系统）。
 *
 * 失败一律非致命：拿不到字体就写一份带 error 的 JSON，Host 侧按"无字体"跑（中文会变豆腐块，
 * 但不影响应用启动）。
 */
import { font, Font, UIContext } from '@kit.ArkUI';
import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG: string = 'OFFICE2PDF-FONT';

/**
 * 候选系统字体名 —— **顺序很重要**。
 *
 * office2pdf 对 docx 的字体替换链是写死的（`render/font_subst.rs`）：
 *   · 宋体 / 宋體 → `["SimSun", "Noto Serif CJK SC", "Songti SC", "STSong"]`
 *   · 微软雅黑     → `["Microsoft YaHei", "Noto Sans CJK SC", …]`
 * **只有名字落在链里的字体，行高（top-edge/bottom-edge）才算得对**；
 * 名字不在链里时 typst 退回通用度量，中文会**上下行重叠**（2026-10-29 实测：
 * 用 HarmonyOS Sans SC 时那篇 docx 整页行叠行）。
 * ⇒ 优先取 `Noto Serif CJK SC`（对宋体）与 `Noto Sans CJK SC`（对雅黑），两者系统自带且 OFL。
 * HarmonyOS Sans 放到最后仅作兜底（它会叠行，只在 Noto 都没有时用）。
 */
const CANDIDATES: string[] = [
  'Noto Serif CJK SC',
  'Noto Sans CJK SC',
  'HarmonyOS Sans SC',
  'HarmonyOS Sans',
  'Source Han Sans SC',
  'Source Han Serif SC',
];

export interface FontBridgeResult {
  ok: boolean;
  /** 命中的系统字体名 */
  fontName: string;
  /** 系统字体真实路径 */
  systemPath: string;
  /** 复制到应用目录后的路径（Host 用这个目录） */
  appDir: string;
  /** 复制出的字体文件名 */
  appFile: string;
  size: number;
  error: string;
  at: string;
}

/** 从 UIContext 取 Font 对象；取不到返回 null。 */
function uicontextFont(ui: UIContext): Font | null {
  try {
    return ui.getFont();
  } catch (e) {
    return null;
  }
}

/**
 * 跑一次字体桥：找系统字体 → 复制到 filesDir/office2pdf-fonts → 写 JSON。
 * @param filesDir 应用 files 目录
 * @param ui UIContext（`windowStage.getMainWindowSync().getUIContext()`）
 */
/**
 * 系统里**确定存在**的 CJK 字体文件（路径来自本机实测，见 Eva-Research 的 docs/05）：
 *   · NotoSerifCJK-Regular.ttc → 家族 `Noto Serif CJK SC`（office2pdf 的**宋体**替换目标）
 *   · NotoSansCJK-Regular.ttc  → 家族 `Noto Sans CJK SC`（office2pdf 的**微软雅黑**替换目标）
 *
 * 【为什么不用 getFontByName】2026-10-29 实测：`UIContext.getFont().getFontByName('Noto Serif CJK SC')`
 * 查不到这两个字体族（返回空/抛错，只有 `HarmonyOS Sans SC` 能查到），于是字体桥退回到
 * HarmonyOS Sans —— 而它**不在 office2pdf 的替换链里**，行高按通用度量算 ⇒ 中文上下行重叠。
 * 直接按路径复制最确定：两个文件在 `/system/fonts` 下且应用域可读（同一进程、同权限域）。
 */
const DIRECT_FONT_PATHS: string[] = [
  '/system/fonts/NotoSerifCJK-Regular.ttc',
  '/system/fonts/NotoSansCJK-Regular.ttc',
];

export function setupOffice2pdfFont(filesDir: string, ui: UIContext): FontBridgeResult {
  const at: string = new Date().toISOString();
  const appDir: string = `${filesDir}/office2pdf-fonts`;
  const result: FontBridgeResult = {
    ok: false, fontName: '', systemPath: '', appDir: appDir,
    appFile: '', size: 0, error: '', at: at,
  };
  try {
    // ① 优先直连已知路径（确定性最高，见 DIRECT_FONT_PATHS 注释）
    const direct: string[] = [];
    for (const candidate of DIRECT_FONT_PATHS) {
      try {
        if (fs.statSync(candidate).size > 0) {
          direct.push(candidate);
        }
      } catch (e) {
        // 该路径不存在：跳过
      }
    }
    if (direct.length > 0) {
      hilog.info(DOMAIN, TAG, '直连字体命中 %{public}d 个（优先于 getFontByName）', direct.length);
    }
    // getFontByName 只作为直连失败时的兜底（它查不到 Noto CJK，见上文注释）
    const fontMgr: Font | null = direct.length > 0 ? null : uicontextFont(ui);
    if (fontMgr === null && direct.length === 0) {
      result.error = 'UIContext.getFont() 不可用且直连字体路径都不存在';
    } else {
      // 收集**所有命中**（最多 3 个）：衬线与无衬线各一份，才能同时喂饱
      // 宋体链（Noto Serif CJK SC）与雅黑链（Noto Sans CJK SC）。
      const picked: string[] = [];
      for (const directPath of direct) {
        picked.push(directPath);
        if (result.systemPath.length === 0) {
          result.fontName = 'direct';
          result.systemPath = directPath;
        }
        hilog.info(DOMAIN, TAG, '直连系统字体 → %{public}s', directPath);
      }
      for (const name of CANDIDATES) {
        if (fontMgr === null || picked.length >= 3) {
          break;
        }
        try {
          const info: font.FontInfo = fontMgr.getFontByName(name);
          if (info !== null && info.path !== null && info.path.length > 0 && picked.indexOf(info.path) < 0) {
            picked.push(info.path);
            if (result.systemPath.length === 0) {
              result.fontName = name;
              result.systemPath = info.path;
            }
            hilog.info(DOMAIN, TAG, '命中系统字体 %{public}s → %{public}s', name, info.path);
          }
        } catch (e) {
          // 该名字不存在：继续试下一个
        }
      }
      if (picked.length === 0) {
        result.error = '候选系统字体都未命中：' + CANDIDATES.join('/');
      } else {
        // 复制到应用目录（幂等：已存在且大小一致就跳过）
        try {
          fs.mkdirSync(appDir, true);
        } catch (e) {
          // 目录已存在：忽略
        }
        const names: string[] = [];
        for (const src of picked) {
          const baseName: string = src.substring(src.lastIndexOf('/') + 1);
          const dest: string = `${appDir}/${baseName}`;
          names.push(baseName);
          const srcSize: number = fs.statSync(src).size;
          let needCopy: boolean = true;
          try {
            const existSize: number = fs.statSync(dest).size;
            if (existSize === srcSize) {
              needCopy = false;
            }
          } catch (e) {
            // 目标不存在：需要复制
          }
          if (needCopy) {
            fs.copyFileSync(src, dest);
            hilog.info(DOMAIN, TAG, '已复制字体 %{public}d 字节 → %{public}s', srcSize, dest);
          } else {
            hilog.info(DOMAIN, TAG, '字体已在应用目录，跳过复制：%{public}s', dest);
          }
          result.size += fs.statSync(dest).size;
        }
        result.appFile = names.join(',');
        result.ok = true;
      }
    }
  } catch (e) {
    result.error = '字体桥异常：' + String(e);
    hilog.error(DOMAIN, TAG, '字体桥异常：%{public}s', String(e));
  }
  // 写 JSON 给 Host（Host 只认文件路径）
  try {
    const f = fs.openSync(`${filesDir}/office2pdf-fonts.json`,
      fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.WRITE_ONLY);
    fs.writeSync(f.fd, JSON.stringify(result, null, 2) + '\n');
    fs.closeSync(f);
  } catch (e) {
    hilog.warn(DOMAIN, TAG, '写字体 JSON 失败：%{public}s', String(e));
  }
  hilog.info(DOMAIN, TAG, '字体桥完成：ok=%{public}s error=%{public}s',
    String(result.ok), result.error);
  return result;
}
