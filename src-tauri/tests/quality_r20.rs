use image::{Rgb, RgbImage};
use tripcut_studio_lib::core::{analysis::measure_quality, moments::MomentWeights};

#[test]
fn quality_r20_hough_rotation_and_unknown() {
    for angle in [0_f64, 3., 7., -3., -7., 90., 87., 83.] {
        let a = angle.to_radians();
        let frame = RgbImage::from_fn(240, 240, |x, y| {
            let side = (y as f64 - 120.) * a.cos() - (x as f64 - 120.) * a.sin();
            Rgb([if side > 0. { 190 } else { 60 }; 3])
        });
        let actual = measure_quality(&frame).horizon_tilt_deg.unwrap();
        let truth = angle.abs().min((90. - angle.abs()).abs());
        assert!((actual - truth).abs() <= 2., "{angle}: {actual}");
    }
    assert_eq!(
        measure_quality(&RgbImage::from_pixel(90, 90, Rgb([128; 3]))).horizon_tilt_deg,
        None
    );
}

#[test]
fn quality_r20_exposure_local_clipping_and_small_images() {
    for (pixel, expected) in [(255, "over"), (0, "under"), (128, "normal")] {
        let frame = RgbImage::from_fn(91, 89, |x, y| {
            Rgb([if x < 30 && y < 29 { pixel } else { 128 }; 3])
        });
        let q = measure_quality(&frame);
        assert_eq!(q.exposure_worst_cell.status, expected);
        assert_eq!(q.exposure_worst_cell.cells.len(), 9);
    }
    for (w, h) in [(0, 0), (1, 1), (2, 9)] {
        let q = measure_quality(&RgbImage::from_pixel(w, h, Rgb([128; 3])));
        assert!(serde_json::to_value(q).is_ok());
    }
}

#[test]
fn quality_r20_saliency_focus_and_flat_unknown() {
    let sharp = RgbImage::from_fn(240, 180, |x, y| {
        let p = if (80..160).contains(&x) && (50..130).contains(&y) {
            if (x / 4 + y / 4) % 2 == 0 {
                220
            } else {
                50
            }
        } else {
            110
        };
        Rgb([p; 3])
    });
    let blurred = image::imageops::blur(&sharp, 3.);
    let a = measure_quality(&sharp).saliency_sharpness.unwrap();
    let b = measure_quality(&blurred).saliency_sharpness.unwrap();
    assert!(a > b * 3., "sharp={a} blur={b}");
    assert_eq!(
        measure_quality(&RgbImage::from_pixel(64, 64, Rgb([128; 3]))).saliency_sharpness,
        None
    );
}

#[test]
fn quality_r20_weights_default_zero_and_old_settings_compatible() {
    let weights = serde_json::to_value(MomentWeights::default()).unwrap();
    for key in [
        "horizon_tilt_deg",
        "exposure_worst_cell",
        "saliency_sharpness",
    ] {
        assert_eq!(weights[key], 0.);
        assert!(MomentWeights::parse(&format!("{{\"{key}\":0.6}}")).is_ok());
        assert!(MomentWeights::parse(&format!("{{\"{key}\":1.1}}")).is_err());
    }
    assert_eq!(
        MomentWeights::parse("{\"interest\":0.2}").unwrap(),
        MomentWeights::default()
    );
}

#[test]
fn quality_r20_truth_columns_exist_without_inventing_real_labels() {
    let manifest = include_str!("../../qa/ai-eval/manifest.tsv");
    let header = manifest.lines().find(|s| !s.starts_with('#')).unwrap();
    for key in [
        "horizon_tilt_deg",
        "exposure_worst_cell",
        "saliency_sharpness",
    ] {
        assert!(header.split('\t').any(|s| s == key));
    }
}

