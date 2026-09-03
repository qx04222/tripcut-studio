//! Reusable libmpv-backed player for the macOS review workspace.
//!
//! AppKit owns surface creation/removal on the main thread. The `Mpv`, render
//! context and OpenGL context are then kept on one dedicated worker thread.
//! libmpv callbacks never render or call the client API; they only enqueue a
//! coalesced wake-up for that worker.

#![allow(deprecated)]

use std::ffi::{c_void, CString};
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use libmpv2::events::{Event, PropertyData};
use libmpv2::render::{mpv_render_update, OpenGLInitParams, RenderContext, RenderParam, RenderParamApiType};
use libmpv2::{Format, Mpv};
use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSOpenGLContext, NSOpenGLPixelFormat,
    NSOpenGLPixelFormatAttribute, NSOpenGLProfileVersion3_2Core, NSOpenGLView, NSWindow,
    NSWindowOrderingMode,
};
use objc2_foundation::{NSPoint as CGPoint, NSRect as CGRect, NSSize as CGSize};
use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

const NS_OPEN_GLPFA_ACCELERATED: NSOpenGLPixelFormatAttribute = 73;
const NS_OPEN_GLPFA_DOUBLE_BUFFER: NSOpenGLPixelFormatAttribute = 5;
const NS_OPEN_GLPFA_COLOR_SIZE: NSOpenGLPixelFormatAttribute = 8;
const NS_OPEN_GLPFA_DEPTH_SIZE: NSOpenGLPixelFormatAttribute = 12;
const NS_OPEN_GLPFA_OPENGL_PROFILE: NSOpenGLPixelFormatAttribute = 99;

const START_TIMEOUT: Duration = Duration::from_secs(5);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);

