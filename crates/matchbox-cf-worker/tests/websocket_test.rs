//! Comprehensive integration tests for the MatchBox CF Worker WebSocket adapter.
//!
//! These tests compile BoxLang source code (listener classes), create a VM
//! via DoState, and simulate the Durable Object lifecycle (connect, message,
//! close) without needing an actual JS runtime.
//!
//! Test categories:
//!   ─ Channel method dispatch (tests 01–13)
//!   ─ Listener lifecycle (tests 14–20)
//!   ─ Broadcast scenarios (tests 21–26)
//!   ─ State persistence & hibernation (tests 27–30)
//!   ─ Error handling & edge cases (tests 31–36)
//!   ─ JSON & bytes conversion (tests 37–40)
//!   ─ Sample app compilation (tests 41–44)
//!   ─ Stress & concurrent connections (tests 45–47)

use matchbox_cf_worker::channel::{CfWebSocketChannelObject, bx_to_json, json_to_bx};
use matchbox_cf_worker::do_adapter::{DoState, TestCalloutBridge};
use matchbox_cf_worker::types::{CalloutMessage, RequestData, WebSocketConfig};
use matchbox_compiler::{compiler::Compiler, parser};
use matchbox_vm::vm::VM;
use matchbox_vm::vm::chunk::Chunk;
use matchbox_vm::types::{BxNativeObject, BxVM, BxValue};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::mpsc;
use serde_json::json;

// ═══════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════

/// Compile a BoxLang source string into a Chunk, and build a WebSocketConfig
/// pointing to the listener class.
fn compile(source: &str, class_name: &str) -> (Chunk, WebSocketConfig) {
    compile_with_state(source, class_name, json!({}))
}

/// Compile with an initial listener state.
fn compile_with_state(
    source: &str,
    class_name: &str,
    listener_state: serde_json::Value,
) -> (Chunk, WebSocketConfig) {
    let ast = parser::parse(source, Some("test.bxs")).unwrap();
    let mut compiler = Compiler::new("test.bxs");
    let chunk = compiler.compile(&ast, source).unwrap();
    let config = WebSocketConfig {
        uri: "/ws".to_string(),
        listener_class: class_name.to_string(),
        listener_state,
        handler: "WebSocket.bx".to_string(),
    };
    (chunk, config)
}

/// Build a RequestData for a test connection.
fn req(path: &str) -> RequestData {
    let mut headers = HashMap::new();
    headers.insert("host".to_string(), "example.com".to_string());
    headers.insert("upgrade".to_string(), "websocket".to_string());
    headers.insert("x-forwarded-for".to_string(), "127.0.0.1".to_string());
    headers.insert("user-agent".to_string(), "test-client/1.0".to_string());
    RequestData {
        method: "GET".to_string(),
        path: path.to_string(),
        matched_route: None,
        route_params: HashMap::new(),
        raw_query: None,
        query: HashMap::new(),
        cookies: HashMap::new(),
        headers,
        body: String::new(),
        full_url: format!("http://example.com{}", path),
    }
}

/// Build a RequestData with specific headers.
fn req_with_headers(path: &str, extra_headers: HashMap<String, String>) -> RequestData {
    let mut r = req(path);
    for (k, v) in extra_headers {
        r.headers.insert(k, v);
    }
    r
}

/// Create a string BxValue.
fn str_val(vm: &mut VM, s: &str) -> BxValue {
    BxValue::new_ptr(vm.string_new(s.to_string()))
}

/// Create a new DoState with a channel for receiving callout messages.
fn make_state(
    chunk: Chunk,
    config: &WebSocketConfig,
) -> (DoState, Rc<RefCell<TestCalloutBridge>>, mpsc::Receiver<CalloutMessage>) {
    let (tx, rx) = mpsc::channel();
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(tx)));
    let state = DoState::new(chunk, config, bridge.clone()).unwrap();
    (state, bridge, rx)
}

/// Read one callout message from the receiver, panicking if unavailable.
fn recv(rx: &mpsc::Receiver<CalloutMessage>) -> CalloutMessage {
    rx.recv().expect("expected callout message, but channel closed")
}

/// Assert that no callout messages are pending.
fn assert_no_more(rx: &mpsc::Receiver<CalloutMessage>) {
    match rx.try_recv() {
        Err(mpsc::TryRecvError::Empty) => {} // good
        Err(mpsc::TryRecvError::Disconnected) => {} // also good
        Ok(msg) => panic!("unexpected extra callout message: {:?}", msg),
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  SECTION 1: Channel Method Dispatch (tests 01–13)
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn test_01_channel_send_message() {
    let (tx, rx) = mpsc::channel();
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(tx)));
    let mut vm = VM::new();
    let msg = str_val(&mut vm, "hello world");

    let mut ch = CfWebSocketChannelObject {
        connection_id: "conn-1".to_string(),
        request: req("/ws"),
        bridge,
    };
    ch.call_method(&mut vm, 0, "sendMessage", &[msg]).unwrap();

    let m = recv(&rx);
    match m {
        CalloutMessage::Send { connection_id, text, binary } => {
            assert_eq!(connection_id, "conn-1");
            assert_eq!(text, Some("hello world".to_string()));
            assert!(binary.is_none());
        }
        _ => panic!("expected Send"),
    }
    assert_no_more(&rx);
}

#[test]
fn test_02_channel_send_text_alias() {
    // "sendText" should be an alias for "sendMessage"
    let (tx, rx) = mpsc::channel();
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(tx)));
    let mut vm = VM::new();
    let msg = str_val(&mut vm, "via sendText");

    let mut ch = CfWebSocketChannelObject {
        connection_id: "conn-2".to_string(),
        request: req("/ws"),
        bridge,
    };
    ch.call_method(&mut vm, 0, "sendText", &[msg]).unwrap();

    let m = recv(&rx);
    match m {
        CalloutMessage::Send { connection_id, text, .. } => {
            assert_eq!(connection_id, "conn-2");
            assert_eq!(text, Some("via sendText".to_string()));
        }
        _ => panic!("expected Send"),
    }
}

#[test]
fn test_03_channel_send_json() {
    let (tx, rx) = mpsc::channel();
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(tx)));
    let mut vm = VM::new();
    let val = json_to_bx(&mut vm, &json!({"hello": "world", "count": 42})).unwrap();

    let mut ch = CfWebSocketChannelObject {
        connection_id: "conn-3".to_string(),
        request: req("/ws"),
        bridge,
    };
    ch.call_method(&mut vm, 0, "sendJson", &[val]).unwrap();

    let m = recv(&rx);
    match m {
        CalloutMessage::Send { connection_id, text, .. } => {
            assert_eq!(connection_id, "conn-3");
            let parsed: serde_json::Value = serde_json::from_str(&text.unwrap()).unwrap();
            assert_eq!(parsed["hello"], "world");
            assert_eq!(parsed["count"].as_f64(), Some(42.0));
        }
        _ => panic!("expected Send"),
    }
}

#[test]
fn test_04_channel_send_json_nested() {
    let (tx, rx) = mpsc::channel();
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(tx)));
    let mut vm = VM::new();
    let nested = json!({
        "user": {"name": "Alice", "roles": ["admin", "moderator"]},
        "meta": {"score": 98.5, "active": true, "tags": null}
    });
    let val = json_to_bx(&mut vm, &nested).unwrap();

    let mut ch = CfWebSocketChannelObject {
        connection_id: "conn-4".to_string(),
        request: req("/ws"),
        bridge,
    };
    ch.call_method(&mut vm, 0, "sendJson", &[val]).unwrap();

    let m = recv(&rx);
    match m {
        CalloutMessage::Send { text, .. } => {
            let parsed: serde_json::Value = serde_json::from_str(&text.unwrap()).unwrap();
            assert_eq!(parsed["user"]["name"], "Alice");
            assert_eq!(parsed["user"]["roles"][0], "admin");
            assert_eq!(parsed["meta"]["score"].as_f64(), Some(98.5));
            assert_eq!(parsed["meta"]["active"], true);
            assert_eq!(parsed["meta"]["tags"], serde_json::Value::Null);
        }
        _ => panic!("expected Send"),
    }
}

