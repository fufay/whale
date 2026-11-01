// tests/helpers/fake-shell.mjs —— 假设备 + 假 ctx.shell 接缝。
//
// 目的：在**没有设备**的情况下把 lib/tools.js 的完整链路跑通 ——
// 包括 ctx.shell 的真实形状（resolve/execute/result，以及流式 readOutput/kill/status/done）。
// 假设备自己维护"当前级别 + 缓冲区"，因此"设置后是否还原"是**可断言的设备状态**，
// 而不是只看返回值。

/** 默认的 Connected 目标列表（含 Offline 残留，模拟真机）。 */
export const DEFAULT_TARGETS = [
  '127.0.0.1:10178\t\tTCP\tOffline\tunknown...',
  '127.0.0.1:45071\t\tTCP\tConnected\tlocalhost',
  '127.0.0.1:34503\t\tTCP\tOffline\tunknown...',
].join('\n');

/** 真机样本行（附录 C + 2026-10-15 实测）。 */
export const SAMPLE_LINES = [
  '10-15 10:47:36.948  4051  4051 W A01B07/com.ohos.sceneboard/IMKG: [a92abe3ec8bd4bd 0 0]ImmersiveDataVm --> checkAutoScreenOn: true, false, false, false,isLowPowerMode= 0',
  '10-15 11:15:34.159 13646 13646 W C02805/com.tencent.wechat.pc/ClientMsgHandler: [K:D:606957|165]The client receives a key, Fd:134',
  '10-15 11:15:34.161  7443  7443 W C02D08/i.hmos.inputmethod:inputMethod/NAPI_HISYSEVENT_ADAPTER: failed to parse js function line number.',
  '10-15 11:15:34.311  1852  8431 W C01651/powermgr/call_reporter: Count: Call the threshold, func: Query, first:64143046ms, now:64210013ms, uri:******h_charging',
  '10-15 10:53:39.771 47645 47645 E C02C02/PARAM: Forbid to access parameter hilog.debug.on',
];

/**
 * 生成"时间戳=当下"的日志行（给 sinceNow 相关用例用：固定样本的时间戳是历史）。
 * @param n 条数；nowMs 基准时间；stepMs 每条之间的间隔
 */
export function freshLines(n = 3, { nowMs = Date.now(), stepMs = 10, tag = 'FreshTag', level = 'I', pid = 4321, domain = 'A0FFFF', pkg = 'com.demo.app' } = {}) {
  const pad = (v, w = 2) => String(v).padStart(w, '0');
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(nowMs + i * stepMs);
    const t = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    return `${t} ${String(pid).padStart(5)} ${String(pid).padStart(5)} ${level} ${domain}/${pkg}/${tag}: fresh line ${i}`;
  });
}

/** 走 via-host 时 shim 会插的噪声行（必须被过滤）。 */
export const SHIM_NOISE =
  '[hdc-tcp-shim] UDS /data/hdc/hdc_debug/hdc_server -> TCP 127.0.0.1:18710 (fd 10)';

/**
 * 造一个假设备。
 * @param opts.level       起始全局级别（默认 W）
 * @param opts.targets     `hdc list targets -v` 的输出（默认 DEFAULT_TARGETS）
 * @param opts.lines       `hilog -x` 返回的缓冲区行
 * @param opts.captureLines 流式抓取时按读取次数逐条吐出的行
 * @param opts.shimNoise   是否在输出里混入 shim 噪声行
 */
export function fakeDevice(opts = {}) {
  return {
    level: opts.level || 'W',
    targets: opts.targets === undefined ? DEFAULT_TARGETS : opts.targets,
    lines: opts.lines || SAMPLE_LINES,
    captureLines: opts.captureLines || SAMPLE_LINES,
    shimNoise: opts.shimNoise === true,
    calls: [],
    levelSets: [],
  };
}

/**
 * 假 ctx.shell：形状与 @deepseek-ai/dsh-bash-sandbox 暴露的接缝一致。
 * @param device   fakeDevice() 的产物
 * @param opts.onCommand  可选钩子（(command) => void | {throwError} ）
 */