const OBSERVE_POSITION: u64 = 1;
const OBSERVE_DURATION: u64 = 2;
const OBSERVE_PAUSED: u64 = 3;
const OBSERVE_FRAME: u64 = 4;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub struct PlayerViewport {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl PlayerViewport {
    fn validate(self) -> Result<Self, String> {
        if ![self.x, self.y, self.width, self.height]
            .into_iter()
            .all(f64::is_finite)
        {
            return Err("播放器区域包含无效坐标".to_owned());
        }
        if self.x < 0.0 || self.y < 0.0 || self.width < 2.0 || self.height < 2.0 {
            return Err("播放器区域尺寸无效".to_owned());
        }
        Ok(self)
    }
}

impl Default for PlayerViewport {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: 960.0,
            height: 540.0,
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PlayerCommand {
    Play,
    Pause,
    StepFwd,
    StepBack,
    SeekAbs { seconds: f64 },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PlayerStatus {
    pub phase: String,
    pub clip_id: Option<i64>,
    pub pos: f64,
    pub duration: f64,
    pub paused: bool,
    pub frame: Option<i64>,
    pub error: Option<String>,
    pub seek_samples: usize,
    pub seek_p50_ms: Option<f64>,
    pub seek_p95_ms: Option<f64>,
    pub last_seek_ms: Option<f64>,
}

impl PlayerStatus {
    fn closed() -> Self {
        Self {
            phase: "closed".to_owned(),
            clip_id: None,
            pos: 0.0,
            duration: 0.0,
            paused: true,
            frame: None,
            error: None,
            seek_samples: 0,
            seek_p50_ms: None,
            seek_p95_ms: None,
            last_seek_ms: None,
        }
    }

    fn loading(clip_id: i64) -> Self {
        Self {
            phase: "loading".to_owned(),
            clip_id: Some(clip_id),
            ..Self::closed()
        }
    }

    fn mark_ready(&mut self) {
        self.phase = "ready".to_owned();
        self.error = None;
    }

    fn fail(&mut self, message: String) {
        self.phase = "error".to_owned();
        self.paused = true;
        self.error = Some(message);
    }

    fn record_seek(&mut self, elapsed_ms: f64, samples: &[f64]) {
        self.last_seek_ms = Some(elapsed_ms);
        self.seek_samples = samples.len();
        self.seek_p50_ms = percentile(samples, 0.50);
        self.seek_p95_ms = percentile(samples, 0.95);
    }
}

fn percentile(samples: &[f64], quantile: f64) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = (quantile.clamp(0.0, 1.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted.get(index).copied()
}

#[derive(Clone)]
pub struct PlayerManager {
    window: WebviewWindow,
    state: Arc<Mutex<ManagerState>>,
    operation: Arc<Mutex<()>>,
    // 关闭超时(3s 内未 ack 且线程未结束)不再 detach JoinHandle:那样会让
    // manager 彻底失去这条渲染线程的引用,旧 view/thread 永远无法回收
    // （回归修复）。改为把 session 挪进这里继续追踪,等线程真正退出后
    // 由 reap_orphans() 补上 join() 并释放,不再无声丢失。
    orphans: Arc<Mutex<Vec<PlayerSession>>>,
}

struct ManagerState {
    viewport: PlayerViewport,
    session: Option<PlayerSession>,
}

struct PlayerSession {
    sender: mpsc::Sender<WorkerMessage>,
    status: Arc<Mutex<PlayerStatus>>,
    worker: Option<JoinHandle<()>>,
}

/// 回收已经真正退出的孤儿渲染线程:join() 拿回它们的终止状态并释放
/// JoinHandle,仍在跑(卡死在原生 teardown)的继续留在池里等下次再查。
fn reap_orphans(orphans: &mut Vec<PlayerSession>) {
    orphans.retain_mut(|session| match session.worker.take() {
        Some(worker) if worker.is_finished() => {
            let _ = worker.join();
            false
        }
        Some(worker) => {
            session.worker = Some(worker);
            true
        }
        None => false,
    });
}

enum WorkerMessage {
    RenderWake,
    ForceRedraw,
    Resize(PlayerViewport, mpsc::Sender<Result<(), String>>),
    EventsWake,
    Command(PlayerCommand, mpsc::Sender<Result<(), String>>),
    Shutdown(mpsc::Sender<()>),
}

impl PlayerManager {
    pub fn new(window: WebviewWindow) -> Self {
        Self {
            window,
            state: Arc::new(Mutex::new(ManagerState {
                viewport: PlayerViewport::default(),
                session: None,
            })),
            operation: Arc::new(Mutex::new(())),
            orphans: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn set_viewport(&self, viewport: PlayerViewport) -> Result<(), String> {
        let viewport = viewport.validate()?;
        let _operation = lock(&self.operation);
        let mut state = lock(&self.state);
        state.viewport = viewport;
        let sender = state
            .session
            .as_ref()
            .map(|session| session.sender.clone());
        drop(state);
        let Some(sender) = sender else {
            return Ok(());
        };
        let (reply_sender, reply_receiver) = mpsc::channel();
        sender
            .send(WorkerMessage::Resize(viewport, reply_sender))
            .map_err(|_| "播放器渲染线程已退出".to_owned())?;
        reply_receiver
            .recv_timeout(COMMAND_TIMEOUT)
            .map_err(|_| "播放器区域更新超时".to_owned())?
    }

    pub fn open(
        &self,
        path: PathBuf,
        clip_id: i64,
        time_mapper: Option<crate::core::canonical_time::ProxyTimeMapper>,
    ) -> Result<PlayerStatus, String> {
        let _operation = lock(&self.operation);
        reap_orphans(&mut lock(&self.orphans));
        self.stop_current()?;

        let viewport = lock(&self.state).viewport;
        let status = Arc::new(Mutex::new(PlayerStatus::loading(clip_id)));
        let (sender, receiver) = mpsc::channel();
        let (started_sender, started_receiver) = mpsc::channel();
        let worker_status = Arc::clone(&status);
        let window = self.window.clone();
        let callback_sender = sender.clone();
        let worker = thread::Builder::new()
            .name("tripcut-player-render".to_owned())
            .spawn(move || {
                worker_entry(
                    window,
                    viewport,
                    path,
                    time_mapper,
                    worker_status,
                    receiver,
                    callback_sender,
                    started_sender,
                );
            })
            .map_err(|error| format!("无法启动播放器渲染线程：{error}"))?;

        let session = PlayerSession {
            sender,
            status: Arc::clone(&status),
            worker: Some(worker),
        };
        lock(&self.state).session = Some(session);

        match started_receiver.recv_timeout(START_TIMEOUT) {
            Ok(Ok(())) => Ok(lock(&status).clone()),
            Ok(Err(error)) => {
                let _ = self.stop_current();
                Err(error)
            }
            Err(_) => {
                let _ = self.stop_current();
                Err("播放器启动超时".to_owned())
            }
        }
    }

    pub fn command(&self, command: PlayerCommand) -> Result<(), String> {
        if let PlayerCommand::SeekAbs { seconds } = &command {
            if !seconds.is_finite() || *seconds < 0.0 {
                return Err("seek_abs 需要非负有限秒数".to_owned());
            }
        }

        let _operation = lock(&self.operation);
        let sender = lock(&self.state)
            .session
            .as_ref()
            .map(|session| session.sender.clone())
            .ok_or_else(|| "播放器尚未打开".to_owned())?;
        let (reply_sender, reply_receiver) = mpsc::channel();
        sender
            .send(WorkerMessage::Command(command, reply_sender))
            .map_err(|_| "播放器渲染线程已退出".to_owned())?;
        reply_receiver
            .recv_timeout(COMMAND_TIMEOUT)
            .map_err(|_| "播放器命令响应超时".to_owned())?
    }

    pub fn close(&self) -> Result<(), String> {
        let _operation = lock(&self.operation);
        reap_orphans(&mut lock(&self.orphans));
        self.stop_current()
    }

    /// 仍在等待原生 teardown 真正结束、尚未被 reap 的孤儿渲染线程数——
    /// 用于诊断/测试:关闭超时后不应无声消失,必须能被外部观察到。
    pub fn orphan_count(&self) -> usize {
        lock(&self.orphans).len()
    }

    pub fn status(&self) -> PlayerStatus {
        let state = lock(&self.state);
        state
            .session
            .as_ref()
            .map(|session| lock(&session.status).clone())
            .unwrap_or_else(PlayerStatus::closed)
    }

    pub fn request_redraw(&self) {
        if let Some(sender) = lock(&self.state)
            .session
            .as_ref()
            .map(|session| session.sender.clone())
        {
            let _ = sender.send(WorkerMessage::ForceRedraw);
        }
    }

    fn stop_current(&self) -> Result<(), String> {
        let session = lock(&self.state).session.take();
        if let Some(mut session) = session {
            let (reply_sender, reply_receiver) = mpsc::channel();
            let sent = session
                .sender
                .send(WorkerMessage::Shutdown(reply_sender))
                .is_ok();
            let acknowledged = sent && reply_receiver.recv_timeout(CLOSE_TIMEOUT).is_ok();
            if let Some(worker) = session.worker.take() {
                if !sent || acknowledged || worker.is_finished() {
                    let _ = worker.join();
                } else {
                    // 超时:不能在这里阻塞 Tauri 执行器等一条卡死的原生
                    // teardown,但也不能像过去那样直接 drop 掉 JoinHandle——
                    // 那样 manager 就再没有任何引用能确认这条线程/原生 view
                    // 何时才真正退出（回归修复）。把它挪进 orphans 继续
                    // 追踪,下次 open()/close() 时 reap_orphans() 会在线程
                    // 真正结束后补上 join() 并释放。
                    session.worker = Some(worker);
                    lock(&self.orphans).push(session);
                    return Err("播放器关闭超时，渲染线程已隔离退出流程".to_owned());
                }
            }
        }
        Ok(())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Resolve a database clip to the original, absolute, currently reachable path.
/// External volumes are resolved by UUID and the candidate is size/hash verified
/// before playback. A same-label replacement disk is never accepted implicitly.
pub fn resolve_clip_path(db_path: &Path, clip_id: i64) -> Result<PathBuf, String> {
    let connection = crate::core::db::open_project(db_path).map_err(|error| error.to_string())?;
    crate::core::media_source::verified_clip_path(&connection, clip_id)
        .map_err(|error| error.to_string())
}

pub fn resolve_playback_source(
    db_path: &Path,
    cache_root: &Path,
    clip_id: i64,
) -> Result<(PathBuf, Option<crate::core::canonical_time::ProxyTimeMapper>), String> {
    use rusqlite::OptionalExtension;

    let connection = crate::core::db::open_project(db_path).map_err(|error| error.to_string())?;
    let proxy_rel_path = if crate::core::settings::proxy_enabled(&connection)
        .map_err(|error| error.to_string())?
    {
        connection
        .query_row(
            "SELECT artifact.rel_path
             FROM cache_artifacts artifact
             JOIN clips clip ON clip.id = artifact.clip_id
             WHERE artifact.clip_id = ?1 AND artifact.kind = 'proxy'
               AND artifact.source_hash = clip.quick_hash",
            [clip_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
    } else {
        None
    };
    if let Some(rel_path) = proxy_rel_path {
        let proxy_path = cache_root.join(rel_path);
        if proxy_path.is_file() {
            let mapper = crate::core::canonical_time::load_proxy_mapper(&connection, clip_id)
                .map_err(|error| error.to_string())?;
            if mapper.is_some() {
                return Ok((proxy_path, mapper));
            }
        }
    }
    let source = crate::core::media_source::verified_clip_path(&connection, clip_id)
        .map_err(|error| error.to_string())?;
    Ok((source, None))
}

fn create_surface(window: &WebviewWindow, viewport: PlayerViewport) -> Result<RenderSurface, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let window_for_main = window.clone();
    window
        .run_on_main_thread(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                build_surface(&window_for_main, viewport)
            }))
            .unwrap_or_else(|payload| Err(format!("创建播放器原生视图时 panic：{}", panic_text(payload))));
            let _ = sender.send(result);
        })
        .map_err(|error| format!("无法派发播放器视图创建：{error}"))?;
    receiver
        .recv_timeout(START_TIMEOUT)
        .map_err(|_| "创建播放器原生视图超时".to_owned())?
}

fn build_surface(window: &WebviewWindow, viewport: PlayerViewport) -> Result<RenderSurface, String> {
    let mtm = MainThreadMarker::new().ok_or_else(|| "播放器视图未运行在 AppKit 主线程".to_owned())?;
    let ns_window_ptr = window
        .ns_window()
        .map_err(|error| format!("无法取得 Tauri NSWindow：{error}"))?;
    // SAFETY: `ns_window()` returns Tauri's live, autoreleased NSWindow. We
    // retain it immediately on the AppKit main thread and only use it here.
    let ns_window: Retained<NSWindow> = unsafe {
        Retained::retain_autoreleased(ns_window_ptr.cast::<NSWindow>())
    }
    .ok_or_else(|| "Tauri NSWindow 指针为空".to_owned())?;
    let content_view = ns_window
        .contentView()
        .ok_or_else(|| "Tauri 窗口缺少 contentView".to_owned())?;
    content_view.setAutoresizesSubviews(true);

    let frame = viewport_frame(content_view.bounds(), viewport)?;

    let mut attributes: [NSOpenGLPixelFormatAttribute; 9] = [
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
    // SAFETY: AppKit expects a zero-terminated attribute array and does not
    // retain the pointer. `attributes` has that terminator and lives through
    // the synchronous initializer call.
    let pixel_format = unsafe {
        NSOpenGLPixelFormat::initWithAttributes(
            mtm.alloc(),
            NonNull::new(attributes.as_mut_ptr())
                .ok_or_else(|| "OpenGL pixel format 属性为空".to_owned())?,
        )
    }
    .ok_or_else(|| "NSOpenGLPixelFormat 创建失败".to_owned())?;
    let gl_view = NSOpenGLView::initWithFrame_pixelFormat(mtm.alloc(), frame, Some(&pixel_format))
        .ok_or_else(|| "NSOpenGLView 创建失败".to_owned())?;
    gl_view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    content_view.addSubview_positioned_relativeTo(&gl_view, NSWindowOrderingMode::Above, None);
    let gl_context = gl_view
        .openGLContext()
        .ok_or_else(|| "NSOpenGLView 缺少 OpenGL context".to_owned())?;
    let removal = MainThreadView(gl_view.clone());

    Ok(RenderSurface {
        gl_view,
        gl_context,
        removal: Some(removal),
    })
}

fn viewport_frame(bounds: CGRect, viewport: PlayerViewport) -> Result<CGRect, String> {
    let width = viewport.width.min((bounds.size.width - viewport.x).max(1.0));
    let height = viewport.height.min((bounds.size.height - viewport.y).max(1.0));
    if width < 2.0 || height < 2.0 {
        return Err("播放器区域超出 Tauri 内容窗口".to_owned());
    }
    Ok(CGRect {
        origin: CGPoint {
            x: viewport.x,
            y: (bounds.size.height - viewport.y - height).max(0.0),
        },
        size: CGSize { width, height },
    })
}

/// The surface is created on AppKit's main thread, then moved exactly once to
/// the render worker. Only that worker reads bounds and touches the GL context;
/// AppKit retains ownership of layout/autoresizing. Removal is separately
/// marshalled back to the main thread. This is the narrow, spike-proven unsafe
/// bridge around objc2's conservative `MainThreadOnly` marker.
struct RenderSurface {
    gl_view: Retained<NSOpenGLView>,
    gl_context: Retained<NSOpenGLContext>,
    removal: Option<MainThreadView>,
}

// SAFETY: see the invariant documented on `RenderSurface`; it is never shared
// (`Sync` is deliberately not implemented) and has one render-thread owner.
unsafe impl Send for RenderSurface {}

struct MainThreadView(Retained<NSOpenGLView>);

// SAFETY: this wrapper is only used to transfer a retained view into a closure
// that Tauri guarantees to execute on the AppKit main thread.
unsafe impl Send for MainThreadView {}

struct MainThreadContext(Retained<NSOpenGLContext>);
// SAFETY: consumed entirely on the AppKit main thread, mirroring MainThreadView.
unsafe impl Send for MainThreadContext {}

fn resize_surface(
    window: &WebviewWindow,
    surface: &RenderSurface,
    viewport: PlayerViewport,
) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let window_for_main = window.clone();
    let view = MainThreadView(surface.gl_view.clone());
    let context = MainThreadContext(surface.gl_context.clone());
    window
        .run_on_main_thread(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let ns_window_ptr = window_for_main
                    .ns_window()
                    .map_err(|error| format!("无法取得 Tauri NSWindow：{error}"))?;
                // SAFETY: the pointer is retained and consumed entirely on the
                // AppKit main thread during this synchronous resize operation.
                let ns_window: Retained<NSWindow> = unsafe {
                    Retained::retain_autoreleased(ns_window_ptr.cast::<NSWindow>())
                }
                .ok_or_else(|| "Tauri NSWindow 指针为空".to_owned())?;
                let content_view = ns_window
                    .contentView()
                    .ok_or_else(|| "Tauri 窗口缺少 contentView".to_owned())?;
                let frame = viewport_frame(content_view.bounds(), viewport)?;
                let view = view;
                let MainThreadView(inner) = view;
                inner.setFrame(frame);
                // AppKit 硬性要求:view 几何变化后必须同步 GL drawable,
                // 否则渲染线程在失配的 framebuffer 上 glClear 会段错误(实报 SIGSEGV)。
                // 2021 闭包精确捕获会只捕字段绕过 unsafe Send,必须先整值捕获再解构。
                let context = context;
                let MainThreadContext(gl) = context;
                let mtm = MainThreadMarker::new()
                    .ok_or_else(|| "播放器视图未运行在 AppKit 主线程".to_owned())?;
                gl.update(mtm);
                Ok(())
            }))
            .unwrap_or_else(|payload| {
                Err(format!(
                    "调整播放器原生视图时 panic：{}",
                    panic_text(payload)
                ))
            });
            let _ = sender.send(result);
        })
        .map_err(|error| format!("无法派发播放器区域更新：{error}"))?;
    receiver
        .recv_timeout(COMMAND_TIMEOUT)
        .map_err(|_| "更新播放器原生视图超时".to_owned())?
}

struct CurrentContextGuard<'a>(&'a NSOpenGLContext);

