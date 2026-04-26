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
  `);
  console.log("✅ 数据库表已就绪");
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
app.get("/api/export", auth, async (req, res) => {
  try {
    const holdRes = await pool.query("SELECT symbol,name,qty,avg_cost,currency,market,region,attribute,sector FROM holdings WHERE user_id=$1 AND qty>0", [req.userId]);
    const tradeRes = await pool.query("SELECT symbol,name,type,qty,price,fee,date FROM trades WHERE user_id=$1", [req.userId]);
    const alertRes = await pool.query("SELECT symbol,name,condition,price,active FROM alerts WHERE user_id=$1", [req.userId]);
    res.json({ holdings: holdRes.rows, trades: tradeRes.rows, alerts: alertRes.rows, exported_at: new Date().toISOString() });
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

// ===== 启动 =====
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initDB();
    await autoSeed();
    app.listen(PORT, () => console.log(`Arc Patrimony 服务器已启动: http://localhost:${PORT}`));
  } catch (e) {
    console.error("启动失败:", e.message);
    process.exit(1);
  }
}

startServer();
