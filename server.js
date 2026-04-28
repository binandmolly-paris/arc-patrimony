const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== PostgreSQL 数据库连接 =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ===== 数据库初始化 =====
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS holdings (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT,
      qty REAL NOT NULL DEFAULT 0,
      avg_cost REAL NOT NULL DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      market TEXT,
      region TEXT,
      attribute TEXT,
      sector TEXT,
      target_weight REAL DEFAULT 0,
      UNIQUE(user_id, symbol)
    );
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT,
      type TEXT NOT NULL,
      qty REAL NOT NULL,
      price REAL NOT NULL,
      fee REAL DEFAULT 0,
      date TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT,
      condition TEXT NOT NULL,
      price REAL NOT NULL,
      active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS portfolio_config (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      UNIQUE(user_id, key)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_used TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- ============ Phase 1 新增表：解锁 YTD/IRR + 为 Phase 2-4 财报/分析师/AI 做准备 ============

    -- 1. 每日组合快照（cron 每晚自动写入；30+ 天后可绘出真·YTD 曲线 / IRR / 最大回撤）
    CREATE TABLE IF NOT EXISTS daily_snapshot (
      user_id INTEGER NOT NULL,
      date DATE NOT NULL,
      total_value_usd NUMERIC(14,2),
      total_cost_usd NUMERIC(14,2),
      unrealized_pl_usd NUMERIC(14,2),
      realized_pl_usd NUMERIC(14,2),
      dividend_total_usd NUMERIC(14,2),
      cumulative_pl_usd NUMERIC(14,2),
      region_values JSONB,        -- {"美国": 583255, "中国": 608443, "日本": 149743}
      fx_rates JSONB,             -- {"CNY": 0.138, "JPY": 0.0067, "HKD": 0.128, "USD": 1}
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, date)
    );

    -- 2. 财报缓存（Phase 2 接 FMP 后写入；按 symbol + period_end + period_type 唯一）
    CREATE TABLE IF NOT EXISTS fundamentals (
      symbol TEXT NOT NULL,
      period_end DATE NOT NULL,
      period_type TEXT NOT NULL,  -- 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'FY'
      currency TEXT,
      revenue NUMERIC(18,2),
      gross_profit NUMERIC(18,2),
      operating_income NUMERIC(18,2),
      net_income NUMERIC(18,2),
      eps NUMERIC(10,4),
      free_cash_flow NUMERIC(18,2),
      total_assets NUMERIC(18,2),
      total_equity NUMERIC(18,2),
      total_debt NUMERIC(18,2),
      pe_ratio NUMERIC(8,2),
      pb_ratio NUMERIC(8,2),
      roe NUMERIC(8,4),
      roic NUMERIC(8,4),
      dividend_yield NUMERIC(8,4),
      payout_ratio NUMERIC(8,4),
      source TEXT,                -- 'FMP' | 'Tushare' | 'JQuants'
      fetched_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (symbol, period_end, period_type)
    );

    -- 3. 分析师一致预期（Phase 4 写入）
    CREATE TABLE IF NOT EXISTS analyst_estimates (
      symbol TEXT NOT NULL,
      period_end DATE NOT NULL,
      period_type TEXT NOT NULL,  -- 'FY+1' | 'FY+2' | 'Q+1' | 'Q+2'
      eps_estimate NUMERIC(10,4),
      revenue_estimate NUMERIC(18,2),
      num_analysts INTEGER,
      rating_buy INTEGER,
      rating_hold INTEGER,
      rating_sell INTEGER,
      target_price NUMERIC(10,2),
      source TEXT,
      fetched_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (symbol, period_end, period_type)
    );

    -- 4. 公司行动 / 财报日历
    CREATE TABLE IF NOT EXISTS corp_actions (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      type TEXT NOT NULL,         -- 'earnings' | 'dividend' | 'split' | 'spinoff'
      ex_date DATE,
      pay_date DATE,
      amount NUMERIC(12,4),
      details JSONB,
      source TEXT,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_corp_actions_sym_date ON corp_actions(symbol, ex_date DESC);
    CREATE INDEX IF NOT EXISTS idx_corp_actions_type_date ON corp_actions(type, ex_date DESC);

    -- 5. AI 决策派日报缓存（Phase 4 写入；每天最多 1 条 per user）
    CREATE TABLE IF NOT EXISTS ai_daily_summary (
      user_id INTEGER NOT NULL,
      date DATE NOT NULL,
      summary_md TEXT,            -- Markdown 内容
      signals JSONB,              -- 触发了哪些规则 (buy/trim/alert)
      model TEXT,                 -- 'claude-sonnet-4-5' 等
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      generated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, date)
    );

    -- 6. 历史锚定价格（用于 YTD / 季度 / 月度等周期收益计算）
    --    例：anchor_date='2025-12-31' 存上一年最后交易日收盘价（按市场本地时区）
    CREATE TABLE IF NOT EXISTS anchor_prices (
      symbol TEXT NOT NULL,
      anchor_date DATE NOT NULL,
      close_price REAL NOT NULL,
      currency TEXT,
      market_tz TEXT,             -- e.g. 'America/New_York'
      source TEXT DEFAULT 'Yahoo',
      fetched_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (symbol, anchor_date)
    );
    CREATE INDEX IF NOT EXISTS idx_anchor_prices_date ON anchor_prices(anchor_date);

    -- 7. Phase 2: 当前基本面数据快照（每只股票 1 行，定期从 FMP 刷新）
    --    与历史 fundamentals 表分开 — 那个按 period 存历史财报，这个存最新指标
    CREATE TABLE IF NOT EXISTS fundamentals_latest (
      symbol TEXT PRIMARY KEY,
      -- 来自 FMP profile
      company_name TEXT,
      sector TEXT,
      industry TEXT,
      country TEXT,
      currency TEXT,
      market_cap NUMERIC(20,2),
      beta NUMERIC(10,4),
      ceo TEXT,
      website TEXT,
      exchange TEXT,
      description TEXT,
      last_dividend NUMERIC(12,4),
      range_52w TEXT,
      day_change NUMERIC(12,4),
      day_change_pct NUMERIC(10,4),
      volume BIGINT,
      avg_volume BIGINT,
      employees INTEGER,
      -- 来自 FMP key-metrics-ttm / ratios-ttm
      pe_ratio NUMERIC(12,4),
      pb_ratio NUMERIC(12,4),
      ps_ratio NUMERIC(12,4),
      roe NUMERIC(10,4),
      roic NUMERIC(10,4),
      debt_to_equity NUMERIC(10,4),
      eps NUMERIC(12,4),
      dividend_yield NUMERIC(10,4),
      payout_ratio NUMERIC(10,4),
      -- 元数据
      source TEXT DEFAULT 'FMP',
      fetched_at TIMESTAMPTZ DEFAULT NOW(),
      raw_json JSONB              -- 保留原始 FMP 返回，未来需要新字段可直接读
    );
  `);

  // Phase 2.1: 扩充 fundamentals_latest 字段（向后兼容，老库自动 ADD COLUMN IF NOT EXISTS）
  await pool.query(`
    ALTER TABLE fundamentals_latest
      ADD COLUMN IF NOT EXISTS price NUMERIC(12,4),
      ADD COLUMN IF NOT EXISTS forward_pe NUMERIC(12,4),
      ADD COLUMN IF NOT EXISTS peg_ratio NUMERIC(12,4),
      ADD COLUMN IF NOT EXISTS current_ratio NUMERIC(10,4),
      ADD COLUMN IF NOT EXISTS gross_margin NUMERIC(10,4),
      ADD COLUMN IF NOT EXISTS operating_margin NUMERIC(10,4),
      ADD COLUMN IF NOT EXISTS net_margin NUMERIC(10,4),
      ADD COLUMN IF NOT EXISTS year_high NUMERIC(12,4),
      ADD COLUMN IF NOT EXISTS year_low NUMERIC(12,4),
      ADD COLUMN IF NOT EXISTS shares_out NUMERIC(20,2),
      ADD COLUMN IF NOT EXISTS price_avg_50 NUMERIC(12,4),
      ADD COLUMN IF NOT EXISTS price_avg_200 NUMERIC(12,4),
      ADD COLUMN IF NOT EXISTS field_sources JSONB,
      ADD COLUMN IF NOT EXISTS discrepancies JSONB
  `);

  console.log("✅ 数据库表已就绪（Phase 2.3：含双源交叉检查字段）");
}

// ===== 自动初始化 LiuBin 用户 =====
async function autoSeed() {
  const { rows } = await pool.query("SELECT COUNT(*) as c FROM users");
  if (parseInt(rows[0].c) > 0) {
    console.log("数据库已有用户，跳过初始化");
    return;
  }
  console.log("首次启动，自动初始化 LiuBin 用户...");
  const pw = bcrypt.hashSync("Xile142130", 10);
  const userRes = await pool.query("INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id", ["LIUBIN", pw]);
  const uid = userRes.rows[0].id;

  const holdings = [
    {s:"0700.HK",n:"腾讯控股",q:1600,c:514.36,cur:"HKD",m:"香港",r:"中国",a:"进攻",sec:"科技"},
    {s:"300750.SZ",n:"宁德时代",q:1000,c:353.26,cur:"CNY",m:"深圳",r:"中国",a:"进攻",sec:"新能源"},
    {s:"1211.HK",n:"比亚迪股份",q:500,c:102.28,cur:"HKD",m:"香港",r:"中国",a:"进攻",sec:"汽车"},
    {s:"1810.HK",n:"小米集团",q:4000,c:33.22,cur:"HKD",m:"香港",r:"中国",a:"进攻",sec:"科技"},
    {s:"9992.HK",n:"泡泡玛特",q:200,c:147.57,cur:"HKD",m:"香港",r:"中国",a:"进攻",sec:"消费"},
    {s:"300760.SZ",n:"迈瑞医疗",q:1200,c:160.65,cur:"CNY",m:"深圳",r:"中国",a:"进攻",sec:"医疗"},
    {s:"600036.SS",n:"招商银行",q:13300,c:38.60,cur:"CNY",m:"上海",r:"中国",a:"防守",sec:"金融"},
    {s:"PDD",n:"拼多多",q:510,c:99.56,cur:"USD",m:"纳斯达克",r:"中国",a:"进攻/防守",sec:"电商"},
    {s:"TCOM",n:"携程集团",q:500,c:55.09,cur:"USD",m:"纳斯达克",r:"中国",a:"进攻",sec:"旅游"},
    {s:"BABA",n:"阿里巴巴",q:100,c:125.08,cur:"USD",m:"纽约",r:"中国",a:"进攻",sec:"科技"},
    {s:"7203.T",n:"丰田汽车",q:200,c:3190,cur:"JPY",m:"东京",r:"日本",a:"进攻",sec:"汽车"},
    {s:"6501.T",n:"日立制作所",q:200,c:4447,cur:"JPY",m:"东京",r:"日本",a:"进攻",sec:"电子"},
    {s:"8035.T",n:"东京电子",q:100,c:37510,cur:"JPY",m:"东京",r:"日本",a:"进攻",sec:"半导体"},
    {s:"4063.T",n:"信越化学",q:200,c:6040,cur:"JPY",m:"东京",r:"日本",a:"进攻",sec:"化学"},
    {s:"8306.T",n:"三菱日联金融集团",q:1300,c:2603,cur:"JPY",m:"东京",r:"日本",a:"防守",sec:"金融"},
    {s:"8001.T",n:"伊藤忠商事",q:1200,c:2030,cur:"JPY",m:"东京",r:"日本",a:"防守",sec:"贸易"},
    {s:"8058.T",n:"三菱商事",q:500,c:5476,cur:"JPY",m:"东京",r:"日本",a:"防守",sec:"贸易"},
    {s:"8766.T",n:"东京海上",q:200,c:7191,cur:"JPY",m:"东京",r:"日本",a:"防守",sec:"保险"},
    {s:"8316.T",n:"三井住友金融",q:200,c:5015,cur:"JPY",m:"东京",r:"日本",a:"防守",sec:"金融"},
    {s:"8031.T",n:"三井物产",q:300,c:6280,cur:"JPY",m:"东京",r:"日本",a:"防守",sec:"贸易"},
    {s:"8053.T",n:"住友商事",q:100,c:5734,cur:"JPY",m:"东京",r:"日本",a:"防守",sec:"贸易"},
    {s:"8002.T",n:"丸红",q:500,c:5413,cur:"JPY",m:"东京",r:"日本",a:"防守",sec:"贸易"},
    {s:"MSFT",n:"微软",q:250,c:435.10,cur:"USD",m:"纳斯达克",r:"美国",a:"进攻",sec:"科技"},
    {s:"GOOGL",n:"谷歌",q:109,c:300.87,cur:"USD",m:"纳斯达克",r:"美国",a:"进攻",sec:"科技"},
    {s:"NVDA",n:"英伟达",q:300,c:186.35,cur:"USD",m:"纳斯达克",r:"美国",a:"进攻",sec:"半导体"},
    {s:"AAPL",n:"苹果",q:100,c:255.08,cur:"USD",m:"纳斯达克",r:"美国",a:"进攻",sec:"科技"},
    {s:"AMZN",n:"亚马逊",q:150,c:226.44,cur:"USD",m:"纳斯达克",r:"美国",a:"进攻",sec:"科技"},
    {s:"AVGO",n:"博通",q:100,c:291.41,cur:"USD",m:"纳斯达克",r:"美国",a:"进攻",sec:"半导体"},
    {s:"INTC",n:"英特尔",q:300,c:44.53,cur:"USD",m:"纳斯达克",r:"美国",a:"择时出货",sec:"半导体"},
    {s:"TSM",n:"台积电",q:100,c:314.66,cur:"USD",m:"纽约",r:"美国",a:"进攻",sec:"半导体"},
    {s:"MU",n:"美光",q:160,c:348.91,cur:"USD",m:"纳斯达克",r:"美国",a:"择时出货",sec:"半导体"},
    {s:"NFLX",n:"Netflix",q:50,c:81.16,cur:"USD",m:"纳斯达克",r:"美国",a:"持有",sec:"流媒体"},
    {s:"PLTR",n:"Palantir",q:150,c:138.64,cur:"USD",m:"纳斯达克",r:"美国",a:"进攻",sec:"AI/数据"},
    {s:"PANW",n:"Palo Alto",q:50,c:172.66,cur:"USD",m:"纳斯达克",r:"美国",a:"进攻",sec:"网络安全"},
    {s:"BRK-B",n:"伯克希尔哈撒韦",q:100,c:467.68,cur:"USD",m:"纽约",r:"美国",a:"防守",sec:"金融"},
    {s:"V",n:"Visa",q:100,c:296.08,cur:"USD",m:"纽约",r:"美国",a:"防守",sec:"金融"},
    {s:"UNH",n:"联合健康",q:100,c:256.58,cur:"USD",m:"纽约",r:"美国",a:"防守",sec:"医疗"},
  ];

  const today = new Date().toISOString().slice(0, 10);
  for (const h of holdings) {
    await pool.query(
      `INSERT INTO holdings (user_id,symbol,name,qty,avg_cost,currency,market,region,attribute,sector)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [uid, h.s, h.n, h.q, h.c, h.cur, h.m, h.r, h.a, h.sec]
    );
    await pool.query(
      `INSERT INTO trades (user_id,symbol,name,type,qty,price,fee,date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uid, h.s, h.n, "买入", h.q, h.c, 0, today]
    );
  }
  console.log("✅ 自动初始化完成: LiuBin + " + holdings.length + " 只股票");
}

// ===== Session 管理（DB 持久化 + 内存缓存）=====
// Token 30 天有效；DB 持久化保证 Render 重启后会话不丢失
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const sessionCache = new Map(); // token -> { userId, lastUsed }

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO sessions (token, user_id) VALUES ($1, $2)",
    [token, userId]
  );
  sessionCache.set(token, { userId, lastUsed: Date.now() });
  return token;
}

async function destroySession(token) {
  if (!token) return;
  sessionCache.delete(token);
  try { await pool.query("DELETE FROM sessions WHERE token=$1", [token]); } catch(e) {}
}

async function destroySessionsForUser(userId, exceptToken) {
  for (const [tk, info] of sessionCache.entries()) {
    if (info.userId === userId && tk !== exceptToken) sessionCache.delete(tk);
  }
  try {
    if (exceptToken) {
      await pool.query("DELETE FROM sessions WHERE user_id=$1 AND token<>$2", [userId, exceptToken]);
    } else {
      await pool.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
    }
  } catch(e) { console.error("destroySessionsForUser error:", e.message); }
}

async function auth(req, res, next) {
  const token = req.headers["x-token"];
  if (!token) return res.status(401).json({ error: "请先登录" });

  const cached = sessionCache.get(token);
  if (cached) {
    req.userId = cached.userId;
    cached.lastUsed = Date.now();
    return next();
  }

  try {
    const r = await pool.query("SELECT user_id, created_at FROM sessions WHERE token=$1", [token]);
    if (r.rows.length === 0) return res.status(401).json({ error: "请先登录" });
    const ageMs = Date.now() - new Date(r.rows[0].created_at).getTime();
    if (ageMs > SESSION_TTL_MS) {
      await destroySession(token);
      return res.status(401).json({ error: "登录已过期，请重新登录" });
    }
    sessionCache.set(token, { userId: r.rows[0].user_id, lastUsed: Date.now() });
    req.userId = r.rows[0].user_id;
    pool.query("UPDATE sessions SET last_used=NOW() WHERE token=$1", [token]).catch(() => {});
    next();
  } catch (e) {
    console.error("Auth error:", e.message);
    return res.status(500).json({ error: "认证服务异常" });
  }
}

// ===== 用户认证 =====
app.post("/api/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "请输入用户名和密码" });
    if (password.length < 4) return res.status(400).json({ error: "密码至少4位" });
    const existing = await pool.query("SELECT id FROM users WHERE username=$1", [username]);
    if (existing.rows.length > 0) return res.status(400).json({ error: "用户名已存在" });
    const hash = bcrypt.hashSync(password, 10);
    const result = await pool.query("INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id", [username, hash]);
    const token = await createSession(result.rows[0].id);
    res.json({ token, username, userId: result.rows[0].id });
  } catch (e) {
    console.error("Register error:", e.message);
    res.status(500).json({ error: "注册失败" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
    if (result.rows.length === 0) return res.status(400).json({ error: "用户不存在" });
    const user = result.rows[0];
    if (!bcrypt.compareSync(password, user.password)) return res.status(400).json({ error: "密码错误" });
    const token = await createSession(user.id);
    res.json({ token, username: user.username, userId: user.id });
  } catch (e) {
    console.error("Login error:", e.message);
    res.status(500).json({ error: "登录失败" });
  }
});

app.get("/api/verify", async (req, res) => {
  const token = req.headers["x-token"];
  if (!token) return res.json({ valid: false });
  if (sessionCache.has(token)) return res.json({ valid: true });
  try {
    const r = await pool.query("SELECT user_id, created_at FROM sessions WHERE token=$1", [token]);
    if (r.rows.length === 0) return res.json({ valid: false });
    const ageMs = Date.now() - new Date(r.rows[0].created_at).getTime();
    if (ageMs > SESSION_TTL_MS) { await destroySession(token); return res.json({ valid: false }); }
    sessionCache.set(token, { userId: r.rows[0].user_id, lastUsed: Date.now() });
    res.json({ valid: true });
  } catch (e) {
    console.error("Verify error:", e.message);
    res.json({ valid: false });
  }
});

app.post("/api/logout", async (req, res) => {
  const token = req.headers["x-token"];
  await destroySession(token);
  res.json({ ok: true });
});

app.post("/api/change-password", auth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ error: "请输入旧密码和新密码" });
    if (newPassword.length < 4) return res.status(400).json({ error: "新密码至少4位" });
    const result = await pool.query("SELECT * FROM users WHERE id=$1", [req.userId]);
    if (result.rows.length === 0) return res.status(400).json({ error: "用户不存在" });
    const user = result.rows[0];
    if (!bcrypt.compareSync(oldPassword, user.password)) return res.status(400).json({ error: "旧密码错误" });
    const hash = bcrypt.hashSync(newPassword, 10);
    const upd = await pool.query("UPDATE users SET password=$1 WHERE id=$2", [hash, req.userId]);
    if (upd.rowCount === 0) return res.status(500).json({ error: "密码更新失败" });
    // Verify the update actually persisted
    const updated = await pool.query("SELECT password FROM users WHERE id=$1", [req.userId]);
    if (!bcrypt.compareSync(newPassword, updated.rows[0].password)) {
      return res.status(500).json({ error: "密码验证失败，请重试" });
    }
    // Invalidate all sessions for this user so they must re-login with new password
    const currentToken = req.headers["x-token"];
    await destroySessionsForUser(req.userId, currentToken);
    console.log("✅ 用户 " + user.username + " 密码已成功修改");
    res.json({ ok: true, message: "密码修改成功" });
  } catch (e) {
    console.error("Change password error:", e.message);
    res.status(500).json({ error: "密码修改失败" });
  }
});

// ===== 持仓目标权重 =====
app.get("/api/portfolio-config", auth, async (req, res) => {
  try {
    const result = await pool.query("SELECT key, value FROM portfolio_config WHERE user_id=$1", [req.userId]);
    const config = {};
    result.rows.forEach(r => config[r.key] = r.value);
    res.json(config);
  } catch (e) {
    console.error("Portfolio config error:", e.message);
    res.status(500).json({ error: "获取配置失败" });
  }
});

app.post("/api/portfolio-config", auth, async (req, res) => {
  try {
    const { key, value } = req.body;
    await pool.query(
      `INSERT INTO portfolio_config (user_id,key,value) VALUES ($1,$2,$3)
       ON CONFLICT(user_id,key) DO UPDATE SET value=EXCLUDED.value`,
      [req.userId, key, value]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("Portfolio config save error:", e.message);
    res.status(500).json({ error: "保存配置失败" });
  }
});

app.post("/api/holdings/target-weight", auth, async (req, res) => {
  try {
    const { symbol, target_weight } = req.body;
    await pool.query("UPDATE holdings SET target_weight=$1 WHERE user_id=$2 AND symbol=$3", [target_weight || 0, req.userId, symbol]);
    res.json({ ok: true });
  } catch (e) {
    console.error("Target weight error:", e.message);
    res.status(500).json({ error: "更新失败" });
  }
});

// ===== 持仓 =====
app.get("/api/holdings", auth, async (req, res) => {
  try {
    const holdResult = await pool.query("SELECT * FROM holdings WHERE user_id=$1 ORDER BY id", [req.userId]);
    const tradeResult = await pool.query("SELECT * FROM trades WHERE user_id=$1 ORDER BY date, id", [req.userId]);
    // Calculate realized P&L and dividends from trade history
    const sellInfo = {};
    const dividendInfo = {};
    tradeResult.rows.forEach(t => {
      const isBuy = t.type === '买入' || t.type === 'BUY';
      const isDividend = t.type === '分红' || t.type === 'DIVIDEND';
      if (isDividend) {
        if (!dividendInfo[t.symbol]) dividendInfo[t.symbol] = 0;
        dividendInfo[t.symbol] += t.price * t.qty; // price=每股分红, qty=股数
      } else if (!isBuy) {
        if (!sellInfo[t.symbol]) sellInfo[t.symbol] = { amount: 0, qty: 0 };
        sellInfo[t.symbol].amount += t.price * t.qty;
        sellInfo[t.symbol].qty += t.qty;
      }
    });
    const enriched = holdResult.rows.map(r => {
      const si = sellInfo[r.symbol];
      let realized_pl = 0, realized_cost = 0;
      if (si && si.qty > 0) {
        realized_cost = r.avg_cost * si.qty;
        realized_pl = si.amount - realized_cost;
      }
      const dividend_total = dividendInfo[r.symbol] || 0;
      return { ...r, realized_pl, realized_cost, dividend_total };
    });
    res.json(enriched);
  } catch (e) {
    console.error("Holdings error:", e.message);
    res.status(500).json({ error: "获取持仓失败" });
  }
});

app.post("/api/holdings", auth, async (req, res) => {
  try {
    const { symbol, name, qty, avg_cost, currency, market, region, attribute, sector } = req.body;
    await pool.query(
      `INSERT INTO holdings (user_id,symbol,name,qty,avg_cost,currency,market,region,attribute,sector)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(user_id,symbol) DO UPDATE SET
       name=EXCLUDED.name, qty=EXCLUDED.qty, avg_cost=EXCLUDED.avg_cost, currency=EXCLUDED.currency,
       market=EXCLUDED.market, region=EXCLUDED.region, attribute=EXCLUDED.attribute, sector=EXCLUDED.sector`,
      [req.userId, symbol, name, qty, avg_cost, currency || "USD", market, region, attribute, sector]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("Holdings save error:", e.message);
    res.status(500).json({ error: "保存持仓失败" });
  }
});

// ===== 交易 =====
app.get("/api/trades", auth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM trades WHERE user_id=$1 ORDER BY date DESC, id DESC", [req.userId]);
    res.json(result.rows);
  } catch (e) {
    console.error("Trades error:", e.message);
    res.status(500).json({ error: "获取交易失败" });
  }
});

app.post("/api/trade", auth, async (req, res) => {
  try {
    const { symbol, name, type, qty, price, fee, date, currency, market, region, attribute, sector } = req.body;
    if (!symbol || !qty || !price || !type || !date) return res.status(400).json({ error: "请填写完整信息" });

    await pool.query(
      "INSERT INTO trades (user_id,symbol,name,type,qty,price,fee,date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [req.userId, symbol, name || "", type, qty, price, fee || 0, date]
    );

    // 更新持仓
    const hResult = await pool.query("SELECT * FROM holdings WHERE user_id=$1 AND symbol=$2", [req.userId, symbol]);
    const h = hResult.rows.length > 0 ? hResult.rows[0] : null;

    if (type === "分红") {
      // 分红不影响持仓数量，仅记录
      res.json({ ok: true });
      return;
    } else if (type === "买入") {
      if (h) {
        const totalQty = h.qty + qty;
        const newAvg = (h.qty * h.avg_cost + qty * price) / totalQty;
        await pool.query("UPDATE holdings SET qty=$1, avg_cost=$2 WHERE id=$3", [totalQty, Math.round(newAvg * 100) / 100, h.id]);
      } else {
        await pool.query(
          `INSERT INTO holdings (user_id,symbol,name,qty,avg_cost,currency,market,region,attribute,sector)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [req.userId, symbol, name || "", qty, price, currency || "USD", market || "", region || "", attribute || "", sector || ""]
        );
      }
    } else if (type === "卖出") {
      if (h) {
        const remain = h.qty - qty;
        if (remain <= 0) await pool.query("UPDATE holdings SET qty=0 WHERE id=$1", [h.id]);
        else await pool.query("UPDATE holdings SET qty=$1 WHERE id=$2", [remain, h.id]);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Trade error:", e.message);
    res.status(500).json({ error: "交易保存失败" });
  }
});

