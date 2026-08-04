const state = {
  member: null,
  members: [],
  tasks: [],
  focus: null,
  focusCandidates: [],
  familyPriorities: [],
  filter: "today",
  status: "open",
  search: "",
  selectedId: null,
  plannerOffset: 0
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" });
const dayFormatter = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", weekday: "short" });
const timeFormatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const fullDateFormatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" });

function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#039;", "\"":"&quot;" }[character])); }
function startOfDay(value) { const date = new Date(value); return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function addDays(value, days) { const date = new Date(value); date.setDate(date.getDate() + days); return date; }
function pad(number) { return String(number).padStart(2, "0"); }
function asInputDate(value) { const date = new Date(value); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }
function asDateInput(value) { const date = new Date(value); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
function defaultTaskDate() { return asDateInput(new Date()); }
function dueAtForDate(value) { return new Date(`${value}T18:00:00`).toISOString(); }
function isDone(task) { return task.status === "done"; }
function isToday(task) { return startOfDay(task.due_at).getTime() === startOfDay(new Date()).getTime(); }
function isOverdue(task) { return !isDone(task) && new Date(task.due_at) < startOfDay(new Date()); }
function memberFor(id) { return state.members.find((member) => member.id === Number(id)); }
function initials(name = "") { return String(name).split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase() || "·"; }
function toast(message) { const node = $("#toast"); node.textContent = message; node.classList.add("is-visible"); window.clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("is-visible"), 3600); }
function currentFocusTask() { return state.focus ? state.tasks.find((task) => task.id === Number(state.focus.taskId)) : null; }
function isFocusEligible(task) { return Boolean(task) && !isDone(task) && (task.assigned_to === state.member?.id || task.collaborators?.some((member) => member.id === state.member?.id)); }
function scheduledDate(task) { return startOfDay(task.planned_start_at || task.due_at); }
function sameDay(left, right) { return startOfDay(left).getTime() === startOfDay(right).getTime(); }

async function api(path, options = {}) {
  const response = await fetch(`/api/arc-todo${path}`, { credentials: "same-origin", headers: { "Content-Type":"application/json", ...(options.headers || {}) }, ...options });
  if (response.status === 401) { showAuth(); throw new Error("登录已过期，请重新登录。"); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "ARC TODO 暂时不可用。");
  return body;
}

function showAuth() {
  $("#app").dataset.screen = "auth";
  $("#todoShell").hidden = true;
  $("#launchScreen").hidden = false;
  $("#launchScreen").classList.add("is-auth");
  $("#loadingScreen").setAttribute("aria-hidden", "true");
  $("#authScreen").setAttribute("aria-hidden", "false");
}

function showApp() {
  $("#app").dataset.screen = "app";
  $("#launchScreen").hidden = true;
  $("#todoShell").hidden = false;
}

function statusCopy(task) {
  const due = new Date(task.due_at);
  if (isDone(task)) return { label: "已完成", className: "" };
  if (isOverdue(task)) return { label: `已逾期 ${Math.max(1, Math.ceil((Date.now() - due) / 86400000))} 天`, className: "is-overdue" };
  if (isToday(task)) return { label: `今天 ${timeFormatter.format(due)}`, className: "" };
  if (sameDay(due, addDays(new Date(), 1))) return { label: `明天 ${timeFormatter.format(due)}`, className: "" };
  return { label: `${dateFormatter.format(due)} ${timeFormatter.format(due)}`, className: "" };
}

function timeRange(task) {
  if (task.planned_start_at && task.planned_end_at) return `${timeFormatter.format(new Date(task.planned_start_at))}–${timeFormatter.format(new Date(task.planned_end_at))}`;
  return "未排时段";
}

function visibleTasks() {
  const now = new Date();
  const inWeek = addDays(startOfDay(now), 7);
  const query = state.search.trim().toLowerCase();
  return state.tasks.filter((task) => {
    const matchesStatus = state.status === "done" ? isDone(task) : !isDone(task);
    const matchesQuery = !query || [task.title, task.notes, task.creator_name, task.assignee_name].join(" ").toLowerCase().includes(query);
    if (!matchesStatus || !matchesQuery) return false;
    if (state.filter === "today") return isToday(task) || isOverdue(task);
    if (state.filter === "inbox") return task.status === "inbox";
    if (state.filter === "upcoming") return !isDone(task) && new Date(task.due_at) >= startOfDay(now) && new Date(task.due_at) <= inWeek;
    if (state.filter === "waiting") return task.created_by === state.member.id && task.assigned_to !== state.member.id && !isDone(task);
    if (state.filter === "completed") return isDone(task);
    return true;
  }).sort((left, right) => new Date(left.due_at) - new Date(right.due_at));
}

function count(filter) {
  const open = state.tasks.filter((task) => !isDone(task));
  if (filter === "today") return open.filter((task) => isToday(task) || isOverdue(task)).length;
  if (filter === "inbox") return open.filter((task) => task.status === "inbox").length;
  if (filter === "upcoming") return open.filter((task) => new Date(task.due_at) >= startOfDay(new Date()) && new Date(task.due_at) <= addDays(startOfDay(new Date()), 7)).length;
  if (filter === "waiting") return open.filter((task) => task.created_by === state.member.id && task.assigned_to !== state.member.id).length;
  if (filter === "completed") return state.tasks.filter(isDone).length;
  return 0;
}

function screenTitle() {
  return {
    today: ["今天", "先把重要的事情做好。"],
    planner: ["计划", "先安排时间，再开始行动。"],
    inbox: ["收件箱", "还没有被安排的念头。"],
    upcoming: ["即将到期", "未来七天需要推进的事。"],
    waiting: ["等待他人", "你已经交代，等待回应。"],
    completed: ["已完成", "已经妥当的事情。"]
  }[state.filter] || ["今天", "先把重要的事情做好。"];
}

function taskRow(task) {
  const due = statusCopy(task);
  const assignee = memberFor(task.assigned_to) || { displayName: task.assignee_name || "—", role: "member" };
  return `<article class="task-row ${isDone(task) ? "is-done" : ""}" data-task-id="${task.id}">
    <button class="check-button" type="button" data-action="complete" aria-label="完成 ${escapeHtml(task.title)}">✓</button>
    <button class="task-title-button" type="button" data-action="detail"><span class="task-title">${escapeHtml(task.title)}</span><span class="task-meta">${escapeHtml(task.creator_name)} 创建${task.priority === "high" ? " · 优先" : ""}</span></button>
    <div class="assignee"><span class="assignee-dot" data-role="${assignee.role}">${initials(assignee.displayName)}</span><span>${escapeHtml(assignee.displayName)}</span></div>
    <div class="due ${due.className}">${due.label}</div>
    <button class="more-button" type="button" data-action="detail" aria-label="查看详情">···</button>
  </article>`;
}

function renderFocusCard() {
  const task = currentFocusTask();
  const active = state.focus?.activeSession;
  if (!task) {
    $("#focusCard").className = "focus-card is-empty";
    $("#focusCard").innerHTML = `<div><p class="eyebrow">CURRENT PRIORITY</p><strong>还没有当前重点</strong><p>只选一件，给它完整的注意力。</p></div><button class="focus-select-button" data-focus-action="choose" type="button">选择重点</button>`;
    return;
  }
  $("#focusCard").className = `focus-card${active ? " is-active" : ""}`;
  const timing = active ? `<p class="focus-elapsed">已专注 <strong id="focusElapsed"></strong></p>` : `<p class="focus-meta">当前最重要的一件事</p>`;
  const controls = active
    ? `<button class="secondary-action" data-focus-action="pause" type="button">暂停</button><button class="primary-action" data-focus-action="complete" type="button">完成</button>`
    : `<button class="primary-action" data-focus-action="start" type="button">开始专注</button><button class="secondary-action" data-focus-action="next" type="button">下一项</button>`;
  $("#focusCard").innerHTML = `<div class="focus-copy"><p class="eyebrow">${active ? "FOCUSING" : "CURRENT PRIORITY"}</p><strong>${escapeHtml(task.title)}</strong>${timing}</div><div class="focus-actions">${controls}</div>`;
  updateFocusElapsed();
}

function focusDuration() {
  const startedAt = state.focus?.activeSession?.startedAt;
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours} 小时 ${pad(minutes)} 分` : `${minutes} 分 ${pad(remainder)} 秒`;
}

function updateFocusElapsed() { const target = $("#focusElapsed"); if (target) target.textContent = focusDuration(); }

function plannerDays() {
  const start = addDays(startOfDay(new Date()), state.plannerOffset * 7);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

function plannerTask(task) {
  return `<button class="planner-task ${task.priority === "high" ? "is-priority" : ""}" data-task-id="${task.id}" type="button"><span>${escapeHtml(task.title)}</span><small>${timeRange(task)}</small></button>`;
}

function renderPlanner() {
  const days = plannerDays();
  const heading = state.plannerOffset === 0 ? "未来七天" : `${dayFormatter.format(days[0])} — ${dayFormatter.format(days[6])}`;
  $("#plannerView").innerHTML = `<div class="planner-controls"><button class="planner-arrow" data-plan-action="previous" type="button" aria-label="上一周">←</button><strong>${heading}</strong><button class="planner-today" data-plan-action="today" type="button">今天</button><button class="planner-arrow" data-plan-action="next" type="button" aria-label="下一周">→</button></div><div class="planner-grid">${days.map((day) => {
    const tasks = state.tasks.filter((task) => !isDone(task) && sameDay(scheduledDate(task), day)).sort((left, right) => new Date(left.planned_start_at || left.due_at) - new Date(right.planned_start_at || right.due_at));
    return `<section class="planner-day ${sameDay(day, new Date()) ? "is-today" : ""}"><header><span>${dayFormatter.format(day)}</span>${sameDay(day, new Date()) ? "<b>今天</b>" : ""}</header><div class="planner-day-tasks">${tasks.length ? tasks.map(plannerTask).join("") : "<p>留白</p>"}</div></section>`;
  }).join("")}</div>`;
}

function render() {
  if (!state.member) return;
  const [title, subtitle] = screenTitle();
  const isPlanner = state.filter === "planner";
  const tasks = visibleTasks();
  $("#todayLabel").textContent = fullDateFormatter.format(new Date());
  $("#personName").textContent = state.member.displayName;
  $("#personRole").textContent = state.member.role === "admin" ? "家庭管理员" : "家庭成员";
  $("#profileButton").textContent = initials(state.member.displayName);
  $("#contextLabel").textContent = state.filter.toUpperCase();
  $("#listTitle").textContent = title;
  $("#listSubtitle").textContent = subtitle;
  [["today", "countToday"], ["inbox", "countInbox"], ["upcoming", "countUpcoming"], ["waiting", "countWaiting"], ["completed", "countCompleted"]].forEach(([filter, id]) => $("#" + id).textContent = count(filter));
  $$(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.filter === state.filter));
  $$("#statusSegments button").forEach((button) => button.classList.toggle("is-selected", button.dataset.status === state.status));
  $("#quickAddForm").hidden = isPlanner;
  $(".task-toolbar").hidden = isPlanner;
  $("#taskList").hidden = isPlanner;
  $("#plannerView").hidden = !isPlanner;
  $("#taskList").innerHTML = tasks.length ? tasks.map(taskRow).join("") : `<div class="empty"><strong>这里已经很清爽。</strong>${state.status === "done" ? "还没有完成事项。" : "添加一件事，让 ARC TODO 帮你记住。"}</div>`;
  renderFocusCard();
  if (isPlanner) renderPlanner();
}

function applyFocus(payload) {
  state.focus = payload.focus || null;
  state.focusCandidates = payload.candidates || [];
  state.familyPriorities = payload.familyPriorities || [];
}

async function loadData() {
  const [members, tasks, focus] = await Promise.all([api("/members"), api("/tasks"), api("/focus")]);
  state.members = members.members;
  state.tasks = tasks.tasks;
  applyFocus(focus);
  render();
}

function memberOptions(selected, includeNone = false) {
  return `${includeNone ? '<option value="">无</option>' : ""}${state.members.map((member) => `<option value="${member.id}" ${Number(selected) === member.id ? "selected" : ""}>${escapeHtml(member.displayName)}</option>`).join("")}`;
}

function openTaskDialog(task = null) {
  $("#taskId").value = task?.id || "";
  $("#taskDialogKicker").textContent = task ? "EDIT TASK" : "NEW TASK";
  $("#taskDialogTitle").textContent = task ? "编辑任务" : "添加一件事";
  $("#taskTitle").value = task?.title || "";
  $("#taskAssignee").innerHTML = memberOptions(task?.assigned_to || state.member.id);
  $("#taskCollaborator").innerHTML = memberOptions(task?.collaborators?.[0]?.id, true);
  $("#taskDate").value = task ? asDateInput(task.due_at) : defaultTaskDate();
  $("#taskPlannedStart").value = task?.planned_start_at ? asInputDate(task.planned_start_at) : "";
  $("#taskPlannedEnd").value = task?.planned_end_at ? asInputDate(task.planned_end_at) : "";
  $("#taskPriority").value = task?.priority || "normal";
  $("#taskNotes").value = task?.notes || "";
  $("#taskDialog").showModal();
  setTimeout(() => $("#taskTitle").focus(), 50);
}

function closeDialog(id) { const dialog = $(id); if (dialog.open) dialog.close(); }

async function saveTask(event) {
  event.preventDefault();
  const id = $("#taskId").value;
  const plannedStartAt = $("#taskPlannedStart").value;
  const plannedEndAt = $("#taskPlannedEnd").value;
  if (Boolean(plannedStartAt) !== Boolean(plannedEndAt)) return toast("安排时段请同时填写开始与结束时间。");
  const payload = {
    title: $("#taskTitle").value,
    assignedTo: Number($("#taskAssignee").value),
    collaboratorId: $("#taskCollaborator").value ? Number($("#taskCollaborator").value) : null,
    dueAt: dueAtForDate($("#taskDate").value),
    plannedStartAt: plannedStartAt ? new Date(plannedStartAt).toISOString() : null,
    plannedEndAt: plannedEndAt ? new Date(plannedEndAt).toISOString() : null,
    priority: $("#taskPriority").value,
    notes: $("#taskNotes").value
  };
  try {
    await api(id ? `/tasks/${id}` : "/tasks", { method: id ? "PATCH" : "POST", body: JSON.stringify(payload) });
    closeDialog("#taskDialog");
    await loadData();
    toast(id ? "任务已更新。" : "任务已添加。日历和邮件将在服务连接后同步。");
  } catch (error) { toast(error.message); }
}

async function quickAdd(event) {
  event.preventDefault();
  const title = $("#quickTitle").value.trim();
  if (!title) return;
  try {
    await api("/tasks", { method: "POST", body: JSON.stringify({ title, assignedTo: state.member.id, dueAt: dueAtForDate(defaultTaskDate()), priority: "normal", notes: "" }) });
    $("#quickTitle").value = "";
    await loadData();
    toast("已添加到今天。 ");
  } catch (error) { toast(error.message); }
}

async function completeTask(id) {
  try {
    await api(`/tasks/${id}/complete`, { method: "POST", body: "{}" });
    await loadData();
    closeDialog("#detailDialog");
    toast("已完成。事情妥当了。 ");
  } catch (error) { toast(error.message); }
}

function reminderSteps(task) {
  const due = new Date(task.due_at);
  const now = new Date();
  const steps = [{ name: "截止前 1 天", at: addDays(due, -1) }, { name: "截止当天", at: due }, { name: "逾期第 3 天", at: addDays(due, 3) }];
  return steps.map((step) => `<div class="timeline-step ${Math.abs(step.at - now) < 18 * 60 * 60 * 1000 ? "is-current" : ""}"><b>${step.name}</b><small>${dateFormatter.format(step.at)}<br>App · 日历 · 邮件</small></div>`).join("");
}

function openDetail(task) {
  state.selectedId = task.id;
  $("#detailState").textContent = isDone(task) ? "COMPLETED" : (isOverdue(task) ? "NEEDS ATTENTION" : "TASK");
  $("#detailTitle").textContent = task.title;
  const pills = [`创建：${task.creator_name}`, `负责：${task.assignee_name}`, `日期：${dateFormatter.format(new Date(task.due_at))}`, task.priority === "high" ? "优先" : "正常"];
  if (task.planned_start_at) pills.push(`时段：${timeRange(task)}`);
  if (task.collaborators?.length) pills.push(`共同：${task.collaborators.map((member) => member.displayName).join("、")}`);
  $("#detailPills").innerHTML = pills.map((item) => `<span class="pill">${escapeHtml(item)}</span>`).join("");
  $("#detailNotes").textContent = task.notes || "还没有备注。";
  $("#reminderSteps").innerHTML = reminderSteps(task);
  $("#activityList").innerHTML = `<li>${escapeHtml(task.creator_name)} 创建了这项任务</li>${isDone(task) ? "<li>任务已标记完成</li>" : "<li>下一次提醒将按时间线发送</li>"}`;
  const isCurrent = state.focus?.taskId === task.id;
  const focusAction = !isDone(task) && isFocusEligible(task)
    ? (isCurrent ? '<button class="secondary-action" data-detail-action="clear-focus" type="button">移除当前重点</button>' : '<button class="secondary-action" data-detail-action="set-focus" type="button">设为当前重点</button>')
    : "";
  $("#detailActions").innerHTML = `${focusAction}${!isDone(task) ? '<button class="primary-action" data-detail-action="complete" type="button">标记完成</button>' : ""}<button class="secondary-action" data-detail-action="edit" type="button">编辑</button>`;
  $("#detailDialog").showModal();
}

function focusCandidate(task) {
  return `<button class="focus-candidate" type="button" data-focus-task-id="${task.id}"><span>${escapeHtml(task.title)}</span><small>${task.priority === "high" ? "优先 · " : ""}${escapeHtml(timeRange(task))}</small></button>`;
}

function openFocusDialog() {
  const candidates = state.focusCandidates;
  $("#focusDialogTitle").textContent = state.focus ? "选择下一项" : "选择当前重点";
  $("#focusCandidates").innerHTML = candidates.length ? candidates.map(focusCandidate).join("") : `<p class="focus-empty">没有可选择的任务。先为自己添加或接收一件待办。</p>`;
  $("#focusDialog").showModal();
}

async function setFocus(taskId) {
  try {
    applyFocus(await api("/focus/current", { method: "POST", body: JSON.stringify({ taskId }) }));
    closeDialog("#focusDialog");
    closeDialog("#detailDialog");
    render();
    toast("已设为当前重点。一次只做好这一件事。");
  } catch (error) { toast(error.message); }
}

async function startFocus() {
  try {
    applyFocus(await api("/focus/start", { method: "POST", body: "{}" }));
    render();
    toast("现在只做这一件事。");
  } catch (error) { toast(error.message); }
}

async function clearFocus(endpoint = "/focus/current") {
  try {
    const payload = endpoint === "/focus/current"
      ? await api(endpoint, { method: "DELETE", body: "{}" })
      : await api(endpoint, { method: "POST", body: "{}" });
    applyFocus(payload);
    render();
    toast(endpoint === "/focus/pause" ? "专注已暂停。请在合适的时候再选择下一项。" : "已移除当前重点。");
  } catch (error) { toast(error.message); }
}

function openImportDialog() {
  const selects = ["#mapLiu", "#mapWife", "#mapSon"];
  selects.forEach((selector, index) => { $(selector).innerHTML = memberOptions(index === 0 ? state.member.id : undefined); });
  $("#importFile").value = "";
  $("#importFileName").textContent = "选择备份文件";
  $("#importDialog").showModal();
}

async function importLegacy(event) {
  event.preventDefault();
  const file = $("#importFile").files[0];
  if (!file) return toast("请先选择旧版备份文件。");
  try {
    const exportData = JSON.parse(await file.text());
    if (exportData.schema !== "arc-todo-legacy-export/v1") throw new Error("这不是 ARC TODO 的旧版备份文件。");
    const memberMap = { liu: Number($("#mapLiu").value), wife: Number($("#mapWife").value), son: Number($("#mapSon").value) };
    const result = await api("/import/legacy", { method: "POST", body: JSON.stringify({ export: exportData, memberMap }) });
    closeDialog("#importDialog");
    await loadData();
    toast(`已安全导入 ${result.importedCount} 件待办。`);
  } catch (error) { toast(error.message); }
}

function bindEvents() {
  $("#navList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    state.filter = button.dataset.filter;
    state.status = state.filter === "completed" ? "done" : "open";
    render();
  });
  $("#statusSegments").addEventListener("click", (event) => { const button = event.target.closest("[data-status]"); if (!button) return; state.status = button.dataset.status; render(); });
  $("#searchInput").addEventListener("input", (event) => { state.search = event.target.value; render(); });
  $("#openTaskDialog").addEventListener("click", () => openTaskDialog());
  $("#quickAddForm").addEventListener("submit", quickAdd);
  $("#taskForm").addEventListener("submit", saveTask);
  $("#taskList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-task-id]");
    if (!row) return;
    const task = state.tasks.find((item) => item.id === Number(row.dataset.taskId));
    if (!task) return;
    if (event.target.closest("[data-action]")?.dataset.action === "complete") completeTask(task.id); else openDetail(task);
  });
  $("#plannerView").addEventListener("click", (event) => {
    const action = event.target.closest("[data-plan-action]")?.dataset.planAction;
    if (action) { state.plannerOffset = action === "previous" ? state.plannerOffset - 1 : (action === "next" ? state.plannerOffset + 1 : 0); render(); return; }
    const taskId = Number(event.target.closest("[data-task-id]")?.dataset.taskId);
    const task = state.tasks.find((item) => item.id === taskId);
    if (task) openDetail(task);
  });
  $("#focusCard").addEventListener("click", (event) => {
    const action = event.target.closest("[data-focus-action]")?.dataset.focusAction;
    if (!action) return;
    if (action === "choose" || action === "next") openFocusDialog();
    if (action === "start") startFocus();
    if (action === "pause") clearFocus("/focus/pause");
    if (action === "complete") { const task = currentFocusTask(); if (task) completeTask(task.id); }
  });
  $("#focusCandidates").addEventListener("click", (event) => { const taskId = Number(event.target.closest("[data-focus-task-id]")?.dataset.focusTaskId); if (taskId) setFocus(taskId); });
  $("#detailActions").addEventListener("click", (event) => {
    const action = event.target.closest("[data-detail-action]")?.dataset.detailAction;
    const task = state.tasks.find((item) => item.id === state.selectedId);
    if (!task || !action) return;
    if (action === "complete") completeTask(task.id);
    if (action === "edit") { closeDialog("#detailDialog"); openTaskDialog(task); }
    if (action === "set-focus") setFocus(task.id);
    if (action === "clear-focus") { closeDialog("#detailDialog"); clearFocus(); }
  });
  $$("#closeTaskDialog,#cancelTaskDialog").forEach((button) => button.addEventListener("click", () => closeDialog("#taskDialog")));
  $("#closeDetailDialog").addEventListener("click", () => closeDialog("#detailDialog"));
  $("#closeFocusDialog").addEventListener("click", () => closeDialog("#focusDialog"));
  $("#importButton").addEventListener("click", openImportDialog);
  $$("#closeImportDialog,#cancelImportDialog").forEach((button) => button.addEventListener("click", () => closeDialog("#importDialog")));
  $("#importForm").addEventListener("submit", importLegacy);
  $("#importFile").addEventListener("change", (event) => { $("#importFileName").textContent = event.target.files[0]?.name || "选择备份文件"; });
  $("#logoutButton").addEventListener("click", async () => { try { await api("/auth/logout", { method: "POST", body: "{}" }); } catch {} showAuth(); });
  $("#profileButton").addEventListener("click", () => toast(`${state.member.displayName} · ${state.member.role === "admin" ? "可查看全家任务与当前重点" : "只显示与您有关的任务"}`));
  $$("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); }));
  window.addEventListener("focus", () => { if (state.member) loadData().catch(() => {}); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.member) loadData().catch(() => {}); });
  window.setInterval(() => { if (state.focus?.activeSession && !document.hidden) updateFocusElapsed(); }, 1000);
}

async function boot() {
  if (location.protocol === "file:") $("#googleLogin").href = "https://arc-patrimony.onrender.com/api/arc-todo/auth/google";
  try {
    const me = await api("/auth/me");
    state.member = me.member;
    await loadData();
    showApp();
  } catch (error) {
    if ($("#app").dataset.screen !== "auth") showAuth();
  }
  if ("serviceWorker" in navigator && (window.isSecureContext || location.hostname === "localhost")) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

bindEvents();
boot();
