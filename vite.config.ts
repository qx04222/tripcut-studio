/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ["./src/test-setup.ts"],
  },
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    // Vite 8 runs on rolldown, whose deprecated `manualChunks` maps 1:1 onto
    // `output.codeSplitting.groups` (rollup's function form is not supported
    // here, only string/regex `test`) — see rolldown OutputOptions docs.
    // Split the three heaviest page modules and the two heaviest deps into
    // their own chunks so no single chunk crosses chunkSizeWarningLimit.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "vendor-dnd", test: /node_modules[\\/]@dnd-kit/ },
            { name: "vendor-cmdk", test: /node_modules[\\/]cmdk/ },
            { name: "storyboard", test: /[\\/]src[\\/]Storyboard\.tsx/ },
            { name: "select", test: /[\\/]src[\\/]SelectPage\.tsx/ },
            { name: "settings", test: /[\\/]src[\\/]SettingsPage\.tsx/ },
          ],
        },
      },
    },
  },
});