// Recompute a holding's qty + avg_cost from full trade history (chronological).
// Used after deleting a trade to keep holdings consistent.
async function recomputeHoldingFromTrades(userId, symbol) {
  const tr = await pool.query(
    "SELECT type, qty, price FROM trades WHERE user_id=$1 AND symbol=$2 ORDER BY date, id",
    [userId, symbol]
  );
  let qty = 0, avgCost = 0;
  for (const t of tr.rows) {
    if (t.type === "分红" || t.type === "DIVIDEND") continue;
    if (t.type === "买入" || t.type === "BUY") {
      const newQty = qty + t.qty;
      avgCost = newQty > 0 ? (qty * avgCost + t.qty * t.price) / newQty : 0;
      qty = newQty;
    } else { // 卖出
      qty = Math.max(0, qty - t.qty);
      // avgCost unchanged on sells (moving weighted-avg method)
      if (qty === 0) avgCost = avgCost; // keep last avg_cost so realized PL on prior sells stays valid
    }
  }
  // Round avg_cost
  avgCost = Math.round(avgCost * 100) / 100;
  // Update if a holding row exists (preserving metadata)
  const h = await pool.query("SELECT id FROM holdings WHERE user_id=$1 AND symbol=$2", [userId, symbol]);
  if (h.rows.length > 0) {
    await pool.query("UPDATE holdings SET qty=$1, avg_cost=$2 WHERE id=$3", [qty, avgCost, h.rows[0].id]);
  }
  return { qty, avg_cost: avgCost, tradesRemaining: tr.rows.length };
}

