use base64::Engine;
use image::GenericImageView;
use image::ImageFormat;
#[cfg(feature = "pro")]
use rayon::{prelude::*, ThreadPoolBuilder};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(feature = "pro")]
use std::process::{Output, Stdio};
#[cfg(feature = "pro")]
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
#[cfg(feature = "pro")]
use std::sync::{Arc, Mutex};
#[cfg(feature = "pro")]
use std::time::Instant;
use std::time::{Duration, UNIX_EPOCH};
use tauri::async_runtime::spawn_blocking;
use tauri::ipc::Channel;
use tauri::utils::config::Color;
use tauri::Emitter;
use tauri::Manager;

#[cfg(all(feature = "pro", windows))]
use std::os::windows::process::CommandExt;

// Pro-only native ONNX Runtime inference layer (§10). Entire module compiles
// only for the pro build; Flash never pulls in ort/ndarray or this code.
#[cfg(feature = "pro")]
pub mod pro_infer;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifData {
    pub shutter_speed: Option<String>,
    pub aperture: Option<String>,
    pub iso: Option<String>,
    pub focal_length: Option<String>,
    pub date_time: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub orientation: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoFileInfo {
    pub name: String,
    pub extension: String,
    pub path: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhotoGroupInfo {
    pub id: String,
    pub jpg: Option<PhotoFileInfo>,
    pub raw: Option<PhotoFileInfo>,
    pub status: String,
    #[serde(default)]
    pub rating: u8,
    pub exif: Option<ExifData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedExportFile {
    pub file_name: String,
    pub data_url: String,
    #[serde(default)]
    pub rating: Option<u8>,
    #[serde(default)]
    pub metadata_mode: Option<String>,
    #[serde(default)]
    pub metadata_source_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgressPayload {
    pub phase: String,
    pub processed: usize,
    pub total: usize,
    pub current: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawEmbeddedPreview {
    pub cache_path: String,
    pub byte_length: usize,
    pub offset: usize,
    pub orientation: Option<u16>,
    pub from_cache: bool,
    pub source: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedJpegThumbnail {
    pub cache_path: String,
    pub from_cache: bool,
    pub width: u32,
    pub height: u32,
}

#[cfg(feature = "pro")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawEngineValidationResult {
    pub ok: bool,
    pub engine_kind: String,
    pub engine_path: Option<String>,
    pub version: Option<String>,
    pub engine_source: Option<String>,
    pub bundled_engine_version: Option<String>,
    pub message: Option<String>,
}

#[cfg(feature = "pro")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawMonitorCacheEntry {
    pub raw_path: String,
    pub profile_id: Option<String>,
    pub cache_path: Option<String>,
    pub from_cache: bool,
    pub fallback: Option<bool>,
    pub cache_source: Option<String>,
    pub recent_failure: Option<bool>,
    pub missing_reason: Option<String>,
}

#[cfg(feature = "pro")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawMonitorCacheEvent {
    pub kind: String,
    pub processed: Option<usize>,
    pub total: Option<usize>,
    pub current: Option<String>,
    pub raw_path: Option<String>,
    pub profile_id: Option<String>,
    pub cache_path: Option<String>,
    pub fallback: Option<bool>,
    pub cache_source: Option<String>,
    pub skipped_reason: Option<String>,
    pub engine_version: Option<String>,
    pub errors: Option<Vec<String>>,
    pub error: Option<String>,
}

#[cfg(feature = "pro")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMonitorCacheMetadata {
    cache_source: String,
    fallback: bool,
    profile_id: String,
    written_at_ms: u64,
}

#[cfg(feature = "pro")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMonitorFailureRecord {
    failed_at_ms: u64,
    error: String,
}

#[cfg(feature = "pro")]
#[derive(Debug, Clone)]
struct RawMonitorCacheStatus {
    source: String,
    fallback: bool,
}

#[cfg(feature = "pro")]
#[derive(Debug, Clone)]
struct RawMonitorRenderResult {
    cache_path: PathBuf,
    status: RawMonitorCacheStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStreamEvent {
    pub kind: String,
    pub phase: Option<String>,
    pub processed: Option<usize>,
    pub total: Option<usize>,
    pub current: Option<String>,
    pub groups: Option<Vec<PhotoGroupInfo>>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportStreamEvent {
    pub kind: String,
    pub phase: Option<String>,
    pub processed: Option<usize>,
    pub total: Option<usize>,
    pub current: Option<String>,
    pub files: Option<Vec<String>>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightroomImportResult {
    pub files: Vec<String>,
    pub launched: bool,
    pub executable_path: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightroomSourceFolderResult {
    pub source_folder: String,
    pub files: Vec<String>,
    pub launched: bool,
    pub executable_path: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeopleExportClusterInput {
    pub id: String,
    pub display_name: String,
    pub photo_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiIssuePayload {
    pub code: String,
    pub level: String,
    pub confidence: f64,
    pub score: f64,
    pub threshold: f64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiMetricsPayload {
    pub sharpness: Option<f64>,
    pub mean_luma: Option<f64>,
    pub subject_mean_luma: Option<f64>,
    pub subject_reliable: Option<bool>,
    pub dark_clip_ratio: Option<f64>,
    pub highlight_clip_ratio: Option<f64>,
    pub subject_dark_clip_ratio: Option<f64>,
    pub subject_highlight_clip_ratio: Option<f64>,
    pub face_count: Option<u32>,
    pub eye_closed_score: Option<f64>,
    pub tenengrad: Option<f64>,
    pub edge_density: Option<f64>,
    pub focus_texture_score: Option<f64>,
    pub focus_peak_sharpness: Option<f64>,
    pub focus_peak_tenengrad: Option<f64>,
    pub focus_peak_texture_score: Option<f64>,
    pub focus_tile_count: Option<u32>,
    pub focus_reliable: Option<bool>,
    pub focus_reliability_score: Option<f64>,
    pub focus_mode: Option<String>,
    pub eye_closed_face_count: Option<u32>,
    pub eye_review_face_count: Option<u32>,
    pub eye_review_score: Option<f64>,
    pub face_candidate_count: Option<u32>,
    pub landmarked_face_count: Option<u32>,
    pub enhanced_face_detection_passes: Option<u32>,
    pub face_quality_score: Option<f64>,
    pub eye_reliability: Option<f64>,
    pub pose_reliability: Option<f64>,
    pub subject_exposure_score: Option<f64>,
    pub primary_subject_count: Option<u32>,
    pub subject_confidence_score: Option<f64>,
    pub subject_confidence: Option<String>,
    pub group_face_count: Option<u32>,
    pub group_eye_closed_face_count: Option<u32>,
    pub group_eye_review_face_count: Option<u32>,
    pub group_portrait_score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRegionPayload {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub source: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiFaceDiagnosticPayload {
    pub index: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub left_blink: Option<f64>,
    pub right_blink: Option<f64>,
    pub left_ear: Option<f64>,
    pub right_ear: Option<f64>,
    pub eye_closed_score: Option<f64>,
    pub detector_confidence: Option<f64>,
    pub detector_source: Option<String>,
    pub detector_name: Option<String>,
    pub face_size_ratio: Option<f64>,
    pub face_quality_score: Option<f64>,
    pub eye_reliability: Option<f64>,
    pub pose_reliability: Option<f64>,
    pub subject_role: Option<String>,
    pub subject_score: Option<f64>,
    pub subject_rank: Option<u32>,
    pub look_at_camera_score: Option<f64>,
    pub center_score: Option<f64>,
    pub size_score: Option<f64>,
    pub sharpness_score: Option<f64>,
    pub crop_safety_score: Option<f64>,
    pub eligible_as_primary: Option<bool>,
    pub subject_reason: Option<String>,
    pub landmarker_status: Option<String>,
    pub closed: bool,
    pub review_hint: Option<bool>,
    pub skipped_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiDiagnosticsPayload {
    pub focus_mode: Option<String>,
    pub focus_reliable: Option<bool>,
    pub focus_skip_reason: Option<String>,
    pub eye_skip_reason: Option<String>,
    pub model_load_error: Option<String>,
    pub wasm_base: Option<String>,
    pub model_asset_path: Option<String>,
    pub face_detector_status: Option<String>,
    pub face_detector_asset_path: Option<String>,
    pub face_detector_error: Option<String>,
    pub face_detector_name: Option<String>,
    pub landmarker_success_count: Option<u32>,
    pub face_diagnostics: Option<Vec<AiFaceDiagnosticPayload>>,
    pub primary_face_indices: Option<Vec<u32>>,
    pub primary_subject_count: Option<u32>,
    pub subject_confidence: Option<String>,
    pub subject_decision: Option<String>,
    pub photo_kind: Option<String>,
    pub group_face_indices: Option<Vec<u32>>,
    pub group_portrait_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDuplicateSignaturePayload {
    pub version: String,
    pub width: u32,
    pub height: u32,
    pub aspect_ratio: f64,
    pub luma_hash: String,
    pub structure_hash: String,
    pub color_histogram: Vec<f64>,
    pub luma_histogram: Vec<f64>,
    pub mean_luma: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnalysisPayload {
    pub status: String,
    pub issues: Vec<AiIssuePayload>,
    pub confidence: f64,
    pub preset: String,
    pub reviewed: bool,
    pub model_version: String,
    pub analyzed_at: Option<u64>,
    pub error: Option<String>,
    pub face_model_status: Option<String>,
    pub metrics: Option<AiMetricsPayload>,
    pub regions: Option<Vec<AiRegionPayload>>,
    pub diagnostics: Option<AiDiagnosticsPayload>,
    pub duplicate_signature: Option<AiDuplicateSignaturePayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEvaluationRequest {
    pub settings: AiSettingsPayload,
    pub metrics: AiMetricsPayload,
    pub diagnostics: AiDiagnosticsPayload,
    pub regions: Option<Vec<AiRegionPayload>>,
    pub face_model_status: Option<String>,
    pub analyzed_at: Option<u64>,
    pub worker_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsPayload {
    pub enabled_checks: HashMap<String, bool>,
    pub sensitivity: String,
    pub sensitivity_by_check: HashMap<String, String>,
}

const RAW_EXTENSIONS: &[&str] = &[
    "ARW", "CR2", "CR3", "NEF", "NRW", "DNG", "ORF", "RAF", "RW2", "SRW", "SRF", "SR2",
];
const XMP_IDENTIFIER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const EXIF_IDENTIFIER: &[u8] = b"Exif\0\0";
const IMPORT_PROGRESS_EVENT: &str = "framecull://import-progress";
const MIN_EMBEDDED_JPEG_BYTES: usize = 16 * 1024;
const RAW_PREVIEW_CACHE_VERSION: &str = "v2";
const JPEG_THUMBNAIL_CACHE_VERSION: &str = "v1";
#[cfg(feature = "pro")]
const RAW_MONITOR_CACHE_VERSION: &str = "v5";
#[cfg(feature = "pro")]
const RAW_MONITOR_PROFILE_BALANCED: &str = "FrameCull_Monitor_Balanced_v1";
#[cfg(feature = "pro")]
const RAW_MONITOR_PROFILE_AUTO_EXPOSURE: &str = "FrameCull_Monitor_AutoExposure_v1";
#[cfg(feature = "pro")]
const RAW_MONITOR_MAX_EDGE: u32 = 2400;
#[cfg(feature = "pro")]
const RAW_MONITOR_JPEG_QUALITY: u8 = 85;
#[cfg(feature = "pro")]
const RAW_MONITOR_MAX_PARALLELISM: usize = 3;
#[cfg(feature = "pro")]
const RAW_MONITOR_MAX_LUT_BYTES: u64 = 16 * 1024 * 1024;
#[cfg(feature = "pro")]
const RAW_MONITOR_FAILURE_RETRY_COOLDOWN_SECS: u64 = 30 * 60;
#[cfg(feature = "pro")]
const RAWTHERAPEE_BUNDLED_VERSION: &str = "5.12";
#[cfg(feature = "pro")]
const RAWTHERAPEE_BUNDLED_RESOURCE_CLI: &str =
    "raw-engines/rawtherapee/windows-x64/RawTherapee_5.12_win64_release/rawtherapee-cli.exe";
#[cfg(feature = "pro")]
const RAWTHERAPEE_DEV_VENDOR_CLI: &str =
    "vendor/rawtherapee/windows-x64/RawTherapee_5.12_win64_release/rawtherapee-cli.exe";
const IMPORT_BATCH_SIZE: usize = 75;
const AI_MODEL_VERSION: &str = "local-native-rules-v30-focus-eye-time";

#[cfg(feature = "pro")]
static RAW_MONITOR_CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy)]
struct AiThresholds {
    sharpness: f64,
    tenengrad: f64,
    min_edge_density: f64,
    highlight_clip_ratio: f64,
    dark_clip_ratio: f64,
    under_mean_luma: f64,
    over_mean_luma: f64,
    eye_closed_score: f64,
}

const AI_THRESHOLDS_WEAK: AiThresholds = AiThresholds {
    sharpness: 25.0,
    tenengrad: 32.0,
    min_edge_density: 0.012,
    highlight_clip_ratio: 0.12,
    dark_clip_ratio: 0.45,
    under_mean_luma: 60.0,
    over_mean_luma: 205.0,
    eye_closed_score: 0.82,
};

const AI_THRESHOLDS_STANDARD: AiThresholds = AiThresholds {
    sharpness: 35.0,
    tenengrad: 45.0,
    min_edge_density: 0.018,
    highlight_clip_ratio: 0.08,
    dark_clip_ratio: 0.35,
    under_mean_luma: 70.0,
    over_mean_luma: 190.0,
    eye_closed_score: 0.7,
};

const AI_THRESHOLDS_STRONG: AiThresholds = AiThresholds {
    sharpness: 55.0,
    tenengrad: 62.0,
    min_edge_density: 0.014,
    highlight_clip_ratio: 0.05,
    dark_clip_ratio: 0.25,
    under_mean_luma: 85.0,
    over_mean_luma: 175.0,
    eye_closed_score: 0.55,
};

#[derive(Debug, Clone)]
struct GroupPortraitDetection {
    photo_kind: String,
    group_face_indices: Vec<u32>,
    group_face_count: u32,
    group_portrait_score: f64,
    group_portrait_reason: String,
}

fn ai_thresholds_for_issue(settings: &AiSettingsPayload, code: &str) -> AiThresholds {
    let sensitivity = settings
        .sensitivity_by_check
        .get(code)
        .map(String::as_str)
        .unwrap_or(settings.sensitivity.as_str());
    match sensitivity {
        "weak" => AI_THRESHOLDS_WEAK,
        "strong" => AI_THRESHOLDS_STRONG,
        _ => AI_THRESHOLDS_STANDARD,
    }
}

fn ai_check_enabled(settings: &AiSettingsPayload, code: &str) -> bool {
    settings.enabled_checks.get(code).copied().unwrap_or(true)
}

fn classify_native_face_eyes(
    faces: &mut [AiFaceDiagnosticPayload],
    settings: &AiSettingsPayload,
    formal_face_indices: &HashSet<u32>,
) {
    let threshold = ai_thresholds_for_issue(settings, "EYES_CLOSED").eye_closed_score;

    for face in faces {
        let is_formal_face = formal_face_indices.contains(&face.index);
        let score = face.eye_closed_score;
        let reliable_for_review = face.eye_reliability.unwrap_or(0.0) >= 0.28;
        let closed = is_formal_face && score.map(|value| value >= threshold).unwrap_or(false);
        let review_hint = is_formal_face
            && !closed
            && score
                .map(|value| value >= threshold * 0.72 && reliable_for_review)
                .unwrap_or(false);

        face.closed = closed;
        face.review_hint = Some(review_hint);
        face.skipped_reason = if closed {
            None
        } else if review_hint {
            Some("Eye metrics are close to the closed-eye threshold; review manually.".to_string())
        } else if score.is_some() {
            Some("Eye metrics are below the closed-eye threshold.".to_string())
        } else {
            face.skipped_reason.clone()
        };
    }
}

fn detect_group_portrait_native(faces: &[AiFaceDiagnosticPayload]) -> GroupPortraitDetection {
    let standard = |score: f64, reason: &str| GroupPortraitDetection {
        photo_kind: "STANDARD".to_string(),
        group_face_indices: Vec::new(),
        group_face_count: 0,
        group_portrait_score: score,
        group_portrait_reason: reason.to_string(),
    };

    let candidates: Vec<AiFaceDiagnosticPayload> = faces
        .iter()
        .filter(|face| is_group_portrait_candidate_native(face))
        .cloned()
        .collect();

    if candidates.len() < 5 {
        return standard(
            0.0,
            "Fewer than five reliable faces; treated as a standard photo.",
        );
    }

    let heights: Vec<f64> = candidates.iter().map(face_height_ratio_native).collect();
    let largest_face = heights.iter().copied().fold(0.0, f64::max);
    let median_face = median_native(heights);
    if median_face <= 0.0 || largest_face / median_face > 1.85 {
        return standard(
            0.28,
            "One face is much larger than the others; treated as a standard multi-person photo.",
        );
    }

    let mut centers_x: Vec<f64> = candidates.iter().map(face_center_x_native).collect();
    let mut centers_y: Vec<f64> = candidates.iter().map(face_center_y_native).collect();
    centers_x.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    centers_y.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let horizontal_span = percentile_native(&centers_x, 0.9) - percentile_native(&centers_x, 0.1);
    if horizontal_span < 0.22 {
        return standard(
            0.34,
            "Reliable faces are not spread across the frame like a posed group.",
        );
    }

    let rows = cluster_face_rows_native(&candidates);
    let y_spread = percentile_native(&centers_y, 0.9) - percentile_native(&centers_y, 0.1);
    let has_single_group_row = rows
        .iter()
        .any(|row| row.len() >= 5 && row_center_y_spread_native(row) <= 0.16);
    let compact_rows: Vec<&Vec<AiFaceDiagnosticPayload>> = rows
        .iter()
        .filter(|row| row.len() >= 2 && row_center_y_spread_native(row) <= 0.12)
        .collect();
    let has_two_group_rows = candidates.len() >= 5 && compact_rows.len() >= 2 && y_spread <= 0.38;
    if !has_single_group_row && !has_two_group_rows {
        return standard(
            0.4,
            "Faces are not aligned closely enough to classify this as a formal group portrait.",
        );
    }

    let density_score = rows
        .iter()
        .filter(|row| row.len() >= 2)
        .map(|row| row_density_score_native(row))
        .fold(0.0, f64::max);
    if density_score < 0.45 {
        return standard(
            0.46,
            "Faces are too loosely spaced for the conservative group portrait rule.",
        );
    }

    let size_spread =
        coefficient_of_variation_native(candidates.iter().map(face_height_ratio_native).collect());
    if size_spread > 0.42 {
        return standard(
            0.5,
            "Face sizes vary too much for the conservative group portrait rule.",
        );
    }

    let count_score = clamp01((candidates.len() as f64 - 4.0) / 4.0);
    let alignment_score = clamp01(1.0 - y_spread / 0.38);
    let size_score = clamp01(1.0 - size_spread / 0.42);
    let spread_score = clamp01(horizontal_span / 0.46);
    let score = clamp01(
        count_score * 0.24
            + alignment_score * 0.26
            + size_score * 0.22
            + density_score * 0.18
            + spread_score * 0.1,
    );

    if score < 0.68 {
        return standard(
            score,
            "Group portrait evidence is below the conservative threshold.",
        );
    }

    GroupPortraitDetection {
        photo_kind: "GROUP_PORTRAIT".to_string(),
        group_face_indices: candidates.iter().map(|face| face.index).collect(),
        group_face_count: candidates.len() as u32,
        group_portrait_score: score,
        group_portrait_reason: if has_two_group_rows {
            "Detected a compact two-row group portrait; closed eyes are checked across all reliable group faces."
        } else {
            "Detected a compact row of reliable faces; closed eyes are checked across all reliable group faces."
        }
        .to_string(),
    }
}

fn is_group_portrait_candidate_native(face: &AiFaceDiagnosticPayload) -> bool {
    let height_ratio = face_height_ratio_native(face);
    face.landmarker_status.as_deref() == Some("OK")
        && height_ratio >= 0.025
        && face.face_quality_score.unwrap_or(0.0) >= 0.32
        && face.eye_reliability.unwrap_or(0.0) >= 0.16
        && !is_strong_edge_face_native(face)
}

fn is_strong_edge_face_native(face: &AiFaceDiagnosticPayload) -> bool {
    let touches_x = face.x <= 0.012 || face.x + face.width >= 0.988;
    let touches_y = face.y <= 0.012 || face.y + face.height >= 0.988;
    (touches_x || touches_y) && face.pose_reliability.unwrap_or(0.0) < 0.24
}

fn cluster_face_rows_native(
    faces: &[AiFaceDiagnosticPayload],
) -> Vec<Vec<AiFaceDiagnosticPayload>> {
    let mut rows: Vec<Vec<AiFaceDiagnosticPayload>> = Vec::new();
    let mut sorted = faces.to_vec();
    sorted.sort_by(|a, b| {
        face_center_y_native(a)
            .partial_cmp(&face_center_y_native(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    for face in sorted {
        let center = face_center_y_native(&face);
        if let Some(row) = rows.iter_mut().find(|items| {
            let row_centers: Vec<f64> = items.iter().map(face_center_y_native).collect();
            (center - median_native(row_centers)).abs() <= 0.105
        }) {
            row.push(face);
        } else {
            rows.push(vec![face]);
        }
    }

    rows
}

fn row_density_score_native(row: &[AiFaceDiagnosticPayload]) -> f64 {
    let mut sorted = row.to_vec();
    sorted.sort_by(|a, b| {
        face_center_x_native(a)
            .partial_cmp(&face_center_x_native(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    if sorted.len() < 2 {
        return 0.0;
    }

    let gaps: Vec<f64> = sorted
        .windows(2)
        .map(|pair| face_center_x_native(&pair[1]) - face_center_x_native(&pair[0]))
        .collect();
    let median_gap = median_native(gaps);
    let median_width = median_native(sorted.iter().map(|face| face.width).collect());
    let allowed_gap = 0.16_f64.max(median_width * 3.6);
    clamp01(1.0 - median_gap / (allowed_gap * 1.8))
}

fn row_center_y_spread_native(row: &[AiFaceDiagnosticPayload]) -> f64 {
    let mut centers: Vec<f64> = row.iter().map(face_center_y_native).collect();
    centers.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    match (centers.first(), centers.last()) {
        (Some(first), Some(last)) => last - first,
        _ => 0.0,
    }
}

fn face_center_x_native(face: &AiFaceDiagnosticPayload) -> f64 {
    face.x + face.width / 2.0
}

fn face_center_y_native(face: &AiFaceDiagnosticPayload) -> f64 {
    face.y + face.height / 2.0
}

fn face_height_ratio_native(face: &AiFaceDiagnosticPayload) -> f64 {
    face.face_size_ratio.unwrap_or(face.height)
}

fn median_native(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let middle = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    }
}

fn percentile_native(values: &[f64], ratio: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let index = ((values.len() - 1) as f64 * ratio).round() as usize;
    values[index.min(values.len() - 1)]
}

fn coefficient_of_variation_native(values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    if mean <= 0.0 {
        return 0.0;
    }
    let variance = values
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / values.len() as f64;
    variance.sqrt() / mean
}

fn classify_ai_issues_native(
    metrics: &AiMetricsPayload,
    settings: &AiSettingsPayload,
) -> Vec<AiIssuePayload> {
    let sharpness_thresholds = ai_thresholds_for_issue(settings, "OUT_OF_FOCUS");
    let under_thresholds = ai_thresholds_for_issue(settings, "UNDER_EXPOSED");
    let over_thresholds = ai_thresholds_for_issue(settings, "OVER_EXPOSED");
    let eye_thresholds = ai_thresholds_for_issue(settings, "EYES_CLOSED");
    let sharpness = metrics.sharpness.unwrap_or(f64::INFINITY);
    let tenengrad = metrics.tenengrad.unwrap_or(sharpness);
    let edge_density = metrics.edge_density.unwrap_or(1.0);
    let focus_texture_score = metrics
        .focus_texture_score
        .unwrap_or(sharpness.min(tenengrad));
    let focus_peak_sharpness = metrics.focus_peak_sharpness.unwrap_or(sharpness);
    let focus_peak_tenengrad = metrics.focus_peak_tenengrad.unwrap_or(tenengrad);
    let focus_peak_texture_score = metrics
        .focus_peak_texture_score
        .unwrap_or(focus_peak_sharpness.min(focus_peak_tenengrad));
    let mean_luma = metrics.mean_luma.unwrap_or(128.0);
    let subject_mean_luma = metrics.subject_mean_luma.unwrap_or(mean_luma);
    let dark_clip_ratio = metrics.dark_clip_ratio.unwrap_or(0.0);
    let highlight_clip_ratio = metrics.highlight_clip_ratio.unwrap_or(0.0);
    let subject_reliable = metrics.subject_reliable == Some(true);
    let primary_subject_count = metrics.primary_subject_count.unwrap_or(0);
    let subject_unclear = matches!(
        metrics.subject_confidence.as_deref(),
        Some("LOW") | Some("NONE")
    );
    let subject_dark_clip_ratio = metrics.subject_dark_clip_ratio.unwrap_or(dark_clip_ratio);
    let subject_highlight_clip_ratio = metrics
        .subject_highlight_clip_ratio
        .unwrap_or(highlight_clip_ratio);
    let group_face_count = metrics.group_face_count.unwrap_or(0);
    let group_eye_closed_face_count = metrics.group_eye_closed_face_count.unwrap_or(0);
    let group_eye_review_face_count = metrics.group_eye_review_face_count.unwrap_or(0);
    let is_group_portrait = group_face_count >= 5;
    let eye_closed_score = metrics.eye_closed_score;
    let eye_review_score = metrics.eye_review_score;
    let mut issues: Vec<AiIssuePayload> = Vec::new();

    let focus_reliable = metrics.focus_reliable == Some(true);
    let focus_mode = metrics.focus_mode.as_deref().unwrap_or("");
    let has_face_focus_candidate = focus_mode == "FACE_ROI" && primary_subject_count > 0;
    let has_enough_detail_to_judge = focus_mode == "FACE_ROI"
        || (focus_mode == "NO_FACE_TEXTURED"
            && edge_density >= sharpness_thresholds.min_edge_density);
    let low_laplacian = sharpness < sharpness_thresholds.sharpness;
    let low_tenengrad = tenengrad < sharpness_thresholds.tenengrad;
    let low_composite = focus_texture_score < sharpness_thresholds.sharpness;
    let face_has_structured_edges = focus_mode == "FACE_ROI" && edge_density >= 0.18;
    let face_edge_density_is_low = focus_mode != "FACE_ROI" || edge_density < 0.12;
    let local_detail_is_low = focus_peak_sharpness < sharpness_thresholds.sharpness * 1.05
        && focus_peak_tenengrad < sharpness_thresholds.tenengrad * 1.05
        && focus_peak_texture_score < sharpness_thresholds.sharpness
        && !face_has_structured_edges
        && face_edge_density_is_low;
    let focus_evidence_count =
        (low_laplacian as u8) + (low_tenengrad as u8) + (low_composite as u8);
    let severe_focus_evidence = focus_texture_score < sharpness_thresholds.sharpness * 0.62
        && tenengrad < sharpness_thresholds.tenengrad * 0.72
        && focus_peak_texture_score < sharpness_thresholds.sharpness * 0.88
        && !face_has_structured_edges;

    let formal_focus_issue = ai_check_enabled(settings, "OUT_OF_FOCUS")
        && (focus_mode != "FACE_ROI" || (primary_subject_count > 0 && !subject_unclear))
        && focus_reliable
        && has_enough_detail_to_judge
        && ((focus_evidence_count >= 2 && local_detail_is_low) || severe_focus_evidence);

    if formal_focus_issue {
        issues.push(make_ai_issue(
            "OUT_OF_FOCUS",
            "ISSUE",
            focus_confidence_native(
                sharpness,
                tenengrad,
                focus_texture_score,
                sharpness_thresholds.sharpness,
                sharpness_thresholds.tenengrad,
            ),
            sharpness.min(tenengrad).min(focus_texture_score),
            sharpness_thresholds.sharpness,
            if focus_mode == "FACE_ROI" {
                "Face or eye ROI focus metrics are consistently below threshold."
            } else {
                "Textured non-face region has consistently low focus metrics."
            },
        ));
    } else if ai_check_enabled(settings, "OUT_OF_FOCUS")
        && has_face_focus_candidate
        && low_laplacian
        && low_tenengrad
        && low_composite
        && focus_peak_sharpness < sharpness_thresholds.sharpness * 1.65
        && focus_peak_tenengrad < sharpness_thresholds.tenengrad * 1.65
    {
        issues.push(make_ai_issue(
            "OUT_OF_FOCUS",
            "REVIEW_HINT",
            0.78_f64.min(focus_confidence_native(
                sharpness,
                tenengrad,
                focus_texture_score,
                sharpness_thresholds.sharpness,
                sharpness_thresholds.tenengrad,
            )),
            sharpness.min(tenengrad).min(focus_texture_score),
            sharpness_thresholds.sharpness,
            if focus_reliable {
                "Face ROI focus is low but not consistent enough for a hard reject."
            } else {
                "Small, angled, or partly occluded face has low focus metrics; review manually."
            },
        ));
    }

    let subject_over_exposed = subject_reliable
        && subject_highlight_clip_ratio > over_thresholds.highlight_clip_ratio
        && subject_mean_luma > over_thresholds.over_mean_luma;
    let has_detected_faces = metrics.face_count.unwrap_or(0) > 0;
    let full_over_exposed = highlight_clip_ratio > over_thresholds.highlight_clip_ratio
        && mean_luma > over_thresholds.over_mean_luma
        && ((!subject_reliable && !has_detected_faces) || subject_over_exposed);
    let disaster_full_over_exposed = !subject_reliable
        && !has_detected_faces
        && highlight_clip_ratio > over_thresholds.highlight_clip_ratio * 1.45
        && mean_luma > over_thresholds.over_mean_luma * 1.08;

    if ai_check_enabled(settings, "OVER_EXPOSED")
        && (disaster_full_over_exposed || subject_over_exposed)
    {
        let mut confidence_scores = vec![confidence_above_native(
            highlight_clip_ratio,
            over_thresholds.highlight_clip_ratio,
            0.25,
        )];
        if subject_reliable {
            confidence_scores.push(confidence_above_native(
                subject_highlight_clip_ratio,
                over_thresholds.highlight_clip_ratio,
                0.25,
            ));
        }
        issues.push(make_ai_issue(
            "OVER_EXPOSED",
            "ISSUE",
            confidence_scores.into_iter().fold(0.0, f64::max),
            if subject_reliable {
                highlight_clip_ratio.max(subject_highlight_clip_ratio)
            } else {
                highlight_clip_ratio
            },
            over_thresholds.highlight_clip_ratio,
            "Highlight clipping or subject brightness is above the local threshold.",
        ));
    } else if ai_check_enabled(settings, "OVER_EXPOSED")
        && (full_over_exposed
            || (subject_reliable
                && subject_highlight_clip_ratio > over_thresholds.highlight_clip_ratio * 0.72
                && subject_mean_luma > over_thresholds.over_mean_luma * 0.92)
            || (has_detected_faces
                && !subject_reliable
                && highlight_clip_ratio > over_thresholds.highlight_clip_ratio * 0.9
                && mean_luma > over_thresholds.over_mean_luma * 0.96))
    {
        issues.push(make_ai_issue(
            "OVER_EXPOSED",
            "REVIEW_HINT",
            0.76_f64.min(confidence_above_native(
                if subject_reliable {
                    subject_highlight_clip_ratio.max(highlight_clip_ratio * 0.5)
                } else {
                    highlight_clip_ratio
                },
                over_thresholds.highlight_clip_ratio,
                0.28,
            )),
            if subject_reliable {
                subject_highlight_clip_ratio.max(highlight_clip_ratio * 0.5)
            } else {
                highlight_clip_ratio
            },
            over_thresholds.highlight_clip_ratio,
            if subject_reliable {
                "Subject highlights are close to the overexposure threshold; review manually."
            } else {
                "Full-image highlights are high, but no reliable subject ROI was found."
            },
        ));
    }

    let subject_under_exposed = subject_reliable
        && subject_dark_clip_ratio > under_thresholds.dark_clip_ratio
        && subject_mean_luma < under_thresholds.under_mean_luma;
    let full_under_exposed = dark_clip_ratio > under_thresholds.dark_clip_ratio
        && mean_luma < under_thresholds.under_mean_luma
        && ((!subject_reliable && !has_detected_faces) || subject_under_exposed);
    let disaster_full_under_exposed = !subject_reliable
        && !has_detected_faces
        && dark_clip_ratio > under_thresholds.dark_clip_ratio * 1.25
        && mean_luma < under_thresholds.under_mean_luma * 0.88;

    if ai_check_enabled(settings, "UNDER_EXPOSED")
        && (disaster_full_under_exposed || subject_under_exposed)
    {
        let mut confidence_scores = vec![
            confidence_above_native(dark_clip_ratio, under_thresholds.dark_clip_ratio, 0.6),
            confidence_below_native(mean_luma, under_thresholds.under_mean_luma),
        ];
        if subject_reliable {
            confidence_scores.push(confidence_above_native(
                subject_dark_clip_ratio,
                under_thresholds.dark_clip_ratio,
                0.6,
            ));
            confidence_scores.push(confidence_below_native(
                subject_mean_luma,
                under_thresholds.under_mean_luma,
            ));
        }
        issues.push(make_ai_issue(
            "UNDER_EXPOSED",
            "ISSUE",
            confidence_scores.into_iter().fold(0.0, f64::max),
            if subject_reliable {
                dark_clip_ratio.max(subject_dark_clip_ratio)
            } else {
                dark_clip_ratio
            },
            under_thresholds.dark_clip_ratio,
            "Shadow clipping and subject brightness indicate severe underexposure.",
        ));
    } else if ai_check_enabled(settings, "UNDER_EXPOSED")
        && (full_under_exposed
            || (subject_reliable
                && subject_dark_clip_ratio > under_thresholds.dark_clip_ratio * 0.72
                && subject_mean_luma < under_thresholds.under_mean_luma * 1.18)
            || (has_detected_faces
                && !subject_reliable
                && dark_clip_ratio > under_thresholds.dark_clip_ratio * 0.9
                && mean_luma < under_thresholds.under_mean_luma * 1.04))
    {
        issues.push(make_ai_issue(
            "UNDER_EXPOSED",
            "REVIEW_HINT",
            0.76_f64.min(
                confidence_above_native(
                    if subject_reliable {
                        subject_dark_clip_ratio
                    } else {
                        dark_clip_ratio
                    },
                    under_thresholds.dark_clip_ratio,
                    0.72,
                )
                .max(confidence_below_native(
                    if subject_reliable {
                        subject_mean_luma
                    } else {
                        mean_luma
                    },
                    under_thresholds.under_mean_luma,
                )),
            ),
            if subject_reliable {
                subject_dark_clip_ratio.max(dark_clip_ratio * 0.5)
            } else {
                dark_clip_ratio
            },
            under_thresholds.dark_clip_ratio,
            if subject_reliable {
                "Subject shadows are close to the underexposure threshold; review manually."
            } else {
                "Full-image shadows are high, but no reliable subject ROI was found."
            },
        ));
    }

    let standard_closed_eye_issue = ai_check_enabled(settings, "EYES_CLOSED")
        && primary_subject_count > 0
        && !subject_unclear
        && metrics.eye_closed_face_count.unwrap_or(0) > 0
        && eye_closed_score
            .map(|score| score >= eye_thresholds.eye_closed_score)
            .unwrap_or(false);
    let group_closed_eye_issue = ai_check_enabled(settings, "EYES_CLOSED")
        && is_group_portrait
        && group_face_count > 0
        && group_eye_closed_face_count > 0
        && eye_closed_score
            .map(|score| score >= eye_thresholds.eye_closed_score)
            .unwrap_or(false);

    if standard_closed_eye_issue || group_closed_eye_issue {
        let score = eye_closed_score.unwrap_or(0.0);
        issues.push(make_ai_issue(
            "EYES_CLOSED",
            "ISSUE",
            score,
            score,
            eye_thresholds.eye_closed_score,
            if is_group_portrait {
                "At least one member in the group portrait appears to have both eyes closed."
            } else {
                "At least one detected face appears to have both eyes closed."
            },
        ));
    } else {
        let standard_closed_eye_review = ai_check_enabled(settings, "EYES_CLOSED")
            && primary_subject_count > 0
            && metrics.eye_review_face_count.unwrap_or(0) > 0
            && eye_review_score
                .map(|score| score >= eye_thresholds.eye_closed_score * 0.72)
                .unwrap_or(false);
        let group_closed_eye_review = ai_check_enabled(settings, "EYES_CLOSED")
            && is_group_portrait
            && group_face_count > 0
            && group_eye_review_face_count > 0
            && eye_review_score
                .map(|score| score >= eye_thresholds.eye_closed_score * 0.72)
                .unwrap_or(false);

        if standard_closed_eye_review || group_closed_eye_review {
            let score = eye_review_score.unwrap_or(0.0);
            issues.push(make_ai_issue(
                "EYES_CLOSED",
                "REVIEW_HINT",
                0.78_f64.min(score),
                score,
                eye_thresholds.eye_closed_score,
                if is_group_portrait {
                    "Eye metrics suggest a possible blink in the group portrait, but the evidence is not strong enough for a hard closed-eyes label."
                } else {
                    "Eye metrics suggest a possible blink, but the evidence is not strong enough for a hard closed-eyes label."
                },
            ));
        }
    }

    issues
}

fn make_ai_issue(
    code: &str,
    level: &str,
    confidence: f64,
    score: f64,
    threshold: f64,
    message: &str,
) -> AiIssuePayload {
    AiIssuePayload {
        code: code.to_string(),
        level: level.to_string(),
        confidence: clamp01(confidence),
        score,
        threshold,
        message: message.to_string(),
    }
}

fn highest_issue_confidence_native(issues: &[AiIssuePayload]) -> f64 {
    issues
        .iter()
        .map(|issue| issue.confidence)
        .fold(0.0, f64::max)
}

fn confidence_below_native(score: f64, threshold: f64) -> f64 {
    if threshold <= 0.0 {
        return 0.0;
    }
    clamp01(0.55 + (threshold - score) / threshold)
}

fn confidence_above_native(score: f64, threshold: f64, max_spread: f64) -> f64 {
    if max_spread <= 0.0 {
        return 0.0;
    }
    clamp01(0.55 + (score - threshold) / max_spread)
}

fn focus_confidence_native(
    sharpness: f64,
    tenengrad: f64,
    focus_texture_score: f64,
    sharpness_threshold: f64,
    tenengrad_threshold: f64,
) -> f64 {
    let deficits = [
        deficit_ratio_native(sharpness, sharpness_threshold),
        deficit_ratio_native(tenengrad, tenengrad_threshold),
        deficit_ratio_native(focus_texture_score, sharpness_threshold),
    ];
    let average_deficit = deficits.iter().sum::<f64>() / deficits.len() as f64;
    let base = 0.58 + average_deficit * 0.34;
    let all_extremely_low = deficits.iter().all(|value| *value > 0.82);
    if all_extremely_low {
        0.98_f64.min(base + 0.05)
    } else {
        0.92_f64.min(base)
    }
}

fn deficit_ratio_native(score: f64, threshold: f64) -> f64 {
    if threshold <= 0.0 {
        return 0.0;
    }
    clamp01((threshold - score) / threshold)
}

fn clamp01(value: f64) -> f64 {
    value.max(0.0).min(1.0)
}

#[tauri::command]
fn evaluate_ai_analysis(request: AiEvaluationRequest) -> Result<AiAnalysisPayload, String> {
    let mut diagnostics = request.diagnostics.clone();
    let mut face_diagnostics = diagnostics.face_diagnostics.clone().unwrap_or_default();
    let group_portrait = detect_group_portrait_native(&face_diagnostics);

    diagnostics.photo_kind = Some(group_portrait.photo_kind.clone());
    diagnostics.group_face_indices = Some(group_portrait.group_face_indices.clone());
    diagnostics.group_portrait_reason = Some(group_portrait.group_portrait_reason.clone());

    let formal_face_indices: HashSet<u32> = if group_portrait.photo_kind == "GROUP_PORTRAIT" {
        group_portrait.group_face_indices.iter().copied().collect()
    } else {
        diagnostics
            .primary_face_indices
            .clone()
            .unwrap_or_default()
            .into_iter()
            .collect()
    };

    classify_native_face_eyes(
        &mut face_diagnostics,
        &request.settings,
        &formal_face_indices,
    );
    let closed_eye_faces: Vec<&AiFaceDiagnosticPayload> =
        face_diagnostics.iter().filter(|face| face.closed).collect();
    let review_eye_faces: Vec<&AiFaceDiagnosticPayload> = face_diagnostics
        .iter()
        .filter(|face| face.review_hint == Some(true))
        .collect();
    let formal_faces: Vec<&AiFaceDiagnosticPayload> = face_diagnostics
        .iter()
        .filter(|face| formal_face_indices.contains(&face.index))
        .collect();

    let eye_closed_score = if !closed_eye_faces.is_empty() {
        closed_eye_faces
            .iter()
            .filter_map(|face| face.eye_closed_score)
            .fold(0.0, f64::max)
    } else {
        formal_faces
            .iter()
            .filter_map(|face| face.eye_closed_score)
            .fold(0.0, f64::max)
    };
    let eye_review_score = if !review_eye_faces.is_empty() {
        review_eye_faces
            .iter()
            .filter_map(|face| face.eye_closed_score)
            .fold(0.0, f64::max)
    } else {
        formal_faces
            .iter()
            .filter_map(|face| face.eye_closed_score)
            .fold(0.0, f64::max)
    };

    let mut metrics = request.metrics.clone();
    metrics.eye_closed_score = if eye_closed_score > 0.0 {
        Some(eye_closed_score)
    } else {
        None
    };
    metrics.eye_review_score = if eye_review_score > 0.0 {
        Some(eye_review_score)
    } else {
        None
    };
    metrics.eye_closed_face_count = Some(closed_eye_faces.len() as u32);
    metrics.eye_review_face_count = Some(review_eye_faces.len() as u32);
    metrics.group_face_count = if group_portrait.photo_kind == "GROUP_PORTRAIT" {
        Some(group_portrait.group_face_count)
    } else {
        None
    };
    metrics.group_eye_closed_face_count = if group_portrait.photo_kind == "GROUP_PORTRAIT" {
        Some(
            closed_eye_faces
                .iter()
                .filter(|face| formal_face_indices.contains(&face.index))
                .count() as u32,
        )
    } else {
        None
    };
    metrics.group_eye_review_face_count = if group_portrait.photo_kind == "GROUP_PORTRAIT" {
        Some(
            review_eye_faces
                .iter()
                .filter(|face| formal_face_indices.contains(&face.index))
                .count() as u32,
        )
    } else {
        None
    };
    metrics.group_portrait_score = Some(group_portrait.group_portrait_score);

    diagnostics.eye_skip_reason = if formal_faces.is_empty() {
        Some(if group_portrait.photo_kind == "GROUP_PORTRAIT" {
            group_portrait.group_portrait_reason.clone()
        } else {
            diagnostics
                .subject_decision
                .clone()
                .unwrap_or_else(|| "Subject unclear; only review hints are allowed.".to_string())
        })
    } else if closed_eye_faces
        .iter()
        .any(|face| formal_face_indices.contains(&face.index))
    {
        None
    } else if review_eye_faces
        .iter()
        .any(|face| formal_face_indices.contains(&face.index))
    {
        Some("At least one face is close to the closed-eye threshold; review manually.".to_string())
    } else {
        Some("All formal faces are below the closed-eye threshold.".to_string())
    };
    diagnostics.face_diagnostics = Some(face_diagnostics.clone());

    let mut regions = request.regions.unwrap_or_default();
    let group_face_index_set: HashSet<u32> =
        group_portrait.group_face_indices.iter().copied().collect();
    for region in &mut regions {
        if region.source != "detector" {
            continue;
        }
        let parsed_index = region
            .label
            .split_whitespace()
            .nth(1)
            .and_then(|value| value.parse::<u32>().ok())
            .map(|value| value.saturating_sub(1));
        let Some(index) = parsed_index else {
            continue;
        };
        if let Some(face) = face_diagnostics.iter().find(|item| item.index == index) {
            region.label =
                face_region_label_native(face, group_face_index_set.contains(&face.index));
        }
    }

    let issues = classify_ai_issues_native(&metrics, &request.settings);
    Ok(AiAnalysisPayload {
        status: "DONE".to_string(),
        confidence: highest_issue_confidence_native(&issues),
        issues,
        preset: request.settings.sensitivity.clone(),
        reviewed: false,
        model_version: AI_MODEL_VERSION.to_string(),
        analyzed_at: request.analyzed_at.or_else(|| {
            Some(
                std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
            )
        }),
        error: request.worker_error.clone(),
        face_model_status: request.face_model_status.clone(),
        metrics: Some(metrics),
        regions: Some(regions),
        diagnostics: Some(diagnostics),
        duplicate_signature: None,
    })
}

fn face_region_label_native(face: &AiFaceDiagnosticPayload, is_group_face: bool) -> String {
    let role = face.subject_role.as_deref().unwrap_or("BACKGROUND");
    let score = face
        .subject_score
        .map(|value| format!(" {}%", (value * 100.0).round() as i32))
        .unwrap_or_default();
    let eye_state = if face.closed {
        " EYE_CLOSED"
    } else if face.review_hint == Some(true) {
        " EYE_REVIEW"
    } else {
        ""
    };
    let group_state = if is_group_face { " GROUP_FACE" } else { "" };
    format!(
        "{} {}{}{}{}",
        role,
        face.index + 1,
        score,
        eye_state,
        group_state
    )
}

fn file_modified_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
}

fn unique_destination_path(dest_path: &Path, file_name: &str) -> PathBuf {
    let safe_file_name = Path::new(file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .map(sanitize_path_segment)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "export".to_string());
    let original = Path::new(&safe_file_name);
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("export");
    let extension = original.extension().and_then(|value| value.to_str());

    let mut candidate = dest_path.join(&safe_file_name);
    let mut counter = 1;

    while candidate.exists() {
        let next_name = match extension {
            Some(ext) if !ext.is_empty() => format!("{} ({counter}).{}", stem, ext),
            _ => format!("{} ({counter})", stem),
        };
        candidate = dest_path.join(next_name);
        counter += 1;
    }

    candidate
}

fn sanitize_path_segment(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if sanitized.is_empty() {
        "person".to_string()
    } else {
        sanitized
    }
}

fn unique_cluster_destination(dest_path: &Path, name: &str) -> PathBuf {
    let base = sanitize_path_segment(name);
    let mut candidate = dest_path.join(&base);
    let mut counter = 1;
    while candidate.exists() {
        candidate = dest_path.join(format!("{} ({counter})", base));
        counter += 1;
    }
    candidate
}

fn clamp_rating(rating: u8) -> u8 {
    rating.min(5)
}

fn xmp_sidecar_path(path: &Path) -> PathBuf {
    path.with_extension("xmp")
}

fn extension_upper(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_uppercase())
        .unwrap_or_default()
}

fn is_jpeg_path(path: &Path) -> bool {
    matches!(extension_upper(path).as_str(), "JPG" | "JPEG")
}

fn is_raw_path(path: &Path) -> bool {
    RAW_EXTENSIONS.contains(&extension_upper(path).as_str())
}

fn is_supported_photo_path(path: &Path) -> bool {
    is_jpeg_path(path) || is_raw_path(path)
}

fn validate_photo_file_path(path: &Path) -> Result<(), String> {
    if !is_supported_photo_path(path) {
        return Err(format!("Unsupported photo file type: {}", path.display()));
    }
    if !path.is_file() {
        return Err(format!("Photo file not found: {}", path.display()));
    }
    Ok(())
}

fn emit_import_progress(
    app: &tauri::AppHandle,
    phase: &str,
    processed: usize,
    total: usize,
    current: Option<String>,
) {
    let payload = ImportProgressPayload {
        phase: phase.to_string(),
        processed,
        total,
        current,
    };
    let _ = app.emit(IMPORT_PROGRESS_EVENT, payload);
}

fn should_emit_progress(processed: usize, total: usize) -> bool {
    processed == 0 || processed == total || processed % 25 == 0
}

fn collect_files_recursive(path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut stack = vec![path.to_path_buf()];

    while let Some(current) = stack.pop() {
        let entries = fs::read_dir(&current)
            .map_err(|e| format!("Failed to read directory {}: {}", current.display(), e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let entry_path = entry.path();
            if entry_path.is_dir() {
                stack.push(entry_path);
            } else {
                files.push(entry_path);
            }
        }
    }

    files.sort();
    Ok(files)
}

fn read_orientation(path: &Path) -> Option<u16> {
    let file = File::open(path).ok()?;
    let mut bufreader = BufReader::new(file);
    let exif = exif::Reader::new()
        .read_from_container(&mut bufreader)
        .ok()?;
    orientation_from_exif(&exif)
}

fn raw_preview_cache_path(
    app: &tauri::AppHandle,
    path: &Path,
    byte_length: usize,
    orientation: Option<u16>,
) -> Result<PathBuf, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("Failed to stat RAW file: {}", e))?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let orientation = orientation.unwrap_or(1);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    RAW_PREVIEW_CACHE_VERSION.hash(&mut hasher);
    path.to_string_lossy().hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified_ms.hash(&mut hasher);
    byte_length.hash(&mut hasher);
    orientation.hash(&mut hasher);
    let file_name = format!("{:016x}.jpg", hasher.finish());

    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache directory: {}", e))?
        .join("raw-previews");

    Ok(cache_root.join(file_name))
}

fn jpeg_thumbnail_cache_path(
    app: &tauri::AppHandle,
    path: &Path,
    max_edge: u32,
    orientation: Option<u16>,
) -> Result<PathBuf, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("Failed to stat JPEG file: {}", e))?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let orientation = orientation.unwrap_or(1);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    JPEG_THUMBNAIL_CACHE_VERSION.hash(&mut hasher);
    path.to_string_lossy().hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified_ms.hash(&mut hasher);
    max_edge.hash(&mut hasher);
    orientation.hash(&mut hasher);
    let file_name = format!("{:016x}.jpg", hasher.finish());

    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache directory: {}", e))?
        .join("jpg-thumbnails");

    Ok(cache_root.join(file_name))
}

#[cfg(feature = "pro")]
fn normalize_raw_monitor_profile_id(profile_id: &str) -> &'static str {
    if profile_id == RAW_MONITOR_PROFILE_AUTO_EXPOSURE {
        RAW_MONITOR_PROFILE_AUTO_EXPOSURE
    } else {
        RAW_MONITOR_PROFILE_BALANCED
    }
}

#[cfg(feature = "pro")]
fn raw_monitor_cache_file_name(
    path: &Path,
    engine_version: &str,
    profile_id: &str,
) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("Failed to stat RAW file: {}", e))?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let profile_id = normalize_raw_monitor_profile_id(profile_id);
    RAW_MONITOR_CACHE_VERSION.hash(&mut hasher);
    profile_id.hash(&mut hasher);
    RAW_MONITOR_MAX_EDGE.hash(&mut hasher);
    RAW_MONITOR_JPEG_QUALITY.hash(&mut hasher);
    engine_version.hash(&mut hasher);
    path.to_string_lossy().hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified_ms.hash(&mut hasher);
    Ok(format!("{:016x}.jpg", hasher.finish()))
}

#[cfg(feature = "pro")]
fn raw_monitor_cache_path(
    app: &tauri::AppHandle,
    path: &Path,
    engine_version: &str,
    profile_id: &str,
) -> Result<PathBuf, String> {
    let file_name = raw_monitor_cache_file_name(path, engine_version, profile_id)?;
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache directory: {}", e))?
        .join("raw-monitor-previews");
    Ok(cache_root.join(file_name))
}

#[cfg(feature = "pro")]
fn raw_monitor_cache_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache directory: {}", e))?
        .join("raw-monitor-previews"))
}

#[cfg(feature = "pro")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitorLutFile {
    path: String,
    name: String,
    content: String,
}

#[cfg(feature = "pro")]
fn monitor_lut_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {}", e))?
        .join("monitor-luts");
    fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create LUT import directory: {}", e))?;
    Ok(root)
}

#[cfg(feature = "pro")]
fn read_monitor_lut_file(path: &Path) -> Result<(String, String), String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case("cube") {
        return Err("Only .cube LUT files are supported".to_string());
    }

    let metadata =
        fs::metadata(path).map_err(|e| format!("Failed to inspect LUT file: {}", e))?;
    if !metadata.is_file() {
        return Err("Selected LUT path is not a file".to_string());
    }
    if metadata.len() > RAW_MONITOR_MAX_LUT_BYTES {
        return Err(format!(
            "LUT file is too large. Maximum supported size is {} MB.",
            RAW_MONITOR_MAX_LUT_BYTES / 1024 / 1024
        ));
    }

    let content =
        fs::read_to_string(path).map_err(|e| format!("Failed to read LUT file: {}", e))?;
    if content.trim().is_empty() {
        return Err("LUT file is empty".to_string());
    }

    Ok((readable_file_name(path), content))
}

#[cfg(feature = "pro")]
#[tauri::command]
fn import_monitor_lut(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<MonitorLutFile, String> {
    let source_path = PathBuf::from(source_path);
    let (name, content) = read_monitor_lut_file(&source_path)?;
    let root = monitor_lut_root(&app)?;

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    source_path.hash(&mut hasher);
    content.hash(&mut hasher);
    let mut safe_name = sanitize_path_segment(&name);
    if !safe_name.to_ascii_lowercase().ends_with(".cube") {
        safe_name.push_str(".cube");
    }
    let imported_path = root.join(format!("{:016x}-{}", hasher.finish(), safe_name));
    fs::write(&imported_path, content.as_bytes())
        .map_err(|e| format!("Failed to import LUT file: {}", e))?;

    Ok(MonitorLutFile {
        path: imported_path.to_string_lossy().to_string(),
        name,
        content,
    })
}

#[cfg(feature = "pro")]
#[tauri::command]
fn read_monitor_lut(path: String) -> Result<MonitorLutFile, String> {
    let path = PathBuf::from(path);
    let (name, content) = read_monitor_lut_file(&path)?;
    Ok(MonitorLutFile {
        path: path.to_string_lossy().to_string(),
        name,
        content,
    })
}

#[cfg(feature = "pro")]
fn raw_monitor_cache_metadata_path(cache_path: &Path) -> PathBuf {
    cache_path.with_extension("json")
}

#[cfg(feature = "pro")]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(feature = "pro")]
fn read_raw_monitor_cache_metadata(cache_path: &Path) -> Option<RawMonitorCacheMetadata> {
    let metadata_path = raw_monitor_cache_metadata_path(cache_path);
    let bytes = fs::read(metadata_path).ok()?;
    serde_json::from_slice::<RawMonitorCacheMetadata>(&bytes).ok()
}

#[cfg(feature = "pro")]
fn write_raw_monitor_cache_metadata(
    cache_path: &Path,
    profile_id: &str,
    source: &str,
    fallback: bool,
) -> Result<(), String> {
    let metadata = RawMonitorCacheMetadata {
        cache_source: source.to_string(),
        fallback,
        profile_id: normalize_raw_monitor_profile_id(profile_id).to_string(),
        written_at_ms: now_ms(),
    };
    let metadata_path = raw_monitor_cache_metadata_path(cache_path);
    if let Some(parent) = metadata_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create RAW monitor cache metadata directory: {}", e))?;
    }
    let bytes = serde_json::to_vec_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize RAW monitor cache metadata: {}", e))?;
    fs::write(metadata_path, bytes)
        .map_err(|e| format!("Failed to write RAW monitor cache metadata: {}", e))
}

#[cfg(feature = "pro")]
fn raw_monitor_cache_status(cache_path: &Path) -> RawMonitorCacheStatus {
    if let Some(metadata) = read_raw_monitor_cache_metadata(cache_path) {
        return RawMonitorCacheStatus {
            source: metadata.cache_source,
            fallback: metadata.fallback,
        };
    }
    RawMonitorCacheStatus {
        source: "rawtherapee".to_string(),
        fallback: false,
    }
}

#[cfg(feature = "pro")]
fn raw_monitor_failure_table_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(raw_monitor_cache_root(app)?.join("failures.json"))
}

#[cfg(feature = "pro")]
fn read_raw_monitor_failure_table(
    app: &tauri::AppHandle,
) -> HashMap<String, RawMonitorFailureRecord> {
    let Ok(path) = raw_monitor_failure_table_path(app) else {
        return HashMap::new();
    };
    let Ok(bytes) = fs::read(path) else {
        return HashMap::new();
    };
    serde_json::from_slice::<HashMap<String, RawMonitorFailureRecord>>(&bytes)
        .unwrap_or_default()
}

#[cfg(feature = "pro")]
fn write_raw_monitor_failure_table(
    app: &tauri::AppHandle,
    table: &HashMap<String, RawMonitorFailureRecord>,
) -> Result<(), String> {
    let path = raw_monitor_failure_table_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create RAW monitor failure table directory: {}", e))?;
    }
    let bytes = serde_json::to_vec_pretty(table)
        .map_err(|e| format!("Failed to serialize RAW monitor failure table: {}", e))?;
    fs::write(path, bytes)
        .map_err(|e| format!("Failed to write RAW monitor failure table: {}", e))
}

#[cfg(feature = "pro")]
fn raw_monitor_failure_key(cache_path: &Path) -> String {
    cache_path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .unwrap_or_else(|| cache_path.display().to_string())
}

#[cfg(feature = "pro")]
fn raw_monitor_recent_failure<'a>(
    table: &'a HashMap<String, RawMonitorFailureRecord>,
    key: &str,
    now: u64,
) -> Option<&'a RawMonitorFailureRecord> {
    let record = table.get(key)?;
    let cooldown_ms = RAW_MONITOR_FAILURE_RETRY_COOLDOWN_SECS * 1000;
    if now.saturating_sub(record.failed_at_ms) < cooldown_ms {
        Some(record)
    } else {
        None
    }
}

#[cfg(feature = "pro")]
fn is_nikon_raw_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("nef") | Some("nrw")
    )
}

#[cfg(feature = "pro")]
fn raw_monitor_pp3_path(app: &tauri::AppHandle, profile_id: &str) -> Result<PathBuf, String> {
    let profile_id = normalize_raw_monitor_profile_id(profile_id);
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache directory: {}", e))?
        .join("raw-monitor-previews");
    Ok(cache_root.join(format!("{}.pp3", profile_id)))
}

#[cfg(feature = "pro")]
fn ensure_raw_monitor_pp3(app: &tauri::AppHandle, profile_id: &str) -> Result<PathBuf, String> {
    let path = raw_monitor_pp3_path(app, profile_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create RAW monitor cache directory: {}", e))?;
    }
    fs::write(&path, raw_monitor_pp3_content(profile_id))
        .map_err(|e| format!("Failed to write RAW monitor pp3: {}", e))?;
    Ok(path)
}

#[cfg(feature = "pro")]
fn raw_monitor_pp3_content(profile_id: &str) -> String {
    if normalize_raw_monitor_profile_id(profile_id) == RAW_MONITOR_PROFILE_AUTO_EXPOSURE {
        return raw_monitor_auto_exposure_pp3_content();
    }
    raw_monitor_balanced_pp3_content()
}

#[cfg(feature = "pro")]
fn raw_monitor_balanced_pp3_content() -> String {
    format!(
        r#"[Version]
AppVersion=5.12
Version=349

[General]
Rank=0
ColorLabel=0

[Exposure]
Auto=false
Clip=0.0005
Compensation=0
Brightness=0
Contrast=0
Saturation=0
Black=0
HighlightCompr=25
HighlightComprThreshold=0
ShadowCompr=0

[HLRecovery]
Enabled=true
Method=Coloropp

[ToneCurve]
CurveMode=Standard
CurveMode2=Standard

[White Balance]
Setting=Camera

[Color Management]
InputProfile=(camera)
ToneCurve=true
ApplyLookTable=true
ApplyBaselineExposureOffset=true
ApplyHueSatMap=true
DCPIlluminant=0
WorkingProfile=ProPhoto
OutputProfile=RTv4_sRGB
OutputProfileIntent=Relative Colorimetric
OutputBPC=true

[Resize]
Enabled=true
AppliesTo=Cropped area
Method=Lanczos
DataSpecified=3
Width={max_edge}
Height={max_edge}
Scale=1
AllowUpscaling=false
"#,
        max_edge = RAW_MONITOR_MAX_EDGE
    )
}

#[cfg(feature = "pro")]
fn raw_monitor_auto_exposure_pp3_content() -> String {
    format!(
        r#"[Version]
AppVersion=5.12
Version=349

[General]
Rank=0
ColorLabel=0

[Exposure]
Auto=true
Clip=0.0005
Compensation=0
Brightness=8
Contrast=0
Saturation=0
Black=0
HighlightCompr=90
HighlightComprThreshold=0
ShadowCompr=55

[HLRecovery]
Enabled=true
Method=Coloropp

[ToneCurve]
CurveMode=Standard
CurveMode2=Standard

[White Balance]
Setting=Camera

[Color Management]
InputProfile=(camera)
ToneCurve=true
ApplyLookTable=true
ApplyBaselineExposureOffset=true
ApplyHueSatMap=true
DCPIlluminant=0
WorkingProfile=ProPhoto
OutputProfile=RTv4_sRGB
OutputProfileIntent=Relative Colorimetric
OutputBPC=true

[Resize]
Enabled=true
AppliesTo=Cropped area
Method=Lanczos
DataSpecified=3
Width={max_edge}
Height={max_edge}
Scale=1
AllowUpscaling=false
"#,
        max_edge = RAW_MONITOR_MAX_EDGE
    )
}

fn normalize_orientation(
    image: image::DynamicImage,
    orientation: Option<u16>,
) -> image::DynamicImage {
    match orientation.unwrap_or(1) {
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        5 => image.fliph().rotate90(),
        6 => image.rotate90(),
        7 => image.fliph().rotate270(),
        8 => image.rotate270(),
        _ => image,
    }
}

fn resize_to_max_edge(image: image::DynamicImage, max_edge: u32) -> image::DynamicImage {
    let max_edge = max_edge.max(64);
    let (width, height) = image.dimensions();
    let long_edge = width.max(height);
    if long_edge <= max_edge {
        return image;
    }

    let scale = max_edge as f32 / long_edge as f32;
    let next_width = ((width as f32 * scale).round() as u32).max(1);
    let next_height = ((height as f32 * scale).round() as u32).max(1);
    image.resize(
        next_width,
        next_height,
        image::imageops::FilterType::Triangle,
    )
}

fn normalize_preview_jpeg(bytes: &[u8], orientation: Option<u16>) -> Result<Vec<u8>, String> {
    let orientation = orientation.unwrap_or(1);
    if orientation == 1 {
        return Ok(bytes.to_vec());
    }

    let image = image::load_from_memory_with_format(bytes, ImageFormat::Jpeg)
        .map_err(|e| format!("Failed to decode embedded JPEG preview: {}", e))?;
    let normalized = normalize_orientation(image, Some(orientation));

    let mut output = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 92);
    encoder
        .encode_image(&normalized)
        .map_err(|e| format!("Failed to normalize embedded JPEG preview: {}", e))?;
    Ok(output)
}

