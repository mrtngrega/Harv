//! Harv's browser (docs/PLAN.md §6x): real web views of the system's engine (WebView2 on
//! Windows, WebKitGTK on Linux) placed over the dashboard's Browser tab, so pages are as sharp
//! and quick as in any browser. One browser per computer, with page tabs, shared by every chat:
//! the dashboard places and drives it, and Harv's browser tools reach it through the dashboard.
//! Its logins live in ~/.harv/browser-data, apart from the dashboard's own. The pages get no
//! access to the app's commands (capabilities/main.json grants them to the "main" webview only).

use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};

/// A page's id is its webview's label: "browser-<n>".
const PREFIX: &str = "browser-";

#[derive(Default)]
pub struct Browser {
    inner: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// Page ids in tab order.
    pages: Vec<u32>,
    active: Option<u32>,
    next: u32,
    /// Where the Browser tab's page area is in the window (logical px), and whether it shows.
    bounds: Option<(f64, f64, f64, f64)>,
    visible: bool,
    /// Titles and whether a page is loading, from the engine's events.
    titles: std::collections::HashMap<u32, String>,
    loading: std::collections::HashSet<u32>,
}

#[derive(Serialize, Clone)]
struct PageInfo {
    id: u32,
    url: String,
    title: String,
    loading: bool,
}

#[derive(Serialize, Clone)]
struct BrowserState {
    pages: Vec<PageInfo>,
    active: Option<u32>,
}

fn label(id: u32) -> String {
    format!("{PREFIX}{id}")
}

fn page(app: &AppHandle, id: u32) -> Result<Webview, String> {
    app.get_webview(&label(id))
        .ok_or_else(|| format!("No browser page {id}."))
}

/// Only web pages and the user's files: no javascript:, data: or the app's own schemes.
fn parse_url(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|e| format!("Not a web address: {url} ({e})"))?;
    match parsed.scheme() {
        "http" | "https" | "file" => Ok(parsed),
        "about" if url == "about:blank" => Ok(parsed),
        other => Err(format!("The browser doesn't open {other}: links.")),
    }
}

/// Tells the dashboard what the browser holds now (its tabs, titles, addresses).
fn emit_state(app: &AppHandle) {
    // Copied out first: asking the engine for an address waits on the main thread, whose page
    // events take this lock (holding it here could deadlock).
    let (pages, active) = {
        let browser = app.state::<Browser>();
        let s = browser.inner.lock().unwrap();
        let pages: Vec<(u32, String, bool)> = s
            .pages
            .iter()
            .map(|&id| {
                (
                    id,
                    s.titles.get(&id).cloned().unwrap_or_default(),
                    s.loading.contains(&id),
                )
            })
            .collect();
        (pages, s.active)
    };
    let state = BrowserState {
        pages: pages
            .into_iter()
            .map(|(id, title, loading)| PageInfo {
                id,
                url: app
                    .get_webview(&label(id))
                    .and_then(|w| w.url().ok())
                    .map(|u| u.to_string())
                    .unwrap_or_default(),
                title,
                loading,
            })
            .collect(),
        active,
    };
    let _ = app.emit_to("main", "browser-state", state);
}

/// Shows the active page over the Browser tab's area (when it's showing) and hides the rest.
fn layout(app: &AppHandle) {
    let (pages, active, visible, bounds) = {
        let browser = app.state::<Browser>();
        let s = browser.inner.lock().unwrap();
        (s.pages.clone(), s.active, s.visible, s.bounds)
    };
    for id in pages {
        let Some(view) = app.get_webview(&label(id)) else {
            continue;
        };
        match (Some(id) == active && visible, bounds) {
            (true, Some((x, y, w, h))) => {
                #[cfg(target_os = "linux")]
                overlay::place(&view, x, y, w.max(1.0), h.max(1.0));
                #[cfg(not(target_os = "linux"))]
                {
                    let _ = view.set_position(LogicalPosition::new(x, y));
                    let _ = view.set_size(LogicalSize::new(w.max(1.0), h.max(1.0)));
                }
                let _ = view.show();
            }
            _ => {
                let _ = view.hide();
            }
        }
    }
}

