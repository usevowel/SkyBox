//! DO Adapter — Bridges the Durable Object lifecycle to the BoxLang VM.
//!
//! This module provides the core logic that the JS `MatchBoxWebSocketDO` class
//! calls via WASM exports. It manages a single BoxLang VM instance that hosts
//! the listener class and channel registry for all WebSocket connections on
//! a particular DO.

use crate::channel::{bx_to_json, CfWebSocketChannelObject};
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
    ///
    /// Also registers D1 binding BIFs (`d1Query`, `d1Execute`) on the VM.
    pub fn new(
        chunk: Chunk,
        config: &WebSocketConfig,
        bridge: Rc<RefCell<dyn CalloutBridge>>,
    ) -> Result<Self, String> {
        // Set the bridge in the thread-local so D1 BIFs can access it
        crate::bifs::set_bridge(bridge.clone());

        // Create VM with D1 BIFs registered
        let mut vm = VM::new_with_bifs(crate::bifs::register_bifs(), std::collections::HashMap::new());
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
    ) -> Result<String, String> {
        let channel = self.build_channel(connection_id, request);
        self.vm
            .struct_set(self.channel_registry_id, connection_id, channel);
        self.vm
            .call_method_value(self.listener, "onconnect", vec![channel])
            .map_err(|e| format!("WebSocket onConnect error: {}", e))?;

        if crate::bifs::has_pending_async() {
            let ops = crate::bifs::get_pending_async_ops();
            let paused = serde_json::json!({
                "__paused__": true,
                "ops": ops.iter().map(|op| serde_json::json!({
                    "async_id": op.async_id,
                    "binding_name": op.binding_name,
                    "action": op.action,
                    "args": op.args,
                })).collect::<Vec<_>>(),
            });
            return serde_json::to_string(&paused).map_err(|e| e.to_string());
        }

        Ok("{}".to_string())
    }

    /// Called when a WebSocket message arrives.
    pub fn on_message(
        &mut self,
        connection_id: &str,
        msg_type: u8,
        message: &[u8],
    ) -> Result<String, String> {
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

        if crate::bifs::has_pending_async() {
            let ops = crate::bifs::get_pending_async_ops();
            let paused = serde_json::json!({
                "__paused__": true,
                "ops": ops.iter().map(|op| serde_json::json!({
                    "async_id": op.async_id,
                    "binding_name": op.binding_name,
                    "action": op.action,
                    "args": op.args,
                })).collect::<Vec<_>>(),
            });
            return serde_json::to_string(&paused).map_err(|e| e.to_string());
        }

        Ok("{}".to_string())
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

    /// Handle an HTTP request by calling the listener's `onHttpGet` method.
    ///
    /// The listener method receives a struct with request metadata and should
    /// return a struct containing `{status, headers, body}`. This struct is
    /// serialized to JSON (in Rust) and returned as a string to the JS shell.
    ///
    /// If the VM yields for an async operation (D1 query), the result will
    /// contain `{__paused: true, ops: [...]}`. The JS shell must resolve the
    /// async ops and call `complete_async`, then `resume_http_request`.
    pub fn on_http_request(&mut self, request: RequestData) -> Result<String, String> {
        let req_struct = self.request_to_struct(request);

        let result = self
            .vm
            .call_method_value(self.listener, "onhttpget", vec![req_struct]);

        // Check if the VM yielded for an async operation
        if crate::bifs::has_pending_async() {
            let ops = crate::bifs::get_pending_async_ops();
            let paused = serde_json::json!({
                "__paused__": true,
                "ops": ops.iter().map(|op| serde_json::json!({
                    "async_id": op.async_id,
                    "binding_name": op.binding_name,
                    "action": op.action,
                    "args": op.args,
                })).collect::<Vec<_>>(),
            });
            return serde_json::to_string(&paused).map_err(|e| e.to_string());
        }

        let result = result.map_err(|e| format!("onHttpGet error: {}", e))?;
        let json = bx_to_json(&self.vm, result).map_err(|e| format!("JSON: {}", e))?;
        serde_json::to_string(&json).map_err(|e| e.to_string())
    }

    /// Inject async operation results and resume the VM.
    ///
    /// Called by the JS shell after resolving D1 (or other binding) operations.
    /// Returns the final HTTP response, or another `{__paused__: true}` if
    /// more async operations are needed.
    pub fn complete_async(&mut self, results_json: &str) -> Result<String, String> {
        let results: Vec<serde_json::Value> = serde_json::from_str(results_json)
            .map_err(|e| format!("Invalid async results JSON: {}", e))?;

        for result in &results {
            let async_id = result["async_id"].as_u64().unwrap_or(0);
            if async_id == 0 {
                continue;
            }
            let data = &result.get("data").cloned().unwrap_or(serde_json::Value::Null);
            crate::bifs::resolve_async_future(&mut self.vm, async_id, data.clone())?;
        }

        // Resume VM fibers that were waiting for async results
        self.vm.pump_until_blocked().map_err(|e| e.to_string())?;

        // Check if there are more pending async ops (chain of D1 queries)
        if crate::bifs::has_pending_async() {
            let ops = crate::bifs::get_pending_async_ops();
            let paused = serde_json::json!({
                "__paused__": true,
                "ops": ops.iter().map(|op| serde_json::json!({
                    "async_id": op.async_id,
                    "binding_name": op.binding_name,
                    "action": op.action,
                    "args": op.args,
                })).collect::<Vec<_>>(),
            });
            return serde_json::to_string(&paused).map_err(|e| e.to_string());
        }

        // Check if the listener fiber completed — the result is already
        // in the VM's fiber completion. We read it from the listener's
        // variables scope if stored there.
        let result = self.vm.instance_variables_json(self.listener)
            .map_err(|e| e.to_string())?;

        if let Some(http_result) = result.get("__http_response") {
            return serde_json::to_string(http_result).map_err(|e| e.to_string());
        }

        // If no __http_response was stored, the BoxLang handler may have
        // already returned its result. Check the fiber's completion value.
        // For now, return a default OK response — the BoxLang code should
        // store its HTTP response in __http_response variable.
        Ok(serde_json::json!({
            "status": 200,
            "headers": {"Content-Type": "text/plain; charset=utf-8"},
            "body": ""
        }).to_string())
    }

    /// Convert a `RequestData` into a BoxLang struct value for passing to listener methods.
    fn request_to_struct(&mut self, request: RequestData) -> BxValue {
        let s = self.vm.struct_new();

        let method_val = self.vm.string_new(request.method);
        self.vm.struct_set(s, "method", BxValue::new_ptr(method_val));

        let path_val = self.vm.string_new(request.path);
        self.vm.struct_set(s, "path", BxValue::new_ptr(path_val));

        if let Some(raw_q) = request.raw_query {
            let raw_q_val = self.vm.string_new(raw_q);
            self.vm.struct_set(s, "raw_query", BxValue::new_ptr(raw_q_val));
        }

        // query (HashMap → BxStruct)
        let q = self.vm.struct_new();
        for (key, val) in &request.query {
            let val_s = self.vm.string_new(val.clone());
            self.vm.struct_set(q, key, BxValue::new_ptr(val_s));
        }
        self.vm.struct_set(s, "query", BxValue::new_ptr(q));

        // headers
        let h = self.vm.struct_new();
        for (key, val) in &request.headers {
            let val_s = self.vm.string_new(val.clone());
            self.vm.struct_set(h, key, BxValue::new_ptr(val_s));
        }
        self.vm.struct_set(s, "headers", BxValue::new_ptr(h));

        // body (already a string from JS)
        let body_val = self.vm.string_new(request.body);
        self.vm.struct_set(s, "body", BxValue::new_ptr(body_val));

        // cookies
        let c = self.vm.struct_new();
        for (key, val) in &request.cookies {
            let val_s = self.vm.string_new(val.clone());
            self.vm.struct_set(c, key, BxValue::new_ptr(val_s));
        }
        self.vm.struct_set(s, "cookies", BxValue::new_ptr(c));

        let url_val = self.vm.string_new(request.full_url);
        self.vm.struct_set(s, "full_url", BxValue::new_ptr(url_val));

        BxValue::new_ptr(s)
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
            async_id: 0,
            data: None,
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
                CalloutMessage::BindingCall { .. } => js_call("__skybox_binding_call", &json),
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
