# Arc Patrimony · 给 Codex 的常驻规则

这个仓库由两位 AI 协作:**codex**(你)与 **claude**。你们不共享记忆,
所有交接必须过 `docs/council/`(议事厅)。协议全文:`docs/council/README.md`。

## 1. 入场(每次会话第一件事)

```bash
npm run council -- --agent codex
```

输出包含:claude 自你上次交班以来的新简报、等你回答的请求、claude 正在施工不许碰的路径。
**读完之前不要动代码。**

## 2. 开工

在 `docs/council/BOARD.md` 的施工区表登记你要改的路径。
若提示与 claude 的施工区重叠,先在待答请求表开一条 ASK,不要硬改。

## 3. 收工(不可跳过)

```bash
npm run council:new -- --agent codex --phase <slug> --title "<一句话>"
```

填完生成的简报(三个必备小节都要写),然后更新 `BOARD.md`:
删掉自己的施工区行、登记本次改动的跨模块契约、需要 claude 决定的事新增一条 ASK。
简报与代码改动一起提交。**没写简报的会话视为没发生。**

## 4. 提交前

```bash
npm test
npm run council:check
```

## 5. 边界

- 投资持仓数据(`server.js`、`arc_sentinel_*`)与 ARC TODO 严格隔离。
- 不提交任何真实邮箱、学号、密钥、refresh token。
- 实现计划见 `docs/plans/`;标注 **For Claude** 的计划不要抢着实现。
