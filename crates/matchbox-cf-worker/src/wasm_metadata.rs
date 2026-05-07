//! WASM Custom Section helpers
//!
//! Cloudflare Workers WASM modules can embed custom sections for metadata
//! that the JS shell reads at runtime. This module provides helpers for
//! reading and writing the sections used by the WebSocket DO adapter.
//!
//! Custom sections used:
//! - `"skybox:chunk"` — the serialized bytecode Chunk (postcard)
//! - `"skybox:ws_config"` — the WebSocketConfig JSON

use crate::types::WebSocketConfig;
use matchbox_vm::vm::chunk::Chunk;

/// The names of the custom sections in the WASM binary.
pub const SECTION_CHUNK: &str = "skybox:chunk";
pub const SECTION_WS_CONFIG: &str = "skybox:ws_config";

/// Encodes the compiled chunk + WebSocketConfig into a serialized form
/// suitable for embedding in WASM custom sections.
pub fn encode_metadata(
    chunk: &Chunk,
    ws_config: Option<&WebSocketConfig>,
) -> Result<(Vec<u8>, Option<Vec<u8>>), String> {
    let chunk_bytes = postcard::to_allocvec(chunk).map_err(|e| format!("Chunk serialization error: {}", e))?;

    let ws_bytes = ws_config.map(|cfg| {
        serde_json::to_vec(cfg).expect("WebSocketConfig JSON serialization")
    });

    Ok((chunk_bytes, ws_bytes))
}

/// Decodes the compiled chunk from serialized bytes (read from WASM custom section).
pub fn decode_chunk(bytes: &[u8]) -> Result<Chunk, String> {
    postcard::from_bytes(bytes).map_err(|e| format!("Chunk deserialization error: {}", e))
}

/// Decodes WebSocketConfig from JSON bytes (read from WASM custom section).
pub fn decode_ws_config(bytes: &[u8]) -> Result<WebSocketConfig, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("WebSocketConfig deserialization error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use matchbox_compiler::{compiler::Compiler, parser};
    use serde_json::json;

    #[test]
    fn test_encode_decode_roundtrip() {
        let source = r#"
            class EchoListener {
                function onConnect(channel) {
                    channel.sendMessage("welcome");
                }
                function onMessage(msg, channel) {
                    channel.sendMessage("echo:" + msg);
                }
                function onClose(channel) {}
            }
        "#;
        let ast = parser::parse(source, Some("test.bxs")).unwrap();
        let mut compiler = Compiler::new("test.bxs");
        let chunk = compiler.compile(&ast, source).unwrap();

        let config = WebSocketConfig {
            uri: "/ws".to_string(),
            listener_class: "EchoListener".to_string(),
            listener_state: json!({}),
            handler: "WebSocket.bx".to_string(),
        };

        let (chunk_bytes, ws_bytes) = encode_metadata(&chunk, Some(&config)).unwrap();
        let ws_bytes = ws_bytes.unwrap();

        let decoded_chunk = decode_chunk(&chunk_bytes).unwrap();
        let decoded_config = decode_ws_config(&ws_bytes).unwrap();

        assert_eq!(decoded_config.uri, "/ws");
        assert_eq!(decoded_config.listener_class, "EchoListener");
        assert_eq!(decoded_config.handler, "WebSocket.bx");

        // Verify the chunk can be interpreted
        let mut vm = matchbox_vm::vm::VM::new();
        vm.interpret(decoded_chunk).unwrap();
    }
}
