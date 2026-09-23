import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("duel migration contract", () => {
  it("appends 0053 with durable decisions and rollback snapshot(0052 属 W1 taken_at_local,合并时重编号)", () => {
    const sql = readFileSync("src-tauri/src/core/migrations.rs", "utf8");
    expect(sql).toContain("pub const MIGRATION_0053");
    expect(sql).toContain("CREATE TABLE duel_sessions");
    expect(sql).toContain("CREATE TABLE duel_verdicts");
    expect(sql).toContain("snapshot_json");
    // R25 quality:0055 预览画质(高清代理)接在 0054 之后,版本号只增不减。
    expect(sql).toMatch(/LATEST_SCHEMA_VERSION: i64 = (5[4-9]|[6-9]\d)/);
    expect(sql).toContain("Migration { version: 53, sql: MIGRATION_0053 }");
  });
});