impl Drop for CurrentContextGuard<'_> {
    fn drop(&mut self) {
        self.0.clearDrawable();
        NSOpenGLContext::clearCurrentContext();
    }
}

#[allow(clippy::too_many_arguments)] // 渲染线程装配参数,拆结构属重构,留待专卡
fn worker_entry(
    window: WebviewWindow,
    viewport: PlayerViewport,
    path: PathBuf,
    time_mapper: Option<crate::core::canonical_time::ProxyTimeMapper>,
    status: Arc<Mutex<PlayerStatus>>,
    receiver: mpsc::Receiver<WorkerMessage>,
    callback_sender: mpsc::Sender<WorkerMessage>,
    started: mpsc::Sender<Result<(), String>>,
) {
    let mut surface = match create_surface(&window, viewport) {
        Ok(surface) => surface,
        Err(error) => {
            let _ = started.send(Err(error.clone()));
            lock(&status).fail(error);
            return;
        }
    };
    let Some(removal) = surface.removal.take() else {
        let error = "播放器原生视图缺少主线程清理句柄".to_owned();
        let _ = started.send(Err(error.clone()));
        lock(&status).fail(error);
        return;
    };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_worker(
            &window,
            &surface,
            &path,
            time_mapper.as_ref(),
            &status,
            receiver,
            callback_sender,
            &started,
        )
    }));

    let shutdown_reply = match outcome {
        Ok(Ok(reply)) => reply,
        Ok(Err(error)) => {
            let _ = started.send(Err(error.clone()));
            lock(&status).fail(error);
            None
        }
        Err(payload) => {
            let error = format!("播放器渲染线程 panic：{}", panic_text(payload));
            let _ = started.send(Err(error.clone()));
            lock(&status).fail(error);
            None
        }
    };

    schedule_surface_removal(&window, removal);
    if let Some(reply) = shutdown_reply {
        let _ = reply.send(());
    }
}