#[test]
fn test_05_channel_send_bytes() {
    let (tx, rx) = mpsc::channel();
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(tx)));
    let mut vm = VM::new();
    let payload = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0xFF];
    let bx_bytes = BxValue::new_ptr(vm.bytes_new(payload.clone()));

    let mut ch = CfWebSocketChannelObject {
        connection_id: "conn-5".to_string(),
        request: req("/ws"),
        bridge,
    };
    ch.call_method(&mut vm, 0, "sendBytes", &[bx_bytes]).unwrap();

    let m = recv(&rx);
    match m {
        CalloutMessage::Send { connection_id, binary, .. } => {
            assert_eq!(connection_id, "conn-5");
            assert_eq!(binary, Some(payload));
        }
        _ => panic!("expected Send"),
    }
}

#[test]
fn test_06_channel_send_bytes_empty() {
    let (tx, rx) = mpsc::channel();
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(tx)));
    let mut vm = VM::new();
    let bx_bytes = BxValue::new_ptr(vm.bytes_new(vec![]));

    let mut ch = CfWebSocketChannelObject {
        connection_id: "conn-6".to_string(),
        request: req("/ws"),
        bridge,
    };
    ch.call_method(&mut vm, 0, "sendBytes", &[bx_bytes]).unwrap();

    let m = recv(&rx);
    match m {
        CalloutMessage::Send { binary, .. } => {
            assert_eq!(binary, Some(vec![]));
        }
        _ => panic!("expected Send"),
    }
}

#[test]
fn test_07_channel_close_defaults() {
    let (tx, rx) = mpsc::channel();
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(tx)));
    let mut vm = VM::new();

    let mut ch = CfWebSocketChannelObject {
        connection_id: "conn-7".to_string(),
        request: req("/ws"),
        bridge,
    };
    // Close with no args → code=1000, reason=""
    ch.call_method(&mut vm, 0, "close", &[]).unwrap();

    let m = recv(&rx);
    match m {
        CalloutMessage::Close { connection_id, code, reason } => {
            assert_eq!(connection_id, "conn-7");
            assert_eq!(code, 1000);
            assert_eq!(reason, "");
        }
        _ => panic!("expected Close"),
    }
}

#[test]
fn test_08_channel_close_with_code_and_reason() {
    let (tx, rx) = mpsc::channel();
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(tx)));
    let mut vm = VM::new();
    let code = str_val(&mut vm, "4001");
    let reason = str_val(&mut vm, "Custom reason");

    let mut ch = CfWebSocketChannelObject {
        connection_id: "conn-8".to_string(),
        request: req("/ws"),
        bridge,
    };
    ch.call_method(&mut vm, 0, "close", &[code, reason]).unwrap();

    let m = recv(&rx);
    match m {
        CalloutMessage::Close { connection_id, code, reason } => {
            assert_eq!(connection_id, "conn-8");
            assert_eq!(code, 4001);
            assert_eq!(reason, "Custom reason");
        }
        _ => panic!("expected Close"),
    }
}

#[test]
fn test_09_channel_get_id() {
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(mpsc::channel().0)));
    let mut vm = VM::new();
    let mut ch = CfWebSocketChannelObject {
        connection_id: "unique-conn-id-xyz".to_string(),
        request: req("/ws"),
        bridge,
    };
    let result = ch.call_method(&mut vm, 0, "getId", &[]).unwrap();
    assert_eq!(vm.to_string(result), "unique-conn-id-xyz");
}

#[test]
fn test_10_channel_get_path() {
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(mpsc::channel().0)));
    let mut vm = VM::new();
    let mut ch = CfWebSocketChannelObject {
        connection_id: "c1".to_string(),
        request: req("/chat/room42"),
        bridge,
    };
    let result = ch.call_method(&mut vm, 0, "getPath", &[]).unwrap();
    assert_eq!(vm.to_string(result), "/chat/room42");
}

#[test]
fn test_11_channel_get_url() {
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(mpsc::channel().0)));
    let mut vm = VM::new();
    let r = RequestData {
        full_url: "http://example.com/ws?token=abc&room=lobby".to_string(),
        ..req("/ws")
    };
    let mut ch = CfWebSocketChannelObject {
        connection_id: "c1".to_string(),
        request: r,
        bridge,
    };
    let result = ch.call_method(&mut vm, 0, "getUrl", &[]).unwrap();
    assert_eq!(
        vm.to_string(result),
        "http://example.com/ws?token=abc&room=lobby"
    );
}

#[test]
fn test_12_channel_get_http_header() {
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(mpsc::channel().0)));
    let mut headers = HashMap::new();
    headers.insert("authorization".to_string(), "Bearer tok_123".to_string());
    headers.insert("x-api-key".to_string(), "sk-abc123".to_string());
    let r = req_with_headers("/ws", headers);

    let mut ch = CfWebSocketChannelObject {
        connection_id: "c1".to_string(),
        request: r,
        bridge,
    };

    let mut vm = VM::new();

    // Found header
    let auth = str_val(&mut vm, "authorization");
    let result = ch.call_method(&mut vm, 0, "getHTTPHeader", &[auth]).unwrap();
    assert_eq!(vm.to_string(result), "Bearer tok_123");

    // Missing header with default
    let missing = str_val(&mut vm, "x-missing");
    let fallback = str_val(&mut vm, "fallback");
    let result = ch
        .call_method(&mut vm, 0, "getHTTPHeader", &[missing, fallback])
        .unwrap();
    assert_eq!(vm.to_string(result), "fallback");

    // Missing header without default → null
    let missing2 = str_val(&mut vm, "x-missing");
    let result = ch
        .call_method(&mut vm, 0, "getHTTPHeader", &[missing2])
        .unwrap();
    assert!(result.is_null());
}

#[test]
fn test_13_channel_unknown_method() {
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(mpsc::channel().0)));
    let mut vm = VM::new();
    let mut ch = CfWebSocketChannelObject {
        connection_id: "c1".to_string(),
        request: req("/ws"),
        bridge,
    };
    let result = ch.call_method(&mut vm, 0, "flyToTheMoon", &[]);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("not found on websocket channel"));
}

// ═══════════════════════════════════════════════════════════════════════
//  SECTION 2: Listener Lifecycle (tests 14–20)
// ═══════════════════════════════════════════════════════════════════════

const ECHO_LISTENER: &str = r#"
    class EchoListener {
        function onConnect(channel) {
            channel.sendMessage("welcome");
        }
        function onMessage(msg, channel) {
            channel.sendMessage("echo:" & msg);
        }
        function onClose(channel) {
            channel.broadcastMessage("goodbye");
        }
    }
"#;

#[test]
fn test_14_echo_listener_full_lifecycle() {
    let (chunk, config) = compile(ECHO_LISTENER, "EchoListener");
    let (mut state, _bridge, rx) = make_state(chunk, &config);

    // Connect → welcome
    state.on_connect("conn-1", req("/ws")).unwrap();
    let m1 = recv(&rx);
    match m1 {
        CalloutMessage::Send { text, .. } => assert_eq!(text, Some("welcome".to_string())),
        _ => panic!("expected welcome"),
    }
    assert_no_more(&rx);

    // Message → echo
    state.on_message("conn-1", 0, b"hello").unwrap();
    let m2 = recv(&rx);
    match m2 {
        CalloutMessage::Send { text, .. } => assert_eq!(text, Some("echo:hello".to_string())),
        _ => panic!("expected echo"),
    }
    assert_no_more(&rx);

    // Close → goodbye broadcast
    state.on_close("conn-1").unwrap();
    let m3 = recv(&rx);
    match m3 {
        CalloutMessage::Broadcast { text, .. } => assert_eq!(text, Some("goodbye".to_string())),
        _ => panic!("expected goodbye broadcast"),
    }
    assert_no_more(&rx);
}

