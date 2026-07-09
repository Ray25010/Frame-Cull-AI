//! Execution-provider detection and fallback chain (PRO_MODEL_ARCHITECTURE.md §10.6).
//!
//! The probe order is platform-fixed. Each level is tried in order; a level that
//! reports unavailable or fails to register is recorded with a reason in the
//! fallback chain and the next level is tried. CPU is always last and never
//! fails, so the chain can never end empty.

use ort::ep::ExecutionProviderDispatch;
use ort::ep::{ExecutionProvider, CPU};

#[cfg(target_os = "macos")]
use ort::ep::CoreML;
#[cfg(windows)]
use ort::ep::{DirectML, CUDA};

/// A single execution-provider candidate, ordered by preference.
pub struct EpCandidate {
    /// Canonical lowercase name reported to the frontend (`activeEp`).
    pub name: &'static str,
    pub dispatch: ExecutionProviderDispatch,
    /// Result of the build-time/availability probe; `Ok` does not guarantee the
    /// session will register it, but lets us record why a level was skipped.
    pub available: bool,
    pub probe_note: String,
}

/// Build the platform-specific candidate list in preference order.
///
/// Windows: CUDA -> DirectML -> CPU
/// macOS:   CoreML -> CPU
/// other:   CPU
pub fn candidate_chain() -> Vec<EpCandidate> {
    let mut chain: Vec<EpCandidate> = Vec::new();

    #[cfg(windows)]
    {
        chain.push(make_candidate("cuda", &CUDA::default(), || {
            CUDA::default().build()
        }));
        chain.push(make_candidate("directml", &DirectML::default(), || {
            DirectML::default().build()
        }));
    }

    #[cfg(target_os = "macos")]
    {
        chain.push(make_candidate("coreml", &CoreML::default(), || {
            CoreML::default().build()
        }));
    }

    // CPU is always the final, infallible fallback.
    chain.push(EpCandidate {
        name: "cpu",
        dispatch: CPU::default().build(),
        available: true,
        probe_note: "cpu fallback always available".to_string(),
    });

    chain
}

#[cfg(any(windows, target_os = "macos"))]
fn make_candidate<E: ExecutionProvider>(
    name: &'static str,
    probe: &E,
    build: impl FnOnce() -> ExecutionProviderDispatch,
) -> EpCandidate {
    let (available, probe_note) = match probe.is_available() {
        Ok(true) => (true, format!("{name} reported available")),
        Ok(false) => (false, format!("{name} not available on this build/host")),
        Err(error) => (false, format!("{name} availability probe failed: {error}")),
    };
    EpCandidate {
        name,
        dispatch: build(),
        available,
        probe_note,
    }
}
