//! R20-3 measurement only. No calibration or scoring weights are applied here.
//! SDR RGB; aspect preserved, long edge <=320. Missing evidence stays null.
use image::{imageops, RgbImage};
use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ExposureCell {
    pub index: usize,
    pub mean: f64,
    pub low_clip_ratio: f64,
    pub high_clip_ratio: f64,
    pub severity: f64,
    pub status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorstExposure {
    pub index: Option<usize>,
    pub status: &'static str,
    pub severity: f64,
    pub cells: Vec<ExposureCell>,
}

#[derive(Debug, Clone, Serialize)]
pub struct QualityMetrics {
    /// Dominant Hough line's unsigned deviation from the nearest axis, 0..45°.
    /// This is a structural line, not a semantic claim that a horizon exists.
    pub horizon_tilt_deg: Option<f64>,
    pub exposure_worst_cell: WorstExposure,
    /// Salient-region Laplacian variance in squared 8-bit luma units, NOT a 1–5 grade.
    pub saliency_sharpness: Option<f64>,
    pub width: u32,
    pub height: u32,
}

pub fn measure_quality(rgb: &RgbImage) -> QualityMetrics {
    let (w, h) = rgb.dimensions();
    let scale = (320. / w.max(h).max(1) as f64).min(1.);
    let rgb = imageops::resize(
        rgb,
        (w as f64 * scale).round() as u32,
        (h as f64 * scale).round() as u32,
        imageops::FilterType::Triangle,
    );
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    let gray: Vec<f64> = rgb
        .pixels()
        .map(|p| (77. * p[0] as f64 + 150. * p[1] as f64 + 29. * p[2] as f64) / 256.)
        .collect();
    QualityMetrics {
        horizon_tilt_deg: horizon(&gray, w, h),
        exposure_worst_cell: exposure(&gray, w, h),
        saliency_sharpness: saliency_sharpness(&gray, w, h),
        width: w as u32,
        height: h as u32,
    }
}

fn exposure(gray: &[f64], w: usize, h: usize) -> WorstExposure {
    let mut cells = Vec::new();
    for cy in 0..3 {
        for cx in 0..3 {
            let (mut sum, mut low, mut high, mut count) = (0., 0., 0., 0.);
            for y in cy * h / 3..(cy + 1) * h / 3 {
                for x in cx * w / 3..(cx + 1) * w / 3 {
                    let v = gray[y * w + x];
                    sum += v;
                    low += f64::from(v <= 8.);
                    high += f64::from(v >= 247.);
                    count += 1.;
                }
            }
            if count == 0. {
                continue;
            }
            let mean = sum / count;
            let lo = low / count;
            let hi = high / count;
            // Explicit provisional SDR guards. Shadow/highlight clipping alone is not
            // enough: the cell must also be dark/bright. No full-frame averaging.
            let under = lo >= 0.1 && mean <= 60.;
            let over = hi >= 0.1 && mean >= 170.;
            let (status, severity) = if under {
                ("under", lo * (1. - mean / 255.))
            } else if over {
                ("over", hi * mean / 255.)
            } else {
                ("normal", 0.)
            };
            cells.push(ExposureCell {
                index: cy * 3 + cx,
                mean,
                low_clip_ratio: lo,
                high_clip_ratio: hi,
                severity,
                status,
            });
        }
    }
    let mut worst = WorstExposure {
        index: None,
        status: "unknown",
        severity: 0.,
        cells: Vec::new(),
    };
    for c in &cells {
        if worst.index.is_none() || c.severity > worst.severity {
            worst.index = Some(c.index);
            worst.status = c.status;
            worst.severity = c.severity;
        }
    }
    worst.cells = cells;
    worst
}

fn horizon(g: &[f64], w: usize, h: usize) -> Option<f64> {
    if w < 8 || h < 8 {
        return None;
    }
    let mut edges = Vec::new();
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let dx = g[(y - 1) * w + x + 1] + 2. * g[y * w + x + 1] + g[(y + 1) * w + x + 1]
                - g[(y - 1) * w + x - 1]
                - 2. * g[y * w + x - 1]
                - g[(y + 1) * w + x - 1];
            let dy = g[(y + 1) * w + x - 1] + 2. * g[(y + 1) * w + x] + g[(y + 1) * w + x + 1]
                - g[(y - 1) * w + x - 1]
                - 2. * g[(y - 1) * w + x]
                - g[(y - 1) * w + x + 1];
            if dx.hypot(dy) >= 80. {
                edges.push((x as f64, y as f64));
            }
        }
    }
    if edges.len() < 8 {
        return None;
    }
    let radius = (w as f64).hypot(h as f64).ceil() as usize;
    let mut bins = vec![0_u32; 2 * radius + 1];
    let (mut peak, mut angle) = (0_u32, 0_usize);
    for theta in 0..180 {
        bins.fill(0);
        let (sin, cos) = (theta as f64).to_radians().sin_cos();
        for &(x, y) in &edges {
            let rho = (x * cos + y * sin).round() as isize + radius as isize;
            bins[rho as usize] += 1;
        }
        let votes = *bins.iter().max()?;
        if votes > peak {
            peak = votes;
            angle = theta;
        }
    }
    // Reject isolated detail/noise without a long supported line.
    if peak < (w.max(h) as f64 * 0.25).max(12.) as u32 {
        return None;
    }
    let deviation = (angle % 90) as f64;
    Some(deviation.min(90. - deviation))
}

