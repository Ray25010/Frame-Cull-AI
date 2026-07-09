//! Model loading, manifest parsing, EP registration and warmup (§10.5/§10.6).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;

use super::ep::candidate_chain;
#[cfg(windows)]
use super::runtime::prepare_cuda_runtime;
use super::types::{ProInferCapabilities, ProModelManifest};

/// Live inference session plus the metadata the batch path needs.
pub struct LoadedModel {
    pub session: Session,
    pub manifest: ProModelManifest,
    pub active_ep: String,
    pub ep_fallback_chain: Vec<String>,
}

/// Tauri-managed state. Holds an optional initialized model behind a mutex so
/// `pro_infer_init` can (re)load and `pro_infer_batch` can borrow it mutably for
/// `Session::run`.
#[derive(Default)]
pub struct ProInferState {
    pub model: Mutex<Option<LoadedModel>>,
}

fn parse_manifest(manifest_path: &Path) -> Result<(ProModelManifest, PathBuf), String> {
    let raw = fs::read_to_string(manifest_path)
        .map_err(|error| format!("failed to read manifest {manifest_path:?}: {error}"))?;
    let manifest: ProModelManifest =
        serde_json::from_str(&raw).map_err(|error| format!("invalid manifest json: {error}"))?;
    if manifest.input_resolution != 384 {
        return Err(format!(
            "manifest inputResolution must be 384, got {}",
            manifest.input_resolution
        ));
    }
    let model_dir = manifest_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let model_path = model_dir.join(&manifest.model);
    if !model_path.exists() {
        return Err(format!("model file not found: {model_path:?}"));
    }
    Ok((manifest, model_path))
}

/// Initialize the model: probe EPs by the platform fallback chain, register the
/// first that commits, then warm up. Never panics; all failures return `Err` and
/// CPU is the infallible final fallback.
pub fn init_model(
    manifest_path: &str,
    resource_dir: Option<PathBuf>,
) -> Result<(LoadedModel, ProInferCapabilities), String> {
    let (manifest, model_path) = parse_manifest(Path::new(manifest_path))?;
    let model_bytes =
        fs::read(&model_path).map_err(|error| format!("failed to read model: {error}"))?;

    let mut fallback_chain: Vec<String> = Vec::new();

    #[cfg(windows)]
    match prepare_cuda_runtime(resource_dir.as_deref()) {
        Ok(Some(runtime_dir)) => {
            fallback_chain.push(format!("cuda-runtime: using {}", runtime_dir.display()))
        }
        Ok(None) => fallback_chain.push(
            "cuda-runtime: bundled runtime not found; relying on system DLL path".to_string(),
        ),
        Err(error) => fallback_chain.push(format!("cuda-runtime: prep failed: {error}")),
    }

    let candidates = candidate_chain();

    for candidate in candidates {
        if !candidate.available {
            fallback_chain.push(format!(
                "{}: skipped ({})",
                candidate.name, candidate.probe_note
            ));
            continue;
        }

        let build_result = build_session(&model_bytes, &candidate.dispatch);

        match build_result {
            Ok(session) => {
                let mut loaded = LoadedModel {
                    session,
                    manifest: manifest.clone(),
                    active_ep: candidate.name.to_string(),
                    ep_fallback_chain: Vec::new(),
                };
                match warmup(&mut loaded) {
                    Ok(warmup_ms) => {
                        fallback_chain.push(format!("{}: active", candidate.name));
                        loaded.ep_fallback_chain = fallback_chain.clone();
                        let capabilities = capabilities_of(&loaded, warmup_ms);
                        return Ok((loaded, capabilities));
                    }
                    Err(error) => {
                        fallback_chain.push(format!("{}: warmup failed: {error}", candidate.name));
                    }
                }
            }
            Err(error) => {
                fallback_chain.push(format!(
                    "{}: register/commit failed: {error}",
                    candidate.name
                ));
            }
        }
    }

    Err(format!(
        "no execution provider could be initialized; chain: {}",
        fallback_chain.join(" | ")
    ))
}

/// Build a session for one EP candidate. Kept separate so the differing
/// `BuilderResult` error type does not have to chain through `and_then`.
fn build_session(
    model_bytes: &[u8],
    dispatch: &ort::ep::ExecutionProviderDispatch,
) -> Result<Session, String> {
    let builder = Session::builder().map_err(|error| format!("builder init failed: {error}"))?;
    let builder = builder
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|error| format!("optimization level failed: {error}"))?;
    let mut builder = builder
        .with_execution_providers([dispatch.clone().error_on_failure()])
        .map_err(|error| format!("ep registration failed: {error}"))?;
    builder
        .commit_from_memory(model_bytes)
        .map_err(|error| format!("commit failed: {error}"))
}

/// Run a single all-zero batch to force EP graph compilation before real work.
fn warmup(loaded: &mut LoadedModel) -> Result<f64, String> {
    let res = loaded.manifest.input_resolution as usize;
    let channels = loaded.manifest.channels as usize;
    let len = channels * res * res;
    let data = vec![0f32; len];
    let input = Tensor::from_array(([1usize, channels, res, res], data))
        .map_err(|error| format!("warmup tensor build failed: {error}"))?;
    let input_name = loaded.manifest.input_name.clone();

    let started = Instant::now();
    loaded
        .session
        .run(ort::inputs![input_name.as_str() => input])
        .map_err(|error| format!("warmup run failed: {error}"))?;
    Ok(started.elapsed().as_secs_f64() * 1000.0)
}

fn capabilities_of(loaded: &LoadedModel, warmup_ms: f64) -> ProInferCapabilities {
    ProInferCapabilities {
        active_ep: loaded.active_ep.clone(),
        ep_fallback_chain: loaded.ep_fallback_chain.clone(),
        backbone_version: loaded.manifest.backbone_version.clone(),
        loaded_heads: loaded
            .manifest
            .heads
            .iter()
            .map(|h| h.name.clone())
            .collect(),
        input_resolution: loaded.manifest.input_resolution,
        warmup_ms,
    }
}
