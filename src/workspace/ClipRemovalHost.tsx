import type { JSX } from "react";

import { cancelClipRemoval, confirmClipRemoval, useClipRemoval } from "./clipRemoval";
import { RemovalConfirm } from "./import/RemovalConfirm";
import { Sheet } from "./ui";

/**
 * R16 P1-1:「移除素材…」的确认卡宿主 —— 壳里挂一次(与 ToastHost 并列)。居中 sheet 里放导入页
 * 那张 `alertdialog`,Esc / 取消都只关卡,不动数据。
 */
export function ClipRemovalHost(): JSX.Element | null {
  const state = useClipRemoval();
  if (state === null) return null;
  return (
    <Sheet open title="移除素材" width="min(560px, 90vw)" height="auto" onClose={cancelClipRemoval}>
      <div className="clip-removal-body">
        <RemovalConfirm
          request={state.request}
          preview={state.preview}
          busy={state.busy}
          title={state.title}
          onCancel={cancelClipRemoval}
          onConfirm={() => void confirmClipRemoval()}
        />
      </div>
    </Sheet>
  );
}
