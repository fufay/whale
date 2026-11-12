# 语音能力规划：用 Core Speech Kit 补全（ASR 主线 + 可选 TTS）

| 项 | 内容 |
|---|---|
| 日期 | 2026-11-12 |
| 状态 | **规划稿（未实施）** |
| 目标 | ASR 主线切到系统 Core Speech Kit（离线/中文），去掉 SenseVoice 与 230 MB 模型下载；解决长语音；可选 TTS |
| 关联 | `entry/src/main/ets/speech/HmsSpeechBridge.ets`、`SenseVoiceRecognizer.ets`、`hostcore/speech-provider/index.js`、`hostcore/speech-models/index.js`、`tools/pack-core.mjs`（`patchSensevoiceForHms`） |

## 1. 现状（代码实测，不是"没接"）

```
WebView 麦克风按钮
  → MediaRecorder 录音 + 重采样 16k → canonical WAV → base64
  → RPC `speech/transcribe`
  → host 侧 hostcore/speech-provider/index.js（写文件队列）
  → $DSH_HOME/speech-to-text/hms-bridge/<id>.req
  → ArkTS entry/src/main/ets/speech/HmsSpeechBridge.ets
       ├── 优先 SenseVoice（sherpa-onnx HAR + 首次下载 230 MB 模型）
       └── 回退 Core Speech Kit（@kit.CoreSpeechKit 的 speechRecognizer）
  → <id>.done → 文本回填输入框草稿
```

关键事实：
- **Core Speech Kit 已经接线**（`speechRecognizer.createEngine/startListening/writeAudio/finish` 已实现于 `HmsSpeechBridge.ets`），但只当兜底；
- 兜底不可用于长语音：真机实测**单会话只吃 ~4–5s，≥6s 近乎全灭**（VAD 截断）；试验过 `recognizerMode:'long'`，结果 `onEvent` 一条都没有（引擎 VAD 不动）⇒ 已回退，改为 SenseVoice 优先；
- SenseVoice 代价：HAP 内 `libonnxruntime.so` 12.9 MB + `libsherpa_onnx*.so` 3.7 MB + 0.7 MB ≈ **17.4 MB**，core 包内 sensevoice 包 7.8 MB；**首次使用需联网下载 230 MB 模型**到 `$DSH_HOME/speech-to-text/sensevoice`。

**结论**：真正要补的是「Speech Kit 能覆盖长语音」+「删掉 SenseVoice/230 MB 依赖」，而不是从零接入。

## 2. 目标

1. ASR **主线 = Core Speech Kit**（离线、免费、中文普通话；系统维护），去除模型下载；
2. 长语音可用（≥60 s，理想覆盖到长段落）；
3. 包体收益：HAP −17.4 MB、core −7.8 MB、不再首次下载 230 MB；
4. 可选：TTS（`textToSpeech`，≤10000 字符，中文/英文）。

## 3. 方案对比

| 方案 | 说明 | 结论 |
|---|---|---|
| **C1 端侧 Core Speech Kit** | `@kit.CoreSpeechKit`：ASR 短语音 ≤60 s / 长语音 ≤8 h，离线；TTS ≤10000 字符 | **推荐**；风险=HarmonyOS PC/2in1 是否支持待探测（文档只写"手机/平板等设备"） |
| C2 云侧 Speech Kit | AGC appId/secret + 网络；`Speech Kit`（场景化：朗读控件/AI 字幕）或云 ASR | 保底：仅在 C1 探测失败且必须有语音时考虑（隐私/网络/凭据成本） |
| C3 维持 SenseVoice | 现状 | 不满足"补全"，且 230 MB 下载 + 17 MB 原生库 |

## 4. 关键技术问题与解法

1. **长语音截断（核心难点）**
   - 路线 a：把 `long` 模式用对——读 `@hms.ai.speechRecognizer.d.ts` 全文，确认 `recognizerMode` / `maxAudioDuration` / `vadBegin`/`vadEnd` 等参数组合与"先 onStart 后 writeAudio"的配合；文档明确长语音 ≤8 h 存在，之前失败可能是参数组合/事件顺序问题；
   - 路线 b（保底）：**客户端分段**——按静音把 PCM 切成 ≤5 s 段，逐段识别，`mergeTranscript`（已有）合并；代价是多次往返与断句边界。