#[allow(clippy::too_many_arguments)] // 渲染线程装配参数,拆结构属重构,留待专卡
fn run_worker(
    window: &WebviewWindow,
    surface: &RenderSurface,
    path: &Path,
    time_mapper: Option<&crate::core::canonical_time::ProxyTimeMapper>,
    status: &Arc<Mutex<PlayerStatus>>,
    receiver: mpsc::Receiver<WorkerMessage>,
    callback_sender: mpsc::Sender<WorkerMessage>,
    started: &mpsc::Sender<Result<(), String>>,
) -> Result<Option<mpsc::Sender<()>>, String> {
    surface.gl_context.makeCurrentContext();
    let _current_context = CurrentContextGuard(&surface.gl_context);

    let mut mpv = Mpv::with_initializer(|initializer| {
        initializer.set_property("vo", "libmpv")?;
        initializer.set_property("hwdec", "videotoolbox")?;
        initializer.set_property("keep-open", "yes")?;
        // osc 是 mpv 自带播放器(cplayer)的屏幕控制器开关,内嵌 render API 模式下
        // 本来就没有它。分发版链接的 LGPL libmpv 用 -Dcplayer=false 编译,
        // 这个属性不存在,设置会返回 PropertyNotFound 并让整个初始化失败。
        let _ = initializer.set_property("osc", false);
        initializer.set_property("pause", true)?;
        Ok(())
    })
    .map_err(|error| format!("libmpv 初始化失败：{error}"))?;

    mpv.observe_property("time-pos", Format::Double, OBSERVE_POSITION)
        .map_err(|error| format!("监听播放位置失败：{error}"))?;
    mpv.observe_property("duration", Format::Double, OBSERVE_DURATION)
        .map_err(|error| format!("监听时长失败：{error}"))?;
    mpv.observe_property("pause", Format::Flag, OBSERVE_PAUSED)
        .map_err(|error| format!("监听暂停状态失败：{error}"))?;
    mpv.observe_property("estimated-frame-number", Format::Int64, OBSERVE_FRAME)
        .map_err(|error| format!("监听帧号失败：{error}"))?;

    let render_pending = Arc::new(AtomicBool::new(false));
    let events_pending = Arc::new(AtomicBool::new(false));
    let event_sender = callback_sender.clone();
    let event_flag = Arc::clone(&events_pending);
    mpv.set_wakeup_callback(move || {
        if !event_flag.swap(true, Ordering::AcqRel) {
            let _ = event_sender.send(WorkerMessage::EventsWake);
        }
    });

    let mut render_context = mpv
        .create_render_context(vec![
            RenderParam::ApiType(RenderParamApiType::OpenGl),
            RenderParam::InitParams(OpenGLInitParams {
                get_proc_address,
                ctx: (),
            }),
        ])
        .map_err(|error| format!("mpv OpenGL render context 创建失败：{error}"))?;
    let render_sender = callback_sender;
    let render_flag = Arc::clone(&render_pending);
    render_context.set_update_callback(move || {
        if !render_flag.swap(true, Ordering::AcqRel) {
            let _ = render_sender.send(WorkerMessage::RenderWake);
        }
    });

    let path_text = path.to_string_lossy();
    mpv.command("loadfile", &[&path_text, "replace"])
        .map_err(|error| format!("素材载入失败：{error}"))?;
    mpv.set_property("pause", false)
        .map_err(|error| format!("素材自动播放失败：{error}"))?;
    lock(status).paused = false;
    let _ = started.send(Ok(()));

    // Exact-seek latency is closed by mpv's PlaybackRestart event. No render
    // call or `seeking` property polling participates in this measurement.
    let mut pending_seek: Option<Instant> = None;
    let mut seek_samples = Vec::new();
    let shutdown_reply = loop {
        // mpv 的 render 回调在播放时可持续以帧率灌入 RenderWake。若只在
        // recv_timeout 超时时轮询事件，队列一直有渲染消息时就永远不会超时，
        // time-pos / duration 等观察值会停在 0。每次处理任意 worker 消息后都
        // drain 一次事件；50ms timeout 只负责静止画面时的兜底。
        let message = match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(message) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                drain_events(&mpv, status, time_mapper, &mut pending_seek, &mut seek_samples)?;
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("播放器控制通道已关闭".to_owned());
            }
        };
        match message {
            WorkerMessage::RenderWake => {
                render_pending.store(false, Ordering::Release);
                let flags = render_context
                    .update()
                    .map_err(|error| format!("mpv render update 失败：{error}"))?;
                if flags & mpv_render_update::Frame != 0 {
                    render_frame(&render_context, surface)?;
                }
            }
            WorkerMessage::ForceRedraw => render_frame(&render_context, surface)?,
            WorkerMessage::Resize(viewport, reply) => {
                let result = resize_surface(window, surface, viewport)
                    .and_then(|()| render_frame(&render_context, surface));
                let failure = result.as_ref().err().cloned();
                let _ = reply.send(result);
                if let Some(error) = failure {
                    lock(status).fail(error.clone());
                    return Err(error);
                }
            }
            WorkerMessage::EventsWake => {
                events_pending.store(false, Ordering::Release);
            }
            WorkerMessage::Command(command, reply) => {
                let result = execute_command(&mpv, status, time_mapper, command, &mut pending_seek);
                if let Err(error) = &result {
                    lock(status).fail(error.clone());
                }
                let failure = result.as_ref().err().cloned();
                let _ = reply.send(result);
                if let Some(error) = failure {
                    return Err(error);
                }
            }
            WorkerMessage::Shutdown(reply) => break Some(reply),
        }
        drain_events(
            &mpv,
            status,
            time_mapper,
            &mut pending_seek,
            &mut seek_samples,
        )?;
    };

    Ok(shutdown_reply)
}

