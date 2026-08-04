const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeEmail,
  tokenHash,
  canViewTask,
  canFocusTask,
  normalizeTaskInput,
  normalizeProjectInput,
  normalizePlanInput,
  normalizeLegacyTask,
  reminderCheckpoints,
  dueCheckpointWindow
} = require("../arc-todo-core");
const {
  CALENDAR_SCOPES,
  encryptRefreshToken,
  decryptRefreshToken,
  scheduleFromGoogleEvent
} = require("../arc-todo-calendar");

test("normalizes email and hashes a session token deterministically", () => {
  assert.equal(normalizeEmail("  Molly@Example.COM "), "molly@example.com");
  assert.equal(tokenHash("abc"), tokenHash("abc"));
  assert.notEqual(tokenHash("abc"), tokenHash("abcd"));
});

test("admin sees all tasks; a member sees only participant tasks", () => {
  const task = { created_by: 1, assigned_to: 2 };
  assert.equal(canViewTask({ id: 9, role: "admin" }, task, []), true);
  assert.equal(canViewTask({ id: 2, role: "member" }, task, []), true);
  assert.equal(canViewTask({ id: 3, role: "member" }, task, [3]), true);
  assert.equal(canViewTask({ id: 4, role: "member" }, task, [3]), false);
});

test("normalizes task input separately from a member's personal plan", () => {
  const task = normalizeTaskInput({ title: "  预约牙医  ", dueAt: "2026-08-03T10:00:00+08:00", priority: "unknown" });
  assert.equal(task.title, "预约牙医");
  assert.equal(task.priority, "normal");
  assert.equal(task.status, "assigned");
  assert.equal(Object.hasOwn(task, "plannedStartAt"), false);
  const plan = normalizePlanInput({ startAt: "2026-08-03T09:00:00+08:00", endAt: "2026-08-03T10:00:00+08:00" });
  assert.equal(plan.plannedStartAt, "2026-08-03T01:00:00.000Z");
  assert.throws(() => normalizePlanInput({ startAt: "2026-08-03T10:00:00+08:00" }), /同时填写/);
  assert.throws(() => normalizePlanInput({ startAt: "2026-08-03T11:00:00+08:00", endAt: "2026-08-03T10:00:00+08:00" }), /晚于/);
  assert.throws(() => normalizeTaskInput({ title: "", dueAt: "2026-08-03" }), /不能为空/);
});

test("normalizes a project without turning it into a scheduled task", () => {
  const project = normalizeProjectInput({
    title: "  更新跨机构资料  ",
    notes: "逐家办理",
    dueAt: "2026-12-31T18:00:00+08:00"
  });
  assert.equal(project.title, "更新跨机构资料");
  assert.equal(project.notes, "逐家办理");
  assert.equal(project.dueAt, "2026-12-31T10:00:00.000Z");
  assert.throws(() => normalizeProjectInput({ title: "" }), /项目名称不能为空/);
  assert.throws(() => normalizeProjectInput({ title: "资料整理", dueAt: "not-a-date" }), /总截止日期无效/);
});

test("only an open assignee or collaborator can make a task their current focus", () => {
  const task = { assigned_to: 2, status: "assigned" };
  assert.equal(canFocusTask({ id: 2, role: "member" }, task, []), true);
  assert.equal(canFocusTask({ id: 3, role: "member" }, task, [3]), true);
  assert.equal(canFocusTask({ id: 1, role: "admin" }, task, []), false);
  assert.equal(canFocusTask({ id: 2, role: "member" }, { ...task, status: "done" }, []), false);
});

test("creates exactly the pre-due, due-day, and day-three reminder checkpoints", () => {
  const due = "2026-08-10T09:00:00.000Z";
  const checkpoints = reminderCheckpoints(due);
  assert.deepEqual(checkpoints.map((point) => point.key), ["pre_due", "due_day", "overdue_day_3"]);
  assert.equal(checkpoints[0].at.toISOString(), "2026-08-09T09:00:00.000Z");
  assert.equal(checkpoints[2].at.toISOString(), "2026-08-13T09:00:00.000Z");
  assert.deepEqual(dueCheckpointWindow(due, new Date("2026-08-13T09:00:00.000Z")).map((point) => point.key), ["overdue_day_3"]);
});

test("normalizes legacy local tasks for explicit import", () => {
  const imported = normalizeLegacyTask({ title: "学校材料", due: "2026-08-05T18:00", assignee: "son", status: "done" }, new Date("2026-08-02T00:00:00Z"));
  assert.equal(imported.title, "学校材料");
  assert.equal(imported.legacyAssignee, "son");
  assert.equal(imported.status, "done");
  assert.ok(imported.completedAt);
});

test("keeps a personal Google Calendar refresh token encrypted at rest", () => {
  const secret = "test-google-client-secret";
  const encrypted = encryptRefreshToken("refresh-token-for-test", secret);
  assert.match(encrypted, /^v1\./);
  assert.notEqual(encrypted, "refresh-token-for-test");
  assert.equal(decryptRefreshToken(encrypted, secret), "refresh-token-for-test");
  assert.throws(() => decryptRefreshToken(encrypted, "another-secret"), /重新连接/);
});

test("uses only the two minimal personal calendar permissions", () => {
  assert.ok(CALENDAR_SCOPES.includes("https://www.googleapis.com/auth/calendar.events.freebusy"));
  assert.ok(CALENDAR_SCOPES.includes("https://www.googleapis.com/auth/calendar.app.created"));
  assert.equal(CALENDAR_SCOPES.some((scope) => scope === "https://www.googleapis.com/auth/calendar"), false);
});

test("accepts timed Google calendar events and ignores all-day events", () => {
  const schedule = scheduleFromGoogleEvent({
    start: { dateTime: "2026-08-04T09:00:00+08:00" },
    end: { dateTime: "2026-08-04T10:30:00+08:00" }
  });
  assert.deepEqual(schedule, {
    plannedStartAt: "2026-08-04T01:00:00.000Z",
    plannedEndAt: "2026-08-04T02:30:00.000Z"
  });
  assert.equal(scheduleFromGoogleEvent({ start: { date: "2026-08-04" }, end: { date: "2026-08-05" } }), null);
});
