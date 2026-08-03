# ARC TODO 上线与连接清单

ARC TODO 已作为凯旋门股神服务中的**独立模块**实现：网页位于 `/arc-todo/`，接口位于 `/api/arc-todo/*`，数据库表、登录 Cookie、OAuth 凭据、定时任务密钥均使用 `ARC_TODO_` 前缀。它不会读取或写入投资账户的表、登录、券商数据、既有 Gmail/Drive 令牌或既有定时任务密钥。

## 先保护旧版待办

旧版本地数据只在浏览器的 localStorage 中，尚未上传。请先在原来的本地页面：

1. 打开 `/Users/liubin/Library/CloudStorage/GoogleDrive-binandmolly@gmail.com/我的云端硬盘/管家婆/index.html`；
2. 刷新一次页面（让新版的 `ARC TODO` 名称与“备份待办”按钮载入）；
3. 点击右上角 **备份待办**，保存下载的 `arc-todo-backup-*.json`；
4. 不删除旧版资料夹，也不要清理浏览器网站数据。

新版上线且以管理员身份登录后，在 ARC TODO 左侧点击 **导入旧版备份**，把三种旧负责人映射至对应家庭成员。只有家庭管理员可导入，且导入不会给每一条历史待办补发通知。

## Render 环境变量

在现有 Render Web Service 的 Environment 页面新增下列变量。实际邮箱、密钥、刷新令牌只能填在 Render 的 Secret/Environment 中，不能写进代码或提交到 Git。

```text
ARC_TODO_ADMIN_EMAIL=
ARC_TODO_ADMIN_NAME=LIU BIN
ARC_TODO_MOLLY_EMAIL=
ARC_TODO_MOLLY_NAME=Molly
ARC_TODO_YUKUN_EMAIL=
ARC_TODO_YUKUN_NAME=Yukun

ARC_TODO_PUBLIC_ORIGIN=https://<your-render-service>.onrender.com
ARC_TODO_GOOGLE_CLIENT_ID=
ARC_TODO_GOOGLE_CLIENT_SECRET=
ARC_TODO_GOOGLE_REDIRECT_URI=https://<your-render-service>.onrender.com/api/arc-todo/auth/google/callback

ARC_TODO_SERVICE_CLIENT_ID=
ARC_TODO_SERVICE_CLIENT_SECRET=
ARC_TODO_SERVICE_REFRESH_TOKEN=
ARC_TODO_CALENDAR_ID=
ARC_TODO_CRON_SECRET=
NODE_ENV=production
```

`DATABASE_URL` 继续使用 Render 已提供的数据库连接即可；ARC TODO 会在启动时自行建立专属 `arc_todo_*` 表。

## 两套 Google 授权，必须隔离

### 1. 家庭成员登录（Web OAuth）

在 Google Cloud 创建一个新的 OAuth Client（类型 Web application），只用于 ARC TODO 登录：

- Authorized redirect URI：`ARC_TODO_GOOGLE_REDIRECT_URI` 的完整值；
- Scope：`openid`、`email`、`profile`；
- 将三位家庭成员的 Google 账号加入 OAuth consent screen 的测试用户（若应用仍处于 Testing）；
- Client ID/Secret 填入 `ARC_TODO_GOOGLE_CLIENT_ID`、`ARC_TODO_GOOGLE_CLIENT_SECRET`。

首次登录时，ARC TODO 只接受成员清单中已登记的邮箱。管理员可查看所有任务；其余家庭成员只能获得自己创建、负责或共同参与的任务。

### 2. ARC TODO 通知身份（服务 OAuth）

为通知另建一个 Google 授权身份；不要复用现有投资应用的 Gmail/Drive OAuth token。推荐创建专用 Google 账号，显示名称设置为 **ARC TODO**，并在这个账号内新建一个专用日历，例如“ARC TODO Family”。

该身份需要由账号拥有者在 Google 授权页面手工批准下列最小权限：

- `https://www.googleapis.com/auth/calendar.events.owned`
- `https://www.googleapis.com/auth/gmail.send`

将其 client ID、secret、refresh token 与专用日历 ID 分别填入 `ARC_TODO_SERVICE_*` 和 `ARC_TODO_CALENDAR_ID`。不要把 Google 密码、双重验证验证码或 refresh token 发给任何人。

由于 ARC TODO 需要长期发送提醒，Google Auth Platform 的发布状态必须是 **In production**，不能停留在 Testing；外部 Testing 模式的非基础 OAuth 令牌会在 7 天后过期。这个家庭版本保持为未验证的私有应用，后端仍只允许成员清单中的家庭邮箱登录，不向陌生人开放。

完成后，任务创建、改期或换负责人时会同步一个日历事项并发送 ARC TODO 邮件；到期前一天、到期当天与逾期第三天，提醒调度会检查并发送一次邮件，同时保持该任务的日历事项同步。完成任务后不再催办。

## 定时提醒

在 cron-job.org（或等效调度器）创建一条独立任务：

- URL：`https://<your-render-service>.onrender.com/api/arc-todo/cron/reminders`
- 方法：`POST`
- 频率：每小时一次，例如 `0 * * * *`（UTC）；
- 请求头：`x-arc-todo-cron-token: <ARC_TODO_CRON_SECRET>`。

调度器和 Render 中的 secret 必须相同。不要使用既有凯旋门投资系统的 `CRON_SECRET`。

## 验收顺序

1. 先部署代码，访问 `https://<service>/api/arc-todo/health`；应看到 `membersConfigured: 3` 及 `googleLoginConfigured: true`。
2. 用三位家庭成员分别登录 `/arc-todo/`，确认管理员看到全量任务，其他成员只能看到权限范围内的任务。
3. 创建一条指派给另一位成员、截止于明天的测试任务；确认 ARC TODO 邮件和专用日历事项均到达。
4. 手动以正确请求头调用一次提醒接口；检查同一检查点不会重复发送。
5. 导入旧版 JSON 备份，核对条数及三位负责人的映射。

如果登录或提醒配置尚未完成，网页仍可部署，但不会把任务写入浏览器本地数据，也不会假装已经发出日历或邮件提醒。配置完成前请继续保留旧版资料夹和导出的 JSON 备份。
