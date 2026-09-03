mod agent;
mod agent_store;
mod ai;
mod background;
mod character_state_policy;
mod commands;
mod credit_confirmation;
mod workflow_credit;
mod database;
mod douyin_tasks;
mod guided_idea;
mod jobs;
mod logging;
mod long_idea;
mod media_tools;
mod platform_session;
mod platform_media;
mod platform_video_understanding;
mod project;
mod shot_policy;
mod story_policy;
mod tray;
mod video_remix;
mod worker;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            tray::initialize(app)?;
            logging::init(app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_project,
            credit_confirmation::list_credit_confirmations,
            credit_confirmation::resolve_credit_confirmation,
            workflow_credit::approve_workflow_credit,
            workflow_credit::stop_workflow_credit,
            commands::list_projects,
            commands::delete_project,
            commands::list_asset_library,
            commands::delete_asset_library,
            commands::load_project,
            commands::save_text_file,
            commands::import_project_reference_image,
            logging::list_application_logs,
            commands::develop_idea,
            commands::get_idea_development_workflow,
            commands::update_idea_development_workflow,
            commands::analyze_script,
            commands::resolve_douyin_url,
            commands::resolve_douyin_auto,
            commands::get_douyin_browser_availability,
            commands::download_douyin_video,
            commands::download_douyin_video_auto,
            commands::analyze_douyin_video,
            douyin_tasks::create_douyin_understanding_task,
            douyin_tasks::list_douyin_understanding_tasks,
            douyin_tasks::list_local_video_understanding_tasks,
            douyin_tasks::create_local_video_understanding_task,
            douyin_tasks::retry_douyin_understanding_task,
            douyin_tasks::retry_local_video_understanding_task,
            douyin_tasks::delete_video_understanding_task,
            douyin_tasks::save_local_video_understanding_task,
            video_remix::create_video_remix_task,
            video_remix::list_video_remix_tasks,
            video_remix::retry_video_remix_task,
            video_remix::delete_video_remix_task,
            video_remix::create_video_remix_project,
            commands::save_canonical_project,
            commands::create_automatic_workflow,
            commands::get_active_automatic_workflow,
            commands::update_automatic_workflow,
            ai::get_ai_settings,
            ai::save_ai_settings,
            platform_session::get_platform_session,
            platform_session::save_platform_session,
            platform_session::clear_platform_session,
            platform_session::activate_user_context,
            media_tools::probe_local_video,
            ai::analyze_video,
            ai::create_image_generation_tasks,
            ai::list_image_generation_tasks,
            ai::resume_image_generation_tasks,
            ai::create_shot_video_generation,
            ai::compose_project_video,
            ai::list_generation_records,
            ai::save_generation_record_asset,
            ai::export_all_generation_assets,
            ai::read_project_asset,
            agent::list_agent_sessions,
            agent::list_agent_messages,
            agent::list_agent_runs,
            agent::send_agent_message,
            tray::set_tray_status,
            tray::exit_application,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI Video Studio");
}
