//! # matchbox-cf-worker — Cloudflare Workers adapter for MatchBox
//!
//! This crate provides the WASM exports needed to run a BoxLang WebSocket
//! application inside a Cloudflare Workers Durable Object using the
//! Hibernation WebSocket API.
//!
//! ## WASM Exports (feature = "js")
//!
//! | Export | Called by | Purpose |
//! |--------|-----------|---------|
//! | `vm_init` | DO constructor | Create VM, load chunk, instantiate listener |
//! | `vm_set_state` | DO constructor | Rehydrate listener state from DO storage |
//! | `vm_register_connection` | DO constructor | Re-register channels after hibernation wake |
//! | `vm_on_connect` | DO.fetch() | Call `onConnect` on the BoxLang listener |
//! | `vm_on_message` | DO.webSocketMessage() | Call `onMessage` on the BoxLang listener |
//! | `vm_on_close` | DO.webSocketClose() | Call `onClose` on the BoxLang listener |
//! | `vm_get_state` | DO after message | Serialize listener state for DO storage |

pub mod build;
pub mod channel;
pub mod do_adapter;
pub mod types;
pub mod wasm_metadata;

#[cfg(feature = "js")]
pub mod wasm_exports;
