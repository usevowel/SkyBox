use crate::channel::json_to_bx;
use crate::types::{CalloutBridge, CalloutMessage};
use matchbox_vm::types::{BxNativeFunction, BxVM, BxValue};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// Describes a pending async operation for serialization to the JS shell.
#[derive(Clone)]
pub struct PendingAsyncOp {
    pub async_id: u64,
    pub binding_name: String,
    pub action: String,
    pub args: serde_json::Value,
}

thread_local! {
    static NEXT_ASYNC_ID: RefCell<u64> = RefCell::new(1u64);
    static PENDING_OPS: RefCell<Vec<PendingAsyncOp>> = RefCell::new(Vec::new());
    static D1_BRIDGE: RefCell<Option<Rc<RefCell<dyn CalloutBridge>>>> = RefCell::new(None);
    static ASYNC_FUTURES: RefCell<HashMap<u64, BxValue>> = RefCell::new(HashMap::new());
}

pub fn set_bridge(bridge: Rc<RefCell<dyn CalloutBridge>>) {
    D1_BRIDGE.with(|b| {
        *b.borrow_mut() = Some(bridge);
    });
}

pub fn get_pending_async_ops() -> Vec<PendingAsyncOp> {
    PENDING_OPS.with(|p| p.borrow_mut().drain(..).collect())
}

pub fn has_pending_async() -> bool {
    PENDING_OPS.with(|p| !p.borrow().is_empty())
}

pub fn next_async_id() -> u64 {
    NEXT_ASYNC_ID.with(|n| {
        let id = *n.borrow();
        *n.borrow_mut() = id + 1;
        id
    })
}

pub fn resolve_async_future(vm: &mut dyn BxVM, async_id: u64, data: serde_json::Value) -> Result<(), String> {
    ASYNC_FUTURES.with(|f| {
        if let Some(future) = f.borrow_mut().remove(&async_id) {
            let bx_val = json_to_bx(vm, &data)?;
            vm.future_schedule_resolve(future, bx_val)?;
        }
        Ok(())
    })
}

pub fn register_bifs() -> HashMap<String, BxNativeFunction> {
    let mut bifs = HashMap::new();
    bifs.insert("d1query".to_string(), d1_query_bif as BxNativeFunction);
    bifs.insert("d1execute".to_string(), d1_execute_bif as BxNativeFunction);
    bifs.insert("openrouterchat".to_string(), open_router_chat_bif as BxNativeFunction);
    bifs.insert("mxaiembed".to_string(), mxai_embed_bif as BxNativeFunction);
    bifs.insert("tursoquery".to_string(), turso_query_bif as BxNativeFunction);
    bifs.insert("tursoexecute".to_string(), turso_execute_bif as BxNativeFunction);
    bifs.insert("mxaiVectorizeUpsert".to_string(), mxai_vectorize_upsert_bif as BxNativeFunction);
    bifs.insert("mxaiVectorizeQuery".to_string(), mxai_vectorize_query_bif as BxNativeFunction);
    bifs.insert("mxaiVectorizeDeleteByIds".to_string(), mxai_vectorize_delete_by_ids_bif as BxNativeFunction);
    bifs
}

fn send_binding_callout(
    binding_name: String,
    action: &str,
    sql: String,
    params: serde_json::Value,
    vm: &mut dyn BxVM,
) -> Result<BxValue, String> {
    let async_id = next_async_id();
    let future = vm.future_new();

    let callout_msg = CalloutMessage::BindingCall {
        async_id,
        binding_name: binding_name.clone(),
        action: action.to_string(),
        args: serde_json::json!({
            "sql": sql,
            "params": params,
        }),
    };

    let result = D1_BRIDGE.with(|b| {
        let guard = b.borrow();
        let bridge_ref = guard.as_ref().ok_or_else(|| "D1 bridge not initialized".to_string())?;
        bridge_ref.borrow_mut().send_callout(&callout_msg)
    })?;

    if !result.success {
        return Err(result.error.unwrap_or_else(|| format!("D1 {} failed", action)));
    }

    if result.async_id > 0 {
        ASYNC_FUTURES.with(|f| {
            f.borrow_mut().insert(result.async_id, future.clone());
        });

        PENDING_OPS.with(|p| {
            p.borrow_mut().push(PendingAsyncOp {
                async_id: result.async_id,
                binding_name,
                action: action.to_string(),
                args: serde_json::Value::Null,
            });
        });

        vm.set_async_waiting(result.async_id);
    }

    Ok(future)
}