app.delete("/api/trade/:id", auth, async (req, res) => {
  try {
    const tradeId = parseInt(req.params.id);
    if (!tradeId) return res.status(400).json({ error: "Invalid trade id" });

    // Look up the trade first (must belong to this user)
    const lookup = await pool.query(
      "SELECT symbol FROM trades WHERE id=$1 AND user_id=$2",
      [tradeId, req.userId]
    );
    if (lookup.rows.length === 0) return res.status(404).json({ error: "Trade not found" });
    const symbol = lookup.rows[0].symbol;

    // Delete the trade
    await pool.query("DELETE FROM trades WHERE id=$1 AND user_id=$2", [tradeId, req.userId]);

    // Recompute that symbol's holding from remaining trade history
    const result = await recomputeHoldingFromTrades(req.userId, symbol);

    // If the symbol has no buy/sell trades left at all, remove the holding row
    const remainingNonDiv = await pool.query(
      "SELECT COUNT(*)::int AS c FROM trades WHERE user_id=$1 AND symbol=$2 AND type NOT IN ('分红','DIVIDEND')",
      [req.userId, symbol]
    );
    if (remainingNonDiv.rows[0].c === 0) {
      await pool.query("DELETE FROM holdings WHERE user_id=$1 AND symbol=$2", [req.userId, symbol]);
    }

    console.log(`✅ Trade ${tradeId} (${symbol}) deleted; holding recomputed: qty=${result.qty}, avg=${result.avg_cost}`);
    res.json({ ok: true, recomputed: result });
  } catch (e) {
    console.error("Delete trade error:", e.message);
    res.status(500).json({ error: "删除交易失败" });
  }
});

// ===== 提醒 =====
app.get("/api/alerts", auth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM alerts WHERE user_id=$1", [req.userId]);
    res.json(result.rows);
  } catch (e) {
    console.error("Alerts error:", e.message);
    res.status(500).json({ error: "获取提醒失败" });
  }
});

app.post("/api/alert", auth, async (req, res) => {
  try {
    const { symbol, name, condition, price } = req.body;
    await pool.query(
      "INSERT INTO alerts (user_id,symbol,name,condition,price) VALUES ($1,$2,$3,$4,$5)",
      [req.userId, symbol, name || "", condition, price]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("Alert save error:", e.message);
    res.status(500).json({ error: "保存提醒失败" });
  }
});

app.put("/api/alert/:id", auth, async (req, res) => {
  try {
    const { active } = req.body;
    await pool.query("UPDATE alerts SET active=$1 WHERE id=$2 AND user_id=$3", [active ? 1 : 0, req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (e) {
    console.error("Alert update error:", e.message);
    res.status(500).json({ error: "更新提醒失败" });
  }
});

// 批量导入提醒
app.post("/api/import-alerts", auth, async (req, res) => {
  try {
    const { alerts: list } = req.body;
    if (!Array.isArray(list)) return res.status(400).json({ error: "数据格式错误" });
    // Clear existing alerts for user first
    await pool.query("DELETE FROM alerts WHERE user_id=$1", [req.userId]);
    for (const a of list) {
      await pool.query(
        "INSERT INTO alerts (user_id,symbol,name,condition,price) VALUES ($1,$2,$3,$4,$5)",
        [req.userId, a.symbol, a.name || "", a.condition || "低于", a.price]
      );
    }
    res.json({ ok: true, count: list.length });
  } catch (e) {
    console.error("Import alerts error:", e.message);
    res.status(500).json({ error: "导入提醒失败" });
  }
});

app.delete("/api/alert/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM alerts WHERE id=$1 AND user_id=$2", [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (e) {
    console.error("Alert delete error:", e.message);
    res.status(500).json({ error: "删除提醒失败" });
  }
});

// ===== 股票查询 (单个股票实时信息) =====
app.get("/api/stock-lookup", async (req, res) => {
  const symbol = (req.query.symbol || "").trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: "请提供股票代码" });
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) return res.json({ found: false });
    const json = await resp.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) return res.json({ found: false });
    const exch = (meta.exchangeName || "").toUpperCase();
    let region = "美国", currency = meta.currency || "USD";
    if (exch.includes("HKG") || exch.includes("HONG KONG") || symbol.endsWith(".HK")) { region = "中国"; currency = "HKD"; }
    else if (exch.includes("TYO") || exch.includes("JPX") || exch.includes("TOKYO") || symbol.endsWith(".T")) { region = "日本"; currency = "JPY"; }
    else if (exch.includes("SHH") || exch.includes("SHANGHAI") || symbol.endsWith(".SS")) { region = "中国"; currency = "CNY"; }
    else if (exch.includes("SHZ") || exch.includes("SHENZHEN") || symbol.endsWith(".SZ")) { region = "中国"; currency = "CNY"; }
    res.json({
      found: true,
      symbol: meta.symbol || symbol,
      name: meta.shortName || meta.longName || symbol,
      price: meta.regularMarketPrice || 0,
      currency: currency,
      region: region,
      exchange: meta.exchangeName || ""
    });
  } catch (e) {
    console.error("Stock lookup error:", e.message);
    res.json({ found: false, error: e.message });
  }
});

