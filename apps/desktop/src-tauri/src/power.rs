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
//! The helper is started early and kept waiting (`keep_warm`) while automatic lights are on:
//! Windows refuses to start new programs during a shutdown (python.exe failed with 0xc0000142
//! and an error popup, 2026-11-02), so at shutdown the app only writes to the running helper.

use crate::harv;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::ptr::null_mut;
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
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

/// No console at all: a hidden console would make Windows end the helper with the consoles,
/// before the app hears the shutdown.
const DETACHED_PROCESS: u32 = 0x0000_0008;

fn read_json(name: &str) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(harv::harv_home().join(name)).ok()?).ok()
}

/// The light helper, started and logged in, waiting for asks on its stdin.
struct Helper {
    child: Child,
    stdin: ChildStdin,
    answers: Receiver<String>,
    /// Which python and helper file it runs: a changed plan starts a new one.
    runs: (String, String),
    next_id: u64,
}

impl Helper {
    fn start(plan: &Value) -> Result<Helper, String> {
        let tapo = read_json("devices.json")
            .and_then(|d| d.get("tapo").cloned())
            .ok_or("no Tapo login")?;
        let (Some(python), Some(helper)) = (plan["python"].as_str(), plan["helper"].as_str())
        else {
            return Err("the plan names no helper".into());
        };
        let mut child = Command::new(python)
            .args(["-I", helper])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(DETACHED_PROCESS)
            .spawn()
            .map_err(|e| format!("the light helper didn't start: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        let out = child.stdout.take().ok_or("no stdout")?;
        let (tx, answers) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let login =
            json!({"op": "login", "email": tapo["email"], "password": tapo["password"], "id": 0});
        writeln!(stdin, "{login}").map_err(|e| format!("the light helper didn't listen: {e}"))?;
        Ok(Helper {
            child,
            stdin,
            answers,
            runs: (python.into(), helper.into()),
            next_id: 1,
        })
    }

    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Every light in the plan on or off; answers within 10 s, so a light that never answers
    /// can't hold up a shutdown.
    fn switch(&mut self, plan: &Value, on: bool) -> String {
        let lights = plan["lights"].as_array().cloned().unwrap_or_default();
        let mut waiting = Vec::new();
        for light in &lights {
            let id = self.next_id;
            self.next_id += 1;
            let mut ask = json!({"op": "set", "mac": light["mac"], "targets": plan["targets"], "change": {"on": on}, "id": id});
            if light.get("ip").is_some() {
                ask["ip"] = light["ip"].clone();
            }
            if writeln!(self.stdin, "{ask}").is_err() {
                break;
            }
            waiting.push(id);
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        let (mut done, mut failed) = (0, Vec::new());
        while !waiting.is_empty() {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            let Ok(line) = self.answers.recv_timeout(left) else {
                break;
            };
            let answer: Value = serde_json::from_str(&line).unwrap_or_default();
            let Some(pos) = waiting.iter().position(|id| answer["id"] == *id) else {
                continue; // the login's answer, or a late one from an earlier ask
            };
            waiting.remove(pos);
            if answer["ok"] == true {
                done += 1;
            } else {
                failed.push(answer["error"].as_str().unwrap_or("no answer").to_string());
            }
        }
        if !waiting.is_empty() {
            failed.push(format!("{} didn't answer", waiting.len()));
        }
        format!(
            "turned {done} of {} light(s) {}{}",
            lights.len(),
            if on { "on" } else { "off" },
            if failed.is_empty() {
                String::new()
            } else {
                format!(" ({})", failed.join("; "))
            }
        )
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// The waiting helper, there while automatic lights are on (`lights-app.json` exists).
static WARM: Mutex<Option<Helper>> = Mutex::new(None);

/// Starts, keeps or drops the waiting helper to match the plan; returns the plan.
fn warm_up() -> Option<Value> {
    let plan = read_json("lights-app.json");
    let mut warm = WARM.lock().unwrap_or_else(|e| e.into_inner());
    let Some(plan) = plan else {
        *warm = None;
        return None;
    };
    let runs = (
        plan["python"].as_str().unwrap_or_default().to_string(),
        plan["helper"].as_str().unwrap_or_default().to_string(),
    );
    let fine = warm.as_mut().is_some_and(|h| h.alive() && h.runs == runs);
    if !fine {
        *warm = None;
        match Helper::start(&plan) {
            Ok(h) => *warm = Some(h),
            Err(e) => harv::log(&format!("lights: {e}")),
        }
    }
    Some(plan)
}

/// Checks every minute that the helper is waiting while automatic lights are on.
fn keep_warm() {
    std::thread::spawn(|| loop {
        warm_up();
        std::thread::sleep(Duration::from_secs(60));
    });
}

/// Runs the plan through the waiting helper; without one (it died, or none could start) a new
/// helper is tried, which works any time but during a shutdown.
fn switch_directly(plan: &Value, on: bool) -> String {
    let mut warm = WARM.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(h) = warm.as_mut() {
        if h.alive() {
            return format!("the app {} itself", h.switch(plan, on));
        }
    }
    *warm = None;
    match Helper::start(plan) {
        Ok(mut h) => {
            let said = h.switch(plan, on);
            *warm = Some(h);
            format!("the app {said} itself (with a new helper)")
        }
        Err(e) => e,
    }
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

/// The app just opened: the light helper starts waiting (`keep_warm`), and if Harv isn't running
/// yet (a PC start) and it's dark, the light goes on at once; Harv's automatic lights take over
/// when the server is up. Cloudy-day darkness needs the weather, so that case still waits for
/// the server.
pub fn on_at_start() {
    std::thread::spawn(|| {
        let up = harv::is_up();
        let plan = warm_up();
        keep_warm();
        let Some(plan) = plan.filter(|_| !up) else {
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
