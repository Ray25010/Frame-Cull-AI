#![cfg(feature = "pro")]

// Keep this outside src/bin so Tauri does not auto-bundle the Pro-only utility in Flash builds.

use std::fs;
use std::path::{Path, PathBuf};

use framecull_ai_lib::pro_infer::infer::run_batch;
use framecull_ai_lib::pro_infer::session::init_model;
use framecull_ai_lib::pro_infer::types::ProBatchRequest;
use serde::Serialize;

#[derive(Debug)]
struct Args {
    audit: PathBuf,
    manifest: PathBuf,
    output: PathBuf,
    preview_dir: Option<PathBuf>,
    batch_size: u32,
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchRow {
    photo_id: String,
    image_path: String,
    aesthetic: Option<f32>,
    persona_score: Option<f32>,
    scene_label: Option<String>,
    scene_confidence: Option<f32>,
    semantic_keep_score: Option<f32>,
    face_validity_score: Option<f32>,
    composition_score: Option<f32>,
    moment_score: Option<f32>,
    lighting_mood_score: Option<f32>,
    false_face_risk: Option<f32>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchOutput {
    manifest_path: String,
    active_ep: String,
    ep_fallback_chain: Vec<String>,
    backbone_version: String,
    warmup_ms: f64,
    batch_size: u32,
    count: usize,
    elapsed_ms: f64,
    mean_per_image_ms: f64,
    results: Vec<BenchRow>,
}

fn main() -> Result<(), String> {
    let args = parse_args(std::env::args().skip(1).collect())?;
    let audit: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&args.audit).map_err(|e| format!("failed to read audit: {e}"))?,
    )
    .map_err(|e| format!("invalid audit json: {e}"))?;

    let summaries = audit["photoSummaries"]
        .as_array()
        .ok_or_else(|| "audit.photoSummaries missing".to_string())?;

    let mut image_paths: Vec<String> = Vec::new();
    let mut photo_ids: Vec<String> = Vec::new();
    for summary in summaries {
        let photo_id = summary["id"].as_str().unwrap_or_default().to_string();
        let source = summary["sourceName"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let file_name = summary["fileName"].as_str().unwrap_or_default().to_string();
        if photo_id.is_empty() {
            continue;
        }
        let explicit_path = explicit_decodable_path(summary);
        let path = pick_decodable_path(
            explicit_path.as_deref(),
            &source,
            &file_name,
            &photo_id,
            args.preview_dir.as_deref(),
        );
        image_paths.push(path);
        photo_ids.push(photo_id);
        if let Some(limit) = args.limit {
            if image_paths.len() >= limit {
                break;
            }
        }
    }

    let (mut loaded, caps) = init_model(
        args.manifest
            .to_str()
            .ok_or_else(|| "manifest path is not valid UTF-8".to_string())?,
        None,
    )?;

    let req = ProBatchRequest {
        image_paths: image_paths.clone(),
        batch_size: Some(args.batch_size),
        heads: None,
    };
    let resp = run_batch(&mut loaded, &req);

    let results = resp
        .results
        .into_iter()
        .zip(photo_ids.into_iter())
        .map(|(row, photo_id)| BenchRow {
            photo_id,
            image_path: row.image_path,
            aesthetic: row.aesthetic,
            persona_score: row.persona_score,
            scene_label: row.scene_label,
            scene_confidence: row.scene_confidence,
            semantic_keep_score: row.semantic_keep_score,
            face_validity_score: row.face_validity_score,
            composition_score: row.composition_score,
            moment_score: row.moment_score,
            lighting_mood_score: row.lighting_mood_score,
            false_face_risk: row.false_face_risk,
            error: row.error,
        })
        .collect::<Vec<_>>();

    let output = BenchOutput {
        manifest_path: args.manifest.to_string_lossy().into_owned(),
        active_ep: resp.ep,
        ep_fallback_chain: caps.ep_fallback_chain,
        backbone_version: caps.backbone_version,
        warmup_ms: caps.warmup_ms,
        batch_size: args.batch_size,
        count: results.len(),
        elapsed_ms: resp.elapsed_ms,
        mean_per_image_ms: if results.is_empty() {
            0.0
        } else {
            resp.elapsed_ms / results.len() as f64
        },
        results,
    };

    if let Some(parent) = args.output.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create output dir: {e}"))?;
    }
    fs::write(
        &args.output,
        serde_json::to_string_pretty(&output)
            .map_err(|e| format!("failed to encode output json: {e}"))?,
    )
    .map_err(|e| format!("failed to write output: {e}"))?;
    Ok(())
}

