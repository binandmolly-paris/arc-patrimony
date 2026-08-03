const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeEmail,
  tokenHash,
  canViewTask,
  normalizeTaskInput,
  normalizeLegacyTask,
  reminderCheckpoints,
  dueCheckpointWindow
} = require("../arc-todo-core");

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

test("normalizes task input and rejects an empty title", () => {
  const task = normalizeTaskInput({ title: "  预约牙医  ", dueAt: "2026-08-03T10:00:00+08:00", priority: "unknown" });
  assert.equal(task.title, "预约牙医");
  assert.equal(task.priority, "normal");
  assert.equal(task.status, "assigned");
  assert.throws(() => normalizeTaskInput({ title: "", dueAt: "2026-08-03" }), /不能为空/);
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