fn render_frame(render_context: &RenderContext<'_>, surface: &RenderSurface) -> Result<(), String> {
    let bounds = surface.gl_view.convertRectToBacking(surface.gl_view.bounds());
    let width = bounds.size.width.round().max(1.0) as i32;
    let height = bounds.size.height.round().max(1.0) as i32;
    render_context
        .render::<()>(0, width, height, true)
        .map_err(|error| format!("mpv render 失败：{error}"))?;
    surface.gl_context.flushBuffer();
    render_context.report_swap();
    Ok(())
}

fn execute_command(
    mpv: &Mpv,
    status: &Arc<Mutex<PlayerStatus>>,
    time_mapper: Option<&crate::core::canonical_time::ProxyTimeMapper>,
    command: PlayerCommand,
    pending_seek: &mut Option<Instant>,
) -> Result<(), String> {
    match command {
        PlayerCommand::Play => {
            mpv.set_property("pause", false)
                .map_err(|error| format!("播放失败：{error}"))?;
            lock(status).paused = false;
        }
        PlayerCommand::Pause => {
            mpv.set_property("pause", true)
                .map_err(|error| format!("暂停失败：{error}"))?;
            lock(status).paused = true;
        }
        PlayerCommand::StepFwd => {
            mpv.set_property("pause", true)
                .map_err(|error| format!("逐帧暂停失败：{error}"))?;
            mpv.command("frame-step", &[])
                .map_err(|error| format!("向前逐帧失败：{error}"))?;
            lock(status).paused = true;
        }
        PlayerCommand::StepBack => {
            mpv.set_property("pause", true)
                .map_err(|error| format!("逐帧暂停失败：{error}"))?;
            mpv.command("frame-back-step", &[])
                .map_err(|error| format!("向后逐帧失败：{error}"))?;
            lock(status).paused = true;
        }
        PlayerCommand::SeekAbs { seconds } => {
            let playback_seconds = time_mapper
                .map(|mapper| mapper.proxy_seconds_for_source_seconds(seconds))
                .unwrap_or(seconds);
            let target = format!("{playback_seconds:.6}");
            *pending_seek = Some(Instant::now());
            if let Err(error) = mpv.command("seek", &[&target, "absolute+exact"]) {
                *pending_seek = None;
                return Err(format!("精确定位失败：{error}"));
            }
        }
    }
    Ok(())
}

fn drain_events(
    mpv: &Mpv,
    status: &Arc<Mutex<PlayerStatus>>,
    time_mapper: Option<&crate::core::canonical_time::ProxyTimeMapper>,
    pending_seek: &mut Option<Instant>,
    seek_samples: &mut Vec<f64>,
) -> Result<(), String> {
    loop {
        let ev = mpv.wait_event(0.0);

        match ev {
            None => return Ok(()),
            Some(Err(error)) => return Err(format!("mpv 事件错误：{error}")),
            Some(Ok(Event::FileLoaded)) => {
                let mut snapshot = lock(status);
                snapshot.duration = time_mapper
                    .map(|mapper| mapper.source_duration_seconds())
                    .unwrap_or_else(|| mpv.get_property("duration").unwrap_or(snapshot.duration));
                snapshot.paused = mpv.get_property("pause").unwrap_or(true);
                snapshot.frame = mpv.get_property("estimated-frame-number").ok();
                snapshot.mark_ready();
            }
            Some(Ok(Event::PlaybackRestart)) => {
                if let Some(started) = pending_seek.take() {
                    let elapsed = started.elapsed().as_secs_f64() * 1_000.0;
                    seek_samples.push(elapsed);
                    lock(status).record_seek(elapsed, seek_samples);
                }
            }
            Some(Ok(Event::PropertyChange { name, change, .. })) => {
                let mut snapshot = lock(status);
                match (name, change) {
                    ("time-pos", PropertyData::Double(value)) => {
                        snapshot.pos = time_mapper
                            .map(|mapper| mapper.source_seconds_for_proxy_seconds(value))
                            .unwrap_or(value)
                            .max(0.0)
                    }
                    ("duration", PropertyData::Double(value)) => {
                        snapshot.duration = time_mapper
                            .map(|mapper| mapper.source_duration_seconds())
                            .unwrap_or(value)
                            .max(0.0)
                    }
                    ("pause", PropertyData::Flag(value)) => snapshot.paused = value,
                    ("estimated-frame-number", PropertyData::Int64(value)) => {
                        snapshot.frame = Some(value)
                    }
                    _ => {}
                }
            }
            Some(Ok(Event::EndFile(_))) => {
                let mut snapshot = lock(status);
                snapshot.paused = true;
                snapshot.pos = snapshot.duration;
            }
            Some(Ok(Event::QueueOverflow)) => {
                return Err("mpv 事件队列溢出".to_owned());
            }
            Some(Ok(_)) => {}
        }
    }
}

