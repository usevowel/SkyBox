/* tslint:disable */
/* eslint-disable */

export function _matchbox_get_instance_keys(vm_ptr: number, gc_id: number): Array<any>;

export function _matchbox_get_instance_prop(vm_ptr: number, gc_id: number, name: string): any;

export function _matchbox_invoke_callback(vm_ptr: number, callback_id: number, this_val: any, args: Array<any>): any;

export function _matchbox_pump_vm(vm_ptr: number): void;

export function _matchbox_set_instance_prop(vm_ptr: number, gc_id: number, name: string, val: any): void;

/**
 * Serialize the current listener instance state to JSON for DO storage.
 * Called after every `onMessage` to persist changes.
 */
export function vm_get_state(): string;

/**
 * Initialize the VM with a compiled chunk from JS.
 *
 * `config_json`: JSON string of WebSocketConfig
 * `chunk_bytes`: postcard-serialized bytecode Chunk
 */
export function vm_init(config_json: string, chunk_bytes: Uint8Array): void;

/**
 * Handle a WebSocket close: call `listener.onClose(channel)`.
 */
export function vm_on_close(connection_id: string): void;

/**
 * Handle a new WebSocket connection: call `listener.onConnect(channel)`.
 */
export function vm_on_connect(connection_id: string, request_json: string): void;

/**
 * Handle a WebSocket message: call `listener.onMessage(message, channel)`.
 *
 * `msg_type`: 0 = text, 1 = binary
 */
export function vm_on_message(connection_id: string, msg_type: number, message: Uint8Array): void;

/**
 * Re-register a connection channel after DO wakes from hibernation.
 * Called for each WebSocket that was re-attached via `getWebSockets()`.
 */
export function vm_register_connection(connection_id: string, request_json: string): void;

/**
 * Rehydrate the listener's instance state from a JSON snapshot.
 * Called after DO wakes from hibernation — DO storage provides the
 * persisted state that was saved by `vm_get_state`.
 */
export function vm_set_state(state_json: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly vm_get_state: (a: number) => void;
    readonly vm_init: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly vm_on_close: (a: number, b: number, c: number) => void;
    readonly vm_on_connect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly vm_on_message: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly vm_register_connection: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly vm_set_state: (a: number, b: number, c: number) => void;
    readonly _matchbox_get_instance_keys: (a: number, b: number) => number;
    readonly _matchbox_get_instance_prop: (a: number, b: number, c: number, d: number) => number;
    readonly _matchbox_invoke_callback: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly _matchbox_pump_vm: (a: number, b: number) => void;
    readonly _matchbox_set_instance_prop: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly __wasm_bindgen_func_elem_1530: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_410: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_826: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly __wasm_bindgen_func_elem_823: (a: number, b: number, c: number, d: number) => number;
    readonly __wasm_bindgen_func_elem_824: (a: number, b: number, c: number, d: number) => number;
    readonly __wasm_bindgen_func_elem_1956: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_1970: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_822: (a: number, b: number, c: number) => number;
    readonly __wasm_bindgen_func_elem_825: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
