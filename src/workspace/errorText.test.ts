import { describe, expect, it } from "vitest";

import { describeError, failureText } from "./errorText";

describe("errorText(R11 简化专项 #5:错误一句话,不带内部代码)", () => {
  it("剥掉 Error: 前缀、Rust Os {…}、常量名、code=、堆栈与指针", () => {
    expect(describeError(new Error("磁盘只读"))).toBe("磁盘只读");
    expect(describeError("Error: 文件夹不存在 Os { code: 2, kind: NotFound, message: \"No such file\" }")).toBe("文件夹不存在");
    expect(describeError("E_DEST_UNAVAILABLE: 上次的导出文件夹不在了")).toBe("上次的导出文件夹不在了");
    expect(describeError("ffprobe 退出 code=1")).toBe("ffprobe 退出");
    expect(describeError("Error: 播放器没响应\n    at invoke (core.js:12)")).toBe("播放器没响应");
  });

  it("什么都不剩时退成「出了点问题」", () => {
    expect(describeError("")).toBe("出了点问题");
    expect(describeError(undefined)).toBe("出了点问题");
    expect(describeError("Error: E_INTERNAL")).toBe("出了点问题");
  });

  it("failureText 固定句式:动作没成功:原因。下一步", () => {
    expect(failureText("撤销", new Error("Error: 这批已经被改过"))).toBe("撤销没成功:这批已经被改过。再试一次");
    expect(failureText("自动挑选", "没有时刻分", "先等画面分析跑完")).toBe("自动挑选没成功:没有时刻分。先等画面分析跑完");
  });
});
