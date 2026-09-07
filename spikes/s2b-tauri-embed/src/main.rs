//! P0 Spike S2b — libmpv render API embedded into a Tauri 2 window (stage 2
//! of S2, see spikes/s2-libmpv/REPORT.md).
//!
//! S2's headline finding: libmpv's client API does NOT bootstrap an
//! NSApplication / Cocoa run loop on its own — a real GPU-backed vo needs a
//! host that already runs one. Tauri does. This spike closes that loop for
//! real:
//!   1. Get the Tauri window's native NSWindow (`WebviewWindow::ns_window`).
//!   2. Create an `NSOpenGLView` and add it as a subview of the window's
//!      content view, sitting on top of (in front of) the webview.
//!   3. Create an `mpv_render_context` (OpenGL API) bound to that view's
//!      `NSOpenGLContext`, drive it from a dedicated render thread.
//!   4. Reuse S2's measurement protocol (frame-step exactness, seek p50/p95,
//!      pause/frame consistency) against this *real* window + hwdec path,
//!      closing the "seek timing was measured under forced software decode"
//!      gap S2 flagged.
//!
//! GUI harness, not a library: everything happens in `main()` / the setup
//! closure + one background thread. Screenshots of the actually-playing
//! window are taken automatically via `screencapture` at fixed checkpoints
//! and written next to this file.
//!
//! NSOpenGLView/NSOpenGLContext are deprecated in favor of Metal/MetalKit —
//! that's a known, accepted tradeoff for this spike (matches how mpv's
//! render API and IINA's classic integration work; a Metal render path is a
//! separate, larger investigation out of scope here).
#![allow(deprecated)]

use libmpv2::events::Event;
use libmpv2::render::{OpenGLInitParams, RenderContext, RenderParam, RenderParamApiType};
use libmpv2::{Mpv, MpvStr};
use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSOpenGLContext, NSOpenGLPixelFormat, NSOpenGLPixelFormatAttribute,
    NSOpenGLProfileVersion3_2Core, NSOpenGLView, NSWindow, NSWindowOrderingMode,
};
use objc2_foundation::{NSPoint as CGPoint, NSRect as CGRect, NSSize as CGSize};
use rand::Rng;
use std::ffi::{c_void, CString};
use std::ptr::NonNull;
use std::time::{Duration, Instant};
use tauri::Manager;

const NS_OPEN_GLPFA_ACCELERATED: NSOpenGLPixelFormatAttribute = 73;
const NS_OPEN_GLPFA_DOUBLE_BUFFER: NSOpenGLPixelFormatAttribute = 5;
const NS_OPEN_GLPFA_COLOR_SIZE: NSOpenGLPixelFormatAttribute = 8;
const NS_OPEN_GLPFA_DEPTH_SIZE: NSOpenGLPixelFormatAttribute = 12;
const NS_OPEN_GLPFA_OPENGL_PROFILE: NSOpenGLPixelFormatAttribute = 99;

const TEXT_STRIP_HEIGHT: f64 = 140.0;

fn shot_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

