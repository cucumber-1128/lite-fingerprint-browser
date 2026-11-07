#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tauri 壳：拉起 Node sidecar（我们的单文件程序），等它打印 FB_READY，
//! 再用返回的地址建窗口。这样没有白屏，也不用把端口写死。

use std::sync::Mutex;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct Sidecar(Mutex<Option<CommandChild>>);

fn open_console(app: &tauri::AppHandle, url: &str) {
    let parsed = match url.parse::<tauri::Url>() {
        Ok(u) => u,
        Err(e) => {
            show_fallback(app, &format!("后台地址解析失败：{e}"));
            return;
        }
    };
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.navigate(parsed);
        return;
    }
    if let Err(e) = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title("轻量指纹浏览器")
        .inner_size(1180.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .build()
    {
        eprintln!("窗口创建失败：{e}");
    }
}

/// sidecar 没起来时的兜底窗口：显示内置页面，至少让人知道出了什么事
fn show_fallback(app: &tauri::AppHandle, reason: &str) {
    eprintln!("[sidecar] {reason}");
    if app.get_webview_window("main").is_some() {
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("轻量指纹浏览器 · 后台没起来")
        .inner_size(760.0, 520.0)
        .build();
}

fn spawn_sidecar(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let cmd = match app.shell().sidecar("fb") {
            Ok(c) => c.args(["--machine", "--no-open"]),
            Err(e) => {
                show_fallback(&app, &format!("找不到后台程序（fb）：{e}"));
                return;
            }
        };
        let (mut rx, child) = match cmd.spawn() {
            Ok(v) => v,
            Err(e) => {
                show_fallback(&app, &format!("后台程序启动失败：{e}"));
                return;
            }
        };
        if let Some(slot) = app.try_state::<Sidecar>() {
            if let Ok(mut guard) = slot.0.lock() {
                *guard = Some(child);
            }
        }

        // 第一阶段：等 FB_READY
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(25);
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                show_fallback(&app, "后台程序 25 秒内没有就绪");
                return;
            }
            match tokio::time::timeout(left, rx.recv()).await {
                Err(_) => {
                    show_fallback(&app, "后台程序 25 秒内没有就绪");
                    return;
                }
                Ok(None) => {
                    show_fallback(&app, "后台程序提前退出");
                    return;
                }
                Ok(Some(CommandEvent::Stdout(line))) => {
                    let text = String::from_utf8_lossy(&line);
                    let mut ready = false;
                    for part in text.lines() {
                        if let Some(rest) = part.trim().strip_prefix("FB_READY ") {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) {
                                if let Some(url) = v.get("url").and_then(|u| u.as_str()) {
                                    open_console(&app, url);
                                    ready = true;
                                }
                            }
                        }
                    }
                    if ready {
                        break;
                    }
                }
                Ok(Some(CommandEvent::Stderr(line))) => {
                    eprint!("{}", String::from_utf8_lossy(&line));
                }
                Ok(Some(_)) => {}
            }
        }

        // 第二阶段：继续把管道读干，免得 sidecar 写日志时把管道堵住
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Stderr(line) = event {
                eprint!("{}", String::from_utf8_lossy(&line));
            }
        }
    });
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            spawn_sidecar(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 应用构建失败");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(slot) = handle.try_state::<Sidecar>() {
                // 丢掉 child：stdin 管道随之关闭，Node 侧会走优雅退出（把已启动的环境关掉）
                if let Ok(mut guard) = slot.0.lock() {
                    let _ = guard.take();
                }
            }
        }
    });
}
