//! office2pdf 的 C ABI 导出层（配合 C++ NAPI 外壳 liboffice2pdf_ext.so 使用）。
//!
//! 为什么不做成 NAPI 模块：实测 napi-rs 用 `napi_register_module_v1`（Node 风格）注册时，
//! OHOS 的 ArkTS 侧解析不到（日志 `default/office2pdf_napi != net.socket`）。改用
//! **napi_module 结构 + constructor** 的写法（与本仓 `entry/src/main/cpp/probe.cpp` 一致）
//! 最稳，因此 Rust 只出一个干净的 C ABI，注册交给 C++ 外壳。
//!
//! 约定：所有字符串都是 UTF-8 C 字符串；返回 0 = 成功，非 0 = 失败（错误信息写入 out_err）。

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::path::Path;

/// 把一个文本指针转成 String；无效指针返回 None。
unsafe fn from_c(p: *const c_char) -> Option<String> {
    if p.is_null() {
        return None;
    }
    CStr::from_ptr(p).to_str().ok().map(|s| s.to_string())
}

/// 把错误写进调用方缓冲区（c_int 返回值仍表示失败）。
unsafe fn write_err(err_buf: *mut c_char, err_len: usize, msg: &str) {
    if err_buf.is_null() || err_len == 0 {
        return;
    }
    let bytes = msg.as_bytes();
    let n = bytes.len().min(err_len - 1);
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), err_buf as *mut u8, n);
    *err_buf.add(n) = 0;
}

/// C ABI：转换文档为 PDF。
/// @param input   输入文档路径（UTF-8）
/// @param output  输出 PDF 路径（UTF-8）
/// @param font_path 可选的中文字体目录；空指针/空串表示不给
/// @param out_err 错误缓冲区（可为空指针）
/// @param err_len 错误缓冲区长度
/// @return 写出的字节数（>0）| -1 = 失败（详情见 out_err）
#[no_mangle]
pub unsafe extern "C" fn office2pdf_convert(
    input: *const c_char,
    output: *const c_char,
    font_path: *const c_char,
    out_err: *mut c_char,
    err_len: usize,
) -> i64 {
    let input = match from_c(input) {
        Some(v) if !v.trim().is_empty() => v,
        _ => {
            write_err(out_err, err_len, "input path is empty");
            return -1;
        }
    };
    let output = match from_c(output) {
        Some(v) if !v.trim().is_empty() => v,
        _ => {
            write_err(out_err, err_len, "output path is empty");
            return -1;
        }
    };
    let font = from_c(font_path).filter(|s| !s.trim().is_empty());

    let mut opts = office2pdf::config::ConvertOptions::default();
    if let Some(fp) = font {
        opts.font_paths = vec![std::path::PathBuf::from(fp)];
    }
    match office2pdf::convert_with_options(Path::new(&input), &opts) {
        Ok(result) => {
            let bytes = result.pdf;
            if let Err(e) = std::fs::write(&output, &bytes) {
                write_err(out_err, err_len, &format!("write output failed: {e}"));
                return -1;
            }
            bytes.len() as i64
        }
        Err(e) => {
            write_err(out_err, err_len, &format!("convert failed: {e}"));
            -1
        }
    }
}

/// C ABI：返回版本串（静态字符串，调用方不要释放）。
#[no_mangle]
pub extern "C" fn office2pdf_version() -> *const c_char {
    static VERSION: &[u8] = b"office2pdf-capi 0.1.0 / office2pdf 0.10.0\0";
    VERSION.as_ptr() as *const c_char
}

/// C ABI：做一次自检（不碰文件，返回 0 表示库已正确链接进进程）。
#[no_mangle]
pub extern "C" fn office2pdf_selfcheck() -> c_int {
    let _ = CString::new("ok").unwrap_or_default();
    c_int::from(0)
}
