//! Windows going to sleep, shutting down or logging off: Harv hears it first, so a light that
//! automatic lights turned on goes off instead of staying on all night (docs/PLAN.md §6z).
//!
//! A hidden top-level window of its own on its own thread (a message-only window gets no
//! broadcasts): `WM_POWERBROADCAST` / `PBT_APMSUSPEND` for sleep, `WM_QUERYENDSESSION` for
//! shutdown and logoff. The call to Harv is synchronous there, so the light is off before Windows
//! goes on; Harv's server answers in about a second (its light helper is already logged in).

use crate::harv;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Power::RegisterSuspendResumeNotification;
use windows_sys::Win32::System::Shutdown::{ShutdownBlockReasonCreate, ShutdownBlockReasonDestroy};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    TranslateMessage, DEVICE_NOTIFY_WINDOW_HANDLE, MSG, WNDCLASSW,
};

const WM_QUERYENDSESSION: u32 = 0x0011;
const WM_POWERBROADCAST: u32 = 0x0218;
const PBT_APMSUSPEND: usize = 0x0004;
const ENDSESSION_LOGOFF: isize = 0x8000_0000u32 as i32 as isize;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Asks Harv to turn off what automatic lights turned on. `why` is sleep, shutdown or logoff.
fn leaving(why: &str) {
    let answer = harv::post_json("/api/lights/leaving", &format!("{{\"why\":\"{why}\"}}"));
    harv::log(&format!(
        "Windows: {why}; lights asked to turn off ({})",
        answer.map_or("Harv didn't answer".into(), |c| format!("HTTP {c}"))
    ));
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_POWERBROADCAST if wparam == PBT_APMSUSPEND => {
            leaving("sleep");
            1
        }
        WM_QUERYENDSESSION => {
            // Shown only if Windows has to wait for it.
            let reason = wide("Turning the light off");
            ShutdownBlockReasonCreate(hwnd, reason.as_ptr());
            leaving(if lparam & ENDSESSION_LOGOFF != 0 {
                "logoff"
            } else {
                "shutdown"
            });
            ShutdownBlockReasonDestroy(hwnd);
            1
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Starts the listener on its own thread; it lives as long as the app.
pub fn watch() {
    std::thread::spawn(|| unsafe {
        let instance = GetModuleHandleW(null_mut());
        let class = wide("HarvPowerWatch");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: instance,
            lpszClassName: class.as_ptr(),
            ..std::mem::zeroed()
        };
        if RegisterClassW(&wc) == 0 {
            harv::log("power watch: couldn't register its window");
            return;
        }
        let title = wide("Harv power watch");
        // Not WS_VISIBLE, no parent: a hidden top-level window, which still gets the broadcasts.
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            title.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            null_mut(),
            null_mut(),
            instance,
            null_mut(),
        );
        if hwnd.is_null() {
            harv::log("power watch: couldn't create its window");
            return;
        }
        // Modern standby too, not only classic sleep.
        RegisterSuspendResumeNotification(hwnd, DEVICE_NOTIFY_WINDOW_HANDLE);
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}
