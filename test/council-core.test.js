const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseFrontMatter,
  parseBoard,
  parseHandoff,
  pathsOverlap,
  detectClaimConflicts,
  lastHandoffOf,
  buildBrief,
  validate,
  buildDigest,
  nextAskId
} = require("../council-core");

const BOARD = [
  "# 议事厅 · 公告板",
  "",
  "## 施工区 (claims)",
  "",
  "| 认领人 | 路径 | 目的 | 认领日 | 预计释放 |",
  "| --- | --- | --- | --- | --- |",
  "| claude | docs/council | 建机制 | 2026-08-30 | 2026-08-30 |",
  "",
  "## 待答请求 (asks)",
  "",
  "| ID | 提出方 | 面向 | 请求 | 状态 | 回应 |",
  "| --- | --- | --- | --- | --- | --- |",
  "| ASK-0001 | claude | codex | 请握手 | OPEN | — |",
  "| ASK-0002 | codex | claude | 焦点表要不要加索引 | ANSWERED | 加,已在 0004 简报 |",
  "",
  "## 契约现状 (contracts)",
  "",
  "| 契约 | 位置 | 最后变更 | 变更人 |",
  "| --- | --- | --- | --- |",
  "| /api/arc-todo/* | arc-todo-routes.js | 2026-08-04 | codex |",
  ""
].join("\n");

function handoffText(overrides = {}) {
  const front = {
    date: "2026-08-30",
    agent: "claude",
    phase: "council-bootstrap",
    status: "shipped",
    ...overrides
  };
  return [
    "---",
    `date: ${front.date}`,
    `agent: ${front.agent}`,
    `phase: ${front.phase}`,
    `status: ${front.status}`,
    "commits:",
    "  - abc1234",
    "contracts: []",
    "asks:",
    "  - ASK-0001",
    "---",
    "",
    "# 建立议事厅",
    "",
    "## 本阶段交付",
    "内容",
    "",
    "## 对方需要知道的",
    "内容",
    "",
    "## 我留下的未完成",
    "内容",
    ""
  ].join("\n");
}

test("parses scalar, empty-list and dash-list front matter fields", () => {
  const { data, body } = parseFrontMatter(handoffText());
  assert.equal(data.agent, "claude");
  assert.deepEqual(data.commits, ["abc1234"]);
  assert.deepEqual(data.contracts, []);
  assert.deepEqual(data.asks, ["ASK-0001"]);
  assert.ok(body.startsWith("# 建立议事厅"));
});

test("rejects front matter that is missing or unclosed", () => {
  assert.throws(() => parseFrontMatter("# 没有 front matter"), /第一行必须是/);
  assert.throws(() => parseFrontMatter("---\nagent: claude\n"), /未闭合/);
});

test("parses the three board tables by their english anchors", () => {
  const board = parseBoard(BOARD);
  assert.equal(board.claims.length, 1);
  assert.equal(board.claims[0].agent, "claude");
  assert.equal(board.asks.length, 2);
  assert.equal(board.asks[1].status, "ANSWERED");
  assert.equal(board.contracts[0].changedBy, "codex");
});

test("rejects a board whose table header drifted from the machine contract", () => {
  const drifted = BOARD.replace("| 认领人 | 路径 |", "| 路径 | 认领人 |");
  assert.throws(() => parseBoard(drifted), /表头必须是/);
});

test("parses a handoff and keeps filename and front matter in sync", () => {
  const handoff = parseHandoff("2026-08-30-claude-council-bootstrap.md", handoffText());
  assert.equal(handoff.agent, "claude");
  assert.equal(handoff.title, "建立议事厅");
  assert.deepEqual(handoff.asks, ["ASK-0001"]);

  assert.throws(
    () => parseHandoff("2026-08-30-claude-council-bootstrap.md", handoffText({ agent: "codex" })),
    /与文件名不一致/
  );
  assert.throws(
    () => parseHandoff("bootstrap.md", handoffText()),
    /文件名必须是/
  );
  assert.throws(
    () => parseHandoff("2026-08-30-claude-council-bootstrap.md", handoffText({ status: "done" })),
    /status 只能是/
  );
});

test("rejects a handoff that dropped a required section", () => {
  const missing = handoffText().replace("## 我留下的未完成", "## 杂项");
  assert.throws(
    () => parseHandoff("2026-08-30-claude-council-bootstrap.md", missing),
    /缺少必备小节/
  );
});

test("treats identical and directory-prefix paths as overlapping", () => {
  assert.equal(pathsOverlap("arc-todo-core.js", "arc-todo-core.js"), true);
  assert.equal(pathsOverlap("docs/council", "docs/council/handoffs"), true);
  assert.equal(pathsOverlap("docs/council/**", "docs/council/BOARD.md"), true);
  assert.equal(pathsOverlap("docs/council", "docs/plans"), false);
  assert.equal(pathsOverlap("arc-todo-core.js", "arc-todo-routes.js"), false);
});