fn parse_args(argv: Vec<String>) -> Result<Args, String> {
    let mut audit: Option<PathBuf> = None;
    let mut manifest: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut preview_dir: Option<PathBuf> = None;
    let mut batch_size: u32 = 1;
    let mut limit: Option<usize> = None;

    let mut idx = 0usize;
    while idx < argv.len() {
        let key = &argv[idx];
        let has_value = argv
            .get(idx + 1)
            .map(|value| !value.starts_with("--"))
            .unwrap_or(false);
        let value = if has_value {
            argv.get(idx + 1).cloned()
        } else {
            None
        };
        match key.as_str() {
            "--audit" => audit = value.as_deref().map(PathBuf::from),
            "--manifest" => manifest = value.as_deref().map(PathBuf::from),
            "--output" => output = value.as_deref().map(PathBuf::from),
            "--preview-dir" => preview_dir = value.as_deref().map(PathBuf::from),
            "--batch-size" => {
                batch_size = value
                    .as_deref()
                    .ok_or_else(|| "--batch-size requires a value".to_string())?
                    .parse::<u32>()
                    .map_err(|e| format!("invalid --batch-size: {e}"))?;
            }
            "--limit" => {
                limit = Some(
                    value
                        .as_deref()
                        .ok_or_else(|| "--limit requires a value".to_string())?
                        .parse::<usize>()
                        .map_err(|e| format!("invalid --limit: {e}"))?,
                );
            }
            _ => {}
        }
        idx += if has_value { 2 } else { 1 };
    }

    Ok(Args {
        audit: audit.ok_or_else(|| "--audit is required".to_string())?,
        manifest: manifest.ok_or_else(|| "--manifest is required".to_string())?,
        output: output.ok_or_else(|| "--output is required".to_string())?,
        preview_dir,
        batch_size,
        limit,
    })
}

fn pick_decodable_path(
    explicit_path: Option<&str>,
    source: &str,
    file_name: &str,
    photo_id: &str,
    preview_dir: Option<&Path>,
) -> String {
    if let Some(explicit_path) = explicit_path {
        let path = Path::new(explicit_path);
        if is_decodable_image(path) && path.exists() {
            return path.to_string_lossy().into_owned();
        }
    }

    if let Some(preview_dir) = preview_dir {
        for candidate in preview_candidates(preview_dir, file_name, photo_id) {
            if candidate.exists() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }

    let path = Path::new(source);
    if is_decodable_image(path) {
        return source.to_string();
    }

    let jpg = path.with_extension("jpg");
    if jpg.exists() {
        return jpg.to_string_lossy().into_owned();
    }
    let jpeg = path.with_extension("jpeg");
    if jpeg.exists() {
        return jpeg.to_string_lossy().into_owned();
    }
    source.to_string()
}

fn explicit_decodable_path(summary: &serde_json::Value) -> Option<String> {
    for key in [
        "studentPreviewPath",
        "previewPath",
        "imagePath",
        "importPath",
    ] {
        let value = summary[key].as_str().unwrap_or_default().trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn is_decodable_image(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|ext| {
            let lower = ext.to_ascii_lowercase();
            lower == "jpg" || lower == "jpeg" || lower == "png"
        })
        .unwrap_or(false)
}

fn preview_candidates(preview_dir: &Path, file_name: &str, photo_id: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if !file_name.is_empty() {
        candidates.push(preview_dir.join(file_name));
    }
    for ext in ["jpg", "jpeg", "png"] {
        candidates.push(preview_dir.join(format!("{photo_id}.{ext}")));
    }
    candidates
}
