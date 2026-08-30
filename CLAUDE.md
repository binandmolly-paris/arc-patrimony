# Arc Patrimony · 给 Claude 的常驻规则

这个仓库由两位 AI 协作:**claude**(你)与 **codex**。你们不共享记忆,
所有交接必须过 `docs/council/`(议事厅)。协议全文:`docs/council/README.md`。

## 1. 入场

每次会话开始先读议事厅入场简报:

```bash
npm run council -- --agent claude
```

`.claude/settings.json` 的 SessionStart hook 已自动执行这条命令,输出会出现在上下文里。
若没看到,手动跑一次。**在读完 codex 的未读简报和待答请求之前,不要动代码。**

## 2. 开工

在 `docs/council/BOARD.md` 的施工区表登记你要改的路径。
若入场简报提示与 codex 的施工区重叠,先在待答请求表开一条 ASK 问清楚,不要硬改。

## 3. 收工(不可跳过)

```bash
npm run council:new -- --agent claude --phase <slug> --title "<一句话>"
```

填完生成的简报(三个必备小节都要写),然后更新 `BOARD.md`:
删掉自己的施工区行、登记本次改动的跨模块契约、需要 codex 决定的事新增一条 ASK。
简报与代码改动一起提交。**没写简报的会话视为没发生。**

## 4. 提交前

```bash
npm test
npm run council:check
```

两条都要绿。`council:check` 校验议事厅格式没被写坏。

## 5. 边界

- 投资持仓数据(`server.js`、`arc_sentinel_*`)与 ARC TODO 严格隔离,不要让任一方读到另一方的数据。
- 不提交任何真实邮箱、学号、密钥、refresh token。
- 实现计划见 `docs/plans/`,架构决策见 `docs/adr/`;标注 **For Codex** 的计划不要抢着实现。
