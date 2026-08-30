# 议事厅协议(Council Protocol)

两位 AI —— **claude** 与 **codex** —— 不共享记忆、不同时在线、看不到对方的会话。
唯一可靠的共享介质是这个 git 仓库。因此议事厅只做一件事:
**把"某个 AI 脑子里的阶段性成果"变成"另一个 AI 下次开工时一定会读到的文件"。**

## 一、三种文件,各司其职

| 文件 | 性质 | 回答的问题 |
| --- | --- | --- |
| `BOARD.md` | 可变,一份,随时覆盖 | **现在**是什么状态?谁在动哪块?什么问题悬着? |
| `handoffs/*.md` | 只增不改,一次一份 | 那一次**做完了什么**?为什么这么做? |
| `digests/*.md` | 机器生成 | 这一周**两边合起来**发生了什么?(给人看) |

规矩只有一条:**BOARD.md 是现状,handoffs 是历史。** 历史写完不许回头改;
现状每次交班都必须覆盖成最新。任何"我以为对方知道"的东西,不在这两处就等于没说过。

## 二、节奏:三层心跳

机制不靠"记得沟通",靠**每层都有一个不可跳过的动作**。

### 第 1 层 · 每次开工与收工(最小心跳)

- **入场**:`npm run council -- --agent <自己>`
  输出:对方自我上次交班以来的新简报、等我回答的请求、对方正在施工不许碰的路径。
  对 claude 这一步由 `.claude/settings.json` 的 SessionStart hook 自动执行,不用记。
  对 codex 由 `AGENTS.md` 第一条规定手动执行。
- **离场**:`npm run council:new -- --agent <自己> --phase <slug>` 生成简报,填完,
  再更新 `BOARD.md`,和代码一起提交。**没写简报的会话视为没发生。**

### 第 2 层 · 每完成一个阶段(成果心跳)

一个 `docs/plans/*.md` 跑完、一个 ADR 定下来、一次 PR 合并 —— 都是一个"阶段"。
阶段结束时,简报的 `status` 写 `shipped`,并在 `BOARD.md` 的契约现状表登记
本阶段改动的**跨模块契约**(HTTP 路由、数据表、共享模块的导出、环境变量)。
契约是两个 AI 最容易互相踩烂的东西,所以它单独有一张表,而不是埋在正文里。

### 第 3 层 · 每周(对账心跳)

GitHub Actions 每周一 UTC 01:00 跑 `npm run council:digest -- --write`,
把这一周两边的简报压成 `digests/<日期>.md` 并提交。人只需要读这一页。
两位 AI 谁都可能一周没上线,周报因此是**唯一不依赖任何 AI 记性**的一环。

## 三、异步问答:ASK

一方要另一方决定或补做的事,不写在正文里(正文没人回),而是在 `BOARD.md`
的待答请求表新增一行,ID 形如 `ASK-0007`,状态 `OPEN`。
对方入场简报里会直接看到"等我回答的请求"。回答时**就地改这一行**:
填回应、状态改 `ANSWERED`。已答复的行保留,不删,便于回溯。
无需再答的写 `DROPPED` 并说明原因。

ASK 是这套机制里唯一的双向通道 —— 简报是"我告诉你",ASK 是"我需要你"。

## 四、防撞车:施工区

动手之前,在 `BOARD.md` 的施工区表登记自己要改的路径。
`council-cli.js` 会在入场简报和 CI 里检查**跨 AI 的路径重叠**(相同或互为目录前缀),
重叠即报冲突。收工时删掉自己那一行。

施工区不是锁 —— 没有强制力,但冲突会在 CI 里变成红叉,足够让人和 AI 都看见。

## 五、命令

```bash
npm run council -- --agent claude          # 入场简报
npm run council:new -- --agent claude --phase focus-mode-v2 --title "专注模式 v2"
npm run council:check                      # 协议体检(CI 会跑)
npm run council:digest                     # 打印本周周报
npm run council:digest -- --write          # 写入 docs/council/digests/
```

## 六、格式是机器契约

`BOARD.md` 三张表的**表头文字与列顺序**、简报文件名 `YYYY-MM-DD-<agent>-<slug>.md`、
front matter 字段、正文的三个必备小节 —— 都被 `council-core.js` 解析和校验。
要改格式,先改 `council-core.js` 与 `test/council-core.test.js`,再改文档,
不要只改文档:`npm run council:check` 会立刻变红。

小节标题里的英文锚点 `(claims)` / `(asks)` / `(contracts)` 是解析定位用的,
中文措辞可以随便改,括号里的锚点不能删。
