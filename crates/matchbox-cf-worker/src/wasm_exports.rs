//! WASM Exports — Functions callable from the JS `MatchBoxWebSocketDO` class.
//!
//! These functions are exported via `#[wasm_bindgen]` and called by the
//! JS shell. They use a global `DoState` stored in a thread-local or static
//! variable. Since WASM is single-threaded and each DO runs in its own
//! isolate (in workerd), a single static is safe.

use crate::do_adapter::DoState;
use crate::do_adapter::wasm_bridge::WasmCalloutBridge;
use crate::types::{RequestData, WebSocketConfig};
use crate::wasm_metadata;
use matchbox_vm::vm::chunk::Chunk;
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;

// Global state for the DO. A new DO instance in workerd gets a fresh WASM
// instance, so globals are isolated per-DO.
thread_local! {
    static DO_STATE: RefCell<Option<DoState>> = const { RefCell::new(None) };
    static CHUNK: RefCell<Option<Chunk>> = const { RefCell::new(None) };
    static WS_CONFIG: RefCell<Option<WebSocketConfig>> = const { RefCell::new(None) };
}

/// Initialize the VM with a compiled chunk from JS.
///
/// `config_json`: JSON string of WebSocketConfig
/// `chunk_bytes`: postcard-serialized bytecode Chunk
#[wasm_bindgen]
pub fn vm_init(config_json: &str, chunk_bytes: &[u8]) -> Result<(), JsValue> {
    // Step 1: parse config
    let config: WebSocketConfig = match serde_json::from_str(config_json) {
        Ok(c) => c,
        Err(e) => return Err(JsValue::from_str(&format!("config JSON: {}", e))),
    };

    if chunk_bytes.is_empty() {
        return Err(JsValue::from_str("chunk_bytes is empty"));
    }

    // Step 2: decode chunk
    let chunk = match wasm_metadata::decode_chunk(chunk_bytes) {
        Ok(c) => c,
        Err(e) => return Err(JsValue::from_str(&format!("decode chunk: {}", e))),
    };

    // Step 3: store config
    WS_CONFIG.with(|cfg| {
        *cfg.borrow_mut() = Some(config.clone());
    });

    // Step 4: store chunk
    CHUNK.with(|c| {
        *c.borrow_mut() = Some(chunk.clone());
    });

    // Step 5: create DoState
    let bridge = Rc::new(RefCell::new(WasmCalloutBridge));
    let state = match DoState::new(chunk, &config, bridge) {
        Ok(s) => s,
        Err(e) => return Err(JsValue::from_str(&format!("DoState::new: {}", e))),
    };

    // Step 6: store state
    DO_STATE.with(|s| {
        *s.borrow_mut() = Some(state);
    });

    Ok(())
}

/// Rehydrate the listener's instance state from a JSON snapshot.
/// Called after DO wakes from hibernation — DO storage provides the
/// persisted state that was saved by `vm_get_state`.
#[wasm_bindgen]
pub fn vm_set_state(state_json: &str) -> Result<(), JsValue> {
    let state_val: serde_json::Value = serde_json::from_str(state_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid state JSON: {}", e)))?;

    DO_STATE.with(|s| {
        let mut state = s.borrow_mut();
        let state = state.as_mut().ok_or_else(|| {
            JsValue::from_str("DO_STATE not initialized. Call vm_init first.")
        })?;
        state.set_state(&state_val).map_err(|e| JsValue::from_str(&e))
    })
}

/// Re-register a connection channel after DO wakes from hibernation.
/// Called for each WebSocket that was re-attached via `getWebSockets()`.
#[wasm_bindgen]
pub fn vm_register_connection(connection_id: &str, request_json: &str) -> Result<(), JsValue> {
    let request: RequestData = serde_json::from_str(request_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid RequestData: {}", e)))?;

    DO_STATE.with(|s| {
        let mut state = s.borrow_mut();
        let state = state.as_mut().ok_or_else(|| {
            JsValue::from_str("DO_STATE not initialized. Call vm_init first.")
        })?;
        state
            .register_connection(connection_id, request)
            .map_err(|e| JsValue::from_str(&e))
    })
}

/// Handle a new WebSocket connection: call `listener.onConnect(channel)`.
#[wasm_bindgen]
pub fn vm_on_connect(connection_id: &str, request_json: &str) -> Result<(), JsValue> {
    let request: RequestData = serde_json::from_str(request_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid RequestData: {}", e)))?;

    DO_STATE.with(|s| {
        let mut state = s.borrow_mut();
        let state = state.as_mut().ok_or_else(|| {
            JsValue::from_str("DO_STATE not initialized. Call vm_init first.")
        })?;
        state
            .on_connect(connection_id, request)
            .map_err(|e| JsValue::from_str(&e))
    })
}

/// Handle a WebSocket message: call `listener.onMessage(message, channel)`.
///
/// `msg_type`: 0 = text, 1 = binary
#[wasm_bindgen]
pub fn vm_on_message(connection_id: &str, msg_type: u8, message: &[u8]) -> Result<(), JsValue> {
    DO_STATE.with(|s| {
        let mut state = s.borrow_mut();
        let state = state.as_mut().ok_or_else(|| {
            JsValue::from_str("DO_STATE not initialized. Call vm_init first.")
        })?;
        state
            .on_message(connection_id, msg_type, message)
            .map_err(|e| JsValue::from_str(&e))
    })
}

/// Handle a WebSocket close: call `listener.onClose(channel)`.
#[wasm_bindgen]
pub fn vm_on_close(connection_id: &str) -> Result<(), JsValue> {
    DO_STATE.with(|s| {
        let mut state = s.borrow_mut();
        let state = state.as_mut().ok_or_else(|| {
            JsValue::from_str("DO_STATE not initialized. Call vm_init first.")
        })?;
        state
            .on_close(connection_id)
            .map_err(|e| JsValue::from_str(&e))
    })
}

/// Serialize the current listener instance state to JSON for DO storage.
/// Called after every `onMessage` to persist changes.
#[wasm_bindgen]
pub fn vm_get_state() -> Result<String, JsValue> {
    DO_STATE.with(|s| {
        let state = s.borrow();
        let state = state.as_ref().ok_or_else(|| {
            JsValue::from_str("DO_STATE not initialized. Call vm_init first.")
        })?;
        let json = state
            .get_state()
            .map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&json).map_err(|e| JsValue::from_str(&e.to_string()))
    })
}

