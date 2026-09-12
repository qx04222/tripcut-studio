import { useCallback, useEffect, useState } from "react";
import {
  cancelExport,
  generateJianyingDraft,
  getCurrentEpisode,
  getJianyingAvailability,
  listPlatformPresets,
  pickExportFolder,
  revealExport,
  startExport,
  type JianyingAvailability,
  type JianyingDraftResult,
  type TargetPlatform,
} from "../../api";
import { closestTargetWithinBudget, presetBudgetSeconds, type TargetSecondsOption } from "./deliverModel";
import type { ExportProgress } from "./useExportProgress";

export interface DeliverForm {
  /** 当前集标题(抽屉副标题用);还没读回来时是空串。 */
  episodeTitle: string;
  episodePlatform: TargetPlatform;
  overridePlatform: TargetPlatform;
  setOverridePlatform(p: TargetPlatform): void;
  targetSeconds: TargetSecondsOption;
  setTargetSeconds(t: TargetSecondsOption): void;
  includeContactSheet: boolean;
  setIncludeContactSheet(v: boolean): void;
  jianying: JianyingAvailability;
  nativeBusy: boolean;
  nativeResult: JianyingDraftResult | null;
  nativeNotice: string | null;
  destination: string | null;
  busy: boolean;
  /** 表单自己的错误(选目录 / 启动 / 取消 / 打开文件夹)或轮询错误,二者取其一。 */
  error: string | null;
  canGenerate: boolean;
  canGenerateNative: boolean;
  generate(): Promise<void>;
  generateNative(): Promise<void>;
  cancel(): Promise<void>;
  reveal(): Promise<void>;
}

const CHECKING_JIANYING: JianyingAvailability = {
  installed_version: null,
  supported: false,
  reason: "正在检测剪映版本与草稿目录…",
};

/**
 * 交付表单状态与动作(从 `DeliverPage` 抽出,行为不变):平台 / 时长 / 联系表 /
 * 剪映可用性 / generate / generateNative(失败自动降级稳定包)/ cancel / reveal,
 * 以及 `tripcut:episode-changed`、`tripcut:action`(deliver-export)、
 * `tripcut:deliver-availability` 三条窗口事件。
 */
