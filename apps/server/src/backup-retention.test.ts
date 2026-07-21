import { describe, expect, it } from "vitest";

import {
  BACKUP_RETENTION_POLICY,
  backupScheduleWindow,
  buildBackupRetentionPlan,
  calendarRetentionBounds,
  evaluateBackupScheduleSupervision,
  parseDailyBackupCron,
  type RetentionRecord,
} from "./backup-retention.js";

function record(
  id: number,
  retentionClass: RetentionRecord["retentionClass"],
  completedAt: string,
  overrides: Partial<RetentionRecord> = {},
): RetentionRecord {
  return {
    id: `backup_${id.toString(16).padStart(40, "0")}`,
    filename: `formaspec-backup-2026-01-${String(id).padStart(2, "0")}T00-00-00-000Z.tar`,
    bundleSha256: id.toString(16).padStart(64, "0"),
    status: "valid",
    createdAt: completedAt,
    verifiedAt: completedAt,
    completedAt,
    sizeBytes: id * 100,
    retentionClass,
    ...overrides,
  };
}

describe("managed backup scheduling and retention", () => {
  it("parses the bounded daily UTC schedule and calculates stable due windows", () => {
    expect(parseDailyBackupCron("5 2 * * *")).toEqual({ minute: 5, hour: 2 });
    expect(backupScheduleWindow("5 2 * * *", new Date("2026-07-19T01:00:00.000Z"))).toEqual({
      dueAt: "2026-07-18T02:05:00.000Z",
      nextDueAt: "2026-07-19T02:05:00.000Z",
    });
    expect(backupScheduleWindow("5 2 * * *", new Date("2026-07-19T12:00:00.000Z"))).toEqual({
      dueAt: "2026-07-19T02:05:00.000Z",
      nextDueAt: "2026-07-20T02:05:00.000Z",
    });
    expect(() => parseDailyBackupCron("*/5 * * * *")).toThrow("one daily UTC time");
    expect(() => parseDailyBackupCron("60 2 * * *")).toThrow("outside the valid UTC range");

    const supervision = evaluateBackupScheduleSupervision({
      enabled: true,
      cronExpression: "5 2 * * *",
      at: new Date("2026-07-19T09:00:00.000Z"),
      currentWindowCovered: false,
      latestAttempt: {
        runId: `backup_schedule_run_${"a".repeat(32)}`,
        status: "failed",
        dueAt: "2026-07-19T02:05:00.000Z",
        nextDueAt: "2026-07-20T02:05:00.000Z",
        startedAt: "2026-07-19T02:06:00.000Z",
        completedAt: "2026-07-19T02:07:00.000Z",
        errorCode: "INTERNAL_ERROR",
        retryable: true,
      },
      retentionCandidateCount: 2,
      retentionCandidateBytes: 500,
      retentionProtectedCount: 1,
      retentionPlanHash: "b".repeat(64),
    });
    expect(supervision.status).toBe("critical");
    expect(supervision.alerts.map((alert) => alert.code)).toEqual([
      "SCHEDULE_RUN_FAILED",
      "BACKUP_WINDOW_OVERDUE",
      "RETENTION_PRUNE_REQUIRED",
      "BACKUP_RECORDS_REQUIRE_REVIEW",
    ]);
    expect(evaluateBackupScheduleSupervision({
      enabled: true,
      cronExpression: "5 2 * * *",
      at: new Date("2026-07-19T09:00:00.000Z"),
      currentWindowCovered: true,
      latestAttempt: supervision.latestAttempt,
      retentionCandidateCount: 0,
      retentionCandidateBytes: 0,
      retentionProtectedCount: 0,
      retentionPlanHash: "b".repeat(64),
    })).toMatchObject({
      status: "critical",
      currentWindowCovered: true,
      alerts: [{ code: "SCHEDULE_RUN_FAILED", severity: "critical" }],
    });
    expect(evaluateBackupScheduleSupervision({
      enabled: true,
      cronExpression: "5 2 * * *",
      at: new Date("2026-07-19T09:00:00.000Z"),
      currentWindowCovered: true,
      latestAttempt: {
        runId: `backup_schedule_run_${"c".repeat(32)}`,
        status: "running",
        dueAt: "2026-07-19T02:05:00.000Z",
        nextDueAt: "2026-07-20T02:05:00.000Z",
        startedAt: "2026-07-19T02:06:00.000Z",
        completedAt: null,
        errorCode: null,
        retryable: null,
      },
      retentionCandidateCount: 0,
      retentionCandidateBytes: 0,
      retentionProtectedCount: 0,
      retentionPlanHash: "b".repeat(64),
    })).toMatchObject({
      status: "critical",
      currentWindowCovered: true,
      alerts: [{ code: "SCHEDULE_RUN_STALLED", severity: "critical" }],
    });
    expect(evaluateBackupScheduleSupervision({
      ...supervision,
      at: new Date("2026-07-19T09:00:00.000Z"),
      enabled: false,
      cronExpression: "5 2 * * *",
      retentionCandidateCount: 0,
      retentionCandidateBytes: 0,
      retentionProtectedCount: 0,
      retentionPlanHash: "b".repeat(64),
    })).toMatchObject({ status: "disabled", dueAt: null, alerts: [] });
  });

  it("uses UTC calendar months and ISO Monday-based weeks", () => {
    expect(calendarRetentionBounds(new Date("2026-07-19T12:00:00.000Z"))).toEqual({
      monthStart: "2026-07-01T00:00:00.000Z",
      monthEnd: "2026-08-01T00:00:00.000Z",
      weekStart: "2026-07-13T00:00:00.000Z",
      weekEnd: "2026-07-20T00:00:00.000Z",
    });
  });

  it("keeps exactly 7 daily, 4 weekly, and 12 monthly backups while exempting every manual backup", () => {
    const records: RetentionRecord[] = [];
    for (let index = 1; index <= 9; index += 1) records.push(record(index, "daily", `2026-07-${String(index).padStart(2, "0")}T00:00:00.000Z`));
    for (let index = 10; index <= 15; index += 1) records.push(record(index, "weekly", `2026-05-${String(index).padStart(2, "0")}T00:00:00.000Z`));
    for (let index = 16; index <= 29; index += 1) records.push(record(index, "monthly", new Date(Date.UTC(2024, index - 16, 1)).toISOString()));
    records.push(record(30, "manual", "2020-01-01T00:00:00.000Z"));
    records.push(record(31, "daily", "2020-01-02T00:00:00.000Z", { status: "invalid" }));

    const plan = buildBackupRetentionPlan(records);
    expect(plan.policy).toEqual(BACKUP_RETENTION_POLICY);
    expect(plan.retained.filter((item) => item.retentionClass === "daily")).toHaveLength(7);
    expect(plan.retained.filter((item) => item.retentionClass === "weekly")).toHaveLength(4);
    expect(plan.retained.filter((item) => item.retentionClass === "monthly")).toHaveLength(12);
    expect(plan.candidates.filter((item) => item.retentionClass === "daily")).toHaveLength(2);
    expect(plan.candidates.filter((item) => item.retentionClass === "weekly")).toHaveLength(2);
    expect(plan.candidates.filter((item) => item.retentionClass === "monthly")).toHaveLength(2);
    expect(plan.candidates.some((item) => item.retentionClass === "manual")).toBe(false);
    expect(plan.manualExemptCount).toBe(1);
    expect(plan.protectedCount).toBe(1);
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(buildBackupRetentionPlan([...records].reverse()).planHash).toBe(plan.planHash);
  });

  it("uses the organization retention values in both selection and the exact plan hash", () => {
    const records = [
      record(1, "daily", "2026-07-01T00:00:00.000Z"),
      record(2, "daily", "2026-07-02T00:00:00.000Z"),
      record(3, "daily", "2026-07-03T00:00:00.000Z"),
    ];
    const strict = buildBackupRetentionPlan(records, { daily: 1, weekly: 1, monthly: 1 });
    const relaxed = buildBackupRetentionPlan(records, { daily: 2, weekly: 1, monthly: 1 });

    expect(strict.policy).toEqual({ daily: 1, weekly: 1, monthly: 1 });
    expect(strict.retained).toHaveLength(1);
    expect(strict.candidates).toHaveLength(2);
    expect(relaxed.retained).toHaveLength(2);
    expect(relaxed.candidates).toHaveLength(1);
    expect(relaxed.planHash).not.toBe(strict.planHash);
    expect(() => buildBackupRetentionPlan(records, { daily: 0, weekly: 1, monthly: 1 })).toThrow(
      "positive safe integer",
    );
  });
});
