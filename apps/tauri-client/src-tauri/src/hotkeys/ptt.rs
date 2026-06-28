use super::HotkeyEvent;
use tokio::sync::mpsc;

pub async fn run_listener(key: &str, tx: mpsc::Sender<HotkeyEvent>) {
    // Windows implementation: RegisterHotKey via windows crate
    // Cross-platform fallback: poll keyboard state

    tracing::info!("PTT listener started for key: {key}");

    // TODO: implement actual global hotkey registration
    // On Windows:
    //   - RegisterHotKey(HWND(0), id, MOD_NONE, vk_code)
    //   - GetMessage loop watching WM_HOTKEY
    //   - Track key state to avoid repeat events (emit PttPressed once, PttReleased once)

    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(3600)).await;
    }
}
