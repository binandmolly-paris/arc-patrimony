const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== 数据库初始化 =====
const dbPath = path.join(__dirname, ".data", "invest.db");
const fs = require("fs");
if (!fs.existsSync(path.join(__dirname, ".data"))) fs.mkdirSync(path.join(__dirname, ".data"));

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    UNIQUE(user_id, symbol)
  );
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT,
    type TEXT NOT NULL,
    qty REAL NOT NULL,
    price REAL NOT NULL,
    fee REAL DEFAULT 0,
    date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT,
    condition TEXT NOT NULL,
    price REAL NOT NULL,
    active INTEGER DEFAULT 1
  );
`);

// ===== 简易Session管理 =====
const sessions = {};
function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions[token] = { userId, created: Date.now() };
  return token;
}
function auth(req, res, next) {
  const token = req.headers["x-token"];
  if (!token || !sessions[token]) return res.status(401).json({ error: "请先登录" });
  req.userId = sessions[token].userId;
  next();
}

// ===== 用户认证 =====
app.post("/api/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "请输入用户名和密码" });
  if (password.length < 4) return res.status(400).json({ error: "密码至少4位" });
  const existing = db.prepare("SELECT id FROM users WHERE username=?").get(username);
  if (existing) return res.status(400).json({ error: "用户名已存在" });
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run(username, hash);
  const token = createSession(result.lastInsertRowid);
  res.json({ token, username, userId: result.lastInsertRowid });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username=?").get(username);
  if (!user) return res.status(400).json({ error: "用户不存在" });
  if (!bcrypt.compareSync(password, user.password)) return res.status(400).json({ error: "密码错误" });
  const token = createSession(user.id);
  res.json({ token, username: user.username, userId: user.id });
});

app.post("/api/logout", (req, res) => {
  const token = req.headers["x-token"];
  if (token) delete sessions[token];
  res.json({ ok: true });
});

// ===== 持仓 =====
app.get("/api/holdings", auth, (req, res) => {
  const rows = db.prepare("SELECT * FROM holdings WHERE user_id=? AND qty>0 ORDER BY id").all(req.userId);
  res.json(rows);
});

app.post("/api/holdings", auth, (req, res) => {
  const { symbol, name, qty, avg_cost, currency, market, region, attribute, sector } = req.body;
  db.prepare(`INSERT INTO holdings (user_id,symbol,name,qty,avg_cost,currency,market,region,attribute,sector)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,symbol) DO UPDATE SET
    name=excluded.name, qty=excluded.qty, avg_cost=excluded.avg_cost, currency=excluded.currency,
    market=excluded.market, region=excluded.region, attribute=excluded.attribute, sector=excluded.sector`)
    .run(req.userId, symbol, name, qty, avg_cost, currency || "USD", market, region, attribute, sector);
  res.json({ ok: true });
});

// ===== 交易 =====
app.get("/api/trades", auth, (req, res) => {
  const rows = db.prepare("SELECT * FROM trades WHERE user_id=? ORDER BY date DESC, id DESC").all(req.userId);
  res.json(rows);
});

app.post("/api/trade", auth, (req, res) => {
  const { symbol, name, type, qty, price, fee, date, currency, market, region, attribute, sector } = req.body;
  if (!symbol || !qty || !price || !type || !date) return res.status(400).json({ error: "请填写完整信息" });

  db.prepare("INSERT INTO trades (user_id,symbol,name,type,qty,price,fee,date) VALUES (?,?,?,?,?,?,?,?)")
    .run(req.userId, symbol, name || "", type, qty, price, fee || 0, date);

  // 更新持仓
  const h = db.prepare("SELECT * FROM holdings WHERE user_id=? AND symbol=?").get(req.userId, symbol);
  if (type === "买入") {
    if (h) {
      const totalQty = h.qty + qty;
      const newAvg = (h.qty * h.avg_cost + qty * price) / totalQty;
      db.prepare("UPDATE holdings SET qty=?, avg_cost=? WHERE id=?").run(totalQty, Math.round(newAvg * 100) / 100, h.id);
    } else {
      db.prepare(`INSERT INTO holdings (user_id,symbol,name,qty,avg_cost,currency,market,region,attribute,sector)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(req.userId, symbol, name || "", qty, price, currency || "USD", market || "", region || "", attribute || "", sector || "");
    }
  } else if (type === "卖出") {
    if (h) {
      const remain = h.qty - qty;
      if (remain <= 0) db.prepare("UPDATE holdings SET qty=0 WHERE id=?").run(h.id);
      else db.prepare("UPDATE holdings SET qty=? WHERE id=?").run(remain, h.id);
    }
  }
  res.json({ ok: true });
});

