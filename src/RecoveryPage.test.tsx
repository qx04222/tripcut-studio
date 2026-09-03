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
    expect(markup).toContain("重建缓存");
    expect(markup).toContain("打开日志目录");
  });

  it("blocks entering the workbench while doctor status is FAIL", () => {
    const markup = renderToStaticMarkup(
      <RecoveryPage report={report} onContinue={() => undefined} onReport={() => undefined} />,
    );

    expect(markup).toContain("进入工作台");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>进入工作台<\/button>/);
    expect(markup).toContain("已回收 2 个中断任务");
  });
});