export function fakeShell(device, opts = {}) {
  const shell = {
    resolve: (request) => ({ ...request }),
    async execute(spec) {
      const command = String(spec.command || '');
      device.calls.push(command);
      if (opts.onCommand) {
        const r = opts.onCommand(command);
        if (r && r.throwError) throw new Error(r.throwError);
      }
      const noise = device.shimNoise ? `${SHIM_NOISE}\n` : '';

      // hdc list targets -v
      if (/\blist\s+targets\b/.test(command)) {
        return settled({ exitCode: 0, stdout: `${noise}${device.targets}\n`, stderr: '' });
      }
      // date +%s（capture 用来精确校正"只看新日志"的下界）
      if (command.includes('date +%s')) {
        const skew = Number(opts.clockSkewMs || 0);
        return settled({ exitCode: 0, stdout: `${Math.floor((Date.now() + skew) / 1000)}\n`, stderr: '' });
      }
      // param get hilog.loggable.global
      if (command.includes('param get')) {
        return settled({ exitCode: 0, stdout: `${device.level} \n`, stderr: '' });
      }
      // hilog -b X
      const set = /hilog -b ([DIWEF])/.exec(command);
      if (set) {
        device.level = set[1];
        device.levelSets.push(set[1]);
        return settled({ exitCode: 0, stdout: `Set global log level to ${set[1]} successfully\n`, stderr: '' });
      }
      // hilog -x ...（非阻塞 dump）
      if (command.includes('hilog -x')) {
        if (opts.dumpStdout !== undefined) return settled({ exitCode: 0, stdout: opts.dumpStdout, stderr: opts.dumpStderr || '' });
        const wanted = /-T\s+'?([^'\s]+)'?/.exec(command);
        let lines = device.lines.slice();
        if (wanted) lines = lines.filter((l) => l.includes(wanted[1]));
        return settled({ exitCode: 0, stdout: `${noise}${lines.join('\n')}\n`, stderr: opts.dumpStderr || '' });
      }
      // timeout N hilog ...（流式抓取）
      if (command.includes('hilog')) {
        return streamHandle(device, spec, opts);
      }
      return settled({ exitCode: 0, stdout: `${noise}`, stderr: '' });
    },
  };
  return shell;
}

/** 一次成型的句柄（后台进程立即"跑完"）。 */
function settled({ exitCode, stdout, stderr }) {
  const result = {
    exitCode,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 0,
    stdout: { text: stdout, truncated: false },
    stderr: { text: stderr, truncated: false },
  };
  return {
    status: 'completed',
    exitCode,
    readOutput: () => ({ delta: '', lossy: false }),
    kill: () => false,
    done: Promise.resolve(),
    result: async () => result,
  };
}

/** 流式句柄：每次 readOutput() 吐一行（模拟"边跑边读"）。 */
function streamHandle(device, spec, opts = {}) {
  const pending = device.captureLines.slice();
  let killed = false;
  let settle;
  const done = new Promise((res) => { settle = res; });
  const handle = {
    status: 'running',
    exitCode: null,
    done,
    readOutput: () => {
      if (opts.readThrowsOnCall && opts.readThrowsOnCall === device._reads + 1) {
        device._reads += 1;
        throw new Error('readOutput 爆炸（测试用）');
      }
      device._reads = (device._reads || 0) + 1;
      if (opts.lossy) return { delta: '', lossy: true, stdoutSpillPath: '/tmp/spill.log' };
      if (killed) return { delta: '', lossy: false };
      const stderrLine = opts.stderrText !== undefined ? opts.stderrText : 'hdc: 测试用 stderr';
      if (pending.length === 0) {
        // 行吐完之后，按需再补一次 stderr（stderrMarker：常规 stderr；shimStderr 已在第一行带过）
        if (opts.stderrMarker && !device._stderrSent) {
          device._stderrSent = true;
          return { delta: `[stderr]\n${stderrLine}\n`, lossy: false };
        }
        return { delta: '', lossy: false };
      }
      const line = pending.shift();
      const prefix = device.shimNoise && device._reads === 1 ? `${SHIM_NOISE}\n` : '';
      const shimOnStderr = opts.shimStderr && device._reads === 1 ? `\n[stderr]\n${opts.shimStderr}\n` : '';
      const tail = opts.stderrMarker && pending.length === 0 && !device._stderrSent
        ? (device._stderrSent = true, `\n[stderr]\n${stderrLine}\n`)
        : '';
      return { delta: `${prefix}${line}\n${shimOnStderr}${tail}`, lossy: false };
    },
    kill: () => {
      killed = true;
      handle.status = 'killed';
      settle();
      return true;
    },
    result: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: device.captureLines.join('\n'), truncated: !!opts.lossy },
      stderr: { text: '', truncated: false },
    }),
  };
  // 没人 kill 的话，2 秒后自然"跑完"（模拟设备侧 timeout）
  setTimeout(() => { if (!killed) { handle.status = 'completed'; settle(); } }, opts.settleMs || 2000).unref?.();
  return handle;
}

/**
 * 假 cordis ctx：收集工具定义，并提供假的 shell 服务。
 * @returns {{ctx, tools: Map, setShell}}
 */
export function fakeCtx(shell) {
  const tools = new Map();
  let shellRef = shell || null;
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    tools: {
      register(def) {
        tools.set(def.name, def);
        return () => tools.delete(def.name);
      },
    },
    inject(deps, cb) {
      if (Array.isArray(deps) && deps.includes('shell') && shellRef) cb({ shell: shellRef });
      return () => {};
    },
  };
  return {
    ctx,
    tools,
    setShell(s) { shellRef = s; },
  };
}

/** 假的 exec/execStream（给 lib/hdc.js / lib/ops.js 的纯单测用）。 */
export function fakeExec(script = {}) {
  const calls = [];
  const exec = async (command, opts = {}) => {
    calls.push({ command, opts });
    const handler = exec.impl || script.onCommand;   // exec.impl 可在测试里临时覆盖
    if (handler) {
      const r = await handler(command, opts);
      if (r && r.throwError) throw new Error(r.throwError);
      if (r) return r;
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  exec.calls = calls;
  return exec;
}
