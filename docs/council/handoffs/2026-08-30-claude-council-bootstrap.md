---
date: 2026-08-30
agent: claude
phase: council-bootstrap
status: shipped
commits: []
contracts:
  - 议事厅文件格式(BOARD 三表 / 简报 front matter)
asks:
  - ASK-0001
---

# 建立两位 AI 的议事厅沟通机制

## 本阶段交付

把"两个 AI 互相通报阶段性成果"从口头约定变成仓库里可执行、可校验的机制。

- `docs/council/README.md` —— 协议全文:三种文件、三层心跳、ASK 异步问答、施工区防撞车。
- `docs/council/BOARD.md` —— 可变的现状公告板,三张机器可解析的表(施工区 / 待答请求 / 契约现状)。
- `docs/council/handoffs/TEMPLATE.md` —— 交班简报模板,三个必备小节。
- `council-core.js` —— 纯函数:front matter 与表格解析、路径重叠检测、入场简报、协议校验、周报生成。
- `council-cli.js` —— `brief` / `new` / `check` / `digest` 四个命令,对应 npm scripts。
- `CLAUDE.md` 与 `AGENTS.md` —— 两位 AI 各自的入口规则,内容对称。
- `.claude/settings.json` —— SessionStart hook,claude 每次开工自动打印入场简报。
- `.github/workflows/council.yml` —— PR 上跑协议体检;每周一自动生成并提交周报。
- `test/council-core.test.js` —— 覆盖解析、校验、简报与周报,并校验仓库里真实的议事厅文件自洽。

## 对方需要知道的

- **入场动作对 codex 是手动的**:`npm run council -- --agent codex`。claude 侧由 hook 自动执行,
  codex 侧目前没有等价机制,所以写进了 `AGENTS.md` 第一条。若你的运行环境有会话启动钩子,请补上。
- **BOARD.md 三张表的表头文字与列顺序是机器契约**,`council-core.js` 会逐字校验。
  想改列,先改 `council-core.js` 的 `CLAIMS_HEADER` / `ASKS_HEADER` / `CONTRACTS_HEADER` 与测试。
- 小节标题里的 `(claims)` / `(asks)` / `(contracts)` 是解析锚点,中文措辞可改,括号内容不能删。
- 简报**只增不改**;现状一律写 `BOARD.md`。历史文件被改会让周报与回溯失真。
- `npm run council:check` 已接入 CI,议事厅写坏会让 PR 变红。

## 我留下的未完成

- **契约现状表是我按 `docs/adr/` 与 `docs/plans/` 回填的**,只覆盖 ARC TODO 与议事厅自身;
  投资端(`server.js`、`arc_sentinel_*`)的跨模块契约尚未登记 —— 需要更熟悉那部分的人补,故先留空而非乱填。
- 周报只做**确定性汇总**(把简报字段压成一页),不做语义归纳。要"这周整体进展如何"的判断,
  仍需人或 AI 读周报后自己写;刻意不让 CI 里跑模型,避免定期心跳依赖额外凭证。
- `npm run council:new -- --title "多个词"` 经 npm 转发会丢引号,标题只取到第一个空格前。
  生成后直接改文件里的一级标题即可;暂未加参数重组逻辑。
- 施工区**没有强制力**(不是 git 锁),只在入场简报与 CI 里报冲突。这是刻意的:
  两位 AI 不同时在线,真锁会造成谁都解不开的死锁。

## 验证

- `npm test` —— 全部通过(含 ARC TODO 既有测试与议事厅新增 14 项)。
- `npm run council:check` —— 议事厅协议体检通过。
- `npm run council -- --agent codex` —— 能正确列出本份简报与 ASK-0001。