fn is_displayable_jpeg(bytes: &[u8]) -> bool {
    image::load_from_memory_with_format(bytes, ImageFormat::Jpeg).is_ok()
}

fn orientation_from_exif(exif: &exif::Exif) -> Option<u16> {
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|field| match &field.value {
            exif::Value::Short(values) => values.first().copied(),
            _ => field
                .display_value()
                .with_unit(exif)
                .to_string()
                .split_whitespace()
                .next()
                .and_then(|value| value.parse::<u16>().ok()),
        })
        .filter(|value| (1..=8).contains(value))
}

#[derive(Clone, Copy)]
struct TiffEntry {
    tag: u16,
    value_type: u16,
    count: u32,
    value_or_offset: u32,
}

#[derive(Clone, Copy)]
struct TiffReader {
    little_endian: bool,
}

impl TiffReader {
    fn new(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 8 {
            return None;
        }
        let little_endian = match &bytes[0..2] {
            b"II" => true,
            b"MM" => false,
            _ => return None,
        };
        let reader = Self { little_endian };
        (reader.u16(bytes, 2)? == 42).then_some(reader)
    }

    fn u16(self, bytes: &[u8], offset: usize) -> Option<u16> {
        let chunk = bytes.get(offset..offset + 2)?;
        Some(if self.little_endian {
            u16::from_le_bytes([chunk[0], chunk[1]])
        } else {
            u16::from_be_bytes([chunk[0], chunk[1]])
        })
    }