test("flags overlapping claims only across different agents", () => {
  const sameAgent = [
    { agent: "claude", path: "docs/council" },
    { agent: "claude", path: "docs/council/handoffs" }
  ];
  assert.equal(detectClaimConflicts(sameAgent).length, 0);

  const crossAgent = [
    { agent: "claude", path: "docs/council" },
    { agent: "codex", path: "docs/council/handoffs" }
  ];
  assert.equal(detectClaimConflicts(crossAgent).length, 1);
});

test("brief shows only the peer handoffs newer than my last one", () => {
  const handoffs = [
    parseHandoff("2026-08-01-codex-old.md", handoffText({ date: "2026-08-01", agent: "codex", phase: "old" })),
    parseHandoff("2026-08-30-claude-council-bootstrap.md", handoffText()),
    parseHandoff("2026-08-31-codex-new.md", handoffText({ date: "2026-08-31", agent: "codex", phase: "new" }))
  ];
  assert.equal(lastHandoffOf(handoffs, "claude").file, "2026-08-30-claude-council-bootstrap.md");

  const brief = buildBrief({ agent: "claude", handoffs, board: parseBoard(BOARD) });
  assert.match(brief, /2026-08-31-codex-new\.md/);
  assert.doesNotMatch(brief, /2026-08-01-codex-old\.md/);
  // ASK-0001 是 claude 提给 codex 的,应出现在“我还在等对方回答的”而非“等我回答的”。
  assert.match(brief, /## 等我回答的请求\(0\)/);
  assert.match(brief, /## 我还在等对方回答的\(1\)/);
});

test("brief for a first-time agent shows every peer handoff", () => {
  const handoffs = [
    parseHandoff("2026-08-30-claude-council-bootstrap.md", handoffText())
  ];
  const brief = buildBrief({ agent: "codex", handoffs, board: parseBoard(BOARD) });
  assert.match(brief, /上次交班:\(还没有\)/);
  assert.match(brief, /2026-08-30-claude-council-bootstrap\.md/);
  assert.match(brief, /## 等我回答的请求\(1\)/);
});

test("validate accepts a healthy council and names each defect otherwise", () => {
  const board = parseBoard(BOARD);
  const handoffs = [parseHandoff("2026-08-30-claude-council-bootstrap.md", handoffText())];
  assert.deepEqual(validate({ handoffs, board }), []);

  const broken = {
    claims: [
      { agent: "claude", path: "arc-todo-core.js" },
      { agent: "codex", path: "arc-todo-core.js" }
    ],
    asks: [
      { id: "ASK-0001", from: "claude", to: "claude", question: "q", status: "MAYBE", answer: "—" },
      { id: "ASK-0001", from: "claude", to: "codex", question: "q", status: "ANSWERED", answer: "—" }
    ],
    contracts: []
  };
  const problems = validate({ handoffs: [], board: broken });
  assert.ok(problems.some((p) => /状态只能是/.test(p)));
  assert.ok(problems.some((p) => /不能向自己提问/.test(p)));
  assert.ok(problems.some((p) => /重复的请求 ID/.test(p)));
  assert.ok(problems.some((p) => /没有写回应/.test(p)));
  assert.ok(problems.some((p) => /施工区冲突/.test(p)));
});

test("validate rejects a handoff pointing at an ask the board never had", () => {
  const board = parseBoard(BOARD.replace("| ASK-0001 | claude | codex | 请握手 | OPEN | — |\n", ""));
  const handoffs = [parseHandoff("2026-08-30-claude-council-bootstrap.md", handoffText())];
  const problems = validate({ handoffs, board });
  assert.ok(problems.some((p) => /不存在的 ASK-0001/.test(p)));
});

test("digest covers the window and carries open asks forward", () => {
  const handoffs = [
    parseHandoff("2026-08-01-codex-old.md", handoffText({ date: "2026-08-01", agent: "codex", phase: "old" })),
    parseHandoff("2026-08-30-claude-council-bootstrap.md", handoffText())
  ];
  const digest = buildDigest({
    handoffs,
    board: parseBoard(BOARD),
    since: "2026-08-24",
    until: "2026-08-30"
  });
  assert.match(digest, /共交付 1 个阶段/);
  assert.match(digest, /建立议事厅/);
  assert.doesNotMatch(digest, /2026-08-01/);
  assert.match(digest, /仍未答复的请求\(1\)/);
});

test("allocates the next ask id above the highest existing one", () => {
  assert.equal(nextAskId(parseBoard(BOARD)), "ASK-0003");
  assert.equal(nextAskId({ asks: [] }), "ASK-0001");
});

test("the committed council files satisfy their own protocol", () => {
  const dir = path.join(__dirname, "..", "docs", "council");
  const board = parseBoard(fs.readFileSync(path.join(dir, "BOARD.md"), "utf8"));
  const handoffDir = path.join(dir, "handoffs");
  const handoffs = fs
    .readdirSync(handoffDir)
    .filter((name) => name.endsWith(".md") && name !== "TEMPLATE.md")
    .map((name) => parseHandoff(name, fs.readFileSync(path.join(handoffDir, name), "utf8")));
  assert.deepEqual(validate({ handoffs, board }), []);
  assert.ok(handoffs.length >= 1, "议事厅至少要有一份交班简报");
});
