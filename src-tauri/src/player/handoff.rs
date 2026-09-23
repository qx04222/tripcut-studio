//! One outgoing drawable remains above the incoming view until a real frame swaps.
use super::*;
use objc2::Message;

pub(super) type ViewSlot = Arc<Mutex<Option<MainThreadView>>>;
const DEADLINE: Duration = Duration::from_millis(1500);

#[derive(Default)]
pub(super) struct HandoffGate {
    restarted: bool,
    retired: bool,
}
impl HandoffGate {
    pub fn playback_restart(&mut self) {
        self.restarted = true;
    }
    pub fn needs_frame(&self) -> bool {
        self.restarted && !self.retired
    }
    pub fn frame_rendered(&mut self) -> bool {
        self.finish(self.restarted)
    }
    pub fn tick(&mut self, elapsed: Duration) -> bool {
        self.finish(elapsed >= DEADLINE)
    }
    fn finish(&mut self, ready: bool) -> bool {
        if self.retired || !ready {
            return false;
        }
        self.retired = true;
        true
    }
}

fn shutdown(session: PlayerSession, orphans: &Mutex<Vec<PlayerSession>>) {
    let (reply, _) = mpsc::channel();
    let _ = session.sender.send(WorkerMessage::Shutdown(reply));
    lock(orphans).push(session);
}

pub(super) fn retire_outgoing(state: &mut ManagerState, orphans: &Mutex<Vec<PlayerSession>>) {
    if let Some(session) = state.outgoing.take() {
        shutdown(session, orphans);
    }
}

pub(super) fn begin(
    state: &mut ManagerState,
    orphans: &Mutex<Vec<PlayerSession>>,
) -> (u64, Option<ViewSlot>) {
    retire_outgoing(state, orphans);
    state.generation += 1;
    state.outgoing = state.session.take();
    (
        state.generation,
        state.outgoing.as_ref().map(|s| Arc::clone(&s.view)),
    )
}

// Drop covers every worker exit, including surface setup errors and unwinding.
// A separate deadline remains effective even if native setup/render is blocked.
pub(super) struct Handoff {
    state: Arc<Mutex<ManagerState>>,
    orphans: Arc<Mutex<Vec<PlayerSession>>>,
    generation: u64,
    finished: mpsc::Sender<()>,
    pub gate: HandoffGate,
}
impl Handoff {
    pub fn new(manager: &PlayerManager, generation: u64) -> Result<Self, String> {
        let (finished, receiver) = mpsc::channel();
        let state = Arc::clone(&manager.state);
        let orphans = Arc::clone(&manager.orphans);
        let deadline_state = Arc::clone(&state);
        let deadline_orphans = Arc::clone(&orphans);
        thread::Builder::new()
            .name("tripcut-player-handoff".into())
            .spawn(move || {
                if receiver.recv_timeout(DEADLINE).is_err() && HandoffGate::default().tick(DEADLINE)
                {
                    retire_generation(&deadline_state, &deadline_orphans, generation);
                }
            })
            .map_err(|error| format!("无法启动播放器交接保护：{error}"))?;
        Ok(Self {
            state,
            orphans,
            generation,
            finished,
            gate: HandoffGate::default(),
        })
    }
    pub fn redraw_ready(
        &mut self,
        context: &RenderContext<'_>,
        surface: &RenderSurface,
        hidden: bool,
    ) -> Result<(), String> {
        if !hidden && self.gate.needs_frame() && render_frame(context, surface)? {
            self.frame_rendered();
        }
        Ok(())
    }
    pub fn frame_rendered(&mut self) {
        if self.gate.frame_rendered() {
            self.retire();
        }
    }
    fn retire(&self) {
        retire_generation(&self.state, &self.orphans, self.generation);
        let _ = self.finished.send(());
    }
}
impl Drop for Handoff {
    fn drop(&mut self) {
        self.retire();
    }
}
fn retire_generation(
    state: &Mutex<ManagerState>,
    orphans: &Mutex<Vec<PlayerSession>>,
    generation: u64,
) {
    let mut state = lock(state);
    if state.generation == generation {
        retire_outgoing(&mut state, orphans);
    }
}

/// Called only on AppKit's main thread. ViewSlot never exposes AppKit off-thread.
pub(super) fn place_view(
    content: &NSView,
    view: &NSOpenGLView,
    below: Option<ViewSlot>,
    own: ViewSlot,
) {
    let old = below.as_ref().map(|slot| lock(slot));
    let old_view = old.as_ref().and_then(|slot| slot.as_ref());
    // SAFETY: both retained views are accessed only in this main-thread callback.
    if let Some(old) = old_view.filter(|old| unsafe { old.0.superview().is_some() }) {
        content.addSubview_positioned_relativeTo(view, NSWindowOrderingMode::Below, Some(&old.0));
    } else {
        content.addSubview_positioned_relativeTo(view, NSWindowOrderingMode::Above, None);
    }
    *lock(&own) = Some(MainThreadView(view.retain()));
}

pub(super) fn occlude_outgoing(state: &ManagerState, occluded: bool) {
    if let Some(session) = &state.outgoing {
        let (reply, _) = mpsc::channel();
        let _ = session
            .sender
            .send(WorkerMessage::SetOccluded(occluded, reply));
    }
}

