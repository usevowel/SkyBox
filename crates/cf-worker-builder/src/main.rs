//! cf-worker-builder — Compile BoxLang sources and embed them into a
//! Cloudflare Worker WASM binary with custom sections.
//!
//! Usage:
//!   cf-worker-builder \
//!     --source samples/echo.bxs \
//!     --listener-class EchoListener \
//!     --input target/matchbox_cf_worker.wasm \
//!     --output dist/worker.wasm \
//!     [--ws-uri /ws] \
//!     [--handler WebSocket.bx] \
//!     [--state '{"count": 0}']
//!
//! The tool:
//!   1. Compiles the .bxs source to a bytecode Chunk
//!   2. Serializes the Chunk + WebSocketConfig
//!   3. Embeds them as WASM custom sections ("skybox:chunk", "skybox:ws_config")
//!   4. Writes the final WASM to the output path

use anyhow::{Context, Result};
use matchbox_compiler::{compiler::Compiler, parser};
use matchbox_vm::vm::chunk::Chunk;
use std::path::Path;
use std::process;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSocketConfig {
    uri: String,
    listener_class: String,
    #[serde(default)]
    listener_state: serde_json::Value,
    #[serde(default = "default_handler")]
    handler: String,
}

fn default_handler() -> String {
    "WebSocket.bx".to_string()
}

fn compile_source(source_path: &Path) -> Result<Chunk> {
    let source = std::fs::read_to_string(source_path)
        .with_context(|| format!("Failed to read source: {}", source_path.display()))?;

    let filename = source_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("app.bxs");

    let ast = parser::parse(&source, Some(filename))
        .with_context(|| format!("Failed to parse: {}", source_path.display()))?;

    let mut compiler = Compiler::new(filename);
    let chunk = compiler
        .compile(&ast, &source)
        .with_context(|| format!("Failed to compile: {}", source_path.display()))?;

    // Class existence is validated by the compiler — if the class
    // definition has errors, compilation itself will fail.

    Ok(chunk)
}

/// Encode a single LEB128 unsigned integer.
fn leb128_encode(mut value: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        bytes.push(byte);
        if value == 0 {
            break;
        }
    }
    bytes
}

/// Build a WASM custom section: section_id(0) + size + name_len + name + data
fn build_custom_section(name: &str, data: &[u8]) -> Vec<u8> {
    let name_bytes = name.as_bytes();
    let content_len = leb128_encode(name_bytes.len() as u32)
        .len() as u32
        + name_bytes.len() as u32
        + data.len() as u32;

    let mut section = Vec::new();
    // Section ID: 0 = custom
    section.push(0);
    // Section length (LEB128)
    section.extend_from_slice(&leb128_encode(content_len));
    // Name length (LEB128)
    section.extend_from_slice(&leb128_encode(name_bytes.len() as u32));
    // Name
    section.extend_from_slice(name_bytes);
    // Data
    section.extend_from_slice(data);

    section
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2
        || args.contains(&"--help".to_string())
        || args.contains(&"-h".to_string())
    {
        eprintln!("Usage: cf-worker-builder --source <path> --listener-class <name> --input <wasm> --output <wasm> [options]");
        eprintln!("");
        eprintln!("Required:");
        eprintln!("  --source <path>         Path to the .bxs source file");
        eprintln!("  --listener-class <name>  Name of the listener class");
        eprintln!("  --input <path>          Path to the input WASM binary");
        eprintln!("  --output <path>         Path to write the output WASM binary");
        eprintln!("");
        eprintln!("Options:");
        eprintln!("  --ws-uri <uri>          WebSocket URI (default: /ws)");
        eprintln!("  --handler <path>        Handler filename (default: WebSocket.bx)");
        eprintln!("  --state <json>          Initial listener state JSON");
        eprintln!("  --state-file <path>     Path to JSON file with initial state");
        eprintln!("");
        process::exit(0);
    }

    let get_arg = |name: &str| -> Option<String> {
        let pos = args.iter().position(|a| a == name)?;
        args.get(pos + 1).cloned()
    };

    let source_path = get_arg("--source").expect("Missing --source argument");
    let class_name = get_arg("--listener-class").expect("Missing --listener-class argument");
    let input_wasm = get_arg("--input").expect("Missing --input argument");
    let output_wasm = get_arg("--output").expect("Missing --output argument");
    let ws_uri = get_arg("--ws-uri").unwrap_or_else(|| "/ws".to_string());
    let handler = get_arg("--handler").unwrap_or_else(|| "WebSocket.bx".to_string());

    let state = if let Some(json_str) = get_arg("--state") {
        serde_json::from_str(&json_str).expect("Invalid --state JSON")
    } else if let Some(path) = get_arg("--state-file") {
        let content =
            std::fs::read_to_string(&path).expect("Failed to read state file");
        serde_json::from_str(&content).expect("Invalid state file JSON")
    } else {
        serde_json::Value::Object(serde_json::Map::new())
    };

    let config = WebSocketConfig {
        uri: ws_uri,
        listener_class: class_name.clone(),
        listener_state: state,
        handler,
    };

    // Step 1: Compile the source
    eprintln!("Compiling {} -> class '{}'...", source_path, class_name);
    let chunk = match compile_source(Path::new(&source_path)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("ERROR: Compilation failed: {:#}", e);
            process::exit(1);
        }
    };
    eprintln!("  Compiled successfully ({} constants)", chunk.constants.len());

    // Step 2: Serialize the chunk
    let chunk_bytes = match postcard::to_allocvec(&chunk) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("ERROR: Chunk serialization failed: {}", e);
            process::exit(1);
        }
    };
    eprintln!("  Chunk size: {} bytes (postcard)", chunk_bytes.len());

    // Step 3: Serialize the config as JSON
    let config_json = serde_json::to_string_pretty(&config).expect("Config serialization");
    let config_bytes = config_json.as_bytes().to_vec();
    eprintln!("  Config: {}", config_json);

    // Step 4: Read the input WASM
    let wasm_bytes = match std::fs::read(&input_wasm) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("ERROR: Failed to read input WASM '{}': {}", input_wasm, e);
            process::exit(1);
        }
    };
    eprintln!("  Input WASM: {} bytes", wasm_bytes.len());

    // Step 5: Build custom sections and append
    let chunk_section = build_custom_section("skybox:chunk", &chunk_bytes);
    let config_section = build_custom_section("skybox:ws_config", &config_bytes);

    let mut output_bytes = Vec::with_capacity(wasm_bytes.len() + chunk_section.len() + config_section.len());
    output_bytes.extend_from_slice(&wasm_bytes);
    output_bytes.extend_from_slice(&chunk_section);
    output_bytes.extend_from_slice(&config_section);

    eprintln!("  Output WASM: {} bytes", output_bytes.len());

    // Step 6: Write the output
    if let Some(parent) = Path::new(&output_wasm).parent() {
        std::fs::create_dir_all(parent).ok();
    }
    match std::fs::write(&output_wasm, &output_bytes) {
        Ok(_) => eprintln!("Wrote {}", output_wasm),
        Err(e) => {
            eprintln!("ERROR: Failed to write output '{}': {}", output_wasm, e);
            process::exit(1);
        }
    }

    eprintln!("Done!");
}