    fn u32(self, bytes: &[u8], offset: usize) -> Option<u32> {
        let chunk = bytes.get(offset..offset + 4)?;
        Some(if self.little_endian {
            u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        } else {
            u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        })
    }

    fn first_ifd_offset(self, bytes: &[u8]) -> Option<u32> {
        self.u32(bytes, 4)
    }
}

fn tiff_type_size(value_type: u16) -> Option<usize> {
    match value_type {
        1 | 2 | 6 | 7 => Some(1),
        3 | 8 => Some(2),
        4 | 9 | 11 => Some(4),
        5 | 10 | 12 => Some(8),
        _ => None,
    }
}

fn read_tiff_entry(reader: TiffReader, bytes: &[u8], offset: usize) -> Option<TiffEntry> {
    Some(TiffEntry {
        tag: reader.u16(bytes, offset)?,
        value_type: reader.u16(bytes, offset + 2)?,
        count: reader.u32(bytes, offset + 4)?,
        value_or_offset: reader.u32(bytes, offset + 8)?,
    })
}

fn tiff_entry_u32_values(reader: TiffReader, bytes: &[u8], entry: TiffEntry) -> Vec<u32> {
    let Some(type_size) = tiff_type_size(entry.value_type) else {
        return Vec::new();
    };
    let Ok(count) = usize::try_from(entry.count) else {
        return Vec::new();
    };
    let total_size = type_size.saturating_mul(count);
    if count == 0 || total_size == 0 {
        return Vec::new();
    }

    let inline = total_size <= 4;
    let base = if inline {
        None
    } else {
        usize::try_from(entry.value_or_offset).ok()
    };

    let read_offset = |index: usize| -> Option<usize> {
        if inline {
            Some(8 + index * type_size)
        } else {
            base.map(|offset| offset + index * type_size)
        }
    };

    let mut values = Vec::with_capacity(count);
    for index in 0..count {
        let Some(offset) = read_offset(index) else {
            break;
        };
        let value = match entry.value_type {
            1 | 6 | 7 => {
                if inline {
                    entry
                        .value_or_offset
                        .to_ne_bytes()
                        .get(index)
                        .copied()
                        .map(u32::from)
                } else {
                    bytes.get(offset).copied().map(u32::from)
                }
            }
            3 | 8 => {
                if inline {
                    let raw = if reader.little_endian {
                        (entry.value_or_offset >> (index * 16)) as u16
                    } else {
                        (entry.value_or_offset >> ((1usize.saturating_sub(index)) * 16)) as u16
                    };
                    Some(u32::from(raw))
                } else {
                    reader.u16(bytes, offset).map(u32::from)
                }
            }
            4 | 9 => {
                if inline {
                    Some(entry.value_or_offset)
                } else {
                    reader.u32(bytes, offset)
                }
            }
            _ => None,
        };

        if let Some(value) = value {
            values.push(value);
        }
    }

    values
}

fn valid_jpeg_range(bytes: &[u8], offset: u32, length: u32) -> Option<(usize, usize)> {
    let offset = usize::try_from(offset).ok()?;
    let length = usize::try_from(length).ok()?;
    if length < MIN_EMBEDDED_JPEG_BYTES {
        return None;
    }
    let end = offset.checked_add(length)?;
    let slice = bytes.get(offset..end)?;
    let starts_like_jpeg =
        slice.len() >= 4 && slice[0] == 0xFF && slice[1] == 0xD8 && slice[2] == 0xFF;
    let ends_like_jpeg =
        slice.len() >= 2 && slice[slice.len() - 2] == 0xFF && slice[slice.len() - 1] == 0xD9;
    if starts_like_jpeg && ends_like_jpeg && is_displayable_jpeg(slice) {
        Some((offset, length))
    } else {
        None
    }
}

fn collect_tiff_preview_candidates(
    bytes: &[u8],
    reader: TiffReader,
    ifd_offset: u32,
    depth: usize,
    candidates: &mut Vec<(usize, usize)>,
) {
    if depth > 12 {
        return;
    }
    let Ok(ifd_offset) = usize::try_from(ifd_offset) else {
        return;
    };
    let Some(entry_count) = reader.u16(bytes, ifd_offset).map(usize::from) else {
        return;
    };
    let entries_start = ifd_offset + 2;
    let next_ifd_offset = entries_start + entry_count.saturating_mul(12);
    if next_ifd_offset + 4 > bytes.len() {
        return;
    }

    let mut jpeg_offset_entries = Vec::new();
    let mut jpeg_length_entries = Vec::new();
    let mut strip_offset_entries = Vec::new();
    let mut strip_byte_count_entries = Vec::new();
    let mut nested_ifd_offsets = Vec::new();

    for index in 0..entry_count {
        let entry_offset = entries_start + index * 12;
        let Some(entry) = read_tiff_entry(reader, bytes, entry_offset) else {
            continue;
        };
        match entry.tag {
            0x0201 => jpeg_offset_entries.push(entry),
            0x0202 => jpeg_length_entries.push(entry),
            0x0111 => strip_offset_entries.push(entry),
            0x0117 => strip_byte_count_entries.push(entry),
            0x8769 | 0x8825 | 0x014A => {
                nested_ifd_offsets.extend(tiff_entry_u32_values(reader, bytes, entry))
            }
            _ => {}
        }
    }

    let jpeg_offsets = jpeg_offset_entries
        .iter()
        .flat_map(|entry| tiff_entry_u32_values(reader, bytes, *entry))
        .collect::<Vec<_>>();
    let jpeg_lengths = jpeg_length_entries
        .iter()
        .flat_map(|entry| tiff_entry_u32_values(reader, bytes, *entry))
        .collect::<Vec<_>>();
    for (offset, length) in jpeg_offsets.iter().zip(jpeg_lengths.iter()) {
        if let Some(candidate) = valid_jpeg_range(bytes, *offset, *length) {
            candidates.push(candidate);
        }
    }

    let strip_offsets = strip_offset_entries
        .iter()
        .flat_map(|entry| tiff_entry_u32_values(reader, bytes, *entry))
        .collect::<Vec<_>>();
    let strip_lengths = strip_byte_count_entries
        .iter()
        .flat_map(|entry| tiff_entry_u32_values(reader, bytes, *entry))
        .collect::<Vec<_>>();
    for (offset, length) in strip_offsets.iter().zip(strip_lengths.iter()) {
        if let Some(candidate) = valid_jpeg_range(bytes, *offset, *length) {
            candidates.push(candidate);
        }
    }

    for nested_offset in nested_ifd_offsets {
        collect_tiff_preview_candidates(bytes, reader, nested_offset, depth + 1, candidates);
    }

    if let Some(next_offset) = reader
        .u32(bytes, next_ifd_offset)
        .filter(|offset| *offset > 0)
    {
        collect_tiff_preview_candidates(bytes, reader, next_offset, depth + 1, candidates);
    }
}