fn fft2(data: &mut [Complex<f64>], n: usize, inverse: bool) {
    let mut planner = FftPlanner::new();
    let fft = if inverse {
        planner.plan_fft_inverse(n)
    } else {
        planner.plan_fft_forward(n)
    };
    for row in data.chunks_exact_mut(n) {
        fft.process(row);
    }
    let mut column = vec![Complex::default(); n];
    for x in 0..n {
        for y in 0..n {
            column[y] = data[y * n + x];
        }
        fft.process(&mut column);
        for y in 0..n {
            data[y * n + x] = column[y];
        }
    }
}

fn saliency_sharpness(g: &[f64], w: usize, h: usize) -> Option<f64> {
    if w < 3 || h < 3 {
        return None;
    }
    let mean = g.iter().sum::<f64>() / g.len() as f64;
    if g.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (g.len() as f64) < 1. {
        return None;
    }
    // Spectral residual: log amplitude minus local 3x3 spectral mean, retain
    // phase, inverse FFT, squared magnitude, Gaussian smoothing. Existing rustfft.
    const N: usize = 64;
    let source = image::ImageBuffer::<image::Luma<f32>, _>::from_vec(
        w as u32,
        h as u32,
        g.iter().map(|v| (*v / 255.) as f32).collect::<Vec<_>>(),
    )?;
    let small = imageops::resize(&source, N as u32, N as u32, imageops::FilterType::Triangle);
    let mut spectrum: Vec<_> = small
        .pixels()
        .map(|p| Complex::new(p[0] as f64, 0.))
        .collect();
    fft2(&mut spectrum, N, false);
    let log: Vec<_> = spectrum.iter().map(|v| v.norm().max(1e-8).ln()).collect();
    for y in 0..N {
        for x in 0..N {
            let mut avg = 0.;
            for dy in [N - 1, 0, 1] {
                for dx in [N - 1, 0, 1] {
                    avg += log[((y + dy) % N) * N + (x + dx) % N];
                }
            }
            let i = y * N + x;
            spectrum[i] = Complex::from_polar((log[i] - avg / 9.).exp(), spectrum[i].arg());
        }
    }
    // DC carries global brightness, not localized saliency.
    spectrum[0] = Complex::default();
    fft2(&mut spectrum, N, true);
    // image's floating-point filters use 0..1 channels; normalize before resize.
    let peak = spectrum.iter().map(|v| v.norm_sqr()).fold(0., f64::max);
    if peak <= 1e-20 {
        return None;
    }
    let map = image::ImageBuffer::<image::Luma<f32>, _>::from_vec(
        N as u32,
        N as u32,
        spectrum
            .iter()
            .map(|v| (v.norm_sqr() / peak) as f32)
            .collect::<Vec<_>>(),
    )?;
    let map = imageops::blur(&map, 2.5);
    let map = imageops::resize(&map, w as u32, h as u32, imageops::FilterType::Triangle);
    let avg = map.as_raw().iter().map(|v| *v as f64).sum::<f64>() / (w * h) as f64;
    let (mut total, mut sum, mut squares) = (0., 0., 0.);
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let weight = map.get_pixel(x as u32, y as u32)[0] as f64;
            if weight <= 2. * avg {
                continue;
            }
            let i = y * w + x;
            let lap = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4. * g[i];
            total += weight;
            sum += weight * lap;
            squares += weight * lap * lap;
        }
    }
    (total > 1e-12).then(|| (squares / total - (sum / total).powi(2)).max(0.))
}
