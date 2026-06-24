use anyhow::Result;
use crate::iracing::defines::IRSDK_BROADCAST_CAM_SWITCH_NUM;

pub struct CameraController;

impl CameraController {
    pub fn switch_camera(&self, camera_num: i32, car_num: i32) -> Result<()> {
        #[cfg(target_os = "windows")]
        {
            self.post_broadcast_message(IRSDK_BROADCAST_CAM_SWITCH_NUM, car_num as u16, camera_num as u16, 0)?;
        }
        #[cfg(not(target_os = "windows"))]
        {
            tracing::warn!("Camera switching is only supported on Windows (iRacing platform)");
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    fn post_broadcast_message(&self, msg_type: u32, var1: u16, var2: u16, var3: i32) -> Result<()> {
        use windows::Win32::UI::WindowsAndMessaging::{FindWindowA, PostMessageA, WM_USER};
        use windows::core::s;

        let broadcast_msg_id = unsafe {
            windows::Win32::UI::WindowsAndMessaging::RegisterWindowMessageA(s!("IRSDK_BROADCASTMSG"))
        };

        let hwnd = unsafe { FindWindowA(s!("IRSDK"), None) };
        if hwnd.0 == 0 {
            anyhow::bail!("iRacing broadcast window not found");
        }

        let wparam = ((msg_type as usize) | ((var1 as usize) << 16));
        let lparam = ((var2 as isize) | ((var3 as isize) << 16));

        unsafe {
            PostMessageA(hwnd, broadcast_msg_id, windows::Win32::Foundation::WPARAM(wparam), windows::Win32::Foundation::LPARAM(lparam))?;
        }

        Ok(())
    }
}
