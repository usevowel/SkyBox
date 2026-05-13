use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Configuration for a WebSocket listener, serialized from either
/// `app.enableWebSockets()` (script API) or `boxlang.json` (JSON config).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSocketConfig {
    pub uri: String,
    pub listener_class: String,
    pub listener_state: serde_json::Value,
    #[serde(default = "default_handler")]
    pub handler: String,
}

fn default_handler() -> String {
    "WebSocket.bx".to_string()
}

/// HTTP request metadata captured when a WebSocket connection is established.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RequestData {
    pub method: String,
    pub path: String,
    pub matched_route: Option<String>,
    pub route_params: HashMap<String, String>,
    pub raw_query: Option<String>,
    pub query: HashMap<String, String>,
    pub cookies: HashMap<String, String>,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub full_url: String,
}

/// Messages sent from the BoxLang VM to the JS host (or test harness).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CalloutMessage {
    #[serde(rename = "send")]
    Send {
        connection_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        binary: Option<Vec<u8>>,
    },
    #[serde(rename = "broadcast")]
    Broadcast {
        sender_connection_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        binary: Option<Vec<u8>>,
    },
    #[serde(rename = "close")]
    Close {
        connection_id: String,
        code: u16,
        reason: String,
    },
    /// Call a Cloudflare binding (D1, R2, KV, Queue, etc.)
    /// The binding name + action + args are forwarded to the JS host.
    #[serde(rename = "binding_call")]
    BindingCall {
        async_id: u64,
        binding_name: String,
        action: String,
        args: serde_json::Value,
    },
}

/// Result of processing a callout — the response from JS (or test harness).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalloutResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// For async binding calls: the async_id to poll/resolve later.
    /// 0 means synchronous completion.
    #[serde(default)]
    pub async_id: u64,
    /// Result data from binding calls (query results, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// Bridge for communicating between the Rust VM and the JS host.
///
/// On WASM targets, this serializes messages and calls JS functions via
/// wasm-bindgen. On native targets (tests), it uses an mpsc channel.
pub trait CalloutBridge {
    fn send_callout(&mut self, msg: &CalloutMessage) -> Result<CalloutResult, String>;
}
