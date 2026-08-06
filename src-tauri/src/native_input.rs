/// Read the physical Ctrl key directly from Windows.
///
/// Packaged WebView2 can omit `ctrlKey` from mouse events and may not deliver
/// the corresponding key event to the editor. The native state is the final
/// fallback for Ctrl+click definition navigation.
#[tauri::command]
pub fn primary_modifier_pressed() -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_CONTROL, VK_LCONTROL, VK_RCONTROL,
        };

        // The high bit means the key is currently down. Check generic and
        // side-specific virtual keys because keyboard drivers vary.
        unsafe {
            [VK_CONTROL, VK_LCONTROL, VK_RCONTROL]
                .into_iter()
                .any(|key| (GetAsyncKeyState(key as i32) as u16 & 0x8000) != 0)
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}