#[test]
fn quality_r20_best_window_iou_zero_weight_regression_lock() {
    use tripcut_studio_lib::core::{moments::*, smart_select::suggest_from_moments};
    let added = MomentWeights::parse(
        r#"{"horizon_tilt_deg":0,"exposure_worst_cell":0,"saliency_sharpness":0}"#,
    )
    .unwrap();
    let pending = MomentWeights::parse(
        r#"{"horizon_tilt_deg":1,"exposure_worst_cell":1,"saliency_sharpness":1}"#,
    )
    .unwrap();
    for seed in 0..24 {
        let source = MomentSource {
            clip_id: seed,
            quick_hash: "fixture".into(),
            tb_num: 1,
            tb_den: 1000,
            duration_ticks: 12000,
            has_audio: false,
        };
        let start = 2 + seed % 5;
        let signals = WindowSignals {
            video: (0..24)
                .map(|i| {
                    let good = i >= start && i < start + 8;
                    VideoWindow {
                        t_secs: i as f64 * 0.5,
                        yavg: 110.,
                        ylow: 30.,
                        yhigh: 180.,
                        ymax: 200.,
                        blur: if good { 3. } else { 12. },
                        entropy: 5.,
                        motion: if good { 15. } else { 0. },
                    }
                })
                .collect(),
            ..Default::default()
        };
        let before = compute_moments(&source, &signals, &[], &MomentWeights::default());
        // Independent frozen six-axis formula, with no audio/CLIP; catches denominator drift.
        for m in &before {
            let legacy = (0.24 * m.sharp + 0.20 * motion_moderation(m.motion) + 0.16 + 0.08)
                / (0.24 + 0.20 + 0.16 + 0.08);
            assert!((m.score - legacy).abs() < 1e-15);
        }
        for weights in [added, pending] {
            let after = compute_moments(&source, &signals, &[], &weights);
            assert_eq!(before, after);
            let a = suggest_from_moments(&before, 4., 1).remove(0);
            let b = suggest_from_moments(&after, 4., 1).remove(0);
            assert_eq!((a.in_ticks, a.out_ticks), (b.in_ticks, b.out_ticks));
            let truth = (start * 500, (start + 8) * 500);
            let iou = |lo: i64, hi: i64| {
                ((hi.min(truth.1) - lo.max(truth.0)).max(0) as f64)
                    / (hi.max(truth.1) - lo.min(truth.0)) as f64
            };
            assert_eq!(iou(a.in_ticks, a.out_ticks), 1.0);
            assert_eq!(iou(a.in_ticks, a.out_ticks), iou(b.in_ticks, b.out_ticks));
        }
    }
    println!("IoU regression: 24/24 same windows, score max delta=0, IoU before=1.0 after=1.0 delta=0; zero weights and saved-but-inactive weights");
}

