use anyhow::{anyhow, Context, Result};
use image::{codecs::jpeg::JpegEncoder, DynamicImage, GenericImageView, Pixel};
use rawler::{analyze, decoders::RawDecodeParams};
use serde::Serialize;
use std::{
    env, fs,
    io::BufReader,
    path::{Path, PathBuf},
    time::Instant,
};
use walkdir::WalkDir;

const DEFAULT_MAX_EDGE: u32 = 2048;
const DEFAULT_JPEG_QUALITY: u8 = 86;

#[derive(Debug)]
struct Args {
    input: PathBuf,
    output: PathBuf,
    max_edge: u32,
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LabReport {
    version: &'static str,
    input: String,
    output: String,
    max_edge: u32,
    jpeg_quality: u8,
    total: usize,
    ok: usize,
    failed: usize,
    records: Vec<FileReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileReport {
    source_path: String,
    file_name: String,
    file_size_bytes: u64,
    embedded_preview: StageReport,
    raw_develop: StageReport,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StageReport {
    ok: bool,
    elapsed_ms: u128,
    width: Option<u32>,
    height: Option<u32>,
    output_path: Option<String>,
    error: Option<String>,
    auto_exposure: Option<AutoExposureReport>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoExposureReport {
    ev: f32,
    brightness: f32,
    confidence: &'static str,
    reason: &'static str,
    p10_luma: f32,
    p50_luma: f32,
    p90_luma: f32,
    p98_luma: f32,
    mean_luma: f32,
    shadow_ratio: f32,
    highlight_ratio: f32,
    clipped_highlight_ratio: f32,
}

fn main() -> Result<()> {
    let args = parse_args()?;
    fs::create_dir_all(&args.output)
        .with_context(|| format!("failed to create output dir {}", args.output.display()))?;

    let inputs = collect_inputs(&args.input, args.limit)?;
    if inputs.is_empty() {
        return Err(anyhow!(
            "no supported RAW files found at {}",
            args.input.display()
        ));
    }

    let mut records = Vec::with_capacity(inputs.len());
    for path in inputs {
        records.push(process_one(&path, &args.output, args.max_edge)?);
    }

    let ok = records
        .iter()
        .filter(|record| record.embedded_preview.ok || record.raw_develop.ok)
        .count();
    let report = LabReport {
        version: "pro-raw-preview-lab-p1",
        input: args.input.display().to_string(),
        output: args.output.display().to_string(),
        max_edge: args.max_edge,
        jpeg_quality: DEFAULT_JPEG_QUALITY,
        total: records.len(),
        ok,
        failed: records.len().saturating_sub(ok),
        records,
    };

    let metrics_path = args.output.join("metrics.json");
    fs::write(&metrics_path, serde_json::to_string_pretty(&report)?)
        .with_context(|| format!("failed to write {}", metrics_path.display()))?;
    write_summary(&args.output.join("summary.md"), &report)?;

    println!(
        "P1 done: {} total, {} ok, {} failed. Metrics: {}",
        report.total,
        report.ok,
        report.failed,
        metrics_path.display()
    );
    Ok(())
}

fn process_one(path: &Path, output_root: &Path, max_edge: u32) -> Result<FileReport> {
    let file_stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("raw")
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("raw")
        .to_string();
    let file_size_bytes = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    let embedded_preview = run_stage(
        path,
        &output_root.join(format!("{file_stem}.embedded.jpg")),
        max_edge,
        |source| analyze::extract_preview_pixels(source, &RawDecodeParams::default()),
    );

    let raw_develop = run_stage(
        path,
        &output_root.join(format!("{file_stem}.raw-develop.jpg")),
        max_edge,
        |source| analyze::raw_to_srgb(source, &RawDecodeParams::default()),
    );

    Ok(FileReport {
        source_path: path.display().to_string(),
        file_name,
        file_size_bytes,
        embedded_preview,
        raw_develop,
    })
}

fn run_stage<F>(source: &Path, output_path: &Path, max_edge: u32, f: F) -> StageReport
where
    F: FnOnce(&Path) -> rawler::Result<DynamicImage>,
{
    let started = Instant::now();
    let orientation = read_exif_orientation(source);
    match f(source) {
        Ok(image) => {
            let normalized = normalize_orientation(image, orientation);
            let resized = resize_to_max_edge(normalized, max_edge);
            let (width, height) = resized.dimensions();
            match write_jpeg(&resized, output_path, DEFAULT_JPEG_QUALITY) {
                Ok(()) => StageReport {
                    ok: true,
                    elapsed_ms: started.elapsed().as_millis(),
                    width: Some(width),
                    height: Some(height),
                    output_path: Some(output_path.display().to_string()),
                    error: None,
                    auto_exposure: Some(compute_auto_exposure_report(&resized)),
                },
                Err(error) => StageReport {
                    ok: false,
                    elapsed_ms: started.elapsed().as_millis(),
                    width: Some(width),
                    height: Some(height),
                    output_path: None,
                    error: Some(error.to_string()),
                    auto_exposure: None,
                },
            }
        }
        Err(error) => StageReport {
            ok: false,
            elapsed_ms: started.elapsed().as_millis(),
            width: None,
            height: None,
            output_path: None,
            error: Some(error.to_string()),
            auto_exposure: None,
        },
    }
}

fn compute_auto_exposure_report(image: &DynamicImage) -> AutoExposureReport {
    let sample = resize_to_max_edge(image.clone(), 360).to_rgba8();
    let mut histogram = [0u32; 256];
    let mut total = 0u32;
    let mut luma_sum = 0.0f32;
    for pixel in sample.pixels() {
        let channels = pixel.channels();
        if channels[3] < 16 {
            continue;
        }
        let luma = (0.2126 * channels[0] as f32 + 0.7152 * channels[1] as f32 + 0.0722 * channels[2] as f32)
            .round()
            .clamp(0.0, 255.0) as usize;
        histogram[luma] += 1;
        total += 1;
        luma_sum += luma as f32 / 255.0;
    }

    if total == 0 {
        return AutoExposureReport {
            ev: 0.0,
            brightness: 1.0,
            confidence: "low",
            reason: "no-sample",
            p10_luma: 0.0,
            p50_luma: 0.0,
            p90_luma: 0.0,
            p98_luma: 0.0,
            mean_luma: 0.0,
            shadow_ratio: 0.0,
            highlight_ratio: 0.0,
            clipped_highlight_ratio: 0.0,
        };
    }

    let p10 = percentile_from_histogram(&histogram, total, 0.10);
    let p50 = percentile_from_histogram(&histogram, total, 0.50);
    let p90 = percentile_from_histogram(&histogram, total, 0.90);
    let p98 = percentile_from_histogram(&histogram, total, 0.98);
    let shadow_ratio = count_range(&histogram, 0, 26) as f32 / total as f32;
    let highlight_ratio = count_range(&histogram, 230, 255) as f32 / total as f32;
    let clipped_highlight_ratio = count_range(&histogram, 250, 255) as f32 / total as f32;

    let median = p50.clamp(0.03, 0.97);
    let mut ev = (0.42 / median).log2() * 0.72;
    let mut reason = "median-target";
    let dark_mood = p50 < 0.16 && p90 < 0.40;
    if dark_mood {
        ev *= 0.55;
        ev = ev.min(0.65);
        reason = "dark-scene-conservative";
    } else {
        ev = ev.min(1.35);
    }
    if p98 > 0.92 {
        ev = ev.min(0.35);
        reason = "highlight-protected";
    }
    if clipped_highlight_ratio > 0.015 {
        ev = ev.min(0.15);
        reason = "clipped-highlight-protected";
    }
    if clipped_highlight_ratio > 0.04 {
        ev = ev.min(0.0);
        reason = "heavy-clipping-protected";
    }
    ev = ev.clamp(-0.60, 1.35);
    if ev.abs() < 0.08 {
        ev = 0.0;
    }

    AutoExposureReport {
        ev,
        brightness: 2.0_f32.powf(ev),
        confidence: if total < 4096 || dark_mood || clipped_highlight_ratio > 0.04 {
            "medium"
        } else {
            "high"
        },
        reason,
        p10_luma: p10,
        p50_luma: p50,
        p90_luma: p90,
        p98_luma: p98,
        mean_luma: luma_sum / total as f32,
        shadow_ratio,
        highlight_ratio,
        clipped_highlight_ratio,
    }
}

fn percentile_from_histogram(histogram: &[u32; 256], total: u32, percentile: f32) -> f32 {
    let target = ((total as f32 * percentile).ceil() as u32).max(1);
    let mut cumulative = 0u32;
    for (index, count) in histogram.iter().enumerate() {
        cumulative += *count;
        if cumulative >= target {
            return index as f32 / 255.0;
        }
    }
    1.0
}

fn count_range(histogram: &[u32; 256], start: usize, end: usize) -> u32 {
    histogram[start..=end].iter().sum()
}

fn read_exif_orientation(path: &Path) -> Option<u16> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|field| match &field.value {
            exif::Value::Short(values) => values.first().copied(),
            _ => field
                .display_value()
                .with_unit(&exif)
                .to_string()
                .split_whitespace()
                .next()
                .and_then(|value| value.parse::<u16>().ok()),
        })
        .filter(|value| (1..=8).contains(value))
}

fn normalize_orientation(image: DynamicImage, orientation: Option<u16>) -> DynamicImage {
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

fn resize_to_max_edge(image: DynamicImage, max_edge: u32) -> DynamicImage {
    let (width, height) = image.dimensions();
    let longest = width.max(height);
    if longest <= max_edge || longest == 0 {
        return image;
    }
    let scale = max_edge as f32 / longest as f32;
    let next_width = ((width as f32 * scale).round() as u32).max(1);
    let next_height = ((height as f32 * scale).round() as u32).max(1);
    image.resize(
        next_width,
        next_height,
        image::imageops::FilterType::Triangle,
    )
}

fn write_jpeg(image: &DynamicImage, output_path: &Path, quality: u8) -> Result<()> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::File::create(output_path)?;
    let mut encoder = JpegEncoder::new_with_quality(&mut file, quality);
    encoder.encode_image(&image.to_rgb8())?;
    Ok(())
}

fn collect_inputs(input: &Path, limit: Option<usize>) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    if input.is_file() {
        paths.push(input.to_path_buf());
    } else if input.is_dir() {
        for entry in WalkDir::new(input)
            .follow_links(false)
            .into_iter()
            .flatten()
        {
            if entry.file_type().is_file() && is_raw_path(entry.path()) {
                paths.push(entry.path().to_path_buf());
                if limit.is_some_and(|limit| paths.len() >= limit) {
                    break;
                }
            }
        }
    }
    paths.sort_by(|left, right| left.display().to_string().cmp(&right.display().to_string()));
    Ok(paths)
}

fn is_raw_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("nef" | "cr2" | "cr3" | "arw" | "dng" | "raf" | "orf" | "rw2" | "pef" | "srw")
    )
}