/// Bring this window frontmost, then screencapture just its on-screen
/// rectangle to `<name>.png` next to REPORT.md. Best-effort: a failure here
/// must never take down the render loop.
///
/// Three approaches were tried in order, two of them failed — both
/// AppleScript/System Events based:
///   1. `set frontmost of first process whose unix id is $PPID` — wrong
///      pid (targets the launching shell, not this binary).
///   2. `id of window 1 of (first process whose unix id is <this pid>)` for
///      a window-id-based `screencapture -l` — "id of window" is not a
///      valid System Events property on this OS version (hard AppleScript
///      syntax error every time).
///   2b. `set frontmost of process "s2b_tauri_embed" to true` + full-screen
///      capture — syntactically valid and worked once, but is a genuine
///      race: the task brief warned other automation is fighting for focus
///      on this screen, and it showed — a Chrome window (unrelated Vercel
///      deployments tab) won the race and got captured instead, twice.
/// Fixed by going through Tauri's own `WebviewWindow::set_focus()` (a
/// first-party, synchronous, in-process AppKit call routed through Tauri's
/// main-thread dispatcher) instead of a separate osascript process with its
/// own Accessibility-permission and IPC latency — then capturing exactly
/// this window's on-screen rectangle via `screencapture -R x,y,w,h`, which
/// only needs this window to be topmost at that rectangle, not the whole
/// screen to be free of other activity.
fn screenshot(name: &str, window: &tauri::WebviewWindow) {
    let _ = window.set_focus();
    std::thread::sleep(Duration::from_millis(200));
    let _ = window.set_focus();
    std::thread::sleep(Duration::from_millis(150));

    let path = shot_dir().join(format!("{name}.png"));
    let region = match (window.outer_position(), window.outer_size()) {
        (Ok(pos), Ok(size)) => Some((pos.x, pos.y, size.width, size.height)),
        _ => None,
    };
    let out = match region {
        Some((x, y, w, h)) => std::process::Command::new("screencapture")
            .args([
                "-x",
                "-o",
                "-R",
                &format!("{x},{y},{w},{h}"),
                path.to_str().unwrap(),
            ])
            .output(),
        None => {
            println!("[shot] could not read window outer_position/outer_size — falling back to full-screen capture");
            std::process::Command::new("screencapture")
                .args(["-x", "-o", path.to_str().unwrap()])
                .output()
        }
    };
    match out {
        Ok(o) if o.status.success() => println!("[shot] wrote {}", path.display()),
        Ok(o) => println!(
            "[shot] screencapture exited non-zero: {:?} stderr={}",
            o.status,
            String::from_utf8_lossy(&o.stderr)
        ),
        Err(e) => println!("[shot] screencapture failed to spawn: {e}"),
    }
}

fn get_proc_address(_ctx: &(), name: &str) -> *mut c_void {
    let cname = CString::new(name).unwrap();
    unsafe { libc::dlsym(libc::RTLD_DEFAULT, cname.as_ptr()) }
}

/// Everything needed to keep driving the embedded GL surface + mpv instance
/// from the dedicated render/test thread. Built on the main thread (where
/// AppKit object creation must happen), then handed off.
struct EmbedHandles {
    gl_view: Retained<NSOpenGLView>,
    gl_context: Retained<NSOpenGLContext>,
}

// SAFETY (spike-grade, not production): after handoff, only the render
// thread ever touches these objects; the main thread only reads `frame()`
// for logging. Objective-C message sends are not inherently thread-affine
// for objects like NSOpenGLContext/NSOpenGLView as long as we don't fight
// AppKit's own main-thread requirements (we don't call `-update:` or other
// MainThreadMarker-gated selectors from here).
unsafe impl Send for EmbedHandles {}

fn build_embed(window: &NSWindow, mtm: MainThreadMarker) -> EmbedHandles {
    let content_view = window
        .contentView()
        .expect("tauri window has no contentView");
    content_view.setAutoresizesSubviews(true);

    let bounds = content_view.bounds();
    let video_rect = CGRect {
        origin: CGPoint { x: 0.0, y: TEXT_STRIP_HEIGHT },
        size: CGSize {
            width: bounds.size.width,
            height: (bounds.size.height - TEXT_STRIP_HEIGHT).max(1.0),
        },
    };

    let mut attrs: [NSOpenGLPixelFormatAttribute; 9] = [
        NS_OPEN_GLPFA_ACCELERATED,
        NS_OPEN_GLPFA_DOUBLE_BUFFER,
        NS_OPEN_GLPFA_COLOR_SIZE,
        24,
        NS_OPEN_GLPFA_DEPTH_SIZE,
        24,
        NS_OPEN_GLPFA_OPENGL_PROFILE,
        NSOpenGLProfileVersion3_2Core,
        0,
    ];
    let pixel_format = unsafe {
        NSOpenGLPixelFormat::initWithAttributes(
            mtm.alloc(),
            NonNull::new(attrs.as_mut_ptr()).unwrap(),
        )
    }
    .expect("NSOpenGLPixelFormat initWithAttributes failed");

    let gl_view = NSOpenGLView::initWithFrame_pixelFormat(
        mtm.alloc(),
        video_rect,
        Some(&pixel_format),
    )
    .expect("NSOpenGLView initWithFrame:pixelFormat: failed");

    gl_view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );

    // Front-most: sits visually on top of the webview, which still shows
    // through everywhere outside `video_rect` (the bottom text strip).
    content_view.addSubview_positioned_relativeTo(&gl_view, NSWindowOrderingMode::Above, None);

    let gl_context = gl_view
        .openGLContext()
        .expect("NSOpenGLView has no openGLContext after pixel format init");

    println!(
        "[embed] contentView bounds={:?} video_rect={:?}",
        bounds, video_rect
    );

    EmbedHandles { gl_view, gl_context }
}

fn current_pixel_size(gl_view: &NSOpenGLView) -> (i32, i32) {
    let bounds = gl_view.convertRectToBacking(gl_view.bounds());
    (
        bounds.size.width.round().max(1.0) as i32,
        bounds.size.height.round().max(1.0) as i32,
    )
}

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

fn drain_until_idle(mpv: &Mpv, max_events: usize) {
    for _ in 0..max_events {
        match mpv.wait_event(0.0) {
            Some(Ok(_)) => continue,
            _ => break,
        }
    }
}

/// Same pattern as S2's `wait_for_settle` / `wait_for_frame_number_change`,
/// but every poll iteration also pumps one GL frame so the embedded window
/// keeps updating while a measurement is in flight instead of freezing.
fn pump_frame(mpv: &Mpv, render_ctx: &RenderContext, gl_view: &NSOpenGLView, gl_ctx: &NSOpenGLContext) {
    let (w, h) = current_pixel_size(gl_view);
    let _ = render_ctx.render::<()>(0, w, h, true);
    gl_ctx.flushBuffer();
    drain_until_idle(mpv, 8);
}

fn wait_for_frame_number_change(
    mpv: &Mpv,
    render_ctx: &RenderContext,
    gl_view: &NSOpenGLView,
    gl_ctx: &NSOpenGLContext,
    prev: i64,
    timeout: f64,
) -> i64 {
    let deadline = Instant::now() + Duration::from_secs_f64(timeout);
    loop {
        pump_frame(mpv, render_ctx, gl_view, gl_ctx);
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

fn wait_for_settle(
    mpv: &Mpv,
    render_ctx: &RenderContext,
    gl_view: &NSOpenGLView,
    gl_ctx: &NSOpenGLContext,
    timeout: f64,
) -> bool {
    let deadline = Instant::now() + Duration::from_secs_f64(timeout);
    loop {
        pump_frame(mpv, render_ctx, gl_view, gl_ctx);
        let seeking: bool = mpv.get_property("seeking").unwrap_or(false);
        if !seeking {
            std::thread::sleep(Duration::from_millis(15));
            pump_frame(mpv, render_ctx, gl_view, gl_ctx);
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Same "seeking" poll as `wait_for_settle`, but WITHOUT calling render()
/// each iteration. Used to get a seek-latency number that isn't inflated by
/// our own GL render+flushBuffer calls (which can block on vsync) — see
/// REPORT.md for why the render-coupled number came out ~3x higher than
/// S2's software-decode baseline.
fn wait_for_settle_norender(mpv: &Mpv, timeout: f64) -> bool {
    let deadline = Instant::now() + Duration::from_secs_f64(timeout);
    loop {
        drain_until_idle(mpv, 8);
        let seeking: bool = mpv.get_property("seeking").unwrap_or(false);
        if !seeking {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn pump_for(mpv: &Mpv, render_ctx: &RenderContext, gl_view: &NSOpenGLView, gl_ctx: &NSOpenGLContext, dur: Duration) {
    let deadline = Instant::now() + dur;
    while Instant::now() < deadline {
        pump_frame(mpv, render_ctx, gl_view, gl_ctx);
        std::thread::sleep(Duration::from_millis(16));
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
    seek_norender_latencies_ms: Vec<f64>,
    seek_norender_p50_ms: f64,
    seek_norender_p95_ms: f64,
    seek_norender_ok: bool,
    pause_consistency_ok: bool,
    pause_consistency_notes: Vec<String>,
}

fn run_probe(
    mpv: &Mpv,
    render_ctx: &RenderContext,
    gl_view: &NSOpenGLView,
    gl_ctx: &NSOpenGLContext,
    path: &str,
    take_shots: bool,
    window: &tauri::WebviewWindow,
) -> Result<FileReport, String> {
    println!("\n=== probing {path} (embedded, real window, real hwdec path) ===");

    mpv.command("loadfile", &[path, "replace"])
        .map_err(|e| format!("loadfile failed: {e}"))?;

    // NOTE: do NOT use pump_frame()/drain_until_idle() here — they drain the
    // event queue as a side effect and would eat FileLoaded/VideoReconfig
    // before this loop's own wait_event() ever saw them (found by running
    // this: the loading wait timed out every time even though loadfile
    // clearly succeeded, because the "poll + drain" helpers built for the
    // frame-step/seek loops silently consumed the very events this loop was
    // blocking on). Render directly here instead, and read events with
    // wait_event() ourselves.
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut file_loaded = false;
    let mut video_reconfig = false;
    while Instant::now() < deadline && !(file_loaded && video_reconfig) {
        let (w, h) = current_pixel_size(gl_view);
        let _ = render_ctx.render::<()>(0, w, h, true);
        gl_ctx.flushBuffer();
        match mpv.wait_event(0.2) {
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

    // Let it actually play for a few seconds — this is the visual proof
    // (real hwdec-fed frames drawn into the embedded NSOpenGLView).
    mpv.set_property("pause", false).ok();
    pump_for(mpv, render_ctx, gl_view, gl_ctx, Duration::from_secs(3));
    if take_shots {
        screenshot("01-playing", window);
    }

    std::thread::sleep(Duration::from_millis(500));
    drain_until_idle(mpv, 8);

    let duration: f64 = mpv.get_property("duration").unwrap_or(0.0);
    let fps: f64 = mpv.get_property("container-fps").unwrap_or(0.0);
    let hwdec_requested: MpvStr = mpv
        .get_property("hwdec")
        .unwrap_or_else(|_| panic!("could not read hwdec property"));
    let hwdec_current: String = mpv
        .get_property::<MpvStr>("hwdec-current")
        .map(|s| s.to_string())
        .unwrap_or_else(|e| format!("<unreadable: {e}>"));
    let hwdec_ok = hwdec_current.to_lowercase().contains("videotoolbox");

    println!("duration={duration:.3}s fps={fps:.3}");
    println!(
        "hwdec (requested)={} hwdec-current={}",
        &*hwdec_requested, hwdec_current
    );

    // --- b) frame-step / frame-back-step exactness ---
    let mid = (duration / 2.0).max(0.0);
    mpv.set_property("pause", true).ok();
    mpv.command("seek", &[&format!("{mid:.3}"), "absolute+exact"])
        .map_err(|e| format!("seek to mid failed: {e}"))?;
    wait_for_settle(mpv, render_ctx, gl_view, gl_ctx, 5.0);
    if take_shots {
        screenshot("02-paused-midframe", window);
    }

    let mut step_fwd_deltas = Vec::new();
    let start_frame: i64 = mpv.get_property("estimated-frame-number").unwrap_or(-1);
    let mut prev = start_frame;
    for _ in 0..10 {
        mpv.command("frame-step", &[])
            .map_err(|e| format!("frame-step failed: {e}"))?;
        let now = wait_for_frame_number_change(mpv, render_ctx, gl_view, gl_ctx, prev, 3.0);
        step_fwd_deltas.push(now - prev);
        prev = now;
    }

    let mut step_back_deltas = Vec::new();
    for _ in 0..10 {
        mpv.command("frame-back-step", &[])
            .map_err(|e| format!("frame-back-step failed: {e}"))?;
        let now = wait_for_frame_number_change(mpv, render_ctx, gl_view, gl_ctx, prev, 3.0);
        step_back_deltas.push(now - prev);
        prev = now;
    }
    let step_ok =
        step_fwd_deltas.iter().all(|&d| d == 1) && step_back_deltas.iter().all(|&d| d == -1);
    println!("frame-step deltas (want all +1): {step_fwd_deltas:?}");
    println!("frame-back-step deltas (want all -1): {step_back_deltas:?}");

    // --- c) precise seek timing, 20 random points (real hwdec path) ---
    let mut rng = rand::rng();
    let mut seek_latencies_ms = Vec::new();
    let safe_max = (duration - 0.5).max(0.1);
    for i in 0..20 {
        let t: f64 = rng.random_range(0.05..safe_max);
        let start = Instant::now();
        mpv.command("seek", &[&format!("{t:.3}"), "absolute+exact"])
            .map_err(|e| format!("seek #{i} failed: {e}"))?;
        let ok = wait_for_settle(mpv, render_ctx, gl_view, gl_ctx, 5.0);
        let elapsed = start.elapsed();
        seek_latencies_ms.push(fmt_ms(elapsed));
        if !ok {
            println!(
                "  seek #{i} to {t:.3}s: did NOT settle within timeout ({:.1}ms elapsed)",
                fmt_ms(elapsed)
            );
        }
    }
    let mut sorted = seek_latencies_ms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let seek_p50_ms = percentile(&sorted, 50.0);
    let seek_p95_ms = percentile(&sorted, 95.0);
    let seek_ok = seek_p95_ms < 100.0;
    println!("seek latencies (ms): {sorted:?}");
    println!("seek p50={seek_p50_ms:.1}ms p95={seek_p95_ms:.1}ms (target p95<100ms)");

    // --- c-bis) same 20-point seek benchmark, but WITHOUT forcing a GL
    // render() on every poll iteration — isolates mpv's own seek latency
    // from our render+flushBuffer overhead in the loop above.
    let mut seek_norender_latencies_ms = Vec::new();
    for i in 0..20 {
        let t: f64 = rng.random_range(0.05..safe_max);
        let start = Instant::now();
        mpv.command("seek", &[&format!("{t:.3}"), "absolute+exact"])
            .map_err(|e| format!("norender seek #{i} failed: {e}"))?;
        let ok = wait_for_settle_norender(mpv, 5.0);
        let elapsed = start.elapsed();
        seek_norender_latencies_ms.push(fmt_ms(elapsed));
        if !ok {
            println!(
                "  norender seek #{i} to {t:.3}s: did NOT settle within timeout ({:.1}ms elapsed)",
                fmt_ms(elapsed)
            );
        }
    }
    // One render pass to refresh the window after the no-render loop above
    // (which never called render(), so the view would otherwise show a
    // stale frame from before it started).
    pump_frame(mpv, render_ctx, gl_view, gl_ctx);
    let mut sorted_nr = seek_norender_latencies_ms.clone();
    sorted_nr.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let seek_norender_p50_ms = percentile(&sorted_nr, 50.0);
    let seek_norender_p95_ms = percentile(&sorted_nr, 95.0);
    let seek_norender_ok = seek_norender_p95_ms < 100.0;
    println!("seek (no forced render) latencies (ms): {sorted_nr:?}");
    println!(
        "seek (no forced render) p50={seek_norender_p50_ms:.1}ms p95={seek_norender_p95_ms:.1}ms (target p95<100ms)"
    );

    // --- d) paused-state frame/time consistency ---
    let mut pause_consistency_ok = true;
    let mut pause_consistency_notes = Vec::new();
    for i in 0..5 {
        let t: f64 = rng.random_range(0.05..safe_max);
        mpv.command("seek", &[&format!("{t:.3}"), "absolute+exact"])
            .map_err(|e| format!("consistency seek #{i} failed: {e}"))?;
        wait_for_settle(mpv, render_ctx, gl_view, gl_ctx, 5.0);
        let paused: bool = mpv.get_property("pause").unwrap_or(false);
        let frame_no: i64 = mpv.get_property("estimated-frame-number").unwrap_or(-1);
        let time_pos: f64 = mpv.get_property("time-pos").unwrap_or(-1.0);
        let expected_frame = if fps > 0.0 {
            (time_pos * fps).round() as i64
        } else {
            -1
        };
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
    if take_shots {
        screenshot("03-after-measurements", window);
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
        seek_norender_latencies_ms: sorted_nr,
        seek_norender_p50_ms,
        seek_norender_p95_ms,
        seek_norender_ok,
        pause_consistency_ok,
        pause_consistency_notes,
    })
}

fn run_resize_probe(
    mpv: &Mpv,
    render_ctx: &RenderContext,
    gl_view: &NSOpenGLView,
    gl_ctx: &NSOpenGLContext,
    window: &tauri::WebviewWindow,
) {
    println!("\n=== resize probe (criterion d: video area follows window resize) ===");
    let before = gl_view.frame();
    println!("[resize] gl_view frame before = {before:?}");
    mpv.set_property("pause", false).ok();
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: 1400.0,
        height: 940.0,
    }));
    pump_for(mpv, render_ctx, gl_view, gl_ctx, Duration::from_millis(900));
    let after = gl_view.frame();
    println!("[resize] gl_view frame after resize to 1400x940 = {after:?}");
    screenshot("04-resized", window);
    let grew = after.size.width > before.size.width + 50.0
        && after.size.height > before.size.height + 50.0;
    println!(
        "[resize] video area grew with window: {} (before={:?} after={:?})",
        grew, before.size, after.size
    );
    mpv.set_property("pause", true).ok();
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let mtm = MainThreadMarker::new().expect("setup runs on the main thread");
            let window = app
                .get_webview_window("main")
                .expect("main window not found");
            let ns_window_ptr = window.ns_window().expect("ns_window() failed");
            let ns_window: Retained<NSWindow> =
                unsafe { Retained::retain_autoreleased(ns_window_ptr as *mut NSWindow) }
                    .expect("ns_window pointer was null");

            let embed = build_embed(&ns_window, mtm);
            let gl_view = embed.gl_view.clone();
            let gl_ctx = embed.gl_context.clone();

            let window_for_thread = window.clone();
            std::thread::spawn(move || {
                let embed = embed; // move handles into this thread
                embed.gl_context.makeCurrentContext();

                let files: Vec<String> = {
                    let mut args = std::env::args().skip(1).peekable();
                    if args.peek().is_some() {
                        args.collect()
                    } else {
                        vec!["media/test-4k-hevc.mp4".to_string()]
                    }
                };

                let mpv = Mpv::with_initializer(|init| {
                    init.set_property("vo", "libmpv")?;
                    init.set_property("hwdec", "videotoolbox")?;
                    init.set_property("keep-open", "yes")?;
                    init.set_property("osc", false)?;
                    init.set_property("pause", true)?;
                    Ok(())
                })
                .expect("Mpv::with_initializer failed");

                let render_ctx = mpv
                    .create_render_context(vec![
                        RenderParam::ApiType(RenderParamApiType::OpenGl),
                        RenderParam::InitParams(OpenGLInitParams {
                            get_proc_address,
                            ctx: (),
                        }),
                    ])
                    .expect("create_render_context (OpenGL) failed — this is the load-bearing checkpoint for the whole spike");

                println!("[render] mpv render context created OK — embedding + NSApplication precondition confirmed");

                let mut reports = Vec::new();
                let mut had_error = false;
                for (i, f) in files.iter().enumerate() {
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        run_probe(&mpv, &render_ctx, &embed.gl_view, &embed.gl_context, f, i == 0, &window_for_thread)
                    })) {
                        Ok(Ok(r)) => reports.push(r),
                        Ok(Err(e)) => {
                            had_error = true;
                            println!("!!! probe error for {f}: {e}");
                        }
                        Err(_) => {
                            had_error = true;
                            println!("!!! probe PANICKED for {f} (caught, process survived — crash isolation partially confirmed)");
                        }
                    }
                }

                run_resize_probe(&mpv, &render_ctx, &embed.gl_view, &embed.gl_context, &window_for_thread);

                println!("\n\n===== SUMMARY (S2b, embedded in Tauri, real hwdec path) =====");
                for r in &reports {
                    println!(
                        "{}\n  duration={:.2}s fps={:.2}\n  hwdec requested={} current={} -> {}\n  frame-step exact: {}\n  seek(render-coupled) p50={:.1}ms p95={:.1}ms -> {}\n  seek(no forced render) p50={:.1}ms p95={:.1}ms -> {}\n  pause/frame consistency: {}\n",
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
                        r.seek_norender_p50_ms,
                        r.seek_norender_p95_ms,
                        if r.seek_norender_ok { "OK (<100ms p95)" } else { "FAIL (>=100ms p95)" },
                        if r.pause_consistency_ok { "OK" } else { "FAIL" },
                    );
                }
                println!("had_error={had_error}");
                println!("DONE — exiting in 2s");
                std::thread::sleep(Duration::from_secs(2));
                std::process::exit(if had_error { 1 } else { 0 });
            });

            let _ = (&gl_view, &gl_ctx); // keep clones alive on main thread for symmetry / future use
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