/// A new page at `url`, made the active one.
fn open(app: &AppHandle, url: Url) -> Result<u32, String> {
    let window = app
        .get_window("main")
        .ok_or("The app's window isn't there.")?;
    let browser = app.state::<Browser>();
    let id = {
        let mut s = browser.inner.lock().unwrap();
        s.next += 1;
        s.next
    };
    let data = crate::harv::harv_home().join("browser-data");
    let _ = std::fs::create_dir_all(&data);
    let titles = app.clone();
    let loads = app.clone();
    let popups = app.clone();
    let builder = WebviewBuilder::new(label(id), WebviewUrl::External(url))
        .data_directory(data)
        .on_document_title_changed(move |_view, title| {
            titles
                .state::<Browser>()
                .inner
                .lock()
                .unwrap()
                .titles
                .insert(id, title);
            emit_state(&titles);
        })
        .on_page_load(move |_view, payload| {
            {
                let browser = loads.state::<Browser>();
                let mut s = browser.inner.lock().unwrap();
                match payload.event() {
                    PageLoadEvent::Started => s.loading.insert(id),
                    PageLoadEvent::Finished => s.loading.remove(&id),
                };
            }
            emit_state(&loads);
        })
        // A link that opens a new window (target=_blank, window.open) opens as a new page tab.
        .on_new_window(move |url, _features| {
            let app = popups.clone();
            std::thread::spawn(move || {
                if parse_url(url.as_str()).is_ok() {
                    let _ = open(&app, url);
                    layout(&app);
                    emit_state(&app);
                }
            });
            NewWindowResponse::Deny
        });
    // Created hidden at the tab's place (or a corner); layout() shows it when the tab is visible.
    let (x, y, w, h) = browser
        .inner
        .lock()
        .unwrap()
        .bounds
        .unwrap_or((0.0, 0.0, 800.0, 600.0));
    let view = window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| format!("Couldn't make a browser page: {e}"))?;
    #[cfg(target_os = "linux")]
    overlay::adopt(&view);
    let _ = view.hide();
    {
        let mut s = browser.inner.lock().unwrap();
        s.pages.push(id);
        s.active = Some(id);
    }
    Ok(id)
}

/// Runs a script in a page and returns its result (the script's last value, as JSON). Scripts
/// must be synchronous: the engines don't wait for promises. A thrown error comes back as
/// { "error": … } (WebView2 drops exceptions, so every script is wrapped).
fn eval(app: &AppHandle, id: u32, script: &str) -> Result<Value, String> {
    let view = page(app, id)?;
    let wrapped = format!(
        "(() => {{ try {{ return JSON.stringify({{ ok: (() => {{ {script} }})() }}); }} catch (e) {{ return JSON.stringify({{ error: String(e && e.message || e) }}); }} }})()"
    );
    let (tx, rx) = mpsc::channel::<String>();
    view.eval_with_callback(wrapped, move |result| {
        let _ = tx.send(result);
    })
    .map_err(|e| format!("Couldn't run a script in the page: {e}"))?;
    let raw = rx
        .recv_timeout(Duration::from_secs(20))
        .map_err(|_| "The page didn't answer in time (still loading?).".to_string())?;
    // The engine returns the script's value as JSON: here a JSON string holding our JSON.
    let inner: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let text = inner.as_str().unwrap_or("null");
    let out: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    if let Some(err) = out.get("error") {
        return Err(format!(
            "The page script failed: {}",
            err.as_str().unwrap_or("?")
        ));
    }
    Ok(out.get("ok").cloned().unwrap_or(Value::Null))
}

fn active(app: &AppHandle, id: Option<u32>) -> Result<u32, String> {
    id.or(app.state::<Browser>().inner.lock().unwrap().active)
        .ok_or_else(|| "No page is open in the browser.".to_string())
}

/// The dashboard (re)loads: no page shows until its Browser view places them again. Without
/// this a restart left the pages over the chat (the user's report, 2026-10-28).
pub fn dashboard_loading(app: &AppHandle) {
    app.state::<Browser>().inner.lock().unwrap().visible = false;
    layout(app);
}