// ===== 提醒 =====
app.get("/api/alerts", auth, (req, res) => {
  res.json(db.prepare("SELECT * FROM alerts WHERE user_id=?").all(req.userId));
});

app.post("/api/alert", auth, (req, res) => {
  const { symbol, name, condition, price } = req.body;
  db.prepare("INSERT INTO alerts (user_id,symbol,name,condition,price) VALUES (?,?,?,?,?)")
    .run(req.userId, symbol, name || "", condition, price);
  res.json({ ok: true });
});

app.put("/api/alert/:id", auth, (req, res) => {
  const { active } = req.body;
  db.prepare("UPDATE alerts SET active=? WHERE id=? AND user_id=?").run(active ? 1 : 0, req.params.id, req.userId);
  res.json({ ok: true });
});

app.delete("/api/alert/:id", auth, (req, res) => {
  db.prepare("DELETE FROM alerts WHERE id=? AND user_id=?").run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ===== 实时股价 (Yahoo Finance) =====
let yahooFinance;
try { yahooFinance = require("yahoo-finance2").default; } catch (e) { console.log("yahoo-finance2 not loaded"); }

const priceCache = {};
const CACHE_TTL = 30000; // 30秒缓存

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

  if (toFetch.length > 0 && yahooFinance) {
    try {
      const quotes = await yahooFinance.quote(toFetch);
      const arr = Array.isArray(quotes) ? quotes : [quotes];
      arr.forEach(q => {
        if (q && q.symbol) {
          const data = {
            price: q.regularMarketPrice || 0,
            prevClose: q.regularMarketPreviousClose || 0,
            change: q.regularMarketChangePercent || 0,
            currency: q.currency || "USD",
            name: q.shortName || q.longName || q.symbol,
            market: q.exchange || "",
          };
          priceCache[q.symbol] = { data, ts: Date.now() };
          results[q.symbol] = data;
        }
      });
    } catch (err) {
      console.error("Yahoo Finance error:", err.message);
      // 返回已缓存的数据
    }
  }

  res.json(results);
});

// ===== 批量导入持仓 =====
app.post("/api/import-holdings", auth, (req, res) => {
  const { holdings: list } = req.body;
  if (!Array.isArray(list)) return res.status(400).json({ error: "数据格式错误" });

  const stmt = db.prepare(`INSERT INTO holdings (user_id,symbol,name,qty,avg_cost,currency,market,region,attribute,sector)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,symbol) DO UPDATE SET
    name=excluded.name, qty=excluded.qty, avg_cost=excluded.avg_cost, currency=excluded.currency,
    market=excluded.market, region=excluded.region, attribute=excluded.attribute, sector=excluded.sector`);

  const tx = db.transaction(() => {
    list.forEach(h => {
      stmt.run(req.userId, h.symbol, h.name || "", h.qty || 0, h.avg_cost || 0,
        h.currency || "USD", h.market || "", h.region || "", h.attribute || "", h.sector || "");
    });
  });
  tx();
  res.json({ ok: true, count: list.length });
});

// ===== 数据导出 =====
app.get("/api/export", auth, (req, res) => {
  const holdings = db.prepare("SELECT symbol,name,qty,avg_cost,currency,market,region,attribute,sector FROM holdings WHERE user_id=? AND qty>0").all(req.userId);
  const trades = db.prepare("SELECT symbol,name,type,qty,price,fee,date FROM trades WHERE user_id=?").all(req.userId);
  const alerts = db.prepare("SELECT symbol,name,condition,price,active FROM alerts WHERE user_id=?").all(req.userId);
  res.json({ holdings, trades, alerts, exported_at: new Date().toISOString() });
});

// ===== 启动 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Arc Patrimony 服务器已启动: http://localhost:${PORT}`));
