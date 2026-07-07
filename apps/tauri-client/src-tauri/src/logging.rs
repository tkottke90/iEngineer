use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

// The non-blocking file writer flushes on a background thread; its guard must
// live for the whole process or buffered lines are dropped on exit.
static LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

/// Initialize tracing. Always logs to stdout (visible under `tauri dev`), and —
/// when a writable log dir is available — also to a daily-rolling file.
///
/// The file target is what makes audio/STT diagnostics visible in Windows
/// release builds, where the console is detached (`windows_subsystem =
/// "windows"` in main.rs) and stdout goes nowhere. Log dir per platform:
///   Windows: %LOCALAPPDATA%\com.iracing.engineer\logs\client.log.<date>
///   macOS:   ~/Library/Logs/com.iracing.engineer/client.log.<date>
pub fn init(app: &AppHandle) {
    let filter = || EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    let log_dir = app.path().app_log_dir().ok();
    let file_layer = log_dir.as_ref().and_then(|dir| {
        if std::fs::create_dir_all(dir).is_err() {
            return None;
        }
        let appender = tracing_appender::rolling::daily(dir, "client.log");
        let (writer, guard) = tracing_appender::non_blocking(appender);
        let _ = LOG_GUARD.set(guard);
        // Option<Layer> is itself a Layer (no-op when None), so this composes
        // cleanly whether or not the file target is available.
        Some(fmt::layer().with_ansi(false).with_writer(writer))
    });

    tracing_subscriber::registry()
        .with(filter())
        .with(fmt::layer().with_writer(std::io::stdout))
        .with(file_layer)
        .init();

    match log_dir {
        Some(dir) => tracing::info!(
            path = %dir.join("client.log").display(),
            "[log] file logging enabled"
        ),
        None => tracing::warn!("[log] no writable log dir — logging to stdout only"),
    }
}