// ===== 实时股价 (Yahoo Finance v8 API) =====
const priceCache = {};
const CACHE_TTL = 30000;

async function fetchYahooQuotes(symbols) {
  const results = {};
  for (const sym of symbols) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`;
      const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!resp.ok) continue;
      const json = await resp.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (meta) {
        results[sym] = {
          price: meta.regularMarketPrice || 0,
          prevClose: meta.chartPreviousClose || meta.previousClose || 0,
          change: meta.chartPreviousClose ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100) : 0,
          currency: meta.currency || "USD",
          name: sym,
          market: meta.exchangeName || "",
          // ★ Capture market session time + timezone (used by client to match per-market "today")
          regularMarketTime: meta.regularMarketTime || 0,  // unix seconds of last regular price
          exchangeTimezoneName: meta.exchangeTimezoneName || "",  // e.g. "America/New_York", "Asia/Shanghai"
          gmtoffset: meta.gmtoffset || 0,  // seconds
        };
      }
    } catch (e) {
      console.error("Yahoo fetch error for", sym, e.message);
    }
  }
  return results;
}

app.get("/api/prices", async (req, res) => {
  const symbols = (req.query.symbols || "").split(",").filter(Boolean);
  if (!symbols.length) return res.json({});

  const results = {};
  const toFetch = [];

  symbols.forEach(s => {
    if (priceCache[s] && Date.now() - priceCache[s].ts < CACHE_TTL) {
      results[s] = priceCache[s].data;
    } else {
      toFetch.push(s);
    }
  });

  if (toFetch.length > 0) {
    try {
      const fetched = await fetchYahooQuotes(toFetch);
      Object.entries(fetched).forEach(([sym, data]) => {
        priceCache[sym] = { data, ts: Date.now() };
        results[sym] = data;
      });
    } catch (err) {
      console.error("Yahoo Finance error:", err.message);
    }
  }

  res.json(results);
});

// ===== 批量导入持仓 =====
app.post("/api/import-holdings", auth, async (req, res) => {
  try {
    const { holdings: list } = req.body;
    if (!Array.isArray(list)) return res.status(400).json({ error: "数据格式错误" });

    for (const h of list) {
      await pool.query(
        `INSERT INTO holdings (user_id,symbol,name,qty,avg_cost,currency,market,region,attribute,sector)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(user_id,symbol) DO UPDATE SET
         name=EXCLUDED.name, qty=EXCLUDED.qty, avg_cost=EXCLUDED.avg_cost, currency=EXCLUDED.currency,
         market=EXCLUDED.market, region=EXCLUDED.region, attribute=EXCLUDED.attribute, sector=EXCLUDED.sector`,
        [req.userId, h.symbol, h.name || "", h.qty || 0, h.avg_cost || 0,
         h.currency || "USD", h.market || "", h.region || "", h.attribute || "", h.sector || ""]
      );
    }
    res.json({ ok: true, count: list.length });
  } catch (e) {
    console.error("Import error:", e.message);
    res.status(500).json({ error: "导入失败" });
  }
});

// ===== 数据导出 =====
// v2: 含已清仓股票 + portfolio_config + target_weight + trade.id
app.get("/api/export", auth, async (req, res) => {
  try {
    // 1) 全部 holdings（包括 qty=0 已清仓的）+ target_weight
    const holdRes = await pool.query(
      `SELECT id, symbol, name, qty, avg_cost, currency, market, region, attribute, sector, target_weight
       FROM holdings WHERE user_id=$1 ORDER BY id`,
      [req.userId]
    );
    const holdings = holdRes.rows.map(h => ({ ...h, is_sold: !(h.qty > 0) }));

    // 2) 全部 trades（含 id 便于追溯）
    const tradeRes = await pool.query(
      `SELECT id, symbol, name, type, qty, price, fee, date, created_at
       FROM trades WHERE user_id=$1 ORDER BY date, id`,
      [req.userId]
    );

    // 3) Alerts
    const alertRes = await pool.query(
      `SELECT id, symbol, name, condition, price, active
       FROM alerts WHERE user_id=$1 ORDER BY id`,
      [req.userId]
    );

    // 4) Portfolio config（含三地区本币预算等）
    const configRes = await pool.query(
      `SELECT key, value FROM portfolio_config WHERE user_id=$1`,
      [req.userId]
    );
    const portfolio_config = {};
    configRes.rows.forEach(r => { portfolio_config[r.key] = r.value; });

    // 5) Daily snapshots（如果有 — Phase 1 cron 启动后才会有数据）
    const snapRes = await pool.query(
      `SELECT date, total_value_usd, total_cost_usd, unrealized_pl_usd, realized_pl_usd,
              dividend_total_usd, cumulative_pl_usd, region_values, fx_rates
       FROM daily_snapshot WHERE user_id=$1 ORDER BY date`,
      [req.userId]
    );

    res.json({
      version: 2,
      exported_at: new Date().toISOString(),
      user_id: req.userId,
      holdings,                    // 含 qty=0 + target_weight + is_sold 标记
      trades: tradeRes.rows,       // 含 id + created_at
      alerts: alertRes.rows,
      portfolio_config,            // budget_中国 / budget_日本 / budget_美国 / totalBudget 等
      daily_snapshots: snapRes.rows,  // 30+ 天数据后才有内容
      counts: {
        holdings_active: holdings.filter(h => !h.is_sold).length,
        holdings_sold: holdings.filter(h => h.is_sold).length,
        trades: tradeRes.rows.length,
        alerts: alertRes.rows.length,
        snapshots: snapRes.rows.length,
        config_keys: Object.keys(portfolio_config).length,
      },
    });
  } catch (e) {
    console.error("Export error:", e.message);
    res.status(500).json({ error: "导出失败" });
  }
});

// ===== 实时汇率 =====
const fxRates = { JPY: 0.0067, CNY: 0.138, USD: 1, HKD: 0.128 };
const fxPairs = ['JPYUSD=X', 'CNYUSD=X', 'HKDUSD=X'];

async function fetchFXRates() {
  for (const pair of fxPairs) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${pair}?range=1d&interval=1d`;
      const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!resp.ok) continue;
      const json = await resp.json();
      const rate = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (rate && rate > 0) {
        const cur = pair.substring(0, 3);
        fxRates[cur] = rate;
        console.log(`汇率更新: 1 ${cur} = ${rate} USD`);
      }
    } catch (e) {
      console.error("FX fetch error for", pair, e.message);
    }
  }
}

// Fetch on startup and every 10 minutes
fetchFXRates();
setInterval(fetchFXRates, 10 * 60 * 1000);

app.get("/api/fx-rates", (req, res) => {
  res.json(fxRates);
});

// ============================================================
// Phase 2: FMP (Financial Modeling Prep) 基本面集成
// ============================================================

const FMP_BASE = 'https://financialmodelingprep.com/stable';

// 通用 FMP 请求函数
async function fetchFMP(endpoint, params = {}) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) throw new Error('FMP_API_KEY not configured');
  const qs = new URLSearchParams({ ...params, apikey: apiKey });
  const url = `${FMP_BASE}/${endpoint}?${qs}`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'ArcPatrimony/1.0' } });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`FMP ${endpoint} HTTP ${resp.status}: ${txt.slice(0, 150)}`);
  }
  return resp.json();
}

// 小工具：把多个候选字段的第一个非空值取出来
const pick = (obj, ...keys) => {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
};

