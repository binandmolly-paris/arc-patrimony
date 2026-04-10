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

// ===== 自动初始化 LiuBin 用户 =====
(function autoSeed() {
  const userCount = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  if (userCount > 0) return console.log("数据库已有用户，跳过初始化");
  console.log("首次启动，自动初始化 LiuBin 用户...");
  const pw = bcrypt.hashSync("123456", 10);
  const r = db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run("LiuBin", pw);
  const uid = r.lastInsertRowid;
  const holdings = [
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
  const iH = db.prepare("INSERT INTO holdings (user_id,symbol,name,qty,avg_cost,currency,market,region,attribute,sector) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const iT = db.prepare("INSERT INTO trades (user_id,symbol,name,type,qty,price,fee,date) VALUES (?,?,?,?,?,?,?,?)");
  const tx = db.transaction(() => {
    const today = new Date().toISOString().slice(0,10);
    holdings.forEach(h => {
      iH.run(uid,h.s,h.n,h.q,h.c,h.cur,h.m,h.r,h.a,h.sec);
      iT.run(uid,h.s,h.n,"买入",h.q,h.c,0,today);
    });
  });
  tx();
  console.log("✅ 自动初始化完成: LiuBin + " + holdings.length + " 只股票");
})();

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