fn find_tiff_embedded_preview(bytes: &[u8]) -> Option<(usize, usize)> {
    let reader = TiffReader::new(bytes)?;
    let first_ifd_offset = reader.first_ifd_offset(bytes)?;
    let mut candidates = Vec::new();
    collect_tiff_preview_candidates(bytes, reader, first_ifd_offset, 0, &mut candidates);
    candidates.into_iter().max_by_key(|(_, length)| *length)
}

fn find_largest_embedded_jpeg(bytes: &[u8]) -> Option<(usize, usize)> {
    if let Some(candidate) = find_tiff_embedded_preview(bytes) {
        return Some(candidate);
    }

    let mut best: Option<(usize, usize)> = None;
    let mut pos = 0usize;

    while pos + 4 < bytes.len() {
        let Some(relative_start) = bytes[pos..]
            .windows(3)
            .position(|window| window[0] == 0xFF && window[1] == 0xD8 && window[2] == 0xFF)
        else {
            break;
        };

        let start = pos + relative_start;
        let mut cursor = start + 3;
        let mut end = None;

        while cursor + 1 < bytes.len() {
            if bytes[cursor] == 0xFF && bytes[cursor + 1] == 0xD9 {
                end = Some(cursor + 2);
                break;
            }
            cursor += 1;
        }

        if let Some(end_offset) = end {
            let length = end_offset.saturating_sub(start);
            if length >= MIN_EMBEDDED_JPEG_BYTES {
                let slice = &bytes[start..end_offset];
                if is_displayable_jpeg(slice) {
                    match best {
                        Some((_, best_length)) if best_length >= length => {}
                        _ => best = Some((start, length)),
                    }
                }
            }
            pos = end_offset;
        } else {
            break;
        }
    }

    best
}

fn photo_file_from_path(file_path: &Path) -> Option<(String, PhotoFileInfo)> {
    if !file_path.is_file() {
        return None;
    }

    let file_name = file_path.file_name()?.to_str()?.to_string();
    let extension = file_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_uppercase())
        .unwrap_or_default();

    if extension != "JPG" && extension != "JPEG" && !RAW_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }

    let base_name = file_path.file_stem()?.to_str()?.to_string();
    let file_size = fs::metadata(file_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let modified_ms = file_modified_ms(file_path);

    Some((
        base_name,
        PhotoFileInfo {
            name: file_name,
            extension,
            path: file_path.to_string_lossy().to_string(),
            size: file_size,
            modified_ms,
        },
    ))
}

fn collect_photo_groups_from_paths<F>(
    paths: Vec<PathBuf>,
    mut on_progress: F,
) -> Vec<PhotoGroupInfo>
where
    F: FnMut(usize, usize, Option<String>),
{
    let total = paths.len();
    on_progress(0, total, None);

    let mut groups: HashMap<String, PhotoGroupInfo> = HashMap::new();

    for (index, file_path) in paths.into_iter().enumerate() {
        let processed = index + 1;
        if should_emit_progress(processed, total) {
            on_progress(
                processed,
                total,
                file_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(|value| value.to_string()),
            );
        }

        let Some((base_name, photo_file)) = photo_file_from_path(&file_path) else {
            continue;
        };

        let group = groups
            .entry(base_name.clone())
            .or_insert_with(|| PhotoGroupInfo {
                id: base_name,
                jpg: None,
                raw: None,
                status: String::from("UNMARKED"),
                rating: 0,
                exif: None,
            });

        if photo_file.extension == "JPG" || photo_file.extension == "JPEG" {
            group.jpg = Some(photo_file);
        } else if RAW_EXTENSIONS.contains(&photo_file.extension.as_str()) {
            group.raw = Some(photo_file);
        }
    }

    on_progress(total, total, None);
    finalize_photo_groups(groups)
}

fn send_import_stream_event(channel: &Channel<ImportStreamEvent>, event: ImportStreamEvent) {
    let _ = channel.send(event);
}

fn import_event(
    kind: &str,
    phase: Option<&str>,
    processed: Option<usize>,
    total: Option<usize>,
    current: Option<String>,
    groups: Option<Vec<PhotoGroupInfo>>,
    error: Option<String>,
) -> ImportStreamEvent {
    ImportStreamEvent {
        kind: kind.to_string(),
        phase: phase.map(|value| value.to_string()),
        processed,
        total,
        current,
        groups,
        error,
    }
}

fn export_event(
    kind: &str,
    phase: Option<&str>,
    processed: Option<usize>,
    total: Option<usize>,
    current: Option<String>,
    files: Option<Vec<String>>,
    error: Option<String>,
) -> ExportStreamEvent {
    ExportStreamEvent {
        kind: kind.to_string(),
        phase: phase.map(|value| value.to_string()),
        processed,
        total,
        current,
        files,
        error,
    }
}

fn send_export_stream_event(channel: &Channel<ExportStreamEvent>, event: ExportStreamEvent) {
    let _ = channel.send(event);
}

fn send_import_groups_in_chunks(
    channel: &Channel<ImportStreamEvent>,
    kind: &str,
    phase: &str,
    groups: &[PhotoGroupInfo],
) {
    for chunk in groups.chunks(IMPORT_BATCH_SIZE) {
        send_import_stream_event(
            channel,
            import_event(
                kind,
                Some(phase),
                None,
                Some(groups.len()),
                None,
                Some(chunk.to_vec()),
                None,
            ),
        );
    }
}

fn finalize_photo_groups(groups: HashMap<String, PhotoGroupInfo>) -> Vec<PhotoGroupInfo> {
    let mut result: Vec<PhotoGroupInfo> = Vec::new();

    for (_, mut group) in groups {
        group.status = match (&group.jpg, &group.raw) {
            (Some(_), Some(_)) => "COMPLETE".to_string(),
            (Some(_), None) => "JPG_ONLY".to_string(),
            (None, Some(_)) => "RAW_ONLY".to_string(),
            _ => continue,
        };
        result.push(group);
    }

    result.sort_by(|a, b| a.id.cmp(&b.id));
    result
}

fn enrich_group_metadata(group: &mut PhotoGroupInfo) {
    if let Some(jpg) = &group.jpg {
        group.exif = read_exif(jpg.path.clone()).ok();
    } else if let Some(raw) = &group.raw {
        group.exif = read_exif(raw.path.clone()).ok();
    }
    group.rating = read_group_rating(group);
}

fn parse_xmp_rating(text: &str) -> Option<u8> {
    for marker in ["xmp:Rating=\"", "Rating=\"", "xmp:Rating='", "Rating='"] {
        if let Some(start) = text.find(marker) {
            let value_start = start + marker.len();
            let quote = if marker.ends_with('\'') { '\'' } else { '"' };
            if let Some(end) = text[value_start..].find(quote) {
                return text[value_start..value_start + end]
                    .trim()
                    .parse::<u8>()
                    .ok()
                    .map(clamp_rating);
            }
        }
    }

    if let Some(start) = text.find("<xmp:Rating>") {
        let value_start = start + "<xmp:Rating>".len();
        if let Some(end) = text[value_start..].find("</xmp:Rating>") {
            return text[value_start..value_start + end]
                .trim()
                .parse::<u8>()
                .ok()
                .map(clamp_rating);
        }
    }

    None
}

fn build_minimal_xmp(rating: u8) -> String {
    format!(
        r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="FrameCull AI">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="{}"/>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#,
        clamp_rating(rating)
    )
}

fn replace_quoted_rating(text: &str, marker: &str, rating: u8) -> Option<String> {
    let start = text.find(marker)?;
    let value_start = start + marker.len();
    let quote = if marker.ends_with('\'') { '\'' } else { '"' };
    let end = text[value_start..].find(quote)? + value_start;

    let mut updated = String::with_capacity(text.len() + 2);
    updated.push_str(&text[..value_start]);
    updated.push_str(&clamp_rating(rating).to_string());
    updated.push_str(&text[end..]);
    Some(updated)
}

fn upsert_xmp_rating(text: &str, rating: u8) -> String {
    for marker in ["xmp:Rating=\"", "Rating=\"", "xmp:Rating='", "Rating='"] {
        if let Some(updated) = replace_quoted_rating(text, marker, rating) {
            return updated;
        }
    }

    if let Some(start) = text.find("<xmp:Rating>") {
        let value_start = start + "<xmp:Rating>".len();
        if let Some(end_rel) = text[value_start..].find("</xmp:Rating>") {
            let end = value_start + end_rel;
            let mut updated = String::with_capacity(text.len() + 2);
            updated.push_str(&text[..value_start]);
            updated.push_str(&clamp_rating(rating).to_string());
            updated.push_str(&text[end..]);
            return updated;
        }
    }

    if let Some(desc_start) = text.find("<rdf:Description") {
        if let Some(tag_end_rel) = text[desc_start..].find('>') {
            let tag_end = desc_start + tag_end_rel;
            let insert_at = if tag_end > 0 && text.as_bytes()[tag_end - 1] == b'/' {
                tag_end - 1
            } else {
                tag_end
            };
            let namespace = if text.contains("xmlns:xmp=") {
                String::new()
            } else {
                " xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"".to_string()
            };
            let attr = format!("{} xmp:Rating=\"{}\"", namespace, clamp_rating(rating));
            let mut updated = String::with_capacity(text.len() + attr.len());
            updated.push_str(&text[..insert_at]);
            updated.push_str(&attr);
            updated.push_str(&text[insert_at..]);
            return updated;
        }
    }

    build_minimal_xmp(rating)
}

fn read_xmp_sidecar_rating(path: &Path) -> Option<u8> {
    let sidecar = xmp_sidecar_path(path);
    let text = fs::read_to_string(sidecar).ok()?;
    parse_xmp_rating(&text)
}

fn write_xmp_sidecar_rating(path: &Path, rating: u8) -> Result<PathBuf, String> {
    let sidecar = xmp_sidecar_path(path);
    let next = match fs::read_to_string(&sidecar) {
        Ok(existing) => upsert_xmp_rating(&existing, rating),
        Err(_) => build_minimal_xmp(rating),
    };

    let mut file = File::create(&sidecar)
        .map_err(|e| format!("Failed to create {}: {}", sidecar.display(), e))?;
    file.write_all(next.as_bytes())
        .map_err(|e| format!("Failed to write {}: {}", sidecar.display(), e))?;
    Ok(sidecar)
}

fn read_jpeg_xmp_rating(path: &Path) -> Option<u8> {
    let mut file = File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;

    find_jpeg_xmp_packet(&bytes)
        .and_then(|packet| std::str::from_utf8(packet).ok())
        .and_then(parse_xmp_rating)
}

fn find_jpeg_xmp_packet(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }

    let mut pos = 2;
    while pos + 4 <= bytes.len() {
        if bytes[pos] != 0xFF {
            return None;
        }

        let marker = bytes[pos + 1];
        if marker == 0xDA || marker == 0xD9 {
            return None;
        }

        let len = u16::from_be_bytes([bytes[pos + 2], bytes[pos + 3]]) as usize;
        if len < 2 || pos + 2 + len > bytes.len() {
            return None;
        }

        let payload_start = pos + 4;
        let payload_end = pos + 2 + len;
        if marker == 0xE1 && bytes[payload_start..payload_end].starts_with(XMP_IDENTIFIER) {
            return Some(&bytes[payload_start + XMP_IDENTIFIER.len()..payload_end]);
        }

        pos = payload_end;
    }

    None
}

fn build_jpeg_xmp_segment(rating: u8) -> Result<Vec<u8>, String> {
    let packet = build_minimal_xmp(rating);
    let mut payload = Vec::with_capacity(XMP_IDENTIFIER.len() + packet.len());
    payload.extend_from_slice(XMP_IDENTIFIER);
    payload.extend_from_slice(packet.as_bytes());

    let len = payload.len() + 2;
    if len > u16::MAX as usize {
        return Err("XMP packet is too large for a JPEG APP1 segment".to_string());
    }

    let mut segment = Vec::with_capacity(len + 2);
    segment.push(0xFF);
    segment.push(0xE1);
    segment.extend_from_slice(&(len as u16).to_be_bytes());
    segment.extend_from_slice(&payload);
    Ok(segment)
}

fn collect_jpeg_app_metadata_segments(path: &Path) -> Result<Vec<Vec<u8>>, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    if bytes.len() < 2 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err(format!("{} is not a valid JPEG file", path.display()));
    }

    let mut segments = Vec::new();
    let mut pos = 2usize;
    while pos + 4 <= bytes.len() {
        if bytes[pos] != 0xFF {
            break;
        }

        let marker = bytes[pos + 1];
        if marker == 0xDA || marker == 0xD9 {
            break;
        }

        let len = u16::from_be_bytes([bytes[pos + 2], bytes[pos + 3]]) as usize;
        if len < 2 || pos + 2 + len > bytes.len() {
            break;
        }

        let payload_start = pos + 4;
        let payload_end = pos + 2 + len;
        let payload = &bytes[payload_start..payload_end];
        let is_exif_segment = marker == 0xE1 && payload.starts_with(EXIF_IDENTIFIER);
        if is_exif_segment {
            segments.push(bytes[pos..payload_end].to_vec());
        }
        pos = payload_end;
    }

    Ok(segments)
}

fn jpeg_without_app_metadata_segments(path: &Path) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    if bytes.len() < 2 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err(format!("{} is not a valid JPEG file", path.display()));
    }

    let mut output = Vec::with_capacity(bytes.len());
    output.extend_from_slice(&bytes[..2]);

    let mut pos = 2usize;
    while pos + 4 <= bytes.len() {
        if bytes[pos] != 0xFF {
            output.extend_from_slice(&bytes[pos..]);
            return Ok(output);
        }

        let marker = bytes[pos + 1];
        if marker == 0xDA || marker == 0xD9 {
            output.extend_from_slice(&bytes[pos..]);
            return Ok(output);
        }

        let len = u16::from_be_bytes([bytes[pos + 2], bytes[pos + 3]]) as usize;
        if len < 2 || pos + 2 + len > bytes.len() {
            output.extend_from_slice(&bytes[pos..]);
            return Ok(output);
        }

        let payload_end = pos + 2 + len;
        let is_app_segment = (0xE0..=0xEF).contains(&marker);
        if !is_app_segment {
            output.extend_from_slice(&bytes[pos..payload_end]);
        }
        pos = payload_end;
    }

    output.extend_from_slice(&bytes[pos..]);
    Ok(output)
}

fn preserve_jpeg_capture_segments(destination: &Path, source: &Path) -> Result<(), String> {
    let source_segments = collect_jpeg_app_metadata_segments(source)?;
    let destination_without_metadata = jpeg_without_app_metadata_segments(destination)?;

    let mut output = Vec::new();
    output.extend_from_slice(&destination_without_metadata[..2]);
    for segment in source_segments {
        output.extend_from_slice(&segment);
    }
    output.extend_from_slice(&destination_without_metadata[2..]);
    fs::write(destination, output).map_err(|e| {
        format!(
            "Failed to preserve metadata for {}: {}",
            destination.display(),
            e
        )
    })
}

fn write_jpeg_xmp_rating(path: &Path, rating: u8) -> Result<PathBuf, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    if bytes.len() < 2 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err(format!("{} is not a valid JPEG file", path.display()));
    }

    let xmp_segment = build_jpeg_xmp_segment(rating)?;
    let mut output = Vec::with_capacity(bytes.len() + xmp_segment.len());
    output.extend_from_slice(&bytes[..2]);
    output.extend_from_slice(&xmp_segment);

    let mut pos = 2;
    while pos < bytes.len() {
        if pos + 4 > bytes.len() || bytes[pos] != 0xFF {
            output.extend_from_slice(&bytes[pos..]);
            break;
        }

        let marker = bytes[pos + 1];
        if marker == 0xDA || marker == 0xD9 {
            output.extend_from_slice(&bytes[pos..]);
            break;
        }

        let len = u16::from_be_bytes([bytes[pos + 2], bytes[pos + 3]]) as usize;
        if len < 2 || pos + 2 + len > bytes.len() {
            output.extend_from_slice(&bytes[pos..]);
            break;
        }

        let payload_start = pos + 4;
        let payload_end = pos + 2 + len;
        let is_xmp =
            marker == 0xE1 && bytes[payload_start..payload_end].starts_with(XMP_IDENTIFIER);
        if !is_xmp {
            output.extend_from_slice(&bytes[pos..payload_end]);
        }
        pos = payload_end;
    }

    fs::write(path, output).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    Ok(path.to_path_buf())
}

fn read_rating_from_path(path: &Path) -> Option<u8> {
    if is_jpeg_path(path) {
        return read_jpeg_xmp_rating(path).or_else(|| read_xmp_sidecar_rating(path));
    }

    read_xmp_sidecar_rating(path)
}

fn write_rating_to_path(path: &Path, rating: u8) -> Result<PathBuf, String> {
    if is_jpeg_path(path) {
        return write_jpeg_xmp_rating(path, rating);
    }

    if is_raw_path(path) {
        return write_xmp_sidecar_rating(path, rating);
    }

    write_xmp_sidecar_rating(path, rating)
}

fn rendered_export_metadata_mode(value: Option<&str>) -> &'static str {
    match value {
        Some("RATING_ONLY") => "RATING_ONLY",
        Some("CAPTURE_INFO_AND_RATING") => "CAPTURE_INFO_AND_RATING",
        Some("ALL") => "ALL",
        _ => "NONE",
    }
}

fn write_rendered_export_metadata(
    path: &Path,
    rating: Option<u8>,
    metadata_mode: Option<&str>,
    metadata_source_path: Option<&str>,
) -> Result<Vec<String>, String> {
    let mode = rendered_export_metadata_mode(metadata_mode);
    if mode == "NONE" {
        return Ok(Vec::new());
    }

    if mode == "CAPTURE_INFO_AND_RATING" && is_jpeg_path(path) {
        let source_path = metadata_source_path
            .map(Path::new)
            .ok_or_else(|| "No JPEG source available for capture metadata copy".to_string())?;
        preserve_jpeg_capture_segments(path, source_path)?;
    }

    let Some(rating) = rating else {
        return Ok(Vec::new());
    };

    let target = write_rating_to_path(path, clamp_rating(rating))?;
    Ok(vec![target.display().to_string()])
}