fn parse_args() -> Result<Args> {
    let mut input = None;
    let mut output = None;
    let mut max_edge = DEFAULT_MAX_EDGE;
    let mut limit = None;

    let mut iter = env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--input" => input = iter.next().map(PathBuf::from),
            "--output" => output = iter.next().map(PathBuf::from),
            "--max-edge" => {
                max_edge = iter
                    .next()
                    .ok_or_else(|| anyhow!("--max-edge requires a value"))?
                    .parse()
                    .context("--max-edge must be a positive integer")?;
            }
            "--limit" => {
                limit = Some(
                    iter.next()
                        .ok_or_else(|| anyhow!("--limit requires a value"))?
                        .parse()
                        .context("--limit must be a positive integer")?,
                );
            }
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            other => return Err(anyhow!("unknown argument: {other}")),
        }
    }

    Ok(Args {
        input: input.ok_or_else(|| anyhow!("missing --input"))?,
        output: output.ok_or_else(|| anyhow!("missing --output"))?,
        max_edge: max_edge.max(256),
        limit,
    })
}

fn print_help() {
    println!(
        "FrameCull Pro RAW Preview Lab P1\n\n\
         Usage:\n\
           cargo run --manifest-path tools/pro-raw-preview-lab/Cargo.toml --release -- \\\n\
             --input G:\\DCIM\\110NZ6_3\\_DSC0552.NEF \\\n\
             --output output\\pro-raw-preview-lab\\p1-smoke\n\n\
         Options:\n\
           --input <file-or-dir>   RAW file or folder\n\
           --output <dir>          Output directory\n\
           --max-edge <px>         Preview max edge, default 2048\n\
           --limit <n>             Max RAW files when input is a folder"
    );
}

