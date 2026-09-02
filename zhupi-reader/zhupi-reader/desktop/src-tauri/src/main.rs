#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{Manager, State};

/// 启动时命令行里带的 .epub 路径,等前端起来了再取走
#[derive(Default)]
struct Pending(Mutex<Vec<String>>);

#[tauri::command]
fn opened_files(state: State<Pending>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// 把文件原样交给前端。返回 ipc::Response,走二进制通道,
/// 不会被序列化成 JSON 数字数组 —— 几十 MB 的书也不卡。
#[tauri::command]
fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

fn only_epubs<I: Iterator<Item = String>>(it: I) -> Vec<String> {
    it.filter(|a| a.to_lowercase().ends_with(".epub")).collect()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Pending::default())
        .invoke_handler(tauri::generate_handler![opened_files, read_file])
        .setup(|app| {
            // Windows / Linux:双击 .epub 时路径在 argv 里
            *app.state::<Pending>().0.lock().unwrap() = only_epubs(std::env::args().skip(1));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("朱批启动失败")
        .run(|_app, _event| {
            // macOS:Finder 双击走的是 Opened 事件,不是 argv
            #[cfg(target_os = "macos")]
            {
                use tauri::Emitter;
                if let tauri::RunEvent::Opened { urls } = &_event {
                    let paths = only_epubs(
                        urls.iter()
                            .filter_map(|u| u.to_file_path().ok())
                            .map(|p| p.to_string_lossy().to_string()),
                    );
                    if !paths.is_empty() {
                        let _ = _app.emit("open-epub", paths);
                    }
                }
            }
        });
}