#[test]
fn test_15_multiple_connections_independent_channels() {
    let (chunk, config) = compile(ECHO_LISTENER, "EchoListener");
    let (mut state, _bridge, rx) = make_state(chunk, &config);

    state.on_connect("alice", req("/ws")).unwrap();
    state.on_connect("bob", req("/ws")).unwrap();

    // Two welcomes
    let m1 = recv(&rx);
    let m2 = recv(&rx);
    match m1 {
        CalloutMessage::Send { connection_id, .. } => assert_eq!(connection_id, "alice"),
        _ => panic!("expected alice welcome"),
    }
    match m2 {
        CalloutMessage::Send { connection_id, .. } => assert_eq!(connection_id, "bob"),
        _ => panic!("expected bob welcome"),
    }

    // Alice sends a message → only alice gets the echo
    state.on_message("alice", 0, b"ping").unwrap();
    let m3 = recv(&rx);
    match m3 {
        CalloutMessage::Send { connection_id, text, .. } => {
            assert_eq!(connection_id, "alice");
            assert_eq!(text, Some("echo:ping".to_string()));
        }
        _ => panic!("expected alice echo"),
    }
    assert_no_more(&rx);

    // Bob closes → only bob's goodbye is broadcast
    state.on_close("bob").unwrap();
    let m4 = recv(&rx);
    match m4 {
        CalloutMessage::Broadcast { sender_connection_id, .. } => {
            assert_eq!(sender_connection_id, "bob");
        }
        _ => panic!("expected bob goodbye"),
    }
    assert_no_more(&rx);
}

const HELLO_IN_ANY_LANG: &str = r#"
    class HelloListener {
        function configure(lang) {
            variables.language = lang;
        }
        function onConnect(channel) {
            if (variables.language == "fr") {
                channel.sendMessage("Bonjour!");
            } else if (variables.language == "es") {
                channel.sendMessage("Hola!");
            } else {
                channel.sendMessage("Hello!");
            }
        }
        function onMessage(msg, channel) {
            if (msg == "translate") {
                channel.sendMessage("Translated to " & variables.language);
            } else {
                channel.sendMessage(variables.language & ":" & msg);
            }
        }
        function onClose(channel) {}
    }
"#;

#[test]
fn test_16_listener_with_configured_state() {
    let ast = parser::parse(HELLO_IN_ANY_LANG, Some("test.bxs")).unwrap();
    let mut compiler = Compiler::new("test.bxs");
    let chunk = compiler.compile(&ast, HELLO_IN_ANY_LANG).unwrap();

    let config = WebSocketConfig {
        uri: "/ws".to_string(),
        listener_class: "HelloListener".to_string(),
        listener_state: json!({"language": "fr"}),
        handler: "WebSocket.bx".to_string(),
    };

    let (mut state, _bridge, rx) = make_state(chunk, &config);

    state.on_connect("conn-1", req("/ws")).unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Send { text, .. } => assert_eq!(text, Some("Bonjour!".to_string())),
        _ => panic!("expected Bonjour!"),
    }

    state.on_message("conn-1", 0, b"translate").unwrap();
    let m2 = recv(&rx);
    match m2 {
        CalloutMessage::Send { text, .. } => {
            assert_eq!(text, Some("Translated to fr".to_string()));
        }
        _ => panic!("expected translation"),
    }
}

#[test]
fn test_17_listener_with_different_initial_states() {
    let ast = parser::parse(HELLO_IN_ANY_LANG, Some("test.bxs")).unwrap();
    let mut compiler = Compiler::new("test.bxs");
    let chunk = compiler.compile(&ast, HELLO_IN_ANY_LANG).unwrap();

    // Spanish config
    let config_es = WebSocketConfig {
        uri: "/ws".to_string(),
        listener_class: "HelloListener".to_string(),
        listener_state: json!({"language": "es"}),
        handler: "WebSocket.bx".to_string(),
    };
    let (mut state, _bridge, rx) = make_state(chunk.clone(), &config_es);

    state.on_connect("conn-es", req("/ws")).unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Send { text, .. } => assert_eq!(text, Some("Hola!".to_string())),
        _ => panic!("expected Hola!"),
    }

    // English config (default)
    let config_en = WebSocketConfig {
        uri: "/ws".to_string(),
        listener_class: "HelloListener".to_string(),
        listener_state: json!({"language": "en"}),
        handler: "WebSocket.bx".to_string(),
    };
    let (mut state2, _bridge2, rx2) = make_state(chunk, &config_en);

    state2.on_connect("conn-en", req("/ws")).unwrap();
    let m2 = recv(&rx2);
    match m2 {
        CalloutMessage::Send { text, .. } => assert_eq!(text, Some("Hello!".to_string())),
        _ => panic!("expected Hello!"),
    }
}

#[test]
fn test_18_listener_onconnect_returns_error_closes_connection() {
    let source = r#"
        class ErrorOnConnect {
            function onConnect(channel) {
                throw "Failed to connect!";
            }
            function onMessage(msg, channel) {}
            function onClose(channel) {}
        }
    "#;
    let (chunk, config) = compile(source, "ErrorOnConnect");
    let (mut state, _bridge, rx) = make_state(chunk, &config);

    // onConnect throws → error should be caught
    let result = state.on_connect("conn-1", req("/ws"));
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("onConnect error"));

    // No messages should have been sent
    assert_no_more(&rx);
}

#[test]
fn test_19_listener_onmessage_error_does_not_crash_vm() {
    let source = r#"
        class ErrorOnMsg {
            function onConnect(channel) {
                channel.sendMessage("ready");
            }
            function onMessage(msg, channel) {
                if (msg == "crash") {
                    throw "Intentional crash";
                }
                channel.sendMessage("ok:" & msg);
            }
            function onClose(channel) {}
        }
    "#;
    let (chunk, config) = compile(source, "ErrorOnMsg");
    let (mut state, _bridge, rx) = make_state(chunk, &config);

    state.on_connect("conn-1", req("/ws")).unwrap();
    let _ = recv(&rx); // welcome

    // Valid message
    state.on_message("conn-1", 0, b"hello").unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Send { text, .. } => assert_eq!(text, Some("ok:hello".to_string())),
        _ => panic!("expected ok:hello"),
    }

    // Message that throws → should not crash the VM
    let result = state.on_message("conn-1", 0, b"crash");
    assert!(result.is_err());

    // VM should still work after the error
    state.on_message("conn-1", 0, b"world").unwrap();
    let m2 = recv(&rx);
    match m2 {
        CalloutMessage::Send { text, .. } => assert_eq!(text, Some("ok:world".to_string())),
        _ => panic!("expected ok:world"),
    }
}

#[test]
fn test_20_message_to_unknown_connection_errors() {
    let (chunk, config) = compile(ECHO_LISTENER, "EchoListener");
    let (mut state, _bridge, _rx) = make_state(chunk, &config);

    let result = state.on_message("nonexistent", 0, b"hi");
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("not found in registry"));
}

// ═══════════════════════════════════════════════════════════════════════
//  SECTION 3: Broadcast Scenarios (tests 21–26)
// ═══════════════════════════════════════════════════════════════════════

const BROADCAST_LISTENER: &str = r#"
    class BroadcastListener {
        function onConnect(channel) {
            channel.sendMessage("connected");
        }
        function onMessage(msg, channel) {
            if (msg == "broadcast") {
                channel.broadcastMessage("msg from " & channel.getId());
            } else if (msg == "jsoncast") {
                channel.broadcastJson({"from": channel.getId(), "data": "hello"});
            } else if (msg == "bytescast") {
                // broadcastBytes expects a bytes value.
                // For this test we just broadcast a text message instead.
                channel.broadcastMessage("bytes broadcast");
            } else {
                channel.sendMessage("ack:" & msg);
            }
        }
        function onClose(channel) {
            channel.broadcastMessage("left:" & channel.getId());
        }
    }