fn read_group_rating(group: &PhotoGroupInfo) -> u8 {
    let mut rating = 0u8;
    if let Some(jpg) = &group.jpg {
        if let Some(value) = read_rating_from_path(Path::new(&jpg.path)) {
            rating = rating.max(value);
        }
    }
    if let Some(raw) = &group.raw {
        if let Some(value) = read_rating_from_path(Path::new(&raw.path)) {
            rating = rating.max(value);
        }
    }
    clamp_rating(rating)
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn read_exif(file_path: String) -> Result<ExifData, String> {
    let path = Path::new(&file_path);

    // Open the file
    let file = File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut bufreader = BufReader::new(file);

    // Read EXIF data
    let exifreader = exif::Reader::new();
    let exif = exifreader
        .read_from_container(&mut bufreader)
        .map_err(|e| format!("Failed to read EXIF: {}", e))?;

    // Extract commonly used EXIF fields
    let mut exif_data = ExifData {
        shutter_speed: None,
        aperture: None,
        iso: None,
        focal_length: None,
        date_time: None,
        model: None,
        lens: None,
        orientation: orientation_from_exif(&exif),
    };

    // Extract exposure time (shutter speed)
    if let Some(field) = exif.get_field(exif::Tag::ExposureTime, exif::In::PRIMARY) {
        match &field.value {
            exif::Value::Rational(ref vals) => {
                if let Some(val) = vals.first() {
                    if val.denom != 0 {
                        let speed = val.num as f64 / val.denom as f64;
                        if speed >= 1.0 {
                            exif_data.shutter_speed = Some(format!("{:.1}s", speed));
                        } else {
                            // For speeds less than 1 second, display as fraction
                            let reciprocal = (val.denom as f64 / val.num as f64).round() as u32;
                            exif_data.shutter_speed = Some(format!("1/{}", reciprocal));
                        }
                    }
                }
            }
            _ => {
                // Fallback to display value if not a rational
                let display = field.display_value().with_unit(&exif).to_string();
                exif_data.shutter_speed = Some(display.trim_matches('"').to_string());
            }
        }
    }

    // Extract aperture (F-number)
    if let Some(field) = exif.get_field(exif::Tag::FNumber, exif::In::PRIMARY) {
        if let exif::Value::Rational(ref vals) = field.value {
            if let Some(val) = vals.first() {
                if val.denom != 0 {
                    let aperture = val.num as f64 / val.denom as f64;
                    exif_data.aperture = Some(format!("f/{:.1}", aperture));
                }
            }
        }
    }

    // Extract ISO
    if let Some(field) = exif.get_field(exif::Tag::PhotographicSensitivity, exif::In::PRIMARY) {
        let iso_str = field.display_value().with_unit(&exif).to_string();
        exif_data.iso = Some(iso_str.trim_matches('"').to_string());
    }

    // Extract focal length
    if let Some(field) = exif.get_field(exif::Tag::FocalLength, exif::In::PRIMARY) {
        if let exif::Value::Rational(ref vals) = field.value {
            if let Some(val) = vals.first() {
                if val.denom != 0 {
                    let focal = val.num as f64 / val.denom as f64;
                    exif_data.focal_length = Some(format!("{:.0}mm", focal));
                }
            }
        }
    }

    // Extract date time
    if let Some(field) = exif.get_field(exif::Tag::DateTime, exif::In::PRIMARY) {
        let datetime_str = field.display_value().with_unit(&exif).to_string();
        exif_data.date_time = Some(datetime_str.trim_matches('"').to_string());
    }

    // Extract camera model
    if let Some(field) = exif.get_field(exif::Tag::Model, exif::In::PRIMARY) {
        let model_str = field.display_value().with_unit(&exif).to_string();
        exif_data.model = Some(model_str.trim_matches('"').to_string());
    }

    // Extract lens model
    if let Some(field) = exif.get_field(exif::Tag::LensModel, exif::In::PRIMARY) {
        match &field.value {
            exif::Value::Ascii(ref vec) => {
                // Handle ASCII value - join all non-empty strings
                let lens_parts: Vec<String> = vec
                    .iter()
                    .filter_map(|bytes| {
                        let s = std::str::from_utf8(bytes)
                            .ok()?
                            .trim_matches('\0')
                            .trim()
                            .trim_matches('"');
                        if !s.is_empty() {
                            Some(s.to_string())
                        } else {
                            None
                        }
                    })
                    .collect();

                if !lens_parts.is_empty() {
                    exif_data.lens = Some(lens_parts[0].clone());
                }
            }
            _ => {
                // Fallback to display value
                let lens_str = field.display_value().with_unit(&exif).to_string();
                let cleaned = lens_str.trim_matches('"').trim().to_string();
                // Remove any trailing empty quoted strings like ","",""
                let final_lens = cleaned
                    .split(',')
                    .next()
                    .unwrap_or(&cleaned)
                    .trim()
                    .trim_matches('"')
                    .to_string();

                if !final_lens.is_empty() {
                    exif_data.lens = Some(final_lens);
                }
            }
        }
    }

    Ok(exif_data)
}

#[tauri::command]
fn scan_folder(app: tauri::AppHandle, folder_path: String) -> Result<Vec<PhotoGroupInfo>, String> {
    let path = Path::new(&folder_path);

    if !path.is_dir() {
        return Err("Path is not a directory".to_string());
    }

    let entries = collect_files_recursive(path)?;

    Ok(collect_photo_groups_from_paths(
        entries,
        |processed, total, current| {
            emit_import_progress(&app, "scan", processed, total, current);
        },
    ))
}

#[tauri::command]
fn scan_files(
    app: tauri::AppHandle,
    file_paths: Vec<String>,
) -> Result<Vec<PhotoGroupInfo>, String> {
    let paths: Vec<PathBuf> = file_paths.into_iter().map(PathBuf::from).collect();
    Ok(collect_photo_groups_from_paths(
        paths,
        |processed, total, current| {
            emit_import_progress(&app, "scan", processed, total, current);
        },
    ))
}

#[tauri::command]
fn enrich_photo_metadata(
    app: tauri::AppHandle,
    groups: Vec<PhotoGroupInfo>,
) -> Result<Vec<PhotoGroupInfo>, String> {
    let total = groups.len();
    let mut result = Vec::with_capacity(total);
    emit_import_progress(&app, "metadata", 0, total, None);

    for (index, mut group) in groups.into_iter().enumerate() {
        enrich_group_metadata(&mut group);
        let processed = index + 1;
        if should_emit_progress(processed, total) {
            emit_import_progress(&app, "metadata", processed, total, Some(group.id.clone()));
        }
        result.push(group);
    }

    emit_import_progress(&app, "done", total, total, None);
    Ok(result)
}

fn stream_import_groups(
    channel: &Channel<ImportStreamEvent>,
    phase: &str,
    groups: &[PhotoGroupInfo],
) {
    let total = groups.len();
    send_import_stream_event(
        channel,
        import_event(
            "progress",
            Some(phase),
            Some(0),
            Some(total),
            None,
            None,
            None,
        ),
    );
    send_import_groups_in_chunks(channel, "groups", phase, groups);
    send_import_stream_event(
        channel,
        import_event(
            "progress",
            Some(phase),
            Some(total),
            Some(total),
            None,
            None,
            None,
        ),
    );
}

fn stream_import_metadata(
    channel: &Channel<ImportStreamEvent>,
    groups: &[PhotoGroupInfo],
) -> Vec<PhotoGroupInfo> {
    let total = groups.len();
    let mut enriched = Vec::with_capacity(total);
    let mut batch = Vec::with_capacity(IMPORT_BATCH_SIZE);

    send_import_stream_event(
        channel,
        import_event(
            "progress",
            Some("metadata"),
            Some(0),
            Some(total),
            None,
            None,
            None,
        ),
    );

    for (index, mut group) in groups.iter().cloned().enumerate() {
        enrich_group_metadata(&mut group);
        batch.push(group.clone());
        let processed = index + 1;
        if batch.len() >= IMPORT_BATCH_SIZE {
            send_import_stream_event(
                channel,
                import_event(
                    "metadata",
                    Some("metadata"),
                    Some(processed),
                    Some(total),
                    None,
                    Some(std::mem::take(&mut batch)),
                    None,
                ),
            );
            std::thread::sleep(Duration::from_millis(8));
        }
        enriched.push(group);
    }

    if !batch.is_empty() {
        send_import_stream_event(
            channel,
            import_event(
                "metadata",
                Some("metadata"),
                Some(total),
                Some(total),
                None,
                Some(batch),
                None,
            ),
        );
    }

    send_import_stream_event(
        channel,
        import_event(
            "done",
            Some("done"),
            Some(total),
            Some(total),
            None,
            None,
            None,
        ),
    );

    enriched
}

fn run_import_folder_stream(
    app: tauri::AppHandle,
    folder_path: String,
    channel: Channel<ImportStreamEvent>,
) -> Result<(), String> {
    let path = Path::new(&folder_path);
    if !path.is_dir() {
        let error = "Path is not a directory".to_string();
        send_import_stream_event(
            &channel,
            import_event(
                "error",
                Some("error"),
                None,
                None,
                None,
                None,
                Some(error.clone()),
            ),
        );
        return Err(error);
    }

    let entries = collect_files_recursive(path)?;

    let groups = collect_photo_groups_from_paths(entries, |processed, total, current| {
        send_import_stream_event(
            &channel,
            import_event(
                "progress",
                Some("scan"),
                Some(processed),
                Some(total),
                current,
                None,
                None,
            ),
        );
    });

    stream_import_groups(&channel, "pair", &groups);
    stream_import_metadata(&channel, &groups);

    let _ = app;
    Ok(())
}

fn run_import_files_stream(
    app: tauri::AppHandle,
    file_paths: Vec<String>,
    channel: Channel<ImportStreamEvent>,
) -> Result<(), String> {
    let paths: Vec<PathBuf> = file_paths.into_iter().map(PathBuf::from).collect();
    let groups = collect_photo_groups_from_paths(paths, |processed, total, current| {
        send_import_stream_event(
            &channel,
            import_event(
                "progress",
                Some("scan"),
                Some(processed),
                Some(total),
                current,
                None,
                None,
            ),
        );
    });

    stream_import_groups(&channel, "pair", &groups);
    stream_import_metadata(&channel, &groups);

    let _ = app;
    Ok(())
}

#[tauri::command]
async fn import_folder_stream(
    app: tauri::AppHandle,
    folder_path: String,
    on_event: Channel<ImportStreamEvent>,
) -> Result<(), String> {
    spawn_blocking(move || run_import_folder_stream(app, folder_path, on_event))
        .await
        .map_err(|e| format!("Import task failed: {}", e))?
}

#[tauri::command]
async fn import_files_stream(
    app: tauri::AppHandle,
    file_paths: Vec<String>,
    on_event: Channel<ImportStreamEvent>,
) -> Result<(), String> {
    spawn_blocking(move || run_import_files_stream(app, file_paths, on_event))
        .await
        .map_err(|e| format!("Import task failed: {}", e))?
}

fn extract_raw_embedded_preview_blocking(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<Option<RawEmbeddedPreview>, String> {
    let path = Path::new(&file_path);

    if !path.is_file() || !is_raw_path(path) {
        return Ok(None);
    }

    let orientation = read_orientation(path);
    let bytes = fs::read(path).map_err(|e| format!("Failed to read RAW file: {}", e))?;
    let Some((offset, byte_length)) = find_largest_embedded_jpeg(&bytes) else {
        return Ok(None);
    };

    let cache_path = raw_preview_cache_path(&app, path, byte_length, orientation)?;
    if cache_path.exists() {
        return Ok(Some(RawEmbeddedPreview {
            cache_path: cache_path.to_string_lossy().to_string(),
            byte_length,
            offset,
            orientation,
            from_cache: true,
            source: "embedded-jpeg".to_string(),
            width: None,
            height: None,
            error: None,
        }));
    }

    let end = offset + byte_length;
    let normalized = normalize_preview_jpeg(&bytes[offset..end], orientation)?;
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create preview cache directory: {}", e))?;
    }
    let mut file = File::create(&cache_path)
        .map_err(|e| format!("Failed to create preview cache file: {}", e))?;
    file.write_all(&normalized)
        .map_err(|e| format!("Failed to write preview cache file: {}", e))?;

    Ok(Some(RawEmbeddedPreview {
        cache_path: cache_path.to_string_lossy().to_string(),
        byte_length,
        offset,
        orientation,
        from_cache: false,
        source: "embedded-jpeg".to_string(),
        width: None,
        height: None,
        error: None,
    }))
}

fn get_jpeg_thumbnail_blocking(
    app: tauri::AppHandle,
    file_path: String,
    max_edge: Option<u32>,
) -> Result<CachedJpegThumbnail, String> {
    let path = Path::new(&file_path);

    if !path.is_file() || !is_jpeg_path(path) {
        return Err("Path is not a JPEG file".to_string());
    }

    let max_edge = max_edge.unwrap_or(360).clamp(160, 720);
    let orientation = read_orientation(path);
    let cache_path = jpeg_thumbnail_cache_path(&app, path, max_edge, orientation)?;
    if cache_path.exists() {
        let image = image::open(&cache_path)
            .map_err(|e| format!("Failed to read cached JPEG thumbnail: {}", e))?;
        let (width, height) = image.dimensions();
        return Ok(CachedJpegThumbnail {
            cache_path: cache_path.to_string_lossy().to_string(),
            from_cache: true,
            width,
            height,
        });
    }

    let image = image::open(path).map_err(|e| format!("Failed to decode JPEG thumbnail: {}", e))?;
    let normalized = normalize_orientation(image, orientation);
    let thumbnail = resize_to_max_edge(normalized, max_edge);
    let (width, height) = thumbnail.dimensions();

    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create JPEG thumbnail cache directory: {}", e))?;
    }

    let mut file = File::create(&cache_path)
        .map_err(|e| format!("Failed to create JPEG thumbnail cache file: {}", e))?;
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, 78);
    encoder
        .encode_image(&thumbnail)
        .map_err(|e| format!("Failed to write JPEG thumbnail cache: {}", e))?;

    Ok(CachedJpegThumbnail {
        cache_path: cache_path.to_string_lossy().to_string(),
        from_cache: false,
        width,
        height,
    })
}

#[cfg(feature = "pro")]
fn raw_monitor_event(
    kind: &str,
    processed: Option<usize>,
    total: Option<usize>,
    current: Option<String>,
    raw_path: Option<String>,
    cache_path: Option<String>,
    engine_version: Option<String>,
    errors: Option<Vec<String>>,
    error: Option<String>,
) -> RawMonitorCacheEvent {
    RawMonitorCacheEvent {
        kind: kind.to_string(),
        processed,
        total,
        current,
        raw_path,
        profile_id: None,
        cache_path,
        fallback: None,
        cache_source: None,
        skipped_reason: None,
        engine_version,
        errors,
        error,
    }
}

#[cfg(feature = "pro")]
fn send_raw_monitor_event(channel: &Channel<RawMonitorCacheEvent>, event: RawMonitorCacheEvent) {
    let _ = channel.send(event);
}

#[cfg(feature = "pro")]
fn rawtherapee_command(engine_path: &Path) -> Command {
    let mut command = Command::new(engine_path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(parent) = engine_path.parent() {
        command.current_dir(parent);
    }
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    command
}

#[cfg(feature = "pro")]
fn run_command_with_timeout(mut command: Command, timeout: Duration) -> Result<Output, String> {
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to launch process: {}", e))?;
    let started = Instant::now();

    loop {
        if let Some(_status) = child
            .try_wait()
            .map_err(|e| format!("Failed to wait for process: {}", e))?
        {
            return child
                .wait_with_output()
                .map_err(|e| format!("Failed to read process output: {}", e));
        }

        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Process timed out".to_string());
        }

        std::thread::sleep(Duration::from_millis(80));
    }
}

#[cfg(feature = "pro")]
fn raw_engine_result(
    ok: bool,
    engine_path: Option<String>,
    version: Option<String>,
    engine_source: Option<&str>,
    message: Option<String>,
) -> RawEngineValidationResult {
    RawEngineValidationResult {
        ok,
        engine_kind: "RAWTHERAPEE".to_string(),
        engine_path,
        version,
        engine_source: engine_source.map(|value| value.to_string()),
        bundled_engine_version: Some(RAWTHERAPEE_BUNDLED_VERSION.to_string()),
        message,
    }
}

#[cfg(feature = "pro")]
fn validate_raw_engine_path(engine_path: &Path, engine_source: &str) -> RawEngineValidationResult {
    if !engine_path.is_file() {
        return raw_engine_result(
            false,
            Some(engine_path.display().to_string()),
            None,
            Some(engine_source),
            Some("RawTherapee CLI was not found at this path".to_string()),
        );
    }

    let mut command = rawtherapee_command(engine_path);
    command.arg("-v");
    match run_command_with_timeout(command, Duration::from_secs(5)) {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let version = if !stdout.is_empty() {
                stdout
            } else if !stderr.is_empty() {
                stderr
            } else {
                "RawTherapee CLI".to_string()
            };
            let ok = output.status.success() || version.to_lowercase().contains("rawtherapee");
            raw_engine_result(
                ok,
                Some(engine_path.display().to_string()),
                Some(version),
                Some(engine_source),
                if ok {
                    Some(match engine_source {
                        "BUNDLED" => "Bundled RawTherapee CLI is available".to_string(),
                        "MANUAL" => "RawTherapee CLI is available".to_string(),
                        _ => "System RawTherapee CLI is available".to_string(),
                    })
                } else {
                    Some(format!("RawTherapee CLI returned status {}", output.status))
                },
            )
        }
        Err(error) => raw_engine_result(
            false,
            Some(engine_path.display().to_string()),
            None,
            Some(engine_source),
            Some(error),
        ),
    }
}

#[cfg(feature = "pro")]
fn validate_raw_engine_blocking(engine_path: String) -> RawEngineValidationResult {
    let path = PathBuf::from(engine_path.trim());
    if path.as_os_str().is_empty() {
        return raw_engine_result(
            false,
            None,
            None,
            Some("MANUAL"),
            Some("RawTherapee CLI path is empty".to_string()),
        );
    }

    validate_raw_engine_path(&path, "MANUAL")
}

#[cfg(feature = "pro")]
fn bundled_rawtherapee_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(RAWTHERAPEE_BUNDLED_RESOURCE_CLI));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(dir) = current_exe.parent() {
            candidates.push(dir.join(RAWTHERAPEE_BUNDLED_RESOURCE_CLI));
            candidates.push(
                dir.join("../Resources")
                    .join(RAWTHERAPEE_BUNDLED_RESOURCE_CLI),
            );
        }
    }

    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(RAWTHERAPEE_DEV_VENDOR_CLI));
    candidates
}

#[cfg(feature = "pro")]
fn rawtherapee_candidates(app: Option<&tauri::AppHandle>) -> Vec<(PathBuf, &'static str)> {
    let mut candidates = Vec::new();

    if let Some(app) = app {
        for path in bundled_rawtherapee_candidates(app) {
            candidates.push((path, "BUNDLED"));
        }
    }

    if let Some(paths) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&paths) {
            candidates.push((path.join("rawtherapee-cli.exe"), "SYSTEM"));
            candidates.push((path.join("rawtherapee-cli"), "SYSTEM"));
        }
    }

    #[cfg(target_os = "windows")]
    {
        for root in ["C:\\Program Files", "C:\\Program Files (x86)"] {
            candidates.push((
                PathBuf::from(root)
                    .join("RawTherapee")
                    .join("rawtherapee-cli.exe"),
                "SYSTEM",
            ));
            if let Ok(entries) = fs::read_dir(PathBuf::from(root).join("RawTherapee")) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        candidates.push((path.join("rawtherapee-cli.exe"), "SYSTEM"));
                    }
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push((
            PathBuf::from("/Applications/RawTherapee.app/Contents/MacOS/rawtherapee-cli"),
            "SYSTEM",
        ));
    }

    candidates
}

#[cfg(feature = "pro")]
fn detect_rawtherapee_cli_blocking(app: Option<tauri::AppHandle>) -> RawEngineValidationResult {
    let mut seen = HashSet::new();
    for (candidate, source) in rawtherapee_candidates(app.as_ref()) {
        let key = candidate.to_string_lossy().to_string();
        if !seen.insert(key) || !candidate.is_file() {
            continue;
        }
        let result = validate_raw_engine_path(&candidate, source);
        if result.ok {
            return result;
        }
    }

    raw_engine_result(
        false,
        None,
        None,
        None,
        Some(
            "RawTherapee CLI was not found in the Pro bundle, PATH, or common install locations"
                .to_string(),
        ),
    )
}

#[cfg(feature = "pro")]
fn readable_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .unwrap_or_else(|| path.display().to_string())
}

#[cfg(feature = "pro")]
fn render_raw_monitor_cache_file(
    engine_path: &Path,
    pp3_path: &Path,
    raw_path: &Path,
    cache_path: &Path,
    profile_id: &str,
) -> Result<RawMonitorRenderResult, String> {
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create RAW monitor cache directory: {}", e))?;
    }

    if cache_path.exists() && validate_raw_monitor_cache_jpeg(cache_path).is_ok() {
        return Ok(RawMonitorRenderResult {
            cache_path: cache_path.to_path_buf(),
            status: raw_monitor_cache_status(cache_path),
        });
    }
    if cache_path.exists() {
        let _ = fs::remove_file(cache_path);
    }

    let mut command = rawtherapee_command(engine_path);
    command
        .arg("-o")
        .arg(cache_path)
        .arg("-p")
        .arg(pp3_path)
        .arg(format!("-j{}", RAW_MONITOR_JPEG_QUALITY))
        .arg("-Y")
        .arg("-c")
        .arg(raw_path);

    let output = run_command_with_timeout(command, Duration::from_secs(180))?;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return write_raw_monitor_embedded_preview_cache(raw_path, cache_path, profile_id).map(
            |status| RawMonitorRenderResult {
                cache_path: cache_path.to_path_buf(),
                status,
            },
        ).map_err(
            |fallback_error| {
                let rawtherapee_error = if detail.is_empty() {
                    format!("RawTherapee CLI exited with {}", output.status)
                } else {
                    detail
                };
                format!(
                    "{}; embedded preview fallback also failed: {}",
                    rawtherapee_error, fallback_error
                )
            },
        );
    }

    if rawtherapee_reported_decode_failure(&stderr) {
        let _ = fs::remove_file(cache_path);
        let detail = if stderr.is_empty() {
            "RawTherapee reported a RAW decode failure".to_string()
        } else {
            stderr
        };
        return write_raw_monitor_embedded_preview_cache(raw_path, cache_path, profile_id).map(
            |status| RawMonitorRenderResult {
                cache_path: cache_path.to_path_buf(),
                status,
            },
        ).map_err(
            |fallback_error| {
                format!(
                    "{}; embedded preview fallback also failed: {}",
                    detail, fallback_error
                )
            },
        );
    }

    if !cache_path.is_file() {
        return write_raw_monitor_embedded_preview_cache(raw_path, cache_path, profile_id).map(
            |status| RawMonitorRenderResult {
                cache_path: cache_path.to_path_buf(),
                status,
            },
        ).map_err(
            |fallback_error| {
                format!(
                    "RawTherapee did not produce a cache JPEG; embedded preview fallback also failed: {}",
                    fallback_error
                )
            },
        );
    }
    validate_raw_monitor_cache_jpeg(cache_path).map(|_| {
        let _ = write_raw_monitor_cache_metadata(cache_path, profile_id, "rawtherapee", false);
        RawMonitorRenderResult {
            cache_path: cache_path.to_path_buf(),
            status: RawMonitorCacheStatus {
                source: "rawtherapee".to_string(),
                fallback: false,
            },
        }
    }).or_else(|error| {
        let _ = fs::remove_file(cache_path);
        write_raw_monitor_embedded_preview_cache(raw_path, cache_path, profile_id).map(
            |status| RawMonitorRenderResult {
                cache_path: cache_path.to_path_buf(),
                status,
            },
        ).map_err(|fallback_error| {
            format!(
                "{}; embedded preview fallback also failed: {}",
                error, fallback_error
            )
        })
    })
}

#[cfg(feature = "pro")]
fn write_raw_monitor_embedded_preview_cache(
    raw_path: &Path,
    cache_path: &Path,
    profile_id: &str,
) -> Result<RawMonitorCacheStatus, String> {
    let orientation = read_orientation(raw_path);
    let bytes = fs::read(raw_path)
        .map_err(|e| format!("Failed to read RAW file for embedded preview fallback: {}", e))?;
    let Some((offset, byte_length)) = find_largest_embedded_jpeg(&bytes) else {
        return Err("RAW file does not contain a displayable embedded JPEG preview".to_string());
    };
    let end = offset
        .checked_add(byte_length)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| "Embedded JPEG preview points outside RAW file".to_string())?;
    let image = image::load_from_memory_with_format(&bytes[offset..end], ImageFormat::Jpeg)
        .map_err(|e| format!("Failed to decode embedded JPEG preview fallback: {}", e))?;
    let normalized = normalize_orientation(image, orientation);
    let resized = resize_to_max_edge(normalized, RAW_MONITOR_MAX_EDGE);

    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create RAW monitor cache directory: {}", e))?;
    }
    let file = File::create(cache_path)
        .map_err(|e| format!("Failed to create embedded preview cache JPEG: {}", e))?;
    let mut encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(file, RAW_MONITOR_JPEG_QUALITY);
    encoder
        .encode_image(&resized)
        .map_err(|e| format!("Failed to write embedded preview cache JPEG: {}", e))?;
    validate_raw_monitor_cache_jpeg(cache_path)?;
    write_raw_monitor_cache_metadata(cache_path, profile_id, "embeddedFallback", true)?;
    Ok(RawMonitorCacheStatus {
        source: "embeddedFallback".to_string(),
        fallback: true,
    })
}

#[cfg(feature = "pro")]
fn validate_raw_monitor_cache_jpeg(cache_path: &Path) -> Result<(), String> {
    image::open(cache_path)
        .map(|_| ())
        .map_err(|e| format!("RAW monitor cache is not a readable JPEG: {}", e))
}

