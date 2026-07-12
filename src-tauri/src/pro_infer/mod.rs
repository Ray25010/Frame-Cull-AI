//! Pro native ONNX Runtime inference layer (PRO_MODEL_ARCHITECTURE.md §10).
//!
//! Entire module is gated behind `#[cfg(feature = "pro")]` (applied at the
//! `mod pro_infer` declaration in `lib.rs`), so the Flash build never compiles
//! `ort`/`ndarray` or any of this code. The layer only owns the new distilled
//! multi-head model; YuNet / MediaPipe / SFace / rule engine stay in the wasm
//! worker untouched.

pub mod ep;
pub mod infer;
pub mod preprocess;
#[cfg(windows)]
pub mod runtime;
pub mod session;
pub mod types;

#[cfg(test)]
mod tests;

use tauri::{AppHandle, Manager, State};

pub use session::ProInferState;
use types::{ProBatchRequest, ProBatchResponse, ProInferCapabilities};

/// Probe execution providers, load backbone + heads from the manifest, warm up,
/// and report the capabilities actually in effect. Initialization failures never
/// panic the host process; they return `Err` and the caller can retry.
#[tauri::command]
pub async fn pro_infer_init(
    app: AppHandle,
    state: State<'_, ProInferState>,
    manifest_path: String,
) -> Result<ProInferCapabilities, String> {
    let resource_dir = app.path().resource_dir().ok();
    let result = tauri::async_runtime::spawn_blocking(move || {
        session::init_model(&manifest_path, resource_dir)
    })
    .await
    .map_err(|error| format!("pro_infer_init task join failed: {error}"))?;

    let (loaded, capabilities) = result?;
    let mut guard = state
        .model
        .lock()
        .map_err(|_| "pro infer state poisoned".to_string())?;
    *guard = Some(loaded);
    Ok(capabilities)
}

/// Run batch inference over image paths. Rust owns decode + resize 384 +
/// normalize + batch packing; per-image failures isolate into that image's
/// `error` field instead of failing the whole batch.
#[tauri::command]
pub async fn pro_infer_batch(
    state: State<'_, ProInferState>,
    req: ProBatchRequest,
) -> Result<ProBatchResponse, String> {
    let mut guard = state
        .model
        .lock()
        .map_err(|_| "pro infer state poisoned".to_string())?;
    let model = guard
        .as_mut()
        .ok_or_else(|| "pro_infer not initialized; call pro_infer_init first".to_string())?;
    Ok(infer::run_batch(model, &req))
}
