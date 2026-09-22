import type { PlayerCommand, PlayerStatus } from '../../api';

/**
 * 测试用的自走播放器:模拟 mpv 的真实语义 —— 播放中位置自己往前走、seek 异步落地、
 * 状态按 80 ms 轮询回读。R23 复现车道用它证实「播放器进入未选原片区间」。
 *
 * 真机语义对应:
 * - `send` 里每条命令都先排队再落地,`await send(...)` resolve 时命令已经到位(Rust 侧
 *   player_command 等状态回读);`seekLandTicks > 0` 时改成「命令回来了但位置还没到」。
 * - 播放中每个 tick 位置按 tickMs × rate 前进,没有任何人替它在出点停下 —— 停不停由被测代码决定。
 */
export interface FakePlayerOptions {
  clips: ReadonlyMap<number, number>;
  clipId: number;
  /** seek 命令发出后还要几个 tick 位置才真正变(0 = 命令落地即到位)。 */
  seekLandTicks?: number;
  /** 换素材(player_open)要几个 tick 才 ready。 */
  openTicks?: number;
  tickMs?: number;
}

export class FakePlayer {
  readonly tickMs: number;
  private readonly clips: ReadonlyMap<number, number>;
  private readonly seekLandTicks: number;
  private readonly openTicks: number;
  clipId: number;
  pos = 0;
  paused = true;
  phase: PlayerStatus['phase'] = 'ready';
  speed = 1;
  /** 每个 tick 记一行:测试拿它当「采样日志」。 */
  readonly samples: { t: number; clipId: number; pos: number; paused: boolean }[] = [];
  readonly commands: { t: number; cmd: PlayerCommand }[] = [];
  elapsed = 0;
  private pendingSeek: { target: number; ticks: number } | null = null;
  private openCountdown = 0;
  /** mpv 的 `end`:播到这儿就 EOF,keep-open 让它停在那一帧。 */
  endFence: number | null = null;

  constructor(options: FakePlayerOptions) {
    this.clips = options.clips;
    this.clipId = options.clipId;
    this.seekLandTicks = options.seekLandTicks ?? 0;
    this.openTicks = options.openTicks ?? 1;
    this.tickMs = options.tickMs ?? 80;
  }

  get duration(): number {
    return this.clips.get(this.clipId) ?? 0;
  }

  status(): PlayerStatus {
    return {
      phase: this.phase, clip_id: this.clipId, pos: this.pos, duration: this.duration,
      paused: this.paused, frame: null, error: null,
      seek_samples: 0, seek_p50_ms: null, seek_p95_ms: null, last_seek_ms: null,
    };
  }

  /** 换素材:和 Rust 的 player_open 一样,载入即播,几拍后才 ready。 */
  open(clipId: number, startPaused = false): void {
    this.clipId = clipId;
    this.phase = 'loading';
    this.pos = 0;
    this.paused = startPaused;
    this.pendingSeek = null;
    this.endFence = null;
    this.openCountdown = this.openTicks;
  }

  send = async (commands: PlayerCommand[]): Promise<void> => {
    for (const cmd of commands) {
      this.commands.push({ t: this.elapsed, cmd });
      if (this.phase !== 'ready') continue;
      if (cmd.type === 'play') this.paused = false;
      else if (cmd.type === 'pause') this.paused = true;
      else if (cmd.type === 'set_speed') this.speed = cmd.speed;
      else if (cmd.type === 'set_end') this.endFence = cmd.seconds;
      else if (cmd.type === 'seek_abs') {
        // 真 mpv:`end` 还挂着时 seek 到它之后会被夹到 end 上(mpv 0.41 实测:end=34.2 时
        // seek 39.4 落在 34.16)。上一段的围栏必须先撤掉,再 seek 下一段入点。
        const ceiling = this.endFence ?? this.duration;
        const target = Math.min(Math.min(this.duration, ceiling), Math.max(0, cmd.seconds));
        if (this.seekLandTicks <= 0) { this.pos = target; this.pendingSeek = null; }
        else this.pendingSeek = { target, ticks: this.seekLandTicks };
      }
    }
    // Rust 侧 player_command 是一次 await;用两个微任务代表它。
    await Promise.resolve();
    await Promise.resolve();
  };

  /** 推进一拍真实时间:位置自己走,seek 到期落地,载入到期就绪。 */
  tick(): void {
    this.elapsed += this.tickMs;
    if (this.openCountdown > 0) {
      this.openCountdown -= 1;
      if (this.openCountdown === 0) this.phase = 'ready';
    }
    if (this.pendingSeek) {
      this.pendingSeek.ticks -= 1;
      if (this.pendingSeek.ticks <= 0) { this.pos = this.pendingSeek.target; this.pendingSeek = null; }
    } else if (this.phase === 'ready' && !this.paused) {
      const next = Math.min(this.duration, this.pos + (this.tickMs / 1000) * this.speed);
      if (this.endFence !== null && next >= this.endFence) { this.pos = this.endFence; this.paused = true; }
      else this.pos = next;
    }
    this.samples.push({ t: this.elapsed, clipId: this.clipId, pos: this.pos, paused: this.paused });
  }
}