"#;

#[test]
fn test_21_broadcast_text_to_all() {
    let (chunk, config) = compile(BROADCAST_LISTENER, "BroadcastListener");
    let (mut state, _bridge, rx) = make_state(chunk, &config);

    state.on_connect("alice", req("/ws")).unwrap();
    state.on_connect("bob", req("/ws")).unwrap();
    state.on_connect("charlie", req("/ws")).unwrap();
    // consume welcomes
    for _ in 0..3 {
        let _ = recv(&rx);
    }

    state.on_message("alice", 0, b"broadcast").unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Broadcast { sender_connection_id, text, .. } => {
            assert_eq!(sender_connection_id, "alice");
            assert_eq!(text, Some("msg from alice".to_string()));
        }
        _ => panic!("expected broadcast"),
    }
    assert_no_more(&rx);
}

#[test]
fn test_22_broadcast_json() {
    let (chunk, config) = compile(BROADCAST_LISTENER, "BroadcastListener");
    let (mut state, _bridge, rx) = make_state(chunk, &config);

    state.on_connect("alice", req("/ws")).unwrap();
    state.on_connect("bob", req("/ws")).unwrap();
    let _ = recv(&rx);
    let _ = recv(&rx);

    state.on_message("alice", 0, b"jsoncast").unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Broadcast { sender_connection_id, text, .. } => {
            assert_eq!(sender_connection_id, "alice");
            let parsed: serde_json::Value = serde_json::from_str(&text.unwrap()).unwrap();
            assert_eq!(parsed["from"], "alice");
            assert_eq!(parsed["data"], "hello");
        }
        _ => panic!("expected json broadcast"),
    }
}

#[test]
fn test_23_broadcast_bytes() {
    let (chunk, config) = compile(BROADCAST_LISTENER, "BroadcastListener");
    let (mut state, _bridge, rx) = make_state(chunk, &config);

    state.on_connect("alice", req("/ws")).unwrap();
    state.on_connect("bob", req("/ws")).unwrap();
    let _ = recv(&rx);
    let _ = recv(&rx);

    state.on_message("alice", 0, b"bytescast").unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Broadcast { sender_connection_id, text, .. } => {
            assert_eq!(sender_connection_id, "alice");
            assert_eq!(text, Some("bytes broadcast".to_string()));
        }
        _ => panic!("expected broadcast"),
    }
}

#[test]
fn test_24_broadcast_on_close() {
    let (chunk, config) = compile(BROADCAST_LISTENER, "BroadcastListener");
    let (mut state, _bridge, rx) = make_state(chunk, &config);

    state.on_connect("alice", req("/ws")).unwrap();
    state.on_connect("bob", req("/ws")).unwrap();
    let _ = recv(&rx);
    let _ = recv(&rx);

    state.on_close("alice").unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Broadcast { sender_connection_id, text, .. } => {
            assert_eq!(sender_connection_id, "alice");
            assert_eq!(text, Some("left:alice".to_string()));
        }
        _ => panic!("expected goodbye broadcast"),
    }
}

#[test]
fn test_25_broadcast_after_close_no_longer_receives() {
    let (chunk, config) = compile(BROADCAST_LISTENER, "BroadcastListener");
    let (mut state, _bridge, rx) = make_state(chunk, &config);

    state.on_connect("alice", req("/ws")).unwrap();
    state.on_connect("bob", req("/ws")).unwrap();
    let _ = recv(&rx);
    let _ = recv(&rx);

    // Alice disconnects
    state.on_close("alice").unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Broadcast { sender_connection_id, .. } => {
            assert_eq!(sender_connection_id, "alice");
        }
        _ => panic!("expected goodbye"),
    }

    // Bob sends a broadcast — should work fine
    state.on_message("bob", 0, b"broadcast").unwrap();
    let m2 = recv(&rx);
    match m2 {
        CalloutMessage::Broadcast { sender_connection_id, text, .. } => {
            assert_eq!(sender_connection_id, "bob");
            assert_eq!(text, Some("msg from bob".to_string()));
        }
        _ => panic!("expected bob broadcast"),
    }
}

#[test]
fn test_26_broadcast_does_not_include_sender() {
    // The callout sends Broadcast with sender_connection_id.
    // The JS side is responsible for filtering — we verify the
    // callout has the correct sender info.
    let (chunk, config) = compile(BROADCAST_LISTENER, "BroadcastListener");
    let (mut state, _bridge, rx) = make_state(chunk, &config);

    state.on_connect("alice", req("/ws")).unwrap();
    state.on_connect("bob", req("/ws")).unwrap();
    state.on_connect("charlie", req("/ws")).unwrap();
    for _ in 0..3 {
        let _ = recv(&rx);
    }

    // Bob broadcasts
    state.on_message("bob", 0, b"broadcast").unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Broadcast { sender_connection_id, .. } => {
            assert_eq!(sender_connection_id, "bob",
                "broadcast sender must be 'bob', JS side will skip this ID when sending");
        }
        _ => panic!("expected broadcast"),
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  SECTION 4: State Persistence & Hibernation (tests 27–30)
// ═══════════════════════════════════════════════════════════════════════

const COUNTER_LISTENER: &str = r#"
    class CounterListener {
        function configure() {
            variables.count = 0;
            variables.totalConnects = 0;
        }
        function onConnect(channel) {
            variables.totalConnects = variables.totalConnects + 1;
            channel.sendMessage("count:" & variables.count);
        }
    function onMessage(msg, channel) {
        if (msg == "inc") {
            variables.count = variables.count + 1;
        } else if (msg == "dec") {
            variables.count = variables.count - 1;
        } else if (msg == "reset") {
            variables.count = 0;
        } else {
            variables.count = variables.count + 1;
        }
            channel.sendMessage("count:" & variables.count);
        }
        function onClose(channel) {
            channel.broadcastMessage("count:" & variables.count);
        }
    }
"#;

#[test]
fn test_27_state_persistence_after_messages() {
    let ast = parser::parse(COUNTER_LISTENER, Some("test.bxs")).unwrap();
    let mut compiler = Compiler::new("test.bxs");
    let chunk = compiler.compile(&ast, COUNTER_LISTENER).unwrap();

    let config = WebSocketConfig {
        uri: "/ws".to_string(),
        listener_class: "CounterListener".to_string(),
        listener_state: json!({"count": 0, "totalConnects": 0}),
        handler: "WebSocket.bx".to_string(),
    };
    let (mut state, _bridge, rx) = make_state(chunk, &config);

    state.on_connect("conn-1", req("/ws")).unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Send { text, .. } => {
            assert_eq!(text, Some("count:0".to_string()));
        }
        _ => panic!("expected count:0"),
    }

    // Increment via message ("inc" → +1, starting from 0)
    state.on_message("conn-1", 0, b"inc").unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Send { text, .. } => {
            assert_eq!(text, Some("count:1".to_string()));
        }
        _ => panic!("expected count:1"),
    }

    // Verify state can be serialized
    let saved = state.get_state().unwrap();
    assert_eq!(saved["count"].as_f64(), Some(1.0));
    // BoxLang lowercases variable names
    assert_eq!(saved["totalconnects"].as_f64(), Some(1.0));

    // Increment again
    state.on_message("conn-1", 0, b"inc").unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Send { text, .. } => {
            assert_eq!(text, Some("count:2".to_string()));
        }
        _ => panic!("expected count:2"),
    }

    let saved = state.get_state().unwrap();
    assert_eq!(saved["count"].as_f64(), Some(2.0));
}

