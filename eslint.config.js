import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default tseslint.config(
  {
    ignores: ["sidecar/**", "scripts/**", "dist/**", "coverage/**", "src-tauri/target/**", ".superpowers/**", "qa/**", "bench/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "vite.config.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }
      ]
    },
  },
  {
    ...jsxA11y.flatConfigs.recommended,
    files: ["src/**/*.{jsx,tsx}"],
    rules: {
      ...Object.fromEntries(
        Object.entries(jsxA11y.flatConfigs.recommended.rules).map(([rule, config]) => {
          if (config === "off" || (Array.isArray(config) && config[0] === "off")) {
            return [rule, config];
          }
          return [rule, Array.isArray(config) ? ["error", ...config.slice(1)] : "error"];
        }),
      ),
      // 复选框卡片里 <label> 到 <input> 之间隔着说明文案的 wrapper(label > div >
      // strong > input),超出规则默认的 depth:2——这里不是缺关联,是合法的卡片式
      // 复选框布局,把搜索深度放宽到实际嵌套层数即可。
      "jsx-a11y/label-has-associated-control": ["error", { depth: 5 }],
    },
  },
);
