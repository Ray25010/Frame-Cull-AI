//! Windows-only CUDA runtime directory discovery + DLL search path setup.
//!
//! The Pro app bundles a locked user-mode CUDA runtime subset as resources.
//! Before the CUDA EP is probed, we attach that directory to the current
//! process DLL search path so ONNX Runtime can load `onnxruntime_providers_cuda`
//! without requiring a global CUDA Toolkit install.

use std::env;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use windows_sys::Win32::System::LibraryLoader::{
    AddDllDirectory, SetDefaultDllDirectories, LOAD_LIBRARY_SEARCH_APPLICATION_DIR,
    LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_SYSTEM32, LOAD_LIBRARY_SEARCH_USER_DIRS,
};

const CUDA_RUNTIME_ENV_VAR: &str = "FRAMECULL_CUDA_RUNTIME_DIR";
const CUDA_RUNTIME_RESOURCE_DIR: &str = "cuda-runtime/windows-x64/runtime";
const CUDA_RUNTIME_DEV_VENDOR_DIR: &str = "vendor/nvidia-cuda/windows-x64/runtime";
const CUDA_RUNTIME_MARKER_DLL: &str = "cublasLt64_12.dll";

static REGISTERED_RUNTIME_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn prepare_cuda_runtime(resource_dir: Option<&Path>) -> Result<Option<PathBuf>, String> {
    let Some(runtime_dir) = locate_cuda_runtime_dir(resource_dir) else {
        return Ok(None);
    };

    if let Some(existing) = REGISTERED_RUNTIME_DIR.get() {
        if paths_equal(existing, &runtime_dir) {
            return Ok(Some(existing.clone()));
        }
    }

    prepend_runtime_dir_to_path(&runtime_dir);
    attach_runtime_dir_to_loader(&runtime_dir)?;
    let _ = REGISTERED_RUNTIME_DIR.set(runtime_dir.clone());
    Ok(Some(runtime_dir))
}

fn locate_cuda_runtime_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(path) = env::var_os(CUDA_RUNTIME_ENV_VAR) {
        if !path.is_empty() {
            candidates.push(PathBuf::from(path));
        }
    }

    if let Some(resource_dir) = resource_dir {
        candidates.push(resource_dir.join(CUDA_RUNTIME_RESOURCE_DIR));
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join(CUDA_RUNTIME_RESOURCE_DIR));
            if let Some(parent) = exe_dir.parent() {
                candidates.push(parent.join("resources").join(CUDA_RUNTIME_RESOURCE_DIR));
            }
        }
    }

    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(CUDA_RUNTIME_DEV_VENDOR_DIR));

    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join(CUDA_RUNTIME_DEV_VENDOR_DIR));
        candidates.push(cwd.join("src-tauri").join(CUDA_RUNTIME_DEV_VENDOR_DIR));
    }

    candidates
        .into_iter()
        .find(|candidate| is_valid_runtime_dir(candidate))
}

fn is_valid_runtime_dir(path: &Path) -> bool {
    path.is_dir() && path.join(CUDA_RUNTIME_MARKER_DLL).is_file()
}

fn prepend_runtime_dir_to_path(runtime_dir: &Path) {
    let Some(dir_text) = runtime_dir.to_str() else {
        return;
    };
    let current = env::var_os("PATH").unwrap_or_default();
    let already_present = env::split_paths(&current).any(|entry| paths_equal(&entry, runtime_dir));
    if already_present {
        return;
    }

    let mut parts = vec![runtime_dir.to_path_buf()];
    parts.extend(env::split_paths(&current));
    if let Ok(joined) = env::join_paths(parts) {
        // SAFETY: updating PATH only affects the current process and child
        // processes. This is a best-effort supplement to AddDllDirectory.
        unsafe {
            env::set_var("PATH", joined);
        }
    } else {
        // Fallback for unexpected invalid PATH segments.
        let combined = if let Some(existing) = current.to_str() {
            format!("{dir_text};{existing}")
        } else {
            dir_text.to_string()
        };
        unsafe {
            env::set_var("PATH", combined);
        }
    }
}

fn attach_runtime_dir_to_loader(runtime_dir: &Path) -> Result<(), String> {
    let mut wide: Vec<u16> = OsStr::new(runtime_dir.as_os_str()).encode_wide().collect();
    wide.push(0);

    let flags = LOAD_LIBRARY_SEARCH_DEFAULT_DIRS
        | LOAD_LIBRARY_SEARCH_USER_DIRS
        | LOAD_LIBRARY_SEARCH_SYSTEM32
        | LOAD_LIBRARY_SEARCH_APPLICATION_DIR;

    unsafe {
        if SetDefaultDllDirectories(flags) == 0 {
            return Err(format!(
                "SetDefaultDllDirectories failed for {:?}: {}",
                runtime_dir,
                std::io::Error::last_os_error()
            ));
        }
        if AddDllDirectory(wide.as_ptr()) == 0 as _ {
            return Err(format!(
                "AddDllDirectory failed for {:?}: {}",
                runtime_dir,
                std::io::Error::last_os_error()
            ));
        }
    }

    Ok(())
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a
            .to_string_lossy()
            .eq_ignore_ascii_case(b.to_string_lossy().as_ref()),
    }
}
