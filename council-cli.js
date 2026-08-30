#!/usr/bin/env node
"use strict";

// 议事厅命令行:两位 AI 与人共用的四个动作。
//   node council-cli.js brief  --agent claude   入场:我不在的时候发生了什么
//   node council-cli.js new    --agent claude --phase <slug> [--title "..."]  离场:开一份交班简报
//   node council-cli.js check                   体检:协议是否被写坏(CI 用)
//   node council-cli.js digest [--since D] [--until D] [--write]  定期:压成一页周报

const fs = require("node:fs");
const path = require("node:path");
const core = require("./council-core");

const ROOT = __dirname;
const COUNCIL_DIR = path.join(ROOT, "docs", "council");
const BOARD_FILE = path.join(COUNCIL_DIR, "BOARD.md");
const HANDOFF_DIR = path.join(COUNCIL_DIR, "handoffs");
const DIGEST_DIR = path.join(COUNCIL_DIR, "digests");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function loadBoard() {
  return core.parseBoard(fs.readFileSync(BOARD_FILE, "utf8"));
}

function loadHandoffs() {
  if (!fs.existsSync(HANDOFF_DIR)) return [];
  return fs
    .readdirSync(HANDOFF_DIR)
    .filter((name) => name.endsWith(".md") && name !== "TEMPLATE.md")
    .map((name) => core.parseHandoff(name, fs.readFileSync(path.join(HANDOFF_DIR, name), "utf8")));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function requireAgent(args) {
  const agent = args.agent || process.env.COUNCIL_AGENT;
  if (!core.AGENTS.includes(agent)) {
    throw new Error(`需要 --agent ${core.AGENTS.join(" 或 ")}`);
  }
  return agent;
}

function cmdBrief(args) {
  const agent = requireAgent(args);
  console.log(core.buildBrief({ agent, handoffs: loadHandoffs(), board: loadBoard() }));
}

function cmdNew(args) {
  const agent = requireAgent(args);
  const phase = String(args.phase || "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(phase)) {
    throw new Error("需要 --phase <小写短横线 slug>,例如 --phase focus-mode-v2");
  }
  const date = String(args.date || today());
  const file = path.join(HANDOFF_DIR, `${date}-${agent}-${phase}.md`);
  if (fs.existsSync(file)) throw new Error(`已存在:${path.relative(ROOT, file)}`);
  const title = String(args.title || phase);
  const template = fs.readFileSync(path.join(HANDOFF_DIR, "TEMPLATE.md"), "utf8");
  const content = template
    .replace(/__DATE__/g, date)
    .replace(/__AGENT__/g, agent)
    .replace(/__PHASE__/g, phase)
    .replace(/__TITLE__/g, title);
  fs.writeFileSync(file, content);
  console.log(path.relative(ROOT, file));
}

function cmdCheck() {
  const problems = [];
  let board = { claims: [], asks: [], contracts: [] };
  let handoffs = [];
  try {
    board = loadBoard();
  } catch (error) {
    problems.push(`BOARD.md: ${error.message}`);
  }
  try {
    handoffs = loadHandoffs();
  } catch (error) {
    problems.push(error.message);
  }
  problems.push(...core.validate({ handoffs, board }));
  if (problems.length) {
    console.error("议事厅协议体检未通过:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`议事厅协议体检通过(${handoffs.length} 份简报,${board.asks.length} 条请求)。`);
}

function cmdDigest(args) {
  const until = String(args.until || today());
  const since = args.since
    ? String(args.since)
    : new Date(Date.parse(`${until}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
  const text = core.buildDigest({
    handoffs: loadHandoffs(),
    board: loadBoard(),
    since,
    until
  });
  if (args.write) {
    fs.mkdirSync(DIGEST_DIR, { recursive: true });
    const file = path.join(DIGEST_DIR, `${until}.md`);
    fs.writeFileSync(file, `${text}\n`);
    console.log(path.relative(ROOT, file));
    return;
  }
  console.log(text);
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0] || "brief";
  const commands = { brief: cmdBrief, new: cmdNew, check: cmdCheck, digest: cmdDigest };
  const run = commands[command];
  if (!run) {
    console.error(`未知命令 ${command};可用:${Object.keys(commands).join(" / ")}`);
    process.exitCode = 1;
    return;
  }
  run(args);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    // SessionStart hook 会调用 brief:议事厅坏了不该让 AI 无法开工,只提示。
    console.error(`议事厅:${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs };
