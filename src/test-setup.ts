// jsdom 缺口 polyfill:react-resizable-panels v4 依赖 ResizeObserver。
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}

// jsdom 默认窗口 1024×768,比 tauri.conf.json 里强制的最小窗口(1280)还窄 ——
// 新壳一挂载就会按窄窗规则把两侧栏折起来,于是每个测试拿到的都是一个现实中
// 不存在的窗口。统一撑到 1440,要测窄窗的用例自己再改小。
// 纯逻辑的用例跑在 node 环境里,那里根本没有 window —— 不守这一道,整个文件在
// 收集阶段就炸,表现成「某某 test 文件 FAIL」而不是某条断言红。
if (typeof window !== "undefined") {
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: 900, configurable: true, writable: true });
}