#[cfg(feature = "pro")]
fn rawtherapee_reported_decode_failure(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    [
        "unsupported file",
        "cannot decode",
        "failed to decode",
        "decode failed",
        "decoder error",
        "unknown file: data corrupted",
        "data corrupted at",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

#[cfg(feature = "pro")]
fn raw_monitor_parallelism() -> usize {
    let logical = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4);
    (logical / 4).clamp(1, RAW_MONITOR_MAX_PARALLELISM)
}

#[cfg(feature = "pro")]
fn run_raw_monitor_cache_stream(
    app: tauri::AppHandle,
    engine_path: String,
    raw_paths: Vec<String>,
    profile_id: String,
    priority_count: usize,
    on_event: Channel<RawMonitorCacheEvent>,
) -> Result<(), String> {
    RAW_MONITOR_CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    let profile_id = normalize_raw_monitor_profile_id(&profile_id).to_string();

    let validation = validate_raw_engine_blocking(engine_path.clone());
    if !validation.ok {
        let error = validation
            .message
            .clone()
            .unwrap_or_else(|| "RawTherapee CLI is not available".to_string());
        send_raw_monitor_event(
            &on_event,
            raw_monitor_event(
                "error",
                Some(0),
                Some(raw_paths.len()),
                None,
                None,
                None,
                validation.version,
                None,
                Some(error.clone()),
            ),
        );
        return Err(error);
    }

    let engine_version = validation
        .version
        .clone()
        .unwrap_or_else(|| "RawTherapee CLI".to_string());
    let pp3_path = ensure_raw_monitor_pp3(&app, &profile_id)?;
    let engine_path = PathBuf::from(engine_path);
    let total = raw_paths.len();
    let processed = Arc::new(AtomicUsize::new(0));
    let errors = Arc::new(Mutex::new(Vec::new()));
    let failure_table = Arc::new(Mutex::new(read_raw_monitor_failure_table(&app)));
    let failure_table_changed = Arc::new(AtomicBool::new(false));

    send_raw_monitor_event(
        &on_event,
        raw_monitor_event(
            "started",
            Some(0),
            Some(total),
            None,
            None,
            None,
            Some(engine_version.clone()),
            None,
            None,
        ),
    );

    // RawTherapee is a heavy external process, so keep concurrency deliberately
    // below CPU thread count. Unbounded rayon parallelism can make preview
    // generation slower and freeze the UI on laptop-class machines.
    let pool = ThreadPoolBuilder::new()
        .num_threads(raw_monitor_parallelism())
        .build()
        .map_err(|e| format!("Failed to create RAW monitor worker pool: {}", e))?;

    let priority_count = priority_count.min(total);
    pool.install(|| {
        let process_raw_path = |raw_path_string: &String| {
            if RAW_MONITOR_CANCEL_REQUESTED.load(Ordering::SeqCst) {
                return;
            }

            let raw_path = PathBuf::from(raw_path_string);
            let current = readable_file_name(&raw_path);
            let current_processed = processed.load(Ordering::SeqCst);

            send_raw_monitor_event(
                &on_event,
                raw_monitor_event(
                    "progress",
                    Some(current_processed),
                    Some(total),
                    Some(current.clone()),
                    Some(raw_path_string.clone()),
                    None,
                    Some(engine_version.clone()),
                    None,
                    None,
                ),
            );

            if !raw_path.is_file() || !is_raw_path(&raw_path) {
                let mut errors_lock = errors.lock().unwrap();
                errors_lock.push(format!(
                    "Unsupported or missing RAW source: {}",
                    raw_path_string
                ));
                processed.fetch_add(1, Ordering::SeqCst);
                return;
            }

            match raw_monitor_cache_path(&app, &raw_path, &engine_version, &profile_id) {
                Ok(cache_path) => {
                    let failure_key = raw_monitor_failure_key(&cache_path);
                    if cache_path.is_file() && validate_raw_monitor_cache_jpeg(&cache_path).is_ok() {
                        let status = raw_monitor_cache_status(&cache_path);
                        if is_nikon_raw_path(&raw_path) {
                            let mut table = failure_table.lock().unwrap();
                            if table.remove(&failure_key).is_some() {
                                failure_table_changed.store(true, Ordering::SeqCst);
                            }
                        }
                        let new_processed = processed.fetch_add(1, Ordering::SeqCst) + 1;
                        let mut event = raw_monitor_event(
                            "cached",
                            Some(new_processed),
                            Some(total),
                            Some(current),
                            Some(raw_path_string.clone()),
                            Some(cache_path.display().to_string()),
                            Some(engine_version.clone()),
                            None,
                            None,
                        );
                        event.cache_source = Some(status.source);
                        event.fallback = Some(status.fallback);
                        send_raw_monitor_event(&on_event, event);
                        return;
                    }

                    if is_nikon_raw_path(&raw_path) {
                        let recent_failure = {
                            let mut table = failure_table.lock().unwrap();
                            let now = now_ms();
                            if let Some(record) =
                                raw_monitor_recent_failure(&table, &failure_key, now).cloned()
                            {
                                Some(record)
                            } else {
                                if table.remove(&failure_key).is_some() {
                                    failure_table_changed.store(true, Ordering::SeqCst);
                                }
                                None
                            }
                        };

                        if let Some(record) = recent_failure {
                            let new_processed = processed.fetch_add(1, Ordering::SeqCst) + 1;
                            let mut event = raw_monitor_event(
                                "skipped",
                                Some(new_processed),
                                Some(total),
                                Some(current),
                                Some(raw_path_string.clone()),
                                None,
                                Some(engine_version.clone()),
                                None,
                                None,
                            );
                            event.skipped_reason = Some(format!(
                                "Recent NEF RAW monitor failure; retry is cooled down. Last error: {}",
                                record.error
                            ));
                            send_raw_monitor_event(&on_event, event);
                            return;
                        }
                    }

                    match render_raw_monitor_cache_file(
                        &engine_path,
                        &pp3_path,
                        &raw_path,
                        &cache_path,
                        &profile_id,
                    ) {
                        Ok(result) => {
                            if is_nikon_raw_path(&raw_path) {
                                let mut table = failure_table.lock().unwrap();
                                if table.remove(&failure_key).is_some() {
                                    failure_table_changed.store(true, Ordering::SeqCst);
                                }
                            }
                            let new_processed = processed.fetch_add(1, Ordering::SeqCst) + 1;
                            let mut event = raw_monitor_event(
                                "cached",
                                Some(new_processed),
                                Some(total),
                                Some(current),
                                Some(raw_path_string.clone()),
                                Some(result.cache_path.display().to_string()),
                                Some(engine_version.clone()),
                                None,
                                None,
                            );
                            event.cache_source = Some(result.status.source);
                            event.fallback = Some(result.status.fallback);
                            send_raw_monitor_event(&on_event, event);
                        }
                        Err(error) => {
                            let new_processed = processed.fetch_add(1, Ordering::SeqCst) + 1;
                            let message = format!("{}: {}", current, error);
                            if is_nikon_raw_path(&raw_path) {
                                let mut table = failure_table.lock().unwrap();
                                table.insert(
                                    failure_key,
                                    RawMonitorFailureRecord {
                                        failed_at_ms: now_ms(),
                                        error: error.clone(),
                                    },
                                );
                                failure_table_changed.store(true, Ordering::SeqCst);
                            }
                            let mut errors_lock = errors.lock().unwrap();
                            errors_lock.push(message.clone());
                            let current_errors = errors_lock.clone();
                            drop(errors_lock);
                            send_raw_monitor_event(
                                &on_event,
                                raw_monitor_event(
                                    "error",
                                    Some(new_processed),
                                    Some(total),
                                    Some(current),
                                    Some(raw_path_string.clone()),
                                    None,
                                    Some(engine_version.clone()),
                                    Some(current_errors),
                                    Some(message),
                                ),
                            );
                        }
                    }
                }
                Err(error) => {
                    let new_processed = processed.fetch_add(1, Ordering::SeqCst) + 1;
                    let message = format!("{}: {}", current, error);
                    let mut errors_lock = errors.lock().unwrap();
                    errors_lock.push(message.clone());
                    let current_errors = errors_lock.clone();
                    drop(errors_lock);
                    send_raw_monitor_event(
                        &on_event,
                        raw_monitor_event(
                            "error",
                            Some(new_processed),
                            Some(total),
                            Some(current),
                            Some(raw_path_string.clone()),
                            None,
                            Some(engine_version.clone()),
                            Some(current_errors),
                            Some(message),
                        ),
                    );
                }
            }
        };

        let (priority_paths, background_paths) = raw_paths.split_at(priority_count);
        priority_paths.par_iter().for_each(&process_raw_path);
        background_paths.par_iter().for_each(&process_raw_path);
    });

    if failure_table_changed.load(Ordering::SeqCst) {
        let table = failure_table.lock().unwrap().clone();
        if let Err(error) = write_raw_monitor_failure_table(&app, &table) {
            eprintln!("Failed to write RAW monitor failure table: {}", error);
        }
    }

    if RAW_MONITOR_CANCEL_REQUESTED.load(Ordering::SeqCst) {
        let final_processed = processed.load(Ordering::SeqCst);
        let final_errors = errors.lock().unwrap().clone();
        send_raw_monitor_event(
            &on_event,
            raw_monitor_event(
                "cancelled",
                Some(final_processed),
                Some(total),
                None,
                None,
                None,
                Some(engine_version.clone()),
                Some(final_errors),
                None,
            ),
        );
        return Ok(());
    }

    let final_processed = processed.load(Ordering::SeqCst);
    let final_errors = errors.lock().unwrap().clone();
    send_raw_monitor_event(
        &on_event,
        raw_monitor_event(
            "done",
            Some(final_processed),
            Some(total),
            None,
            None,
            None,
            Some(engine_version),
            Some(final_errors),
            None,
        ),
    );
    Ok(())
}

#[tauri::command]
async fn extract_raw_embedded_preview(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<Option<RawEmbeddedPreview>, String> {
    spawn_blocking(move || extract_raw_embedded_preview_blocking(app, file_path))
        .await
        .map_err(|e| format!("RAW preview task failed: {}", e))?
}

#[tauri::command]
async fn get_jpeg_thumbnail(
    app: tauri::AppHandle,
    file_path: String,
    max_edge: Option<u32>,
) -> Result<CachedJpegThumbnail, String> {
    spawn_blocking(move || get_jpeg_thumbnail_blocking(app, file_path, max_edge))
        .await
        .map_err(|e| format!("JPEG thumbnail task failed: {}", e))?
}

#[cfg(feature = "pro")]
#[tauri::command]
async fn detect_rawtherapee_cli(
    app: tauri::AppHandle,
) -> Result<RawEngineValidationResult, String> {
    spawn_blocking(move || detect_rawtherapee_cli_blocking(Some(app)))
        .await
        .map_err(|e| format!("RawTherapee detection task failed: {}", e))
}

#[cfg(feature = "pro")]
#[tauri::command]
async fn validate_raw_engine(engine_path: String) -> Result<RawEngineValidationResult, String> {
    spawn_blocking(move || validate_raw_engine_blocking(engine_path))
        .await
        .map_err(|e| format!("RAW engine validation task failed: {}", e))
}

#[cfg(feature = "pro")]
#[tauri::command]
async fn get_raw_monitor_cache_entry(
    app: tauri::AppHandle,
    raw_path: String,
    engine_version: String,
    profile_id: String,
) -> Result<RawMonitorCacheEntry, String> {
    spawn_blocking(move || {
        let path = PathBuf::from(&raw_path);
        let normalized_profile_id = normalize_raw_monitor_profile_id(&profile_id).to_string();
        if !path.is_file() || !is_raw_path(&path) {
            return Ok(RawMonitorCacheEntry {
                raw_path,
                profile_id: Some(normalized_profile_id),
                cache_path: None,
                from_cache: false,
                fallback: None,
                cache_source: None,
                recent_failure: None,
                missing_reason: Some("Path is not a supported RAW file".to_string()),
            });
        }
        let cache_path =
            raw_monitor_cache_path(&app, &path, &engine_version, &normalized_profile_id)?;
        if cache_path.is_file() && validate_raw_monitor_cache_jpeg(&cache_path).is_ok() {
            let status = raw_monitor_cache_status(&cache_path);
            Ok(RawMonitorCacheEntry {
                raw_path,
                profile_id: Some(normalized_profile_id),
                cache_path: Some(cache_path.display().to_string()),
                from_cache: true,
                fallback: Some(status.fallback),
                cache_source: Some(status.source),
                recent_failure: None,
                missing_reason: None,
            })
        } else {
            let failure_key = raw_monitor_failure_key(&cache_path);
            let recent_failure = is_nikon_raw_path(&path)
                && raw_monitor_recent_failure(
                    &read_raw_monitor_failure_table(&app),
                    &failure_key,
                    now_ms(),
                )
                .is_some();
            Ok(RawMonitorCacheEntry {
                raw_path,
                profile_id: Some(normalized_profile_id),
                cache_path: None,
                from_cache: false,
                fallback: None,
                cache_source: None,
                recent_failure: Some(recent_failure),
                missing_reason: Some(if recent_failure {
                    "Recent NEF RAW monitor failure is cooling down".to_string()
                } else {
                    "RAW monitor cache has not been generated".to_string()
                }),
            })
        }
    })
    .await
    .map_err(|e| format!("RAW monitor cache lookup task failed: {}", e))?
}

#[cfg(feature = "pro")]
#[tauri::command]
async fn render_raw_monitor_cache_stream(
    app: tauri::AppHandle,
    engine_path: String,
    raw_paths: Vec<String>,
    profile_id: String,
    priority_count: Option<usize>,
    on_event: Channel<RawMonitorCacheEvent>,
) -> Result<(), String> {
    spawn_blocking(move || {
        run_raw_monitor_cache_stream(
            app,
            engine_path,
            raw_paths,
            profile_id,
            priority_count.unwrap_or(0),
            on_event,
        )
    })
    .await
    .map_err(|e| format!("RAW monitor cache task failed: {}", e))?
}

#[cfg(feature = "pro")]
#[tauri::command]
fn cancel_raw_monitor_cache_render() -> Result<(), String> {
    RAW_MONITOR_CANCEL_REQUESTED.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(feature = "pro")]
const RAW_MONITOR_MAX_CACHE_SIZE_GB: u64 = 10;

#[cfg(feature = "pro")]
#[tauri::command]
fn clear_raw_monitor_cache(app: tauri::AppHandle) -> Result<(), String> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache directory: {}", e))?
        .join("raw-monitor-previews");
    if cache_root.exists() {
        fs::remove_dir_all(&cache_root)
            .map_err(|e| format!("Failed to clear RAW monitor cache: {}", e))?;
    }
    Ok(())
}

#[cfg(feature = "pro")]
#[tauri::command]
fn get_raw_monitor_cache_size(app: tauri::AppHandle) -> Result<u64, String> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache directory: {}", e))?
        .join("raw-monitor-previews");

    if !cache_root.exists() {
        return Ok(0);
    }

    let total_size = calculate_directory_size(&cache_root)
        .map_err(|e| format!("Failed to calculate cache size: {}", e))?;

    Ok(total_size)
}

#[cfg(feature = "pro")]
#[tauri::command]
fn cleanup_raw_monitor_cache_lru(app: tauri::AppHandle) -> Result<u64, String> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache directory: {}", e))?
        .join("raw-monitor-previews");

    if !cache_root.exists() {
        return Ok(0);
    }

    let total_size = calculate_directory_size(&cache_root)
        .map_err(|e| format!("Failed to calculate cache size: {}", e))?;

    let max_size_bytes = RAW_MONITOR_MAX_CACHE_SIZE_GB * 1024 * 1024 * 1024;

    if total_size <= max_size_bytes {
        return Ok(0);
    }

    // 需要清理：删除最旧的缓存文件直到低于限制
    let target_size = (max_size_bytes as f64 * 0.8) as u64; // 清理到80%
    let mut files_with_time: Vec<(PathBuf, std::time::SystemTime, u64)> = Vec::new();

    // 收集所有缓存文件及其修改时间和大小
    collect_cache_files(&cache_root, &mut files_with_time)
        .map_err(|e| format!("Failed to collect cache files: {}", e))?;

    files_with_time.sort_by_key(|(_, time, _)| *time);

    let mut current_size = total_size;
    let mut deleted_size = 0u64;

    for (file_path, _, file_size) in files_with_time {
        if current_size <= target_size {
            break;
        }

        if let Err(e) = fs::remove_file(&file_path) {
            eprintln!("Failed to delete cache file {:?}: {}", file_path, e);
        } else {
            current_size = current_size.saturating_sub(file_size);
            deleted_size += file_size;
        }
    }

    Ok(deleted_size)
}

#[cfg(feature = "pro")]
fn calculate_directory_size(path: &Path) -> std::io::Result<u64> {
    let mut total_size = 0u64;

    if path.is_file() {
        return Ok(path.metadata()?.len());
    }

    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;

        if metadata.is_file() {
            total_size += metadata.len();
        } else if metadata.is_dir() {
            total_size += calculate_directory_size(&entry.path())?;
        }
    }

    Ok(total_size)
}

#[cfg(feature = "pro")]
fn collect_cache_files(
    path: &Path,
    files: &mut Vec<(PathBuf, std::time::SystemTime, u64)>,
) -> std::io::Result<()> {
    if path.is_file() {
        let metadata = path.metadata()?;
        if let Ok(modified) = metadata.modified() {
            files.push((path.to_path_buf(), modified, metadata.len()));
        }
        return Ok(());
    }

    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let file_path = entry.path();
        let metadata = entry.metadata()?;

        if metadata.is_file() && file_path.extension().and_then(|s| s.to_str()) == Some("jpg") {
            if let Ok(modified) = metadata.modified() {
                files.push((file_path, modified, metadata.len()));
            }
        } else if metadata.is_dir() {
            collect_cache_files(&file_path, files)?;
        }
    }

    Ok(())
}

#[tauri::command]
fn move_to_trash(groups: Vec<PhotoGroupInfo>) -> Result<Vec<String>, String> {
    let mut moved_files = Vec::new();
    let mut failed_files = Vec::new();

    for group in groups {
        // Move JPG file to trash if it exists
        if let Some(jpg) = &group.jpg {
            let path = Path::new(&jpg.path);
            if let Err(error) = validate_photo_file_path(path) {
                failed_files.push(error);
            } else {
                match trash::delete(path) {
                    Ok(_) => {
                        moved_files.push(jpg.path.clone());
                    }
                    Err(e) => {
                        failed_files.push(format!("Failed to move {} to trash: {}", jpg.path, e));
                    }
                }
            }
        }

        // Move RAW file to trash if it exists
        if let Some(raw) = &group.raw {
            let path = Path::new(&raw.path);
            if let Err(error) = validate_photo_file_path(path) {
                failed_files.push(error);
            } else {
                match trash::delete(path) {
                    Ok(_) => {
                        moved_files.push(raw.path.clone());
                    }
                    Err(e) => {
                        failed_files.push(format!("Failed to move {} to trash: {}", raw.path, e));
                    }
                }
            }
        }
    }

    if !failed_files.is_empty() {
        Err(format!(
            "Some files failed to move to trash:\n{}",
            failed_files.join("\n")
        ))
    } else {
        Ok(moved_files)
    }
}

#[tauri::command]
fn delete_files_permanently(groups: Vec<PhotoGroupInfo>) -> Result<Vec<String>, String> {
    let mut deleted_files = Vec::new();
    let mut failed_files = Vec::new();

    for group in groups {
        // Delete JPG file if it exists
        if let Some(jpg) = &group.jpg {
            let path = Path::new(&jpg.path);
            if let Err(error) = validate_photo_file_path(path) {
                failed_files.push(error);
            } else {
                match fs::remove_file(path) {
                    Ok(_) => {
                        deleted_files.push(jpg.path.clone());
                    }
                    Err(e) => {
                        failed_files.push(format!("Failed to delete {}: {}", jpg.path, e));
                    }
                }
            }
        }

        // Delete RAW file if it exists
        if let Some(raw) = &group.raw {
            let path = Path::new(&raw.path);
            if let Err(error) = validate_photo_file_path(path) {
                failed_files.push(error);
            } else {
                match fs::remove_file(path) {
                    Ok(_) => {
                        deleted_files.push(raw.path.clone());
                    }
                    Err(e) => {
                        failed_files.push(format!("Failed to delete {}: {}", raw.path, e));
                    }
                }
            }
        }
    }

    if !failed_files.is_empty() {
        Err(format!(
            "Some files failed to delete permanently:\n{}",
            failed_files.join("\n")
        ))
    } else {
        Ok(deleted_files)
    }
}

#[tauri::command]
fn export_files(
    groups: Vec<PhotoGroupInfo>,
    export_mode: String,
    operation: String,
    destination_folder: String,
) -> Result<Vec<String>, String> {
    let dest_path = Path::new(&destination_folder);

    if !dest_path.exists() {
        return Err("Destination folder does not exist".to_string());
    }

    if !dest_path.is_dir() {
        return Err("Destination path is not a directory".to_string());
    }

    let mut processed_files = Vec::new();
    let mut failed_files = Vec::new();

    for group in groups {
        // Determine which files to export based on export_mode
        let files_to_export: Vec<&PhotoFileInfo> = match export_mode.as_str() {
            "JPG" => {
                if let Some(ref jpg) = group.jpg {
                    vec![jpg]
                } else {
                    continue;
                }
            }
            "RAW" => {
                if let Some(ref raw) = group.raw {
                    vec![raw]
                } else {
                    continue;
                }
            }
            "BOTH" => {
                let mut files = Vec::new();
                if let Some(ref jpg) = group.jpg {
                    files.push(jpg);
                }
                if let Some(ref raw) = group.raw {
                    files.push(raw);
                }
                if files.is_empty() {
                    continue;
                }
                files
            }
            _ => {
                failed_files.push(format!("Unknown export mode: {}", export_mode));
                continue;
            }
        };

        // Process each file
        for file_info in files_to_export {
            let source_path = Path::new(&file_info.path);

            if let Err(error) = validate_photo_file_path(source_path) {
                failed_files.push(error);
                continue;
            }

            let file_name = source_path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| format!("Invalid file name: {}", file_info.path))?;

            let dest_file_path = unique_destination_path(dest_path, file_name);

            // Perform the operation (copy or move)
            let result = match operation.as_str() {
                "COPY" => fs::copy(source_path, &dest_file_path)
                    .map(|_| ())
                    .map_err(|e| format!("Failed to copy {}: {}", file_name, e)),
                "MOVE" => fs::rename(source_path, &dest_file_path)
                    .map_err(|e| format!("Failed to move {}: {}", file_name, e)),
                _ => Err(format!("Unknown operation: {}", operation)),
            };

            match result {
                Ok(_) => {
                    processed_files.push(format!(
                        "{} {} to {}",
                        if operation == "COPY" {
                            "Copied"
                        } else {
                            "Moved"
                        },
                        file_name,
                        dest_file_path.display()
                    ));
                }
                Err(e) => {
                    failed_files.push(e);
                }
            }
        }
    }

    if !failed_files.is_empty() {
        Err(format!(
            "Export completed with errors:\n{}\n\nSuccessfully processed {} files",
            failed_files.join("\n"),
            processed_files.len()
        ))
    } else if processed_files.is_empty() {
        Err("No files were exported".to_string())
    } else {
        Ok(processed_files)
    }
}

fn files_for_export<'a>(
    group: &'a PhotoGroupInfo,
    export_mode: &str,
) -> Result<Vec<&'a PhotoFileInfo>, String> {
    match export_mode {
        "JPG" => Ok(group.jpg.iter().collect()),
        "RAW" => Ok(group.raw.iter().collect()),
        "BOTH" => {
            let mut files = Vec::new();
            if let Some(ref jpg) = group.jpg {
                files.push(jpg);
            }
            if let Some(ref raw) = group.raw {
                files.push(raw);
            }
            Ok(files)
        }
        _ => Err(format!("Unknown export mode: {}", export_mode)),
    }
}

fn raw_sidecar_should_export(source_path: &Path, include_raw_sidecars: bool, rating: u8) -> bool {
    if !include_raw_sidecars || !is_raw_path(source_path) {
        return false;
    }

    xmp_sidecar_path(source_path).exists() || clamp_rating(rating) > 0
}

fn export_raw_sidecar_to_target(
    source_path: &Path,
    target_path: &Path,
    operation: &str,
    include_raw_sidecars: bool,
    rating: u8,
) -> Result<Option<PathBuf>, String> {
    if !raw_sidecar_should_export(source_path, include_raw_sidecars, rating) {
        return Ok(None);
    }

    let source_sidecar = xmp_sidecar_path(source_path);
    let target_sidecar = xmp_sidecar_path(target_path);
    let copied_existing = source_sidecar.exists();

    if copied_existing && source_sidecar != target_sidecar {
        match operation {
            "MOVE" => fs::rename(&source_sidecar, &target_sidecar)
                .map_err(|e| format!("Failed to move {}: {}", source_sidecar.display(), e))?,
            "COPY" => {
                fs::copy(&source_sidecar, &target_sidecar)
                    .map_err(|e| format!("Failed to copy {}: {}", source_sidecar.display(), e))?;
            }
            _ => return Err(format!("Unknown operation: {}", operation)),
        }
    }

    if clamp_rating(rating) > 0 || !copied_existing {
        write_xmp_sidecar_rating(target_path, rating)?;
    }

    Ok(Some(target_sidecar))
}

fn write_exported_target_rating_metadata(
    source_path: &Path,
    target_path: &Path,
    rating: u8,
    operation: &str,
    include_raw_sidecars: bool,
) -> Result<Vec<PathBuf>, String> {
    let rating = clamp_rating(rating);
    let mut written = Vec::new();

    if is_raw_path(target_path) {
        if let Some(sidecar) = export_raw_sidecar_to_target(
            source_path,
            target_path,
            operation,
            include_raw_sidecars,
            rating,
        )? {
            written.push(sidecar);
        }
    } else if rating > 0 {
        written.push(write_rating_to_path(target_path, rating)?);
    }

    Ok(written)
}