2. **引擎生命周期**：`createEngine` 实例数有限（注释已记），保持单例 + 会话互斥（现有 mutex 保留）。
3. **音频格式**：Speech Kit 要求 16 kHz/单声道/PCM；现有链路已是，保留 `slicePcmChunks` 的 640/1280 B 约束。
4. **权限与能力探测**：`ohos.permission.MICROPHONE` 已有；用 `canIUse('SystemCapability.AI.SpeechRecognizer')` + `createEngine` 错误码判定 PC 可用性。
5. **AEC/降噪补丁**：Speech Kit 只负责"文本化"，录音仍在 WebView（`getUserMedia`）⇒ `patchVoiceInputNoiseSuppression`（AEC/降噪关闭）**仍需要**，不能随手删。

## 5. 分阶段实施（含文件级清单）

### M0 能力探测（0.5 天，先做）
- 在 `HmsSpeechBridge.ets` 加一次性诊断（或临时页面按钮）：`canIUse` + `createEngine` + 2–3 s PCM 识别 + 打印错误码；
- 真机（HarmonyOS PC）跑一次，判定 C1 是否可用、`short`/`long` 各自行为；
- **决策门**：C1 可用 → 走 M1；不可用 → C2 或维持现状。

### M1 Speech Kit 为主线 + 长语音（1–2 天）
- `entry/src/main/ets/speech/HmsSpeechBridge.ets`：去掉"SenseVoice 优先"，改为 Speech Kit 主线；实现路线 a 或 b；保留文件队列协议与 `-asr` 诊断日志；
- `hostcore/speech-provider/index.js`：删模型下载/`SenseVoice` 分支，仅保留 WAV→队列、超时与错误映射；
- 门禁：新增 `assert-speech-wiring.mjs`（断言 Speech Kit 引擎调用存在、无 `SenseVoiceRecognizer` import、无模型下载 URL、`mergeTranscript`/chunk 约束保留）。

### M2 清理与瘦身（0.5–1 天）
- 删 `entry/src/main/ets/speech/SenseVoiceRecognizer.ets`、`entry/oh-package.json5` 的 `sherpa_onnx` HAR 依赖、`third_party/sherpa_onnx-1.13.3.har`；
- 删 `entry/libs/arm64-v8a/libonnxruntime.so`、`libsherpa_onnx*.so`（−17.4 MB）；
- 删 `hostcore/speech-models/`、`tools/pack-core.mjs` 的 `patchSensevoiceForHms()`（连同 hms-provider/speech-models 拷贝）；
- `check-native-closure` / `assert-core-entrypoints` / 补丁门禁同步。

### M3 可选 TTS（0.5–1 天，需 UI 决策）
- `textToSpeech.createEngine` + 朗读入口（先做"朗读当前回复"最省 UI 改动）；
- 中文/英文音色：聆小珊/劳拉/凌飞哲；需确认 PC 是否同样支持。

### M4 验证与发布（0.5 天）
- 门禁全绿 → `tools/build-verify-hap.sh` 装机（同 versionCode）→ 真机冒烟（3 s/10 s/30 s 中文、长段落、无网、连续识别、断网恢复）；
- 发布件 `v1.1.9 / 1010009`（按 AGENTS「发布件/本机验证件」规则自动递增）。

## 6. 验收标准

- 语音按钮可用：短句（3 s）/长句（30 s）/长段落（≥60 s）中文识别正确，**无模型下载、无网可用**；
- HAP −17.4 MB、core −7.8 MB；`$DSH_HOME/speech-to-text` 不再生成模型目录；
- 门禁全绿（含新语音门禁）；真机冒烟通过；`docs/135`/`HANDOFF` 更新。

## 7. 风险

- **PC/2in1 不支持 Core Speech Kit**（M0 决定）；保底 C2 或维持现状；
- `long` 模式仍不可用 → 走分段（多一次往返、断句边界）；
- 仅中文普通话（中文语境英文可），英文场景弱；TTS 音色 PC 支持未知；
- 删除 SenseVoice 后若想回退，需要恢复 HAR/原生库/补丁（工作量≈本方案 M1+M2）。

## 8. 待确认

1. 是否接受"若 `long` 不可用则分段"的保底；
2. 是否要 TTS；要的话入口放哪（朗读当前回复 / 设置开关 / 消息工具栏）；
3. 是否同意删除 SenseVoice / onnx / sherpa（体积收益 17.4 MB + 7.8 MB，行为替换）；
4. M0 探测是否现在就跑（只需装一次包 + 点一次按钮，产出错误码/日志）。