/// openRouterChat(bindingName, messagesJson, connectionId, userPrompt)
///
/// Fire-and-forget BindingCall to JS with action "openrouter".
/// The JS shell makes a streaming HTTP fetch to OpenRouter, pushes each
/// SSE chunk to the client WebSocket via sendToWS(), and sends ai_done
/// when finished. No async future tracking needed — JS handles everything.
///
/// The optional 4th argument `userPrompt` is forwarded to JS for D1 persistence.
fn open_router_chat_bif(vm: &mut dyn BxVM, args: &[BxValue]) -> Result<BxValue, String> {
    if args.len() < 3 {
        return Err(
            "openRouterChat(bindingName, messagesJson, connectionId, userPrompt) requires 3+ arguments"
                .to_string(),
        );
    }

    let binding_name = vm.to_string(args[0]);
    let messages_json = vm.to_string(args[1]);
    let connection_id = vm.to_string(args[2]);
    let user_prompt = if args.len() > 3 { vm.to_string(args[3]) } else { String::new() };

    let callout_msg = CalloutMessage::BindingCall {
        async_id: 0,
        binding_name: binding_name.clone(),
        action: "openrouter".to_string(),
        args: serde_json::json!({
            "messages": messages_json,
            "connection_id": connection_id,
            "user_prompt": user_prompt,
            "model": "openrouter/free",
        }),
    };

    let result = D1_BRIDGE.with(|b| {
        let guard = b.borrow();
        let bridge_ref = guard.as_ref().ok_or_else(|| "Bridge not initialized".to_string())?;
        bridge_ref.borrow_mut().send_callout(&callout_msg)
    })?;

    if !result.success {
        return Err(result.error.unwrap_or_else(|| "OpenRouter call failed".to_string()));
    }

    Ok(BxValue::new_null())
}

fn d1_query_bif(vm: &mut dyn BxVM, args: &[BxValue]) -> Result<BxValue, String> {
    if args.len() < 2 {
        return Err("d1Query(binding, sql, [params]) requires at least 2 arguments".to_string());
    }

    let binding_name = vm.to_string(args[0]);
    let sql = vm.to_string(args[1]);
    let params = if args.len() > 2 {
        crate::channel::bx_to_json(vm, args[2]).unwrap_or(serde_json::Value::Null)
    } else {
        serde_json::Value::Array(Vec::new())
    };

    send_binding_callout(binding_name, "query", sql, params, vm)
}

fn d1_execute_bif(vm: &mut dyn BxVM, args: &[BxValue]) -> Result<BxValue, String> {
    if args.len() < 2 {
        return Err("d1Execute(binding, sql, [params]) requires at least 2 arguments".to_string());
    }

    let binding_name = vm.to_string(args[0]);
    let sql = vm.to_string(args[1]);
    let params = if args.len() > 2 {
        crate::channel::bx_to_json(vm, args[2]).unwrap_or(serde_json::Value::Null)
    } else {
        serde_json::Value::Array(Vec::new())
    };

    send_binding_callout(binding_name, "execute", sql, params, vm)
}

