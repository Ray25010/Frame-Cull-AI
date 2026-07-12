//! Batch inference and multi-head output parsing (§10.5/§10.7).

use std::path::Path;

use ort::value::Tensor;

use super::preprocess::preprocess_image;
use super::session::LoadedModel;
use super::types::{ProBatchRequest, ProBatchResponse, ProHeadScores};

const DEFAULT_ACCELERATED_BATCH_SIZE: usize = 8;
const DEFAULT_CPU_BATCH_SIZE: usize = 1;

/// Resolve the effective batch size: explicit request, else a conservative
/// default sized for the 6GB min-spec card (§6.1).
fn effective_batch_size(req: &ProBatchRequest, active_ep: &str) -> usize {
    req.batch_size
        .map(|value| value.max(1) as usize)
        .unwrap_or_else(|| {
            if active_ep == "cpu" {
                DEFAULT_CPU_BATCH_SIZE
            } else {
                DEFAULT_ACCELERATED_BATCH_SIZE
            }
        })
}

/// Run a full batch request. Per-image decode failures are isolated into that
/// image's `error` field and never abort the whole batch (§10.9 item 5).
pub fn run_batch(model: &mut LoadedModel, req: &ProBatchRequest) -> ProBatchResponse {
    let started = std::time::Instant::now();
    let active_ep = model.active_ep.clone();
    let batch_size = effective_batch_size(req, &active_ep);
    let mut results: Vec<ProHeadScores> = Vec::with_capacity(req.image_paths.len());

    for chunk in req.image_paths.chunks(batch_size) {
        run_chunk(model, chunk, &mut results);
    }

    ProBatchResponse {
        results,
        ep: active_ep,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    }
}

fn run_chunk(model: &mut LoadedModel, chunk: &[String], results: &mut Vec<ProHeadScores>) {
    let res = model.manifest.input_resolution as usize;
    let channels = model.manifest.channels as usize;
    let plane = channels * res * res;

    // Preprocess each path; keep only the ones that decoded so the batch tensor
    // stays dense. Failed paths get an immediate error result.
    let mut packed: Vec<f32> = Vec::with_capacity(chunk.len() * plane);
    let mut valid_paths: Vec<&String> = Vec::with_capacity(chunk.len());
    let mut valid_indices: Vec<usize> = Vec::with_capacity(chunk.len());
    let mut ordered_results: Vec<Option<ProHeadScores>> = vec![None; chunk.len()];

    for (index, path) in chunk.iter().enumerate() {
        match preprocess_image(Path::new(path), &model.manifest) {
            Ok(buffer) => {
                packed.extend_from_slice(&buffer);
                valid_paths.push(path);
                valid_indices.push(index);
            }
            Err(error) => {
                ordered_results[index] = Some(ProHeadScores {
                    image_path: path.clone(),
                    error: Some(error),
                    ..Default::default()
                });
            }
        }
    }

    if !valid_paths.is_empty() {
        match infer_packed(model, &packed, valid_paths.len(), channels, res) {
            Ok(chunk_results) => {
                // Success rows are positional; attach the path for each row.
                for ((path, index), mut score) in valid_paths
                    .iter()
                    .zip(valid_indices.iter())
                    .zip(chunk_results.into_iter())
                {
                    score.image_path = (*path).clone();
                    ordered_results[*index] = Some(score);
                }
            }
            Err(error) => {
                // A run-level failure marks every valid image in this chunk; the
                // rest of the batch still proceeds.
                for (path, index) in valid_paths.iter().zip(valid_indices.iter()) {
                    ordered_results[*index] = Some(ProHeadScores {
                        image_path: (*path).clone(),
                        error: Some(error.clone()),
                        ..Default::default()
                    });
                }
            }
        }
    }

    results.extend(ordered_results.into_iter().enumerate().map(|(index, row)| {
        row.unwrap_or_else(|| ProHeadScores {
            image_path: chunk[index].clone(),
            error: Some("internal error: missing inference slot".to_string()),
            ..Default::default()
        })
    }));
}

