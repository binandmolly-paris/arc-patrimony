const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Drive upsert 端点(原地更新 Drive 真相源/主档文件,解决 MCP 工具只能新建的问题)
const { registerDriveUpsert } = require("./drive-upsert");
registerDriveUpsert(app);
const { checkAndNotifyAlerts } = require("./alert-notify"); // A2 价格告警邮件通知
const { initArcTodoDB, seedArcTodoMembers, registerArcTodoRoutes } = require("./arc-todo-routes");

// ===== PostgreSQL 数据库连接 =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ARC TODO 是独立模块：自己的表、会话 cookie、OAuth 与 cron 令牌，绝不复用投资账户的认证或写入令牌。
registerArcTodoRoutes(app, pool);

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
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS notified INTEGER DEFAULT 0;
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
      ADD COLUMN IF NOT EXISTS discrepancies JSONB,
      ADD COLUMN IF NOT EXISTS quality_flags JSONB
  `);

  // 现金水位（按币种 + 可选地区）— 用于组合现金占比 / 宪法 20% 红线
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cash_positions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      currency TEXT NOT NULL,
      region TEXT,
      amount NUMERIC(20,2) NOT NULL DEFAULT 0,
      note TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, currency, region)
    );
  `);

  // 交易↔现金联动：记录每笔交易自动调整了哪笔现金、调了多少（删除时按此退回）
  await pool.query(`
    ALTER TABLE trades
      ADD COLUMN IF NOT EXISTS cash_ccy TEXT,
      ADD COLUMN IF NOT EXISTS cash_region TEXT,
      ADD COLUMN IF NOT EXISTS cash_delta NUMERIC(20,2)
  `);

  await initArcTodoDB(pool);
  await seedArcTodoMembers(pool);
  console.log("✅ 数据库表已就绪（Phase 2.3 + ARC TODO 隔离模块）");
}