/// Everything the dashboard asks of the browser: open, navigate, back, forward, reload, close,
/// select a page, place the browser over its tab, run a script in a page, or list the pages.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser(
    app: AppHandle,
    action: String,
    id: Option<u32>,
    url: Option<String>,
    script: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    w: Option<f64>,
    h: Option<f64>,
    visible: Option<bool>,
) -> Result<Value, String> {
    // Webviews are made and driven off the command thread (eval waits for the page's answer).
    tauri::async_runtime::spawn_blocking(move || {
        let result = match action.as_str() {
            "open" => {
                let target = parse_url(url.as_deref().unwrap_or("about:blank"))?;
                let id = open(&app, target)?;
                layout(&app);
                json!({ "id": id })
            }
            "navigate" => {
                let target = parse_url(url.as_deref().unwrap_or(""))?;
                let id = active(&app, id)?;
                page(&app, id)?
                    .navigate(target)
                    .map_err(|e| e.to_string())?;
                json!({ "id": id })
            }
            "back" | "forward" => {
                let id = active(&app, id)?;
                let go = if action == "back" { "back" } else { "forward" };
                page(&app, id)?
                    .eval(format!("history.{go}()"))
                    .map_err(|e| e.to_string())?;
                json!({ "id": id })
            }
            "reload" => {
                let id = active(&app, id)?;
                page(&app, id)?.reload().map_err(|e| e.to_string())?;
                json!({ "id": id })
            }
            "close" => {
                let id = active(&app, id)?;
                page(&app, id)?.close().map_err(|e| e.to_string())?;
                let browser = app.state::<Browser>();
                let mut s = browser.inner.lock().unwrap();
                let at = s.pages.iter().position(|&p| p == id);
                s.pages.retain(|&p| p != id);
                s.titles.remove(&id);
                s.loading.remove(&id);
                if s.active == Some(id) {
                    s.active = at
                        .and_then(|i| s.pages.get(i.min(s.pages.len().saturating_sub(1))).copied())
                        .or(s.pages.last().copied());
                }
                drop(s);
                layout(&app);
                json!({ "id": id })
            }
            "select" => {
                let id = id.ok_or("Which page?")?;
                page(&app, id)?;
                app.state::<Browser>().inner.lock().unwrap().active = Some(id);
                layout(&app);
                json!({ "id": id })
            }
            "place" => {
                {
                    let browser = app.state::<Browser>();
                    let mut s = browser.inner.lock().unwrap();
                    if let (Some(x), Some(y), Some(w), Some(h)) = (x, y, w, h) {
                        s.bounds = Some((x, y, w, h));
                    }
                    s.visible = visible.unwrap_or(s.visible);
                }
                layout(&app);
                // Nothing changed for the dashboard's tabs; no state event.
                return Ok(Value::Null);
            }
            "eval" => {
                let id = active(&app, id)?;
                eval(&app, id, script.as_deref().unwrap_or("return null"))?
            }
            "list" => Value::Null,
            other => return Err(format!("Unknown browser action {other}.")),
        };
        emit_state(&app);
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Linux: Tauri packs a window's webviews one under the other in its vertical box, so a page
/// showed below the whole dashboard and ignored its place (the user's report, 2026-10-28).
/// The first page moves the dashboard into a GtkOverlay in that box; every page floats over
/// it at the place layout() gives. Runs on GTK's thread through with_webview.
#[cfg(target_os = "linux")]
mod overlay {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use gtk::prelude::*;
    use tauri::Webview;

    thread_local! {
        /// Each page's place in the overlay (logical px), by its widget name (the page's label).
        static PLACES: RefCell<HashMap<String, (i32, i32, i32, i32)>> = RefCell::new(HashMap::new());
    }

    /// The overlay in the window's box, made around the dashboard the first time.
    fn overlay_in(boxed: &gtk::Box, page: &gtk::Widget) -> gtk::Overlay {
        let children = boxed.children();
        if let Some(found) = children
            .iter()
            .find_map(|c| c.clone().downcast::<gtk::Overlay>().ok())
        {
            return found;
        }
        let overlay = gtk::Overlay::new();
        // Exact places: an overlay child otherwise gets its own preferred size.
        overlay.connect_get_child_position(|_, child| {
            let name = child.widget_name().to_string();
            PLACES.with(|p| {
                p.borrow()
                    .get(&name)
                    .map(|&(x, y, w, h)| gtk::Allocation::new(x, y, w, h))
            })
        });
        if let Some(dashboard) = children.iter().find(|c| *c != page) {
            boxed.remove(dashboard);
            overlay.add(dashboard);
        }
        boxed.pack_start(&overlay, true, true, 0);
        overlay.show();
        overlay
    }

    /// Moves a new page from the window's box into the overlay.
    pub fn adopt(view: &Webview) {
        let name = view.label().to_string();
        let _ = view.with_webview(move |platform| {
            let page: gtk::Widget = platform.inner().upcast();
            page.set_widget_name(&name);
            let Some(boxed) = page.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) else {
                return;
            };
            let overlay = overlay_in(&boxed, &page);
            boxed.remove(&page);
            overlay.add_overlay(&page);
        });
    }

    /// Puts a page at its place over the dashboard.
    pub fn place(view: &Webview, x: f64, y: f64, w: f64, h: f64) {
        let name = view.label().to_string();
        let place = (
            x.round() as i32,
            y.round() as i32,
            w.round() as i32,
            h.round() as i32,
        );
        let _ = view.with_webview(move |platform| {
            PLACES.with(|p| p.borrow_mut().insert(name, place));
            let page: gtk::Widget = platform.inner().upcast();
            page.queue_resize();
        });
    }
}

/// The pages and the active one, for a dashboard that (re)loads.
#[tauri::command]
pub fn browser_state(app: AppHandle) {
    emit_state(&app);
}