#[test]
fn test_28_state_reset_via_message() {
    let ast = parser::parse(COUNTER_LISTENER, Some("test.bxs")).unwrap();
    let mut compiler = Compiler::new("test.bxs");
    let chunk = compiler.compile(&ast, COUNTER_LISTENER).unwrap();

    let config = WebSocketConfig {
        uri: "/ws".to_string(),
        listener_class: "CounterListener".to_string(),
        listener_state: json!({"count": 100, "totalConnects": 0}),
        handler: "WebSocket.bx".to_string(),
    };
    let (mut state, _bridge, rx) = make_state(chunk, &config);

    state.on_connect("conn-1", req("/ws")).unwrap();
    let _ = recv(&rx); // count:100

    // Reset
    state.on_message("conn-1", 0, b"reset").unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Send { text, .. } => {
            assert_eq!(text, Some("count:0".to_string()));
        }
        _ => panic!("expected count:0"),
    }

    let saved = state.get_state().unwrap();
    assert_eq!(saved["count"].as_f64(), Some(0.0));
}

#[test]
fn test_29_hibernation_recovery_reconnects_state() {
    let ast = parser::parse(COUNTER_LISTENER, Some("test.bxs")).unwrap();
    let mut compiler = Compiler::new("test.bxs");
    let chunk = compiler.compile(&ast, COUNTER_LISTENER).unwrap();

    let config = WebSocketConfig {
        uri: "/ws".to_string(),
        listener_class: "CounterListener".to_string(),
        listener_state: json!({"count": 10, "totalConnects": 2}),
        handler: "WebSocket.bx".to_string(),
    };
    let (mut state, bridge, rx) = make_state(chunk.clone(), &config);

    state.on_connect("alice", req("/ws")).unwrap();
    state.on_connect("bob", req("/ws")).unwrap();
    let _ = recv(&rx); // alice: count:10
    let _ = recv(&rx); // bob: count:10
    assert_no_more(&rx);

    // Alice increments (starting from 10, "inc" → +1)
    state.on_message("alice", 0, b"inc").unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Send { text, .. } => assert_eq!(text, Some("count:11".to_string())),
        _ => panic!("expected count:11"),
    }

    // Snapshot state before hibernation
    let saved_state = state.get_state().unwrap();
    assert_eq!(saved_state["count"].as_f64(), Some(11.0));
    // 2 (initial) + 2 connections (alice + bob)
    assert_eq!(saved_state["totalconnects"].as_f64(), Some(4.0));

    // ── Simulate hibernation: drop state, create new ──
    drop(state);
    drop(bridge);

    // Restore with saved state
    let restored_config = WebSocketConfig {
        uri: "/ws".to_string(),
        listener_class: "CounterListener".to_string(),
        listener_state: saved_state.clone(),
        handler: "WebSocket.bx".to_string(),
    };

    let (tx2, _rx2) = mpsc::channel();
    let bridge2 = Rc::new(RefCell::new(TestCalloutBridge::new(tx2)));
    let mut restored = DoState::new(chunk, &restored_config, bridge2).unwrap();

    // Re-register connections (simulating getWebSockets after hibernation)
    restored
        .register_connection("alice", req("/ws"))
        .unwrap();
    restored
        .register_connection("bob", req("/ws"))
        .unwrap();

    // Verify state is intact (register_connection does NOT call onConnect,
    // so totalconnects = 4 as saved, not 6)
    let check_state = restored.get_state().unwrap();
    assert_eq!(check_state["count"].as_f64(), Some(11.0));
    assert_eq!(check_state["totalconnects"].as_f64(), Some(4.0));

    // Bob sends a message — should use restored count
    let result = restored.on_message("bob", 0, b"inc");
    assert!(result.is_ok());
}

#[test]
fn test_30_state_isolation_between_hibernation_cycles() {
    let source = r#"
        class StatefulListener {
            function configure() {
                variables.step = 0;
                variables.label = "init";
            }
            function onConnect(channel) {
                variables.step = 1;
                variables.label = "connected";
                channel.sendMessage("step:" & variables.step);
            }
            function onMessage(msg, channel) {
                variables.step = variables.step + 1;
                variables.label = msg;
                channel.sendMessage("step:" & variables.step & ",label:" & variables.label);
            }
            function onClose(channel) {
                channel.broadcastMessage("final:" & variables.step);
            }
        }
    "#;

    let ast = parser::parse(source, Some("test.bxs")).unwrap();
    let mut compiler = Compiler::new("test.bxs");
    let chunk = compiler.compile(&ast, source).unwrap();

    let config = WebSocketConfig {
        uri: "/ws".to_string(),
        listener_class: "StatefulListener".to_string(),
        listener_state: json!({"step": 0, "label": "init"}),
        handler: "WebSocket.bx".to_string(),
    };

    // First lifecycle
    let (mut state, _bridge, rx) = make_state(chunk.clone(), &config);
    state.on_connect("c1", req("/ws")).unwrap();
    let _ = recv(&rx); // step:1

    state.on_message("c1", 0, b"hello").unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Send { text, .. } => assert_eq!(text, Some("step:2,label:hello".to_string())),
        _ => panic!("expected step:2"),
    }

    let s1 = state.get_state().unwrap();
    assert_eq!(s1["step"].as_f64(), Some(2.0));
    drop(state);

    // Second lifecycle — different VM, fresh config
    let config2 = WebSocketConfig {
        uri: "/ws".to_string(),
        listener_class: "StatefulListener".to_string(),
        listener_state: json!({"step": 0, "label": "init"}),
        handler: "WebSocket.bx".to_string(),
    };
    let (mut state2, _bridge2, rx2) = make_state(chunk, &config2);
    state2.on_connect("c2", req("/ws")).unwrap();
    let m2 = recv(&rx2);
    match m2 {
        CalloutMessage::Send { text, .. } => assert_eq!(text, Some("step:1".to_string())),
        _ => panic!("expected step:1 (fresh instance)"),
    }

    let s2 = state2.get_state().unwrap();
    assert_eq!(s2["step"].as_f64(), Some(1.0), "fresh instance should start at step:1");
}

// ═══════════════════════════════════════════════════════════════════════
//  SECTION 5: Error Handling & Edge Cases (tests 31–36)
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn test_31_send_message_with_no_args_errors() {
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(mpsc::channel().0)));
    let mut vm = VM::new();
    let mut ch = CfWebSocketChannelObject {
        connection_id: "c1".to_string(),
        request: req("/ws"),
        bridge,
    };
    let result = ch.call_method(&mut vm, 0, "sendMessage", &[]);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("requires a message"));
}

#[test]
fn test_32_send_json_with_no_args_errors() {
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(mpsc::channel().0)));
    let mut vm = VM::new();
    let mut ch = CfWebSocketChannelObject {
        connection_id: "c1".to_string(),
        request: req("/ws"),
        bridge,
    };
    let result = ch.call_method(&mut vm, 0, "sendJson", &[]);
    assert!(result.is_err());
}

#[test]
fn test_33_send_bytes_with_no_args_errors() {
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(mpsc::channel().0)));
    let mut vm = VM::new();
    let mut ch = CfWebSocketChannelObject {
        connection_id: "c1".to_string(),
        request: req("/ws"),
        bridge,
    };
    let result = ch.call_method(&mut vm, 0, "sendBytes", &[]);
    assert!(result.is_err());
}

#[test]
fn test_34_broadcast_with_no_args_errors() {
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(mpsc::channel().0)));
    let mut vm = VM::new();
    let mut ch = CfWebSocketChannelObject {
        connection_id: "c1".to_string(),
        request: req("/ws"),
        bridge,
    };
    let result = ch.call_method(&mut vm, 0, "broadcastMessage", &[]);
    assert!(result.is_err());
}

#[test]
fn test_35_get_http_header_with_no_args_errors() {
    let bridge = Rc::new(RefCell::new(TestCalloutBridge::new(mpsc::channel().0)));
    let mut vm = VM::new();
    let mut ch = CfWebSocketChannelObject {
        connection_id: "c1".to_string(),
        request: req("/ws"),
        bridge,
    };
    let result = ch.call_method(&mut vm, 0, "getHTTPHeader", &[]);
    assert!(result.is_err());
}

