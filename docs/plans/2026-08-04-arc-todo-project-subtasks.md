# ARC TODO · 项目与子任务 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不改变既有待办、提醒、日历与当前重点的前提下，增加“项目（大事）→ 子任务（可执行事项）”两层结构。

**Architecture:** 新建独立的 `arc_todo_projects` 表，项目只保存目标、可选总截止日、说明与创建者；现有 `arc_todo_tasks` 以可空的 `project_id` 关联项目。所有负责人、个人排程、Google Calendar 同步和当前重点继续只作用于子任务，避免项目误触发提醒或占用日历。

**Tech Stack:** Node.js、Express、PostgreSQL、原生浏览器 JavaScript、CSS、node:test。

---

### Task 1: 项目数据与输入验证

**Files:**
- Modify: `arc-todo-core.js`
- Modify: `arc-todo-routes.js`
- Modify: `test/arc-todo-core.test.js`

**Step 1: Write the failing tests**

新增项目输入测试：标题去除空格、可选总截止日转为 ISO 时间、空标题和无效日期被拒绝。

**Step 2: Implement the minimal validation and migration**

在 `arc-todo-core.js` 添加 `normalizeProjectInput`；在启动迁移中新建 `arc_todo_projects`，并给现有任务增加可空 `project_id` 外键和索引。旧任务保持 `project_id=NULL`，因此仍是独立任务。

**Step 3: Verify**

Run: `npm test`

Expected: 项目验证与原有待办测试全部通过。

### Task 2: 项目 API 与子任务关联

**Files:**
- Modify: `arc-todo-routes.js`
- Test: `test/arc-todo-core.test.js`

**Step 1: Implement project visibility and summaries**

增加项目创建、读取、编辑接口。管理员可见全部项目；家庭成员仅可见自己创建的项目或自己参与的子任务所属项目。项目返回总子任务数与已完成数；没有项目级提醒或日历事件。

**Step 2: Associate existing task APIs**

为任务创建/编辑接口接受可选 `projectId`，验证项目存在且调用者可访问；任务读取接口返回 `project_id` 和 `project_title`。任务完成后，项目摘要自动更新。

**Step 3: Verify**

Run: `node --check arc-todo-routes.js && npm test`

Expected: API 代码可解析，所有单元测试通过。

### Task 3: 极简项目界面与子任务入口

**Files:**
- Modify: `public/arc-todo/index.html`
- Modify: `public/arc-todo/app.js`
- Modify: `public/arc-todo/styles.css`
- Modify: `public/arc-todo/sw.js`

**Step 1: Implement project list and detail**

侧栏增加“项目”。项目卡显示标题、总截止日（若有）和 `已完成 / 总数`；点击后进入项目详情，展示子任务列表和“添加子任务”。

**Step 2: Keep task entry clean**

增加独立的“新建项目”入口。原“添加一件事”表单只增加一个可选的“所属项目”选择框；从项目详情添加子任务时自动预选该项目。项目本身不能成为当前重点，也不会出现在计划日程。

**Step 3: Verify**

Run: `node --check public/arc-todo/app.js && npm test`

Expected: 浏览器脚本可解析，测试通过；Service Worker 缓存版本更新使手机和电脑收到新界面。

### Task 4: 文档、提交与发布验证

**Files:**
- Modify: `docs/ARC_TODO_RENDER_SETUP.md`

**Step 1: Document the behavior**

说明项目无提醒/日历、子任务拥有提醒/排程，旧任务仍可独立使用。

**Step 2: Verify and commit**

Run: `git diff --check && npm test && git status --short`

Expected: 无格式错误、测试通过，只包含本功能相关文件。

**Step 3: Publish**

提交并推送 `main`；确认 Render 健康检查正常后，手工检查：新项目、两个子任务、完成一个子任务、将另一个排入计划日，确认项目进度正确且只有子任务进入日历。
