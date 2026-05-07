//! DO Adapter — Bridges the Durable Object lifecycle to the BoxLang VM.
//!
//! This module provides the core logic that the JS `MatchBoxWebSocketDO` class
//! calls via WASM exports. It manages a single BoxLang VM instance that hosts
//! the listener class and channel registry for all WebSocket connections on
//! a particular DO.

use crate::channel::CfWebSocketChannelObject;
use crate::types::{CalloutBridge, CalloutMessage, CalloutResult, RequestData, WebSocketConfig};
use matchbox_vm::types::{BxValue, BxVM};
use matchbox_vm::vm::chunk::Chunk;
use matchbox_vm::vm::VM;
use std::cell::RefCell;
use std::rc::Rc;

/// Holds the state for one Durable Object instance.
///
/// Contains the BoxLang VM, the listener instance, and the channel registry
/// that maps connection IDs to native channel objects.
pub struct DoState {
    pub vm: VM,
    pub listener: BxValue,
    pub channel_registry_id: usize,
    pub bridge: Rc<RefCell<dyn CalloutBridge>>,
}

impl DoState {
    /// Initialize the VM, load the chunk, instantiate the listener, and
    /// restore state.
    pub fn new(
        chunk: Chunk,
        config: &WebSocketConfig,
        bridge: Rc<RefCell<dyn CalloutBridge>>,
    ) -> Result<Self, String> {
        let mut vm = VM::new();
        vm.interpret(chunk).map_err(|e| e.to_string())?;

        let listener = vm
            .instantiate_global_class_without_constructor(&config.listener_class)
            .map_err(|e| e.to_string())?;

        vm.set_instance_variables_json(listener, config.listener_state.clone())
            .map_err(|e| e.to_string())?;

        let channel_registry_id = vm.struct_new();
        vm.insert_global("__websocketlistener".to_string(), listener);
        vm.insert_global(
            "__websocketconnections".to_string(),
            BxValue::new_ptr(channel_registry_id),
        );

        Ok(Self {
            vm,
            listener,
            channel_registry_id,
            bridge,
        })
    }

    /// Rehydrate listener state from a JSON snapshot (called after DO wakes
    /// from hibernation).
    pub fn set_state(&mut self, state_json: &serde_json::Value) -> Result<(), String> {
        self.vm
            .set_instance_variables_json(self.listener, state_json.clone())
            .map_err(|e| e.to_string())
    }

    /// Serialize the current listener instance variables to JSON for DO
    /// storage persistence.
    pub fn get_state(&self) -> Result<serde_json::Value, String> {
        self.vm
            .instance_variables_json(self.listener)
            .map_err(|e| e.to_string())
    }

    /// Re-register a connection channel after DO wake from hibernation.
    pub fn register_connection(
        &mut self,
        connection_id: &str,
        request: RequestData,
    ) -> Result<(), String> {
        let channel = self.build_channel(connection_id, request);
        self.vm
            .struct_set(self.channel_registry_id, connection_id, channel);
        Ok(())
    }

    /// Called when a new WebSocket connects.
    pub fn on_connect(
        &mut self,
        connection_id: &str,
        request: RequestData,
    ) -> Result<(), String> {
        let channel = self.build_channel(connection_id, request);
        self.vm
            .struct_set(self.channel_registry_id, connection_id, channel);
        self.vm
            .call_method_value(self.listener, "onconnect", vec![channel])
            .map_err(|e| format!("WebSocket onConnect error: {}", e))?;
        Ok(())
    }

    /// Called when a WebSocket message arrives.
    pub fn on_message(
        &mut self,
        connection_id: &str,
        msg_type: u8,
        message: &[u8],
    ) -> Result<(), String> {
        let channel = self.vm.struct_get(self.channel_registry_id, connection_id);
        if channel.is_null() {
            return Err(format!("Connection {} not found in registry", connection_id));
        }
        let msg_value = if msg_type == 0 {
            // Text — decode UTF-8
            let text = String::from_utf8_lossy(message).to_string();
            BxValue::new_ptr(self.vm.string_new(text))
        } else {
            // Binary
            BxValue::new_ptr(self.vm.bytes_new(message.to_vec()))
        };
        self.vm
            .call_method_value(self.listener, "onmessage", vec![msg_value, channel])
            .map_err(|e| format!("WebSocket onMessage error: {}", e))?;
        Ok(())
    }

    /// Called when a WebSocket closes.
    pub fn on_close(&mut self, connection_id: &str) -> Result<(), String> {
        let channel = self.vm.struct_get(self.channel_registry_id, connection_id);
        if !channel.is_null() {
            let _ = self
                .vm
                .call_method_value(self.listener, "onclose", vec![channel]);
            self.vm.struct_delete(self.channel_registry_id, connection_id);
        }
        Ok(())
    }

    fn build_channel(&mut self, connection_id: &str, request: RequestData) -> BxValue {
        let id = self.vm.native_object_new(Rc::new(RefCell::new(
            CfWebSocketChannelObject {
                connection_id: connection_id.to_string(),
                request,
                bridge: self.bridge.clone(),
            },
        )));
        BxValue::new_ptr(id)
    }
}

// ── Native-test callout bridge (uses channels, no JS dependency) ──

use std::sync::mpsc;

/// A callout bridge for testing that forwards messages to a receiver.
pub struct TestCalloutBridge {
    sender: mpsc::Sender<CalloutMessage>,
}

impl TestCalloutBridge {
    pub fn new(sender: mpsc::Sender<CalloutMessage>) -> Self {
        Self { sender }
    }
}

impl CalloutBridge for TestCalloutBridge {
    fn send_callout(&mut self, msg: &CalloutMessage) -> Result<CalloutResult, String> {
        self.sender
            .send(msg.clone())
            .map_err(|e| format!("Callout send error: {}", e))?;
        Ok(CalloutResult {
            success: true,
            error: None,
        })
    }
}

// ── WASM callout bridge (calls JS functions via wasm-bindgen) ──

#[cfg(feature = "js")]
pub mod wasm_bridge {
    use super::*;
    use wasm_bindgen::prelude::*;

    /// The callout bridge implementation for WASM targets.
    ///
    /// Calls the JS functions `__skybox_send`, `__skybox_broadcast`, and
    /// `__skybox_close` that are registered on the global object by the
    /// JS shell.
    pub struct WasmCalloutBridge;

    impl CalloutBridge for WasmCalloutBridge {
        fn send_callout(&mut self, msg: &CalloutMessage) -> Result<CalloutResult, String> {
            let json = serde_json::to_string(msg).map_err(|e| e.to_string())?;
            let result = match msg {
                CalloutMessage::Send { .. } => js_call("__skybox_send", &json),
                CalloutMessage::Broadcast { .. } => js_call("__skybox_broadcast", &json),
                CalloutMessage::Close { .. } => js_call("__skybox_close", &json),
            };
            result
        }
    }

    fn js_call(func_name: &str, arg: &str) -> Result<CalloutResult, String> {
        let js_result = js_sys::Reflect::get(
            &js_sys::global(),
            &wasm_bindgen::JsValue::from_str(func_name),
        )
        .map_err(|e| format!("Failed to get {}: {:?}", func_name, e))?;

        let func = js_sys::Function::from(js_result);
        let ret = func
            .call1(&JsValue::NULL, &JsValue::from_str(arg))
            .map_err(|e| format!("{} call failed: {:?}", func_name, e))?;

        let ret_str = ret.as_string().unwrap_or_else(|| "{}".to_string());
        serde_json::from_str(&ret_str).map_err(|e| format!("Callout result parse error: {}", e))
    }
}
