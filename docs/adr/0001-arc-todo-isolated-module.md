# ADR-0001: 在现有 Render 服务中以隔离模块承载 ARC TODO

## Status

Accepted — 2026-08-02

## Context

ARC TODO 需要为 LIU BIN、Molly 与 Yukun 提供跨设备任务协作、Google 登录、日历邀请、邮件提醒和定时升级提醒。现有 Arc Patrimony 已运行在 Render，具备 Express、PostgreSQL、Google API 与定时任务基础；但它保存投资持仓，任何家庭成员登录或自动化凭证均不得读取、写入或推断投资数据。

## Decision

采用**模块化单体**：ARC TODO 使用同一个 Render Web Service 与 PostgreSQL 实例，但拥有完全独立的：

- 静态站点路径 `/arc-todo/`；
- `/api/arc-todo/*` 路由模块；
- `arc_todo_*` 数据库表、独立成员模型和独立会话 cookie；
- `ARC_TODO_*` 环境变量与 `x-arc-todo-cron-token`；
- 最小权限的 Google OAuth 客户端，只申请登录、专用日历和专用邮件发送所需权限。

ARC TODO 不调用 `users`、`holdings`、`trades`、`alerts`、`portfolio_config`、投资 session、`CRON_SECRET`、`ALERT_SECRET`、`HOLDINGS_WRITE_SECRET` 或现有全盘 Google Drive refresh token。

## Consequences

### Positive

- 不需新建第二套云服务或数据库，能够复用现有 Render 部署、PostgreSQL、域名和定时经验。
- 所有家庭任务数据有独立表与审计记录；任何 ARC TODO SQL 都不访问投资表。
- 可用专用 cookie、独立 token 和最小 Google scopes 进行隔离。

### Negative

- 同一服务发布仍有运维关联：发布前需跑两套检查，数据库备份需覆盖两类数据。
- Google OAuth 需要新增 Web Application 凭证、授权回调 URL 和每位家庭成员的显式同意。

## Alternatives Considered

### 新建 Supabase + Vercel

隔离最直观，但重复账户、费用、部署与监控；对三人家庭过度分散。

### 在投资 App 内添加一个家庭 Tab

拒绝。会迫使家人进入投资应用，增加隐私和授权边界风险。

### Google Sheet / Apps Script

上手快，但角色可见性、审计、PWA 体验与可维护性较弱。

## References

- `PROJECT_BRIEF.md`
- `DEPLOY_哨兵自动化.md`
- `付费API清单.md`
