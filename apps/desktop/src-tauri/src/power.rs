//! Windows going to sleep, shutting down or logging off: Harv hears it first, so a light that
//! automatic lights turned on goes off instead of staying on all night (docs/PLAN.md §6z).
//!
//! A hidden top-level window of its own on its own thread (a message-only window gets no
//! broadcasts): `WM_POWERBROADCAST` / `PBT_APMSUSPEND` for sleep, `WM_QUERYENDSESSION` for
//! shutdown and logoff. The call to Harv is synchronous there, so the light is off before Windows
//! goes on; Harv's server answers in about a second (its light helper is already logged in).
//! At shutdown the server is often gone already (Windows closes its hidden console first, seen
//! 2026-11-01): then the app runs the light helper itself, from the plan the server keeps in
//! ~/.harv/lights-app.json (there only while automatic lights are on) and the Tapo login.
//! The same helper turns the light on the moment the app opens after dark (`on_at_start`, the
//! user's wish 2026-11-02: "start instantly"), instead of waiting ~15 s for Harv's server.

use crate::harv;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::ptr::null_mut;
use std::sync::mpsc;
use std::time::{Duration, Instant};
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

/// Asks Harv to turn the lights off (automatic lights on). `why` is sleep, shutdown or logoff.
fn leaving(why: &str) {
    let answer = harv::post_json("/api/lights/leaving", &format!("{{\"why\":\"{why}\"}}"));
    harv::log(&format!(
        "Windows: {why}; lights asked to turn off ({})",
        answer.map_or("Harv didn't answer".into(), |c| format!("HTTP {c}"))
    ));
    if answer.is_none() {
        harv::log(&format!("Windows: {why}; {}", off_directly()));
    }
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn read_json(name: &str) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(harv::harv_home().join(name)).ok()?).ok()
}

/// Harv's server is gone: the light helper turns the lights off, the same way the server would.
fn off_directly() -> String {
    match read_json("lights-app.json") {
        Some(plan) => switch_directly(&plan, false),
        None => "no lights to turn off (automatic lights off)".into(),
    }
}

const DAY_MS: f64 = 86_400_000.0;

/// Dark by the last sun times Harv read (like the server's `sunOnly` + `sunDark`): from the margin
/// before sunset until sunrise, the times moved on by whole days to today. None without sun times.
fn sun_dark(plan: &Value, now: f64) -> Option<bool> {
    let times = |key: &str| -> Option<Vec<f64>> {
        Some(
            plan[key]
                .as_array()?
                .iter()
                .filter_map(Value::as_f64)
                .collect(),
        )
    };
    let (rise, set) = (times("sunrise")?, times("sunset")?);
    let days = ((now - rise.first()?) / DAY_MS).floor().max(0.0);
    let rise: Vec<f64> = rise.iter().map(|t| t + days * DAY_MS).collect();
    let set: Vec<f64> = set.iter().map(|t| t + days * DAY_MS).collect();
    let before = plan["beforeSunsetMin"].as_f64().unwrap_or(30.0) * 60_000.0;
    if now < rise[0] {
        return Some(true);
    }
    Some(
        set.iter()
            .enumerate()
            .any(|(i, s)| now >= s - before && rise.get(i + 1).is_none_or(|r| now < *r)),
    )
}

/// The app just opened and Harv isn't running yet (a PC start): after dark the light goes on at
/// once; Harv's automatic lights take over when the server is up. Cloudy-day darkness needs the
/// weather, so that case still waits for the server.
pub fn on_at_start() {
    std::thread::spawn(|| {
        if harv::is_up() {
            return;
        }
        let Some(plan) = read_json("lights-app.json") else {
            return;
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_millis() as f64);
        if sun_dark(&plan, now) == Some(true) {
            harv::log(&format!(
                "Start after dark: {}",
                switch_directly(&plan, true)
            ));
        }
    });
}

/// Runs the light helper for every light in the plan: on or off.
fn switch_directly(plan: &Value, on: bool) -> String {
    let Some(tapo) = read_json("devices.json").and_then(|d| d.get("tapo").cloned()) else {
        return "no Tapo login".into();
    };
    let lights = plan["lights"].as_array().cloned().unwrap_or_default();
    let (Some(python), Some(helper)) = (plan["python"].as_str(), plan["helper"].as_str()) else {
        return "the plan names no helper".into();
    };
    let child = Command::new(python)
        .args(["-I", helper])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => return format!("the light helper didn't start: {e}"),
    };
    let mut asks =
        vec![json!({"op": "login", "email": tapo["email"], "password": tapo["password"], "id": 0})];
    for (i, light) in lights.iter().enumerate() {
        let mut ask = json!({"op": "set", "mac": light["mac"], "targets": plan["targets"], "change": {"on": on}, "id": i + 1});
        if light.get("ip").is_some() {
            ask["ip"] = light["ip"].clone();
        }
        asks.push(ask);
    }
    if let Some(mut stdin) = child.stdin.take() {
        for ask in &asks {
            let _ = writeln!(stdin, "{ask}");
        }
    }
    // The answers, each line on a thread so a light that never answers can't hold up the shutdown.
    let (tx, rx) = mpsc::channel();
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let (mut done, mut failed) = (0, Vec::new());
    for _ in 0..asks.len() {
        let Some(left) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        let Ok(line) = rx.recv_timeout(left) else {
            break;
        };
        let answer: Value = serde_json::from_str(&line).unwrap_or_default();
        if answer["id"] == 0 {
            continue;
        }
        if answer["ok"] == true {
            done += 1;
        } else {
            failed.push(answer["error"].as_str().unwrap_or("no answer").to_string());
        }
    }
    let _ = child.kill();
    format!(
        "the app turned {done} of {} light(s) {} itself{}",
        lights.len(),
        if on { "on" } else { "off" },
        if failed.is_empty() {
            String::new()
        } else {
            format!(" ({})", failed.join("; "))
        }
    )
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
