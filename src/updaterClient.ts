// 应用内更新的前端接线。UI 组件只跟这里的纯函数 + 三个薄封装打交道,方便单测:
// 「签名坏掉时界面上到底出现哪几个字」是 R6 负例的判据,必须是可断言的纯函数,
// 不能藏在组件的 catch 里靠跑一次真实更新才知道。
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface UpdaterView {
  phase: UpdaterPhase;
  version: string | null;
  notes: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  message: string;
}

export const IDLE_UPDATER_VIEW: UpdaterView = {
  phase: "idle",
  version: null,
  notes: null,
  downloadedBytes: 0,
  totalBytes: null,
  message: "尚未检查更新。",
};

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// minisign 校验失败在 Rust 侧是 minisign_verify::Error,序列化到前端只是一句英文
// ("The signature verification failed")。用户看不懂,QA 也不该去断言英文——这里把它
// 翻成一句固定的中文,并保留英文原文作证据。
//
// M2(review 修复):判据只认包含 "signature"(大小写不敏感)。旧版还挂了
// /decod|base64|verif/ 等宽泛词,想顺带兜住「篡改 .sig 落在 base64 层先炸成
// base64::DecodeError」的路径,但这些词同样会命中一句普通的传输层错误
// ("error decoding response body"、"failed to verify checksum" 之类),
// 会把纯粹的网络故障误判成签名失败,负例断言就会在错误的原因上通过。
//
// R4 终审(第二次修复):光缩窄到 "signature" 一个词还不够——reqwest 的传输层
// 错误 Display 末尾常带一句 `for url (...)`(或 `(url: ...)`),而 GitHub
// release 资产会 302 到带 `X-Amz-Signature=...` 查询串的 S3/CloudFront 地址。
// 于是"下载中途断网"这类纯网络故障的错误串,只因为 URL 尾巴里凑巧出现了
// "Signature" 四个字母,也会被整段判成签名失败。修法:分类前先把这条尾巴剥掉
// (只影响判据用的文本,展示给用户的原文不变),再改用 tauri-plugin-updater /
// minisign-verify 真正会产出的、具体到"签名"这件事本身的措辞去匹配——
// "signature verification failed"、"signature ... could not be decoded"、
// "signature was created with a different key"——而不是宽泛的 "signature"。
function stripTransportUrlSuffix(detail: string): string {
  return detail.replace(/ for url \([^)]*\)$/i, "").replace(/ \(url: [^)]*\)$/i, "");
}

const SIGNATURE_ERROR_PATTERN =
  /signature (?:verification failed|[^.]*could not be decoded|was created with a different key)/i;

export function updaterErrorMessage(error: unknown): string {
  const detail = describe(error).trim() || "未知错误";
  const classificationTarget = stripTransportUrlSuffix(detail);
  if (SIGNATURE_ERROR_PATTERN.test(classificationTarget)) {
    return `更新包签名校验失败，已拒绝安装：${detail}`;
  }
  return `更新失败：${detail}`;
}

export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function downloadProgressLabel(downloaded: number, total: number | null): string {
  if (total === null || total <= 0) return `已下载 ${bytesLabel(downloaded)}`;
  const percent = Math.min(100, Math.round((downloaded / total) * 100));
  return `已下载 ${percent}%（${bytesLabel(downloaded)} / ${bytesLabel(total)}）`;
}

export function updateFoundMessage(version: string, notes: string | null): string {
  const head = `发现新版本 ${version}，当前版本可继续使用。`;
  const trimmed = (notes ?? "").trim();
  return trimmed ? `${head}更新说明：${trimmed}` : head;
}

export async function checkForUpdate(): Promise<Update | null> {
  return check();
}

export async function restartApp(): Promise<void> {
  return relaunch();
}

export async function downloadAndInstall(
  update: Update,
  onProgress: (downloaded: number, total: number | null) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? null;
      downloaded = 0;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
    }
    onProgress(downloaded, total);
  });
}
