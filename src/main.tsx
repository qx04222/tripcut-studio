import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import "./styles/tokens.css";
import "./styles.css";
import "./styles/kit.css";
import "./styles/workspace.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root mount element");
}

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// R19 E-05(bench 车道):首次 render 提交后的下一帧,报一次 `mark_first_paint`,
// 与 Rust 侧的 `rust_setup_ms` 拼成启动时间的两段拆分。预览/mock/单测环境没有
// Tauri host,`invoke` 会 reject——吞掉即可,不影响首屏。
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("mark_first_paint"))
      .catch(() => {});
  });
});
