//! Shared serde structures for the Pro native inference layer.
//!
//! Field names map one-to-one to the TypeScript interfaces in `src/types.ts`
//! (see PRO_MODEL_ARCHITECTURE.md §10.5). Do not rename fields without updating
//! the frontend contract in lockstep.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProInferCapabilities {
    pub active_ep: String,
    pub ep_fallback_chain: Vec<String>,
    pub backbone_version: String,
    pub loaded_heads: Vec<String>,
    pub input_resolution: u32,
    pub warmup_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProBatchRequest {
    pub image_paths: Vec<String>,
    #[serde(default)]
    pub batch_size: Option<u32>,
    #[serde(default)]
    pub heads: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProHeadScores {
    pub image_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aesthetic: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_confidence: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona_score: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_keep_score: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face_validity_score: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub composition_score: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moment_score: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lighting_mood_score: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub false_face_risk: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProBatchResponse {
    pub results: Vec<ProHeadScores>,
    pub ep: String,
    pub elapsed_ms: f64,
}

/// Head descriptor parsed from `manifest.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestHead {
    pub name: String,
    pub output: String,
    pub kind: String,
    #[serde(default)]
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestNormalize {
    pub mean: [f32; 3],
    pub std: [f32; 3],
}

/// Parsed `manifest.json`. Swapping in a real model only edits this file plus
/// the referenced model blob, never the Rust code.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProModelManifest {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub backbone_version: String,
    pub model: String,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default = "default_input_name")]
    pub input_name: String,
    pub input_resolution: u32,
    #[serde(default = "default_channels")]
    pub channels: u32,
    pub normalize: ManifestNormalize,
    pub heads: Vec<ManifestHead>,
}

fn default_schema_version() -> u32 {
    1
}

fn default_input_name() -> String {
    "pixel_values".to_string()
}

fn default_channels() -> u32 {
    3
}
