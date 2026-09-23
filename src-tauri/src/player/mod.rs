//! Reusable libmpv-backed player for the macOS review workspace.
//!
//! AppKit owns surface creation/removal on the main thread. The `Mpv`, render
//! context and OpenGL context are then kept on one dedicated worker thread.
//! libmpv callbacks never render or call the client API; they only enqueue a
//! coalesced wake-up for that worker.

#![allow(deprecated)]

/// R16 车道 E:libmpv 初始化选项表(标准 / 低配两套),`run_worker` 只按表设置。
pub mod mpv_options;
mod handoff;
mod pause_drain;
pub mod preview_source;
use preview_source::{PreviewQuality, SourceKind, SourcePlan, SourceSwitcher};

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
use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSOpenGLContext, NSOpenGLPixelFormat,
    NSOpenGLPixelFormatAttribute, NSOpenGLProfileVersion3_2Core, NSOpenGLView, NSView, NSWindow,
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
    /// 渲染线程队列栅栏:之前排队的命令已处理完,不调用 mpv。
    Sync,
    Play,
    Pause,
    StepFwd,
    StepBack,
    SeekAbs { seconds: f64 },
    /// Preview-only display LUT — applied as a labelled `vf` entry so it can
    /// be removed by that exact label. Never used by proxy generation or
    /// export/deliver (see the negative assertions in `core::artifacts` and
    /// `core::deliver`).
    ApplyDisplayLut { path: PathBuf },
    ClearDisplayLut,
    /// 0-based, audio-relative index (matches `clip_audio_tracks.stream_index`
    /// and the `-map 0:a:N` convention). Converted to mpv's 1-based `aid` in
    /// exactly one place — `mpv_calls_for` — never anywhere else.
    SelectAudioTrack { stream_index: i64 },
    SetMute { muted: bool },
    /// Sets mpv's `video-rotate` property. Only meaningful for a clip whose
    /// stored rotation came from a legacy `rotate` metadata tag with no
    /// `side_data_list` display matrix (`clips.manual_rotation` — see
    /// `core::import::parse_probe_json`). mpv already auto-rotates from the
    /// display matrix by default (confirmed via its own
    /// `[autorotate] Inserting rotation filter` log), so callers must NEVER
    /// pass the merged `clips.rotation` value here — that would add this
    /// rotation on top of mpv's own, doubling it for the common case.
    SetRotation { degrees: Option<i64> },
    /// R12 §5 真变速:mpv 的 `speed` 属性,夹紧到 `PLAYBACK_SPEED_MIN..=PLAYBACK_SPEED_MAX`。
    /// mpv 不支持负速,反向由前端用 `StepBack` 定时回退实现,不经这里。
    SetSpeed { speed: f64 },
    /// R23:出点围栏。mpv 的 `end` 属性 —— 播到这一秒就 EOF,`keep-open=yes` 让它停在那儿
    /// 而不是关掉。镜头带连播的「到 out 就结束」因此由播放器自己保证,不再只靠前端按 80 ms
    /// 轮询到的位置去追:前端状态机一旦掉链子(停连播没停住、卡在等首帧、事件迟到),
    /// 以前就会一路播进用户没选的原片(ISSUE-A)。`None` = 撤掉围栏(`end=none`)。
    SetEnd { seconds: Option<f64> },
}

/// 真变速的夹紧范围(R12 §5:0.25–4×)。
pub const PLAYBACK_SPEED_MIN: f64 = 0.25;
pub const PLAYBACK_SPEED_MAX: f64 = 4.0;

/// NaN / ±∞ 返回 None(不能交给 mpv);其余夹紧到支持范围。
pub fn clamp_playback_speed(speed: f64) -> Option<f64> {
    if !speed.is_finite() {
        return None;
    }
    Some(speed.clamp(PLAYBACK_SPEED_MIN, PLAYBACK_SPEED_MAX))
}

/// mpv's `vf` label for the preview LUT filter — `vf remove @tripcut-lut`
/// must match exactly what `vf add` used, so the label lives in one place.
const DISPLAY_LUT_LABEL: &str = "@tripcut-lut";