pub(super) fn stop_sessions(
    state: &Mutex<ManagerState>,
    orphans: &Mutex<Vec<PlayerSession>>,
) -> Result<(), String> {
    let session = {
        let mut state = lock(state);
        retire_outgoing(&mut state, orphans);
        state.session.take()
    };
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
                lock(orphans).push(session);
                return Err("播放器关闭超时，渲染线程已隔离退出流程".to_owned());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session() -> (PlayerSession, mpsc::Receiver<WorkerMessage>) {
        let (sender, receiver) = mpsc::channel();
        (
            PlayerSession {
                sender,
                status: Arc::new(Mutex::new(PlayerStatus::closed())),
                worker: None,
                view: Arc::default(),
            },
            receiver,
        )
    }
    fn state() -> ManagerState {
        ManagerState {
            viewport: PlayerViewport::default(),
            occluded: false,
            session: None,
            outgoing: None,
            generation: 0,
        }
    }
    fn shutdowns(receiver: &mpsc::Receiver<WorkerMessage>) -> usize {
        receiver
            .try_iter()
            .filter(|msg| matches!(msg, WorkerMessage::Shutdown(_)))
            .count()
    }
    #[test]
    fn initial_black_render_is_not_a_frame_and_restart_alone_does_not_retire() {
        let mut gate = HandoffGate::default();
        assert!(!gate.frame_rendered());
        gate.playback_restart();
        assert!(!gate.tick(Duration::from_millis(1499)));
        assert!(gate.frame_rendered());
        assert!(!gate.frame_rendered());
        assert!(!gate.tick(DEADLINE));
    }
    #[test]
    fn open_preserves_old_until_gate_opens_exactly_once() {
        let mut state = state();
        let orphans = Mutex::new(vec![]);
        let (old, receiver) = session();
        state.session = Some(old);
        begin(&mut state, &orphans);
        assert_eq!(shutdowns(&receiver), 0);
        let mut gate = HandoffGate::default();
        gate.playback_restart();
        if gate.frame_rendered() {
            retire_outgoing(&mut state, &orphans);
        }
        if gate.frame_rendered() {
            retire_outgoing(&mut state, &orphans);
        }
        assert_eq!(shutdowns(&receiver), 1);
        assert_eq!(lock(&orphans).len(), 1);
    }
    #[test]
    fn deadline_retires_once_without_first_frame() {
        let mut state = state();
        let orphans = Mutex::new(vec![]);
        let (old, receiver) = session();
        state.outgoing = Some(old);
        let mut gate = HandoffGate::default();
        assert!(!gate.tick(DEADLINE - Duration::from_millis(1)));
        if gate.tick(DEADLINE) {
            retire_outgoing(&mut state, &orphans);
        }
        assert!(!gate.tick(DEADLINE));
        assert_eq!(shutdowns(&receiver), 1);
    }
    #[test]
    fn another_open_retires_previous_outgoing_and_stale_worker_cannot_retire_new_one() {
        let mut state = state();
        let orphans = Mutex::new(vec![]);
        let (a, ar) = session();
        state.session = Some(a);
        let (generation, _) = begin(&mut state, &orphans);
        let (b, br) = session();
        state.session = Some(b);
        begin(&mut state, &orphans);
        let state = Mutex::new(state);
        retire_generation(&state, &orphans, generation);
        assert_eq!(shutdowns(&ar), 1);
        assert_eq!(shutdowns(&br), 0);
        let generation = lock(&state).generation;
        retire_generation(&state, &orphans, generation);
        assert_eq!(shutdowns(&br), 1);
    }
    #[test]
    fn close_shuts_down_both_current_and_outgoing() {
        let mut state = state();
        let orphans = Mutex::new(vec![]);
        let (old, old_receiver) = session();
        state.outgoing = Some(old);
        let (current, receiver) = session();
        state.session = Some(current);
        let ack = thread::spawn(move || {
            if let WorkerMessage::Shutdown(reply) = receiver.recv().unwrap() {
                reply.send(()).unwrap();
            }
            assert_eq!(shutdowns(&receiver), 0);
        });
        let state = Mutex::new(state);
        stop_sessions(&state, &orphans).unwrap();
        ack.join().unwrap();
        assert_eq!(shutdowns(&old_receiver), 1);
        assert!(lock(&state).session.is_none());
        assert!(lock(&state).outgoing.is_none());
    }
    #[test]
    fn worker_error_or_early_exit_retires_outgoing_without_render() {
        let mut state = state();
        let (old, receiver) = session();
        state.outgoing = Some(old);
        let state = Arc::new(Mutex::new(state));
        let orphans = Arc::new(Mutex::new(vec![]));
        let (finished, _) = mpsc::channel();
        drop(Handoff {
            state: Arc::clone(&state),
            orphans,
            generation: 0,
            finished,
            gate: HandoffGate::default(),
        });
        assert_eq!(shutdowns(&receiver), 1);
        assert!(lock(&state).outgoing.is_none());
    }
    #[test]
    fn occlusion_reaches_outgoing() {
        let mut state = state();
        let (old, receiver) = session();
        state.outgoing = Some(old);
        occlude_outgoing(&state, true);
        assert!(matches!(
            receiver.try_recv(),
            Ok(WorkerMessage::SetOccluded(true, _))
        ));
    }
}
