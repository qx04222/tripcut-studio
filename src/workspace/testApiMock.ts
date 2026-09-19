import { vi, type Mocked } from "vitest";

import type * as ApiModule from "../api";

/**
 * 挂壳类测试(WorkspaceShell / 两个抽屉 / 设置 sheet)共用的 `src/api.ts` 替身。
 *
 * 为什么要有这一份:新壳一挂载就把状态条、集切换、媒体池、镜头带、检查器全部
 * 拉起来,每个都在 effect 里打几条 api。以前每个测试文件各自手抄一份几十行的
 * `vi.hoisted` 对象,于是——
 *  - 任何一次合并只要有人往 api 里加一条新调用,所有文件同时红,而且红在
 *    「undefined 不是函数」这种离现场十万八千里的地方;
 *  - 两条分支各自补一行,合并后就是重复键(main 上 850b257 那次去重就是它)。
 *
 * 这一份**不手抄名单**:用 `vi.importActual` 拿到 `src/api.ts` 的真实导出表,
 * 每个函数导出都换成 `vi.fn(async () => [])`,非函数导出(类型以外的常量)原样
 * 保留。加一条新 api 命令,替身自动跟着有——不用改任何测试。
 *
 * 数组是这仓里最常见的返回形状(列表类命令),对象形状的那几条在
 * `SHELL_DEFAULTS` 里点名给默认值;个别用例要的具体返回值走 `overrides`。
 */

type ApiExports = typeof ApiModule;
export type TestApiMock = Mocked<ApiExports>;

/**
 * 对象形状的返回值。挂壳时这几条一定会被读到属性(`.chapters`、`.total` 等),
 * 回 `[]` 会在 `undefined.length` 处抛,把整棵 React 树拆掉,错误现场全失真。
 */
const SHELL_DEFAULTS: Record<string, () => unknown> = {
  getStoryboard: () => ({ chapters: [], candidates: [], items: [] }),
  getClipsRevision: () => 0,
  getSettings: () => ({}),
  getCurrentEpisode: () => undefined,
  getLlmStatus: () => ({
    enabled: false,
    provider: "none",
    monthly_budget: 200,
    calls_this_month: 0,
    remaining_calls: 200,
    budget_exhausted: false,
    providers: [],
  }),
  generationAvailability: () => ({ enabled: false, has_key: false, budget_remaining_usd: 0 }),
  getAppInfo: () => ({ version: "0.0.0", db_schema_version: 41, worker_count: 4, read_only: false }),
  hasMinimaxKey: () => false,
  // 状态条常驻轮询这三条(StatusStrip)。
  // R10 U-19:状态条把音乐分析进度并进轮询;回 [] 会让 `running + pending` 变 NaN。
  getMusicAnalysisProgress: () => ({ total: 0, done: 0, failed: 0, running: 0, pending: 0 }),
  // R10 U-19:壳挂载时桥接 Tauri 事件,卸载时调返回的解除函数——替身也得回一个函数。
  bridgeMusicAnalyzedEvents: () => () => undefined,
  // X-04:状态条自己桥接 import_probe 完成事件,同样要回一个解除函数。
  bridgeImportProbeEvents: () => () => undefined,
  getImportProgress: () => ({
    total: 0,
    done: 0,
    failed: 0,
    running: 0,
    waiting_for_permit: 0,
    paused_for_memory: false,
  }),
  clearCacheAndRebuild: () => ({ removed_database_rows: 0, reset_jobs: 0, removed_disk_bytes: 0 }),
  generationLedgerSummary: () => ({ month: "2026-09", spent_usd: 0, budget_usd: 10, entries: [] }),
  getSettingsStatus: () => ({
    ffmpeg: { configured_path: "", resolved_path: "ffmpeg", available: true, version: "6.0", note: null },
    ffprobe: { configured_path: "", resolved_path: "ffprobe", available: true, version: "6.0", note: null },
    whisper: {
      binary: { configured_path: "", resolved_path: "whisper-cli", available: true, version: "1.0", note: null },
      model_tier: "large-v3-turbo",
      model_path: "",
      model_available: true,
      models_directory: "",
    },
    clip_sidecar: {
      venv_path: "",
      service_path: "",
      setup_script: "",
      available: true,
      service_available: true,
      note: "",
    },
    cache: { database_bytes: 0, disk_bytes: 0 },
  }),
  rollbackComponent: () => ({}),
  runClipSelfCheck: () => ({}),
};

/**
 * 造一份完整的 api 替身。用法(顶层 await,配合 `vi.mock` 的惰性工厂):
 *
 * ```ts
 * const apiMocks = await createTestApiMock({ listClips: vi.fn(async () => [clip]) });
 * vi.mock("../api", () => apiMocks);
 * ```
 *
 * `overrides` 里出现 `src/api.ts` 没有的名字会直接抛 —— 打错字或命令改名时
 * 立刻在本文件炸掉,而不是让一个永远不会被调用的桩静静地躺着。
 */
export async function createTestApiMock(
  overrides: Record<string, unknown> = {},
): Promise<TestApiMock> {
  const actual = await vi.importActual<ApiExports>("../api");
  const mock: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value !== "function") {
      mock[name] = value;
      continue;
    }
    const shape = SHELL_DEFAULTS[name];
    mock[name] = shape ? vi.fn(async () => shape()) : vi.fn(async () => []);
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!(name in mock)) {
      throw new Error(`createTestApiMock: src/api.ts 没有导出 "${name}"(改名或打错字了?)`);
    }
    mock[name] = value;
  }
  return mock as TestApiMock;
}

// R17 车道 B:自动升级——壳一挂载 UpdateHost 就桥接进度事件(要回解除函数);检查更新默认「已是最新」。
SHELL_DEFAULTS.bridgeUpdateProgressEvents = () => () => undefined;
SHELL_DEFAULTS.checkForUpdate = () => ({ available: false, version: "0.0.0", notes: "", pub_date: "" });
// R17 车道 epmove:移到其他集——默认「一条也没动」;测试按需 mockImplementation 回旧归属。
SHELL_DEFAULTS.moveClipsToEpisode = () => ({ moved: 0, skipped_missing: 0, from: [] });
// R19 P-06(models 车道):状态条挂 ModelStatusPhrase 时桥接进度事件,替身要回一个解除函数;清单默认空。
SHELL_DEFAULTS.bridgeModelProgressEvents = () => () => undefined;
SHELL_DEFAULTS.listModels = () => [];