export function useDeliverForm(progress: ExportProgress): DeliverForm {
  const { status, active, setStatus, setJobId, refresh } = progress;
  const [destination, setDestination] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [jianying, setJianying] = useState<JianyingAvailability>(CHECKING_JIANYING);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [nativeResult, setNativeResult] = useState<JianyingDraftResult | null>(null);
  const [nativeNotice, setNativeNotice] = useState<string | null>(null);
  const [episodeTitle, setEpisodeTitle] = useState("");
  const [episodePlatform, setEpisodePlatform] = useState<TargetPlatform>("general");
  const [overridePlatform, setOverridePlatform] = useState<TargetPlatform>("general");
  const [includeContactSheet, setIncludeContactSheet] = useState(true);
  const [targetSeconds, setTargetSeconds] = useState<TargetSecondsOption>(null);

  useEffect(() => {
    let alive = true;
    const loadEpisodePlatform = () => {
      void Promise.all([getCurrentEpisode(), listPlatformPresets().catch(() => [])])
        .then(([episode, presets]) => {
          if (!alive) return;
          setEpisodeTitle(episode.title);
          setEpisodePlatform(episode.target_platform);
          setOverridePlatform(episode.target_platform);
          const preset = presets.find((candidate) => candidate.platform === episode.target_platform);
          setTargetSeconds(closestTargetWithinBudget(presetBudgetSeconds(preset)));
        })
        .catch(() => undefined);
    };
    const onEpisodeChanged = () => {
      // 换集:上一集的草稿结果与错误不再成立(轮询状态由 useExportProgress 自己重置)。
      setNativeResult(null);
      setFormError(null);
      loadEpisodePlatform();
    };
    loadEpisodePlatform();
    window.addEventListener("tripcut:episode-changed", onEpisodeChanged);
    return () => {
      alive = false;
      window.removeEventListener("tripcut:episode-changed", onEpisodeChanged);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void getJianyingAvailability()
      .then((next) => {
        if (alive) setJianying(next);
      })
      .catch((availabilityError) => {
        if (alive) {
          setJianying({
            installed_version: null,
            supported: false,
            reason: `剪映兼容性检测失败:${String(availabilityError)}`,
          });
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const canGenerate = !busy && !active && status.selected_count > 0;
  const canGenerateNative = jianying.supported && !nativeBusy && !active && status.selected_count > 0;

  const startStablePackage = useCallback(
    async (selected: string) => {
      setDestination(selected);
      const started = await startExport(
        selected,
        overridePlatform === episodePlatform ? undefined : overridePlatform,
        includeContactSheet,
        targetSeconds ?? undefined,
      );
      setStatus(started);
      setJobId(started.job_id);
    },
    [episodePlatform, includeContactSheet, overridePlatform, setJobId, setStatus, targetSeconds],
  );

  const generate = useCallback(async () => {
    if (busy || active || status.selected_count === 0) return;
    setBusy(true);
    setFormError(null);
    try {
      const selected = await pickExportFolder();
      if (!selected) return;
      await startStablePackage(selected);
    } catch (startError) {
      setFormError(String(startError));
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [active, busy, refresh, startStablePackage, status.selected_count]);

  const generateNative = useCallback(async () => {
    setNativeBusy(true);
    setNativeResult(null);
    setNativeNotice(null);
    setFormError(null);
    try {
      const result = await generateJianyingDraft();
      setNativeResult(result);
    } catch (nativeError) {
      const reason = String(nativeError);
      setNativeNotice(`原生草稿未通过自检:${reason}。请选择位置后自动降级为稳定交付包。`);
      try {
        const selected = await pickExportFolder();
        if (!selected) {
          setFormError(`${reason};未选择稳定包保存位置,尚未生成降级交付。`);
          return;
        }
        await startStablePackage(selected);
        setNativeNotice(`原生草稿未通过自检,已降级并开始生成稳定交付包。原因:${reason}`);
      } catch (fallbackError) {
        setFormError(`原生草稿失败:${reason};稳定包降级也未能启动:${String(fallbackError)}`);
      }
    } finally {
      setNativeBusy(false);
    }
  }, [startStablePackage]);

  const cancel = useCallback(async () => {
    if (status.job_id === null) return;
    setFormError(null);
    try {
      await cancelExport(status.job_id);
      await refresh();
    } catch (cancelError) {
      setFormError(String(cancelError));
    }
  }, [refresh, status.job_id]);

  const reveal = useCallback(async () => {
    if (status.job_id === null) return;
    setFormError(null);
    try {
      await revealExport(status.job_id);
    } catch (revealError) {
      setFormError(String(revealError));
    }
  }, [status.job_id]);

  // 顶栏 / 命令面板的「生成交付包」动作。每次渲染重挂,拿到的永远是最新的 generate。
  useEffect(() => {
    const onAction = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "deliver-export") void generate();
    };
    window.addEventListener("tripcut:action", onAction);
    return () => window.removeEventListener("tripcut:action", onAction);
  }, [generate]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("tripcut:deliver-availability", { detail: canGenerate }));
    return () => {
      window.dispatchEvent(new CustomEvent("tripcut:deliver-availability", { detail: false }));
    };
  }, [canGenerate]);

  return {
    episodeTitle,
    episodePlatform,
    overridePlatform,
    setOverridePlatform,
    targetSeconds,
    setTargetSeconds,
    includeContactSheet,
    setIncludeContactSheet,
    jianying,
    nativeBusy,
    nativeResult,
    nativeNotice,
    destination,
    busy,
    error: formError ?? progress.error,
    canGenerate,
    canGenerateNative,
    generate,
    generateNative,
    cancel,
    reveal,
  };
}