// 拉取一只股票的全部基本面数据（合并多个 endpoint）
// Phase 2.1: 新增 quote / analyst-estimates，扩充 12 个字段名 fallback，缺失时计算式补救
async function fetchFMPFundamentals(symbol) {
  const result = {
    symbol,
    source: 'FMP',
    raw_json: {}
  };

  // 1) profile — 公司基础信息 + 估值锚（marketCap, beta）
  try {
    const profile = await fetchFMP('profile', { symbol });
    if (Array.isArray(profile) && profile.length > 0) {
      const p = profile[0];
      result.raw_json.profile = p;
      Object.assign(result, {
        company_name: pick(p, 'companyName', 'name'),
        sector: p.sector || null,
        industry: p.industry || null,
        country: p.country || null,
        currency: p.currency || null,
        market_cap: pick(p, 'marketCap', 'mktCap'),
        beta: p.beta || null,
        ceo: p.ceo || null,
        website: p.website || null,
        exchange: pick(p, 'exchange', 'exchangeShortName'),
        description: p.description ? p.description.slice(0, 2000) : null,
        last_dividend: pick(p, 'lastDividend', 'lastDiv'),
        range_52w: p.range || null,
        day_change: p.change || null,
        day_change_pct: pick(p, 'changePercentage', 'changesPercentage'),
        volume: p.volume || null,
        avg_volume: pick(p, 'averageVolume', 'volAvg'),
        employees: parseInt(p.fullTimeEmployees) || null,
        price: pick(p, 'price'),  // 备用价格
      });
    }
  } catch (e) {
    console.warn(`FMP profile failed for ${symbol}:`, e.message);
  }

  // 2) quote — 最可靠的 PE / EPS / Market Cap / 52W / 均价（Free 档普遍覆盖）
  try {
    const q = await fetchFMP('quote', { symbol });
    if (Array.isArray(q) && q.length > 0) {
      const x = q[0];
      result.raw_json.quote = x;
      // quote 给出的字段优先级最高（直接来自 FMP 报价，最准确）
      result.pe_ratio       = pick(x, 'pe', 'peRatio') ?? result.pe_ratio;
      result.eps            = pick(x, 'eps', 'epsTTM')  ?? result.eps;
      result.market_cap     = pick(x, 'marketCap')      ?? result.market_cap;
      result.year_high      = pick(x, 'yearHigh');
      result.year_low       = pick(x, 'yearLow');
      result.shares_out     = pick(x, 'sharesOutstanding');
      result.price_avg_50   = pick(x, 'priceAvg50');
      result.price_avg_200  = pick(x, 'priceAvg200');
      result.price          = pick(x, 'price') ?? result.price;
      result.day_change     = pick(x, 'change')              ?? result.day_change;
      result.day_change_pct = pick(x, 'changesPercentage', 'changePercentage') ?? result.day_change_pct;
      result.volume         = pick(x, 'volume')              ?? result.volume;
      result.avg_volume     = pick(x, 'avgVolume', 'averageVolume') ?? result.avg_volume;
    }
  } catch (e) {
    console.warn(`FMP quote failed for ${symbol}:`, e.message);
  }

  // 3) key-metrics-ttm — PE / PB / PS / ROE / ROIC / Debt / Current Ratio / Margins / PEG
  try {
    const km = await fetchFMP('key-metrics-ttm', { symbol });
    if (Array.isArray(km) && km.length > 0) {
      const m = km[0];
      result.raw_json.key_metrics = m;
      // 字段名 fallback 大全（FMP 不同版本/计划字段名差异较大）
      result.pe_ratio        = result.pe_ratio        ?? pick(m, 'peRatioTTM', 'peRatio', 'priceEarningsRatioTTM', 'priceEarningsRatio', 'priceToEarningsRatioTTM');
      result.pb_ratio        = result.pb_ratio        ?? pick(m, 'pbRatioTTM', 'pbRatio', 'priceToBookRatioTTM', 'priceToBookRatio', 'pbtTTM');
      result.ps_ratio        = result.ps_ratio        ?? pick(m, 'priceToSalesRatioTTM', 'priceToSalesRatio', 'psRatioTTM', 'psRatio');
      result.roe             = result.roe             ?? pick(m, 'roeTTM', 'roe', 'returnOnEquityTTM', 'returnOnEquity');
      result.roic            = result.roic            ?? pick(m, 'roicTTM', 'roic', 'returnOnInvestedCapitalTTM', 'returnOnInvestedCapital');
      result.debt_to_equity  = result.debt_to_equity  ?? pick(m, 'debtToEquityTTM', 'debtToEquity', 'debtEquityRatioTTM', 'debtEquityRatio');
      result.current_ratio   = pick(m, 'currentRatioTTM', 'currentRatio');
      result.peg_ratio       = pick(m, 'pegRatioTTM', 'pegRatio', 'priceEarningsToGrowthRatioTTM');
      result.forward_pe      = pick(m, 'forwardPERatioTTM', 'forwardPERatio', 'forwardPE');
    }
  } catch (e) {
    console.warn(`FMP key-metrics-ttm failed for ${symbol}:`, e.message);
  }

  // 4) ratios-ttm — EPS / 股息率 / 派息率 / 利润率（Gross/Operating/Net Margin）
  try {
    const r = await fetchFMP('ratios-ttm', { symbol });
    if (Array.isArray(r) && r.length > 0) {
      const x = r[0];
      result.raw_json.ratios = x;
      result.eps              = result.eps              ?? pick(x, 'netIncomePerShareTTM', 'epsTTM', 'eps');
      result.dividend_yield   = pick(x, 'dividendYieldTTM', 'dividendYielPercentageTTM', 'dividendYieldPercentageTTM', 'dividendYield');
      result.payout_ratio     = pick(x, 'payoutRatioTTM', 'payoutRatio');
      result.gross_margin     = pick(x, 'grossProfitMarginTTM', 'grossProfitMargin');
      result.operating_margin = pick(x, 'operatingProfitMarginTTM', 'operatingProfitMargin', 'operatingMarginTTM');
      result.net_margin       = pick(x, 'netProfitMarginTTM', 'netProfitMargin', 'netIncomeMarginTTM');
      // 还可能在 ratios 里找到 PE / PB（双保险）
      result.pe_ratio         = result.pe_ratio       ?? pick(x, 'priceEarningsRatioTTM', 'priceEarningsRatio', 'peRatioTTM', 'peRatio');
      result.pb_ratio         = result.pb_ratio       ?? pick(x, 'priceToBookRatioTTM', 'priceToBookRatio', 'pbRatioTTM');
      result.ps_ratio         = result.ps_ratio       ?? pick(x, 'priceToSalesRatioTTM', 'priceToSalesRatio');
      result.roe              = result.roe            ?? pick(x, 'returnOnEquityTTM', 'returnOnEquity');
      result.debt_to_equity   = result.debt_to_equity ?? pick(x, 'debtEquityRatioTTM', 'debtEquityRatio');
      result.current_ratio    = result.current_ratio  ?? pick(x, 'currentRatioTTM', 'currentRatio');
    }
  } catch (e) {
    console.warn(`FMP ratios-ttm failed for ${symbol}:`, e.message);
  }

  // 5) analyst-estimates — Forward EPS（用于算 Forward PE，可选/Free档可能限速）
  if (result.forward_pe == null && result.price != null) {
    try {
      const est = await fetchFMP('analyst-estimates', { symbol, period: 'annual', limit: 2 });
      if (Array.isArray(est) && est.length > 0) {
        result.raw_json.estimates = est[0];
        // 取下一年的 EPS 中值
        const nextEps = pick(est[0], 'estimatedEpsAvg', 'epsAvg', 'estimatedEps');
        if (nextEps && nextEps > 0) {
          result.forward_pe = result.price / nextEps;
        }
      }
    } catch (e) {
      // analyst-estimates 是可选的，失败不影响其他数据
      console.warn(`FMP analyst-estimates skipped for ${symbol}:`, e.message);
    }
  }

  // === 计算式补救：FMP 没给的，能算就自己算 ===
  // PE = 当前价 / EPS
  if (result.pe_ratio == null && result.price != null && result.eps && result.eps > 0) {
    result.pe_ratio = result.price / result.eps;
  }
  // 把数值字段统一转 Number（避免 "12.34" 字符串混入数据库出错）
  ['market_cap','beta','last_dividend','day_change','day_change_pct','volume','avg_volume',
   'pe_ratio','pb_ratio','ps_ratio','roe','roic','debt_to_equity','eps','dividend_yield','payout_ratio',
   'price','forward_pe','peg_ratio','current_ratio','gross_margin','operating_margin','net_margin',
   'year_high','year_low','shares_out','price_avg_50','price_avg_200'
  ].forEach(k => {
    if (result[k] != null) {
      const n = parseFloat(result[k]);
      result[k] = isNaN(n) ? null : n;
    }
  });

  return result;
}

// ============================================================
// Phase 2.3: Yahoo Finance quoteSummary 基本面源（覆盖全球市场）
// ============================================================

// 从 Yahoo {raw, fmt} 包装结构中提取原始数值
const yRaw = (obj, key) => {
  if (!obj || obj[key] == null) return null;
  if (typeof obj[key] === 'number' || typeof obj[key] === 'string') return obj[key];
  if (obj[key].raw != null) return obj[key].raw;
  return null;
};

// Yahoo Finance 反爬：先取 session cookie + crumb token，再用 crumb 访问 quoteSummary
// 这是 yfinance / yahoo-finance2 等主流库使用的标准流程
const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let yahooSession = null; // { cookies, crumb, expiresAt }

async function getYahooSession(forceRefresh = false) {
  if (!forceRefresh && yahooSession && yahooSession.expiresAt > Date.now()) {
    return yahooSession;
  }
  try {
    // Step 1: 触达 fc.yahoo.com 获取 session cookies (A1 / A1S 等)
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': YAHOO_UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.5' },
      redirect: 'manual',
    });
    let cookies = '';
    const setCookies = (typeof r1.headers.getSetCookie === 'function')
      ? r1.headers.getSetCookie()
      : (r1.headers.raw ? r1.headers.raw()['set-cookie'] : []);
    if (Array.isArray(setCookies) && setCookies.length > 0) {
      cookies = setCookies.map(c => c.split(';')[0]).join('; ');
    }

    // Step 2: 用 cookie 拿 crumb
    const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': YAHOO_UA,
        'Accept': 'text/plain',
        'Cookie': cookies,
      },
    });
    const crumbBody = (await r2.text()).trim();
    if (!r2.ok || !crumbBody || crumbBody.length > 50 || crumbBody.length < 5) {
      throw new Error(`crumb fetch HTTP ${r2.status}, body length ${crumbBody.length}`);
    }
    yahooSession = {
      cookies,
      crumb: crumbBody,
      expiresAt: Date.now() + 60 * 60 * 1000, // 1 小时
    };
    console.log(`✅ Yahoo session 建立: crumb=${crumbBody.slice(0, 8)}..., cookies len=${cookies.length}`);
    return yahooSession;
  } catch (e) {
    console.warn(`⚠️ Yahoo session 建立失败: ${e.message}（将无 crumb 重试）`);
    yahooSession = null;
    return null;
  }
}