/// mxaiEmbed(input, params, options)
///
/// Async future BindingCall with action "embed".
/// Sends the text to JS which calls env.AI.run() with the embedding model.
/// Returns the embedding array as a BoxLang value.
fn mxai_embed_bif(vm: &mut dyn BxVM, args: &[BxValue]) -> Result<BxValue, String> {
    if args.len() < 1 {
        return Err("mxaiEmbed(input, [params], [options]) requires at least 1 argument".to_string());
    }

    let input = crate::channel::bx_to_json(vm, args[0]).unwrap_or(serde_json::Value::Null);
    let params = if args.len() > 1 {
        crate::channel::bx_to_json(vm, args[1]).unwrap_or(serde_json::Value::Null)
    } else {
        serde_json::Value::Null
    };
    let options = if args.len() > 2 {
        crate::channel::bx_to_json(vm, args[2]).unwrap_or(serde_json::Value::Null)
    } else {
        serde_json::Value::Null
    };

    let async_id = next_async_id();
    let future = vm.future_new();

    let callout_msg = CalloutMessage::BindingCall {
        async_id,
        binding_name: "AI".to_string(),
        action: "embed".to_string(),
        args: serde_json::json!({
            "input": input,
            "params": params,
            "options": options,
        }),
    };

    let result = D1_BRIDGE.with(|b| {
        let guard = b.borrow();
        let bridge_ref = guard.as_ref().ok_or_else(|| "Bridge not initialized".to_string())?;
        bridge_ref.borrow_mut().send_callout(&callout_msg)
    })?;

    if !result.success {
        return Err(result.error.unwrap_or_else(|| "Embedding call failed".to_string()));
    }

    if result.async_id > 0 {
        ASYNC_FUTURES.with(|f| {
            f.borrow_mut().insert(result.async_id, future.clone());
        });
        PENDING_OPS.with(|p| {
            p.borrow_mut().push(PendingAsyncOp {
                async_id: result.async_id,
                binding_name: "AI".to_string(),
                action: "embed".to_string(),
                args: serde_json::Value::Null,
            });
        });
        vm.set_async_waiting(result.async_id);
    }

    Ok(future)
}

fn turso_query_bif(vm: &mut dyn BxVM, args: &[BxValue]) -> Result<BxValue, String> {
    if args.len() < 2 {
        return Err("tursoQuery(binding, sql, [params]) requires at least 2 arguments".to_string());
    }
    let binding_name = vm.to_string(args[0]);
    let sql = vm.to_string(args[1]);
    let params = if args.len() > 2 {
        crate::channel::bx_to_json(vm, args[2]).unwrap_or(serde_json::Value::Null)
    } else {
        serde_json::Value::Array(Vec::new())
    };
    send_binding_callout(binding_name, "turso_query", sql, params, vm)
}

fn turso_execute_bif(vm: &mut dyn BxVM, args: &[BxValue]) -> Result<BxValue, String> {
    if args.len() < 2 {
        return Err("tursoExecute(binding, sql, [params]) requires at least 2 arguments".to_string());
    }
    let binding_name = vm.to_string(args[0]);
    let sql = vm.to_string(args[1]);
    let params = if args.len() > 2 {
        crate::channel::bx_to_json(vm, args[2]).unwrap_or(serde_json::Value::Null)
    } else {
        serde_json::Value::Array(Vec::new())
    };
    send_binding_callout(binding_name, "turso_execute", sql, params, vm)
}

/// mxaiVectorizeUpsert(bindingName, vectorsJson)
///
/// Async future BindingCall with action "vectorize_upsert".
/// Sends an array of vectors to JS which calls env.VECTORIZE.upsert().
/// Each vector: { id: string, values: number[], metadata?: object }
fn mxai_vectorize_upsert_bif(vm: &mut dyn BxVM, args: &[BxValue]) -> Result<BxValue, String> {
    if args.len() < 2 {
        return Err("mxaiVectorizeUpsert(bindingName, vectorsJson) requires 2 arguments".to_string());
    }

    let binding_name = vm.to_string(args[0]);
    let vectors_json = vm.to_string(args[1]);

    let async_id = next_async_id();
    let future = vm.future_new();

    let callout_msg = CalloutMessage::BindingCall {
        async_id,
        binding_name: binding_name.clone(),
        action: "vectorize_upsert".to_string(),
        args: serde_json::json!({
            "vectors": vectors_json,
        }),
    };

    let result = D1_BRIDGE.with(|b| {
        let guard = b.borrow();
        let bridge_ref = guard.as_ref().ok_or_else(|| "D1 bridge not initialized".to_string())?;
        bridge_ref.borrow_mut().send_callout(&callout_msg)
    })?;

    if !result.success {
        return Err(result.error.unwrap_or_else(|| "Vectorize upsert failed".to_string()));
    }

    if result.async_id > 0 {
        ASYNC_FUTURES.with(|f| {
            f.borrow_mut().insert(result.async_id, future.clone());
        });
        PENDING_OPS.with(|p| {
            p.borrow_mut().push(PendingAsyncOp {
                async_id: result.async_id,
                binding_name,
                action: "vectorize_upsert".to_string(),
                args: serde_json::Value::Null,
            });
        });
        vm.set_async_waiting(result.async_id);
    }

    Ok(future)
}

