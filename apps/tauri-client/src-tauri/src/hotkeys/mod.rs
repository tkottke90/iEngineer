pub mod ptt;

use tokio::{sync::mpsc, task::JoinHandle};

pub struct HotkeyConfig {
    pub ptt_key: String,
}

#[derive(Debug, Clone)]
pub enum HotkeyEvent {
    PttPressed,
    PttReleased,
}

pub fn spawn_hotkey_listener(config: HotkeyConfig) -> (JoinHandle<()>, mpsc::Receiver<HotkeyEvent>) {
    let (tx, rx) = mpsc::channel(32);
    let handle = tokio::spawn(async move {
        ptt::run_listener(&config.ptt_key, tx).await;
    });
    (handle, rx)
}