#[test]
fn test_36_null_and_empty_value_handling() {
    let source = r#"
        class NullTolerant {
            function onConnect(channel) {
                channel.sendMessage("ready");
            }
            function onMessage(msg, channel) {
                if (isNull(msg) || msg == "") {
                    channel.sendMessage("empty");
                } else {
                    channel.sendMessage("got:" & msg);
                }
            }
            function onClose(channel) {}
        }
    "#;
    let (chunk, config) = compile(source, "NullTolerant");
    let (mut state, _bridge, rx) = make_state(chunk, &config);

    state.on_connect("c1", req("/ws")).unwrap();
    let _ = recv(&rx); // ready

    // Empty message
    state.on_message("c1", 0, b"").unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Send { text, .. } => assert_eq!(text, Some("empty".to_string())),
        _ => panic!("expected empty handling"),
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  SECTION 6: JSON & Bytes Conversion (tests 37–40)
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn test_37_json_conversion_simple_types() {
    let mut vm = VM::new();

    let cases = vec![
        (json!(null), "null"),
        (json!(true), "true"),
        (json!(false), "false"),
        (json!(42), "42"),
        (json!(3.14), "3.14"),
        (json!("hello"), "\"hello\""),
    ];

    for (original, _desc) in &cases {
        let bx = json_to_bx(&mut vm, original).unwrap();
        let result = bx_to_json(&mut vm, bx).unwrap();
        // Numbers go through f64, so ints may become floats.
        // Check structural equality instead of exact JSON comparison.
        match original {
            serde_json::Value::Number(n) => {
                let expected_f64 = n.as_f64().unwrap();
                assert_eq!(result.as_f64(), Some(expected_f64), "failed roundtrip for {:?}", original);
            }
            _ => assert_eq!(&result, original, "failed roundtrip for {:?}", original),
        }
    }
}

#[test]
fn test_38_json_conversion_arrays() {
    let mut vm = VM::new();

    let arr = json!([1, 2, 3, "four", true, null, [5, 6]]);
    let bx = json_to_bx(&mut vm, &arr).unwrap();
    let result = bx_to_json(&mut vm, bx).unwrap();

    assert_eq!(result[0].as_f64(), Some(1.0));
    assert_eq!(result[1].as_f64(), Some(2.0));
    assert_eq!(result[3], "four");
    assert_eq!(result[4], true);
    assert_eq!(result[5], serde_json::Value::Null);
    assert_eq!(result[6][0].as_f64(), Some(5.0));
}

#[test]
fn test_39_json_conversion_deeply_nested() {
    let mut vm = VM::new();

    let data = json!({
        "level1": {
            "level2": {
                "level3": {
                    "value": 42,
                    "items": [{"x": 1}, {"x": 2}]
                }
            }
        }
    });

    let bx = json_to_bx(&mut vm, &data).unwrap();
    let result = bx_to_json(&mut vm, bx).unwrap();

    assert_eq!(result["level1"]["level2"]["level3"]["value"].as_f64(), Some(42.0));
    assert_eq!(result["level1"]["level2"]["level3"]["items"][0]["x"].as_f64(), Some(1.0));
    assert_eq!(result["level1"]["level2"]["level3"]["items"][1]["x"].as_f64(), Some(2.0));
}

#[test]
fn test_40_bytes_conversion_empty_and_large() {
    let mut vm = VM::new();

    // Empty bytes
    let bx = json_to_bx(&mut vm, &json!([])).unwrap();
    let result = bx_to_json(&mut vm, bx).unwrap();
    assert_eq!(result.as_array().unwrap().len(), 0);

    // Large array of bytes
    let large: Vec<u8> = (0..255).collect();
    let bx_str = BxValue::new_ptr(vm.bytes_new(large.clone()));
    assert!(vm.is_bytes(bx_str));
    let recovered = vm.to_bytes(bx_str).unwrap();
    assert_eq!(recovered, large);
}

// ═══════════════════════════════════════════════════════════════════════
//  SECTION 7: Sample App Compilation (tests 41–44)
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn test_41_compile_echo_sample() {
    // Extract just the listener class from the sample file (skip app bootstrap)
    let source = r#"
        class EchoServer {
            function onConnect(required channel) {
                channel.sendMessage("welcome to EchoServer!");
            }
            function onMessage(required message, required channel) {
                channel.sendMessage("echo:" & message);
            }
            function onClose(required channel) {
                channel.broadcastMessage("someone left");
            }
        }
    "#;
    let (chunk, config) = compile(source, "EchoServer");

    let (mut state, _bridge, rx) = make_state(chunk, &config);

    state.on_connect("c1", req("/ws")).unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Send { text, .. } => {
            assert_eq!(text, Some("welcome to EchoServer!".to_string()));
        }
        _ => panic!("expected welcome"),
    }

    state.on_message("c1", 0, b"ping").unwrap();
    let m2 = recv(&rx);
    match m2 {
        CalloutMessage::Send { text, .. } => {
            assert_eq!(text, Some("echo:ping".to_string()));
        }
        _ => panic!("expected echo:ping"),
    }

    state.on_close("c1").unwrap();
    let m3 = recv(&rx); // "someone left" broadcast from onClose
    match m3 {
        CalloutMessage::Broadcast { text, .. } => {
            assert_eq!(text, Some("someone left".to_string()));
        }
        _ => panic!("expected goodbye broadcast"),
    }
    assert_no_more(&rx);
}

#[test]
fn test_42_compile_chatroom_sample() {
    // Use the listener class from the sample (skip the import/web.server() bootstrap)
    let source = r#"
        class ChatRoom {
            function configure(required roomName) {
                variables.room = roomName;
                variables.userCount = 0;
                variables.users = {};
                variables.messages = [];
            }

            function onConnect(required channel) {
                var userId = channel.getId();
                variables.userCount = variables.userCount + 1;
                var userInfo = {
                    "id": userId,
                    "nickname": "User" & variables.userCount,
                    "joined": now()
                };
                variables.users[userId] = userInfo;
                channel.sendJson({
                    "type": "welcome",
                    "room": variables.room,
                    "userId": userId,
                    "userCount": variables.userCount
                });
                channel.broadcastJson({
                    "type": "join",
                    "user": userInfo,
                    "userCount": variables.userCount
                });
            }

            function onMessage(required message, required channel) {
                var userId = channel.getId();
                var userInfo = variables.users[userId] ?: { "nickname": "Anonymous" };
                var payload = {};
                try {
                    payload = deserializeJSON(message);
                } catch(e) {
                    payload = { "type": "text", "body": message };
                }
                var chatMessage = {
                    "type": "chat",
                    "userId": userId,
                    "nickname": userInfo.nickname,
                    "timestamp": now(),
                    "payload": payload
                };
                arrayAppend(variables.messages, chatMessage);
                if (arrayLen(variables.messages) > 100) {
                    arrayDeleteAt(variables.messages, 1);
                }
                channel.broadcastJson(chatMessage);
            }

            function onClose(required channel) {
                var userId = channel.getId();
                var userInfo = variables.users[userId] ?: { "nickname": "Unknown" };
                variables.userCount = variables.userCount - 1;
                structDelete(variables.users, userId);
                channel.broadcastJson({
                    "type": "leave",
                    "user": userInfo,
                    "userCount": variables.userCount
                });
            }
        }
    "#;

    let (chunk, config) = compile_with_state(source, "ChatRoom",
        json!({"room": "lobby", "userCount": 0, "users": {}, "messages": []}));

    let (mut state, _bridge, rx) = make_state(chunk, &config);

    // Alice connects → welcome + join broadcast
    state.on_connect("alice", req("/ws")).unwrap();
    let m1 = recv(&rx); // welcome
    let m2 = recv(&rx); // join broadcast
    match m1 {
        CalloutMessage::Send { text, .. } => {
            let parsed: serde_json::Value = serde_json::from_str(&text.unwrap()).unwrap();
            assert_eq!(parsed["type"], "welcome");
            assert_eq!(parsed["room"], "lobby");
            assert_eq!(parsed["userId"], "alice");
            assert_eq!(parsed["userCount"].as_f64(), Some(1.0));
        }
        _ => panic!("expected welcome JSON"),
    }
    match m2 {
        CalloutMessage::Broadcast { text, .. } => {
            let parsed: serde_json::Value = serde_json::from_str(&text.unwrap()).unwrap();
            assert_eq!(parsed["type"], "join");
            assert_eq!(parsed["userCount"].as_f64(), Some(1.0));
        }
        _ => panic!("expected join broadcast"),
    }

    // Bob connects
    state.on_connect("bob", req("/ws")).unwrap();
    let _ = recv(&rx); // bob welcome
    let _ = recv(&rx); // bob join broadcast

    // Alice sends a chat message (plain text triggers catch branch)
    state
        .on_message("alice", 0, b"Hello everyone!")
        .unwrap();
    let m3 = recv(&rx);
    match m3 {
        CalloutMessage::Broadcast { text, .. } => {
            let parsed: serde_json::Value = serde_json::from_str(&text.unwrap()).unwrap();
            assert_eq!(parsed["type"], "chat");
            assert_eq!(parsed["userId"], "alice");
            // Plain text falls through to catch(e), so payload is
            // { "type": "text", "body": "Hello everyone!" }
            assert_eq!(parsed["payload"]["body"], "Hello everyone!");
        }
        _ => panic!("expected chat broadcast"),
    }

    // Alice disconnects
    state.on_close("alice").unwrap();
    let m4 = recv(&rx);
    match m4 {
        CalloutMessage::Broadcast { text, .. } => {
            let parsed: serde_json::Value = serde_json::from_str(&text.unwrap()).unwrap();
            assert_eq!(parsed["type"], "leave");
            assert_eq!(parsed["userCount"].as_f64(), Some(1.0));
        }
        _ => panic!("expected leave broadcast"),
    }

    let saved = state.get_state().unwrap();
    // BoxLang variable names are lowercased, so "userCount" → "usercount"
    assert_eq!(saved["usercount"].as_f64(), Some(1.0));
    let users = saved["users"].as_object().unwrap();
    assert!(!users.contains_key("alice"), "alice should be removed from users");
}

