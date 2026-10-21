// refs popup: tray icon, global hotkey and a window kept hidden and pre-rendered, so the
// hotkey only has to show it. All library logic lives in the Node sidecar (@refs/core);
// this side starts it, keeps it alive, and relays its JSON lines to the frontend.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_RESTARTS_PER_MINUTE: usize = 5;

struct Sidecar {
    node: PathBuf,
    script: PathBuf,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    quitting: AtomicBool,
}

#[derive(Default)]
struct Popup {
    /// When the hotkey last fired, for the hotkey-to-painted measurement.
    hotkey_at: Mutex<Option<Instant>>,
    /// The registered accelerator, kept so Resume can register it again.
    hotkey: Mutex<Option<String>>,
    paused: AtomicBool,
}

/// %LOCALAPPDATA%\refs, read from the environment like the rest of refs (so a sandbox moves it).
fn data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("refs")
}

fn log_path() -> PathBuf {
    data_dir().join("logs").join("popup.log")
}

fn log(line: &str) {
    let path = log_path();
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
        let _ = writeln!(f, "{secs:.3} {line}");
    }
}

/// --node and --sidecar from the logon entry; otherwise node.exe on PATH and the
/// sidecar in the checkout this exe was built in (target\release -> repo root).
fn sidecar_paths() -> (PathBuf, PathBuf) {
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(PathBuf::from);
    let node = arg("--node").unwrap_or_else(|| PathBuf::from("node.exe"));
    let script = arg("--sidecar").unwrap_or_else(|| {
        let exe = std::env::current_exe().unwrap_or_default();
        let repo = exe.ancestors().nth(5).map(PathBuf::from).unwrap_or_default();
        repo.join("packages").join("sidecar").join("src").join("main.ts")
    });
    (node, script)
}

fn spawn_sidecar(sc: &Sidecar) -> std::io::Result<std::process::ChildStdout> {
    let mut child = Command::new(&sc.node)
        .arg(&sc.script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log(&format!("sidecar: {line}"));
            }
        });
    }
    *sc.stdin.lock().unwrap() = child.stdin.take();
    *sc.child.lock().unwrap() = Some(child);
    Ok(stdout)
}

