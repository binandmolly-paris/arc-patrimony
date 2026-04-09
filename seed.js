/**
 * 初始化脚本 - 创建 LiuBin 用户并录入持仓数据
 * 运行方式: node seed.js
 */
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, ".data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new Database(path.join(dataDir, "invest.db"));
db.pragma("journal_mode = WAL");

// 建表
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

// ===== 创建用户 LiuBin =====
const password = bcrypt.hashSync("123456", 10); // 默认密码 123456，请登录后修改
const existing = db.prepare("SELECT id FROM users WHERE username=?").get("LiuBin");
let userId;
if (existing) {
  userId = existing.id;
  console.log("用户 LiuBin 已存在，ID:", userId);
} else {
  const result = db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run("LiuBin", password);
  userId = result.lastInsertRowid;
  console.log("创建用户 LiuBin，ID:", userId);
}

// ===== 清空现有持仓（重新录入）=====
db.prepare("DELETE FROM holdings WHERE user_id=?").run(userId);
db.prepare("DELETE FROM trades WHERE user_id=?").run(userId);

// ===== 持仓数据（来自截图）=====
const holdings = [
  // === 中国 ===
  { symbol: "300750.SZ", name: "宁德时代", qty: 1000, avg_cost: 353.26, currency: "CNY", market: "深圳", region: "中国", attribute: "进攻", sector: "新能源" },
  { symbol: "1211.HK",   name: "比亚迪股份", qty: 500, avg_cost: 102.28, currency: "HKD", market: "香港", region: "中国", attribute: "进攻", sector: "汽车" },
  { symbol: "1810.HK",   name: "小米集团", qty: 4000, avg_cost: 33.22, currency: "HKD", market: "香港", region: "中国", attribute: "进攻", sector: "科技" },
  { symbol: "9992.HK",   name: "泡泡玛特", qty: 200, avg_cost: 147.57, currency: "HKD", market: "香港", region: "中国", attribute: "进攻", sector: "消费" },
  { symbol: "300760.SZ", name: "迈瑞医疗", qty: 1200, avg_cost: 160.65, currency: "CNY", market: "深圳", region: "中国", attribute: "进攻", sector: "医疗" },
  { symbol: "600036.SS", name: "招商银行", qty: 13300, avg_cost: 38.60, currency: "CNY", market: "上海", region: "中国", attribute: "防守", sector: "金融" },
  { symbol: "PDD",       name: "拼多多", qty: 510, avg_cost: 99.56, currency: "USD", market: "纳斯达克", region: "中国", attribute: "进攻/防守", sector: "电商" },
  { symbol: "TCOM",      name: "携程集团", qty: 500, avg_cost: 55.09, currency: "USD", market: "纳斯达克", region: "中国", attribute: "进攻", sector: "旅游" },
  { symbol: "BABA",      name: "阿里巴巴", qty: 100, avg_cost: 125.08, currency: "USD", market: "纽约", region: "中国", attribute: "进攻", sector: "科技" },

  // === 日本 ===
  { symbol: "7203.T",  name: "丰田汽车", qty: 200, avg_cost: 3190, currency: "JPY", market: "东京", region: "日本", attribute: "进攻", sector: "汽车" },
  { symbol: "6501.T",  name: "日立制作所", qty: 200, avg_cost: 4447, currency: "JPY", market: "东京", region: "日本", attribute: "进攻", sector: "电子" },
  { symbol: "8035.T",  name: "东京电子", qty: 100, avg_cost: 37510, currency: "JPY", market: "东京", region: "日本", attribute: "进攻", sector: "半导体" },
  { symbol: "4063.T",  name: "信越化学", qty: 200, avg_cost: 6040, currency: "JPY", market: "东京", region: "日本", attribute: "进攻", sector: "化学" },
  { symbol: "8306.T",  name: "三菱日联金融集团", qty: 1300, avg_cost: 2603, currency: "JPY", market: "东京", region: "日本", attribute: "防守", sector: "金融" },
  { symbol: "8001.T",  name: "伊藤忠商事", qty: 1200, avg_cost: 2030, currency: "JPY", market: "东京", region: "日本", attribute: "防守", sector: "贸易" },
  { symbol: "8058.T",  name: "三菱商事", qty: 500, avg_cost: 5476, currency: "JPY", market: "东京", region: "日本", attribute: "防守", sector: "贸易" },
  { symbol: "8766.T",  name: "东京海上", qty: 200, avg_cost: 7191, currency: "JPY", market: "东京", region: "日本", attribute: "防守", sector: "保险" },
  { symbol: "8316.T",  name: "三井住友金融", qty: 200, avg_cost: 5015, currency: "JPY", market: "东京", region: "日本", attribute: "防守", sector: "金融" },
  { symbol: "8031.T",  name: "三井物产", qty: 300, avg_cost: 6280, currency: "JPY", market: "东京", region: "日本", attribute: "防守", sector: "贸易" },
  { symbol: "8053.T",  name: "住友商事", qty: 100, avg_cost: 5734, currency: "JPY", market: "东京", region: "日本", attribute: "防守", sector: "贸易" },
  { symbol: "8002.T",  name: "丸红", qty: 500, avg_cost: 5413, currency: "JPY", market: "东京", region: "日本", attribute: "防守", sector: "贸易" },

  // === 美国 ===
  { symbol: "MSFT",   name: "微软", qty: 250, avg_cost: 435.10, currency: "USD", market: "纳斯达克", region: "美国", attribute: "进攻", sector: "科技" },
  { symbol: "GOOGL",  name: "谷歌", qty: 109, avg_cost: 300.87, currency: "USD", market: "纳斯达克", region: "美国", attribute: "进攻", sector: "科技" },
  { symbol: "NVDA",   name: "英伟达", qty: 300, avg_cost: 186.35, currency: "USD", market: "纳斯达克", region: "美国", attribute: "进攻", sector: "半导体" },
  { symbol: "AAPL",   name: "苹果", qty: 100, avg_cost: 255.08, currency: "USD", market: "纳斯达克", region: "美国", attribute: "进攻", sector: "科技" },
  { symbol: "AMZN",   name: "亚马逊", qty: 150, avg_cost: 226.44, currency: "USD", market: "纳斯达克", region: "美国", attribute: "进攻", sector: "科技" },
  { symbol: "AVGO",   name: "博通", qty: 100, avg_cost: 291.41, currency: "USD", market: "纳斯达克", region: "美国", attribute: "进攻", sector: "半导体" },
  { symbol: "INTC",   name: "英特尔", qty: 300, avg_cost: 44.53, currency: "USD", market: "纳斯达克", region: "美国", attribute: "择时出货", sector: "半导体" },
  { symbol: "TSM",    name: "台积电", qty: 100, avg_cost: 314.66, currency: "USD", market: "纽约", region: "美国", attribute: "进攻", sector: "半导体" },
  { symbol: "MU",     name: "美光", qty: 160, avg_cost: 348.91, currency: "USD", market: "纳斯达克", region: "美国", attribute: "择时出货", sector: "半导体" },
  { symbol: "NFLX",   name: "Netflix", qty: 50, avg_cost: 81.16, currency: "USD", market: "纳斯达克", region: "美国", attribute: "持有", sector: "流媒体" },
  { symbol: "PLTR",   name: "Palantir", qty: 150, avg_cost: 138.64, currency: "USD", market: "纳斯达克", region: "美国", attribute: "进攻", sector: "AI/数据" },
  { symbol: "PANW",   name: "Palo Alto", qty: 50, avg_cost: 172.66, currency: "USD", market: "纳斯达克", region: "美国", attribute: "进攻", sector: "网络安全" },
  { symbol: "BRK-B",  name: "伯克希尔哈撑韦", qty: 100, avg_cost: 467.68, currency: "USD", market: "纽约", region: "美国", attribute: "防守", sector: "金融" },
  { symbol: "V",      name: "Visa", qty: 100, avg_cost: 296.08, currency: "USD", market: "纽约", region: "美国", attribute: "防守", sector: "金融" },
  { symbol: "UNH",    name: "联合健康", qty: 100, avg_cost: 256.58, currency: "USD", market: "纽约", region: "美国", attribute: "防守", sector: "医疗" },
];