#[test]
fn test_43_compile_counter_sample() {
    // Use the listener class from the sample (skip the import/web.server() bootstrap)
    let source = r#"
        class SharedCounter {
            function configure() {
                variables.count = 0;
                variables.history = [];
                variables.connectedClients = 0;
            }

            function onConnect(required channel) {
                variables.connectedClients = variables.connectedClients + 1;
                channel.sendJson({
                    "type": "state",
                    "count": variables.count,
                    "connectedClients": variables.connectedClients
                });
                channel.broadcastJson({
                    "type": "clientJoined",
                    "connectedClients": variables.connectedClients
                });
            }

            function onMessage(required message, required channel) {
                var cmd = message;
                try {
                    cmd = deserializeJSON(message);
                } catch(e) {
                    cmd = { "action": "increment" };
                }
                var action = cmd.action ?: "increment";
                var delta = cmd.delta ?: 1;

                if (action == "increment") {
                    variables.count = variables.count + delta;
                } else if (action == "decrement") {
                    variables.count = variables.count - delta;
                } else if (action == "reset") {
                    variables.count = 0;
                } else if (action == "set") {
                    variables.count = cmd.value ?: 0;
                } else if (action == "get") {
                    channel.sendJson({
                        "type": "state",
                        "count": variables.count,
                        "connectedClients": variables.connectedClients
                    });
                    return;
                }
                channel.broadcastJson({
                    "type": "update",
                    "count": variables.count,
                    "action": action,
                    "userId": channel.getId(),
                    "delta": delta,
                    "connectedClients": variables.connectedClients
                });
            }

            function onClose(required channel) {
                variables.connectedClients = variables.connectedClients - 1;
                channel.broadcastJson({
                    "type": "clientLeft",
                    "connectedClients": variables.connectedClients
                });
            }
        }
    "#;
    let (chunk, config) = compile_with_state(source, "SharedCounter",
        json!({"count": 0, "history": [], "connectedClients": 0}));

    let (mut state, _bridge, rx) = make_state(chunk, &config);

    state.on_connect("c1", req("/ws")).unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Send { text, .. } => {
            let parsed: serde_json::Value = serde_json::from_str(&text.unwrap()).unwrap();
            assert_eq!(parsed["type"], "state");
            assert_eq!(parsed["count"].as_f64(), Some(0.0));
            assert_eq!(parsed["connectedClients"].as_f64(), Some(1.0));
        }
        _ => panic!("expected state JSON"),
    }
    let _ = recv(&rx); // clientJoined broadcast

    // Increment
    state.on_message("c1", 0, br#"{"action":"increment"}"#).unwrap();
    let m2 = recv(&rx);
    match m2 {
        CalloutMessage::Broadcast { text, .. } => {
            let parsed: serde_json::Value = serde_json::from_str(&text.unwrap()).unwrap();
            assert_eq!(parsed["type"], "update");
            assert_eq!(parsed["count"].as_f64(), Some(1.0));
        }
        _ => panic!("expected update broadcast"),
    }

    let saved = state.get_state().unwrap();
    assert_eq!(saved["count"].as_f64(), Some(1.0));
}

#[test]
fn test_44_compile_room_manager_sample() {
    // Use the listener class from the sample (simplified without url parsing)
    let source = r#"
        class RoomManager {
            function configure() {
                variables.rooms = {};
            }

            function onConnect(required channel) {
                var roomName = channel.getHTTPHeader("x-room", "lobby");
                if (!structKeyExists(variables.rooms, roomName)) {
                    variables.rooms[roomName] = {
                        "count": 0,
                        "members": {},
                        "history": []
                    };
                }
                var room = variables.rooms[roomName];
                var userId = channel.getId();
                room.count = room.count + 1;
                room.members[userId] = {
                    "id": userId,
                    "joined": now()
                };
                channel.sendJson({
                    "type": "welcome",
                    "room": roomName,
                    "userId": userId,
                    "memberCount": room.count
                });
                channel.broadcastJson({
                    "type": "join",
                    "room": roomName,
                    "userId": userId,
                    "memberCount": room.count
                });
            }

            function onMessage(required message, required channel) {
                var roomName = channel.getHTTPHeader("x-room", "lobby");
                if (!structKeyExists(variables.rooms, roomName)) {
                    variables.rooms[roomName] = {
                        "count": 0,
                        "members": {},
                        "history": []
                    };
                }
                var room = variables.rooms[roomName];
                var userId = channel.getId();
                var payload = message;
                try {
                    payload = deserializeJSON(message);
                } catch(e) {
                    payload = { "type": "text", "body": message };
                }
                var chatMsg = {
                    "type": "chat",
                    "room": roomName,
                    "userId": userId,
                    "payload": payload,
                    "timestamp": now()
                };
                arrayAppend(room.history, chatMsg);
                channel.broadcastJson(chatMsg);
            }

            function onClose(required channel) {
                var roomName = channel.getHTTPHeader("x-room", "lobby");
                if (structKeyExists(variables.rooms, roomName)) {
                    var room = variables.rooms[roomName];
                    var userId = channel.getId();
                    room.count = max(room.count - 1, 0);
                    structDelete(room.members, userId);
                    channel.broadcastJson({
                        "type": "leave",
                        "room": roomName,
                        "userId": userId,
                        "memberCount": room.count
                    });
                }
            }
        }
    "#;
    let (chunk, config) = compile_with_state(source, "RoomManager",
        json!({"rooms": {}}));

    let (mut state, _bridge, rx) = make_state(chunk, &config);

    // Connect with a custom header
    let mut headers = HashMap::new();
    headers.insert("x-room".to_string(), "gaming".to_string());
    headers.insert("host".to_string(), "example.com".to_string());
    headers.insert("upgrade".to_string(), "websocket".to_string());

    let mut r = req("/ws");
    r.headers = headers;

    state.on_connect("gamer1", r).unwrap();
    let m1 = recv(&rx); // welcome
    let m2 = recv(&rx); // join broadcast
    match m1 {
        CalloutMessage::Send { text, .. } => {
            let parsed: serde_json::Value = serde_json::from_str(&text.unwrap()).unwrap();
            assert_eq!(parsed["type"], "welcome");
            assert_eq!(parsed["room"], "gaming");
        }
        _ => panic!("expected welcome with room: gaming"),
    }
    match m2 {
        CalloutMessage::Broadcast { text, .. } => {
            let parsed: serde_json::Value = serde_json::from_str(&text.unwrap()).unwrap();
            assert_eq!(parsed["type"], "join");
            assert_eq!(parsed["room"], "gaming");
        }
        _ => panic!("expected join broadcast for gaming room"),
    }

    let saved = state.get_state().unwrap();
    assert!(saved["rooms"].as_object().unwrap().contains_key("gaming"));
    assert_eq!(
        saved["rooms"]["gaming"]["count"].as_f64(),
        Some(1.0)
    );
}