/// mxaiVectorizeQuery(bindingName, vectorJson, topK, filterJson)
///
/// Async future BindingCall with action "vectorize_query".
/// Sends a query vector to JS which calls env.VECTORIZE.query().
/// Returns matches with ids, scores, and metadata.
fn mxai_vectorize_query_bif(vm: &mut dyn BxVM, args: &[BxValue]) -> Result<BxValue, String> {
    if args.len() < 2 {
        return Err("mxaiVectorizeQuery(bindingName, vectorJson, topK, filterJson) requires 2+ arguments".to_string());
    }

    let binding_name = vm.to_string(args[0]);
    let vector_json = vm.to_string(args[1]);
    let top_k = if args.len() > 2 {
        vm.to_string(args[2])
    } else {
        "5".to_string()
    };
    let filter_json = if args.len() > 3 {
        vm.to_string(args[3])
    } else {
        "{}".to_string()
    };

    let async_id = next_async_id();
    let future = vm.future_new();

    let callout_msg = CalloutMessage::BindingCall {
        async_id,
        binding_name: binding_name.clone(),
        action: "vectorize_query".to_string(),
        args: serde_json::json!({
            "vector": vector_json,
            "topK": top_k,
            "filter": filter_json,
        }),
    };

    let result = D1_BRIDGE.with(|b| {
        let guard = b.borrow();
        let bridge_ref = guard.as_ref().ok_or_else(|| "D1 bridge not initialized".to_string())?;
        bridge_ref.borrow_mut().send_callout(&callout_msg)
    })?;

    if !result.success {
        return Err(result.error.unwrap_or_else(|| "Vectorize query failed".to_string()));
    }

    if result.async_id > 0 {
        ASYNC_FUTURES.with(|f| {
            f.borrow_mut().insert(result.async_id, future.clone());
        });
        PENDING_OPS.with(|p| {
            p.borrow_mut().push(PendingAsyncOp {
                async_id: result.async_id,
                binding_name,
                action: "vectorize_query".to_string(),
                args: serde_json::Value::Null,
            });
        });
        vm.set_async_waiting(result.async_id);
    }

    Ok(future)
}

/// mxaiVectorizeDeleteByIds(bindingName, idsJson)
///
/// Async future BindingCall with action "vectorize_delete_by_ids".
/// Sends an array of IDs to JS which calls env.VECTORIZE.deleteByIds().
fn mxai_vectorize_delete_by_ids_bif(vm: &mut dyn BxVM, args: &[BxValue]) -> Result<BxValue, String> {
    if args.len() < 2 {
        return Err("mxaiVectorizeDeleteByIds(bindingName, idsJson) requires 2 arguments".to_string());
    }

    let binding_name = vm.to_string(args[0]);
    let ids_json = vm.to_string(args[1]);

    let async_id = next_async_id();
    let future = vm.future_new();

    let callout_msg = CalloutMessage::BindingCall {
        async_id,
        binding_name: binding_name.clone(),
        action: "vectorize_delete_by_ids".to_string(),
        args: serde_json::json!({
            "ids": ids_json,
        }),
    };

    let result = D1_BRIDGE.with(|b| {
        let guard = b.borrow();
        let bridge_ref = guard.as_ref().ok_or_else(|| "D1 bridge not initialized".to_string())?;
        bridge_ref.borrow_mut().send_callout(&callout_msg)
    })?;

    if !result.success {
        return Err(result.error.unwrap_or_else(|| "Vectorize delete failed".to_string()));
    }

    if result.async_id > 0 {
        ASYNC_FUTURES.with(|f| {
            f.borrow_mut().insert(result.async_id, future.clone());
        });
        PENDING_OPS.with(|p| {
            p.borrow_mut().push(PendingAsyncOp {
                async_id: result.async_id,
                binding_name,
                action: "vectorize_delete_by_ids".to_string(),
                args: serde_json::Value::Null,
            });
        });
        vm.set_async_waiting(result.async_id);
    }

    Ok(future)
}
