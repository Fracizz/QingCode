//! Native title-bar drag regions.
//!
//! Tauri's `data-tauri-drag-region` starts the OS move loop from a JS `mousedown`
//! handler through an IPC round trip (`plugin:window|start_dragging` →
//! `ReleaseCapture` + `PostMessage(WM_NCLBUTTONDOWN)`), so a drag cannot begin
//! until the webview's main thread is free. In an editor that is busy with
//! CodeMirror, xterm and file-tree work that shows up as the window refusing to
//! follow the cursor and then snapping to it.
//!
//! Reporting the same rectangles here and answering `WM_NCHITTEST` with
//! `HTCAPTION` hands the drag to Windows on the very first mouse message, the way
//! Chromium implements `-webkit-app-region: drag`. Double-click-to-maximize,
//! edge snapping and the caption context menu then come from the OS as well.
//!
//! The frontend keeps `data-tauri-drag-region` in place: it is the fallback for
//! other platforms, and on Windows the webview never sees a `mousedown` inside a
//! caption rectangle, so the two cannot both act on one press.

use serde::Deserialize;

/// A drag region in CSS pixels, relative to the top-left of the webview.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct CaptionRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Converts a CSS-pixel region into inclusive-left/exclusive-right physical
/// client pixels, which is what a window procedure can compare cheaply.
fn physical_bounds(region: &CaptionRegion, scale: f64) -> (i32, i32, i32, i32) {
    let left = (region.x * scale).round() as i32;
    let top = (region.y * scale).round() as i32;
    // Round the far edges from the CSS edge rather than from the scaled width, so
    // adjacent regions stay seamless instead of leaving a one-pixel dead seam.
    let right = ((region.x + region.width) * scale).round() as i32;
    let bottom = ((region.y + region.height) * scale).round() as i32;
    (left, top, right, bottom)
}

/// Replaces the window's native drag regions with `regions`.
#[tauri::command]
pub fn set_caption_regions(
    window: tauri::Window,
    regions: Vec<CaptionRegion>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return imp::apply(&window, &regions);

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, regions);
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{physical_bounds, CaptionRegion};
    use std::sync::Mutex;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::ScreenToClient;
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        HTCAPTION, HTCLIENT, WM_NCDESTROY, WM_NCHITTEST,
    };

    const SUBCLASS_ID: usize = 0x9163_0001;

    struct WindowRegions {
        /// Raw `HWND` value; kept as `isize` so no window handle is held across threads.
        hwnd: isize,
        /// Physical client-area pixels, so the window procedure only compares integers.
        rects: Vec<RECT>,
    }

    static REGIONS: Mutex<Vec<WindowRegions>> = Mutex::new(Vec::new());

    pub fn apply(window: &tauri::Window, regions: &[CaptionRegion]) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let rects = regions
            .iter()
            .filter(|region| region.width > 0.0 && region.height > 0.0)
            .map(|region| {
                let (left, top, right, bottom) = physical_bounds(region, scale);
                RECT {
                    left,
                    top,
                    right,
                    bottom,
                }
            })
            .collect::<Vec<_>>();

        let mut entries = REGIONS.lock().map_err(|_| "caption regions poisoned")?;
        match entries.iter_mut().find(|entry| entry.hwnd == hwnd) {
            Some(entry) => entry.rects = rects,
            None => {
                entries.push(WindowRegions { hwnd, rects });
                // Installed after tao's subclass, so this runs first and chains
                // into tao's border hit-testing through `DefSubclassProc`.
                unsafe {
                    let _ = SetWindowSubclass(
                        HWND(hwnd as *mut _),
                        Some(subclass_proc),
                        SUBCLASS_ID,
                        0,
                    );
                }
            }
        }
        Ok(())
    }

    fn contains(rect: &RECT, point: &POINT) -> bool {
        point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom
    }

    fn in_caption(hwnd: HWND, lparam: LPARAM) -> bool {
        let packed = lparam.0 as u32;
        let mut point = POINT {
            x: (packed & 0xFFFF) as u16 as i16 as i32,
            y: (packed >> 16) as u16 as i16 as i32,
        };
        if !unsafe { ScreenToClient(hwnd, &mut point) }.as_bool() {
            return false;
        }

        let raw = hwnd.0 as isize;
        // A window procedure must never wait on the frontend's update, so a
        // contended lock just falls back to normal client-area behaviour.
        let Ok(entries) = REGIONS.try_lock() else {
            return false;
        };
        entries
            .iter()
            .find(|entry| entry.hwnd == raw)
            .is_some_and(|entry| entry.rects.iter().any(|rect| contains(rect, &point)))
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        match msg {
            WM_NCHITTEST => {
                let default = DefSubclassProc(hwnd, msg, wparam, lparam);
                // Only ever upgrade plain client area: tao returns the resize
                // border codes here and those must win.
                if default.0 as u32 == HTCLIENT && in_caption(hwnd, lparam) {
                    return LRESULT(HTCAPTION as isize);
                }
                default
            }
            WM_NCDESTROY => {
                let raw = hwnd.0 as isize;
                if let Ok(mut entries) = REGIONS.lock() {
                    entries.retain(|entry| entry.hwnd != raw);
                }
                let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
                DefSubclassProc(hwnd, msg, wparam, lparam)
            }
            _ => DefSubclassProc(hwnd, msg, wparam, lparam),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{physical_bounds, CaptionRegion};

    fn region(x: f64, y: f64, width: f64, height: f64) -> CaptionRegion {
        CaptionRegion {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn physical_bounds_scales_css_pixels() {
        let bounds = physical_bounds(&region(100.0, 0.0, 140.0, 32.0), 1.75);
        assert_eq!(bounds, (175, 0, 420, 56));
    }

    #[test]
    fn physical_bounds_passes_through_at_unit_scale() {
        let bounds = physical_bounds(&region(12.5, 4.0, 60.5, 28.0), 1.0);
        assert_eq!(bounds, (13, 4, 73, 32));
    }

    #[test]
    fn physical_bounds_keeps_adjacent_regions_seamless() {
        // A shared CSS edge must map to a single physical edge, otherwise the OS
        // hit test finds a dead seam between two neighbouring drag regions.
        let scale = 1.5;
        let left = physical_bounds(&region(10.0, 0.0, 33.0, 32.0), scale);
        let right = physical_bounds(&region(43.0, 0.0, 27.0, 32.0), scale);
        assert_eq!(left.2, right.0);
    }
}
