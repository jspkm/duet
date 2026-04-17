//! Manages the Python sidecar process.
//!
//! Spawns duet-sidecar as a child process, communicates via stdin/stdout JSON lines.
//! Progress events are forwarded to the frontend as Tauri events.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize)]
struct SidecarRequest {
    command: String,
    params: Value,
}

#[derive(Debug, Deserialize)]
struct SidecarResponse {
    #[serde(rename = "type")]
    response_type: String,
    #[serde(default)]
    data: Option<Value>,
    #[serde(default)]
    message: Option<String>,
}

pub struct SidecarManager {
    child: Mutex<Option<Child>>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }

    /// Start the sidecar process if not already running.
    pub fn ensure_running(&self) -> Result<(), String> {
        let mut child_guard = self.child.lock().map_err(|e| e.to_string())?;

        // Check if already running
        if let Some(ref mut child) = *child_guard {
            match child.try_wait() {
                Ok(None) => return Ok(()), // still running
                _ => {} // exited or error, restart
            }
        }

        let child = Command::new("python3")
            .arg("-m")
            .arg("duet_sidecar.main")
            .current_dir(sidecar_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start sidecar: {}", e))?;

        *child_guard = Some(child);
        Ok(())
    }

    /// Send a command to the sidecar and collect the result.
    /// Progress events are forwarded to the frontend via Tauri events.
    pub fn send_command(
        &self,
        command: &str,
        params: Value,
        app: &AppHandle,
    ) -> Result<Value, String> {
        self.ensure_running()?;

        let mut child_guard = self.child.lock().map_err(|e| e.to_string())?;
        let child = child_guard.as_mut().ok_or("Sidecar not running")?;

        // Write request to stdin
        let stdin = child.stdin.as_mut().ok_or("No stdin")?;
        let request = SidecarRequest {
            command: command.to_string(),
            params,
        };
        let mut request_json = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        request_json.push('\n');
        stdin
            .write_all(request_json.as_bytes())
            .map_err(|e| format!("Failed to write to sidecar: {}", e))?;
        stdin
            .flush()
            .map_err(|e| format!("Failed to flush sidecar stdin: {}", e))?;

        // Read responses line by line until we get a result or error
        let stdout = child.stdout.as_mut().ok_or("No stdout")?;
        let reader = BufReader::new(stdout);

        for line in reader.lines() {
            let line = line.map_err(|e| format!("Failed to read from sidecar: {}", e))?;
            if line.is_empty() {
                continue;
            }

            // Skip non-JSON lines (library warnings, log messages, etc.)
            let response: SidecarResponse = match serde_json::from_str(&line) {
                Ok(r) => r,
                Err(_) => continue,
            };

            match response.response_type.as_str() {
                "progress" => {
                    // Forward progress to frontend
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("sidecar-progress", &line);
                    }
                }
                "result" => {
                    return response.data.ok_or("Result missing data field".to_string());
                }
                "error" => {
                    return Err(response
                        .message
                        .unwrap_or_else(|| "Unknown sidecar error".to_string()));
                }
                _ => {
                    log::warn!("Unknown sidecar response type: {}", response.response_type);
                }
            }
        }

        Err("Sidecar closed unexpectedly".to_string())
    }

    /// Kill the sidecar process.
    pub fn stop(&self) {
        if let Ok(mut child_guard) = self.child.lock() {
            if let Some(mut child) = child_guard.take() {
                let _ = child.kill();
            }
        }
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.stop();
    }
}

fn sidecar_dir() -> String {
    // In dev, the sidecar is at ../sidecar relative to src-tauri
    // In production, it would be bundled via PyInstaller
    let dev_path = std::env::current_dir()
        .map(|p| p.join("../sidecar"))
        .unwrap_or_default();

    if dev_path.exists() {
        dev_path.to_string_lossy().to_string()
    } else {
        // Fallback for bundled app
        "sidecar".to_string()
    }
}
