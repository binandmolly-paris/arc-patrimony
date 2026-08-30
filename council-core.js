"use strict";

// 议事厅(Council)核心:纯函数,不碰文件系统、不联网,便于 node:test 覆盖。
// 两位 AI(claude / codex)通过 git 里的两类文件沟通:
//   - docs/council/BOARD.md      可变的“当前状态”(施工区 / 待答请求 / 契约现状)
//   - docs/council/handoffs/*.md 只增不改的“阶段成果交班简报”

const AGENTS = ["claude", "codex"];
const HANDOFF_STATUS = ["shipped", "in-progress", "blocked"];
const ASK_STATUS = ["OPEN", "ANSWERED", "DROPPED"];

// 表格列顺序即机器契约:改列顺序必须同时改这里和 BOARD.md。
const CLAIMS_HEADER = ["认领人", "路径", "目的", "认领日", "预计释放"];
const ASKS_HEADER = ["ID", "提出方", "面向", "请求", "状态", "回应"];
const CONTRACTS_HEADER = ["契约", "位置", "最后变更", "变更人"];

function splitLines(text) {
  return String(text).replace(/\r\n/g, "\n").split("\n");
}

// 极简 front matter:只支持 `key: value`、`key: []` 和缩进短横线列表。
// 刻意不引入 YAML 依赖 —— 简报字段少,越简单越不会两边解析不一致。
function parseFrontMatter(text) {
  const lines = splitLines(text);
  if (lines[0] !== "---") {
    throw new Error("缺少 front matter:文件第一行必须是 ---");
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    throw new Error("front matter 未闭合:找不到第二个 ---");
  }
  const data = {};
  let listKey = null;
  for (let i = 1; i < end; i += 1) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const item = raw.match(/^\s+-\s*(.*)$/);
    if (item) {
      if (!listKey) throw new Error(`列表项没有归属字段:${raw.trim()}`);
      const value = item[1].trim();
      if (value) data[listKey].push(value);
      continue;
    }
    const pair = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) throw new Error(`无法解析的 front matter 行:${raw}`);
    const key = pair[1];
    const value = pair[2].trim();
    if (value === "" ) {
      data[key] = [];
      listKey = key;
    } else if (value === "[]") {
      data[key] = [];
      listKey = null;
    } else {
      data[key] = value;
      listKey = null;
    }
  }
  return { data, body: lines.slice(end + 1).join("\n").trim() };
}

function parseTableRows(lines, start) {
  const rows = [];
  let i = start;
  while (i < lines.length && lines[i].trim().startsWith("|")) {
    const cells = lines[i]
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    rows.push(cells);
    i += 1;
  }
  return rows;
}

// 用标题里的英文锚点(claims / asks / contracts)定位表格,
// 这样中文标题措辞怎么改都不会把解析弄坏。
function parseSectionTable(text, anchor) {
  const lines = splitLines(text);
  const headingIndex = lines.findIndex(
    (line) => /^#{2,3}\s/.test(line) && line.includes(`(${anchor})`)
  );
  if (headingIndex === -1) {
    throw new Error(`BOARD.md 缺少带 (${anchor}) 锚点的小节`);
  }
  let i = headingIndex + 1;
  while (i < lines.length && !lines[i].trim().startsWith("|")) {
    if (/^#{2,3}\s/.test(lines[i])) {
      throw new Error(`(${anchor}) 小节里没有表格`);
    }
    i += 1;
  }
  const rows = parseTableRows(lines, i);
  if (rows.length < 2) throw new Error(`(${anchor}) 表格不完整`);
  const header = rows[0];
  const data = rows.slice(2).filter((row) => row.some((cell) => cell && cell !== "—"));
  return { header, rows: data };
}

function assertHeader(anchor, actual, expected) {
  const same =
    actual.length === expected.length && actual.every((cell, idx) => cell === expected[idx]);
  if (!same) {
    throw new Error(
      `(${anchor}) 表头必须是 ${expected.join(" | ")},当前是 ${actual.join(" | ")}`
    );
  }
}

function parseBoard(text) {
  const claimsTable = parseSectionTable(text, "claims");
  assertHeader("claims", claimsTable.header, CLAIMS_HEADER);
  const asksTable = parseSectionTable(text, "asks");
  assertHeader("asks", asksTable.header, ASKS_HEADER);
  const contractsTable = parseSectionTable(text, "contracts");
  assertHeader("contracts", contractsTable.header, CONTRACTS_HEADER);

  return {
    claims: claimsTable.rows.map((row) => ({
      agent: row[0],
      path: row[1],
      purpose: row[2],
      claimedOn: row[3],
      releaseBy: row[4]
    })),
    asks: asksTable.rows.map((row) => ({
      id: row[0],
      from: row[1],
      to: row[2],
      question: row[3],
      status: row[4],
      answer: row[5]
    })),
    contracts: contractsTable.rows.map((row) => ({
      name: row[0],
      location: row[1],
      changedOn: row[2],
      changedBy: row[3]
    }))
  };
}