// ===== 自动初始化 LiuBin 用户 =====
async function autoSeed() {
  const { rows } = await pool.query("SELECT COUNT(*) as c FROM users");
  if (parseInt(rows[0].c) > 0) {
    console.log("数据库已有用户，跳过初始化");
    return;
  }
  console.log("首次启动，自动初始化 LiuBin 用户...");
  // 种子密码从环境变量读取，不再硬编码（生产 DB 早已 seed，此处仅供全新部署）
  const seedPw = process.env.SEED_PASSWORD || "changeme-set-SEED_PASSWORD";
  const pw = bcrypt.hashSync(seedPw, 10);
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
    {s:"8031.T",n:"三井物产",q:500,c:6231.956,cur:"JPY",m:"东京",r:"日本",a:"防守",sec:"贸易"},
    {s:"8053.T",n:"住友商事",q:400,c:1433.54,cur:"JPY",m:"东京",r:"日本",a:"防守",sec:"贸易"},
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

// ===== 一次性数据修正（2026-07，对齐券商最新持仓）=====
// autoSeed 只对空库生效，已上线的数据库需在此修正：
// - 8031.T 三井物产：加仓 200 股（300→500，成本 6280→6231.956）
// - 8053.T 住友商事：1拆4 股票分割（100→400，成本 5734→1433.54）
// 以修正前的旧股数为条件，幂等：已修正或用户已自行调整时不会重复执行
async function patchHoldings202607() {
  const mitsui = await pool.query(
    "UPDATE holdings SET qty=500, avg_cost=6231.956 WHERE symbol='8031.T' AND qty=300 RETURNING user_id"
  );
  for (const row of mitsui.rows) {
    // 补记加仓交易，保持交易流水与持仓一致（6159.89 = 摊薄反推的买入均价）
    await pool.query(
      `INSERT INTO trades (user_id,symbol,name,type,qty,price,fee,date)
       VALUES ($1,'8031.T','三井物产','买入',200,6159.89,0,'2026-07-02')`,
      [row.user_id]
    );
  }
  const sumitomo = await pool.query(
    "UPDATE holdings SET qty=400, avg_cost=1433.54 WHERE symbol='8053.T' AND qty=100 RETURNING user_id"
  );
  for (const row of sumitomo.rows) {
    // 拆股同步调整历史交易，保证 recomputeHoldingFromTrades 结果一致
    await pool.query(
      "UPDATE trades SET qty=qty*4, price=price/4 WHERE user_id=$1 AND symbol='8053.T'",
      [row.user_id]
    );
  }
  if (mitsui.rowCount || sumitomo.rowCount) {
    console.log(`✅ 持仓数据修正完成: 三井物产 ${mitsui.rowCount} 户, 住友商事 ${sumitomo.rowCount} 户`);
  }
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

// ===== Alert 自动化:稳定服务令牌 x-alert-token(ALERT_SECRET)=用户登录令牌的替代,仅作用于 alerts 口 =====
// 仿 cron 模式:单用户 App,取主用户;Claude 可用此令牌写价格预警,无需浏览器登录令牌。
async function authOrAlert(req, res, next) {
  const at = req.headers["x-alert-token"];
  if (at && process.env.ALERT_SECRET && at === process.env.ALERT_SECRET) {
    try {
      const u = await pool.query("SELECT id FROM users ORDER BY id LIMIT 1");
      if (u.rows.length === 0) return res.status(500).json({ error: "no user" });
      req.userId = u.rows[0].id;
      return next();
    } catch (e) {
      console.error("authOrAlert error:", e.message);
      return res.status(500).json({ error: "alert auth error" });
    }
  }
  return auth(req, res, next);
}

// ===== 持仓写自动化:稳定服务令牌 x-holdings-token(HOLDINGS_WRITE_SECRET)=用户登录令牌替代,仅作用于持仓记录写口 =====
// 仿 alert/cron:单用户 App 取主用户;Claude 可用此令牌改持仓字段(名称/数量/成本/属性/板块/地区/目标权重),无需浏览器登录令牌。
// ⚠️ 不含 /api/trade(记交易+动现金)与 /api/import-holdings(批量覆盖)——那两口仍只认登录令牌。
async function authOrHoldings(req, res, next) {
  const ht = req.headers["x-holdings-token"];
  if (ht && process.env.HOLDINGS_WRITE_SECRET && ht === process.env.HOLDINGS_WRITE_SECRET) {
    try {
      const u = await pool.query("SELECT id FROM users ORDER BY id LIMIT 1");
      if (u.rows.length === 0) return res.status(500).json({ error: "no user" });
      req.userId = u.rows[0].id;
      return next();
    } catch (e) {
      console.error("authOrHoldings error:", e.message);
      return res.status(500).json({ error: "holdings auth error" });
    }
  }
  return auth(req, res, next);
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

// ===== 登录防暴力破解：每 key（用户名+IP）15 分钟内最多 5 次失败 =====
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFails = new Map(); // key -> { count, firstAt }
function loginKey(req, username) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  return `${(username || "").toLowerCase()}@${ip}`;
}
function loginLockRemainingMs(key) {
  const rec = loginFails.get(key);
  if (!rec) return 0;
  if (Date.now() - rec.firstAt > LOGIN_LOCK_MS) { loginFails.delete(key); return 0; }
  return rec.count >= LOGIN_MAX_FAILS ? LOGIN_LOCK_MS - (Date.now() - rec.firstAt) : 0;
}
function recordLoginFail(key) {
  const rec = loginFails.get(key);
  if (!rec || Date.now() - rec.firstAt > LOGIN_LOCK_MS) {
    loginFails.set(key, { count: 1, firstAt: Date.now() });
  } else {
    rec.count++;
  }
}

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const key = loginKey(req, username);
    const lockMs = loginLockRemainingMs(key);
    if (lockMs > 0) {
      return res.status(429).json({ error: `尝试次数过多，请 ${Math.ceil(lockMs / 60000)} 分钟后再试` });
    }
    const result = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
    if (result.rows.length === 0) { recordLoginFail(key); return res.status(400).json({ error: "用户名或密码错误" }); }
    const user = result.rows[0];
    if (!bcrypt.compareSync(password, user.password)) { recordLoginFail(key); return res.status(400).json({ error: "用户名或密码错误" }); }
    loginFails.delete(key); // 成功登录清零
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

app.post("/api/holdings/target-weight", authOrHoldings, async (req, res) => {
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

app.post("/api/holdings", authOrHoldings, async (req, res) => {
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

// 交易→现金：按币种调整一笔现金（买入扣、卖出/分红加）。返回实际命中的 {currency, region}。
// 匹配优先级：同币种+同地区 → 同币种任意(最早一笔) → 都没有则新建一笔。
async function adjustCashForTrade(userId, currency, region, delta) {
  if (!currency || !delta) return null;
  let row = null;
  const exact = await pool.query(
    "SELECT id, region FROM cash_positions WHERE user_id=$1 AND currency=$2 AND region IS NOT DISTINCT FROM $3 LIMIT 1",
    [userId, currency, region || null]
  );
  if (exact.rows.length) row = exact.rows[0];
  if (!row) {
    const any = await pool.query(
      "SELECT id, region FROM cash_positions WHERE user_id=$1 AND currency=$2 ORDER BY id LIMIT 1",
      [userId, currency]
    );
    if (any.rows.length) row = any.rows[0];
  }
  if (row) {
    await pool.query("UPDATE cash_positions SET amount = amount + $1, updated_at=NOW() WHERE id=$2", [delta, row.id]);
    return { currency, region: row.region };
  }
  // 没有该币种现金 → 新建一笔（金额可为负，提醒用户去登记真实现金）
  await pool.query(
    "INSERT INTO cash_positions (user_id, currency, region, amount, note, updated_at) VALUES ($1,$2,$3,$4,$5,NOW())",
    [userId, currency, region || null, delta, '交易自动建立']
  );
  return { currency, region: region || null };
}

app.post("/api/trade", auth, async (req, res) => {
  try {
    const { symbol, name, type, qty, price, fee, date, currency, market, region, attribute, sector, syncCash } = req.body;
    if (!symbol || !qty || !price || !type || !date) return res.status(400).json({ error: "请填写完整信息" });

    const ins = await pool.query(
      "INSERT INTO trades (user_id,symbol,name,type,qty,price,fee,date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [req.userId, symbol, name || "", type, qty, price, fee || 0, date]
    );
    const tradeId = ins.rows[0].id;

    // 现金联动（默认开；前端可关）。买入扣 qty*price+fee；卖出/分红加 qty*price-fee。
    if (syncCash && currency) {
      const f = parseFloat(fee) || 0;
      const gross = qty * price;
      let delta = 0;
      if (type === "买入" || type === "BUY") delta = -(gross + f);
      else if (type === "卖出" || type === "SELL") delta = (gross - f);
      else if (type === "分红" || type === "DIVIDEND") delta = (gross - f);
      if (delta !== 0) {
        const hit = await adjustCashForTrade(req.userId, currency, region || null, delta);
        if (hit) {
          await pool.query(
            "UPDATE trades SET cash_ccy=$1, cash_region=$2, cash_delta=$3 WHERE id=$4",
            [hit.currency, hit.region, delta, tradeId]
          );
        }
      }
    }

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
      "SELECT symbol, cash_ccy, cash_region, cash_delta FROM trades WHERE id=$1 AND user_id=$2",
      [tradeId, req.userId]
    );
    if (lookup.rows.length === 0) return res.status(404).json({ error: "Trade not found" });
    const symbol = lookup.rows[0].symbol;

    // 现金联动：若该笔交易曾自动调整过现金，删除时反向退回
    const cd = lookup.rows[0];
    if (cd.cash_ccy && cd.cash_delta != null && parseFloat(cd.cash_delta) !== 0) {
      await adjustCashForTrade(req.userId, cd.cash_ccy, cd.cash_region, -parseFloat(cd.cash_delta));
    }

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
app.get("/api/alerts", authOrAlert, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM alerts WHERE user_id=$1", [req.userId]);
    res.json(result.rows);
  } catch (e) {
    console.error("Alerts error:", e.message);
    res.status(500).json({ error: "获取提醒失败" });
  }
});

app.post("/api/alert", authOrAlert, async (req, res) => {
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

app.put("/api/alert/:id", authOrAlert, async (req, res) => {
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
app.post("/api/import-alerts", authOrAlert, async (req, res) => {
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

app.delete("/api/alert/:id", authOrAlert, async (req, res) => {
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
        const tradingPeriod = meta.currentTradingPeriod?.regular || {};
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
          // ★ 今日交易时段窗口 (Yahoo 提供，比 regularMarketTime 更可靠地判断"市场是否正在交易")
          // 用于识别 "市场已开但还没收到 tick" 的过渡状态 (常见于 JP 假期后第一天等)
          todaySessionStart: tradingPeriod.start || 0,
          todaySessionEnd: tradingPeriod.end || 0,
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
  // ?fresh=1 → 跳过缓存，强制向 Yahoo 重新拉。前端"强制刷新"按钮使用。
  const bypassCache = req.query.fresh === '1' || req.query.fresh === 'true';

  const results = {};
  const toFetch = [];

  symbols.forEach(s => {
    if (!bypassCache && priceCache[s] && Date.now() - priceCache[s].ts < CACHE_TTL) {
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

// ===== 现金水位 =====
// 各币种现金，折 USD 计入组合总值，用于宪法"现金 20% 红线"监控
app.get("/api/cash", auth, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id, currency, region, amount, note, updated_at FROM cash_positions WHERE user_id=$1 ORDER BY currency, region",
      [req.userId]
    );
    let totalUSD = 0;
    const positions = r.rows.map(row => {
      const amt = parseFloat(row.amount) || 0;
      const rate = fxRates[row.currency] || (row.currency === 'USD' ? 1 : null);
      const usd = rate != null ? amt * rate : null;
      if (usd != null) totalUSD += usd;
      return { ...row, amount: amt, usd_value: usd };
    });
    res.json({ positions, total_usd: totalUSD, red_line_pct: 20 });
  } catch (e) {
    console.error("Cash list error:", e.message);
    res.status(500).json({ error: "获取现金失败" });
  }
});

// 新增/更新一笔现金（同 用户+币种+地区 视为同一笔，覆盖金额）
app.post("/api/cash", auth, async (req, res) => {
  try {
    const { currency, region, amount, note } = req.body;
    if (!currency || amount == null) return res.status(400).json({ error: "currency 和 amount 必填" });
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: "amount 非法" });
    const r = await pool.query(
      `INSERT INTO cash_positions (user_id, currency, region, amount, note, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (user_id, currency, region) DO UPDATE SET
         amount = EXCLUDED.amount, note = EXCLUDED.note, updated_at = NOW()
       RETURNING id`,
      [req.userId, currency.toUpperCase(), region || null, amt, note || null]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    console.error("Cash upsert error:", e.message);
    res.status(500).json({ error: "保存现金失败" });
  }
});

app.delete("/api/cash/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM cash_positions WHERE id=$1 AND user_id=$2", [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (e) {
    console.error("Cash delete error:", e.message);
    res.status(500).json({ error: "删除现金失败" });
  }
});

// ===== 实时汇率 =====
// fxRates[X] = USD per 1 X. _prev_X = previous trading day's close (for daily-change display).
const fxRates = { JPY: 0.0067, CNY: 0.138, USD: 1, HKD: 0.128, CHF: 1.10, MYR: 0.21 };
const fxPairs = ['JPYUSD=X', 'CNYUSD=X', 'HKDUSD=X', 'CHFUSD=X', 'MYRUSD=X'];

async function fetchFXRates() {
  for (const pair of fxPairs) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${pair}?range=1d&interval=1d`;
      const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!resp.ok) continue;
      const json = await resp.json();
      const meta = json?.chart?.result?.[0]?.meta;
      const rate = meta?.regularMarketPrice;
      const prev = meta?.chartPreviousClose;
      if (rate && rate > 0) {
        const cur = pair.substring(0, 3);
        fxRates[cur] = rate;
        if (prev && prev > 0) fxRates['_prev_' + cur] = prev;
        console.log(`汇率更新: 1 ${cur} = ${rate} USD (prev ${prev || '?'})`);
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

  // ========================================================
  // 第 1 步：v7/finance/quote — 限速宽松，无需 crumb，覆盖大部分关键字段
  // 此 endpoint 跟 chart endpoint 同级别，对 Render 数据中心 IP 友好
  // ========================================================
  try {
    const v7Url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const v7Resp = await fetch(v7Url, {
      headers: {
        'User-Agent': YAHOO_UA,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    if (v7Resp.ok) {
      const v7Data = await v7Resp.json();
      const q = v7Data?.quoteResponse?.result?.[0];
      if (q) {
        result.raw_json.v7_quote = q;
        result.company_name   = q.longName || q.shortName || null;
        result.exchange       = q.fullExchangeName || q.exchange || null;
        result.currency       = q.currency || null;
        result.market_cap     = q.marketCap ?? null;
        result.shares_out     = q.sharesOutstanding ?? null;
        result.price          = q.regularMarketPrice ?? null;
        result.day_change     = q.regularMarketChange ?? null;
        result.day_change_pct = q.regularMarketChangePercent ?? null;  // v7 已是 percent 形式
        result.volume         = q.regularMarketVolume ?? null;
        result.avg_volume     = q.averageDailyVolume3Month ?? null;
        result.year_high      = q.fiftyTwoWeekHigh ?? null;
        result.year_low       = q.fiftyTwoWeekLow ?? null;
        result.price_avg_50   = q.fiftyDayAverage ?? null;
        result.price_avg_200  = q.twoHundredDayAverage ?? null;
        result.pe_ratio       = q.trailingPE ?? null;
        result.forward_pe     = q.forwardPE ?? null;
        result.eps            = q.epsTrailingTwelveMonths ?? null;
        result.pb_ratio       = q.priceToBook ?? null;
        // v7 dividend yield 已是 percent (1.5 = 1.5%)，转为 decimal 形式（0.015）与其他源对齐
        result.dividend_yield = q.trailingAnnualDividendYield != null ? q.trailingAnnualDividendYield
                              : (q.dividendYield != null ? q.dividendYield / 100 : null);
        result.last_dividend  = q.trailingAnnualDividendRate ?? null;
        if (result.year_low != null && result.year_high != null) {
          result.range_52w = `${result.year_low} - ${result.year_high}`;
        }
      }
    } else {
      console.warn(`Yahoo v7/quote HTTP ${v7Resp.status} for ${symbol}`);
    }
  } catch (e) {
    console.warn(`Yahoo v7/quote 失败 for ${symbol}:`, e.message);
  }

  // ========================================================
  // 第 2 步：v10/quoteSummary — 限速严，仅在 v7 拿不到的深度字段（ROE/利润率/PEG/Beta）调用
  // 失败不影响 v7 已拿到的字段
  // ========================================================
  const needDeep = result.roe == null || result.gross_margin == null || result.peg_ratio == null;
  if (needDeep) {
    try {
      const session = await getYahooSession();
      const modules = ['defaultKeyStatistics', 'financialData', 'assetProfile', 'summaryDetail'];
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
      if (resp.status === 401 || resp.status === 403) {
        const fresh = await getYahooSession(true);
        if (fresh) resp = await fetch(buildUrl(fresh), { headers: buildHeaders(fresh) });
      }
      if (resp.ok) {
        const data = await resp.json();
        const r = data?.quoteSummary?.result?.[0];
        if (r) {
          result.raw_json.v10_quoteSummary = r;
          const sd = r.summaryDetail || {};
          const ks = r.defaultKeyStatistics || {};
          const fd = r.financialData || {};
          const ap = r.assetProfile || {};

          // 用 v10 补 v7 没给的深度字段
          result.sector            = result.sector            ?? (ap.sector || null);
          result.industry          = result.industry          ?? (ap.industry || null);
          result.country           = result.country           ?? (ap.country || null);
          result.ceo               = result.ceo               ?? ((ap.companyOfficers && ap.companyOfficers[0]?.name) || null);
          result.website           = result.website           ?? (ap.website || null);
          result.description       = result.description       ?? (ap.longBusinessSummary ? ap.longBusinessSummary.slice(0, 2000) : null);
          result.employees         = result.employees         ?? yRaw(ap, 'fullTimeEmployees');
          result.peg_ratio         = result.peg_ratio         ?? yRaw(ks, 'pegRatio');
          result.beta              = result.beta              ?? yRaw(sd, 'beta') ?? yRaw(ks, 'beta');
          result.ps_ratio          = result.ps_ratio          ?? yRaw(sd, 'priceToSalesTrailing12Months');
          result.payout_ratio      = result.payout_ratio      ?? yRaw(sd, 'payoutRatio');
          result.roe               = result.roe               ?? yRaw(fd, 'returnOnEquity');
          result.gross_margin      = result.gross_margin      ?? yRaw(fd, 'grossMargins');
          result.operating_margin  = result.operating_margin  ?? yRaw(fd, 'operatingMargins');
          result.net_margin        = result.net_margin        ?? yRaw(fd, 'profitMargins');
          let dte = yRaw(fd, 'debtToEquity');
          if (dte != null && dte > 10) dte = dte / 100;
          result.debt_to_equity    = result.debt_to_equity    ?? dte;
          result.current_ratio     = result.current_ratio     ?? yRaw(fd, 'currentRatio');
        }
      } else {
        console.warn(`Yahoo v10 HTTP ${resp.status} for ${symbol}（v7 字段保留）`);
      }
    } catch (e) {
      console.warn(`Yahoo v10 失败 for ${symbol}（v7 字段保留）:`, e.message);
    }
  }

  // 如果 v7 + v10 都没拿到关键数据，抛错让 hybrid 知道
  if (!hasSourceData(result)) {
    throw new Error('Yahoo: v7 + v10 均无关键字段');
  }

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

// ============================================================
// Phase 3.1: Tushare Pro 集成（A股 fundamentals + HK 价格基础）
// API 文档: https://tushare.pro/document/2
// ============================================================
const TUSHARE_API = 'https://api.tushare.pro';

// Tushare 部分接口（特别是 hk_daily）有频率限制（2次/分钟 起）
// 这里用全局"上次调用时间"映射，对每个限速接口强制最小间隔
const TUSHARE_MIN_INTERVAL_MS = {
  hk_daily: 31000,   // 2次/min → 至少 31s 间隔
  hk_basic: 2000,
};
const tushareLastCallAt = {};

async function fetchTushare(api_name, params = {}, fields = '') {
  const token = process.env.TUSHARE_TOKEN;
  if (!token) throw new Error('TUSHARE_TOKEN not configured');

  // 强制最小间隔（仅限 TUSHARE_MIN_INTERVAL_MS 中列出的接口）
  const minInterval = TUSHARE_MIN_INTERVAL_MS[api_name];
  if (minInterval) {
    const last = tushareLastCallAt[api_name] || 0;
    const wait = minInterval - (Date.now() - last);
    if (wait > 0) {
      console.log(`[Tushare] ${api_name} 限速等待 ${Math.ceil(wait/1000)}s`);
      await new Promise(r => setTimeout(r, wait));
    }
    tushareLastCallAt[api_name] = Date.now();
  }

  const resp = await fetch(TUSHARE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_name, token, params, fields }),
  });
  if (!resp.ok) throw new Error(`Tushare HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`Tushare ${api_name}: ${data.msg || 'error'}`);
  // 把 {fields:[...], items:[[...]]} 二维数组转成对象数组
  const f = data.data?.fields || [];
  const items = data.data?.items || [];
  return items.map(row => Object.fromEntries(f.map((k, i) => [k, row[i]])));
}

// Yahoo .SS → Tushare .SH；HK 4位 → 5位 padded
function yahooToTushareTicker(symbol) {
  if (symbol.endsWith('.SS')) return symbol.replace('.SS', '.SH');
  if (symbol.endsWith('.SZ')) return symbol;
  if (symbol.endsWith('.HK')) {
    const num = symbol.replace('.HK', '');
    return num.padStart(5, '0') + '.HK';
  }
  return symbol;
}

// 在 result 上把所有非空字段统一打上来源标签（Phase 3 单源 fetcher 用）
function tagAllFieldsWithSource(result, source) {
  result.field_sources = result.field_sources || {};
  for (const k of Object.keys(result)) {
    if (result[k] == null) continue;
    if (['symbol','source','raw_json','field_sources','discrepancies'].includes(k)) continue;
    result.field_sources[k] = source;
  }
}

async function fetchTushareFundamentals(symbol) {
  const result = { symbol, source: 'tushare', raw_json: {} };
  const tsTicker = yahooToTushareTicker(symbol);
  const isHK = symbol.endsWith('.HK');

  if (isHK) {
    // HK: 仅基本信息 + 价格（Tushare 暂不直接提供 HK fundamentals）
    try {
      const info = await fetchTushare('hk_basic', { ts_code: tsTicker });
      if (info.length > 0) {
        result.raw_json.hk_basic = info[0];
        result.company_name = info[0].name || null;
        result.country = '香港';
        result.currency = 'HKD';
        result.exchange = 'HKEX';
      }
    } catch (e) { console.warn(`Tushare hk_basic failed for ${symbol}:`, e.message); }

    try {
      const today = new Date().toISOString().slice(0,10).replace(/-/g, '');
      const start = new Date(Date.now() - 14*86400000).toISOString().slice(0,10).replace(/-/g, '');
      const prices = await fetchTushare('hk_daily', { ts_code: tsTicker, start_date: start, end_date: today });
      if (prices.length > 0) {
        const latest = prices.sort((a, b) => b.trade_date.localeCompare(a.trade_date))[0];
        result.raw_json.hk_daily = latest;
        result.price = parseFloat(latest.close) || null;
        result.day_change = parseFloat(latest.change) || null;
        result.day_change_pct = parseFloat(latest.pct_chg) || null;
        result.volume = parseFloat(latest.vol) || null;
      }
    } catch (e) { console.warn(`Tushare hk_daily failed for ${symbol}:`, e.message); }
  } else {
    // A股: 基本信息 + 估值（daily_basic）+ 财务比率（fina_indicator）
    try {
      const basic = await fetchTushare('stock_basic',
        { ts_code: tsTicker },
        'ts_code,name,area,industry,list_date,market'
      );
      if (basic.length > 0) {
        result.raw_json.stock_basic = basic[0];
        result.company_name = basic[0].name || null;
        result.industry = basic[0].industry || null;
        result.country = '中国';
        result.currency = 'CNY';
        result.exchange = basic[0].market === '主板' ? 'SSE/SZSE' : (basic[0].market || null);
      }
    } catch (e) { console.warn(`Tushare stock_basic failed for ${symbol}:`, e.message); }

    try {
      const today = new Date().toISOString().slice(0,10).replace(/-/g, '');
      const start = new Date(Date.now() - 14*86400000).toISOString().slice(0,10).replace(/-/g, '');
      const db = await fetchTushare('daily_basic', { ts_code: tsTicker, start_date: start, end_date: today });
      if (db.length > 0) {
        const latest = db.sort((a, b) => b.trade_date.localeCompare(a.trade_date))[0];
        result.raw_json.daily_basic = latest;
        result.price = parseFloat(latest.close) || null;
        result.pe_ratio = parseFloat(latest.pe_ttm) ?? parseFloat(latest.pe) ?? null;
        result.pb_ratio = parseFloat(latest.pb) || null;
        result.ps_ratio = parseFloat(latest.ps_ttm) ?? parseFloat(latest.ps) ?? null;
        // dv 是 percent 形式（1.5 = 1.5%），转为 decimal 与其他源一致
        const dv = parseFloat(latest.dv_ttm) || parseFloat(latest.dv_ratio);
        if (!isNaN(dv)) result.dividend_yield = dv / 100;
        // total_mv 单位：万元 → ×10000 转为 CNY
        if (latest.total_mv) result.market_cap = parseFloat(latest.total_mv) * 10000;
        if (latest.total_share) result.shares_out = parseFloat(latest.total_share) * 10000;
      }
    } catch (e) { console.warn(`Tushare daily_basic failed for ${symbol}:`, e.message); }

    try {
      // fina_indicator：取最新一期财报指标
      const fi = await fetchTushare('fina_indicator', { ts_code: tsTicker });
      if (fi.length > 0) {
        const latest = fi.sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
        result.raw_json.fina_indicator = latest;
        // Tushare 财务比率均为 percent 形式（15.5 = 15.5%），统一转为 decimal
        const pct = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n / 100; };
        result.roe              = pct(latest.roe);
        result.roic             = pct(latest.roic);
        result.gross_margin     = pct(latest.grossprofit_margin);
        result.operating_margin = pct(latest.op_of_gr);
        result.net_margin       = pct(latest.netprofit_margin);
        result.eps              = parseFloat(latest.eps) || null;
        result.current_ratio    = parseFloat(latest.current_ratio) || null;
        const de = parseFloat(latest.debt_to_eqt);
        if (!isNaN(de)) result.debt_to_equity = de / 100;
      }
    } catch (e) { console.warn(`Tushare fina_indicator failed for ${symbol}:`, e.message); }
  }

  // 数值字段统一 Number 化
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

  tagAllFieldsWithSource(result, 'tushare');
  return result;
}

// ============================================================
// Phase 3.2: J-Quants 集成（日股 fundamentals + 价格 + 5 年历史）
// API 文档: https://jpx.gitbook.io/j-quants-en/api-reference
// ============================================================
// J-Quants V2 API（2025-12-22 后注册的账号必须用 V2 + API Key 认证）
const JQUANTS_API = 'https://api.jquants.com/v2';

async function fetchJQuants(endpoint, params = {}) {
  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) {
    throw new Error('J-Quants 凭证未配置：请在 Render 设置 JQUANTS_API_KEY（V2 API Key，从 J-Quants 控制台 API Keys 页面获取）');
  }

  // V2 用 pagination_key 分页，需要循环抓取所有数据
  const allData = [];
  let paginationKey = null;
  let pageCount = 0;

  while (true) {
    const query = { ...params };
    if (paginationKey) query.pagination_key = paginationKey;
    const qs = new URLSearchParams(query);
    const url = `${JQUANTS_API}${endpoint}?${qs}`;
    const resp = await fetch(url, { headers: { 'x-api-key': apiKey } });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`J-Quants ${endpoint} HTTP ${resp.status}: ${txt.slice(0, 100)}`);
    }
    const payload = await resp.json();
    if (Array.isArray(payload.data)) allData.push(...payload.data);

    paginationKey = payload.pagination_key || null;
    pageCount++;
    if (!paginationKey || pageCount >= 10) break; // 安全上限：单次最多 10 页
  }

  return { data: allData };
}

// Yahoo .T → J-Quants 5位代码（4位 + check digit '0'）
// 7203.T → 72030
function yahooToJQuantsCode(symbol) {
  const m = symbol.match(/^(\d+)\.T$/i);
  if (!m) return null;
  return m[1].length === 4 ? m[1] + '0' : m[1];
}

async function fetchJQuantsFundamentals(symbol) {
  const result = { symbol, source: 'jquants', raw_json: {} };
  const code = yahooToJQuantsCode(symbol);
  if (!code) throw new Error(`Invalid JP symbol: ${symbol}`);

  // 1. 上市公司基本信息（V2: /equities/master，字段名缩写）
  try {
    const info = await fetchJQuants('/equities/master', { code });
    if (info.data && info.data.length > 0) {
      const i = info.data[0];
      result.raw_json.eq_master = i;
      result.company_name = i.CoName || i.CoNameEn || null;
      result.sector       = i.S33Nm || i.S17Nm || null;
      result.industry     = i.S33Nm || null;
      result.country      = '日本';
      result.currency     = 'JPY';
      result.exchange     = i.MktNm || 'TSE';
    }
  } catch (e) { console.warn(`J-Quants /equities/master failed for ${symbol}:`, e.message); }

  // 2. 价格（最近交易日 + 1 年历史用于 52W 高低/SMA）
  // V2: /equities/bars/daily，字段名 O/H/L/C/Vo
  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const yearAgo = new Date(Date.now() - 365*86400000).toISOString().slice(0, 10).replace(/-/g, '');
    const prices = await fetchJQuants('/equities/bars/daily', { code, from: yearAgo, to: today });
    if (prices.data && prices.data.length > 0) {
      const sorted = prices.data.sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));
      const latest = sorted[0];
      result.raw_json.daily_quote_latest = latest;
      const closeP = parseFloat(latest.C);
      const openP  = parseFloat(latest.O);
      result.price          = isNaN(closeP) ? null : closeP;
      result.day_change     = (!isNaN(closeP) && !isNaN(openP)) ? closeP - openP : null;
      result.day_change_pct = (result.price && openP)
        ? ((result.price - openP) / openP) * 100
        : null;
      const vol = parseFloat(latest.Vo);
      result.volume = isNaN(vol) ? null : vol;

      const closes = sorted.map(p => parseFloat(p.C)).filter(p => !isNaN(p));
      if (closes.length > 0) {
        result.year_high = Math.max(...closes);
        result.year_low  = Math.min(...closes);
        result.range_52w = `${result.year_low} - ${result.year_high}`;
      }
      // SMA 50 / 200
      if (closes.length >= 50) {
        const sma50 = closes.slice(0, 50).reduce((a, b) => a + b, 0) / 50;
        result.price_avg_50 = sma50;
      }
      if (closes.length >= 200) {
        const sma200 = closes.slice(0, 200).reduce((a, b) => a + b, 0) / 200;
        result.price_avg_200 = sma200;
      }
    }
  } catch (e) { console.warn(`J-Quants /equities/bars/daily failed for ${symbol}:`, e.message); }

  // 3. 财报 Summary（V2: /fins/summary，字段名缩写）
  try {
    const stmts = await fetchJQuants('/fins/summary', { code });
    if (stmts.data && stmts.data.length > 0) {
      // 按披露日期降序
      const sorted = stmts.data.sort((a, b) => (b.DiscDate || '').localeCompare(a.DiscDate || ''));
      // ⭐ Bug fix(2026-05-27):快照取最新【年报 FY】,不取 sorted[0]
      //（最新披露可能是季报/累计数,会把部分年数据当全年 → PE/利润率算错;无 FY 才退回 sorted[0]）
      const fyRecords = sorted.filter(r => r.CurPerType === 'FY');
      const latest = fyRecords[0] || sorted[0];
      result.raw_json.statements_latest = latest;

      // ⭐ 5年历史(2026-05-27):把 J-Quants 全部 FY 年报序列带出去,存进 fundamentals 历史表
      //（之前只存最新一期,白白浪费 J-Quants 给的多年深度;历史表早建好只是没喂数据）
      result.fy_history = fyRecords.map(r => ({
        period_end: r.CurFYEn || r.CurPerEn || null,
        period_type: 'FY',
        currency: 'JPY',
        revenue: parseFloat(r.Sales) || null,
        operating_income: parseFloat(r.OP) || null,
        net_income: parseFloat(r.NP) || null,
        eps: parseFloat(r.EPS) || null,
        total_assets: parseFloat(r.TA) || null,
        total_equity: parseFloat(r.Eq) || null,
      })).filter(x => x.period_end);

      // V2 财务字段映射（短字段名）
      result.eps = parseFloat(latest.EPS) || null;
      const bps = parseFloat(latest.BPS);
      const totalRev = parseFloat(latest.Sales);
      const opIncome = parseFloat(latest.OP);
      const netIncome = parseFloat(latest.NP);
      const equity = parseFloat(latest.Eq);

      if (result.price && result.eps) result.pe_ratio = result.price / result.eps;
      if (result.price && bps && bps > 0) result.pb_ratio = result.price / bps;
      if (totalRev && opIncome) result.operating_margin = opIncome / totalRev;
      if (totalRev && netIncome) result.net_margin = netIncome / totalRev;
      if (netIncome && equity && equity > 0) result.roe = netIncome / equity;

      // Forward EPS → Forward PE
      const fwdEps = parseFloat(latest.FEPS);
      if (result.price && fwdEps) result.forward_pe = result.price / fwdEps;

      // 年度每股分红 → 股息率（DivAnn = 实际年度，FDivAnn = 预测年度）
      const divPerShare = parseFloat(latest.DivAnn) || parseFloat(latest.FDivAnn);
      if (result.price && divPerShare) result.dividend_yield = divPerShare / result.price;
      if (divPerShare) result.last_dividend = divPerShare;

      // shares outstanding (用于市值)
      const shares = parseFloat(latest.ShOutFY);
      if (shares && result.price) {
        result.shares_out = shares;
        result.market_cap = shares * result.price;
      }
    }
  } catch (e) { console.warn(`J-Quants /fins/summary failed for ${symbol}:`, e.message); }

  // 数值字段统一 Number 化
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

  tagAllFieldsWithSource(result, 'jquants');
  return result;
}


// 检测某源返回的数据是否"实质有内容"（除了 symbol/source/raw_json 三个固定字段外是否有值）
function hasSourceData(obj) {
  if (!obj) return false;
  return !!(obj.market_cap || obj.pe_ratio || obj.eps || obj.beta || obj.company_name
         || obj.dividend_yield || obj.roe || obj.day_change_pct || obj.price);
}

// ============================================================
// Phase 3.5: Eastmoney 港股 fundamentals（无需 API key，2 个 endpoint）
// 实测过 6 只港股全部跑通（0700/1211/1810/9992/2840/9660）
// 关键：HK 代码必须 5 位带前导 0（如 00700），node fetch 自动 follow 302
// ============================================================
const EASTMONEY_DC = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
const EASTMONEY_PUSH2 = 'https://push2.eastmoney.com/api/qt/stock/get';

// Yahoo .HK → Eastmoney 5位代码（0700.HK → 00700）
function yahooToEastmoneyHKCode(symbol) {
  const m = symbol.match(/^(\d+)\.HK$/i);
  if (!m) return null;
  return m[1].padStart(5, '0');
}

// 从 Eastmoney 字符串字段提取 number（"-" / null / "" → null）
function emNum(v) {
  if (v == null || v === '' || v === '-') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

async function fetchEastmoneyHKFundamentals(symbol) {
  const result = { symbol, source: 'eastmoney', raw_json: {} };
  const code5 = yahooToEastmoneyHKCode(symbol);
  if (!code5) throw new Error(`Invalid HK symbol: ${symbol}`);

  // ① 实时行情（push2）→ 价 / PE / PB / 市值 / 52W / 股息率 / 行业
  try {
    const fields = 'f43,f58,f60,f116,f127,f164,f167,f170,f174,f175,f188';
    const url = `${EASTMONEY_PUSH2}?invt=2&fltt=2&secid=116.${code5}&fields=${fields}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const x = json.data;
    if (x) {
      result.raw_json.quote = x;
      result.company_name   = x.f58 || null;
      result.price          = emNum(x.f43);
      result.day_change_pct = emNum(x.f170); // 已是 % 单位（与现有约定一致）
      result.pe_ratio       = emNum(x.f164);
      result.pb_ratio       = emNum(x.f167);
      result.market_cap     = emNum(x.f116);
      result.year_high      = emNum(x.f174);
      result.year_low       = emNum(x.f175);
      // f188 是百分比格式（0.39 = 0.39%），DB 约定 decimal（0.039 = 3.9%）→ ÷ 100
      const dyPct = emNum(x.f188);
      result.dividend_yield = dyPct != null ? dyPct / 100 : null;
      result.sector         = x.f127 && x.f127 !== '-' ? x.f127 : null;
      result.industry       = result.sector;
      result.country        = '香港';
      result.currency       = 'HKD';
      result.exchange       = 'HKEX';
      if (result.year_high && result.year_low) {
        result.range_52w = `${result.year_low} - ${result.year_high}`;
      }
    }
  } catch (e) { console.warn(`Eastmoney push2 failed for ${symbol}: ${e.message}`); }

  // ② 财务指标（datacenter）→ EPS / ROE / 毛利率 / 净利率 / 营收增长
  try {
    const params = new URLSearchParams({
      reportName: 'RPT_HKF10_FN_MAININDICATOR',
      columns: 'HKF10_FN_MAININDICATOR',
      pageNumber: '1',
      pageSize: '1',
      sortTypes: '-1',
      sortColumns: 'STD_REPORT_DATE',
      source: 'F10',
      client: 'PC',
      filter: `(SECUCODE="${code5}.HK")(DATE_TYPE_CODE="001")`,
    });
    const url = `${EASTMONEY_DC}?${params}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const rows = json?.result?.data;
    if (Array.isArray(rows) && rows.length > 0) {
      const r = rows[0];
      result.raw_json.financials = r;
      // EPS：优先 EPS_TTM
      result.eps = emNum(r.EPS_TTM) ?? emNum(r.BASIC_EPS) ?? emNum(r.DILUTED_EPS);
      // 百分比字段：÷100 转 decimal
      const roe = emNum(r.ROE_AVG);
      result.roe = roe != null ? roe / 100 : null;
      const gm = emNum(r.GROSS_PROFIT_RATIO);
      result.gross_margin = gm != null ? gm / 100 : null;
      const nm = emNum(r.NET_PROFIT_RATIO);
      result.net_margin = nm != null ? nm / 100 : null;
      // 营业利率：用 (营业利润/营收) 近似（Eastmoney 给 GROSS_PROFIT 是毛利不是营业利润，跳过）
    }
  } catch (e) { console.warn(`Eastmoney datacenter failed for ${symbol}: ${e.message}`); }

  tagAllFieldsWithSource(result, 'eastmoney');
  return result;
}

// ============================================================
// Phase 3: 按市场后缀路由到最优数据源
// US (no suffix / -, BRK-B 等) → Yahoo + FMP hybrid
// .SS / .SZ → Tushare 主源（A 股最权威），FMP 备源
// .HK → Eastmoney 主源（Phase 3.5 新增），Tushare/FMP 兜底
// .T → J-Quants 主源（JPX 官方），FMP 备源
// ============================================================
async function fetchFundamentalsByMarket(symbol) {
  const upper = symbol.toUpperCase();
  const hasTushare = !!process.env.TUSHARE_TOKEN;
  const hasJQuants = !!process.env.JQUANTS_API_KEY;

  // 日股 → J-Quants 主，FMP 兜底
  if (upper.endsWith('.T')) {
    if (hasJQuants) {
      try {
        const r = await fetchJQuantsFundamentals(symbol);
        if (hasSourceData(r)) return r;
      } catch (e) { console.warn(`[router] J-Quants ${symbol}: ${e.message}`); }
    }
    return fetchFundamentalsHybrid(symbol); // 兜底走 FMP
  }

  // A 股 → Tushare 主，FMP 兜底
  if (upper.endsWith('.SS') || upper.endsWith('.SZ')) {
    if (hasTushare) {
      try {
        const r = await fetchTushareFundamentals(symbol);
        if (hasSourceData(r)) return r;
      } catch (e) { console.warn(`[router] Tushare A股 ${symbol}: ${e.message}`); }
    }
    return fetchFundamentalsHybrid(symbol);
  }

  // HK → Eastmoney 主源（Phase 3.5），Tushare/FMP 兜底
  if (upper.endsWith('.HK')) {
    // 主：Eastmoney（无 API key 限制，覆盖 PE/PB/ROE/利润率/52W/股息率/市值）
    try {
      const r = await fetchEastmoneyHKFundamentals(symbol);
      if (hasSourceData(r)) return r;
    } catch (e) { console.warn(`[router] Eastmoney HK ${symbol}: ${e.message}`); }

    // 兜底：原 Tushare + FMP 融合（保留旧逻辑应对 Eastmoney 偶发故障）
    let tushareR = {};
    if (hasTushare) {
      try { tushareR = await fetchTushareFundamentals(symbol); }
      catch (e) { console.warn(`[router] Tushare HK ${symbol}: ${e.message}`); }
    }
    let fmpR = {};
    try { fmpR = await fetchFMPFundamentals(symbol); }
    catch (e) { /* ignore — FMP Free 可能不覆盖 HK */ }
    const merged = { symbol, source: 'tushare+fmp', raw_json: { tushare: tushareR.raw_json, fmp: fmpR.raw_json }, field_sources: {} };
    for (const k of Object.keys(tushareR)) {
      if (['symbol','source','raw_json','field_sources','discrepancies'].includes(k)) continue;
      if (tushareR[k] != null) {
        merged[k] = tushareR[k];
        merged.field_sources[k] = 'tushare';
      }
    }
    for (const k of Object.keys(fmpR)) {
      if (['symbol','source','raw_json','field_sources','discrepancies','_errors'].includes(k)) continue;
      if (fmpR[k] != null && merged[k] == null) {
        merged[k] = fmpR[k];
        merged.field_sources[k] = 'fmp';
      }
    }
    return merged;
  }

  // 默认（美股 / BRK-B / 其他）→ Yahoo + FMP 双源（已有逻辑）
  return fetchFundamentalsHybrid(symbol);
}

// Phase 2.3.2: Yahoo 默认启用（已切换到 v7/quote 主源 + v10 备源策略）
// v7/quote 与 chart endpoint 同级别限速，对 Render IP 友好
// 如需紧急禁用：Render 环境变量 ENABLE_YAHOO=false
const ENABLE_YAHOO = process.env.ENABLE_YAHOO !== 'false';

// 双源同时拉取 + 融合（Phase 2.3 主入口；空数据时抛带明细的错）
async function fetchFundamentalsHybrid(symbol) {
  const calls = ENABLE_YAHOO
    ? [fetchYahooFundamentals(symbol), fetchFMPFundamentals(symbol)]
    : [Promise.resolve({}), fetchFMPFundamentals(symbol)];
  const [yResult, fResult] = await Promise.allSettled(calls);
  const yahoo = yResult.status === 'fulfilled' ? yResult.value : {};
  const fmp   = fResult.status === 'fulfilled' ? fResult.value : {};

  // 记录每个源的状态（成功/失败原因）
  let yahooStatus, fmpStatus;
  if (yResult.status === 'rejected') {
    yahooStatus = `❌ ${yResult.reason?.message || 'unknown error'}`;
    console.warn(`[hybrid] ${symbol} Yahoo: ${yahooStatus}`);
  } else if (!hasSourceData(yahoo)) {
    yahooStatus = '⚠️ 返回空（无 market_cap/pe/eps 等关键字段）';
    console.warn(`[hybrid] ${symbol} Yahoo: 返回空数据`);
  } else {
    yahooStatus = '✅';
  }
  if (fResult.status === 'rejected') {
    fmpStatus = `❌ ${fResult.reason?.message || 'unknown error'}`;
    console.warn(`[hybrid] ${symbol} FMP: ${fmpStatus}`);
  } else if (!hasSourceData(fmp)) {
    fmpStatus = '⚠️ 返回空（5 个 endpoint 全无关键字段，可能是 Free 档不覆盖此市场）';
    console.warn(`[hybrid] ${symbol} FMP: 返回空数据`);
  } else {
    fmpStatus = '✅';
  }

  const merged = mergeWithCrossCheck(yahoo, fmp);
  merged.symbol = symbol;
  const ySrcOK = hasSourceData(yahoo);
  const fSrcOK = hasSourceData(fmp);
  merged.source = ySrcOK && fSrcOK ? 'yahoo+fmp' : (ySrcOK ? 'yahoo' : (fSrcOK ? 'fmp' : 'none'));
  merged.raw_json = {
    yahoo: yahoo.raw_json || null,
    fmp:   fmp.raw_json   || null,
  };

  // 双源都没拿到有意义数据 → 抛错带明细，让前端 first_error 能看到真因
  if (!ySrcOK && !fSrcOK) {
    throw new Error(`双源均无数据 [Yahoo ${yahooStatus}] [FMP ${fmpStatus}]`);
  }
  return merged;
}

// UPSERT 到 fundamentals_latest（Phase 2.2 防线：跳过空数据 + COALESCE 保护现有值）
// ===== 数据质量哨兵：标记明显异常的基本面值（多为数据源错误，如 TSM PE=5.3x）=====
function computeQualityFlags(d) {
  const flags = [];
  const txt = `${d.sector || ''} ${d.industry || ''}`.toLowerCase();
  const isFinancial = /金融|银行|保险|证券|bank|financ|insur|capital market/.test(txt);
  const pe = num(d.pe_ratio), roe = num(d.roe), nm = num(d.net_margin), pb = num(d.pb_ratio);
  // 非银行股 PE < 5 极可能是数据错（如 TSM 误报 5.3x）
  if (pe != null && pe > 0 && pe < 5 && !isFinancial) flags.push({ field: 'pe_ratio', value: pe, reason: '非金融股 PE<5，疑数据源错误' });
  if (pe != null && pe > 1000) flags.push({ field: 'pe_ratio', value: pe, reason: 'PE>1000，疑异常' });
  // ROE 可能以小数或百分数存，>80(%) 或 >0.8 都标
  if (roe != null && (roe > 80 || (roe > 0.8 && roe <= 1.5)) ) flags.push({ field: 'roe', value: roe, reason: 'ROE 过高，疑单位/数据错误' });
  if (nm != null && (nm > 90 || (nm > 0.9 && nm <= 1.5))) flags.push({ field: 'net_margin', value: nm, reason: '净利率过高，疑数据错误' });
  if (pb != null && pb < 0) flags.push({ field: 'pb_ratio', value: pb, reason: 'PB 为负，疑数据错误' });
  return flags;
  function num(v){ const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
}

async function saveFundamentalsToDB(d) {
  // 数据质量哨兵：算出可疑字段，连同数据一起存（前端可显示 ⚠️）
  d.quality_flags = computeQualityFlags(d);
  if (d.quality_flags.length) {
    console.warn(`[quality] ${d.symbol}: ${d.quality_flags.map(f => f.field + '=' + f.value).join(', ')}`);
  }
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
      field_sources, discrepancies, quality_flags,
      source, fetched_at, raw_json
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
      $20,$21,$22,$23,$24,$25,$26,$27,$28,
      $29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
      $41,$42,$43,
      $44,NOW(),$45
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
      quality_flags  = EXCLUDED.quality_flags,
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
    JSON.stringify(d.quality_flags || []),
    d.source, JSON.stringify(d.raw_json || {})
  ]);

  // ⭐ 5年历史(2026-05-27):J-Quants 返回的 FY 年报序列存进 fundamentals 历史表
  //（仅 J-Quants 设 fy_history;其他源不设此字段 → 不受影响。每行 try/catch 隔离,失败不影响主存储）
  if (Array.isArray(d.fy_history) && d.fy_history.length) {
    for (const fy of d.fy_history) {
      try {
        await pool.query(`
          INSERT INTO fundamentals (
            symbol, period_end, period_type, currency,
            revenue, operating_income, net_income, eps,
            total_assets, total_equity, source, fetched_at
          ) VALUES ($1,$2,'FY',$3,$4,$5,$6,$7,$8,$9,$10,NOW())
          ON CONFLICT (symbol, period_end, period_type) DO UPDATE SET
            currency         = EXCLUDED.currency,
            revenue          = COALESCE(EXCLUDED.revenue,          fundamentals.revenue),
            operating_income = COALESCE(EXCLUDED.operating_income, fundamentals.operating_income),
            net_income       = COALESCE(EXCLUDED.net_income,       fundamentals.net_income),
            eps              = COALESCE(EXCLUDED.eps,              fundamentals.eps),
            total_assets     = COALESCE(EXCLUDED.total_assets,     fundamentals.total_assets),
            total_equity     = COALESCE(EXCLUDED.total_equity,     fundamentals.total_equity),
            source           = EXCLUDED.source,
            fetched_at       = NOW()
        `, [
          d.symbol, fy.period_end, fy.currency || d.currency,
          fy.revenue, fy.operating_income, fy.net_income, fy.eps,
          fy.total_assets, fy.total_equity, d.source || 'jquants'
        ]);
      } catch (e) {
        console.warn(`[fund-history] ${d.symbol} ${fy.period_end}: ${e.message}`);
      }
    }
  }
}

// Phase 2.3 调试 endpoint：单独测试 Yahoo / FMP 单源（公开访问，仅供诊断用）
app.get("/api/debug/source/:source/:symbol", async (req, res) => {
  const source = req.params.source;
  const symbol = req.params.symbol.trim().toUpperCase();
  const fn = source === 'yahoo' ? fetchYahooFundamentals
           : source === 'fmp'   ? fetchFMPFundamentals
           : null;
  if (!fn) return res.status(400).json({ error: 'source must be yahoo or fmp' });
  try {
    const result = await fn(symbol);
    const populatedKeys = Object.keys(result).filter(k =>
      k !== 'symbol' && k !== 'source' && k !== 'raw_json' && result[k] != null
    );
    res.json({
      ok: true,
      source, symbol,
      populated_field_count: populatedKeys.length,
      populated_keys: populatedKeys,
      sample_values: {
        market_cap: result.market_cap,
        pe_ratio: result.pe_ratio,
        eps: result.eps,
        beta: result.beta,
        company_name: result.company_name,
        sector: result.sector,
        country: result.country,
      },
    });
  } catch (e) {
    res.json({ ok: false, source, symbol, error: e.message, stack: e.stack?.split('\n').slice(0, 4).join(' | ') });
  }
});

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
    const fresh = await fetchFundamentalsByMarket(symbol);
    await saveFundamentalsToDB(fresh);
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

// POST /api/fundamentals/refresh/:symbol — 强制刷新一只（按市场路由到最优源）
app.post("/api/fundamentals/refresh/:symbol", auth, async (req, res) => {
  const symbol = req.params.symbol.trim().toUpperCase();
  try {
    const data = await fetchFundamentalsByMarket(symbol);
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
      sources: { 'yahoo+fmp': 0, yahoo: 0, fmp: 0, tushare: 0, jquants: 0, eastmoney: 0, 'tushare+fmp': 0 },
      total_discrepancies: 0,
      first_error: null,  // Phase 2.3 调试：暴露首个失败的具体原因
    };
    for (const row of r.rows) {
      try {
        const data = await fetchFundamentalsByMarket(row.symbol);
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

// ============ Portfolio As-Of (Historical Snapshot) ============
// 给定一个历史日期，重建那天的持仓 + 那天的收盘价 → 用于"资产占比"模态框选择历史日期

// 回放交易记录算出某日的 qty 和 avg_cost（每个 symbol 一行）
async function getHoldingsAsOf(userId, dateStr) {
  // 取该用户所有交易（在该日及之前），按时间顺序回放
  const tRes = await pool.query(
    `SELECT t.symbol, t.type, t.qty, t.price, t.date,
            h.name, h.region, h.currency, h.attribute, h.sector
       FROM trades t
       LEFT JOIN holdings h ON h.user_id = t.user_id AND h.symbol = t.symbol
      WHERE t.user_id = $1 AND t.date <= $2
      ORDER BY t.date ASC, t.created_at ASC`,
    [userId, dateStr]
  );

  const acc = {}; // { symbol: { qty, totalCost, name, region, currency, attribute, sector } }
  for (const t of tRes.rows) {
    const sym = t.symbol;
    if (!acc[sym]) acc[sym] = {
      symbol: sym, qty: 0, totalCost: 0,
      name: t.name || sym, region: t.region || '',
      currency: t.currency || 'USD',
      attribute: t.attribute || '', sector: t.sector || '',
    };
    const a = acc[sym];
    const isBuy = t.type === '买入' || t.type === 'BUY';
    const isDiv = t.type === '分红' || t.type === 'DIVIDEND';
    if (isBuy) {
      a.qty += +t.qty;
      a.totalCost += +t.qty * +t.price;
    } else if (!isDiv) {
      // 卖出：减仓位但 avg_cost 不变（基于剩余持仓的单位成本）
      const remainingRatio = a.qty > 0 ? Math.max(0, (a.qty - +t.qty)) / a.qty : 0;
      a.totalCost = a.totalCost * remainingRatio;
      a.qty = Math.max(0, a.qty - +t.qty);
    }
  }
  return Object.values(acc).map(a => ({
    ...a,
    avg_cost: a.qty > 0 ? a.totalCost / a.qty : 0,
  }));
}

// 取一只股票在某日的收盘价（命中缓存优先，否则向 Yahoo 拉一段时间窗口并缓存）
async function getCachedHistoricalPrice(symbol, dateStr) {
  // 1) 命中缓存
  const cached = await pool.query(
    `SELECT close_price, currency, market_tz FROM anchor_prices
      WHERE symbol = $1 AND anchor_date = $2 LIMIT 1`,
    [symbol, dateStr]
  );
  if (cached.rows.length > 0) {
    return { ...cached.rows[0], source: 'cache' };
  }
  // 2) 拉 Yahoo：覆盖 dateStr 前后各 10 天，落到的所有交易日全部入库
  const targetUnix = Math.floor(new Date(`${dateStr}T12:00:00Z`).getTime() / 1000);
  const startUnix = targetUnix - 10 * 86400;
  const endUnix   = targetUnix + 10 * 86400;
  const { meta, timestamps, closes } = await fetchYahooHistorical(symbol, startUnix, endUnix);
  const tz = meta.exchangeTimezoneName || 'America/New_York';
  const cur = meta.currency || 'USD';

  // 一次性写入所有拿到的交易日（多日缓存命中率提升）
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    const d = dateInTZ(timestamps[i], tz);
    await pool.query(
      `INSERT INTO anchor_prices (symbol, anchor_date, close_price, currency, market_tz, source, fetched_at)
       VALUES ($1, $2, $3, $4, $5, 'Yahoo', NOW())
       ON CONFLICT (symbol, anchor_date) DO NOTHING`,
      [symbol, d, closes[i], cur, tz]
    );
  }
  // 3) 找 dateStr 本身或最近一个早于 dateStr 的交易日
  let bestIdx = -1, bestDate = '';
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    const d = dateInTZ(timestamps[i], tz);
    if (d <= dateStr && d > bestDate) { bestDate = d; bestIdx = i; }
  }
  if (bestIdx < 0) return null;
  return { close_price: closes[bestIdx], currency: cur, market_tz: tz, source: 'yahoo', actual_date: bestDate };
}

// 取某日的 FX rates（优先从 daily_snapshot 拿，没有就用当前内存里的）
async function getFxRatesAsOf(userId, dateStr) {
  const r = await pool.query(
    `SELECT fx_rates FROM daily_snapshot WHERE user_id = $1 AND date = $2 LIMIT 1`,
    [userId, dateStr]
  );
  if (r.rows.length > 0 && r.rows[0].fx_rates) return r.rows[0].fx_rates;
  return fxRates; // 退到当前实时
}

// GET /api/portfolio-asof?date=YYYY-MM-DD — 重建某日组合
app.get("/api/portfolio-asof", auth, async (req, res) => {
  try {
    const date = String(req.query.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }
    // 上限：今天；下限：放宽到 2024-01-01（再往前 Yahoo 数据不一定有）
    const today = new Date().toISOString().slice(0, 10);
    if (date > today) return res.status(400).json({ error: "date cannot be in the future" });
    if (date < '2024-01-01') return res.status(400).json({ error: "date too far in the past (>2024-01-01)" });

    const holdings = await getHoldingsAsOf(req.userId, date);
    const active = holdings.filter(h => h.qty > 0);
    const fx_rates = await getFxRatesAsOf(req.userId, date);

    // 并发拉历史价（每只 200ms 间隔，避免 Yahoo 限流）
    const results = [];
    const failures = [];
    for (const h of active) {
      try {
        const p = await getCachedHistoricalPrice(h.symbol, date);
        if (p && p.close_price > 0) {
          results.push({ ...h, price: p.close_price, price_currency: p.currency, price_source: p.source, price_actual_date: p.actual_date || date });
        } else {
          failures.push({ symbol: h.symbol, reason: 'no_close' });
          results.push({ ...h, price: h.avg_cost, price_source: 'fallback_avgcost' });
        }
      } catch (e) {
        failures.push({ symbol: h.symbol, reason: e.message });
        results.push({ ...h, price: h.avg_cost, price_source: 'fallback_avgcost' });
      }
      await new Promise(r => setTimeout(r, 150));
    }

    res.json({ date, holdings: results, fx_rates, failures });
  } catch (e) {
    console.error("/api/portfolio-asof error:", e.message);
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
        try { await checkAndNotifyAlerts(pool, fetchYahooQuotes, u.id); } // A2 价格告警邮件
        catch (ne) { console.error("Alert notify failed for user " + u.id + ":", ne.message); }
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

// ===== Read-only holdings export (凯旋门大师论道分析用) =====
// Auth: header "x-cron-token" 或 query "?token=" 必须等于 CRON_SECRET。
// 只读、不可写;给 Claude 大师论道自动拉当前持仓用。token 可随时在 Render 改。
app.get("/api/cron/holdings", async (req, res) => {
  const token = req.headers["x-cron-token"] || req.query.token;
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: "CRON_SECRET not configured on server" });
  }
  if (!token || token !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid token" });
  }
  try {
    // 单用户 App(LiuBin)——取主用户
    const u = await pool.query("SELECT id FROM users ORDER BY id LIMIT 1");
    if (u.rows.length === 0) return res.json({ generated_at: new Date().toISOString(), holdings_active: [], holdings_sold: [] });
    const userId = u.rows[0].id;
    const r = await pool.query(
      "SELECT symbol,name,qty,avg_cost,currency,market,region,attribute,sector,target_weight FROM holdings WHERE user_id=$1 ORDER BY id",
      [userId]
    );
    const rows = r.rows.map(h => ({ ...h, is_sold: !(h.qty > 0) }));
    res.json({
      generated_at: new Date().toISOString(),
      user_id: userId,
      count_active: rows.filter(h => !h.is_sold).length,
      holdings_active: rows.filter(h => !h.is_sold),
      holdings_sold: rows.filter(h => h.is_sold).map(h => h.symbol)
    });
  } catch (e) {
    console.error("Holdings export error:", e.message);
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

// ============================================================
// 每日基本面刷新 cron（AI 日报已于 2026-05-27 整体移除）
// - cron/fundamentals-refresh @ 8:55am Beijing → 强制刷新所有持仓基本面
//   (保持组合页 / 分析页的 PE/ROE 等数据新鲜)
// ============================================================

// 强 cron token 校验（与现有 snapshot cron 一致）
function checkCronToken(req, res) {
  const token = req.headers['x-cron-token'];
  if (!process.env.CRON_SECRET) {
    res.status(500).json({ error: 'CRON_SECRET not configured on server' });
    return false;
  }
  if (!token || token !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Invalid cron token' });
    return false;
  }
  return true;
}

// ===== 1. cron/fundamentals-refresh ======================
// 每天 8:55am Beijing 跑，让 AI 报告读到当天最新 PE/ROE/财报
// 立刻返回 200（避免 cron-job.org 30s 超时），后台跑实际工作
async function runFundamentalsRefresh() {
  const startedAt = Date.now();
  try {
    const userRows = await pool.query('SELECT DISTINCT user_id FROM holdings WHERE qty > 0');
    const summary = { users: 0, ok: 0, failed: [] };
    for (const u of userRows.rows) {
      const symRows = await pool.query(
        'SELECT DISTINCT symbol FROM holdings WHERE user_id=$1 AND qty > 0',
        [u.user_id]
      );
      summary.users++;
      for (const s of symRows.rows) {
        try {
          const data = await fetchFundamentalsByMarket(s.symbol);
          await saveFundamentalsToDB(data);
          summary.ok++;
        } catch (e) {
          summary.failed.push({ symbol: s.symbol, error: e.message });
          console.warn(`[cron-fund] ❌ ${s.symbol}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }
    const dur = Math.round((Date.now() - startedAt) / 1000);
    console.log(`✅ Cron fundamentals refresh done in ${dur}s: ${summary.ok} ok, ${summary.failed.length} failed across ${summary.users} user(s)`);
  } catch (e) {
    console.error('runFundamentalsRefresh error:', e.message);
  }
}

app.post('/api/cron/fundamentals-refresh', async (req, res) => {
  if (!checkCronToken(req, res)) return;
  // 立刻 200 给 cron-job.org，避免 30s 超时
  res.json({ ok: true, message: 'Fundamentals refresh started in background' });
  // 后台跑（fire-and-forget）
  runFundamentalsRefresh().catch(e => console.error('Background fund refresh:', e.message));
});



// ===== 启动 =====
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initDB();
    await autoSeed();
    await patchHoldings202607();
    app.listen(PORT, () => console.log(`Arc Patrimony 服务器已启动: http://localhost:${PORT}`));
    // Take today's snapshot ~30s after startup (let FX rates load first; fire-and-forget)
    setTimeout(() => { maybeStartupSnapshot(); }, 30000);
  } catch (e) {
    console.error("启动失败:", e.message);
    process.exit(1);
  }
}

startServer();