#[test]
#[ignore = "explicit deterministic fixture generation; writes only qa/ai-eval/quality"]
fn quality_r20_generate_fixtures() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../qa/ai-eval/quality");
    std::fs::create_dir_all(&root).unwrap();
    let mut manifest = String::from("# Synthetic construction truth, not human ratings of real footage. Focus grade 5..1 = sigma 0,0.7,1.2,2,3.5.\nfile\thorizon_tilt_deg\texposure_worst_cell\tsaliency_sharpness\tgroup\n");
    let mut save = |name: String,
                    img: RgbImage,
                    angle: String,
                    exposure: &str,
                    focus: String,
                    group: String| {
        img.save(root.join(&name)).unwrap();
        manifest.push_str(&format!("{name}\t{angle}\t{exposure}\t{focus}\t{group}\n"));
    };
    for n in 0..24 {
        let deg: f64 = if n % 2 == 0 { 3. } else { 7. };
        let rotation = (if n % 4 < 2 { deg } else { -deg }) + if n >= 12 { 90. } else { 0. };
        let a = rotation.to_radians();
        let img = RgbImage::from_fn(240, 240, |x, y| {
            let side =
                (y as f64 - 100. - (n % 6) as f64 * 7.) * a.cos() - (x as f64 - 120.) * a.sin();
            Rgb([if side > 0. {
                180 + n as u8
            } else {
                50 + n as u8
            }; 3])
        });
        save(
            format!("tilt-{n:02}.png"),
            img,
            deg.to_string(),
            "normal",
            "*".into(),
            "tilt".into(),
        );
    }
    for n in 0..27 {
        let mode = n / 9;
        let img = RgbImage::from_fn(240, 180, |x, y| {
            let cell = y / 60 * 3 + x / 80;
            Rgb([if cell == n % 9 {
                [255, 0, 128][mode as usize]
            } else {
                125 + ((x + y) % 5) as u8
            }; 3])
        });
        save(
            format!("exposure-{n:02}.png"),
            img,
            "*".into(),
            ["over", "under", "normal"][mode as usize],
            "*".into(),
            "exposure".into(),
        );
    }
    for group in 0..4 {
        let sharp = RgbImage::from_fn(240, 180, |x, y| {
            let cx = 60 + group * 30;
            Rgb([if (cx..cx + 60).contains(&x) && (50..130).contains(&y) {
                if (x / 4 + y / 4) % 2 == 0 {
                    220
                } else {
                    40
                }
            } else {
                110
            }; 3])
        });
        for (index, sigma) in [0., 0.7, 1.2, 2., 3.5].into_iter().enumerate() {
            let img = if sigma == 0. {
                sharp.clone()
            } else {
                image::imageops::blur(&sharp, sigma)
            };
            save(
                format!("focus-{group}-{index}.png"),
                img,
                "*".into(),
                "normal",
                (5 - index).to_string(),
                format!("focus-{group}"),
            );
        }
    }
    std::fs::write(root.join("manifest.tsv"), manifest).unwrap();
}

#[test]
fn quality_r20_fixture_baseline() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../qa/ai-eval/quality");
    let text = std::fs::read_to_string(root.join("manifest.tsv")).unwrap();
    let mut angles = Vec::new();
    let mut exposure = [0_usize; 2];
    let mut focus = std::collections::BTreeMap::<String, Vec<(f64, f64)>>::new();
    for row in text.lines().filter(|s| !s.starts_with('#')).skip(1) {
        let c: Vec<_> = row.split('\t').collect();
        let q = measure_quality(&image::open(root.join(c[0])).unwrap().to_rgb8());
        if let Ok(truth) = c[1].parse::<f64>() {
            angles.push((q.horizon_tilt_deg.unwrap() - truth).abs());
        }
        if c[2] != "*" {
            exposure[1] += 1;
            exposure[0] += usize::from(q.exposure_worst_cell.status == c[2]);
        }
        if let Ok(truth) = c[3].parse::<f64>() {
            focus
                .entry(c[4].into())
                .or_default()
                .push((truth, q.saliency_sharpness.unwrap()));
        }
    }
    assert!(
        angles.len() >= 18
            && exposure[1] >= 18
            && focus.values().map(Vec::len).sum::<usize>() >= 18
    );
    assert!(angles.iter().all(|e| *e <= 2.));
    assert_eq!(exposure[0], exposure[1]);
    let mut pairs = 0;
    let mut correct = 0;
    for rows in focus.values() {
        for (i, a) in rows.iter().enumerate() {
            for b in &rows[i + 1..] {
                pairs += 1;
                correct += usize::from((a.0 - b.0) * (a.1 - b.1) > 0.);
            }
        }
    }
    assert_eq!(
        correct, pairs,
        "focus ordering must follow independently prescribed blur levels"
    );
    println!("horizon n={} MAE={:.4} max={:.4} recall±2={}/{}; exposure={}/{}; focus ordinal={}/{} pairs (20 samples)",angles.len(),angles.iter().sum::<f64>()/angles.len() as f64, angles.iter().copied().fold(0.,f64::max), angles.iter().filter(|e| **e<=2.).count(),angles.len(),exposure[0],exposure[1],correct,pairs);
}
