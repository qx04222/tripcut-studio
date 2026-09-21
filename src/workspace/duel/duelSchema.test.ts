import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("duel migration contract", () => {
  it("appends 0053 with durable decisions and rollback snapshot(0052 属 W1 taken_at_local,合并时重编号)", () => {
    const sql = readFileSync("src-tauri/src/core/migrations.rs", "utf8");
    expect(sql).toContain("pub const MIGRATION_0053");
    expect(sql).toContain("CREATE TABLE duel_sessions");
    expect(sql).toContain("CREATE TABLE duel_verdicts");
    expect(sql).toContain("snapshot_json");
    expect(sql).toContain("LATEST_SCHEMA_VERSION: i64 = 53");
    expect(sql).toContain("Migration { version: 53, sql: MIGRATION_0053 }");
  });
});
