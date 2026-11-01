// office2pdf 的 NAPI 外壳（一次性探针 2026-10-29，验证后删除）
//
// 背景（重要，别再踩）：
//   CMakeLists.txt 顶部那条实测结论——**手工拷进 entry/libs/ 的 .so 不会被 ArkTS 实例化**：
//   运行时会 dlopen、构造器会执行，但 `napi_module_register` 注册的模块**永远不会被实例化**
//   （Init 不被调用）⇒ ArkTS 侧 `import` 拿到的是 undefined。所以：
//     · 本外壳必须由 hvigor/CMake 构建（走 add_library），映射才成立；
//     · Rust 侧的 office2pdf 编成纯 C ABI 的 cdylib（liboffice2pdf_capi.so），
//       由本外壳**运行时 dlopen** 加载并 dlsym 调用。
//
// 为什么 Rust 不走 NAPI：实测 napi-rs 用 `napi_register_module_v1`（Node 风格）注册时
//   ArkTS 解析不到（日志 `default/office2pdf_napi != net.socket`）。改用 C ABI + C++ 外壳最稳。
//
// 导出：version() / convert(input, output, fontPath?) —— 与 liboffice2pdf_napi.d.ts 保持一致。

#include <node_api.h>

#include <dlfcn.h>

#include <cstdint>
#include <cstring>
#include <string>

namespace {

/** Rust cdylib 的 C ABI 签名（与 office2pdf-capi/src/lib.rs 对应）。 */
using ConvertFn = int64_t (*)(const char*, const char*, const char*, char*, size_t);
using VersionFn = const char* (*)();

/** 缓存 dlopen 的句柄与函数指针，避免每次调用都查。 */
struct O2pLib {
  void* handle = nullptr;
  ConvertFn convert = nullptr;
  VersionFn version = nullptr;
  std::string error;
};

/** 候选路径：先 libs 目录（随 HAP 打包），再应用 files 目录（调试时手工放置）。 */
const char* kLibName = "liboffice2pdf_capi.so";

O2pLib& o2p() {
  static O2pLib lib;
  static bool tried = false;
  if (tried) return lib;
  tried = true;
  // RTLD_NOW：立刻解析全部符号，失败能拿到明确错误。
  void* h = dlopen(kLibName, RTLD_NOW);
  if (h == nullptr) {
    const char* err = dlerror();
    lib.error = std::string("dlopen 失败：") + (err == nullptr ? "(unknown)" : err);
    return lib;
  }
  auto conv = reinterpret_cast<ConvertFn>(dlsym(h, "office2pdf_convert"));
  auto ver = reinterpret_cast<VersionFn>(dlsym(h, "office2pdf_version"));
  if (conv == nullptr || ver == nullptr) {
    const char* err = dlerror();
    lib.error = std::string("dlsym 失败：") + (err == nullptr ? "(unknown)" : err);
    dlclose(h);
    return lib;
  }
  lib.handle = h;
  lib.convert = conv;
  lib.version = ver;
  return lib;
}

/** 取 napi string 参数；失败返回 false。 */
bool getStr(napi_env env, napi_value value, std::string& out) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &len) != napi_ok) return false;
  std::string buf(len + 1, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, &buf[0], len + 1, &copied) != napi_ok) return false;
  buf.resize(copied);
  out = buf;
  return true;
}

/** 创建一个 napi string。 */
napi_value makeStr(napi_env env, const std::string& s) {
  napi_value out = nullptr;
  napi_create_string_utf8(env, s.c_str(), s.size(), &out);
  return out;
}

/** 抛一个 Error（带 message）。 */
napi_value throwError(napi_env env, const std::string& msg) {
  napi_throw_error(env, nullptr, msg.c_str());
  return nullptr;
}

/** version(): string —— 返回 Rust 库的版本串；库加载失败时返回错误串（不抛，便于探针排障）。 */
napi_value Version(napi_env env, napi_callback_info) {
  O2pLib& lib = o2p();
  if (lib.version == nullptr) return makeStr(env, "unavailable: " + lib.error);
  return makeStr(env, lib.version());
}

/**
 * convert(input, output, fontPath?) → number（写出的字节数；失败抛 Error）
 */
napi_value Convert(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3] = {nullptr, nullptr, nullptr};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) {
    return throwError(env, "napi_get_cb_info failed");
  }
  if (argc < 2) return throwError(env, "convert(input, output, fontPath?) requires 2 args");

  std::string input;
  std::string output;
  std::string fontPath;
  if (!getStr(env, argv[0], input)) return throwError(env, "input must be a string");
  if (!getStr(env, argv[1], output)) return throwError(env, "output must be a string");
  if (argc >= 3 && argv[2] != nullptr) {
    napi_valuetype t = napi_undefined;
    napi_typeof(env, argv[2], &t);
    if (t == napi_string) {
      if (!getStr(env, argv[2], fontPath)) return throwError(env, "fontPath must be a string");
    }
  }

  O2pLib& lib = o2p();
  if (lib.convert == nullptr) return throwError(env, "office2pdf 库不可用：" + lib.error);

  char errBuf[512] = {0};
  int64_t written = lib.convert(input.c_str(), output.c_str(),
                                fontPath.empty() ? nullptr : fontPath.c_str(),
                                errBuf, sizeof(errBuf));
  if (written < 0) {
    std::string msg = errBuf[0] == '\0' ? "convert failed" : std::string(errBuf);
    return throwError(env, msg);
  }
  napi_value out = nullptr;
  napi_create_int64(env, written, &out);
  return out;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
      {"version", nullptr, Version, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"convert", nullptr, Convert, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}

}  // namespace

/*
 * 【注册口径：走 Host（Node）侧，与内嵌 Python 桥一致】
 *
 * 探针阶段已经证明两件事（2026-10-29 真机，留档避免重复摸索）：
 *   ① ArkTS 侧 `import liboffice2pdf_ext.so` **可以**跑通 —— 前提是
 *      (a) 外壳由 hvigor/CMake 构建（手工拷进 entry/libs 的 .so 不会被实例化，
 *          见 CMakeLists 头注），(b) 用 OHOS 的 `napi/native_api.h` + `napi_module` 结构
 *          + `__attribute__((constructor))` 调 `napi_module_register`，
 *      (c) `.so` 必须 `DT_NEEDED libace_napi.z.so`，否则 `napi_*` 符号解析不到
 *          （实测 `relocating failed: symbol not found. s=napi_get_cb_info`）。
 *      探针读数：P1 import ok / P2 convert 32639 字节 / P3 `%PDF-1.7` + `%%EOF`。
 *
 *   ② **最终选 Host 侧**：插件（纯 JS）只能经 Host 触达转换能力，ArkTS 侧调用对插件不可见。
 *      于是改用与 `python_runner.cpp` 完全相同的口径：
 *        · 头文件 `<node_api.h>`（Node 的 N-API），
 *        · `NAPI_MODULE(office2pdf_ext, Init)` 展开出 `napi_register_module_v1` 导出，
 *        · 由 Host 的 `process.dlopen(mod, addon)` 加载（main.js 的 getPyBridge 同款）。
 *      注意：`napi/native_api.h` 里**没有** `NAPI_MODULE` 宏，所以必须用 node_api.h。
 *
 * 想回到 ①（ArkTS 直调）时：把 include 换回 `napi/native_api.h`，并恢复
 * `napi_module` + constructor 那段即可（本仓 git 历史里 `office2pdf_ext.cpp` 有原文）。
 */

// Host（Node/libnode）侧：process.dlopen() 认这个符号
NAPI_MODULE(office2pdf_ext, Init)