fn write_summary(path: &Path, report: &LabReport) -> Result<()> {
    let mut markdown = String::new();
    markdown.push_str("# FrameCull Pro RAW Preview Lab P1\n\n");
    markdown.push_str(&format!("- Input: `{}`\n", report.input));
    markdown.push_str(&format!("- Output: `{}`\n", report.output));
    markdown.push_str(&format!("- Total: `{}`\n", report.total));
    markdown.push_str(&format!("- OK: `{}`\n", report.ok));
    markdown.push_str(&format!("- Failed: `{}`\n\n", report.failed));
    markdown.push_str("| File | Embedded Preview | Raw Develop |\n");
    markdown.push_str("| --- | ---: | ---: |\n");
    for record in &report.records {
        markdown.push_str(&format!(
            "| {} | {} ms / {} | {} ms / {} |\n",
            record.file_name,
            record.embedded_preview.elapsed_ms,
            if record.embedded_preview.ok {
                "ok"
            } else {
                "failed"
            },
            record.raw_develop.elapsed_ms,
            if record.raw_develop.ok {
                "ok"
            } else {
                "failed"
            },
        ));
    }
    markdown.push_str("\n## Auto Exposure Preview\n\n");
    markdown.push_str("| File | EV | P50 | P98 | Clip | Reason |\n");
    markdown.push_str("| --- | ---: | ---: | ---: | ---: | --- |\n");
    for record in &report.records {
        if let Some(auto) = &record.embedded_preview.auto_exposure {
            markdown.push_str(&format!(
                "| {} | {:+.2} | {:.0}% | {:.0}% | {:.1}% | {} |\n",
                record.file_name,
                auto.ev,
                auto.p50_luma * 100.0,
                auto.p98_luma * 100.0,
                auto.clipped_highlight_ratio * 100.0,
                auto.reason,
            ));
        }
    }
    fs::write(path, markdown)?;
    Ok(())
}
