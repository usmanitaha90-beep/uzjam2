use crate::audio_host::AudioHost;
use serde::{Deserialize, Serialize};
use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
#[cfg(windows)]
use tungstenite::{accept_hdr, Error as WebSocketError, Message};

pub const BRIDGE_PROTOCOL: u16 = 1;
const FIRST_BRIDGE_PORT: u16 = 39_847;
const LAST_BRIDGE_PORT: u16 = 39_857;
const MAX_PCM_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionBridgeStatus {
    pub available: bool,
    pub protocol: u16,
    pub port: u16,
    pub pairing_code: String,
    pub connected: bool,
    pub streaming: bool,
    pub tab_title: Option<String>,
    pub browser: Option<String>,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub last_packet_at_ms: u64,
    pub last_error: Option<String>,
}

impl ExtensionBridgeStatus {
    fn initial(pairing_code: String) -> Self {
        Self {
            available: cfg!(windows),
            protocol: BRIDGE_PROTOCOL,
            port: 0,
            pairing_code,
            connected: false,
            streaming: false,
            tab_title: None,
            browser: None,
            sample_rate_hz: 0,
            channels: 0,
            last_packet_at_ms: 0,
            last_error: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientHello {
    #[serde(rename = "type")]
    message_type: String,
    protocol: u16,
    pairing_code: String,
    sample_rate_hz: u32,
    channels: u16,
    tab_title: Option<String>,
    browser: Option<String>,
}

pub struct ExtensionBridge {
    status: Arc<Mutex<ExtensionBridgeStatus>>,
    stop_generation: Arc<AtomicU64>,
    shutdown: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl ExtensionBridge {
    pub fn start(data_directory: &Path, audio: Arc<Mutex<AudioHost>>) -> Self {
        let pairing_code =
            load_or_create_pairing_code(data_directory).unwrap_or_else(|_| fallback_pairing_code());
        let status = Arc::new(Mutex::new(ExtensionBridgeStatus::initial(
            pairing_code.clone(),
        )));
        let stop_generation = Arc::new(AtomicU64::new(0));
        let shutdown = Arc::new(AtomicBool::new(false));

        #[cfg(windows)]
        let worker = {
            let worker_status = Arc::clone(&status);
            let worker_stop_generation = Arc::clone(&stop_generation);
            let worker_shutdown = Arc::clone(&shutdown);
            thread::Builder::new()
                .name("uzjam-extension-bridge".into())
                .spawn(move || {
                    run_server(
                        worker_status,
                        pairing_code,
                        audio,
                        worker_stop_generation,
                        worker_shutdown,
                    )
                })
                .ok()
        };

        #[cfg(not(windows))]
        let worker = {
            let _ = audio;
            None
        };

        Self {
            status,
            stop_generation,
            shutdown,
            worker,
        }
    }

    pub fn status(&self) -> ExtensionBridgeStatus {
        self.status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn stop_capture(&self) {
        self.stop_generation.fetch_add(1, Ordering::AcqRel);
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        status.streaming = false;
    }

    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
        self.stop_capture();
    }
}

impl Drop for ExtensionBridge {
    fn drop(&mut self) {
        self.shutdown();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn load_or_create_pairing_code(data_directory: &Path) -> Result<String, String> {
    let path = data_directory.join("extension-pairing-code.txt");
    if let Ok(existing) = fs::read_to_string(&path) {
        let code = normalize_pairing_code(&existing);
        if code.len() == 10 {
            return Ok(code);
        }
    }
    fs::create_dir_all(data_directory)
        .map_err(|error| format!("create app data directory: {error}"))?;
    let mut bytes = [0_u8; 5];
    getrandom::fill(&mut bytes).map_err(|error| format!("generate pairing code: {error}"))?;
    let code = bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>();
    fs::write(path, &code).map_err(|error| format!("save pairing code: {error}"))?;
    Ok(code)
}

fn fallback_pairing_code() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{:010X}",
        (now ^ std::process::id() as u128) & 0xFF_FFFF_FFFF
    )
}

fn normalize_pairing_code(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_hexdigit())
        .map(|character| character.to_ascii_uppercase())
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(windows)]
fn run_server(
    status: Arc<Mutex<ExtensionBridgeStatus>>,
    pairing_code: String,
    audio: Arc<Mutex<AudioHost>>,
    stop_generation: Arc<AtomicU64>,
    shutdown: Arc<AtomicBool>,
) {
    let listener = (FIRST_BRIDGE_PORT..=LAST_BRIDGE_PORT).find_map(|port| {
        TcpListener::bind(("127.0.0.1", port))
            .ok()
            .map(|listener| (port, listener))
    });
    let Some((port, listener)) = listener else {
        let mut current = status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        current.available = false;
        current.last_error = Some(format!(
            "Ports {FIRST_BRIDGE_PORT}-{LAST_BRIDGE_PORT} are already in use."
        ));
        return;
    };
    if listener.set_nonblocking(true).is_err() {
        let mut current = status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        current.available = false;
        current.last_error = Some("The local extension bridge could not start.".into());
        return;
    }
    {
        let mut current = status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        current.available = true;
        current.port = port;
        current.last_error = None;
    }

    while !shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => handle_connection(
                stream,
                &status,
                &pairing_code,
                &audio,
                &stop_generation,
                &shutdown,
            ),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(80));
            }
            Err(error) => {
                status
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .last_error = Some(format!("Extension bridge connection failed: {error}"));
                thread::sleep(Duration::from_millis(250));
            }
        }
    }
}