#[tauri::command]
fn export_files_stream(
    groups: Vec<PhotoGroupInfo>,
    export_mode: String,
    operation: String,
    destination_folder: String,
    on_event: Channel<ExportStreamEvent>,
    include_raw_sidecars: Option<bool>,
) -> Result<Vec<String>, String> {
    let dest_path = Path::new(&destination_folder);
    let include_raw_sidecars = include_raw_sidecars.unwrap_or(true);

    if !dest_path.exists() {
        let error = "Destination folder does not exist".to_string();
        send_export_stream_event(
            &on_event,
            export_event(
                "error",
                Some("copying"),
                None,
                None,
                None,
                None,
                Some(error.clone()),
            ),
        );
        return Err(error);
    }

    if !dest_path.is_dir() {
        let error = "Destination path is not a directory".to_string();
        send_export_stream_event(
            &on_event,
            export_event(
                "error",
                Some("copying"),
                None,
                None,
                None,
                None,
                Some(error.clone()),
            ),
        );
        return Err(error);
    }

    let phase = if operation == "MOVE" {
        "moving"
    } else {
        "copying"
    };
    let total = groups
        .iter()
        .filter_map(|group| {
            let files = files_for_export(group, &export_mode).ok()?;
            Some((files, group.rating))
        })
        .map(|(files, rating)| {
            files
                .iter()
                .map(|file| {
                    let source_path = Path::new(&file.path);
                    1 + usize::from(raw_sidecar_should_export(
                        source_path,
                        include_raw_sidecars,
                        rating,
                    ))
                })
                .sum::<usize>()
        })
        .sum::<usize>();
    let mut processed = 0usize;
    let mut processed_files = Vec::new();
    let mut failed_files = Vec::new();

    send_export_stream_event(
        &on_event,
        export_event(
            "progress",
            Some(phase),
            Some(0),
            Some(total),
            None,
            None,
            None,
        ),
    );

    for group in groups {
        let files_to_export = match files_for_export(&group, &export_mode) {
            Ok(files) => files,
            Err(error) => {
                failed_files.push(error);
                continue;
            }
        };

        for file_info in files_to_export {
            let source_path = Path::new(&file_info.path);
            let current = source_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|value| value.to_string())
                .unwrap_or_else(|| file_info.name.clone());

            send_export_stream_event(
                &on_event,
                export_event(
                    "progress",
                    Some(phase),
                    Some(processed),
                    Some(total),
                    Some(current.clone()),
                    None,
                    None,
                ),
            );

            if let Err(error) = validate_photo_file_path(source_path) {
                failed_files.push(error);
                processed += 1;
                continue;
            }

            let Some(file_name) = source_path.file_name().and_then(|n| n.to_str()) else {
                failed_files.push(format!("Invalid file name: {}", file_info.path));
                processed += 1;
                continue;
            };

            let dest_file_path = unique_destination_path(dest_path, file_name);
            let result = match operation.as_str() {
                "COPY" => fs::copy(source_path, &dest_file_path)
                    .map(|_| ())
                    .map_err(|e| format!("Failed to copy {}: {}", file_name, e)),
                "MOVE" => fs::rename(source_path, &dest_file_path)
                    .map_err(|e| format!("Failed to move {}: {}", file_name, e)),
                _ => Err(format!("Unknown operation: {}", operation)),
            };

            let mut file_exported = false;
            match result {
                Ok(_) => {
                    if let Err(error) = write_exported_target_rating_metadata(
                        source_path,
                        &dest_file_path,
                        group.rating,
                        &operation,
                        include_raw_sidecars,
                    ) {
                        failed_files.push(format!(
                            "Failed to write rating metadata to {}: {}",
                            dest_file_path.display(),
                            error
                        ));
                    }
                    processed_files.push(dest_file_path.display().to_string());
                    file_exported = true;
                }
                Err(error) => failed_files.push(error),
            }

            processed += 1;
            if file_exported
                && raw_sidecar_should_export(source_path, include_raw_sidecars, group.rating)
                && is_raw_path(&dest_file_path)
            {
                let target_sidecar_path = xmp_sidecar_path(&dest_file_path);
                let sidecar_name = target_sidecar_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|value| value.to_string());

                if let Some(sidecar_name) = sidecar_name {
                    let sidecar_current = sidecar_name;

                    send_export_stream_event(
                        &on_event,
                        export_event(
                            "progress",
                            Some(phase),
                            Some(processed),
                            Some(total),
                            Some(sidecar_current.clone()),
                            None,
                            None,
                        ),
                    );

                    processed_files.push(target_sidecar_path.display().to_string());

                    processed += 1;
                    send_export_stream_event(
                        &on_event,
                        export_event(
                            "progress",
                            Some(phase),
                            Some(processed),
                            Some(total),
                            Some(sidecar_current),
                            None,
                            None,
                        ),
                    );
                }
            }

            send_export_stream_event(
                &on_event,
                export_event(
                    "progress",
                    Some(phase),
                    Some(processed),
                    Some(total),
                    Some(current),
                    None,
                    None,
                ),
            );
        }
    }

    if !failed_files.is_empty() {
        let error = format!(
            "Export completed with errors:\n{}\n\nSuccessfully processed {} files",
            failed_files.join("\n"),
            processed_files.len()
        );
        send_export_stream_event(
            &on_event,
            export_event(
                "error",
                Some(phase),
                Some(processed),
                Some(total),
                None,
                Some(processed_files.clone()),
                Some(error.clone()),
            ),
        );
        Err(error)
    } else if processed_files.is_empty() {
        let error = "No files were exported".to_string();
        send_export_stream_event(
            &on_event,
            export_event(
                "error",
                Some(phase),
                Some(processed),
                Some(total),
                None,
                None,
                Some(error.clone()),
            ),
        );
        Err(error)
    } else {
        send_export_stream_event(
            &on_event,
            export_event(
                "done",
                Some(phase),
                Some(processed),
                Some(total),
                None,
                Some(processed_files.clone()),
                None,
            ),
        );
        Ok(processed_files)
    }
}

#[tauri::command]
fn write_rating_metadata(groups: Vec<PhotoGroupInfo>, rating: u8) -> Result<Vec<String>, String> {
    let rating = clamp_rating(rating);
    let mut written = Vec::new();
    let mut failed = Vec::new();
    let mut seen_paths = std::collections::HashSet::new();

    for group in groups {
        let mut paths = Vec::new();
        if let Some(jpg) = group.jpg {
            paths.push(jpg.path);
        }
        if let Some(raw) = group.raw {
            paths.push(raw.path);
        }

        for path_string in paths {
            if !seen_paths.insert(path_string.clone()) {
                continue;
            }

            let path = Path::new(&path_string);
            if !path.exists() {
                failed.push(format!("Source file not found: {}", path.display()));
                continue;
            }

            match write_rating_to_path(path, rating) {
                Ok(target) => written.push(target.display().to_string()),
                Err(error) => failed.push(error),
            }
        }
    }

    if !failed.is_empty() {
        Err(format!(
            "Rating metadata completed with errors:\n{}\n\nSuccessfully wrote {} files",
            failed.join("\n"),
            written.len()
        ))
    } else {
        Ok(written)
    }
}

#[tauri::command]
fn write_rendered_export(
    files: Vec<RenderedExportFile>,
    destination_folder: String,
) -> Result<Vec<String>, String> {
    let dest_path = Path::new(&destination_folder);

    if !dest_path.exists() {
        return Err("Destination folder does not exist".to_string());
    }

    if !dest_path.is_dir() {
        return Err("Destination path is not a directory".to_string());
    }

    let mut processed_files = Vec::new();
    let mut failed_files = Vec::new();
    let base64_engine = base64::engine::general_purpose::STANDARD;

    for file in files {
        let payload = file
            .data_url
            .split_once(',')
            .map(|(_, data)| data)
            .unwrap_or(file.data_url.as_str());

        match base64_engine.decode(payload) {
            Ok(bytes) => {
                let dest_file_path = unique_destination_path(dest_path, &file.file_name);
                match fs::write(&dest_file_path, bytes) {
                    Ok(_) => {
                        processed_files.push(dest_file_path.display().to_string());
                        match write_rendered_export_metadata(
                            &dest_file_path,
                            file.rating,
                            file.metadata_mode.as_deref(),
                            file.metadata_source_path.as_deref(),
                        ) {
                            Ok(metadata_files) => processed_files.extend(metadata_files),
                            Err(e) => failed_files.push(format!(
                                "Failed to write metadata for {}: {}",
                                dest_file_path.display(),
                                e
                            )),
                        }
                    }
                    Err(e) => failed_files.push(format!(
                        "Failed to write {}: {}",
                        dest_file_path.display(),
                        e
                    )),
                }
            }
            Err(e) => failed_files.push(format!("Failed to decode {}: {}", file.file_name, e)),
        }
    }

    if !failed_files.is_empty() {
        Err(format!(
            "Rendered export completed with errors:\n{}\n\nSuccessfully wrote {} files",
            failed_files.join("\n"),
            processed_files.len()
        ))
    } else if processed_files.is_empty() {
        Err("No rendered files were exported".to_string())
    } else {
        Ok(processed_files)
    }
}

#[tauri::command]
fn write_rendered_export_stream(
    files: Vec<RenderedExportFile>,
    destination_folder: String,
    on_event: Channel<ExportStreamEvent>,
) -> Result<Vec<String>, String> {
    let dest_path = Path::new(&destination_folder);

    if !dest_path.exists() {
        let error = "Destination folder does not exist".to_string();
        send_export_stream_event(
            &on_event,
            export_event(
                "error",
                Some("writing"),
                None,
                None,
                None,
                None,
                Some(error.clone()),
            ),
        );
        return Err(error);
    }

    if !dest_path.is_dir() {
        let error = "Destination path is not a directory".to_string();
        send_export_stream_event(
            &on_event,
            export_event(
                "error",
                Some("writing"),
                None,
                None,
                None,
                None,
                Some(error.clone()),
            ),
        );
        return Err(error);
    }

    let total = files.len();
    let mut processed_files = Vec::new();
    let mut failed_files = Vec::new();
    let base64_engine = base64::engine::general_purpose::STANDARD;

    send_export_stream_event(
        &on_event,
        export_event(
            "progress",
            Some("writing"),
            Some(0),
            Some(total),
            None,
            None,
            None,
        ),
    );

    for (index, file) in files.into_iter().enumerate() {
        let current = file.file_name.clone();
        send_export_stream_event(
            &on_event,
            export_event(
                "progress",
                Some("writing"),
                Some(index),
                Some(total),
                Some(current.clone()),
                None,
                None,
            ),
        );

        let payload = file
            .data_url
            .split_once(',')
            .map(|(_, data)| data)
            .unwrap_or(file.data_url.as_str());

        match base64_engine.decode(payload) {
            Ok(bytes) => {
                let dest_file_path = unique_destination_path(dest_path, &file.file_name);
                match fs::write(&dest_file_path, bytes) {
                    Ok(_) => {
                        processed_files.push(dest_file_path.display().to_string());
                        match write_rendered_export_metadata(
                            &dest_file_path,
                            file.rating,
                            file.metadata_mode.as_deref(),
                            file.metadata_source_path.as_deref(),
                        ) {
                            Ok(metadata_files) => processed_files.extend(metadata_files),
                            Err(e) => failed_files.push(format!(
                                "Failed to write metadata for {}: {}",
                                dest_file_path.display(),
                                e
                            )),
                        }
                    }
                    Err(e) => failed_files.push(format!(
                        "Failed to write {}: {}",
                        dest_file_path.display(),
                        e
                    )),
                }
            }
            Err(e) => failed_files.push(format!("Failed to decode {}: {}", file.file_name, e)),
        }

        send_export_stream_event(
            &on_event,
            export_event(
                "progress",
                Some("writing"),
                Some(index + 1),
                Some(total),
                Some(current),
                None,
                None,
            ),
        );
    }

    if !failed_files.is_empty() {
        let error = format!(
            "Rendered export completed with errors:\n{}\n\nSuccessfully wrote {} files",
            failed_files.join("\n"),
            processed_files.len()
        );
        send_export_stream_event(
            &on_event,
            export_event(
                "error",
                Some("writing"),
                Some(processed_files.len()),
                Some(total),
                None,
                Some(processed_files.clone()),
                Some(error.clone()),
            ),
        );
        Err(error)
    } else if processed_files.is_empty() {
        let error = "No rendered files were exported".to_string();
        send_export_stream_event(
            &on_event,
            export_event(
                "error",
                Some("writing"),
                Some(0),
                Some(total),
                None,
                None,
                Some(error.clone()),
            ),
        );
        Err(error)
    } else {
        send_export_stream_event(
            &on_event,
            export_event(
                "done",
                Some("writing"),
                Some(total),
                Some(total),
                None,
                Some(processed_files.clone()),
                None,
            ),
        );
        Ok(processed_files)
    }
}

fn candidate_lightroom_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            paths.push(
                PathBuf::from(&program_files)
                    .join("Adobe")
                    .join("Adobe Lightroom Classic")
                    .join("Lightroom.exe"),
            );
            paths.push(
                PathBuf::from(&program_files)
                    .join("Adobe")
                    .join("Adobe Lightroom")
                    .join("Lightroom.exe"),
            );
        }
        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            paths.push(
                PathBuf::from(&program_files_x86)
                    .join("Adobe")
                    .join("Adobe Lightroom Classic")
                    .join("Lightroom.exe"),
            );
        }
        paths.extend(detect_lightroom_paths_from_registry());
    }

    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from(
            "/Applications/Adobe Lightroom Classic/Adobe Lightroom Classic.app",
        ));
        paths.push(PathBuf::from("/Applications/Adobe Lightroom Classic.app"));
    }

    paths
}

#[cfg(target_os = "windows")]
fn detect_lightroom_paths_from_registry() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let script = r#"
$roots = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
Get-ChildItem -Path $roots -ErrorAction SilentlyContinue |
  ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } |
  Where-Object { $_.DisplayName -match 'Adobe Lightroom Classic' } |
  ForEach-Object { if ($_.InstallLocation) { $_.InstallLocation } }
"#;
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output();

    let Ok(output) = output else {
        return paths;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let install_location = line.trim();
        if install_location.is_empty() {
            continue;
        }
        let root = PathBuf::from(install_location);
        paths.push(root.join("Adobe Lightroom Classic").join("Lightroom.exe"));
        paths.push(root.join("Lightroom.exe"));
    }
    paths
}

fn detect_lightroom_classic_path() -> Option<PathBuf> {
    let mut seen = HashSet::new();
    candidate_lightroom_paths()
        .into_iter()
        .find(|path| seen.insert(path.clone()) && is_lightroom_classic_executable(path))
}

fn is_lightroom_classic_executable(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }

    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();

    #[cfg(target_os = "windows")]
    {
        path.is_file() && file_name == "lightroom.exe"
    }

    #[cfg(target_os = "macos")]
    {
        file_name.contains("lightroom classic")
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        path.is_file() && file_name.contains("lightroom")
    }
}

#[tauri::command]
fn detect_lightroom_classic() -> Result<Option<String>, String> {
    Ok(detect_lightroom_classic_path().map(|path| path.display().to_string()))
}

#[tauri::command]
fn resolve_lightroom_classic_path(executable_path: Option<String>) -> Option<PathBuf> {
    let manual_path = executable_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| is_lightroom_classic_executable(path));
    manual_path.or_else(detect_lightroom_classic_path)
}

#[tauri::command]
fn launch_lightroom_classic(executable_path: Option<String>) -> Result<Option<String>, String> {
    let detected_path = resolve_lightroom_classic_path(executable_path);

    #[cfg(target_os = "macos")]
    {
        if let Some(path) = detected_path {
            Command::new("open")
                .arg(path)
                .spawn()
                .map_err(|e| format!("Failed to launch Lightroom Classic: {}", e))?;
            return Ok(Some(path.display().to_string()));
        }
        Command::new("open")
            .args(["-a", "Adobe Lightroom Classic"])
            .spawn()
            .map_err(|e| format!("Failed to launch Lightroom Classic: {}", e))?;
        return Ok(None);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let Some(path) = detected_path else {
            return Ok(None);
        };
        Command::new(&path)
            .spawn()
            .map_err(|e| format!("Failed to launch Lightroom Classic: {}", e))?;
        Ok(Some(path.display().to_string()))
    }
}

fn files_for_lightroom_import(group: &PhotoGroupInfo) -> Vec<&PhotoFileInfo> {
    let mut files = Vec::new();
    if let Some(jpg) = &group.jpg {
        files.push(jpg);
    }
    if let Some(raw) = &group.raw {
        files.push(raw);
    }
    files
}

fn file_for_lightroom_catalog(group: &PhotoGroupInfo) -> Option<&PhotoFileInfo> {
    group.raw.as_ref().or(group.jpg.as_ref())
}

fn files_for_lightroom_command_line(groups: &[PhotoGroupInfo]) -> (Vec<String>, Vec<String>) {
    let mut import_files = Vec::new();
    let mut warnings = Vec::new();
    let mut seen = HashSet::new();

    for group in groups {
        for file in files_for_lightroom_import(group) {
            let path = Path::new(&file.path);
            if !path.exists() {
                warnings.push(format!("Source file not found: {}", file.path));
                continue;
            }
            if clamp_rating(group.rating) > 0 {
                if let Err(error) = write_rating_to_path(path, group.rating) {
                    warnings.push(format!(
                        "Failed to write rating metadata for {}: {}",
                        path.display(),
                        error
                    ));
                }
            }
        }

        let Some(catalog_file) = file_for_lightroom_catalog(group) else {
            warnings.push(format!("No RAW or JPG file is available for {}", group.id));
            continue;
        };
        let catalog_path = Path::new(&catalog_file.path);
        if !catalog_path.exists() {
            warnings.push(format!(
                "Lightroom import file not found: {}",
                catalog_file.path
            ));
            continue;
        }
        if seen.insert(catalog_file.path.clone()) {
            import_files.push(catalog_file.path.clone());
        }
    }

    (import_files, warnings)
}

#[tauri::command]
fn open_lightroom_source_folder(
    groups: Vec<PhotoGroupInfo>,
    executable_path: Option<String>,
) -> Result<LightroomSourceFolderResult, String> {
    let (files, mut warnings) = files_for_lightroom_command_line(&groups);
    if files.is_empty() {
        return Err("No files are available for Lightroom import".to_string());
    }

    let source_folder = files
        .first()
        .and_then(|file| Path::new(file).parent())
        .map(Path::to_path_buf)
        .ok_or_else(|| "Cannot resolve Lightroom source folder".to_string())?;
    let resolved_path = resolve_lightroom_classic_path(executable_path);

    #[cfg(target_os = "macos")]
    let launched = {
        let mut command = Command::new("open");
        if let Some(path) = &resolved_path {
            command.arg(path);
        } else {
            command.args(["-a", "Adobe Lightroom Classic"]);
        }
        command.arg("--args");
        command.arg(&source_folder);
        match command.spawn() {
            Ok(_) => true,
            Err(error) => {
                warnings.push(format!("Failed to launch Lightroom Classic: {}", error));
                false
            }
        }
    };

    #[cfg(not(target_os = "macos"))]
    let launched = {
        if let Some(path) = &resolved_path {
            let mut command = Command::new(path);
            command.arg(&source_folder);
            match command.spawn() {
                Ok(_) => true,
                Err(error) => {
                    warnings.push(format!("Failed to launch Lightroom Classic: {}", error));
                    false
                }
            }
        } else {
            warnings.push("Lightroom Classic was not detected. Open the selected photos folder from Lightroom.".to_string());
            false
        }
    };

    Ok(LightroomSourceFolderResult {
        source_folder: source_folder.display().to_string(),
        files,
        launched,
        executable_path: resolved_path.map(|path| path.display().to_string()),
        warnings,
    })
}

#[tauri::command]
fn import_to_lightroom_classic(
    groups: Vec<PhotoGroupInfo>,
    executable_path: Option<String>,
) -> Result<LightroomImportResult, String> {
    let resolved_path = resolve_lightroom_classic_path(executable_path);
    let (import_files, failed) = files_for_lightroom_command_line(&groups);

    if import_files.is_empty() {
        return Err("No files are available for Lightroom import".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if let Some(path) = &resolved_path {
            command.arg("-a").arg(path);
        } else {
            command.args(["-a", "Adobe Lightroom Classic"]);
        }
        command.arg("--args");
        if let Some(folder) = import_files
            .first()
            .and_then(|file| Path::new(file).parent())
        {
            command.arg(folder);
        }
        command
            .spawn()
            .map_err(|e| format!("Failed to launch Lightroom Classic: {}", e))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let Some(path) = &resolved_path else {
            return Ok(LightroomImportResult {
                files: import_files,
                launched: false,
                executable_path: None,
                warnings: failed,
            });
        };
        let mut command = Command::new(&path);
        if let Some(folder) = import_files
            .first()
            .and_then(|file| Path::new(file).parent())
        {
            command.arg(folder);
        }
        command
            .spawn()
            .map_err(|e| format!("Failed to launch Lightroom Classic: {}", e))?;
    }

    Ok(LightroomImportResult {
        files: import_files,
        launched: true,
        executable_path: resolved_path.map(|path| path.display().to_string()),
        warnings: failed,
    })
}

#[tauri::command]
fn export_people_clusters_stream(
    clusters: Vec<PeopleExportClusterInput>,
    destination_folder: String,
    on_event: Channel<ExportStreamEvent>,
) -> Result<Vec<String>, String> {
    let dest_path = Path::new(&destination_folder);
    if !dest_path.exists() {
        let error = "Destination folder does not exist".to_string();
        send_export_stream_event(
            &on_event,
            export_event(
                "error",
                Some("copying"),
                None,
                None,
                None,
                None,
                Some(error.clone()),
            ),
        );
        return Err(error);
    }

    if !dest_path.is_dir() {
        let error = "Destination path is not a directory".to_string();
        send_export_stream_event(
            &on_event,
            export_event(
                "error",
                Some("copying"),
                None,
                None,
                None,
                None,
                Some(error.clone()),
            ),
        );
        return Err(error);
    }

    let total = clusters
        .iter()
        .map(|cluster| cluster.photo_paths.len())
        .sum::<usize>();
    let mut processed = 0usize;
    let mut processed_files = Vec::new();
    let mut failed_files = Vec::new();

    send_export_stream_event(
        &on_event,
        export_event(
            "progress",
            Some("copying"),
            Some(0),
            Some(total),
            None,
            None,
            None,
        ),
    );

    for cluster in clusters {
        let cluster_dir_name = sanitize_path_segment(&cluster.display_name);
        let cluster_dir = unique_cluster_destination(dest_path, &cluster_dir_name);
        if let Err(error) = fs::create_dir_all(&cluster_dir) {
            failed_files.push(format!(
                "Failed to create {}: {}",
                cluster_dir.display(),
                error
            ));
            continue;
        }

        for photo_path in cluster.photo_paths {
            let source_path = Path::new(&photo_path);
            let current = source_path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|value| value.to_string())
                .unwrap_or_else(|| photo_path.clone());

            send_export_stream_event(
                &on_event,
                export_event(
                    "progress",
                    Some("copying"),
                    Some(processed),
                    Some(total),
                    Some(current.clone()),
                    None,
                    None,
                ),
            );

            if !source_path.exists() || !is_jpeg_path(source_path) {
                failed_files.push(format!("Unsupported or missing JPG source: {}", photo_path));
                processed += 1;
                continue;
            }

            let Some(file_name) = source_path.file_name().and_then(|name| name.to_str()) else {
                failed_files.push(format!("Invalid file name: {}", photo_path));
                processed += 1;
                continue;
            };

            let destination = unique_destination_path(&cluster_dir, file_name);
            match fs::copy(source_path, &destination) {
                Ok(_) => processed_files.push(destination.display().to_string()),
                Err(error) => failed_files.push(format!(
                    "Failed to copy {}: {}",
                    source_path.display(),
                    error
                )),
            }

            processed += 1;
            send_export_stream_event(
                &on_event,
                export_event(
                    "progress",
                    Some("copying"),
                    Some(processed),
                    Some(total),
                    Some(current),
                    None,
                    None,
                ),
            );
        }
    }

    if !failed_files.is_empty() {
        let error = format!(
            "People export completed with errors:\n{}\n\nSuccessfully processed {} files",
            failed_files.join("\n"),
            processed_files.len()
        );
        send_export_stream_event(
            &on_event,
            export_event(
                "error",
                Some("copying"),
                Some(processed),
                Some(total),
                None,
                Some(processed_files.clone()),
                Some(error.clone()),
            ),
        );
        Err(error)
    } else if processed_files.is_empty() {
        let error = "No person photos were exported".to_string();
        send_export_stream_event(
            &on_event,
            export_event(
                "error",
                Some("copying"),
                Some(processed),
                Some(total),
                None,
                None,
                Some(error.clone()),
            ),
        );
        Err(error)
    } else {
        send_export_stream_event(
            &on_event,
            export_event(
                "done",
                Some("copying"),
                Some(processed),
                Some(total),
                None,
                Some(processed_files.clone()),
                None,
            ),
        );
        Ok(processed_files)
    }
}

