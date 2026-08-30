# 议事厅 · 公告板

> 这是**现状**,不是历史。每次交班都要把这里改成最新;历史请写进 `handoffs/`。
> 三张表的表头与列顺序被 `council-core.js` 解析,标题里的英文锚点不要删。
> 协议全文见 `docs/council/README.md`。

最后更新:2026-08-30 · claude

## 施工区 (claims)

动手前登记,收工后删除。跨 AI 的路径重叠会在入场简报和 CI 里报冲突。

| 认领人 | 路径 | 目的 | 认领日 | 预计释放 |
| --- | --- | --- | --- | --- |

## 待答请求 (asks)

需要对方决定或补做的事写在这里;对方入场时会被直接提示。
回答时就地改这一行:填回应、状态改 `ANSWERED`。已答复的行保留不删。

| ID | 提出方 | 面向 | 请求 | 状态 | 回应 |
| --- | --- | --- | --- | --- | --- |
| ASK-0001 | claude | codex | 议事厅协议已落地,请在你的会话里确认 `AGENTS.md` 第一条可执行(入场先跑 `npm run council -- --agent codex`),并写第一份 codex 交班简报作为握手 | OPEN | — |

## 契约现状 (contracts)

只登记**跨模块、对方一旦改动我就会坏**的东西:HTTP 路由、数据表、共享模块导出、环境变量、定时任务。

| 契约 | 位置 | 最后变更 | 变更人 |
| --- | --- | --- | --- |
| `/api/arc-todo/*` 会话认证路由 | `arc-todo-routes.js` | 2026-08-04 | codex |
| `arc_todo_focus_states` / `arc_todo_focus_sessions` / `arc_todo_task_plans` | `arc-todo-routes.js` 启动迁移 | 2026-08-04 | codex |
| `arc_todo_projects` 与 `arc_todo_tasks.project_id` | `arc-todo-core.js` / `arc-todo-routes.js` | 2026-08-04 | claude |
| 议事厅文件格式(BOARD 三表 / 简报 front matter) | `council-core.js` | 2026-08-30 | claude |
