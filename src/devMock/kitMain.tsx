// 套件预览页入口(kit.html)。只在 `vite --mode mock` / `vite dev` 下可访问;生产 build
// 只打 index.html,本文件不进产物(src/devMock/viteMock.test.ts 断言)。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../styles/tokens.css";
import "../styles.css";
import "../styles/kit.css";
import "./kitPreview.css";
import { KitPreview } from "./KitPreview";

const root = document.getElementById("kit");
if (!root) throw new Error("Missing #kit mount element");

createRoot(root).render(
  <StrictMode>
    <KitPreview />
  </StrictMode>,
);