/// A pure description of what `execute_command` will ask mpv to do for one
/// `PlayerCommand`. Kept separate from the actual `Mpv` calls so the
/// command→mpv-call mapping (including path escaping) is unit-testable
/// without a live mpv instance — there is no GUI test for this plumbing.
#[derive(Debug, Clone, PartialEq)]
enum MpvCall {
    Command(&'static str, Vec<String>),
    SetPropertyInt(&'static str, i64),
    SetPropertyBool(&'static str, bool),
    SetPropertyF64(&'static str, f64),
    SetPropertyStr(&'static str, String),
}

fn mpv_calls_for(command: PlayerCommand) -> Result<Vec<MpvCall>, String> {
    Ok(match command {
        PlayerCommand::ApplyDisplayLut { path } => vec![MpvCall::Command(
            "vf",
            vec![
                "add".to_owned(),
                format!("{DISPLAY_LUT_LABEL}:lut3d={}", escape_mpv_path(&path)),
            ],
        )],
        PlayerCommand::ClearDisplayLut => vec![MpvCall::Command(
            "vf",
            vec!["remove".to_owned(), DISPLAY_LUT_LABEL.to_owned()],
        )],
        PlayerCommand::SelectAudioTrack { stream_index } => {
            if stream_index < 0 {
                return Err(format!("音轨序号不能为负：{stream_index}"));
            }
            // mpv's `aid` is 1-based; `stream_index` is the 0-based,
            // audio-relative index stored in `clip_audio_tracks` — this is
            // the ONLY place that conversion happens.
            vec![MpvCall::SetPropertyInt("aid", stream_index + 1)]
        }
        PlayerCommand::SetMute { muted } => vec![MpvCall::SetPropertyBool("mute", muted)],
        PlayerCommand::SetSpeed { speed } => {
            let clamped = clamp_playback_speed(speed)
                .ok_or_else(|| format!("播放速度不是有限数：{speed}"))?;
            vec![MpvCall::SetPropertyF64("speed", clamped)]
        }
        PlayerCommand::SetRotation { degrees } => match degrees {
            Some(90) | Some(180) | Some(270) => {
                vec![MpvCall::SetPropertyInt("video-rotate", degrees.expect("matched Some above"))]
            }
            // 0/None, or any value outside the three real orientations: no call.
            _ => Vec::new(),
        },
        PlayerCommand::SetEnd { seconds } => match seconds {
            Some(value) if value.is_finite() && value > 0.0 => {
                vec![MpvCall::SetPropertyStr("end", format!("{value:.6}"))]
            }
            // 负数 / 非有限 / 0 一律当成「撤掉围栏」,绝不把播放窗口关成空的。
            _ => vec![MpvCall::SetPropertyStr("end", "none".to_owned())],
        },
        PlayerCommand::Play | PlayerCommand::Pause | PlayerCommand::StepFwd | PlayerCommand::StepBack
        | PlayerCommand::SeekAbs { .. } | PlayerCommand::Sync => Vec::new(),
    })
}

/// mpv's length-prefixed `%n%text` quoting: quotes any byte sequence
/// (including `:`, `,` and spaces, all significant in `vf`'s filter-graph
/// syntax) without needing to escape individual characters.
fn escape_mpv_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    format!("%{}%{}", text.len(), text)
}

fn apply_mpv_call(mpv: &Mpv, call: MpvCall) -> Result<(), String> {
    match call {
        MpvCall::Command(name, args) => {
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            mpv.command(name, &arg_refs)
                .map_err(|error| format!("执行 {name} 命令失败：{error}"))
        }
        MpvCall::SetPropertyInt(name, value) => mpv
            .set_property(name, value)
            .map_err(|error| format!("设置 {name} 失败：{error}")),
        MpvCall::SetPropertyBool(name, value) => mpv
            .set_property(name, value)
            .map_err(|error| format!("设置 {name} 失败：{error}")),
        MpvCall::SetPropertyF64(name, value) => mpv
            .set_property(name, value)
            .map_err(|error| format!("设置 {name} 失败：{error}")),
        MpvCall::SetPropertyStr(name, value) => mpv
            .set_property(name, value.as_str())
            .map_err(|error| format!("设置 {name} 失败：{error}")),
    }
}

/// `command_for` 拒绝跨素材命令时的错误文本;前端据此静默(不是播放器故障)。
pub const STALE_CLIP_COMMAND: &str = "命令属于已换掉的素材";

/// 纯判定:命令声明的归属 `expected` 与当前会话的 `current` 不一致即拒;未声明归属(`None`)放行。
fn command_owner_check(current: Option<i64>, expected: Option<i64>) -> Result<(), String> {
    match expected {
        Some(expected) if current != Some(expected) => Err(STALE_CLIP_COMMAND.to_owned()),
        _ => Ok(()),
    }
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
    pub source_kind: Option<String>,
    pub source_width: Option<i64>,
    pub source_height: Option<i64>,
    pub preview_quality: Option<String>,
    pub source_switch_ms: Option<f64>,
    pub source_switch_error_s: Option<f64>,
    pub dropped_frames: Option<i64>,
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
            source_kind: None,
            source_width: None,
            source_height: None,
            preview_quality: None,
            source_switch_ms: None,
            source_switch_error_s: None,
            dropped_frames: None,
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
    /// 原生视图是否被 DOM 覆盖层(popover / 抽屉 / 命令面板)遮住。原生 NSView
    /// 永远画在 WKWebView 之上,所以覆盖层打开时必须把它 setHidden,否则视频会
    /// 盖住覆盖层(R9 实机 D1)。存在这里是为了:遮挡中打开的会话一出生就隐藏,
    /// Resize 也不会把它露出来。
    occluded: bool,
    session: Option<PlayerSession>,
    outgoing: Option<PlayerSession>,
    generation: u64,
}

struct PlayerSession {
    sender: mpsc::Sender<WorkerMessage>,
    status: Arc<Mutex<PlayerStatus>>,
    worker: Option<JoinHandle<()>>,
    view: handoff::ViewSlot,
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
    SetOccluded(bool, mpsc::Sender<Result<(), String>>),
    EventsWake,
    Command(PlayerCommand, mpsc::Sender<Result<(), String>>),
    Shutdown(mpsc::Sender<()>),
    SetSourcePlan(Box<SourcePlan>, SourceKind, mpsc::Sender<Result<(), String>>),
    SetPreviewQuality(PreviewQuality, mpsc::Sender<Result<(), String>>),
}

impl PlayerManager {
    pub fn new(window: WebviewWindow) -> Self {
        Self {
            window,
            state: Arc::new(Mutex::new(ManagerState {
                viewport: PlayerViewport::default(),
                occluded: false,
                session: None,
                outgoing: None,
                generation: 0,
            })),
            operation: Arc::new(Mutex::new(())),
            orphans: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn install_source_plan(&self, plan: SourcePlan, opened_kind: SourceKind) -> Result<(), String> {
        self.send_source_message(|reply| WorkerMessage::SetSourcePlan(Box::new(plan), opened_kind, reply))
    }

    pub fn set_preview_quality(&self, quality: PreviewQuality) -> Result<(), String> {
        self.send_source_message(|reply| WorkerMessage::SetPreviewQuality(quality, reply))
    }

    fn send_source_message(&self, message: impl FnOnce(mpsc::Sender<Result<(), String>>) -> WorkerMessage) -> Result<(), String> {
        let _operation = lock(&self.operation);
        self.send_source_message_locked(message)
    }

    fn send_source_message_locked(&self, message: impl FnOnce(mpsc::Sender<Result<(), String>>) -> WorkerMessage) -> Result<(), String> {
        let sender = lock(&self.state).session.as_ref().map(|s| s.sender.clone());
        let Some(sender) = sender else { return Ok(()); };
        let (reply, receiver) = mpsc::channel();
        sender.send(message(reply)).map_err(|e| e.to_string())?;
        receiver.recv_timeout(COMMAND_TIMEOUT).map_err(|e| e.to_string())?
    }

    /// 后台 HQ 完成时只更新仍在同一素材、同一档位的会话。
    pub fn refresh_source_plan_for_clip(&self, clip_id: i64, plan: SourcePlan, only_if_high: bool) -> Result<(), String> {
        let _operation = lock(&self.operation);
        let status = self.status();
        if status.clip_id != Some(clip_id) || (only_if_high && status.preview_quality.as_deref() != Some("high")) {
            return Ok(());
        }
        let opened = match status.source_kind.as_deref() { Some("proxy") => SourceKind::Proxy, Some("proxy_hq") => SourceKind::ProxyHq, _ => SourceKind::Original };
        let quality = plan.quality;
        self.send_source_message_locked(|reply| WorkerMessage::SetSourcePlan(Box::new(plan), opened, reply))?;
        self.send_source_message_locked(|reply| WorkerMessage::SetPreviewQuality(quality, reply))
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

    /// 覆盖层开合时切换原生视图的可见性。播放状态不动:只是 setHidden,
    /// 覆盖层收起后画面从当前位置继续。没有会话时只记下旗标。
    pub fn set_occluded(&self, occluded: bool) -> Result<(), String> {
        let _operation = lock(&self.operation);
        let sender = record_occlusion(&mut lock(&self.state), occluded);
        let Some(sender) = sender else {
            return Ok(());
        };
        let (reply_sender, reply_receiver) = mpsc::channel();
        sender
            .send(WorkerMessage::SetOccluded(occluded, reply_sender))
            .map_err(|_| "播放器渲染线程已退出".to_owned())?;
        reply_receiver
            .recv_timeout(COMMAND_TIMEOUT)
            .map_err(|_| "播放器遮挡更新超时".to_owned())?
    }

    /// 当前遮挡旗标(测试与诊断用)。
    pub fn is_occluded(&self) -> bool {
        lock(&self.state).occluded
    }

    /// `start_paused` = 载入后停在首帧不自动播(R23:镜头带连播换素材时用它,否则新实例
    /// 从 0 自己跑起来,seek 到入点之前那几百毫秒播的是用户没选的原片)。
    pub fn open(
        &self,
        path: PathBuf,
        clip_id: i64,
        time_mapper: Option<crate::core::canonical_time::ProxyTimeMapper>,
        start_paused: bool,
        start_at: Option<f64>,
    ) -> Result<PlayerStatus, String> {
        let _operation = lock(&self.operation);
        reap_orphans(&mut lock(&self.orphans));
        let (generation, below) = handoff::begin(&mut lock(&self.state), &self.orphans);
        let handoff = handoff::Handoff::new(self, generation).inspect_err(|_| {
            handoff::retire_outgoing(&mut lock(&self.state), &self.orphans);
        })?;
        let view = handoff::ViewSlot::default();
        let worker_view = Arc::clone(&view);

        let (viewport, occluded) = {
            let state = lock(&self.state);
            (state.viewport, state.occluded)
        };
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
                    below,
                    worker_view,
                    handoff,
                    viewport,
                    occluded,
                    start_paused,
                    start_at,
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
            view,
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
        self.command_for(command, None)
    }

    /// R17 playfix:命令只打在它所属的那条素材上。`open()` 持 `operation` 锁期间排队的
    /// 旧素材命令(A 的 `seek_abs 12.3` / `play`)以前会在锁一放后落到 B 的新实例上,
    /// 让 B 从 A 停住的位置开播。带 `clip_id` 的调用方在这里被比对;`None` 保持旧语义。
    pub fn command_for(&self, command: PlayerCommand, clip_id: Option<i64>) -> Result<(), String> {
        if let PlayerCommand::SeekAbs { seconds } = &command {
            if !seconds.is_finite() || *seconds < 0.0 {
                return Err("seek_abs 需要非负有限秒数".to_owned());
            }
        }

        let _operation = lock(&self.operation);
        let sender = {
            let state = lock(&self.state);
            let session = state.session.as_ref().ok_or_else(|| "播放器尚未打开".to_owned())?;
            let current = lock(&session.status).clip_id;
            command_owner_check(current, clip_id)?;
            session.sender.clone()
        };
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
        handoff::stop_sessions(&self.state, &self.orphans)
    }
}

/// 记下遮挡旗标;只有旗标真的变了且有活动会话时才返回要通知的渲染线程。
/// 重复同值不打扰渲染线程;没有会话时只记旗标,留给下一次 open() 用。
fn record_occlusion(state: &mut ManagerState, occluded: bool) -> Option<mpsc::Sender<WorkerMessage>> {
    let changed = state.occluded != occluded;
    state.occluded = occluded;
    if !changed {
        return None;
    }
    handoff::occlude_outgoing(state, occluded);
    state.session.as_ref().map(|session| session.sender.clone())
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

/// Opens the project database and resolves the path (and, for a proxy, its
/// time mapper) `player_open` should play. Returns the open `Connection`
/// alongside the result so the caller can reuse it for
/// `apply_stored_display_prefs` instead of opening a second one.
pub fn resolve_playback_source(
    db_path: &Path,
    cache_root: &Path,
    clip_id: i64,
) -> Result<
    (
        rusqlite::Connection,
        PathBuf,
        Option<crate::core::canonical_time::ProxyTimeMapper>,
    ),
    String,
> {
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
                return Ok((connection, proxy_path, mapper));
            }
        }
    }
    let source = crate::core::media_source::verified_clip_path(&connection, clip_id)
        .map_err(|error| error.to_string())?;
    Ok((connection, source, None))
}

fn create_surface(window: &WebviewWindow, viewport: PlayerViewport, below: Option<handoff::ViewSlot>, own: handoff::ViewSlot) -> Result<RenderSurface, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let window_for_main = window.clone();
    window
        .run_on_main_thread(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                build_surface(&window_for_main, viewport, below, own)
            }))
            .unwrap_or_else(|payload| Err(format!("创建播放器原生视图时 panic：{}", panic_text(payload))));
            let _ = sender.send(result);
        })
        .map_err(|error| format!("无法派发播放器视图创建：{error}"))?;
    receiver
        .recv_timeout(START_TIMEOUT)
        .map_err(|_| "创建播放器原生视图超时".to_owned())?
}