/// Runs the sidecar for as long as the popup runs, restarting it when it exits
/// (at most 5 times a minute; after that the frontend shows that it is down).
fn supervise(app: AppHandle, sc: Arc<Sidecar>) {
    std::thread::spawn(move || {
        let mut starts: Vec<Instant> = Vec::new();
        loop {
            starts.retain(|t| t.elapsed() < Duration::from_secs(60));
            if starts.len() >= MAX_RESTARTS_PER_MINUTE {
                log("sidecar keeps exiting; giving up until the popup restarts");
                let _ = app.emit("sidecar-down", "the sidecar keeps exiting; see logs\\popup.log");
                return;
            }
            starts.push(Instant::now());
            match spawn_sidecar(&sc) {
                Ok(stdout) => {
                    if starts.len() > 1 {
                        let _ = app.emit("sidecar-restarted", ());
                    }
                    let mut first = true;
                    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                        if first {
                            log("sidecar answering");
                            first = false;
                        }
                        if let Err(e) = app.emit("sidecar", line) {
                            log(&format!("could not pass a sidecar reply to the window: {e}"));
                        }
                    }
                    if let Some(mut child) = sc.child.lock().unwrap().take() {
                        let status = child.wait();
                        if !sc.quitting.load(Ordering::SeqCst) {
                            log(&format!("sidecar exited: {status:?}"));
                        }
                    }
                }
                Err(e) => log(&format!("could not start the sidecar ({} {}): {e}", sc.node.display(), sc.script.display())),
            }
            if sc.quitting.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

fn show_popup(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = app.emit("popup-shown", ());
    }
}

fn quit(app: &AppHandle) {
    let sc = app.state::<Arc<Sidecar>>();
    sc.quitting.store(true, Ordering::SeqCst);
    // Closing stdin makes the sidecar exit by itself; kill covers a stuck one.
    sc.stdin.lock().unwrap().take();
    if let Some(mut child) = sc.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    app.exit(0);
}

#[tauri::command]
fn sidecar_send(sc: State<Arc<Sidecar>>, line: String) -> Result<(), String> {
    let mut guard = sc.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or("the sidecar is not running")?;
    stdin.write_all(line.as_bytes()).and_then(|_| stdin.write_all(b"\n")).and_then(|_| stdin.flush()).map_err(|e| e.to_string())
}

/// Register the hotkey from config.json (already checked by the sidecar), replacing any other.
#[tauri::command]
fn set_hotkey(app: AppHandle, popup: State<Popup>, accelerator: String) -> Result<String, String> {
    let shortcut: Shortcut = accelerator.parse().map_err(|e| format!("{accelerator}: {e}"))?;
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    if !popup.paused.load(Ordering::SeqCst) {
        gs.register(shortcut).map_err(|e| format!("{accelerator} could not be registered (another app may own it): {e}"))?;
    }
    *popup.hotkey.lock().unwrap() = Some(accelerator.clone());
    log(&format!("hotkey {accelerator}"));
    Ok(accelerator)
}

#[tauri::command]
fn hide_popup(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// Frontend errors and milestones, so a release build without devtools can still be diagnosed.
#[tauri::command]
fn log_line(line: String) {
    log(&format!("frontend: {}", line.chars().take(2000).collect::<String>()));
}

/// The frontend calls this once the shown window has painted (two animation frames).
#[tauri::command]
fn shown_ack(popup: State<Popup>) -> Option<f64> {
    let at = popup.hotkey_at.lock().unwrap().take()?;
    let ms = at.elapsed().as_secs_f64() * 1000.0;
    log(&format!("hotkey to painted: {ms:.1} ms"));
    Some(ms)
}

fn toggle_pause(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let popup = app.state::<Popup>();
    let paused = !popup.paused.load(Ordering::SeqCst);
    popup.paused.store(paused, Ordering::SeqCst);
    let gs = app.global_shortcut();
    if paused {
        let _ = gs.unregister_all();
    } else if let Some(acc) = popup.hotkey.lock().unwrap().clone() {
        if let Ok(s) = acc.parse::<Shortcut>() {
            let _ = gs.register(s);
        }
    }
    let _ = item.set_checked(paused);
    log(if paused { "hotkey paused" } else { "hotkey resumed" });
}

fn main() {
    let (node, script) = sidecar_paths();
    let sidecar = Arc::new(Sidecar { node, script, stdin: Mutex::new(None), child: Mutex::new(None), quitting: AtomicBool::new(false) });

    tauri::Builder::default()
        // A second launch (logon entry plus a manual start) just shows this one.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_popup(app)))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        *app.state::<Popup>().hotkey_at.lock().unwrap() = Some(Instant::now());
                        show_popup(app);
                    }
                })
                .build(),
        )
        .manage(sidecar.clone())
        .manage(Popup::default())
        .invoke_handler(tauri::generate_handler![sidecar_send, set_hotkey, hide_popup, shown_ack, log_line])
        .setup(move |app| {
            log("popup started");
            let handle = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("refs")
                .inner_size(760.0, 520.0)
                .decorations(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .center()
                .visible(false)
                // WebView2's profile goes with the other rebuildable data, not %LOCALAPPDATA%\<identifier>.
                .data_directory(data_dir().join("webview"))
                // The page never navigates: links in sheets open in the browser through the sidecar.
                .on_navigation(|url| url.host_str() == Some("tauri.localhost") || url.scheme() == "tauri")
                .build()?;
            let w = window.clone();
            window.on_window_event(move |e| {
                if let WindowEvent::Focused(false) = e {
                    let _ = w.hide();
                }
            });

            let open_i = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            let pause_i = CheckMenuItem::with_id(app, "pause", "Pause hotkey", true, false, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &pause_i, &quit_i])?;
            let pause_item = pause_i.clone();
            TrayIconBuilder::with_id("refs")
                .icon(app.default_window_icon().cloned().ok_or("no app icon")?)
                .tooltip("refs")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => show_popup(app),
                    "pause" => toggle_pause(app, &pause_item),
                    "quit" => quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_popup(tray.app_handle());
                    }
                })
                .build(app)?;

            supervise(handle, sidecar.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("refs popup failed to start");
}