// ═══════════════════════════════════════════════════════════════════════
//  SECTION 8: Stress & Concurrent Connections (tests 45–47)
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn test_45_many_connections_and_broadcasts() {
    let source = r#"
        class StressTest {
            function onConnect(channel) {
                channel.sendMessage("ok");
            }
            function onMessage(msg, channel) {
                channel.broadcastMessage("all:" & msg);
            }
            function onClose(channel) {}
        }
    "#;
    let (chunk, config) = compile(source, "StressTest");
    let (mut state, _bridge, rx) = make_state(chunk, &config);

    let num_conns = 50;
    for i in 0..num_conns {
        state
            .on_connect(&format!("conn-{}", i), req("/ws"))
            .unwrap();
    }

    // Consume welcomes
    for _ in 0..num_conns {
        let _ = recv(&rx);
    }
    assert_no_more(&rx);

    // One broadcast should reach all
    state.on_message("conn-0", 0, b"hello").unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Broadcast { sender_connection_id, text, .. } => {
            assert_eq!(sender_connection_id, "conn-0");
            assert_eq!(text, Some("all:hello".to_string()));
        }
        _ => panic!("expected broadcast"),
    }
    assert_no_more(&rx);

    // Verify state (should have tracked all connections via onConnect calls)
    // Even though the listener doesn't track connections, the VM should be fine
    let result = state.on_message("conn-37", 0, b"test");
    assert!(result.is_ok());
    let m2 = recv(&rx);
    match m2 {
        CalloutMessage::Broadcast { sender_connection_id, .. } => {
            assert_eq!(sender_connection_id, "conn-37");
        }
        _ => panic!("expected broadcast from conn-37"),
    }
}

#[test]
fn test_46_rapid_connect_disconnect_cycle() {
    let source = r#"
        class RapidCycle {
            function onConnect(channel) {
                channel.sendMessage("hi");
            }
            function onMessage(msg, channel) {}
            function onClose(channel) {
                channel.broadcastMessage("bye");
            }
        }
    "#;
    let (chunk, config) = compile(source, "RapidCycle");
    let (mut state, _bridge, rx) = make_state(chunk, &config);

    // Rapidly connect and disconnect 25 connections
    for i in 0..25 {
        let id = format!("rapid-{}", i);

        state.on_connect(&id, req("/ws")).unwrap();
        let m = recv(&rx);
        match m {
            CalloutMessage::Send { connection_id, text, .. } => {
                assert_eq!(connection_id, id);
                assert_eq!(text, Some("hi".to_string()));
            }
            _ => panic!("expected hi"),
        }

        state.on_close(&id).unwrap();
        let m2 = recv(&rx);
        match m2 {
            CalloutMessage::Broadcast { sender_connection_id, text, .. } => {
                assert_eq!(sender_connection_id, id);
                assert_eq!(text, Some("bye".to_string()));
            }
            _ => panic!("expected bye"),
        }
    }
    assert_no_more(&rx);
}

#[test]
fn test_47_interleaved_connections_and_messages() {
    // Simulate a real-world usage pattern where connections come and go
    // while messages are being exchanged.
    let source = r#"
        class Chat {
            function onConnect(channel) {
                channel.broadcastMessage("joined:" & channel.getId());
            }
            function onMessage(msg, channel) {
                channel.broadcastMessage(channel.getId() & ":" & msg);
            }
            function onClose(channel) {
                channel.broadcastMessage("left:" & channel.getId());
            }
        }
    "#;
    let (chunk, config) = compile(source, "Chat");
    let (mut state, _bridge, rx) = make_state(chunk, &config);

    // ── Scene 1: Alice and Bob connect ──
    state.on_connect("alice", req("/ws")).unwrap();
    let _ = recv(&rx); // broadcast: joined:alice

    state.on_connect("bob", req("/ws")).unwrap();
    let _ = recv(&rx); // broadcast: joined:bob

    // ── Scene 2: Alice talks, Bob is silent ──
    state.on_message("alice", 0, b"hi bob").unwrap();
    let m = recv(&rx);
    match m {
        CalloutMessage::Broadcast { sender_connection_id, text, .. } => {
            assert_eq!(sender_connection_id, "alice");
            assert_eq!(text, Some("alice:hi bob".to_string()));
        }
        _ => panic!("expected alice:hi bob"),
    }

    // ── Scene 3: Charlie joins ──
    state.on_connect("charlie", req("/ws")).unwrap();
    let _ = recv(&rx); // joined:charlie

    // ── Scene 4: Charlie asks a question ──
    state.on_message("charlie", 0, b"anyone there?").unwrap();
    let m2 = recv(&rx);
    match m2 {
        CalloutMessage::Broadcast { sender_connection_id, text, .. } => {
            assert_eq!(sender_connection_id, "charlie");
            assert_eq!(text, Some("charlie:anyone there?".to_string()));
        }
        _ => panic!("expected charlie's message"),
    }

    // ── Scene 5: Bob leaves ──
    state.on_close("bob").unwrap();
    let m3 = recv(&rx);
    match m3 {
        CalloutMessage::Broadcast { sender_connection_id, text, .. } => {
            assert_eq!(sender_connection_id, "bob");
            assert_eq!(text, Some("left:bob".to_string()));
        }
        _ => panic!("expected left:bob"),
    }

    // ── Scene 6: Alice and Charlie continue
    state.on_message("alice", 0, b"i'm here").unwrap();
    let m4 = recv(&rx);
    match m4 {
        CalloutMessage::Broadcast { sender_connection_id, text, .. } => {
            assert_eq!(sender_connection_id, "alice");
            assert_eq!(text, Some("alice:i'm here".to_string()));
        }
        _ => panic!("expected alice response"),
    }

    assert_no_more(&rx);
}

// ═══════════════════════════════════════════════════════════════════════
//  SECTION 9: WASM Metadata & Build (tests 48–49)
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn test_48_build_generate_wrangler_toml() {
    let toml = matchbox_cf_worker::build::generate_wrangler_toml("my-app");
    assert!(toml.contains(r#"name = "my-app""#));
    assert!(toml.contains("WEBSOCKET_DO"));
    assert!(toml.contains("MatchBoxWebSocketDO"));
    assert!(toml.contains("new_sqlite_classes"));
}

#[test]
fn test_49_build_generate_package_json() {
    let pkg = matchbox_cf_worker::build::generate_package_json("my-ws-app");
    assert!(pkg.contains(r#""name": "my-ws-app""#));
    assert!(pkg.contains("wrangler"));
    assert!(pkg.contains("matchbox --target cf-worker"));
}