#[cfg(windows)]
#[allow(clippy::result_large_err)]
fn handle_connection(
    stream: TcpStream,
    status: &Arc<Mutex<ExtensionBridgeStatus>>,
    pairing_code: &str,
    audio: &Arc<Mutex<AudioHost>>,
    stop_generation: &AtomicU64,
    shutdown: &AtomicBool,
) {
    let websocket = accept_hdr(stream, |request: &Request, response: Response| {
        let valid_origin = request
            .headers()
            .get("origin")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|origin| origin.starts_with("chrome-extension://"));
        let valid_path = request.uri().path() == "/uzjam-tab-audio";
        if valid_origin && valid_path {
            Ok(response)
        } else {
            let rejection = http_rejection("UZjam accepts its Chrome extension only.");
            Err(rejection)
        }
    });
    let Ok(mut websocket) = websocket else {
        return;
    };
    let _ = websocket
        .get_mut()
        .set_read_timeout(Some(Duration::from_secs(5)));
    let hello = match websocket.read() {
        Ok(Message::Text(text)) => serde_json::from_str::<ClientHello>(&text).ok(),
        _ => None,
    };
    let Some(hello) = hello else {
        let _ = websocket.send(Message::Text(
            r#"{"type":"error","message":"A valid UZjam hello message is required."}"#.into(),
        ));
        return;
    };
    if hello.message_type != "hello"
        || hello.protocol != BRIDGE_PROTOCOL
        || normalize_pairing_code(&hello.pairing_code) != pairing_code
        || !(8_000..=384_000).contains(&hello.sample_rate_hz)
        || hello.channels == 0
        || hello.channels > 8
    {
        let _ = websocket.send(Message::Text(
            r#"{"type":"error","message":"Pairing code or audio format was rejected."}"#.into(),
        ));
        return;
    }
    let _ = websocket
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(250)));
    {
        let mut current = status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        current.connected = true;
        current.streaming = false;
        current.tab_title = hello
            .tab_title
            .clone()
            .map(|title| truncate_text(&title, 120));
        current.browser = hello.browser.clone().map(|name| truncate_text(&name, 40));
        current.sample_rate_hz = hello.sample_rate_hz;
        current.channels = hello.channels;
        current.last_error = None;
    }
    let _ = websocket.send(Message::Text(
        format!(r#"{{"type":"ready","protocol":{BRIDGE_PROTOCOL}}}"#).into(),
    ));
    let connection_generation = stop_generation.load(Ordering::Acquire);

    while !shutdown.load(Ordering::Acquire) {
        if stop_generation.load(Ordering::Acquire) != connection_generation {
            let _ = websocket.send(Message::Text(
                r#"{"type":"stop","reason":"Stopped in UZjam"}"#.into(),
            ));
            let _ = websocket.close(None);
            break;
        }
        match websocket.read() {
            Ok(Message::Binary(bytes)) => {
                if bytes.is_empty() || bytes.len() > MAX_PCM_BYTES || bytes.len() % 4 != 0 {
                    let _ = websocket.send(Message::Text(
                        r#"{"type":"error","message":"Invalid PCM packet."}"#.into(),
                    ));
                    break;
                }
                let (chunks, _) = bytes.as_chunks::<4>();
                let samples = chunks
                    .iter()
                    .map(|chunk| f32::from_le_bytes(*chunk))
                    .collect::<Vec<_>>();
                let pushed = audio
                    .lock()
                    .map_err(|_| "The audio engine is unavailable.".to_string())
                    .and_then(|host| {
                        host.push_external_pcm(samples, hello.sample_rate_hz, hello.channels)
                    });
                let mut current = status
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                match pushed {
                    Ok(()) => {
                        current.streaming = true;
                        current.last_packet_at_ms = now_ms();
                        current.last_error = None;
                    }
                    Err(error) => {
                        current.streaming = false;
                        current.last_error = Some(error.clone());
                        drop(current);
                        let payload = serde_json::json!({
                            "type": "error",
                            "message": error,
                        });
                        let _ = websocket.send(Message::Text(payload.to_string().into()));
                        break;
                    }
                }
            }
            Ok(Message::Text(text)) => {
                if text.contains("\"type\":\"stopped\"") {
                    break;
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(data)) => {
                let _ = websocket.send(Message::Pong(data));
            }
            Ok(_) => {}
            Err(WebSocketError::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => break,
        }
    }
    let mut current = status
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    current.connected = false;
    current.streaming = false;
}

#[cfg(windows)]
fn http_rejection(message: &str) -> ErrorResponse {
    tungstenite::http::Response::builder()
        .status(403)
        .body(Some(message.to_string()))
        .expect("static WebSocket rejection is valid")
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_codes_are_normalized_for_human_entry() {
        assert_eq!(normalize_pairing_code("aa-bb 01 cc dd"), "AABB01CCDD");
    }

    #[test]
    fn labels_are_bounded_by_characters() {
        assert_eq!(truncate_text("🎵abcdef", 4), "🎵abc");
    }
}
