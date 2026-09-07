//! P0 Spike S2 — libmpv (via libmpv2-rs) frame-accurate playback feasibility check.
//!
//! Judgement criteria (from docs/specs/2026-08-31-tripcut-design.md §9-S2):
//!   a) hwdec-current == videotoolbox (hardware decode actually engages)
//!   b) frame-step / frame-back-step: estimated-frame-number moves exactly ±1
//!   c) precise seek (`seek <t> absolute+exact`) to 20 random points: p50/p95 latency
//!   d) paused-state frame number / timestamp self-consistency
//!
//! This spike lets mpv open its own native (Cocoa/gpu-next) window rather than
//! embedding in Tauri: the goal is to validate the libmpv *client API*
//! contract (property/command/event behavior under real hw decode + real GPU
//! output), not embedding. An earlier iteration tried `vo=null` (fully
//! headless) and found two problems that make it a worse proxy for the real
//! Tauri render-API integration: (1) `hwdec-current` reported `no` even with
//! `hwdec=videotoolbox` requested — no GPU surface, no hw decode path — so it
//! could not validate criterion (a) at all; (2) `seeking`/frame-step settle
//! signals behave differently without a real video timer driving them.
//! GPU-context-rebuild and crash-isolation under actual NSView embedding are
//! still out of scope for this pass (stage 2, per the task brief).

use libmpv2::events::Event;
use libmpv2::{Mpv, MpvStr};
use rand::Rng;
use std::env;
use std::time::{Duration, Instant};

fn fmt_ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let idx = ((p / 100.0) * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

/// Drain the event queue (non-blocking peek) up to a bounded number of
/// events, so we don't race ahead of mpv's internal state after issuing a
/// command. Bounded so a misbehaving event stream can never hang this.
fn drain_until_idle(mpv: &Mpv, max_events: usize) {
    for _ in 0..max_events {
        match mpv.wait_event(0.0) {
            Some(Ok(_)) => continue,
            _ => break,
        }
    }
}

/// Poll `estimated-frame-number` directly until it changes from `prev` or
/// `timeout` elapses. Used for frame-step / frame-back-step, where an
/// earlier attempt polling the generic `seeking` property produced an
/// alternating 0/1 delta pattern — `seeking` flips back to false before
/// `estimated-frame-number` has actually caught up for single-frame steps,
/// so about half the reads landed one step early. Polling the property we
/// actually care about directly removes that race.
fn wait_for_frame_number_change(mpv: &Mpv, prev: i64, timeout: f64) -> i64 {
    let deadline = Instant::now() + Duration::from_secs_f64(timeout);
    loop {
        drain_until_idle(mpv, 8);
        let now: i64 = mpv.get_property("estimated-frame-number").unwrap_or(prev);
        if now != prev {
            return now;
        }
        if Instant::now() >= deadline {
            return now;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// First attempt used `wait_event` for `Event::PlaybackRestart` as the
/// "operation settled" signal. Observed finding: with `vo=null` (headless),
/// mpv does not reliably emit `PlaybackRestart` for `frame-step` while
/// paused, so that approach blocked for the full per-call timeout on every
/// single step (20+ ops x up to 5s = spike run stalled, looked hung).
/// Property polling on `seeking` is the robust cross-vo signal instead.
fn wait_for_settle(mpv: &Mpv, timeout: f64) -> bool {
    let deadline = Instant::now() + Duration::from_secs_f64(timeout);
    loop {
        drain_until_idle(mpv, 8);
        let seeking: bool = mpv.get_property("seeking").unwrap_or(false);
        if !seeking {
            // one more short grace sleep so estimated-frame-number / time-pos
            // catch up to the just-completed seek/step before we sample them
            std::thread::sleep(Duration::from_millis(15));
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

struct FileReport {
    path: String,
    duration: f64,
    fps: f64,
    hwdec_requested: String,
    hwdec_current: String,
    hwdec_ok: bool,
    step_fwd_deltas: Vec<i64>,
    step_back_deltas: Vec<i64>,
    step_ok: bool,
    seek_latencies_ms: Vec<f64>,
    seek_p50_ms: f64,
    seek_p95_ms: f64,
    seek_ok: bool,
    pause_consistency_ok: bool,
    pause_consistency_notes: Vec<String>,
}

fn run_probe(path: &str) -> Result<FileReport, String> {
    println!("\n=== probing {path} ===");

    // IMPORTANT FINDING (see REPORT.md "hwdec / GPU context" section):
    // A `vo=gpu-next`/`force-window=yes` attempt from this bare Rust binary
    // failed hard: "Failed to initialize macvk context, no NSApplication
    // initialized." libmpv (unlike the mpv CLI, whose own main() bootstraps
    // Cocoa) does NOT start an NSApplication run loop for you — the *host*
    // process must. mpv CLI proved hwdec=videotoolbox itself works correctly
    // on this machine/format (see REPORT.md's separate CLI probe); this
    // harness instead uses vo=null (no window, no NSApplication needed) to
    // exercise the client-API contract for criteria (b)/(c)/(d)
    // deterministically. Tauri already runs its own NSApplication loop, so
    // this is expected to be a non-issue for the real integration — but it
    // is a concrete stage-2 requirement to carry forward, not an assumption.
    let mpv = Mpv::with_initializer(|init| {
        init.set_property("vo", "null")?;
        init.set_property("hwdec", "videotoolbox")?;
        init.set_property("pause", true)?;
        init.set_property("keep-open", "yes")?;
        init.set_property("osc", false)?;
        Ok(())
    })
    .map_err(|e| format!("Mpv::with_initializer failed: {e}"))?;

    mpv.command("loadfile", &[path, "replace"])
        .map_err(|e| format!("loadfile failed: {e}"))?;

    // Wait for FileLoaded + first VideoReconfig so properties are populated.
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut file_loaded = false;
    let mut video_reconfig = false;
    while Instant::now() < deadline && !(file_loaded && video_reconfig) {
        match mpv.wait_event(1.0) {
            Some(Ok(Event::FileLoaded)) => file_loaded = true,
            Some(Ok(Event::VideoReconfig)) => video_reconfig = true,
            Some(Ok(Event::EndFile(reason))) => {
                return Err(format!("file ended before loading completed: {reason:?}"));
            }
            _ => continue,
        }
    }
    if !file_loaded {
        return Err("timed out waiting for FileLoaded".into());
    }
    // Give the decoder a moment to actually decode the first frame(s) so
    // hwdec-current is populated (it can lag VideoReconfig by a frame or two).
    std::thread::sleep(Duration::from_millis(500));
    drain_until_idle(&mpv, 8);

    let duration: f64 = mpv.get_property("duration").unwrap_or(0.0);
    let fps: f64 = mpv.get_property("container-fps").unwrap_or(0.0);
    let hwdec_requested: MpvStr = mpv.get_property("hwdec").unwrap_or_else(|_| {
        panic!("could not read hwdec property")
    });
    let hwdec_current: String = mpv
        .get_property::<MpvStr>("hwdec-current")
        .map(|s| s.to_string())
        .unwrap_or_else(|e| format!("<unreadable: {e}>"));
    let hwdec_ok = hwdec_current.to_lowercase().contains("videotoolbox");

    println!("duration={duration:.3}s fps={fps:.3}");
    println!("hwdec (requested)={} hwdec-current={}", &*hwdec_requested, hwdec_current);

    // --- b) frame-step / frame-back-step exactness ---
    // Start paused, mid-file, away from either boundary.
    let mid = (duration / 2.0).max(0.0);
    mpv.command("seek", &[&format!("{mid:.3}"), "absolute+exact"])
        .map_err(|e| format!("seek to mid failed: {e}"))?;
    wait_for_settle(&mpv, 5.0);
    drain_until_idle(&mpv, 8);

    let mut step_fwd_deltas = Vec::new();
    let start_frame: i64 = mpv.get_property("estimated-frame-number").unwrap_or(-1);
    let mut prev = start_frame;
    for _ in 0..10 {
        mpv.command("frame-step", &[]).map_err(|e| format!("frame-step failed: {e}"))?;
        let now = wait_for_frame_number_change(&mpv, prev, 3.0);
        step_fwd_deltas.push(now - prev);
        prev = now;
    }

    let mut step_back_deltas = Vec::new();
    for _ in 0..10 {
        mpv.command("frame-back-step", &[]).map_err(|e| format!("frame-back-step failed: {e}"))?;
        let now = wait_for_frame_number_change(&mpv, prev, 3.0);
        step_back_deltas.push(now - prev);
        prev = now;
    }
    let step_ok = step_fwd_deltas.iter().all(|&d| d == 1) && step_back_deltas.iter().all(|&d| d == -1);
    println!("frame-step deltas (want all +1): {step_fwd_deltas:?}");
    println!("frame-back-step deltas (want all -1): {step_back_deltas:?}");

    // --- c) precise seek timing, 20 random points ---
    let mut rng = rand::rng();
    let mut seek_latencies_ms = Vec::new();
    let safe_max = (duration - 0.5).max(0.1);
    for i in 0..20 {
        let t: f64 = rng.random_range(0.05..safe_max);
        let start = Instant::now();
        mpv.command("seek", &[&format!("{t:.3}"), "absolute+exact"])
            .map_err(|e| format!("seek #{i} failed: {e}"))?;
        let ok = wait_for_settle(&mpv, 5.0);
        let elapsed = start.elapsed();
        seek_latencies_ms.push(fmt_ms(elapsed));
        if !ok {
            println!("  seek #{i} to {t:.3}s: did NOT settle (seeking still true) within timeout ({:.1}ms elapsed)", fmt_ms(elapsed));
        }
        drain_until_idle(&mpv, 8);
    }
    let mut sorted = seek_latencies_ms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let seek_p50_ms = percentile(&sorted, 50.0);
    let seek_p95_ms = percentile(&sorted, 95.0);
    let seek_ok = seek_p95_ms < 100.0;
    println!("seek latencies (ms): {sorted:?}");
    println!("seek p50={seek_p50_ms:.1}ms p95={seek_p95_ms:.1}ms (target p95<100ms)");

    // --- d) paused-state frame/time consistency ---
    let mut pause_consistency_ok = true;
    let mut pause_consistency_notes = Vec::new();
    for i in 0..5 {
        let t: f64 = rng.random_range(0.05..safe_max);
        mpv.command("seek", &[&format!("{t:.3}"), "absolute+exact"])
            .map_err(|e| format!("consistency seek #{i} failed: {e}"))?;
        wait_for_settle(&mpv, 5.0);
        drain_until_idle(&mpv, 8);
        let paused: bool = mpv.get_property("pause").unwrap_or(false);
        let frame_no: i64 = mpv.get_property("estimated-frame-number").unwrap_or(-1);
        let time_pos: f64 = mpv.get_property("time-pos").unwrap_or(-1.0);
        let expected_frame = if fps > 0.0 { (time_pos * fps).round() as i64 } else { -1 };
        let diff = (expected_frame - frame_no).abs();
        let note = format!(
            "seek target={t:.3}s -> paused={paused} time-pos={time_pos:.4}s frame#={frame_no} expected_frame(time*fps)={expected_frame} diff={diff}"
        );
        println!("  {note}");
        pause_consistency_notes.push(note);
        if !paused || diff > 1 {
            pause_consistency_ok = false;
        }
    }

    Ok(FileReport {
        path: path.to_string(),
        duration,
        fps,
        hwdec_requested: hwdec_requested.to_string(),
        hwdec_current,
        hwdec_ok,
        step_fwd_deltas,
        step_back_deltas,
        step_ok,
        seek_latencies_ms: sorted,
        seek_p50_ms,
        seek_p95_ms,
        seek_ok,
        pause_consistency_ok,
        pause_consistency_notes,
    })
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let files: Vec<String> = if args.len() > 1 {
        args[1..].to_vec()
    } else {
        vec![
            "media/test-4k-hevc.mp4".to_string(),
            "media/test-4k-hevc-10bit.mp4".to_string(),
        ]
    };

    let mut reports = Vec::new();
    let mut had_error = false;

    for f in &files {
        match std::panic::catch_unwind(|| run_probe(f)) {
            Ok(Ok(report)) => reports.push(report),
            Ok(Err(e)) => {
                had_error = true;
                println!("!!! probe error for {f}: {e}");
            }
            Err(_) => {
                had_error = true;
                println!("!!! probe PANICKED for {f} (caught, process survived)");
            }
        }
    }

    println!("\n\n===== SUMMARY =====");
    for r in &reports {
        println!(
            "{}\n  duration={:.2}s fps={:.2}\n  hwdec requested={} current={} -> {}\n  frame-step exact: {}\n  seek p50={:.1}ms p95={:.1}ms -> {}\n  pause/frame consistency: {}\n",
            r.path,
            r.duration,
            r.fps,
            r.hwdec_requested,
            r.hwdec_current,
            if r.hwdec_ok { "OK" } else { "FAIL/NOT-ENGAGED" },
            if r.step_ok { "OK" } else { "FAIL" },
            r.seek_p50_ms,
            r.seek_p95_ms,
            if r.seek_ok { "OK (<100ms p95)" } else { "FAIL (>=100ms p95)" },
            if r.pause_consistency_ok { "OK" } else { "FAIL" },
        );
    }

    if had_error || reports.is_empty() {
        std::process::exit(1);
    }
}
