# Whale 品牌资源

本目录的图片**全部由脚本生成**，不要手工替换。

## 生成方式

| 脚本 | 产出 | 说明 |
|---|---|---|
| `tools/make-whale-icon.mjs` | `AppScope/` 与 `entry/` 的 `foreground.png` / `background.png`（1024 分层图标）、`docs/brand/whale-icon.png`（512 展示图）、`docs/brand/whale-mark.png`（256 透明底标记） | 主体为用户提供的角色插画 `Common/assets/whale.png`（白底 691×691）；需要 `sharp`（`NODE_PATH` 指向含 sharp 的 node_modules） |
| `tools/make-whale-splash.py` | `entry/src/main/resources/base/media/logo_dark.png`（应用内启动页标识，底 `#F3F7FB`）与 `startIcon.png`（系统启动窗口图标，白底） | **纯标准库**实现（本机沙箱没有可用的 sharp）：解 PNG → 去白边 → 双线性缩放 → 合成到纯色底 |
| `tools/make-tray-icon.py` | `Common/assets/tray/tray_{white,black}.svg`（实心版，**托盘 + 顶栏**用）、`tray_line_{white,black}.svg`（线稿版）、`preview_*.png`（深/浅底预览）；`--place` 时另写 `entry/src/main/resources/rawfile/tray_{white,black}.svg` 与 `entry/src/main/resources/base/media/whale_mark.svg` | 从 `Common/assets/icon.png`（角色头像，718×587）**单色化 + 方形裁切满版 + potrace 矢量化**；需要 potrace 的 JS 端口（一次性 `npm i potrace`，用 `POTRACE_MODULE` 指定；本机没有 potrace/autotrace/ImageMagick） |

## 本目录文件

| 文件 | 用途 |
|---|---|
| `whale-icon.png` | README / 展示图（白底合成，512） |
| `whale-mark.png` | 纯标记（透明底，256） |
| `whale-source.png` | 角色插画原件（存档，691×691） |
| `dshm-icon.png` / `dshm-mark.png` | **DSHM 原品牌素材：保留作历史对照，Whale 不再使用** |

## 设计口径

- **应用图标**：白色底 + 居中角色插画（内容约占画布 76%，落在鸿蒙分层图标安全区内，系统视差不会裁到主体）；前景层透明、背景层纯白，`AppScope/` 与 `entry/` **必须完全一致**，否则不同入口显示不同图标。
- **启动页标识**：角色插画铺在 `#F3F7FB`（与启动页 Column 背景色同值）上 ⇒ 与背景无缝，不出现白方块；系统启动窗口图标用纯白底。
- **托盘图标 / 顶栏标识**：同一枚**单色剪影**（角色头像，实心版）。托盘要黑/白两份（`rawfile/tray_{white,black}.svg`，系统按状态栏明暗二选一）；顶栏用 `media/whale_mark.svg` + `Image.fillColor` 整体重着色（等价 `currentColor`）。
  - **按宽度满版、绝不裁左右**：鲸鱼娘的**鱼鳍耳朵**长在头像左右边缘（原图 x 直达 0 与 718），方形裁切会把耳朵切掉（2026-10-17 用户实测指出）。⇒ 托盘在方形槽位里按宽度满版（0.98）、垂直居中；顶栏用内容真实比例 480×390（`FishMark` 高度按 `WHALE_MARK_VIEWBOX_H/W` 推出）。
- **历史素材**：DSHM 时期的「官方鲸鱼 path + HM/OS 角标」素材与生成脚本（`tools/gen-fish-logo.mjs`、`tools/make-icon.py`）保留在仓库中作历史，Whale **不再使用**（顶栏鲸鱼 `fish_logo.svg` 亦被 `whale_mark.svg` 取代，文件保留）。
