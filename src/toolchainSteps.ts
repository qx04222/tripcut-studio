import type { SettingsStatus } from "./api";

/**
 * 工具链检查的纯逻辑(R11 简化专项 #1):首启弹窗 `FirstRunGuide` 与 设置 → 工具链 的
 * 「安装检查」卡共用。单独成文件是为了 chunk 分组:它被首屏与懒加载的 settings 块同时
 * 引用,不点名归入 app-core 的话 rolldown 会把它塞进 settings 块,首屏就静态拉设置了。
 */
export interface GuideStep {
  id: string;
  title: string;
  description: string;
  command?: string;
  commandLabel?: string;
  tone?: "danger";
  /** 必需组件(ffmpeg / ffprobe)缺失才算 required —— 只有这种才在首启自动弹出(R11 简化专项 #1)。 */
  required?: boolean;
}

/** 必需组件缺失(ffmpeg / ffprobe)= 首启才自动弹工具链引导;其余步骤只在 设置 → 工具与模型 里看。 */
export function requiredToolsMissing(status: SettingsStatus): boolean {
  return onboardingSteps(status).some((step) => step.required === true);
}

export function onboardingSteps(status: SettingsStatus): GuideStep[] {
  const steps: GuideStep[] = [];

  if (!status.ffmpeg.available || !status.ffprobe.available) {
    steps.push({
      id: "bundled-tools-missing",
      title: "核心媒体工具不完整",
      description: "正式安装包应自带 FFmpeg 与 FFprobe,没有它们就无法导入和导出。请重新安装完整 DMG;不要自行修改 .app 内容,否则会破坏签名。",
      tone: "danger",
      required: true,
    });
  }

  if (!status.whisper.binary.available) {
    steps.push({
      id: "whisper-binary",
      title: "语音转写组件缺失",
      description: "正式安装包应自带 Whisper。缺失时只影响本地语音转写;导入、挑选、播放与导出都不受影响。重新安装完整 DMG 即可补齐。",
    });
  }

  if (!status.whisper.model_available) {
    steps.push({
      id: "whisper-model",
      title: "可选：提供已校验的 Whisper 模型",
      description: `当前正式版不会联网下载模型。需要本地转写时，请将已合法取得并核验的对应 ggml 模型放到：${status.whisper.model_path}；不安装不会影响导入、筛片、播放与交付。`,
    });
  }

  if (!status.clip_sidecar.service_available) {
    steps.push({
      id: "sidecar-resource",
      title: "应用资源不完整",
      description: `未找到 ${status.clip_sidecar.service_path}。请重新安装完整 DMG；不要在 .app 内手工补文件，否则会破坏签名。`,
      tone: "danger",
    });
  } else if (!status.clip_sidecar.available) {
    steps.push({
      id: "clip-sidecar",
      title: "初始化本地 Chinese-CLIP 环境",
      description: "正式版不在线安装 Python 运行环境。画面语义搜索将在签名组件包可用后启用；其余核心筛片与交付不受影响。",
    });
  }

  return steps;
}
