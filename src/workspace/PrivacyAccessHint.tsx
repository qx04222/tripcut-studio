import { type JSX } from "react";

import { openExternalUrl } from "../api";
import { Button } from "./ui";

/**
 * R18 车道 native / H-07:权限被拒之后的下一步。
 *
 * `errorText.ts` 已经把 `Permission denied` / `Operation not permitted` 翻成了中文一句话,
 * 但只说了"被拒",没说**现在怎么办**——全仓 `x-apple.systempreferences:` 零命中
 * (brainstorm-holistic §1.4)。这里补上那一个按钮:直接跳到
 * 系统设置 › 隐私与安全性 › 文件与文件夹。
 *
 * 判定按**中文文案**,不按英文原因:用户看到的、我们能拿到的都是翻译后的那句话。
 */
export const PRIVACY_FILES_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";

const DENIED_PHRASES = ["没有写入权限", "系统不允许这个操作", "没有访问权限", "权限不足"];

/** 这条错误是不是"系统没放行",而不是"文件真的不在"。 */
export function isPermissionDenied(text: string | null | undefined): boolean {
  if (!text) return false;
  return DENIED_PHRASES.some((phrase) => text.includes(phrase));
}

/**
 * 权限类错误旁边的那一个按钮;不是权限问题就渲染 null(不给每条错误都挂一个按钮)。
 * AX:按钮「去系统设置打开」。
 */
export function PrivacyAccessHint({ text }: { text: string | null | undefined }): JSX.Element | null {
  if (!isPermissionDenied(text)) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void openExternalUrl(PRIVACY_FILES_URL).catch(() => undefined);
      }}
    >
      去系统设置打开
    </Button>
  );
}
