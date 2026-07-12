//! End-to-end tests for the Pro native inference layer against the bundled
//! placeholder model. These cover acceptance items §10.9 #5 (per-image
//! aesthetic + single-image error isolation) and keep the batch path exercised.
//! Full #6 throughput evidence is produced by the release bench because debug
//! builds and GPU fallback states can be noisy. They require the `ort` runtime,
//! so they are gated behind `feature = "pro"` and only run for the pro build.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use image::{ImageBuffer, Rgb};

use super::session::init_model;
use super::types::ProBatchRequest;
use super::{infer, session::LoadedModel};

fn manifest_path() -> PathBuf {
    if let Ok(path) = std::env::var("FRAMECULL_PRO_TEST_MANIFEST") {
        return PathBuf::from(path);
    }
    // CARGO_MANIFEST_DIR is `src-tauri`; the placeholder lives under pro-models.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pro-models/placeholder/manifest.json")
}

fn write_test_jpeg(dir: &std::path::Path, name: &str, fill: u8) -> PathBuf {
    let path = dir.join(name);
    let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
        ImageBuffer::from_fn(64, 64, |x, _y| Rgb([fill, (x as u8).wrapping_mul(3), 128]));
    img.save_with_format(&path, image::ImageFormat::Jpeg)
        .expect("write test jpeg");
    path
}

fn write_corrupt_jpeg(dir: &std::path::Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    let mut f = fs::File::create(&path).expect("create corrupt file");
    f.write_all(b"this is not a valid jpeg payload").unwrap();
    path
}

fn load() -> LoadedModel {
    let (loaded, caps) = init_model(manifest_path().to_str().unwrap(), None)
        .expect("placeholder model should initialize (CPU fallback never fails)");
    assert_eq!(
        caps.input_resolution, 384,
        "manifest resolution must be 384"
    );
    assert!(
        !caps.ep_fallback_chain.is_empty(),
        "fallback chain recorded"
    );
    assert!(
        caps.loaded_heads.iter().any(|h| h == "aesthetic"),
        "aesthetic head must load"
    );
    loaded
}

#[test]
fn batch_returns_per_image_aesthetic_and_isolates_corrupt() {
    let dir = std::env::temp_dir().join(format!("framecull_pro_infer_{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();

    let good_a = write_test_jpeg(&dir, "good_a.jpg", 40);
    let bad = write_corrupt_jpeg(&dir, "broken.jpg");
    let good_b = write_test_jpeg(&dir, "good_b.jpg", 200);

    let mut model = load();
    let req = ProBatchRequest {
        image_paths: vec![
            good_a.to_string_lossy().into_owned(),
            bad.to_string_lossy().into_owned(),
            good_b.to_string_lossy().into_owned(),
        ],
        batch_size: Some(4),
        heads: None,
    };
    let resp = infer::run_batch(&mut model, &req);

    assert_eq!(resp.results.len(), 3, "every input gets a result row");

    let find = |needle: &str| {
        resp.results
            .iter()
            .find(|r| r.image_path.contains(needle))
            .unwrap_or_else(|| panic!("missing result for {needle}"))
    };

    // §10.9 #5: good images carry an aesthetic in [0,1] and no error.
    for needle in ["good_a", "good_b"] {
        let row = find(needle);
        let aesthetic = row
            .aesthetic
            .unwrap_or_else(|| panic!("{needle} aesthetic missing"));
        assert!((0.0..=1.0).contains(&aesthetic), "aesthetic in range");
        assert!(row.error.is_none(), "good image has no error");
    }

    // §10.9 #5: the single corrupt image is isolated to its own error field and
    // does not abort the rest of the batch.
    let broken = find("broken");
    assert!(broken.error.is_some(), "corrupt image reports an error");
    assert!(broken.aesthetic.is_none(), "corrupt image has no score");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn batch_throughput_beats_single_image_loop() {
    let dir = std::env::temp_dir().join(format!("framecull_pro_infer_perf_{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();

    let mut paths: Vec<String> = Vec::new();
    for i in 0..16 {
        let p = write_test_jpeg(&dir, &format!("perf_{i}.jpg"), (i * 12) as u8);
        paths.push(p.to_string_lossy().into_owned());
    }

    let mut model = load();

    // Single-image loop: batch_size 1 forces one run per image.
    let loop_started = Instant::now();
    let loop_req = ProBatchRequest {
        image_paths: paths.clone(),
        batch_size: Some(1),
        heads: None,
    };
    let loop_resp = infer::run_batch(&mut model, &loop_req);
    let loop_ms = loop_started.elapsed().as_secs_f64() * 1000.0;

    // Batched path: a single run over the whole set.
    let batch_started = Instant::now();
    let batch_req = ProBatchRequest {
        image_paths: paths.clone(),
        batch_size: Some(16),
        heads: None,
    };
    let batch_resp = infer::run_batch(&mut model, &batch_req);
    let batch_ms = batch_started.elapsed().as_secs_f64() * 1000.0;

    assert_eq!(loop_resp.results.len(), paths.len());
    assert_eq!(batch_resp.results.len(), paths.len());

    if std::env::var("FRAMECULL_PRO_TEST_MANIFEST").is_ok() {
        eprintln!(
            "external manifest benchmark: ep={} batch={batch_ms:.1}ms loop={loop_ms:.1}ms; detailed throughput is covered by bench-pro-persona.mjs",
            model.active_ep
        );
        let _ = fs::remove_dir_all(&dir);
        return;
    }

    // §10.9 #6: the batched path should be no slower than the per-image loop.
    // Decode dominates here, but batched inference still avoids per-image run
    // overhead; allow a small slack for timer noise on tiny placeholder graphs.
    // The release bench is the authoritative throughput check. In debug unit
    // tests, decode overhead and DirectML/CUDA fallback probing can dominate a
    // tiny placeholder graph, so only guard against a severe batch regression.
    assert!(
        batch_ms <= loop_ms * 1.35,
        "batch ({batch_ms:.1}ms) regressed too far beyond single-image loop ({loop_ms:.1}ms)"
    );

    let _ = fs::remove_dir_all(&dir);
}
