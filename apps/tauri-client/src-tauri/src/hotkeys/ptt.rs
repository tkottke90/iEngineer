use super::HotkeyEvent;
use tokio::sync::{mpsc, oneshot};

/// T024/E2: the macOS Accessibility deep-link the "Open Accessibility
/// Settings" button opens (FR-028). A typo here silently breaks the button —
/// guarded by a unit test below.
pub const MACOS_ACCESSIBILITY_PREFS_URI: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/// Map a `global_shortcut().register()` error message onto the FR-012 error
/// code taxonomy. The plugin surfaces one opaque error type, so this is a
/// keyword heuristic: permission-flavored messages (macOS Accessibility) →
/// `ptt:accessibility-denied`; everything else → `ptt:key-conflict`.
pub fn classify_register_error(message: &str) -> &'static str {
    let lower = message.to_lowercase();
    if lower.contains("accessibility")
        || lower.contains("permission")
        || lower.contains("not trusted")
    {
        "ptt:accessibility-denied"
    } else {
        "ptt:key-conflict"
    }
}

/// Await the captured key from the listening session with the 10s bind window
/// (T022). A dropped sender (superseded session) and the timeout both map to
/// `ptt:timeout` — from the driver's view, no key arrived.
pub async fn await_capture(
    rx: oneshot::Receiver<String>,
    timeout: std::time::Duration,
) -> Result<String, String> {
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(key)) => Ok(key),
        _ => Err("ptt:timeout".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// T024/E2: the deep-link URI must not drift — a typo silently breaks FR-028.
    #[test]
    fn accessibility_uri_constant_unchanged() {
        assert_eq!(
            MACOS_ACCESSIBILITY_PREFS_URI,
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        );
    }

    /// T024: register-error classification — permission-flavored messages map
    /// to accessibility-denied, anything else to key-conflict.
    #[test]
    fn classify_register_error_taxonomy() {
        assert_eq!(
            classify_register_error("process is not trusted for Accessibility"),
            "ptt:accessibility-denied"
        );
        assert_eq!(
            classify_register_error("OS permission denied registering hotkey"),
            "ptt:accessibility-denied"
        );
        assert_eq!(
            classify_register_error("hotkey already registered by another application"),
            "ptt:key-conflict"
        );
        assert_eq!(
            classify_register_error("unknown failure"),
            "ptt:key-conflict"
        );
    }

    /// T024: the 10s listening window times out with the exact contract code…
    #[tokio::test]
    async fn await_capture_times_out() {
        let (_tx, rx) = oneshot::channel::<String>();
        let result = await_capture(rx, std::time::Duration::from_millis(20)).await;
        assert_eq!(result, Err("ptt:timeout".into()));
    }

    /// …and delivers the captured key when one arrives in time.
    #[tokio::test]
    async fn await_capture_delivers_key() {
        let (tx, rx) = oneshot::channel::<String>();
        tx.send("F14".into()).unwrap();
        let result = await_capture(rx, std::time::Duration::from_secs(1)).await;
        assert_eq!(result, Ok("F14".into()));
    }
}

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