fn infer_packed(
    model: &mut LoadedModel,
    packed: &[f32],
    count: usize,
    channels: usize,
    res: usize,
) -> Result<Vec<ProHeadScores>, String> {
    let input = Tensor::from_array(([count, channels, res, res], packed.to_vec()))
        .map_err(|error| format!("batch tensor build failed: {error}"))?;
    let input_name = model.manifest.input_name.clone();

    let outputs = model
        .session
        .run(ort::inputs![input_name.as_str() => input])
        .map_err(|error| format!("inference run failed: {error}"))?;

    let manifest = &model.manifest;
    let mut scores: Vec<ProHeadScores> = (0..count).map(|_| ProHeadScores::default()).collect();
    let has_false_face_risk_head = manifest
        .heads
        .iter()
        .any(|head| matches!(head.name.as_str(), "false_face_risk" | "falseFaceRisk"));

    for head in &manifest.heads {
        let value = match outputs.get(head.output.as_str()) {
            Some(value) => value,
            None => continue,
        };
        let (shape, data) = value
            .try_extract_tensor::<f32>()
            .map_err(|error| format!("head '{}' extract failed: {error}", head.name))?;
        apply_head(head, shape.as_ref(), data, count, &mut scores);
    }

    if !has_false_face_risk_head {
        for score in scores.iter_mut() {
            if score.false_face_risk.is_none() {
                if let Some(face_validity) = score.face_validity_score {
                    score.false_face_risk = Some((1.0 - face_validity).clamp(0.0, 1.0));
                }
            }
        }
    }

    Ok(scores)
}

fn apply_head(
    head: &super::types::ManifestHead,
    shape: &[i64],
    data: &[f32],
    count: usize,
    scores: &mut [ProHeadScores],
) {
    let per_row = if shape.len() >= 2 {
        shape[1..].iter().product::<i64>().max(1) as usize
    } else {
        1
    };

    for (row, score) in scores.iter_mut().enumerate().take(count) {
        let start = row * per_row;
        if start >= data.len() {
            break;
        }
        let slice = &data[start..(start + per_row).min(data.len())];
        match head.kind.as_str() {
            "scalar01" => {
                let value = slice.first().copied().unwrap_or(0.0).clamp(0.0, 1.0);
                assign_scalar(&head.name, value, score);
            }
            "classifier" => {
                let (idx, confidence) = argmax_softmax(slice);
                let label = head
                    .labels
                    .get(idx)
                    .cloned()
                    .unwrap_or_else(|| format!("class_{idx}"));
                score.scene_label = Some(label);
                score.scene_confidence = Some(confidence);
            }
            _ => {}
        }
    }
}

fn assign_scalar(head_name: &str, value: f32, score: &mut ProHeadScores) {
    match head_name {
        "aesthetic" => score.aesthetic = Some(value),
        "persona" => score.persona_score = Some(value),
        "semantic_keep" | "semanticKeepScore" => score.semantic_keep_score = Some(value),
        "face_validity" | "faceValidityScore" => score.face_validity_score = Some(value),
        "composition" | "compositionScore" => score.composition_score = Some(value),
        "moment" | "momentScore" => score.moment_score = Some(value),
        "lighting" | "lighting_mood" | "lightingMoodScore" => {
            score.lighting_mood_score = Some(value)
        }
        "false_face_risk" | "falseFaceRisk" => score.false_face_risk = Some(value),
        _ => {}
    }
}

fn argmax_softmax(logits: &[f32]) -> (usize, f32) {
    if logits.is_empty() {
        return (0, 0.0);
    }
    let max = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let exps: Vec<f32> = logits.iter().map(|v| (v - max).exp()).collect();
    let sum: f32 = exps.iter().sum();
    let mut best_idx = 0;
    let mut best_val = f32::NEG_INFINITY;
    for (idx, value) in logits.iter().enumerate() {
        if *value > best_val {
            best_val = *value;
            best_idx = idx;
        }
    }
    let confidence = if sum > 0.0 { exps[best_idx] / sum } else { 0.0 };
    (best_idx, confidence)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pro_infer::types::ManifestHead;

    #[test]
    fn false_face_head_is_not_forced_to_inverse_face_validity() {
        let mut scores = vec![ProHeadScores::default()];
        let face_head = ManifestHead {
            name: "face_validity".to_string(),
            output: "face_validity".to_string(),
            kind: "scalar01".to_string(),
            labels: vec![],
        };
        let risk_head = ManifestHead {
            name: "false_face_risk".to_string(),
            output: "false_face_risk".to_string(),
            kind: "scalar01".to_string(),
            labels: vec![],
        };

        apply_head(&face_head, &[1, 1], &[0.8], 1, &mut scores);
        apply_head(&risk_head, &[1, 1], &[0.6], 1, &mut scores);

        assert_eq!(scores[0].face_validity_score, Some(0.8));
        assert_eq!(scores[0].false_face_risk, Some(0.6));
    }
}