async function fetchYahooFundamentals(symbol) {
  const result = { symbol, source: 'yahoo', raw_json: {} };
  const modules = [
    'summaryDetail', 'defaultKeyStatistics', 'financialData',
    'price', 'assetProfile', 'calendarEvents', 'earnings'
  ];
  const session = await getYahooSession();

  const buildUrl = (s) => {
    const crumb = s?.crumb ? `&crumb=${encodeURIComponent(s.crumb)}` : '';
    return `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules.join(',')}${crumb}`;
  };
  const buildHeaders = (s) => ({
    'User-Agent': YAHOO_UA,
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.5',
    ...(s?.cookies ? { 'Cookie': s.cookies } : {}),
  });

  let resp = await fetch(buildUrl(session), { headers: buildHeaders(session) });
  // 401 / 403 / Invalid Crumb → 重新建立 session 一次
  if (resp.status === 401 || resp.status === 403) {
    const fresh = await getYahooSession(true);
    if (fresh) {
      resp = await fetch(buildUrl(fresh), { headers: buildHeaders(fresh) });
    }
  }
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Yahoo HTTP ${resp.status}: ${txt.slice(0, 120)}`);
  }
  const data = await resp.json();
  const r = data?.quoteSummary?.result?.[0];
  if (!r) {
    const errInfo = data?.quoteSummary?.error;
    throw new Error(`Yahoo: no result${errInfo ? ' · ' + JSON.stringify(errInfo).slice(0, 100) : ''}`);
  }
  result.raw_json = r;

  const sd = r.summaryDetail || {};
  const ks = r.defaultKeyStatistics || {};
  const fd = r.financialData || {};
  const pr = r.price || {};
  const ap = r.assetProfile || {};

  // 公司基础信息
  result.company_name = pr.longName || pr.shortName || null;
  result.sector       = ap.sector || null;
  result.industry     = ap.industry || null;
  result.country      = ap.country || null;
  result.currency     = pr.currency || null;
  result.exchange     = pr.exchangeName || pr.exchange || null;
  result.ceo          = (ap.companyOfficers && ap.companyOfficers[0]?.name) || null;
  result.website      = ap.website || null;
  result.description  = ap.longBusinessSummary ? ap.longBusinessSummary.slice(0, 2000) : null;
  result.employees    = yRaw(ap, 'fullTimeEmployees');

  // 价格与市场数据
  result.price          = yRaw(fd, 'currentPrice') ?? yRaw(pr, 'regularMarketPrice');
  result.market_cap     = yRaw(pr, 'marketCap') ?? yRaw(sd, 'marketCap');
  result.day_change     = yRaw(pr, 'regularMarketChange');
  // Yahoo 给的 changePercent 是 decimal（-0.0127 = -1.27%），× 100 转为 percent 形式与 FMP 对齐
  const yPct = yRaw(pr, 'regularMarketChangePercent');
  result.day_change_pct = yPct != null ? yPct * 100 : null;
  result.volume         = yRaw(pr, 'regularMarketVolume') ?? yRaw(sd, 'volume');
  result.avg_volume     = yRaw(sd, 'averageVolume');
  result.year_high      = yRaw(sd, 'fiftyTwoWeekHigh');
  result.year_low       = yRaw(sd, 'fiftyTwoWeekLow');
  result.price_avg_50   = yRaw(sd, 'fiftyDayAverage');
  result.price_avg_200  = yRaw(sd, 'twoHundredDayAverage');
  result.shares_out     = yRaw(ks, 'sharesOutstanding') ?? yRaw(ks, 'floatShares');
  if (result.year_low != null && result.year_high != null) {
    result.range_52w = `${result.year_low} - ${result.year_high}`;
  }

  // 估值
  result.pe_ratio      = yRaw(sd, 'trailingPE') ?? yRaw(ks, 'trailingPE');
  result.forward_pe    = yRaw(sd, 'forwardPE') ?? yRaw(ks, 'forwardPE');
  result.pb_ratio      = yRaw(ks, 'priceToBook');
  result.ps_ratio      = yRaw(sd, 'priceToSalesTrailing12Months');
  result.peg_ratio     = yRaw(ks, 'pegRatio');
  result.eps           = yRaw(ks, 'trailingEps');
  result.beta          = yRaw(sd, 'beta') ?? yRaw(ks, 'beta');

  // 盈利能力（Yahoo 都用 decimal 形式）
  result.roe              = yRaw(fd, 'returnOnEquity');
  result.gross_margin     = yRaw(fd, 'grossMargins');
  result.operating_margin = yRaw(fd, 'operatingMargins');
  result.net_margin       = yRaw(fd, 'profitMargins');
  // Yahoo 没有 ROIC，留 null（FMP 端可填）

  // 财务健康
  let dte = yRaw(fd, 'debtToEquity');
  // Yahoo 的 debtToEquity 是 percent 形式（145.6 表示 1.456 ratio），归一化
  if (dte != null && dte > 10) dte = dte / 100;
  result.debt_to_equity = dte;
  result.current_ratio  = yRaw(fd, 'currentRatio');

  // 股息
  result.dividend_yield = yRaw(sd, 'dividendYield');
  result.payout_ratio   = yRaw(sd, 'payoutRatio');
  result.last_dividend  = yRaw(sd, 'dividendRate');

  // 数值字段统一转 Number
  ['market_cap','beta','last_dividend','day_change','day_change_pct','volume','avg_volume',
   'pe_ratio','pb_ratio','ps_ratio','roe','roic','debt_to_equity','eps','dividend_yield','payout_ratio',
   'price','forward_pe','peg_ratio','current_ratio','gross_margin','operating_margin','net_margin',
   'year_high','year_low','shares_out','price_avg_50','price_avg_200','employees'
  ].forEach(k => {
    if (result[k] != null) {
      const n = parseFloat(result[k]);
      result[k] = isNaN(n) ? null : n;
    }
  });

  return result;
}

// ============================================================
// Phase 2.3: 双源融合 + 字段级交叉检查
// ============================================================

// 字段规则：哪个源是主源 + 容差（用于检测分歧）
// tolerance = null 表示该字段单源（无法交叉检查）
const FIELD_RULES = {
  market_cap:       { primary: 'yahoo', tolerance: 0.02 },
  beta:             { primary: 'yahoo', tolerance: 0.30 }, // 计算口径常差异 → 容忍度高
  pe_ratio:         { primary: 'yahoo', tolerance: 0.05 },
  pb_ratio:         { primary: 'fmp',   tolerance: 0.10 },
  ps_ratio:         { primary: 'yahoo', tolerance: 0.10 },
  eps:              { primary: 'yahoo', tolerance: 0.05 },
  roe:              { primary: 'fmp',   tolerance: 0.10 },
  forward_pe:       { primary: 'yahoo', tolerance: 0.15 },
  peg_ratio:        { primary: 'yahoo', tolerance: 0.20 },
  dividend_yield:   { primary: 'yahoo', tolerance: 0.03 },
  payout_ratio:     { primary: 'yahoo', tolerance: 0.10 },
  gross_margin:     { primary: 'fmp',   tolerance: 0.05 },
  operating_margin: { primary: 'fmp',   tolerance: 0.05 },
  net_margin:       { primary: 'fmp',   tolerance: 0.05 },
  debt_to_equity:   { primary: 'fmp',   tolerance: 0.20 },
  current_ratio:    { primary: 'fmp',   tolerance: 0.05 },
  year_high:        { primary: 'yahoo', tolerance: 0.005 },
  year_low:         { primary: 'yahoo', tolerance: 0.005 },
  price_avg_50:     { primary: 'yahoo', tolerance: 0.02 },
  price_avg_200:    { primary: 'yahoo', tolerance: 0.02 },
  day_change_pct:   { primary: 'yahoo', tolerance: 0.10 },
  price:            { primary: 'yahoo', tolerance: 0.005 },
  shares_out:       { primary: 'yahoo', tolerance: 0.05 },
  volume:           { primary: 'yahoo', tolerance: 0.10 },
  avg_volume:       { primary: 'yahoo', tolerance: 0.10 },
  roic:             { primary: 'fmp',   tolerance: null },  // FMP 独有
  day_change:       { primary: 'yahoo', tolerance: 0.10 },
  last_dividend:    { primary: 'yahoo', tolerance: 0.10 },
  employees:        { primary: 'yahoo', tolerance: 0.05 },
};

// 文本/标识字段：不交叉检查，优先 Yahoo（更新更勤），FMP 兜底
const TEXT_FIELDS = ['company_name','sector','industry','country','currency','ceo','website','exchange','description','range_52w'];

function mergeWithCrossCheck(yahoo, fmp) {
  const merged = { field_sources: {}, discrepancies: {} };

  // 数值字段：按规则选主源 + 检测分歧
  for (const [field, rule] of Object.entries(FIELD_RULES)) {
    const yVal = yahoo[field];
    const fVal = fmp[field];

    let chosen = null;
    if (rule.primary === 'yahoo') {
      if (yVal != null) chosen = { val: yVal, src: 'yahoo' };
      else if (fVal != null) chosen = { val: fVal, src: 'fmp' };
    } else {
      if (fVal != null) chosen = { val: fVal, src: 'fmp' };
      else if (yVal != null) chosen = { val: yVal, src: 'yahoo' };
    }

    if (chosen) {
      merged[field] = chosen.val;
      merged.field_sources[field] = chosen.src;
    }

    // 双源都有值 + 有容差 → 交叉检查
    if (yVal != null && fVal != null && rule.tolerance != null) {
      const max = Math.max(Math.abs(yVal), Math.abs(fVal));
      if (max > 0.01) {
        const diffPct = Math.abs(yVal - fVal) / max;
        if (diffPct > rule.tolerance) {
          merged.discrepancies[field] = {
            yahoo: parseFloat(yVal.toFixed(4)),
            fmp: parseFloat(fVal.toFixed(4)),
            diff_pct: parseFloat((diffPct * 100).toFixed(2)),
          };
        }
      }
    }
  }

  // 文本字段：优先 Yahoo
  for (const field of TEXT_FIELDS) {
    const yVal = yahoo[field];
    const fVal = fmp[field];
    if (yVal != null && yVal !== '') {
      merged[field] = yVal;
      merged.field_sources[field] = 'yahoo';
    } else if (fVal != null && fVal !== '') {
      merged[field] = fVal;
      merged.field_sources[field] = 'fmp';
    }
  }

  return merged;
}

// 双源同时拉取 + 融合（Phase 2.3 主入口）
async function fetchFundamentalsHybrid(symbol) {
  const [yResult, fResult] = await Promise.allSettled([
    fetchYahooFundamentals(symbol),
    fetchFMPFundamentals(symbol),
  ]);
  const yahoo = yResult.status === 'fulfilled' ? yResult.value : {};
  const fmp   = fResult.status === 'fulfilled' ? fResult.value : {};

  if (yResult.status === 'rejected') console.warn(`Yahoo failed for ${symbol}:`, yResult.reason?.message);
  if (fResult.status === 'rejected') console.warn(`FMP failed for ${symbol}:`, fResult.reason?.message);

  const merged = mergeWithCrossCheck(yahoo, fmp);
  merged.symbol = symbol;
  // source 字符串记录哪个源真正出了数据
  const ySrcOK = yResult.status === 'fulfilled' && Object.keys(yahoo).length > 3;
  const fSrcOK = fResult.status === 'fulfilled' && Object.keys(fmp).length > 3;
  merged.source = ySrcOK && fSrcOK ? 'yahoo+fmp' : (ySrcOK ? 'yahoo' : (fSrcOK ? 'fmp' : 'none'));
  merged.raw_json = {
    yahoo: yahoo.raw_json || null,
    fmp:   fmp.raw_json   || null,
  };
  return merged;
}

// UPSERT 到 fundamentals_latest（Phase 2.2 防线：跳过空数据 + COALESCE 保护现有值）
async function saveFundamentalsToDB(d) {
  // 防线 1: 如果 FMP 返回完全空，抛错让调用者知道，避免用 NULL 覆盖 DB 里的好数据
  const hasUsefulData = d.market_cap || d.pe_ratio || d.eps || d.beta || d.company_name
                        || d.dividend_yield || d.roe || d.day_change_pct || d.price;
  if (!hasUsefulData) {
    throw new Error('FMP 返回空数据（可能是 Free 档不覆盖此市场，或限速触发）— 已跳过保存以保留现有数据');
  }

  // 防线 2: ON CONFLICT 用 COALESCE — 新值是 NULL 时保留旧值（防止部分 endpoint 失败覆盖好字段）
  await pool.query(`
    INSERT INTO fundamentals_latest (
      symbol, company_name, sector, industry, country, currency, market_cap, beta,
      ceo, website, exchange, description, last_dividend, range_52w,
      day_change, day_change_pct, volume, avg_volume, employees,
      pe_ratio, pb_ratio, ps_ratio, roe, roic, debt_to_equity,
      eps, dividend_yield, payout_ratio,
      price, forward_pe, peg_ratio, current_ratio,
      gross_margin, operating_margin, net_margin,
      year_high, year_low, shares_out, price_avg_50, price_avg_200,
      field_sources, discrepancies,
      source, fetched_at, raw_json
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
      $20,$21,$22,$23,$24,$25,$26,$27,$28,
      $29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
      $41,$42,
      $43,NOW(),$44
    )
    ON CONFLICT (symbol) DO UPDATE SET
      company_name   = COALESCE(EXCLUDED.company_name,   fundamentals_latest.company_name),
      sector         = COALESCE(EXCLUDED.sector,         fundamentals_latest.sector),
      industry       = COALESCE(EXCLUDED.industry,       fundamentals_latest.industry),
      country        = COALESCE(EXCLUDED.country,        fundamentals_latest.country),
      currency       = COALESCE(EXCLUDED.currency,       fundamentals_latest.currency),
      market_cap     = COALESCE(EXCLUDED.market_cap,     fundamentals_latest.market_cap),
      beta           = COALESCE(EXCLUDED.beta,           fundamentals_latest.beta),
      ceo            = COALESCE(EXCLUDED.ceo,            fundamentals_latest.ceo),
      website        = COALESCE(EXCLUDED.website,        fundamentals_latest.website),
      exchange       = COALESCE(EXCLUDED.exchange,       fundamentals_latest.exchange),
      description    = COALESCE(EXCLUDED.description,    fundamentals_latest.description),
      last_dividend  = COALESCE(EXCLUDED.last_dividend,  fundamentals_latest.last_dividend),
      range_52w      = COALESCE(EXCLUDED.range_52w,      fundamentals_latest.range_52w),
      day_change     = COALESCE(EXCLUDED.day_change,     fundamentals_latest.day_change),
      day_change_pct = COALESCE(EXCLUDED.day_change_pct, fundamentals_latest.day_change_pct),
      volume         = COALESCE(EXCLUDED.volume,         fundamentals_latest.volume),
      avg_volume     = COALESCE(EXCLUDED.avg_volume,     fundamentals_latest.avg_volume),
      employees      = COALESCE(EXCLUDED.employees,      fundamentals_latest.employees),
      pe_ratio       = COALESCE(EXCLUDED.pe_ratio,       fundamentals_latest.pe_ratio),
      pb_ratio       = COALESCE(EXCLUDED.pb_ratio,       fundamentals_latest.pb_ratio),
      ps_ratio       = COALESCE(EXCLUDED.ps_ratio,       fundamentals_latest.ps_ratio),
      roe            = COALESCE(EXCLUDED.roe,            fundamentals_latest.roe),
      roic           = COALESCE(EXCLUDED.roic,           fundamentals_latest.roic),
      debt_to_equity = COALESCE(EXCLUDED.debt_to_equity, fundamentals_latest.debt_to_equity),
      eps            = COALESCE(EXCLUDED.eps,            fundamentals_latest.eps),
      dividend_yield = COALESCE(EXCLUDED.dividend_yield, fundamentals_latest.dividend_yield),
      payout_ratio   = COALESCE(EXCLUDED.payout_ratio,   fundamentals_latest.payout_ratio),
      price          = COALESCE(EXCLUDED.price,          fundamentals_latest.price),
      forward_pe     = COALESCE(EXCLUDED.forward_pe,     fundamentals_latest.forward_pe),
      peg_ratio      = COALESCE(EXCLUDED.peg_ratio,      fundamentals_latest.peg_ratio),
      current_ratio  = COALESCE(EXCLUDED.current_ratio,  fundamentals_latest.current_ratio),
      gross_margin   = COALESCE(EXCLUDED.gross_margin,   fundamentals_latest.gross_margin),
      operating_margin = COALESCE(EXCLUDED.operating_margin, fundamentals_latest.operating_margin),
      net_margin     = COALESCE(EXCLUDED.net_margin,     fundamentals_latest.net_margin),
      year_high      = COALESCE(EXCLUDED.year_high,      fundamentals_latest.year_high),
      year_low       = COALESCE(EXCLUDED.year_low,       fundamentals_latest.year_low),
      shares_out     = COALESCE(EXCLUDED.shares_out,     fundamentals_latest.shares_out),
      price_avg_50   = COALESCE(EXCLUDED.price_avg_50,   fundamentals_latest.price_avg_50),
      price_avg_200  = COALESCE(EXCLUDED.price_avg_200,  fundamentals_latest.price_avg_200),
      field_sources  = EXCLUDED.field_sources,
      discrepancies  = EXCLUDED.discrepancies,
      source         = EXCLUDED.source,
      fetched_at     = NOW(),
      raw_json       = COALESCE(EXCLUDED.raw_json,       fundamentals_latest.raw_json)
  `, [
    d.symbol, d.company_name, d.sector, d.industry, d.country, d.currency,
    d.market_cap, d.beta, d.ceo, d.website, d.exchange, d.description,
    d.last_dividend, d.range_52w, d.day_change, d.day_change_pct, d.volume,
    d.avg_volume, d.employees, d.pe_ratio, d.pb_ratio, d.ps_ratio, d.roe,
    d.roic, d.debt_to_equity, d.eps, d.dividend_yield, d.payout_ratio,
    d.price, d.forward_pe, d.peg_ratio, d.current_ratio,
    d.gross_margin, d.operating_margin, d.net_margin,
    d.year_high, d.year_low, d.shares_out, d.price_avg_50, d.price_avg_200,
    JSON.stringify(d.field_sources || {}),
    JSON.stringify(d.discrepancies || {}),
    d.source, JSON.stringify(d.raw_json || {})
  ]);
}

// 检测一行数据是否"实质为空"（关键字段全 null）— Phase 2.2 防线 3 用
function isRowEmpty(row) {
  if (!row) return true;
  return !row.market_cap && !row.pe_ratio && !row.eps && !row.beta
         && !row.company_name && !row.dividend_yield && !row.roe;
}

// GET /api/fundamentals/:symbol — 读缓存，过期或空行则自动刷新
app.get("/api/fundamentals/:symbol", auth, async (req, res) => {
  const symbol = req.params.symbol.trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const maxAgeDays = parseFloat(req.query.maxAgeDays || '7');
  try {
    const cached = await pool.query(
      `SELECT *, EXTRACT(EPOCH FROM (NOW() - fetched_at))/86400 AS age_days
       FROM fundamentals_latest WHERE symbol=$1`,
      [symbol]
    );
    const cachedRow = cached.rows[0];
    const emptyCache = isRowEmpty(cachedRow);

    // 缓存有效 + 内容非空 → 直接返回
    if (cachedRow && cachedRow.age_days < maxAgeDays && !emptyCache) {
      return res.json({ ...cachedRow, _from: 'cache' });
    }

    // 缓存过期 OR 缓存为空（被之前 NULL 覆盖污染过） → 触发双源刷新
    if (emptyCache && cachedRow) {
      console.log(`🔄 Auto-retry for ${symbol}: cache row is empty, attempting hybrid fetch`);
    }
    const fresh = await fetchFundamentalsHybrid(symbol);
    await saveFundamentalsToDB(fresh); // 如果 fresh 也是空，会抛错被下面 catch 接住
    res.json({ ...fresh, _from: fresh.source || 'hybrid' });
  } catch (e) {
    console.error(`Fundamentals error for ${symbol}:`, e.message);
    // Fallback：旧缓存（即使过期或空）也返回，至少前端能显示"数据不可用"提示而非 500
    try {
      const stale = await pool.query("SELECT * FROM fundamentals_latest WHERE symbol=$1", [symbol]);
      if (stale.rows.length > 0) {
        return res.json({ ...stale.rows[0], _from: 'cache_stale', error: e.message });
      }
    } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

// POST /api/fundamentals/refresh/:symbol — 强制刷新一只（双源）
app.post("/api/fundamentals/refresh/:symbol", auth, async (req, res) => {
  const symbol = req.params.symbol.trim().toUpperCase();
  try {
    const data = await fetchFundamentalsHybrid(symbol);
    await saveFundamentalsToDB(data);
    res.json({ ok: true, symbol, _from: data.source || 'hybrid', fetched_at: new Date().toISOString() });
  } catch (e) {
    console.error(`Refresh failed for ${symbol}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/fundamentals/refresh-all — 批量刷新所有持仓（双源）
app.post("/api/fundamentals/refresh-all", auth, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT DISTINCT symbol FROM holdings WHERE user_id=$1 AND qty > 0 ORDER BY symbol",
      [req.userId]
    );
    const result = {
      ok: 0, failed: [], total: r.rows.length,
      sources: { 'yahoo+fmp': 0, yahoo: 0, fmp: 0 },
      total_discrepancies: 0,
      first_error: null,  // Phase 2.3 调试：暴露首个失败的具体原因
    };
    for (const row of r.rows) {
      try {
        const data = await fetchFundamentalsHybrid(row.symbol);
        await saveFundamentalsToDB(data);
        result.ok++;
        if (result.sources[data.source] != null) result.sources[data.source]++;
        if (data.discrepancies) result.total_discrepancies += Object.keys(data.discrepancies).length;
      } catch (e) {
        result.failed.push({ symbol: row.symbol, error: e.message });
        if (!result.first_error) result.first_error = `${row.symbol}: ${e.message}`;
        console.warn(`❌ ${row.symbol}: ${e.message}`);
      }
      await new Promise(rs => setTimeout(rs, 300));
    }
    res.json(result);
  } catch (e) {
    console.error("Refresh-all error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Anchor Prices — 历史锚定价格（用于精确 YTD 收益计算）
// 解决跨时区问题：每只股票的"年初"应该是它自己市场的"上一年最后交易日"
// ============================================================

// 给定 IANA 时区，把 unix 秒转成 YYYY-MM-DD（在该时区的日期）
function dateInTZ(unixSec, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(unixSec * 1000));
  } catch (e) {
    return new Date(unixSec * 1000).toISOString().slice(0, 10);
  }
}