fn schedule_surface_removal(window: &WebviewWindow, view: MainThreadView) {
    let _ = window.run_on_main_thread(move || {
        // 强制整值捕获:2021 闭包的精确捕获(含模式解构)会只捕 view.0(非 Send),
        // 绕过包装器的 unsafe Send;先整体重绑再解构是官方惯用法。
        let view = view;
        let MainThreadView(inner) = view;
        inner.removeFromSuperview();
    });
}

fn get_proc_address(_context: &(), name: &str) -> *mut c_void {
    let Ok(name) = CString::new(name) else {
        return std::ptr::null_mut();
    };
    // SAFETY: dlsym accepts this process-wide handle and a valid NUL-terminated
    // symbol. The returned pointer is consumed by libmpv's OpenGL loader.
    unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) }
}

fn panic_text(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_owned()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "未知 panic".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    fn fake_session(worker: JoinHandle<()>) -> PlayerSession {
        PlayerSession {
            sender: channel().0,
            status: Arc::new(Mutex::new(PlayerStatus::closed())),
            worker: Some(worker),
        }
    }

    #[test]
    fn reap_orphans_joins_finished_workers_and_keeps_wedged_ones() {
        // 回归说明：关闭超时曾直接 drop 掉 JoinHandle(detach),manager
        // 从此彻底失去这条渲染线程的引用——旧线程/原生 view 永远无法确认
        // 回收。reap_orphans 必须能在线程真正退出后补上 join() 并释放,
        // 同时不能对仍卡在原生 teardown 里的线程做任何事。
        let (release_tx, release_rx) = channel::<()>();
        let wedged = thread::Builder::new()
            .spawn(move || {
                // 模拟卡在原生 teardown 里、3 秒超时窗口内不会退出的线程。
                let _ = release_rx.recv();
            })
            .unwrap();
        let finished = thread::spawn(|| {});
        // 确保 finished 线程已经真正跑完,再进池子。
        while !finished.is_finished() {
            thread::yield_now();
        }

        let mut orphans = vec![fake_session(wedged), fake_session(finished)];
        assert_eq!(orphans.len(), 2);

        reap_orphans(&mut orphans);
        assert_eq!(orphans.len(), 1, "已结束的孤儿线程必须被回收,卡死的必须留在池里");

        // 放行卡死的线程,让它真正退出,再验证下一次 reap 能补上回收。
        release_tx.send(()).unwrap();
        while !orphans[0].worker.as_ref().unwrap().is_finished() {
            thread::yield_now();
        }
        reap_orphans(&mut orphans);
        assert!(orphans.is_empty(), "卡死线程一旦真正退出,必须能在后续 reap 中被回收,不能永久停留在 orphans 里");
    }

    #[test]
    fn closed_state_is_inert() {
        let status = PlayerStatus::closed();
        assert_eq!(status.phase, "closed");
        assert_eq!(status.clip_id, None);
        assert!(status.paused);
        assert_eq!(status.pos, 0.0);
    }

    #[test]
    fn loading_state_resets_previous_media_state() {
        let status = PlayerStatus::loading(42);
        assert_eq!(status.phase, "loading");
        assert_eq!(status.clip_id, Some(42));
        assert_eq!(status.duration, 0.0);
        assert_eq!(status.seek_samples, 0);
    }

    #[test]
    fn ready_and_error_transitions_are_explicit() {
        let mut status = PlayerStatus::loading(7);
        status.mark_ready();
        assert_eq!(status.phase, "ready");
        status.fail("decoder failed".to_owned());
        assert_eq!(status.phase, "error");
        assert_eq!(status.error.as_deref(), Some("decoder failed"));
        assert!(status.paused);
    }

    #[test]
    fn seek_metrics_report_nearest_rank_percentiles() {
        let mut status = PlayerStatus::loading(1);
        let samples = [10.0, 20.0, 30.0, 40.0, 90.0];
        status.record_seek(90.0, &samples);
        assert_eq!(status.seek_samples, 5);
        assert_eq!(status.seek_p50_ms, Some(30.0));
        assert_eq!(status.seek_p95_ms, Some(90.0));
        assert_eq!(status.last_seek_ms, Some(90.0));
    }

    #[test]
    fn viewport_rejects_non_finite_or_empty_geometry() {
        assert!(PlayerViewport { width: f64::NAN, ..PlayerViewport::default() }.validate().is_err());
        assert!(PlayerViewport { height: 0.0, ..PlayerViewport::default() }.validate().is_err());
        assert!(PlayerViewport::default().validate().is_ok());
    }

    #[test]
    fn viewport_frame_recomputes_position_and_size_from_latest_geometry() {
        let bounds = CGRect {
            origin: CGPoint { x: 0.0, y: 0.0 },
            size: CGSize { width: 1_200.0, height: 800.0 },
        };
        let frame = viewport_frame(
            bounds,
            PlayerViewport { x: 12.0, y: 18.0, width: 640.0, height: 360.0 },
        ).unwrap();

        assert_eq!(frame.origin.x, 12.0);
        assert_eq!(frame.origin.y, 422.0);
        assert_eq!(frame.size.width, 640.0);
        assert_eq!(frame.size.height, 360.0);
    }

    #[test]
    fn seek_command_contract_is_tagged_and_snake_case() {
        let command: PlayerCommand = serde_json::from_str(
            r#"{"type":"seek_abs","seconds":12.5}"#,
        )
        .unwrap();
        assert_eq!(command, PlayerCommand::SeekAbs { seconds: 12.5 });
    }
}
