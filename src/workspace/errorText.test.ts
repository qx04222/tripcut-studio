import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeError, failureText, stripStepNumbers } from "./errorText";

describe("errorText(R11 简化专项 #5:错误一句话,不带内部代码)", () => {
  it("R12 术语 v2(B-列表 27):后端 CoreError 的英文前缀「export failed:」也剥掉", () => {
    expect(describeError(new Error("export failed: 精选段与源片时间对不上"))).toBe("精选段与源片时间对不上");
    expect(failureText("导出", "Error: export failed: 磁盘已满", "清出空间后再试")).toBe("导出没成功:磁盘已满。清出空间后再试");
  });

  it("X-02:任何「<词> failed:」「<词> error:」前缀都剥,多词前缀与嵌套的 Error: 也剥", () => {
    expect(describeError(new Error("rating failed: 这个范围里没有可挑的素材"))).toBe("这个范围里没有可挑的素材");
    expect(describeError("Error: media source verification failed: 源片被移走了")).toBe("源片被移走了");
    expect(describeError("Jianying draft generation failed: 草稿目录不存在")).toBe("草稿目录不存在");
    expect(describeError("player error: 没响应")).toBe("没响应");
    expect(describeError("素材 failed 了")).toBe("素材 failed 了");
  });

  it("X-02:后端已经给了下一步(冒号后的「先…/请…/或…/再试」)就不再追加兜底话", () => {
    expect(failureText("自动挑选", "rating failed: 这个范围里没有可挑的素材:先收藏几条或给素材打星,或把范围改成「全部」", "先让画面分析跑完,再试一次")).toBe(
      "自动挑选没成功:这个范围里没有可挑的素材:先收藏几条或给素材打星,或把范围改成「全部」",
    );
    expect(failureText("排入", "没有进行中的集;先新建一集再试")).toBe("排入没成功:没有进行中的集;先新建一集再试");
    expect(failureText("重新定位", "素材已清理,请重新选择文件夹", "确认新位置里有同名文件后再试")).toBe("重新定位没成功:素材已清理,请重新选择文件夹");
    // 只是陈述原因、没说怎么办的,照旧补一句。
    expect(failureText("撤销", "这批已经被改过")).toBe("撤销没成功:这批已经被改过。再试一次");
  });

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

  it("Z-09 / Z-10:后端小写代码前缀、(os error N) 与英文系统原因都变成人话", () => {
    expect(describeError("export failed: dest_unavailable: 上次的文件夹现在用不了 (/Volumes/s6-ro) : Permission denied (os error 13)"))
      .toBe("上次的文件夹现在用不了 (/Volumes/s6-ro):没有写入权限");
    expect(describeError("Error: export failed: 目标磁盘空间不足:预计需要 112.8 MiB,当前可用 29.2 MiB"))
      .toBe("目标磁盘空间不足:预计需要 112.8 MiB,当前可用 29.2 MiB");
    expect(describeError("No space left on device (os error 28)")).toBe("磁盘已满");
    expect(describeError("写文件失败: Read-only file system (os error 30)")).toBe("写文件失败:这个磁盘是只读的");
    expect(describeError("No such file or directory (os error 2)")).toBe("文件或文件夹不存在");
  });
});

/** R19 U-08:错误文案不说「第 n 步」—— 那是我们的编号,不是剪映的;用户不该先学编号才能读懂错误。 */
describe("R19 U-08:失败文案去「第 n 步」", () => {
  it("后端旧文案里的「第 1 步 / 第 2 步」被改写成动作词;新后端文案本来就没有编号,原样通过", () => {
    expect(failureText("自动挑选", "rating failed: 还没有可挑的素材:先在第 1 步导入视频")).toBe("自动挑选没成功:还没有可挑的素材:先导入视频");
    expect(failureText("自动挑选", "素材都已经挑过了:想重挑就先撤销上一批,或在第 2 步手动挑几条")).toBe("自动挑选没成功:素材都已经挑过了:想重挑就先撤销上一批,或去媒体池手动挑几条");
    expect(failureText("排入", "没有挑好的片段", "先在第 2 步挑几条片段")).toBe("排入没成功:没有挑好的片段。先挑几条片段");
    expect(failureText("排入", "没有挑好的片段", "回到第 ② 步挑几条")).toBe("排入没成功:没有挑好的片段。回去挑几条");
    expect(stripStepNumbers("在第 3 步把片段排进来")).toBe("把片段排进来");
    expect(failureText("自动挑选", "还没有可挑的素材:先导入视频")).toBe("自动挑选没成功:还没有可挑的素材:先导入视频");
  });

  it("src-tauri/src/core 的用户可见文案里没有「第 n 步」", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".rs")) {
          readFileSync(path, "utf8").split("\n").forEach((line, index) => {
            const trimmed = line.trim();
            if (trimmed.startsWith("//")) return;
            if (/"[^"]*第\s*[\d①②③④]\s*步[^"]*"/.test(trimmed)) hits.push(`${path}:${index + 1}`);
          });
        }
      }
    };
    walk(join(process.cwd(), "src-tauri/src/core"));
    expect(hits).toEqual([]);
  });
});