// 拉取一只股票最近至给定日期的所有日 K 线，用于定位"上一年最后交易日"
async function fetchYahooHistorical(symbol, startUnix, endUnix) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?period1=${startUnix}&period2=${endUnix}&interval=1d`;
  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!resp.ok) throw new Error(`Yahoo historical HTTP ${resp.status}`);
  const json = await resp.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("No chart data");
  const meta = result.meta || {};
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  return { meta, timestamps, closes };
}

// 给一只股票，取它"上一年最后交易日"的收盘价（按市场本地时区判断）
async function fetchAnchorPriceForSymbol(symbol, anchorYear) {
  // 查询窗口：anchorYear-12-15 到 (anchorYear+1)-01-15（覆盖年末跨年）
  const startUnix = Math.floor(new Date(`${anchorYear}-12-15T00:00:00Z`).getTime() / 1000);
  const endUnix = Math.floor(new Date(`${anchorYear + 1}-01-15T00:00:00Z`).getTime() / 1000);
  const { meta, timestamps, closes } = await fetchYahooHistorical(symbol, startUnix, endUnix);
  const tz = meta.exchangeTimezoneName || 'America/New_York';
  const cur = meta.currency || 'USD';
  const yearEndCutoff = `${anchorYear + 1}-01-01`; // 任何 < 这个日期(in tz) 的都是 anchorYear 内
  // 找最大的 timestamp，其在 tz 下的日期 < yearEndCutoff
  let bestIdx = -1;
  let bestDate = '';
  for (let i = 0; i < timestamps.length; i++) {
    const d = dateInTZ(timestamps[i], tz);
    if (d < yearEndCutoff && d > bestDate) {
      bestDate = d;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || closes[bestIdx] == null) {
    throw new Error(`No trading day found for ${symbol} before ${yearEndCutoff}`);
  }
  return {
    symbol,
    anchor_date: bestDate,
    close_price: closes[bestIdx],
    currency: cur,
    market_tz: tz,
  };
}

// POST /api/anchor/backfill?year=2025  — 回填指定年份的所有持仓的年末锚定价
app.post("/api/anchor/backfill", auth, async (req, res) => {
  try {
    const year = parseInt(req.query.year || req.body?.year || new Date().getUTCFullYear() - 1);
    if (year < 2000 || year > 2100) return res.status(400).json({ error: "Invalid year" });

    // 取该用户所有股票（含已清仓的，方便回测）
    const hRes = await pool.query("SELECT DISTINCT symbol FROM holdings WHERE user_id=$1", [req.userId]);
    const tRes = await pool.query("SELECT DISTINCT symbol FROM trades WHERE user_id=$1", [req.userId]);
    const symbols = new Set([...hRes.rows.map(r => r.symbol), ...tRes.rows.map(r => r.symbol)]);

    const results = { ok: 0, skipped: 0, failed: [] };
    for (const symbol of symbols) {
      try {
        const anchor = await fetchAnchorPriceForSymbol(symbol, year);
        await pool.query(
          `INSERT INTO anchor_prices (symbol, anchor_date, close_price, currency, market_tz, source, fetched_at)
           VALUES ($1, $2, $3, $4, $5, 'Yahoo', NOW())
           ON CONFLICT (symbol, anchor_date) DO UPDATE SET
             close_price = EXCLUDED.close_price,
             currency = EXCLUDED.currency,
             market_tz = EXCLUDED.market_tz,
             fetched_at = NOW()`,
          [anchor.symbol, anchor.anchor_date, anchor.close_price, anchor.currency, anchor.market_tz]
        );
        results.ok++;
        console.log(`📌 Anchor saved: ${symbol} @ ${anchor.anchor_date} = ${anchor.close_price} ${anchor.currency}`);
      } catch (e) {
        console.warn(`Anchor failed for ${symbol}:`, e.message);
        results.failed.push({ symbol, error: e.message });
      }
      // 礼貌等待，避免 Yahoo 限流
      await new Promise(r => setTimeout(r, 200));
    }
    res.json({ year, ...results });
  } catch (e) {
    console.error("Anchor backfill error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/anchor-prices?year=2025 — 拉取指定年份所有锚定价
app.get("/api/anchor-prices", auth, async (req, res) => {
  try {
    const year = parseInt(req.query.year || new Date().getUTCFullYear() - 1);
    const r = await pool.query(
      `SELECT symbol, anchor_date::text AS anchor_date, close_price, currency, market_tz
       FROM anchor_prices
       WHERE EXTRACT(YEAR FROM anchor_date) = $1
       ORDER BY symbol`,
      [year]
    );
    res.json(r.rows);
  } catch (e) {
    console.error("Anchor query error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ Daily Snapshot — Phase 1 自动快照 ============
// 每天给每个用户的组合拍一张"照片"存到 daily_snapshot 表里。
// 30+ 天后可绘出真·YTD 曲线 / IRR / 最大回撤。

async function takeDailySnapshot(userId) {
  // 1) Refresh FX rates
  try { await fetchFXRates(); } catch(e) { console.warn("Snapshot: FX refresh failed:", e.message); }

  // 2) Get holdings + trades for this user
  const [hRes, tRes] = await Promise.all([
    pool.query("SELECT * FROM holdings WHERE user_id=$1", [userId]),
    pool.query("SELECT type, symbol, qty, price FROM trades WHERE user_id=$1", [userId]),
  ]);

  // 3) Compute per-symbol realized PL & dividends from trade history
  const sellInfo = {};   // { symbol: { amount, qty } }
  const dividendInfo = {};
  tRes.rows.forEach(t => {
    const isBuy = t.type === '买入' || t.type === 'BUY';
    const isDiv = t.type === '分红' || t.type === 'DIVIDEND';
    if (isDiv) {
      dividendInfo[t.symbol] = (dividendInfo[t.symbol] || 0) + t.price * t.qty;
    } else if (!isBuy) {
      if (!sellInfo[t.symbol]) sellInfo[t.symbol] = { amount: 0, qty: 0 };
      sellInfo[t.symbol].amount += t.price * t.qty;
      sellInfo[t.symbol].qty += t.qty;
    }
  });

  // 4) Fetch current prices for active symbols
  const activeSymbols = hRes.rows.filter(h => h.qty > 0).map(h => h.symbol);
  let prices = {};
  if (activeSymbols.length > 0) {
    try { prices = await fetchYahooQuotes(activeSymbols); }
    catch(e) { console.warn("Snapshot: price fetch failed:", e.message); }
  }

  // 5) Aggregate totals (USD)
  let totalValueUsd = 0, totalCostUsd = 0, unrealizedUsd = 0, realizedUsd = 0, dividendsUsd = 0;
  const regionValues = {};

  hRes.rows.forEach(h => {
    const fx = fxRates[h.currency] || 1;

    // Realized PL & dividends apply across all positions (including sold)
    const si = sellInfo[h.symbol];
    if (si && si.qty > 0) {
      const realizedCost = h.avg_cost * si.qty;
      realizedUsd += (si.amount - realizedCost) * fx;
    }
    const divLocal = dividendInfo[h.symbol] || 0;
    dividendsUsd += divLocal * fx;

    // Unrealized only for active positions
    if (h.qty > 0) {
      const px = prices[h.symbol]?.price || h.avg_cost;
      const mvLocal = h.qty * px;
      const cvLocal = h.qty * h.avg_cost;
      const mvUsd = mvLocal * fx;
      const cvUsd = cvLocal * fx;
      totalValueUsd += mvUsd;
      totalCostUsd += cvUsd;
      unrealizedUsd += (mvUsd - cvUsd);
      if (h.region) {
        regionValues[h.region] = (regionValues[h.region] || 0) + mvUsd;
      }
    }
  });

  const cumulativePlUsd = unrealizedUsd + realizedUsd + dividendsUsd;
  const today = new Date().toISOString().slice(0, 10);

  // 6) UPSERT today's snapshot (one row per user per date)
  await pool.query(`
    INSERT INTO daily_snapshot (
      user_id, date, total_value_usd, total_cost_usd,
      unrealized_pl_usd, realized_pl_usd, dividend_total_usd, cumulative_pl_usd,
      region_values, fx_rates
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (user_id, date) DO UPDATE SET
      total_value_usd     = EXCLUDED.total_value_usd,
      total_cost_usd      = EXCLUDED.total_cost_usd,
      unrealized_pl_usd   = EXCLUDED.unrealized_pl_usd,
      realized_pl_usd     = EXCLUDED.realized_pl_usd,
      dividend_total_usd  = EXCLUDED.dividend_total_usd,
      cumulative_pl_usd   = EXCLUDED.cumulative_pl_usd,
      region_values       = EXCLUDED.region_values,
      fx_rates            = EXCLUDED.fx_rates
  `, [
    userId, today,
    totalValueUsd.toFixed(2), totalCostUsd.toFixed(2),
    unrealizedUsd.toFixed(2), realizedUsd.toFixed(2),
    dividendsUsd.toFixed(2), cumulativePlUsd.toFixed(2),
    JSON.stringify(regionValues), JSON.stringify(fxRates),
  ]);

  return {
    userId, date: today,
    total_value_usd: +totalValueUsd.toFixed(2),
    cumulative_pl_usd: +cumulativePlUsd.toFixed(2),
    active_positions: activeSymbols.length,
  };
}

// ===== Cron endpoint: external scheduler (cron-job.org) hits this daily =====
// Auth: header "x-cron-token" must match CRON_SECRET env var
app.post("/api/cron/snapshot", async (req, res) => {
  const token = req.headers["x-cron-token"];
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: "CRON_SECRET not configured on server" });
  }
  if (!token || token !== process.env.CRON_SECRET) {
    console.warn("Snapshot cron: invalid token");
    return res.status(401).json({ error: "Invalid cron token" });
  }
  try {
    const users = await pool.query("SELECT id FROM users");
    const results = [];
    for (const u of users.rows) {
      try {
        const r = await takeDailySnapshot(u.id);
        results.push(r);
      } catch (e) {
        console.error(`Snapshot failed for user ${u.id}:`, e.message);
        results.push({ userId: u.id, error: e.message });
      }
    }
    console.log(`✅ Daily snapshot taken for ${results.length} user(s)`);
    res.json({ ok: true, snapshots: results });
  } catch (e) {
    console.error("Snapshot cron error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== Snapshot history endpoint (for future YTD chart UI) =====
app.get("/api/snapshots", auth, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 365, 1825); // cap at 5 years
    const r = await pool.query(
      `SELECT date, total_value_usd, total_cost_usd, unrealized_pl_usd, realized_pl_usd,
              dividend_total_usd, cumulative_pl_usd, region_values
       FROM daily_snapshot
       WHERE user_id=$1 AND date >= CURRENT_DATE - $2::int
       ORDER BY date`,
      [req.userId, days]
    );
    res.json(r.rows);
  } catch (e) {
    console.error("Snapshots fetch error:", e.message);
    res.status(500).json({ error: "获取快照失败" });
  }
});

// Startup snapshot: after server starts, take today's snapshot if missing.
// Fire-and-forget so it doesn't block startup. Wraps in setTimeout to let FX rates load first.
async function maybeStartupSnapshot() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const exists = await pool.query(
      "SELECT 1 FROM daily_snapshot WHERE date=$1 LIMIT 1",
      [today]
    );
    if (exists.rows.length > 0) {
      console.log("📸 Snapshot for today already exists, skipping startup snapshot");
      return;
    }
    const users = await pool.query("SELECT id FROM users");
    for (const u of users.rows) {
      try {
        const r = await takeDailySnapshot(u.id);
        console.log(`📸 Startup snapshot taken for user ${u.id}: $${r.total_value_usd}`);
      } catch (e) {
        console.error(`Startup snapshot failed for user ${u.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error("Startup snapshot error:", e.message);
  }
}

// ===== 启动 =====
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initDB();
    await autoSeed();
    app.listen(PORT, () => console.log(`Arc Patrimony 服务器已启动: http://localhost:${PORT}`));
    // Take today's snapshot ~30s after startup (let FX rates load first; fire-and-forget)
    setTimeout(() => { maybeStartupSnapshot(); }, 30000);
  } catch (e) {
    console.error("启动失败:", e.message);
    process.exit(1);
  }
}

startServer();