#[tauri::command]
async fn show_main_window(window: tauri::Window) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init());

    // Pro inference state holds the loaded native ONNX session across commands.
    #[cfg(feature = "pro")]
    let builder = builder.manage(pro_infer::ProInferState::default());

    #[cfg(feature = "pro")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        greet,
        read_exif,
        scan_folder,
        scan_files,
        enrich_photo_metadata,
        import_folder_stream,
        import_files_stream,
        extract_raw_embedded_preview,
        get_jpeg_thumbnail,
        detect_rawtherapee_cli,
        validate_raw_engine,
        get_raw_monitor_cache_entry,
        render_raw_monitor_cache_stream,
        cancel_raw_monitor_cache_render,
        import_monitor_lut,
        read_monitor_lut,
        clear_raw_monitor_cache,
        get_raw_monitor_cache_size,
        cleanup_raw_monitor_cache_lru,
        move_to_trash,
        delete_files_permanently,
        export_files,
        export_files_stream,
        write_rating_metadata,
        write_rendered_export,
        write_rendered_export_stream,
        detect_lightroom_classic,
        launch_lightroom_classic,
        import_to_lightroom_classic,
        open_lightroom_source_folder,
        export_people_clusters_stream,
        evaluate_ai_analysis,
        show_main_window,
        pro_infer::pro_infer_init,
        pro_infer::pro_infer_batch
    ]);

    #[cfg(not(feature = "pro"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        greet,
        read_exif,
        scan_folder,
        scan_files,
        enrich_photo_metadata,
        import_folder_stream,
        import_files_stream,
        extract_raw_embedded_preview,
        get_jpeg_thumbnail,
        move_to_trash,
        delete_files_permanently,
        export_files,
        export_files_stream,
        write_rating_metadata,
        write_rendered_export,
        write_rendered_export_stream,
        detect_lightroom_classic,
        launch_lightroom_classic,
        import_to_lightroom_classic,
        open_lightroom_source_folder,
        export_people_clusters_stream,
        evaluate_ai_analysis,
        show_main_window
    ]);

    builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri::Manager;
                let window = app.get_webview_window("main").unwrap();
                if let Err(error) = window.set_background_color(Some(Color(16, 17, 21, 255))) {
                    eprintln!("Failed to set startup background color: {error}");
                }

                // On macOS, enable native decorations for traffic light buttons
                // On Windows/Linux, disable decorations for custom title bar
                #[cfg(target_os = "macos")]
                {
                    window.set_decorations(true).unwrap();
                }

                #[cfg(not(target_os = "macos"))]
                {
                    window.set_decorations(false).unwrap();
                }
                // Window will be shown after frontend is ready via show_main_window command
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("framecull-{name}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn raw_copy_exports_target_sidecar_with_rating() {
        let dir = temp_test_dir("raw-sidecar");
        let source = dir.join("source.NEF");
        let target = dir.join("target.NEF");
        fs::write(&source, b"raw").unwrap();
        fs::write(&target, b"raw").unwrap();

        let written = export_raw_sidecar_to_target(&source, &target, "COPY", true, 4)
            .unwrap()
            .unwrap();
        let text = fs::read_to_string(&written).unwrap();
        assert_eq!(written, dir.join("target.xmp"));
        assert!(text.contains("xmp:Rating=\"4\""));
        assert!(!dir.join("source.xmp").exists());

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn raw_copy_preserves_existing_sidecar_and_updates_rating() {
        let dir = temp_test_dir("raw-existing-sidecar");
        let source = dir.join("source.NEF");
        let target = dir.join("target.NEF");
        let source_sidecar = dir.join("source.xmp");
        fs::write(&source, b"raw").unwrap();
        fs::write(&target, b"raw").unwrap();
        fs::write(&source_sidecar, build_minimal_xmp(2)).unwrap();

        let written = export_raw_sidecar_to_target(&source, &target, "COPY", true, 5)
            .unwrap()
            .unwrap();
        let target_text = fs::read_to_string(&written).unwrap();
        let source_text = fs::read_to_string(&source_sidecar).unwrap();
        assert_eq!(written, dir.join("target.xmp"));
        assert!(target_text.contains("xmp:Rating=\"5\""));
        assert!(source_text.contains("xmp:Rating=\"2\""));

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn jpeg_rating_is_embedded_and_read_back() {
        let dir = temp_test_dir("jpeg-rating");
        let path = dir.join("rated.jpg");
        fs::write(&path, [0xFF, 0xD8, 0xFF, 0xD9]).unwrap();

        let written = write_rating_to_path(&path, 5).unwrap();
        assert_eq!(written, path);
        assert_eq!(read_rating_from_path(&path), Some(5));
        let bytes = fs::read(&path).unwrap();
        assert!(find_jpeg_xmp_packet(&bytes).is_some());

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn exported_target_jpeg_gets_embedded_rating() {
        let dir = temp_test_dir("exported-jpeg-rating");
        let source = dir.join("source.jpg");
        let target = dir.join("target.jpg");
        fs::write(&source, [0xFF, 0xD8, 0xFF, 0xD9]).unwrap();
        fs::write(&target, [0xFF, 0xD8, 0xFF, 0xD9]).unwrap();

        let written =
            write_exported_target_rating_metadata(&source, &target, 3, "COPY", true).unwrap();
        assert_eq!(written, vec![target.clone()]);
        assert_eq!(read_rating_from_path(&target), Some(3));
        assert_eq!(read_rating_from_path(&source), None);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rendered_jpeg_export_metadata_writes_rating() {
        let dir = temp_test_dir("rendered-jpeg-rating");
        let target = dir.join("rendered.jpg");
        fs::write(&target, [0xFF, 0xD8, 0xFF, 0xD9]).unwrap();

        let written =
            write_rendered_export_metadata(&target, Some(4), Some("RATING_ONLY"), None).unwrap();
        assert_eq!(written, vec![target.display().to_string()]);
        assert_eq!(read_rating_from_path(&target), Some(4));

        fs::remove_dir_all(dir).unwrap();
    }

    fn test_jpeg_bytes(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([
                ((x * 17 + y * 3) % 256) as u8,
                ((x * 5 + y * 29) % 256) as u8,
                ((x * 11 + y * 7) % 256) as u8,
            ])
        });
        let mut bytes = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 82);
        encoder.encode_image(&image).unwrap();
        bytes
    }

    #[test]
    fn raw_preview_prefers_displayable_tiff_jpeg_over_larger_lossless_segment() {
        let preview = test_jpeg_bytes(320, 240);
        let preview_offset = 128usize;
        let lossless_offset = preview_offset + preview.len() + 32;
        let lossless_length = preview.len() + 4096;
        let mut bytes = vec![0u8; lossless_offset + lossless_length + 32];

        bytes[0..2].copy_from_slice(b"II");
        bytes[2..4].copy_from_slice(&42u16.to_le_bytes());
        bytes[4..8].copy_from_slice(&8u32.to_le_bytes());
        bytes[8..10].copy_from_slice(&2u16.to_le_bytes());

        let first_entry = 10usize;
        bytes[first_entry..first_entry + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        bytes[first_entry + 2..first_entry + 4].copy_from_slice(&4u16.to_le_bytes());
        bytes[first_entry + 4..first_entry + 8].copy_from_slice(&1u32.to_le_bytes());
        bytes[first_entry + 8..first_entry + 12]
            .copy_from_slice(&(preview_offset as u32).to_le_bytes());

        let second_entry = first_entry + 12;
        bytes[second_entry..second_entry + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        bytes[second_entry + 2..second_entry + 4].copy_from_slice(&4u16.to_le_bytes());
        bytes[second_entry + 4..second_entry + 8].copy_from_slice(&1u32.to_le_bytes());
        bytes[second_entry + 8..second_entry + 12]
            .copy_from_slice(&(preview.len() as u32).to_le_bytes());

        bytes[second_entry + 12..second_entry + 16].copy_from_slice(&0u32.to_le_bytes());
        bytes[preview_offset..preview_offset + preview.len()].copy_from_slice(&preview);

        bytes[lossless_offset] = 0xFF;
        bytes[lossless_offset + 1] = 0xD8;
        bytes[lossless_offset + 2] = 0xFF;
        bytes[lossless_offset + 3] = 0xC4;
        bytes[lossless_offset + lossless_length - 2] = 0xFF;
        bytes[lossless_offset + lossless_length - 1] = 0xD9;

        assert_eq!(
            find_largest_embedded_jpeg(&bytes),
            Some((preview_offset, preview.len())),
        );
    }

    #[test]
    fn uppercase_cr2_imports_as_raw_only() {
        let dir = temp_test_dir("cr2-import");
        let raw = dir.join("2K9A9785.CR2");
        fs::write(&raw, b"canon raw").unwrap();

        let groups = collect_photo_groups_from_paths(vec![raw.clone()], |_, _, _| {});

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, "2K9A9785");
        assert_eq!(groups[0].status, "RAW_ONLY");
        assert!(groups[0].jpg.is_none());
        assert_eq!(groups[0].raw.as_ref().unwrap().extension, "CR2");
        assert_eq!(groups[0].raw.as_ref().unwrap().path, raw.to_string_lossy());

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn recursive_folder_scan_finds_nested_cr2_files() {
        let dir = temp_test_dir("recursive-cr2-import");
        let nested = dir.join("nested").join("canon");
        fs::create_dir_all(&nested).unwrap();
        let raw = nested.join("2K9A9785.CR2");
        fs::write(&raw, b"canon raw").unwrap();

        let files = collect_files_recursive(&dir).unwrap();
        let groups = collect_photo_groups_from_paths(files, |_, _, _| {});

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, "2K9A9785");
        assert_eq!(groups[0].status, "RAW_ONLY");
        assert_eq!(groups[0].raw.as_ref().unwrap().extension, "CR2");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lightroom_catalog_file_prefers_raw() {
        let group = PhotoGroupInfo {
            id: "g1".to_string(),
            jpg: Some(PhotoFileInfo {
                name: "a.jpg".to_string(),
                extension: "jpg".to_string(),
                path: "C:\\photos\\a.jpg".to_string(),
                size: 1,
                modified_ms: None,
            }),
            raw: Some(PhotoFileInfo {
                name: "a.nef".to_string(),
                extension: "nef".to_string(),
                path: "C:\\photos\\a.nef".to_string(),
                size: 2,
                modified_ms: None,
            }),
            status: "UNDECIDED".to_string(),
            rating: 4,
            exif: None,
        };

        let selected = file_for_lightroom_catalog(&group).unwrap();
        assert_eq!(selected.path, "C:\\photos\\a.nef");
    }

    #[test]
    fn lightroom_command_line_uses_original_raw_path_and_writes_ratings() {
        let dir = temp_test_dir("lightroom-command-line");
        let jpg = dir.join("a.jpg");
        let raw = dir.join("a.nef");
        fs::write(&jpg, [0xFF, 0xD8, 0xFF, 0xD9]).unwrap();
        fs::write(&raw, b"raw").unwrap();

        let group = PhotoGroupInfo {
            id: "g1".to_string(),
            jpg: Some(PhotoFileInfo {
                name: "a.jpg".to_string(),
                extension: "jpg".to_string(),
                path: jpg.display().to_string(),
                size: 4,
                modified_ms: None,
            }),
            raw: Some(PhotoFileInfo {
                name: "a.nef".to_string(),
                extension: "nef".to_string(),
                path: raw.display().to_string(),
                size: 3,
                modified_ms: None,
            }),
            status: "UNDECIDED".to_string(),
            rating: 4,
            exif: None,
        };

        let (files, warnings) = files_for_lightroom_command_line(&[group]);
        assert!(warnings.is_empty());
        assert_eq!(files, vec![raw.display().to_string()]);
        assert_eq!(read_rating_from_path(&jpg), Some(4));
        assert_eq!(read_xmp_sidecar_rating(&raw), Some(4));

        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(feature = "pro")]
    #[test]
    fn raw_monitor_cache_key_changes_with_engine_version() {
        let dir = temp_test_dir("raw-monitor-cache-key");
        let raw = dir.join("a.CR2");
        fs::write(&raw, b"canon raw").unwrap();

        let first =
            raw_monitor_cache_file_name(&raw, "RawTherapee 5.12", RAW_MONITOR_PROFILE_BALANCED)
                .unwrap();
        let second =
            raw_monitor_cache_file_name(&raw, "RawTherapee 5.13", RAW_MONITOR_PROFILE_BALANCED)
                .unwrap();

        assert_ne!(first, second);
        assert!(first.ends_with(".jpg"));

        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(feature = "pro")]
    #[test]
    fn raw_monitor_cache_key_changes_with_profile() {
        let dir = temp_test_dir("raw-monitor-cache-profile-key");
        let raw = dir.join("a.CR2");
        fs::write(&raw, b"canon raw").unwrap();

        let balanced =
            raw_monitor_cache_file_name(&raw, "RawTherapee 5.12", RAW_MONITOR_PROFILE_BALANCED)
                .unwrap();
        let auto_exposure = raw_monitor_cache_file_name(
            &raw,
            "RawTherapee 5.12",
            RAW_MONITOR_PROFILE_AUTO_EXPOSURE,
        )
        .unwrap();

        assert_ne!(balanced, auto_exposure);

        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(feature = "pro")]
    #[test]
    fn raw_monitor_cache_status_reads_profile_metadata() {
        let dir = temp_test_dir("raw-monitor-cache-metadata");
        let cache = dir.join("cache.jpg");
        fs::write(&cache, b"cached jpeg placeholder").unwrap();

        write_raw_monitor_cache_metadata(
            &cache,
            RAW_MONITOR_PROFILE_AUTO_EXPOSURE,
            "embeddedFallback",
            true,
        )
        .unwrap();

        let status = raw_monitor_cache_status(&cache);
        assert_eq!(status.source, "embeddedFallback");
        assert!(status.fallback);

        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(feature = "pro")]
    #[test]
    fn raw_monitor_recent_failure_respects_cooldown() {
        let mut table = HashMap::new();
        table.insert(
            "nef-cache-key".to_string(),
            RawMonitorFailureRecord {
                failed_at_ms: 10_000,
                error: "decode failed".to_string(),
            },
        );

        assert!(raw_monitor_recent_failure(&table, "nef-cache-key", 10_000 + 60_000).is_some());

        let cooled_down_at =
            10_000 + (RAW_MONITOR_FAILURE_RETRY_COOLDOWN_SECS * 1000) + 1;
        assert!(raw_monitor_recent_failure(&table, "nef-cache-key", cooled_down_at).is_none());
        assert!(raw_monitor_recent_failure(&table, "missing-key", cooled_down_at).is_none());
    }

    #[cfg(feature = "pro")]
    #[test]
    fn raw_monitor_pp3_contains_monitor_defaults() {
        let pp3 = raw_monitor_pp3_content(RAW_MONITOR_PROFILE_BALANCED);

        assert!(pp3.contains("[Exposure]"));
        assert!(pp3.contains("Auto=false"));
        assert!(pp3.contains("HighlightCompr=25"));
        assert!(pp3.contains(&format!("Width={}", RAW_MONITOR_MAX_EDGE)));
        assert!(pp3.contains("OutputProfile=RTv4_sRGB"));
    }

    #[cfg(feature = "pro")]
    #[test]
    fn raw_monitor_auto_exposure_pp3_contains_auto_profile() {
        let pp3 = raw_monitor_pp3_content(RAW_MONITOR_PROFILE_AUTO_EXPOSURE);

        assert!(pp3.contains("Auto=true"));
        assert!(pp3.contains("Brightness=8"));
        assert!(pp3.contains("HighlightCompr=90"));
        assert!(pp3.contains("ShadowCompr=55"));
        assert!(pp3.contains("OutputProfile=RTv4_sRGB"));
    }

    #[cfg(feature = "pro")]
    #[test]
    fn raw_engine_result_marks_bundled_version_and_source() {
        let result = raw_engine_result(
            true,
            Some("rawtherapee-cli.exe".to_string()),
            Some("RawTherapee, version 5.12".to_string()),
            Some("BUNDLED"),
            Some("ok".to_string()),
        );

        assert!(result.ok);
        assert_eq!(result.engine_source.as_deref(), Some("BUNDLED"));
        assert_eq!(
            result.bundled_engine_version.as_deref(),
            Some(RAWTHERAPEE_BUNDLED_VERSION)
        );
    }

    #[cfg(all(feature = "pro", target_os = "windows"))]
    fn fake_rawtherapee_cli(dir: &Path, writes_valid_jpeg: bool) -> PathBuf {
        use base64::Engine as _;

        let cli_path = dir.join("rawtherapee-cli.cmd");
        let ps_path = dir.join("fake-rawtherapee.ps1");
        let output_command = if writes_valid_jpeg {
            let jpeg_b64 =
                base64::engine::general_purpose::STANDARD.encode(test_jpeg_bytes(64, 48));
            format!(
                "$jpegB64 = '{}'\r\n[IO.File]::WriteAllBytes($out, [Convert]::FromBase64String($jpegB64))\r\n",
                jpeg_b64
            )
        } else {
            "Set-Content -LiteralPath $out -Value 'not-a-jpeg'\r\n".to_string()
        };
        let ps_script = format!(
            r#"$rest = $args
if ($rest.Count -gt 0 -and $rest[0] -eq '-v') {{
  Write-Output 'RawTherapee, version 5.12-test'
  exit 0
}}
$out = $null
$pp3 = $null
$raw = $null
$quality = $false
$overwrite = $false
for ($i = 0; $i -lt $rest.Count; $i++) {{
  switch ($rest[$i]) {{
    '-o' {{ $i++; $out = $rest[$i]; continue }}
    '-p' {{ $i++; $pp3 = $rest[$i]; continue }}
    '-j{quality}' {{ $quality = $true; continue }}
    '-Y' {{ $overwrite = $true; continue }}
    '-c' {{ $i++; $raw = $rest[$i]; continue }}
  }}
}}
if (-not $out) {{ exit 5 }}
if (-not $pp3) {{ exit 6 }}
if (-not $raw) {{ exit 7 }}
if (-not $quality) {{ exit 8 }}
if (-not $overwrite) {{ exit 9 }}
if (-not (Test-Path -LiteralPath $pp3)) {{ exit 10 }}
if (-not (Test-Path -LiteralPath $raw)) {{ exit 11 }}
{output_command}exit $LASTEXITCODE
"#,
            quality = RAW_MONITOR_JPEG_QUALITY,
            output_command = output_command
        );
        fs::write(&ps_path, ps_script).unwrap();
        fs::write(
            &cli_path,
            "@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0fake-rawtherapee.ps1\" %*\r\nexit /b %ERRORLEVEL%\r\n",
        )
        .unwrap();
        cli_path
    }

    #[cfg(all(feature = "pro", target_os = "windows"))]
    #[test]
    fn raw_monitor_render_invokes_cli_and_writes_valid_jpeg() {
        let dir = temp_test_dir("raw-monitor-render");
        let engine = fake_rawtherapee_cli(&dir, true);
        let raw = dir.join("source.CR2");
        let pp3 = dir.join("FrameCull_Monitor_v1.pp3");
        let cache = dir.join("cache.jpg");
        fs::write(&raw, b"canon raw").unwrap();
        fs::write(&pp3, raw_monitor_pp3_content(RAW_MONITOR_PROFILE_BALANCED)).unwrap();

        render_raw_monitor_cache_file(&engine, &pp3, &raw, &cache, RAW_MONITOR_PROFILE_BALANCED)
            .unwrap();

        assert!(cache.is_file());
        assert!(image::open(&cache).is_ok());

        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(all(feature = "pro", target_os = "windows"))]
    #[test]
    fn raw_monitor_render_rejects_unreadable_cli_output() {
        let dir = temp_test_dir("raw-monitor-bad-output");
        let engine = fake_rawtherapee_cli(&dir, false);
        let raw = dir.join("source.CR2");
        let pp3 = dir.join("FrameCull_Monitor_v1.pp3");
        let cache = dir.join("cache.jpg");
        fs::write(&raw, b"canon raw").unwrap();
        fs::write(&pp3, raw_monitor_pp3_content(RAW_MONITOR_PROFILE_BALANCED)).unwrap();

        let error = render_raw_monitor_cache_file(
            &engine,
            &pp3,
            &raw,
            &cache,
            RAW_MONITOR_PROFILE_BALANCED,
        )
            .expect_err("bad CLI output should be rejected");

        assert!(error.contains("not a readable JPEG"));

        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(all(feature = "pro", target_os = "windows"))]
    #[test]
    fn raw_monitor_render_falls_back_to_embedded_preview_when_cli_output_is_bad() {
        let dir = temp_test_dir("raw-monitor-embedded-fallback");
        let engine = fake_rawtherapee_cli(&dir, false);
        let raw = dir.join("source.NEF");
        let pp3 = dir.join("FrameCull_Monitor_v1.pp3");
        let cache = dir.join("cache.jpg");
        let preview = test_jpeg_bytes(640, 480);
        let mut raw_bytes = b"nikon raw header".to_vec();
        raw_bytes.extend_from_slice(&preview);
        raw_bytes.extend_from_slice(b"nikon raw footer");
        fs::write(&raw, raw_bytes).unwrap();
        fs::write(&pp3, raw_monitor_pp3_content(RAW_MONITOR_PROFILE_BALANCED)).unwrap();

        let result = render_raw_monitor_cache_file(
            &engine,
            &pp3,
            &raw,
            &cache,
            RAW_MONITOR_PROFILE_BALANCED,
        )
        .unwrap();

        assert!(cache.is_file());
        assert!(image::open(&cache).is_ok());
        assert!(result.status.fallback);
        assert_eq!(result.status.source, "embeddedFallback");

        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(feature = "pro")]
    #[test]
    fn raw_monitor_decode_failure_detection_catches_corruption_warnings() {
        assert!(rawtherapee_reported_decode_failure(
            "unknown file: data corrupted at 5014531"
        ));
        assert!(rawtherapee_reported_decode_failure(
            "Decoder error while reading RAW data"
        ));
        assert!(!rawtherapee_reported_decode_failure(
            "Processing completed with neutral profile"
        ));
    }
}
