//! Image preprocessing for the Pro native inference layer (§10.7).
//!
//! The frontend hands over file paths only; Rust owns decode + resize to the
//! manifest resolution + normalization + NCHW tensor packing. No pixels cross
//! the Tauri boundary.

use std::path::Path;

use image::imageops::FilterType;

use super::types::ProModelManifest;

/// Decode an image at `path` and produce a normalized `[3, R, R]` CHW buffer in
/// row-major order (channel-major), ready to be stacked into a batch tensor.
pub fn preprocess_image(path: &Path, manifest: &ProModelManifest) -> Result<Vec<f32>, String> {
    let res = manifest.input_resolution as u32;
    let channels = manifest.channels as usize;
    if channels != 3 {
        return Err(format!(
            "unsupported channel count {channels}; placeholder pipeline expects 3"
        ));
    }

    let decoded = image::open(path).map_err(|error| format!("decode failed: {error}"))?;
    let resized = decoded.resize_exact(res, res, FilterType::Triangle);
    let rgb = resized.to_rgb8();

    let mean = manifest.normalize.mean;
    let std = manifest.normalize.std;
    let pixel_count = (res * res) as usize;
    let mut chw = vec![0f32; channels * pixel_count];

    // Pack channel-major: [R-plane, G-plane, B-plane], normalized per channel.
    for (idx, pixel) in rgb.pixels().enumerate() {
        for c in 0..3 {
            let value = pixel[c] as f32 / 255.0;
            let normalized = (value - mean[c]) / std[c];
            chw[c * pixel_count + idx] = normalized;
        }
    }

    Ok(chw)
}
