use tauri::{
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager,
};

const TRAY_ID: &str = "main-tray";

pub fn initialize(app: &App) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("逐梦帧 · 当前没有运行中的任务")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if !matches!(event, TrayIconEvent::DoubleClick { button: MouseButton::Left, .. }) {
                return;
            }
            if let Some(window) = tray.app_handle().get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[tauri::command]
pub fn set_tray_status(app: AppHandle, status: String) -> Result<(), String> {
    let compact = status.split_whitespace().collect::<Vec<_>>().join(" ");
    let compact = compact.chars().take(80).collect::<String>();
    let tooltip = if compact.is_empty() {
        "逐梦帧 · 当前没有运行中的任务".to_owned()
    } else {
        format!("逐梦帧 · {compact}")
    };
    let tray = app.tray_by_id(TRAY_ID).ok_or_else(|| "系统托盘尚未初始化".to_owned())?;
    tray.set_tooltip(Some(tooltip)).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn exit_application(app: AppHandle) {
    app.exit(0);
}
