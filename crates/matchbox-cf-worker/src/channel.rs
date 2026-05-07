use crate::types::{CalloutBridge, CalloutMessage, RequestData};
use matchbox_vm::types::{BxNativeObject, BxVM, BxValue};
use serde_json::Value as JsonValue;
use std::cell::RefCell;
use std::rc::Rc;

/// A BoxLang native object representing a WebSocket channel.
///
/// Mirrors the interface from `WebSocketChannelObject` in matchbox-server's
/// `websocket.rs`, but uses a `CalloutBridge` instead of mpsc senders to
/// communicate outbound messages to the host (JS or test harness).
pub struct CfWebSocketChannelObject {
    pub connection_id: String,
    pub request: RequestData,
    pub bridge: Rc<RefCell<dyn CalloutBridge>>,
}

impl std::fmt::Debug for CfWebSocketChannelObject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CfWebSocketChannelObject")
            .field("connection_id", &self.connection_id)
            .finish()
    }
}

impl BxNativeObject for CfWebSocketChannelObject {
    fn get_property(&self, name: &str) -> BxValue {
        match name.to_lowercase().as_str() {
            "id" => BxValue::new_null(),
            _ => BxValue::new_null(),
        }
    }

    fn set_property(&mut self, _name: &str, _value: BxValue) {}

    fn call_method(
        &mut self,
        vm: &mut dyn BxVM,
        _id: usize,
        name: &str,
        args: &[BxValue],
    ) -> Result<BxValue, String> {
        match name.to_lowercase().as_str() {
            // ── Send to single connection ──
            "sendmessage" | "sendtext" => {
                if args.is_empty() {
                    return Err("sendMessage() requires a message".to_string());
                }
                let text = vm.to_string(args[0]);
                self.send_text(text)
            }
            "sendjson" => {
                if args.is_empty() {
                    return Err("sendJson() requires a payload".to_string());
                }
                let payload = bx_to_json(vm, args[0])?;
                let text = serde_json::to_string(&payload)
                    .map_err(|e| e.to_string())?;
                self.send_text(text)
            }
            "sendbytes" => {
                if args.is_empty() {
                    return Err("sendBytes() requires a bytes payload".to_string());
                }
                let payload = vm.to_bytes(args[0])?;
                self.send_binary(payload)
            }

            // ── Broadcast to all connections ──
            "broadcastmessage" | "broadcasttext" => {
                if args.is_empty() {
                    return Err("broadcastMessage() requires a message".to_string());
                }
                let text = vm.to_string(args[0]);
                self.broadcast_text(text)
            }
            "broadcastjson" => {
                if args.is_empty() {
                    return Err("broadcastJson() requires a payload".to_string());
                }
                let payload = bx_to_json(vm, args[0])?;
                let text = serde_json::to_string(&payload)
                    .map_err(|e| e.to_string())?;
                self.broadcast_text(text)
            }
            "broadcastbytes" => {
                if args.is_empty() {
                    return Err("broadcastBytes() requires a bytes payload".to_string());
                }
                let payload = vm.to_bytes(args[0])?;
                self.broadcast_binary(payload)
            }

            // ── Close ──
            "close" => {
                let code = args
                    .first()
                    .map(|v| vm.to_string(*v).parse::<u16>().unwrap_or(1000))
                    .unwrap_or(1000);
                let reason = args
                    .get(1)
                    .map(|v| vm.to_string(*v))
                    .unwrap_or_default();
                self.close_connection(code, reason)
            }

            // ── Accessors ──
            "getid" => Ok(BxValue::new_ptr(vm.string_new(self.connection_id.clone()))),
            "getpath" => Ok(BxValue::new_ptr(vm.string_new(self.request.path.clone()))),
            "geturl" => Ok(BxValue::new_ptr(
                vm.string_new(self.request.full_url.clone()),
            )),
            "gethttpheader" => {
                if args.is_empty() {
                    return Err("getHTTPHeader() requires a header name".to_string());
                }
                let key = vm.to_string(args[0]).to_lowercase();
                if let Some(value) = self.request.headers.get(&key) {
                    Ok(BxValue::new_ptr(vm.string_new(value.clone())))
                } else if let Some(default) = args.get(1) {
                    Ok(*default)
                } else {
                    Ok(BxValue::new_null())
                }
            }

            _ => Err(format!(
                "Method {} not found on websocket channel.",
                name
            )),
        }
    }
}

// ── Internal helper methods ──