const HANDOFF_NAME = /^(\d{4}-\d{2}-\d{2})-(claude|codex)-([a-z0-9][a-z0-9-]*)\.md$/;

function parseHandoff(filename, text) {
  const name = HANDOFF_NAME.exec(filename);
  if (!name) {
    throw new Error(`交班简报文件名必须是 YYYY-MM-DD-<agent>-<slug>.md,当前是 ${filename}`);
  }
  const { data, body } = parseFrontMatter(text);
  const handoff = {
    file: filename,
    date: String(data.date || ""),
    agent: String(data.agent || ""),
    phase: String(data.phase || ""),
    status: String(data.status || ""),
    commits: Array.isArray(data.commits) ? data.commits : [],
    contracts: Array.isArray(data.contracts) ? data.contracts : [],
    asks: Array.isArray(data.asks) ? data.asks : [],
    title: (body.match(/^#\s+(.+)$/m) || [, ""])[1].trim(),
    body
  };
  if (handoff.date !== name[1]) {
    throw new Error(`${filename}: front matter 的 date (${handoff.date}) 与文件名不一致`);
  }
  if (handoff.agent !== name[2]) {
    throw new Error(`${filename}: front matter 的 agent (${handoff.agent}) 与文件名不一致`);
  }
  if (handoff.phase !== name[3]) {
    throw new Error(`${filename}: front matter 的 phase (${handoff.phase}) 与文件名不一致`);
  }
  if (!AGENTS.includes(handoff.agent)) {
    throw new Error(`${filename}: agent 只能是 ${AGENTS.join(" / ")}`);
  }
  if (!HANDOFF_STATUS.includes(handoff.status)) {
    throw new Error(`${filename}: status 只能是 ${HANDOFF_STATUS.join(" / ")}`);
  }
  if (!handoff.title) {
    throw new Error(`${filename}: 正文缺少一级标题`);
  }
  for (const section of ["## 本阶段交付", "## 对方需要知道的", "## 我留下的未完成"]) {
    if (!body.includes(section)) {
      throw new Error(`${filename}: 正文缺少必备小节 ${section}`);
    }
  }
  return handoff;
}

function sortHandoffs(handoffs) {
  return [...handoffs].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

function other(agent) {
  return agent === "claude" ? "codex" : "claude";
}

function normalizePath(p) {
  return String(p).trim().replace(/\/?\*+$/, "").replace(/\/+$/, "");
}

// 两条路径冲突 = 相同,或一条是另一条的目录前缀。
function pathsOverlap(a, b) {
  const x = normalizePath(a);
  const y = normalizePath(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

function detectClaimConflicts(claims) {
  const conflicts = [];
  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      if (claims[i].agent === claims[j].agent) continue;
      if (pathsOverlap(claims[i].path, claims[j].path)) {
        conflicts.push([claims[i], claims[j]]);
      }
    }
  }
  return conflicts;
}

function lastHandoffOf(handoffs, agent) {
  const mine = sortHandoffs(handoffs).filter((h) => h.agent === agent);
  return mine.length ? mine[mine.length - 1] : null;
}

// 入场简报:自己上次交班之后,对方交付了什么、有什么问题在等我、哪些地方不许动。
function buildBrief({ agent, handoffs, board }) {
  if (!AGENTS.includes(agent)) throw new Error(`未知 agent: ${agent}`);
  const peer = other(agent);
  const mine = lastHandoffOf(handoffs, agent);
  const since = mine ? mine.file : "";
  const unread = sortHandoffs(handoffs).filter((h) => h.agent === peer && h.file > since);
  const openAsks = board.asks.filter((a) => a.status === "OPEN" && a.to === agent);
  const myOpenAsks = board.asks.filter((a) => a.status === "OPEN" && a.from === agent);
  const peerClaims = board.claims.filter((c) => c.agent === peer);

  const out = [];
  out.push(`# 议事厅入场简报 · ${agent}`);
  out.push("");
  out.push(`上次交班:${mine ? mine.file : "(还没有)"}`);
  out.push("");

  out.push(`## ${peer} 自那以后的阶段成果(${unread.length})`);
  if (!unread.length) {
    out.push("- 无新简报。");
  } else {
    for (const h of unread) {
      out.push(`- [${h.status}] ${h.date} ${h.title}  (${h.file})`);
      if (h.contracts.length) out.push(`    契约变更:${h.contracts.join("、")}`);
    }
  }
  out.push("");

  out.push(`## 等我回答的请求(${openAsks.length})`);
  if (!openAsks.length) out.push("- 无。");
  else for (const a of openAsks) out.push(`- ${a.id} ← ${a.from}:${a.question}`);
  out.push("");

  out.push(`## 我还在等对方回答的(${myOpenAsks.length})`);
  if (!myOpenAsks.length) out.push("- 无。");
  else for (const a of myOpenAsks) out.push(`- ${a.id} → ${a.to}:${a.question}`);
  out.push("");

  out.push(`## ${peer} 正在施工、我不要碰(${peerClaims.length})`);
  if (!peerClaims.length) out.push("- 无。");
  else for (const c of peerClaims) out.push(`- ${c.path}(${c.purpose},预计 ${c.releaseBy} 释放)`);
  out.push("");

  const conflicts = detectClaimConflicts(board.claims);
  if (conflicts.length) {
    out.push("## ⚠ 施工区冲突");
    for (const [a, b] of conflicts) {
      out.push(`- ${a.agent}:${a.path}  ×  ${b.agent}:${b.path}`);
    }
    out.push("");
  }

  out.push("离场前必须:写一份交班简报(npm run council:new)并更新 BOARD.md。");
  return out.join("\n");
}

// CI / 提交前的协议体检。
function validate({ handoffs, board }) {
  const problems = [];
  const ids = new Set(board.asks.map((a) => a.id));

  for (const ask of board.asks) {
    if (!ASK_STATUS.includes(ask.status)) {
      problems.push(`${ask.id}: 状态只能是 ${ASK_STATUS.join(" / ")}`);
    }
    if (!AGENTS.includes(ask.from) || !AGENTS.includes(ask.to)) {
      problems.push(`${ask.id}: 提出方/面向必须是 ${AGENTS.join(" / ")}`);
    }
    if (ask.from === ask.to) problems.push(`${ask.id}: 不能向自己提问`);
    if (ask.status === "ANSWERED" && (!ask.answer || ask.answer === "—")) {
      problems.push(`${ask.id}: 标记 ANSWERED 但没有写回应`);
    }
  }

  const seen = new Set();
  for (const ask of board.asks) {
    if (seen.has(ask.id)) problems.push(`${ask.id}: 重复的请求 ID`);
    seen.add(ask.id);
  }

  for (const handoff of handoffs) {
    for (const id of handoff.asks) {
      if (!ids.has(id)) problems.push(`${handoff.file}: 引用了 BOARD.md 里不存在的 ${id}`);
    }
  }

  for (const claim of board.claims) {
    if (!AGENTS.includes(claim.agent)) {
      problems.push(`施工区 ${claim.path}: 认领人必须是 ${AGENTS.join(" / ")}`);
    }
  }

  for (const [a, b] of detectClaimConflicts(board.claims)) {
    problems.push(`施工区冲突:${a.agent} 的 ${a.path} 与 ${b.agent} 的 ${b.path} 重叠`);
  }

  return problems;
}

// 定期摘要:把一段时间内两边的简报压成一页,给人看。
function buildDigest({ handoffs, board, since, until }) {
  const inRange = sortHandoffs(handoffs).filter(
    (h) => (!since || h.date >= since) && (!until || h.date <= until)
  );
  const out = [];
  out.push(`# 议事厅周报 · ${since || "开天辟地"} → ${until || "至今"}`);
  out.push("");
  out.push(`本期两位 AI 共交付 ${inRange.length} 个阶段。`);
  out.push("");
  for (const agent of AGENTS) {
    const items = inRange.filter((h) => h.agent === agent);
    out.push(`## ${agent}(${items.length})`);
    if (!items.length) out.push("- 本期无交付。");
    else
      for (const h of items) {
        out.push(`- ${h.date} [${h.status}] ${h.title}`);
        if (h.commits.length) out.push(`    提交:${h.commits.join(" ")}`);
      }
    out.push("");
  }
  const contracts = [...new Set(inRange.flatMap((h) => h.contracts))];
  out.push(`## 本期契约变更(${contracts.length})`);
  if (!contracts.length) out.push("- 无。");
  else for (const c of contracts) out.push(`- ${c}`);
  out.push("");
  const open = board.asks.filter((a) => a.status === "OPEN");
  out.push(`## 仍未答复的请求(${open.length})`);
  if (!open.length) out.push("- 无。");
  else for (const a of open) out.push(`- ${a.id} ${a.from} → ${a.to}:${a.question}`);
  out.push("");
  return out.join("\n");
}

function nextAskId(board) {
  const numbers = board.asks
    .map((a) => Number((/^ASK-(\d+)$/.exec(a.id) || [, 0])[1]))
    .filter((n) => Number.isFinite(n));
  const max = numbers.length ? Math.max(...numbers) : 0;
  return `ASK-${String(max + 1).padStart(4, "0")}`;
}

module.exports = {
  AGENTS,
  ASK_STATUS,
  HANDOFF_STATUS,
  CLAIMS_HEADER,
  ASKS_HEADER,
  CONTRACTS_HEADER,
  parseFrontMatter,
  parseBoard,
  parseHandoff,
  sortHandoffs,
  other,
  pathsOverlap,
  detectClaimConflicts,
  lastHandoffOf,
  buildBrief,
  validate,
  buildDigest,
  nextAskId
};
