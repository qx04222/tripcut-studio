import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RecoveryPage } from "./RecoveryPage";
import type { DoctorReport } from "./api";

const report: DoctorReport = {
  status: "FAIL",
  abnormal_exit: true,
  recovered_jobs: 2,
  cache_sampled: 20,
  cache_missing: 1,
  snapshots: ["project-100.db", "project-099.db"],
  restart_required: false,
  checks: [
    {
      id: "database",
      title: "项目数据库",
      status: "FAIL",
      detail: "数据库完整性检查失败",
    },
  ],
};

describe("P5-F2 startup recovery page", () => {
  it("renders the three required recovery actions and log access", () => {
    const markup = renderToStaticMarkup(
      <RecoveryPage report={report} onContinue={() => undefined} onReport={() => undefined} />,
    );

    expect(markup).toContain("从快照恢复");
    expect(markup).toContain("导出决策数据");
    // R15:「重建缓存」改名「清理缓存并重新分析」,并加「重置项目库」(与设置页同名同文案)。
    expect(markup).toContain("清理缓存并重新分析");
    expect(markup).toContain("重置项目库");
    expect(markup).toContain("原片不会被删");
    expect(markup).toContain("打开日志目录");
  });

  it("R15:「重置项目库」没打「确认」两个字时是禁用的", () => {
    const markup = renderToStaticMarkup(
      <RecoveryPage report={report} onContinue={() => undefined} onReport={() => undefined} />,
    );
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>(?:<[^>]+>|<\/[^>]+>)*重置项目库<\/span><\/button>/);
    expect(markup).toContain('aria-label="重置确认"');
  });

  it("blocks entering the workbench while doctor status is FAIL", () => {
    const markup = renderToStaticMarkup(
      <RecoveryPage report={report} onContinue={() => undefined} onReport={() => undefined} />,
    );

    expect(markup).toContain("进入工作台");
    // R10 U-36 起主按钮是套件 Button(图标 + label span),所以按钮标签与文字之间允许有子元素。
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>(?:<[^>]+>|<\/[^>]+>)*进入工作台<\/span><\/button>/);
    expect(markup).toContain("已回收 2 个中断任务");
  });
});

describe("R10 U-36:恢复页换设计系统", () => {
  it("没有英文 kicker,主按钮在吸底操作条里,标题与卡片走套件类", () => {
    const markup = renderToStaticMarkup(
      <RecoveryPage report={{ ...report, status: "WARN", abnormal_exit: true }} onContinue={() => undefined} onReport={() => undefined} />,
    );
    expect(markup).not.toMatch(/TRIPCUT DOCTOR|STARTUP RECOVERY/);
    // 可见文本里没有成串大写(kicker 的形状);JSON 是数据格式名,不是 kicker。
    const visible = markup.replace(/<[^>]+>/g, " ").replace(/JSON/g, "");
    expect(visible.match(/[A-Z]{3,}/g) ?? []).toEqual([]);
    expect(markup).toContain('class="recovery-r10"');
    expect(markup).toMatch(/<footer class="recovery-r10-bar">[\s\S]*进入工作台/);
    expect(markup).toMatch(/<h1 class="recovery-r10-title">上次会话没有正常结束<\/h1>/);
    expect(markup).toContain("ui-card");
    expect(markup).toContain("ui-badge");
    // WARN 下不阻断:主按钮可点。
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>(?:<[^>]+>|<\/[^>]+>)*进入工作台/);
  });
});