// ===== 插入持仓 =====
const insertHolding = db.prepare(`INSERT INTO holdings (user_id,symbol,name,qty,avg_cost,currency,market,region,attribute,sector)
  VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,symbol) DO UPDATE SET
  name=excluded.name, qty=excluded.qty, avg_cost=excluded.avg_cost, currency=excluded.currency,
  market=excluded.market, region=excluded.region, attribute=excluded.attribute, sector=excluded.sector`);

const insertTrade = db.prepare(`INSERT INTO trades (user_id,symbol,name,type,qty,price,fee,date) VALUES (?,?,?,?,?,?,?,?)`);

const tx = db.transaction(() => {
  const today = new Date().toISOString().slice(0, 10);
  holdings.forEach(h => {
    insertHolding.run(userId, h.symbol, h.name, h.qty, h.avg_cost, h.currency, h.market, h.region, h.attribute, h.sector);
    // 同时创建买入交易记录
    insertTrade.run(userId, h.symbol, h.name, "买入", h.qty, h.avg_cost, 0, today);
  });
});
tx();

console.log(`\n✅ 成功录入 ${holdings.length} 只股票到用户 LiuBin 的账户`);
console.log("\n📋 持仓概要:");
console.log("  中国: 宁德时代、比亪迪、小米、泡泡玛特、迈瑞医疗、招商银行、拼多多、携程、阿里巴巴");
console.log("  日本: 丰田、日立、东京电子、信越化学、三菱日联、伊藤忠、三菱商事、东京海上、三井住友、三井物产、住友商事、丸红");
console.log("  美国: 微软、谷歌、英伟达、苹果、亚马逊、博通、英特尔、台积电、美光、Netflix、Palantir、Palo Alto、伯克希尔、Visa、联合健康");
console.log(`\n🔑 登录信息: 用户名=LiuBin  密码=123456`);
console.log("⚠️  请登录后尽快修改密码！\n");

db.close();
