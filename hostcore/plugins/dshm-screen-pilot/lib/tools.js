// 模型工具注册：把截图/窗口/UI树/注入能力以 ctx.tools 注册暴露给模型。
import { mkdirSync } from 'node:fs';
import { capture, listWindows, screenSize } from './screen.js';
import { dumpLayout, findElements } from './layout.js';
import { click, swipe, key, typeText } from './input.js';

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function jsonRender(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}


/** 把 {key: {type,... , required:true}} 的参数映射转成 DSH raw register 要求的完整 object schema：
 *  {type:'object', properties:{...}, required:[...]}（required 提升到对象级）。 */
function objectSchema(props) {
  const required = [];
  const properties = {};
  for (const [k, v] of Object.entries(props)) {
    const { required: req, ...rest } = v;
    if (req === true) required.push(k);
    properties[k] = rest;
  }
  return required.length
    ? { type: 'object', properties, required }
    : { type: 'object', properties };
}

/** 注册全部工具；返回注销函数数组。 */
export function registerTools(toolsSvc, config = {}) {
  const saveDir = config.saveDir;
  ensureDir(saveDir);
  const disposers = [];
  const register = (def) => {
    disposers.push(toolsSvc.register(def));
  };

  register({
    name: 'screen_capture',
    description:
      '截取本机真实屏幕并保存为 PNG 文件。三种模式：默认整屏；传 window（窗口名子串或 WinId，用 screen_windows 查）截取指定窗口；传 region [x,y,w,h] 截取矩形区域。返回文件路径与尺寸。',
    parameters: objectSchema({
      window: {
        type: 'string',
        description: '窗口名子串（如 "dshclient"）或 WinId（纯数字字符串）；缺省=整屏截图',
      },
      region: {
        type: 'array',
        items: { type: 'number' },
        description: '矩形区域 [x, y, width, height]；缺省=整屏截图',
      },
      outPath: {
        type: 'string',
        description: '输出文件名（相对 saveDir）或绝对路径；缺省自动命名 capture_<时间戳>.png',
      },
      displayId: { type: 'number', description: '显示器 id；本机仅 0，一般省略' },
    }),
    output: {
      schema: { description: '{path, width, height, bytes, mode}' },
      render: jsonRender,
    },
    async execute(args) {
      return capture({ ...args, saveDir });
    },
  });

  register({
    name: 'screen_windows',
    description:
      '列出本机全部窗口（含系统层），含 WinId、进程 pid、z 序、是否焦点、窗口边界 [x,y,w,h]。用于选择截图目标或判断当前前台应用。',
    parameters: objectSchema({}),
    output: {
      schema: { description: '{windows:[{name,winId,pid,zord,x,y,w,h,...}], focus: WinId}' },
      render: jsonRender,
    },
    async execute() {
      return listWindows();
    },
  });

  register({
    name: 'screen_size',
    description: '返回本机屏幕分辨率（宽 x 高）与显示器 id。',
    parameters: objectSchema({}),
    output: {
      schema: { description: '{width, height, displayId}' },
      render: jsonRender,
    },
    async execute() {
      return screenSize();
    },
  });

  register({
    name: 'ui_dump',
    description:
      '导出当前屏幕的 UI 无障碍树（uitest dumpLayout）并解析：返回窗口列表与所有带文本的元素（text + 坐标边界 + 中心点），供定位"应用内的某项功能"后点击。结果缓存在内存，可用 ui_find 检索。',
    parameters: objectSchema({
      merged: {
        type: 'boolean',
        description: 'true=合并多窗口（默认）；false=按窗口分列（含 bundleName）',
      },
      maxTexts: {
        type: 'number',
        description: '返回的最多文本元素数；缺省 200，0=不限制',
      },
      saveTo: {
        type: 'string',
        description: '布局 JSON 的保存路径（绝对路径）；缺省存 saveDir',
      },
    }),
    output: {
      schema: {
        description: '{path, windows:[{bundleName,abilityName,bounds}], elements:[{text,bounds,center,clickable}], elementCount}',
      },
      render: jsonRender,
    },
    async execute(args) {
      const r = dumpLayout({ merged: args.merged !== false, saveTo: args.saveTo, saveDir });
      const max = args.maxTexts ?? 200;
      const texts = max > 0 ? r.elements.slice(0, max) : r.elements;
      return {
        path: r.path,
        windowCount: r.windows.length,
        windows: r.windows,
        elementCount: r.elements.length,
        texts: texts.map((e) => ({
          text: e.text,
          bounds: e.bounds,
          center: e.center,
          clickable: e.clickable,
        })),
      };
    },
  });

  register({
    name: 'ui_find',
    description:
      '在最近一次 ui_dump 的 UI 树中按文本子串检索元素，返回坐标（含中心点）供 ui_click 使用。未 dump 过或 refresh=true 时自动重新 dump。',
    parameters: objectSchema({
      text: { type: 'string', required: true, description: '要查找的文本子串（如按钮/菜单名）' },
      limit: { type: 'number', description: '最多返回条数，缺省 10' },
      refresh: { type: 'boolean', description: 'true=强制重新 dump 布局后再检索' },
    }),
    output: {
      schema: { description: '[{text, bounds:{x0,y0,x1,y1}, center:{x,y}, clickable}]' },
      render: jsonRender,
    },
    async execute(args) {
      return findElements(args.text, { limit: args.limit ?? 10, refresh: !!args.refresh, saveDir });
    },
  });

  register({
    name: 'ui_click',
    description:
      '在真实屏幕上点击指定坐标（uitest uiInput）。count=2 双击；holdMs>0 变长按。⚠ 这是真实鼠标点击，会作用于当前前台窗口，请先用 ui_find/ui_dump 确认目标坐标。',
    parameters: objectSchema({
      x: { type: 'number', required: true, description: '屏幕 X 坐标' },
      y: { type: 'number', required: true, description: '屏幕 Y 坐标' },
      count: { type: 'number', enum: [1, 2], description: '1=单击（默认），2=双击' },
      holdMs: { type: 'number', description: '>0 时变长按（毫秒）' },
      displayId: { type: 'number', description: '显示器 id；本机仅 0' },
    }),
    output: {
      schema: { description: '{ok, action, x, y, output}' },
      render: jsonRender,
    },
    async execute(args) {
      return click(args.x, args.y, { count: args.count ?? 1, holdMs: args.holdMs ?? 0, displayId: args.displayId });
    },
  });

  register({
    name: 'ui_swipe',
    description:
      '在真实屏幕上从 from 坐标滑动到 to 坐标（触摸滑动/拖拽）。durationMs>0 走 drag（拖拽），否则 swipe。可用于滚动列表、拖拽窗口/图标。',
    parameters: objectSchema({
      from: { type: 'array', items: { type: 'number' }, required: true, description: '起点 [x, y]' },
      to: { type: 'array', items: { type: 'number' }, required: true, description: '终点 [x, y]' },
      velocity: { type: 'number', description: 'swipe 速度 200~40000，缺省 600' },
      durationMs: { type: 'number', description: '>0 时走 drag 并以毫秒为单位控制时长' },
      displayId: { type: 'number', description: '显示器 id；本机仅 0' },
    }),
    output: {
      schema: { description: '{ok, action, from, to, output}' },
      render: jsonRender,
    },
    async execute(args) {
      return swipe(args.from, args.to, {
        velocity: args.velocity,
        durationMs: args.durationMs ?? 0,
        displayId: args.displayId,
      });
    },
  });

  register({
    name: 'ui_key',
    description:
      '注入键盘按键：key 为数字 keyID（OpenHarmony KeyCode）或 "Back"/"Home"/"Power"；combo 传 2~3 个 keyID 模拟组合键（如 Ctrl+A）。注意：PC 形态下 Home/Back 可能无效。',
    parameters: objectSchema({
      key: { type: 'string', required: true, description: '按键 keyID（数字请传字符串形式）或 Back/Home/Power' },
      combo: {
        type: 'array',
        items: { type: 'string' },
        description: '组合键 keyID 数组（2~3 个，同时按下；数字请传字符串形式）',
      },
      displayId: { type: 'number', description: '显示器 id；本机仅 0' },
    }),
    output: {
      schema: { description: '{ok, action, key, combo, output}' },
      render: jsonRender,
    },
    async execute(args) {
      return key(args.key, { combo: args.combo || [], displayId: args.displayId });
    },
  });

  register({
    name: 'ui_type',
    description:
      '注入文本：给 x,y 时先点击该坐标再输入（适合输入框）；不给坐标则在当前焦点处输入。⚠ 文本经过系统输入法：拼音输入法激活时英文字符可能被转换为中文候选，需按需确认。',
    parameters: objectSchema({
      text: { type: 'string', required: true, description: '要输入的文本' },
      x: { type: 'number', description: '目标输入框 X 坐标（与 y 同时给出）' },
      y: { type: 'number', description: '目标输入框 Y 坐标（与 x 同时给出）' },
      displayId: { type: 'number', description: '显示器 id；本机仅 0' },
    }),
    output: {
      schema: { description: '{ok, action, text, output}' },
      render: jsonRender,
    },
    async execute(args) {
      return typeText(args.text, { x: args.x, y: args.y, displayId: args.displayId });
    },
  });

  return disposers;
}