impl CfWebSocketChannelObject {
    fn send_text(&mut self, text: String) -> Result<BxValue, String> {
        let msg = CalloutMessage::Send {
            connection_id: self.connection_id.clone(),
            text: Some(text),
            binary: None,
        };
        self.bridge.borrow_mut().send_callout(&msg)?;
        Ok(BxValue::new_null())
    }

    fn send_binary(&mut self, data: Vec<u8>) -> Result<BxValue, String> {
        let msg = CalloutMessage::Send {
            connection_id: self.connection_id.clone(),
            text: None,
            binary: Some(data),
        };
        self.bridge.borrow_mut().send_callout(&msg)?;
        Ok(BxValue::new_null())
    }

    fn broadcast_text(&mut self, text: String) -> Result<BxValue, String> {
        let msg = CalloutMessage::Broadcast {
            sender_connection_id: self.connection_id.clone(),
            text: Some(text),
            binary: None,
        };
        self.bridge.borrow_mut().send_callout(&msg)?;
        Ok(BxValue::new_null())
    }

    fn broadcast_binary(&mut self, data: Vec<u8>) -> Result<BxValue, String> {
        let msg = CalloutMessage::Broadcast {
            sender_connection_id: self.connection_id.clone(),
            text: None,
            binary: Some(data),
        };
        self.bridge.borrow_mut().send_callout(&msg)?;
        Ok(BxValue::new_null())
    }

    fn close_connection(&mut self, code: u16, reason: String) -> Result<BxValue, String> {
        let msg = CalloutMessage::Close {
            connection_id: self.connection_id.clone(),
            code,
            reason,
        };
        self.bridge.borrow_mut().send_callout(&msg)?;
        Ok(BxValue::new_null())
    }
}

// ── BxValue ↔ JSON conversion (ported from matchbox-server/src/lib.rs) ──

pub fn bx_to_json(vm: &dyn BxVM, value: BxValue) -> Result<JsonValue, String> {
    if value.is_null() {
        return Ok(JsonValue::Null);
    }
    if value.is_bool() {
        return Ok(JsonValue::Bool(value.as_bool()));
    }
    if value.is_int() {
        return Ok(JsonValue::from(value.as_int()));
    }
    if value.is_number() {
        return Ok(JsonValue::from(value.as_number()));
    }
    if vm.is_string_value(value) {
        return Ok(JsonValue::String(vm.to_string(value)));
    }
    if vm.is_bytes(value) {
        return Ok(JsonValue::Array(
            vm.to_bytes(value)?
                .into_iter()
                .map(JsonValue::from)
                .collect(),
        ));
    }
    if vm.is_array_value(value) {
        let id = value.as_gc_id().unwrap();
        let mut items = Vec::new();
        for index in 0..vm.array_len(id) {
            items.push(bx_to_json(vm, vm.array_get(id, index))?);
        }
        return Ok(JsonValue::Array(items));
    }
    if vm.is_struct_value(value) {
        let id = value.as_gc_id().unwrap();
        let mut object = serde_json::Map::new();
        for key in vm.struct_key_array(id) {
            object.insert(key.clone(), bx_to_json(vm, vm.struct_get(id, &key))?);
        }
        return Ok(JsonValue::Object(object));
    }
    Ok(JsonValue::String(vm.to_string(value)))
}

pub fn json_to_bx(vm: &mut dyn BxVM, value: &JsonValue) -> Result<BxValue, String> {
    match value {
        JsonValue::Null => Ok(BxValue::new_null()),
        JsonValue::Bool(val) => Ok(BxValue::new_bool(*val)),
        JsonValue::Number(val) => {
            if let Some(i) = val.as_i64() {
                Ok(BxValue::new_number(i as f64))
            } else {
                Ok(BxValue::new_number(
                    val.as_f64()
                        .ok_or_else(|| "Unsupported JSON number".to_string())?,
                ))
            }
        }
        JsonValue::String(val) => Ok(BxValue::new_ptr(vm.string_new(val.clone()))),
        JsonValue::Array(values) => {
            let id = vm.array_new();
            for v in values {
                let bx = json_to_bx(vm, v)?;
                vm.array_push(id, bx);
            }
            Ok(BxValue::new_ptr(id))
        }
        JsonValue::Object(values) => {
            let id = vm.struct_new();
            for (key, value) in values {
                let bx = json_to_bx(vm, value)?;
                vm.struct_set(id, key, bx);
            }
            Ok(BxValue::new_ptr(id))
        }
    }
}