#[link(name = "OpenGL", kind = "framework")]
extern "C" {
    fn CGLLockContext(ctx: *mut c_void) -> i32;
    fn CGLUnlockContext(ctx: *mut c_void) -> i32;
}

/// `NSOpenGLContext.CGLContextObj`:objc2-app-kit 把它关在 objc2-open-gl feature
/// 后面,这里直接 msg_send 取裸指针,不引新 crate。
fn cgl_context(context: &NSOpenGLContext) -> *mut c_void {
    unsafe { msg_send![context, CGLContextObj] }
}

/// 持有 CGLLockContext 的作用域守卫。渲染线程画帧、AppKit 主线程 update drawable
/// 两边都拿这把锁——Apple 文档对「从副线程渲染的 NSOpenGLView」的硬性要求。
struct CglLock(*mut c_void);

impl CglLock {
    fn acquire(context: &NSOpenGLContext) -> Self {
        let ctx = cgl_context(context);
        if !ctx.is_null() {
            // SAFETY: ctx 来自活着的 NSOpenGLContext;CGL 锁是递归的,同线程重入安全。
            unsafe {
                CGLLockContext(ctx);
            }
        }
        Self(ctx)
    }
}

impl Drop for CglLock {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: 与 acquire 配对。
            unsafe {
                CGLUnlockContext(self.0);
            }
        }
    }
}

define_class!(
    // SAFETY: NSOpenGLView 没有额外的子类化要求;本类型不实现 Drop,也没有 ivar。
    //
    // 为什么要子类:AppKit 在窗口活动缩放期间会自己改 view 的 frame / 全局位置,
    // 然后在主线程上调 `-update` 重建 GL drawable。渲染线程此时若正在
    // `mpv_render_context_render`(glClear),就撞进被拆掉一半的 drawable
    // (R9 真机 P0-A:AppleMetalOpenGLRenderer GLRResourceList::addResource SIGSEGV)。
    // Apple 文档的规定动作就是:重写 `-update`,拿 CGLLockContext 再调 super。
    #[unsafe(super(NSOpenGLView))]
    #[thread_kind = MainThreadOnly]
    #[name = "TripcutPlayerGLView"]
    struct PlayerGlView;

    impl PlayerGlView {
        #[unsafe(method(update))]
        fn update_locked(&self) {
            let _lock = self.openGLContext().map(|context| CglLock::acquire(&context));
            // SAFETY: 调 NSOpenGLView 自己的 -update,签名无参无返回。
            let _: () = unsafe { msg_send![super(self), update] };
        }
    }
);

fn build_surface(window: &WebviewWindow, viewport: PlayerViewport, below: Option<handoff::ViewSlot>, own: handoff::ViewSlot) -> Result<RenderSurface, String> {
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

    let frame = viewport_frame(webview_area(&ns_window, &content_view), viewport)?;

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
    // SAFETY: -initWithFrame:pixelFormat: 是 NSOpenGLView 的指定初始化器,子类未改签名。
    let gl_view: Option<Retained<PlayerGlView>> = unsafe {
        msg_send![mtm.alloc::<PlayerGlView>(), initWithFrame: frame, pixelFormat: &*pixel_format]
    };
    let gl_view: Retained<NSOpenGLView> = gl_view
        .ok_or_else(|| "NSOpenGLView 创建失败".to_owned())?
        .into_super();
    gl_view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    handoff::place_view(&content_view, &gl_view, below, own);
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

/// DOM 矩形 → AppKit frame。`area` 是 **WKWebView 在 contentView 坐标系里的矩形**,
/// 不是 contentView.bounds:Tauri 的 contentView 是全尺寸的(含 32px 标题栏),
/// 而 webview 挂在标题栏下面 —— 直接用 bounds 会把原生视图整体抬高一个标题栏
/// (真机复核三:视频盖住「预览监视器」栏标题条)。DOM 的 (0,0) 是 area 的左上角。
fn viewport_frame(area: CGRect, viewport: PlayerViewport) -> Result<CGRect, String> {
    let width = viewport.width.min((area.size.width - viewport.x).max(1.0));
    let height = viewport.height.min((area.size.height - viewport.y).max(1.0));
    if width < 2.0 || height < 2.0 {
        return Err("播放器区域超出 Tauri 内容窗口".to_owned());
    }
    Ok(CGRect {
        origin: CGPoint {
            x: area.origin.x + viewport.x,
            y: (area.origin.y + area.size.height - viewport.y - height).max(area.origin.y),
        },
        size: CGSize { width, height },
    })
}

/// DOM 真正占据的区域,换算到 contentView 坐标系。Tauri 的 contentView 与 WKWebView
/// 都是全尺寸的(含标题栏),但 WebKit 会自动把页面内容缩进到标题栏之下 —— DOM 的
/// (0,0) 在 `contentLayoutRect` 的左上角,不在 contentView 的左上角。
fn webview_area(ns_window: &NSWindow, content_view: &NSView) -> CGRect {
    content_view.convertRect_fromView(ns_window.contentLayoutRect(), None)
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
                let frame = viewport_frame(webview_area(&ns_window, &content_view), viewport)?;
                let view = view;
                let MainThreadView(inner) = view;
                inner.setFrame(frame);
                // AppKit 硬性要求:view 几何变化后必须同步 GL drawable,
                // 否则渲染线程在失配的 framebuffer 上 glClear 会段错误(实报 SIGSEGV)。
                // 走 view 的 -update(子类里带 CGL 锁),而不是直接 context.update:
                // 渲染线程可能正拿着锁在画,必须排队等它画完。
                // 2021 闭包精确捕获会只捕字段绕过 unsafe Send,必须先整值捕获再解构。
                let context = context;
                let MainThreadContext(_gl) = context;
                inner.update();
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

/// 在 AppKit 主线程上切换原生视图的 hidden。只改可见性,不动 frame、
/// GL context 或 mpv 播放状态。
fn set_surface_hidden(
    window: &WebviewWindow,
    surface: &RenderSurface,
    hidden: bool,
) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let view = MainThreadView(surface.gl_view.clone());
    window
        .run_on_main_thread(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let view = view;
                let MainThreadView(inner) = view;
                inner.setHidden(hidden);
                // 重新露出来时 drawable 可能已经被 AppKit 拆掉,先同步再让渲染线程画。
                if !hidden {
                    inner.update();
                }
            }))
            .map_err(|payload| format!("切换播放器原生视图可见性时 panic：{}", panic_text(payload)));
            let _ = sender.send(result);
        })
        .map_err(|error| format!("无法派发播放器遮挡更新：{error}"))?;
    receiver
        .recv_timeout(COMMAND_TIMEOUT)
        .map_err(|_| "更新播放器原生视图可见性超时".to_owned())?
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
    below: Option<handoff::ViewSlot>,
    own: handoff::ViewSlot,
    mut handoff: handoff::Handoff,
    viewport: PlayerViewport,
    occluded: bool,
    start_paused: bool,
    start_at: Option<f64>,
    path: PathBuf,
    time_mapper: Option<crate::core::canonical_time::ProxyTimeMapper>,
    status: Arc<Mutex<PlayerStatus>>,
    receiver: mpsc::Receiver<WorkerMessage>,
    callback_sender: mpsc::Sender<WorkerMessage>,
    started: mpsc::Sender<Result<(), String>>,
) {
    let mut surface = match create_surface(&window, viewport, below, Arc::clone(&own)) {
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
    // 遮挡中打开的会话一出生就隐藏,不能先闪一帧再藏。
    if occluded {
        if let Err(error) = set_surface_hidden(&window, &surface, true) {
            let _ = started.send(Err(error.clone()));
            lock(&status).fail(error);
            schedule_surface_removal(&window, removal, own);
            return;
        }
    }
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_worker(
            &window,
            &surface,
            occluded,
            start_paused,
            start_at,
            &path,
            time_mapper.as_ref(),
            &status,
            receiver,
            callback_sender,
            &started,
            &mut handoff,
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

    schedule_surface_removal(&window, removal, own);
    if let Some(reply) = shutdown_reply {
        let _ = reply.send(());
    }
}

/// mpv 0.41 的第四个参数是每文件选项;路径保持独立参数,逗号/冒号不参与解析。
fn loadfile_args(
    path: &str,
    start_at: Option<f64>,
    time_mapper: Option<&crate::core::canonical_time::ProxyTimeMapper>,
) -> Vec<String> {
    let mut args = vec![path.to_owned(), "replace".to_owned()];
    if let Some(seconds) = start_at.filter(|seconds| seconds.is_finite() && *seconds >= 0.0) {
        let proxy_seconds = time_mapper
            .map(|mapper| mapper.proxy_seconds_for_source_seconds(seconds))
            .unwrap_or(seconds);
        args.extend(["-1".to_owned(), format!("start={proxy_seconds},pause=yes")]);
    }
    args
}

#[allow(clippy::too_many_arguments)] // 渲染线程装配参数,拆结构属重构,留待专卡
fn run_worker(
    window: &WebviewWindow,
    surface: &RenderSurface,
    occluded: bool,
    start_paused: bool,
    start_at: Option<f64>,
    path: &Path,
    time_mapper: Option<&crate::core::canonical_time::ProxyTimeMapper>,
    status: &Arc<Mutex<PlayerStatus>>,
    receiver: mpsc::Receiver<WorkerMessage>,
    callback_sender: mpsc::Sender<WorkerMessage>,
    started: &mpsc::Sender<Result<(), String>>,
    handoff: &mut handoff::Handoff,
) -> Result<Option<mpsc::Sender<()>>, String> {
    surface.gl_context.makeCurrentContext();
    let _current_context = CurrentContextGuard(&surface.gl_context);

    // R16 车道 E:选项从 `mpv_options` 的表来(标准 / 低配两套);required 的失败即初始化失败,
    // optional 的失败只告警(osc 这类 cplayer 属性在 -Dcplayer=false 的分发版 libmpv 里不存在)。
    let options = mpv_options::init_options();
    let mut mpv = Mpv::with_initializer(|initializer| {
        for option in &options {
            let result = match option.value {
                mpv_options::MpvValue::Str(value) => initializer.set_property(option.name, value),
                mpv_options::MpvValue::Bool(value) => initializer.set_property(option.name, value),
                mpv_options::MpvValue::Int(value) => initializer.set_property(option.name, value),
            };
            match result {
                Ok(()) => {}
                Err(error) if option.required => return Err(error),
                Err(error) => tracing::warn!(%error, option = option.name, "设置 mpv 选项失败"),
            }
        }
        if let Some(path) = mpv_options::mpv_log_file_from_env(std::env::var("TRIPCUT_MPV_LOG_FILE").ok()) {
            if let Err(error) = initializer.set_property("log-file", path.as_str()) { tracing::warn!(%error, "设置 mpv 诊断日志失败"); }
        }
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

    for (name, id) in [("frame-drop-count", 5), ("decoder-frame-drop-count", 6)] {
        mpv.observe_property(name, Format::Int64, id).map_err(|error| format!("监听掉帧失败：{error}"))?;
    }
    // R25:换源策略要的 EOF 也走观察事件。渲染线程上不许高频同步读属性(get_property 要等核心线程,
    // 核心又可能在等本线程出帧)——真机 High 档曾因每 20 ms 读一次 eof-reached 卡住 2 s,命令超时。
    mpv.observe_property("eof-reached", Format::Flag, 7).map_err(|error| format!("监听片尾失败：{error}"))?;
    // R26:换源后的原片宽高(角标「原片 2160p」)也走观察事件,不在 FileLoaded 上同步读。
    for (name, id) in [("width", 8), ("height", 9)] {
        mpv.observe_property(name, Format::Int64, id).map_err(|error| format!("监听画面尺寸失败：{error}"))?;
    }
    let mut switcher = SourceSwitcher::new(time_mapper.cloned());
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
    let redraw_sender = callback_sender.clone();
    let render_sender = callback_sender;
    let render_flag = Arc::clone(&render_pending);
    render_context.set_update_callback(move || {
        if !render_flag.swap(true, Ordering::AcqRel) {
            let _ = render_sender.send(WorkerMessage::RenderWake);
        }
    });

    let path_text = path.to_string_lossy();
    let start_at = start_at.filter(|seconds| seconds.is_finite() && *seconds >= 0.0);
    let load_args = loadfile_args(&path_text, start_at, time_mapper);
    let load_refs: Vec<&str> = load_args.iter().map(String::as_str).collect();
    mpv.command("loadfile", &load_refs)
        .map_err(|error| format!("素材载入失败：{error}"))?;
    mpv.set_property("pause", start_paused || start_at.is_some())
        .map_err(|error| format!("素材自动播放失败：{error}"))?;
    lock(status).paused = start_paused || start_at.is_some();
    let _ = started.send(Ok(()));

    // Exact-seek latency is closed by mpv's PlaybackRestart event. No render
    // call or `seeking` property polling participates in this measurement.
    let mut pending_seek: Option<Instant> = None;
    let mut end_fence: Option<f64> = None;
    let mut seek_samples = Vec::new();
    // 隐藏期间不往 GL drawable 画:AppKit 对 hidden 的 NSOpenGLView 不保证
    // drawable 有效。解除遮挡时补画一帧,画面立刻接上。
    let mut hidden = occluded;
    let shutdown_reply = loop {
        // mpv 的 render 回调在播放时可持续以帧率灌入 RenderWake。若只在
        // recv_timeout 超时时轮询事件，队列一直有渲染消息时就永远不会超时，
        // time-pos / duration 等观察值会停在 0。每次处理任意 worker 消息后都
        // drain 一次事件；50ms timeout 只负责静止画面时的兜底。
        // R26 P-3:自动档暂停去抖未到时按剩余时间醒来,不吃 50 ms 轮询粒度。
        let idle = Duration::from_millis(50);
        let wait = switcher.next_wake(lock(status).paused).map_or(idle, |d| d.clamp(Duration::from_millis(1), idle));
        let message = match receiver.recv_timeout(wait) {
            Ok(message) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                drain_events(&mpv, status, &mut switcher, &mut pending_seek, &mut seek_samples, &mut handoff.gate)?;
                switcher.tick(&mpv, &mut lock(status));
                handoff.redraw_ready(&render_context, surface, hidden)?;
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
                if flags & mpv_render_update::Frame != 0 && !hidden
                    && render_frame(&render_context, surface)? {
                    handoff.frame_rendered();
                }
            }
            WorkerMessage::ForceRedraw => {
                if !hidden && render_frame(&render_context, surface)? {
                    handoff.frame_rendered();
                }
            }
            WorkerMessage::SetOccluded(occluded, reply) => {
                let result = set_surface_hidden(window, surface, occluded).and_then(|()| {
                    hidden = occluded;
                    if hidden {
                        Ok(())
                    } else {
                        render_frame(&render_context, surface).map(|rendered| {
                            if rendered { handoff.frame_rendered(); }
                        })
                    }
                });
                let failure = result.as_ref().err().cloned();
                let _ = reply.send(result);
                if let Some(error) = failure {
                    lock(status).fail(error.clone());
                    return Err(error);
                }
            }
            WorkerMessage::Resize(viewport, reply) => {
                // setFrame 不会碰 hidden 旗标,遮挡状态跨过 Resize 保持不变。
                // 不在这里同步画帧:先把回复还给调用方,下一轮循环再 ForceRedraw ——
                // 连续 Resize 时中间的帧根本不必画,也让主线程的 drawable 重建先落地。
                let result = resize_surface(window, surface, viewport);
                if result.is_ok() && !hidden {
                    let _ = redraw_sender.send(WorkerMessage::ForceRedraw);
                }
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
                let handled = matches!(&command, PlayerCommand::Play) && switcher.before_play(&mpv, &mut lock(status));
                if matches!(&command, PlayerCommand::Pause) && !lock(status).paused { switcher.note_pause_command(); }
                if matches!(&command, PlayerCommand::Pause | PlayerCommand::StepFwd | PlayerCommand::StepBack) {
                    if let Some(swap) = &mut switcher.swapping { swap.resume = false; }
                }
                let deferred = !handled && switcher.defer_during_swap(&command);
                let result = if handled || deferred { Ok(()) } else { execute_command(&mpv, status, switcher.mapper(), command, &mut pending_seek, &mut end_fence) };
                if let Err(error) = &result {
                    lock(status).fail(error.clone());
                }
                let failure = result.as_ref().err().cloned();
                let _ = reply.send(result);
                if let Some(error) = failure {
                    return Err(error);
                }
            }
            WorkerMessage::SetSourcePlan(plan, opened, reply) => {
                switcher.install(*plan, opened, &mut lock(status));
                let _ = reply.send(Ok(()));
            }
            WorkerMessage::SetPreviewQuality(quality, reply) => {
                let result = switcher.set_quality(&mpv, &mut lock(status), quality);
                let _ = reply.send(result);
            }
            WorkerMessage::Shutdown(reply) => break Some(reply),
        }
        drain_events(
            &mpv,
            status,
            &mut switcher,
            &mut pending_seek,
            &mut seek_samples,
            &mut handoff.gate,
        )?;
        switcher.tick(&mpv, &mut lock(status));
        handoff.redraw_ready(&render_context, surface, hidden)?;
    };

    Ok(shutdown_reply)
}

fn render_frame(render_context: &RenderContext<'_>, surface: &RenderSurface) -> Result<bool, String> {
    // 整个画帧 + 交换都在 CGL 锁里:主线程的 -update(窗口缩放、setFrame、
    // 取消隐藏)要等这一帧画完才能重建 drawable,反过来也一样。
    let _lock = CglLock::acquire(&surface.gl_context);
    let bounds = surface.gl_view.convertRectToBacking(surface.gl_view.bounds());
    let width = bounds.size.width.round() as i32;
    let height = bounds.size.height.round() as i32;
    if width < 2 || height < 2 {
        // 零尺寸 / 被裁到看不见的 drawable 上 glClear 没有意义,也是撞坏资源表的路径之一。
        return Ok(false);
    }
    render_context
        .render::<()>(0, width, height, true)
        .map_err(|error| format!("mpv render 失败：{error}"))?;
    surface.gl_context.flushBuffer();
    render_context.report_swap();
    Ok(true)
}

fn execute_command(
    mpv: &Mpv,
    status: &Arc<Mutex<PlayerStatus>>,
    time_mapper: Option<&crate::core::canonical_time::ProxyTimeMapper>,
    command: PlayerCommand,
    pending_seek: &mut Option<Instant>,
    end_fence: &mut Option<f64>,
) -> Result<(), String> {
    match command {
        PlayerCommand::Sync => {}
        PlayerCommand::Play => {
            mpv.set_property("pause", false)
                .map_err(|error| format!("播放失败：{error}"))?;
            lock(status).paused = false;
        }
        PlayerCommand::Pause => {
            pause_drain::prepare_pause(mpv, *end_fence);
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
        PlayerCommand::SetEnd { seconds } => {
            for call in mpv_calls_for(PlayerCommand::SetEnd { seconds })? {
                apply_mpv_call(mpv, call)?;
            }
            // 与实际 end 属性保持一致,只有设置成功才更新;新播放器实例从无围栏开始。
            *end_fence = seconds.filter(|value| value.is_finite() && *value >= 0.0);
        }
        command @ (PlayerCommand::ApplyDisplayLut { .. }
        | PlayerCommand::ClearDisplayLut
        | PlayerCommand::SelectAudioTrack { .. }
        | PlayerCommand::SetMute { .. }
        | PlayerCommand::SetSpeed { .. }
        | PlayerCommand::SetRotation { .. }) => {
            for call in mpv_calls_for(command)? {
                apply_mpv_call(mpv, call)?;
            }
        }
    }
    Ok(())
}

fn drain_events(
    mpv: &Mpv,
    status: &Arc<Mutex<PlayerStatus>>,
    switcher: &mut SourceSwitcher,
    pending_seek: &mut Option<Instant>,
    seek_samples: &mut Vec<f64>,
    handoff: &mut handoff::HandoffGate,
) -> Result<(), String> {
    loop {
        let ev = mpv.wait_event(0.0);

        match ev {
            None => return Ok(()),
            Some(Err(error)) => return Err(format!("mpv 事件错误：{error}")),
            Some(Ok(Event::FileLoaded)) => {
                // R26 P-3:换源中不在渲染线程上同步读属性。新文件的 vo reconfig 要本线程出帧/处理
                // render update,而同步 get_property 要等核心线程 —— 两头互等到 vo_libmpv 的 200 ms 超时
                // (「mpv_render_context_render() not being called or stuck」),暂停换原片因此多 ~200 ms。
                // 同一素材换源时长不变;宽高走观察事件。
                if switcher.swapping.is_some() { switcher.file_loaded(); continue; }
                let mut snapshot = lock(status);
                snapshot.duration = switcher.mapper()
                    .map(|mapper| mapper.source_duration_seconds())
                    .unwrap_or_else(|| mpv.get_property("duration").unwrap_or(snapshot.duration));
                snapshot.source_width = mpv.get_property("width").ok();
                snapshot.source_height = mpv.get_property("height").ok();
                switcher.file_loaded();
                snapshot.paused = mpv.get_property("pause").unwrap_or(true);
                snapshot.frame = mpv.get_property("estimated-frame-number").ok();
                // FileLoaded 可能早于 time-pos 的观察通知:首份 ready 必须读真实入点。
                if let Ok(position) = mpv.get_property::<f64>("time-pos") {
                    snapshot.pos = switcher.mapper()
                        .map(|mapper| mapper.source_seconds_for_proxy_seconds(position))
                        .unwrap_or(position).max(0.0);
                }
                snapshot.mark_ready();
            }
            Some(Ok(Event::PlaybackRestart)) => {
                handoff.playback_restart();
                switcher.on_playback_restart(mpv, &mut lock(status));
                if let Some(started) = pending_seek.take() {
                    let elapsed = started.elapsed().as_secs_f64() * 1_000.0;
                    seek_samples.push(elapsed);
                    lock(status).record_seek(elapsed, seek_samples);
                }
            }
            Some(Ok(Event::PropertyChange { name, change, .. })) => {
                if let ("eof-reached", PropertyData::Flag(value)) = (name, &change) { switcher.eof = *value; continue; }
                if switcher.swapping.is_some() && matches!(name, "time-pos" | "duration" | "pause" | "estimated-frame-number" | "frame-drop-count" | "decoder-frame-drop-count" | "width" | "height") { continue; }
                let mut snapshot = lock(status);
                match (name, change) {
                    ("time-pos", PropertyData::Double(value)) => {
                        snapshot.pos = switcher.mapper()
                            .map(|mapper| mapper.source_seconds_for_proxy_seconds(value))
                            .unwrap_or(value)
                            .max(0.0)
                    }
                    ("duration", PropertyData::Double(value)) => {
                        snapshot.duration = switcher.mapper()
                            .map(|mapper| mapper.source_duration_seconds())
                            .unwrap_or(value)
                            .max(0.0)
                    }
                    ("pause", PropertyData::Flag(value)) => snapshot.paused = value,
                    ("width", PropertyData::Int64(value)) => snapshot.source_width = Some(value),
                    ("height", PropertyData::Int64(value)) => snapshot.source_height = Some(value),
                    ("estimated-frame-number", PropertyData::Int64(value)) => {
                        snapshot.frame = Some(value)
                    }
                    ("frame-drop-count" | "decoder-frame-drop-count", PropertyData::Int64(value)) => {
                        snapshot.dropped_frames = Some(switcher.record_drops(name, value));
                        tracing::debug!(dropped = snapshot.dropped_frames, frame = snapshot.frame, "player frame drops");
                    }
                    _ => {}
                }
            }
            Some(Ok(Event::EndFile(_))) => {
                if switcher.swapping.is_some() { continue; }
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

fn schedule_surface_removal(window: &WebviewWindow, view: MainThreadView, own: handoff::ViewSlot) {
    let _ = window.run_on_main_thread(move || {
        // 强制整值捕获:2021 闭包的精确捕获(含模式解构)会只捕 view.0(非 Send),
        // 绕过包装器的 unsafe Send;先整体重绑再解构是官方惯用法。
        let view = view;
        let MainThreadView(inner) = view;
        inner.removeFromSuperview();
        lock(&own).take();
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

    #[test]
    fn loadfile_none_preserves_legacy_arguments() {
        assert_eq!(loadfile_args("/a.mov", None, None), ["/a.mov", "replace"]);
    }

    #[test]
    fn loadfile_start_is_a_paused_per_file_option() {
        assert_eq!(loadfile_args("/a.mov", Some(7.4), None),
            ["/a.mov", "replace", "-1", "start=7.4,pause=yes"]);
        assert_eq!(loadfile_args("/a.mov", Some(0.0), None)[3], "start=0,pause=yes");
    }

    #[test]
    fn loadfile_start_maps_source_seconds_to_proxy_seconds() {
        use crate::core::canonical_time::{ProxyTimeMapper, ProxyTimePoint};
        let mapper = ProxyTimeMapper::from_points(1, 1000, vec![
            ProxyTimePoint { proxy_ts_ms: 0, source_ticks: 0 },
            ProxyTimePoint { proxy_ts_ms: 5000, source_ticks: 10000 },
        ]).unwrap();
        assert_eq!(loadfile_args("/a.mov", Some(7.4), Some(&mapper))[3], "start=3.7,pause=yes");
    }

    #[test]
    fn loadfile_invalid_start_falls_back_to_legacy() {
        for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.1] {
            assert_eq!(loadfile_args("/a.mov", Some(invalid), None), ["/a.mov", "replace"]);
        }
    }

    #[test]
    fn loadfile_path_punctuation_never_enters_options() {
        assert_eq!(loadfile_args("/素材,a:b.mov", Some(7.4), None),
            ["/素材,a:b.mov", "replace", "-1", "start=7.4,pause=yes"]);
    }

    fn fake_session(worker: JoinHandle<()>) -> PlayerSession {
        PlayerSession {
            sender: channel().0,
            status: Arc::new(Mutex::new(PlayerStatus::closed())),
            worker: Some(worker),
            view: Arc::default(),
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
    fn stale_clip_commands_are_rejected_before_reaching_the_session() {
        // R17 playfix:A 在 open(B) 的锁后排队的 seek/play 不能落到 B 的实例上。
        assert_eq!(command_owner_check(Some(2), Some(1)), Err(STALE_CLIP_COMMAND.to_owned()));
        assert_eq!(command_owner_check(None, Some(1)), Err(STALE_CLIP_COMMAND.to_owned()));
        assert_eq!(command_owner_check(Some(2), Some(2)), Ok(()));
        assert_eq!(command_owner_check(Some(2), None), Ok(()), "旧调用方不带归属时保持原语义");
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
    fn occluded_flag_is_remembered_without_a_session() {
        // 覆盖层在没有会话时开合:旗标必须记住,后续 open() 才能一出生就隐藏。
        let mut state = ManagerState {
            viewport: PlayerViewport::default(),
            occluded: false,
            session: None,
            outgoing: None,
            generation: 0,
        };
        assert!(record_occlusion(&mut state, true).is_none());
        assert!(state.occluded);
        assert!(record_occlusion(&mut state, false).is_none());
        assert!(!state.occluded);
    }

    #[test]
    fn occlusion_notifies_the_session_only_when_the_flag_changes() {
        // 有会话时:旗标变化才通知渲染线程;重复同值不打扰它。
        let (sender, receiver) = channel();
        let mut state = ManagerState {
            viewport: PlayerViewport::default(),
            occluded: false,
            outgoing: None,
            generation: 0,
            session: Some(PlayerSession {
                sender,
                status: Arc::new(Mutex::new(PlayerStatus::closed())),
                worker: None,
                view: Arc::default(),
            }),
        };
        let mut notified = Vec::new();
        for next in [true, true, false, false] {
            if let Some(sender) = record_occlusion(&mut state, next) {
                let (reply, _) = channel();
                sender.send(WorkerMessage::SetOccluded(next, reply)).unwrap();
                notified.push(next);
            }
        }
        assert_eq!(notified, vec![true, false]);
        let mut seen = Vec::new();
        while let Ok(WorkerMessage::SetOccluded(flag, _)) = receiver.try_recv() {
            seen.push(flag);
        }
        assert_eq!(seen, vec![true, false]);
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
    fn viewport_frame_offsets_by_the_webview_area_not_the_full_content_view() {
        // 全尺寸 contentView 1000 高,webview 挂在 32px 标题栏下面:area = (0,0 1600×968)。
        // DOM y=75 的井,frame 顶必须在标题栏下 75px 处,即 AppKit y = 968 − 75 − 358 = 535,
        // 而不是按 1000 算出的 567(真机复核三:视频抬高一个标题栏盖住栏标题条)。
        let area = CGRect {
            origin: CGPoint { x: 0.0, y: 0.0 },
            size: CGSize { width: 1_600.0, height: 968.0 },
        };
        let frame = viewport_frame(
            area,
            PlayerViewport { x: 471.0, y: 75.0, width: 638.0, height: 358.0 },
        ).unwrap();
        assert_eq!(frame.origin.y, 535.0);
        assert_eq!(frame.size.height, 358.0);

        // area 自己带偏移(webview 不从 contentView 左下角开始)也一并算进去。
        let shifted = CGRect {
            origin: CGPoint { x: 10.0, y: 20.0 },
            size: CGSize { width: 800.0, height: 600.0 },
        };
        let frame = viewport_frame(shifted, PlayerViewport { x: 5.0, y: 8.0, width: 100.0, height: 50.0 }).unwrap();
        assert_eq!(frame.origin.x, 15.0);
        assert_eq!(frame.origin.y, 20.0 + 600.0 - 8.0 - 50.0);
    }

    #[test]
    fn seek_command_contract_is_tagged_and_snake_case() {
        let command: PlayerCommand = serde_json::from_str(
            r#"{"type":"seek_abs","seconds":12.5}"#,
        )
        .unwrap();
        assert_eq!(command, PlayerCommand::SeekAbs { seconds: 12.5 });
    }

    #[test]
    fn lut_and_track_commands_are_tagged_and_snake_case() {
        let apply: PlayerCommand =
            serde_json::from_str(r#"{"type":"apply_display_lut","path":"/tmp/x.cube"}"#).unwrap();
        assert_eq!(apply, PlayerCommand::ApplyDisplayLut { path: PathBuf::from("/tmp/x.cube") });

        let clear: PlayerCommand = serde_json::from_str(r#"{"type":"clear_display_lut"}"#).unwrap();
        assert_eq!(clear, PlayerCommand::ClearDisplayLut);

        let select: PlayerCommand =
            serde_json::from_str(r#"{"type":"select_audio_track","stream_index":2}"#).unwrap();
        assert_eq!(select, PlayerCommand::SelectAudioTrack { stream_index: 2 });

        let mute: PlayerCommand = serde_json::from_str(r#"{"type":"set_mute","muted":true}"#).unwrap();
        assert_eq!(mute, PlayerCommand::SetMute { muted: true });
    }

    #[test]
    fn set_end_fences_playback_at_the_out_point_and_none_clears_it() {
        // R23 ISSUE-A:出点由播放器自己守。契约是 tagged snake_case,和别的命令同一条路。
        let fence: PlayerCommand =
            serde_json::from_str(r#"{"type":"set_end","seconds":45.6}"#).unwrap();
        assert_eq!(fence, PlayerCommand::SetEnd { seconds: Some(45.6) });
        assert_eq!(
            mpv_calls_for(fence).unwrap(),
            vec![MpvCall::SetPropertyStr("end", "45.600000".to_owned())]
        );

        let clear: PlayerCommand = serde_json::from_str(r#"{"type":"set_end"}"#).unwrap();
        assert_eq!(clear, PlayerCommand::SetEnd { seconds: None });
        assert_eq!(
            mpv_calls_for(clear).unwrap(),
            vec![MpvCall::SetPropertyStr("end", "none".to_owned())]
        );

        // 空窗口是最坏的失败朝开:围栏关成 0 / 负数 / NaN 时宁可不设,也不能把播放窗口关死。
        for bad in [Some(0.0), Some(-1.0), Some(f64::NAN), Some(f64::INFINITY)] {
            assert_eq!(
                mpv_calls_for(PlayerCommand::SetEnd { seconds: bad }).unwrap(),
                vec![MpvCall::SetPropertyStr("end", "none".to_owned())],
                "seconds = {bad:?}"
            );
        }
    }

    #[test]
    fn escape_mpv_path_uses_length_prefixed_quoting_for_special_characters() {
        // libmpv's filter-graph syntax is delimited by `:`/`,`; a raw path
        // containing either would be silently mis-parsed. `%n%text` sidesteps
        // that entirely by length-prefixing instead of escaping characters.
        let path = PathBuf::from("/Users/x/my luts:weird, name.cube");
        let text = path.to_string_lossy();
        let escaped = escape_mpv_path(&path);
        assert_eq!(escaped, format!("%{}%{}", text.len(), text));
        assert!(escaped.starts_with(&format!("%{}%", text.len())));
    }

    #[test]
    fn mpv_calls_for_apply_lut_adds_labelled_filter_with_escaped_path() {
        let path = PathBuf::from("/Volumes/Look Book/rec709 to log.cube");
        let calls = mpv_calls_for(PlayerCommand::ApplyDisplayLut { path: path.clone() }).unwrap();
        assert_eq!(
            calls,
            vec![MpvCall::Command(
                "vf",
                vec![
                    "add".to_owned(),
                    format!("@tripcut-lut:lut3d={}", escape_mpv_path(&path)),
                ],
            )]
        );
    }

    #[test]
    fn mpv_calls_for_clear_lut_removes_the_exact_label_that_add_used() {
        let calls = mpv_calls_for(PlayerCommand::ClearDisplayLut).unwrap();
        assert_eq!(
            calls,
            vec![MpvCall::Command("vf", vec!["remove".to_owned(), "@tripcut-lut".to_owned()])]
        );
    }

    #[test]
    fn mpv_calls_for_audio_track_converts_zero_based_stream_index_to_one_based_aid() {
        assert_eq!(
            mpv_calls_for(PlayerCommand::SelectAudioTrack { stream_index: 0 }).unwrap(),
            vec![MpvCall::SetPropertyInt("aid", 1)]
        );
        assert_eq!(
            mpv_calls_for(PlayerCommand::SelectAudioTrack { stream_index: 2 }).unwrap(),
            vec![MpvCall::SetPropertyInt("aid", 3)]
        );
    }

    #[test]
    fn mpv_calls_for_audio_track_rejects_negative_stream_index() {
        assert!(mpv_calls_for(PlayerCommand::SelectAudioTrack { stream_index: -1 }).is_err());
    }

    #[test]
    fn mpv_calls_for_mute_sets_the_expected_property() {
        assert_eq!(
            mpv_calls_for(PlayerCommand::SetMute { muted: true }).unwrap(),
            vec![MpvCall::SetPropertyBool("mute", true)]
        );
    }

    #[test]
    fn mpv_calls_for_rotation_sets_video_rotate_for_the_three_real_orientations() {
        for degrees in [90, 180, 270] {
            assert_eq!(
                mpv_calls_for(PlayerCommand::SetRotation { degrees: Some(degrees) }).unwrap(),
                vec![MpvCall::SetPropertyInt("video-rotate", degrees)],
            );
        }
    }

    #[test]
    fn mpv_calls_for_rotation_none_or_zero_issues_no_call() {
        // A clip with no manual-correction rotation must not touch
        // video-rotate at all — mpv's own default already handles the
        // side_data case, so an unconditional call here would double it.
        assert!(mpv_calls_for(PlayerCommand::SetRotation { degrees: None }).unwrap().is_empty());
        assert!(mpv_calls_for(PlayerCommand::SetRotation { degrees: Some(0) }).unwrap().is_empty());
    }

    #[test]
    fn set_speed_command_contract_is_tagged_and_snake_case() {
        let command: PlayerCommand =
            serde_json::from_str(r#"{"type":"set_speed","speed":2.0}"#).unwrap();
        assert_eq!(command, PlayerCommand::SetSpeed { speed: 2.0 });
    }

    #[test]
    fn mpv_calls_for_set_speed_sets_the_speed_property_and_clamps_to_the_supported_range() {
        // R12 §5:真变速走 mpv 的 `speed` 属性;前端的 L 循环只会发 1/2/4,但菜单和
        // 未来的调用方可能发别的值 —— 0.25–4.0 之外一律夹紧,不让 mpv 收到 0 或负数。
        assert_eq!(
            mpv_calls_for(PlayerCommand::SetSpeed { speed: 2.0 }).unwrap(),
            vec![MpvCall::SetPropertyF64("speed", 2.0)]
        );
        assert_eq!(
            mpv_calls_for(PlayerCommand::SetSpeed { speed: 0.5 }).unwrap(),
            vec![MpvCall::SetPropertyF64("speed", 0.5)]
        );
        assert_eq!(
            mpv_calls_for(PlayerCommand::SetSpeed { speed: 16.0 }).unwrap(),
            vec![MpvCall::SetPropertyF64("speed", PLAYBACK_SPEED_MAX)]
        );
        assert_eq!(
            mpv_calls_for(PlayerCommand::SetSpeed { speed: 0.0 }).unwrap(),
            vec![MpvCall::SetPropertyF64("speed", PLAYBACK_SPEED_MIN)]
        );
        assert_eq!(
            mpv_calls_for(PlayerCommand::SetSpeed { speed: -2.0 }).unwrap(),
            vec![MpvCall::SetPropertyF64("speed", PLAYBACK_SPEED_MIN)]
        );
    }

    #[test]
    fn mpv_calls_for_set_speed_rejects_nan_and_infinite() {
        assert!(mpv_calls_for(PlayerCommand::SetSpeed { speed: f64::NAN }).is_err());
        assert!(mpv_calls_for(PlayerCommand::SetSpeed { speed: f64::INFINITY }).is_err());
    }

    #[test]
    fn clamp_playback_speed_bounds() {
        assert_eq!(clamp_playback_speed(1.0), Some(1.0));
        assert_eq!(clamp_playback_speed(0.1), Some(PLAYBACK_SPEED_MIN));
        assert_eq!(clamp_playback_speed(8.0), Some(PLAYBACK_SPEED_MAX));
        assert_eq!(clamp_playback_speed(f64::NAN), None);
    }

    #[test]
    fn mpv_calls_for_transport_commands_stay_empty_here() {
        // Play/Pause/StepFwd/StepBack/SeekAbs are handled directly in
        // execute_command's existing arms, not through this mapping.
        assert!(mpv_calls_for(PlayerCommand::Play).unwrap().is_empty());
        assert!(mpv_calls_for(PlayerCommand::SeekAbs { seconds: 1.0 }).unwrap().is_empty());
    }
}

#[cfg(test)]
mod command_settle_tests;
