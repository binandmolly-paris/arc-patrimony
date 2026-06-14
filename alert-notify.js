// alert-notify.js — Arc Patrimony · 价格告警邮件通知(A2,2026-06-14)
// ─────────────────────────────────────────────────────────────────────────
// 解决:App 设了价格告警,达到价格时后端从不主动通知(无邮件/推送)。
// 本模块在每日 snapshot cron 里检查 active 告警 vs 现价,新触达的发一封汇总邮件。
//   - 复用 Drive 那套 Google OAuth(googleapis + refresh token),client 换成 gmail。
//   - ⚠️ refresh token 需含 scope「https://www.googleapis.com/auth/gmail.send」
//     (原只有 drive)→ 重跑 get-refresh-token.js 加该 scope 后更新 Render env。
//   - 防刷屏:每个触发只发一次(notified=1);价格回到线另一侧 → notified 复位 0 重新武装。
//   - 收件人:env ALERT_EMAIL_TO,默认 binandmolly@gmail.com(发件=已授权的 Gmail 本人)。
// 依赖 server.js 传入:pool(pg)、fetchYahooQuotes(全市场现价)。
// ─────────────────────────────────────────────────────────────────────────
const { google } = require("googleapis");

function getGmailClient() {
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new Error("Google OAuth env 缺失:GOOGLE_OAUTH_CLIENT_ID / SECRET / REFRESH_TOKEN");
  }
  const oauth2 = new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth: oauth2 });
}

// condition 存中文「低于/高于」(兼容历史 BELOW/ABOVE)
function isTriggered(condition, target, cur) {
  if (cur == null) return false;
  const s = String(condition || "");
  const c = s.toUpperCase();
  if (s.includes("低") || c.includes("BELOW")) return cur <= target;
  if (s.includes("高") || c.includes("ABOVE")) return cur >= target;
  return false;
}

async function sendAlertDigest(toEmail, hits) {
  const gmail = getGmailClient();
  const rows = hits.map(h =>
    `<tr><td style="padding:8px 14px;border-bottom:1px solid #eee;"><b>${h.symbol}</b> ${h.name || ""}</td>`
    + `<td style="padding:8px 14px;border-bottom:1px solid #eee;">${h.condition} ${h.price}</td>`
    + `<td style="padding:8px 14px;border-bottom:1px solid #eee;color:#b45309;font-weight:bold;">现价 ${h.cur}</td></tr>`
  ).join("");
  const html =
    `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;">`
    + `<h2 style="color:#b91c1c;margin-bottom:6px;">🔔 凯旋门价格告警 · ${hits.length} 条已触达</h2>`
    + `<table style="border-collapse:collapse;width:100%;font-size:14px;">${rows}</table>`
    + `<p style="color:#888;font-size:13px;margin-top:16px;line-height:1.7;">现价已穿过你设的目标线,登录 App 查看详情。<br>`
    + `(每个触发只发一次;价格回到线另一侧后会自动重新武装。)</p></div>`;
  const subject = `🔔 凯旋门 ${hits.length} 条价格告警已触达`;
  const message =
    `To: ${toEmail}\r\n`
    + `Subject: =?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=\r\n`
    + `Content-Type: text/html; charset=UTF-8\r\n\r\n`
    + html;
  const raw = Buffer.from(message, "utf-8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
}

// 每日 cron 调用:检查某用户 active 告警,新触达发汇总邮件并标记;价格回撤的重新武装。
async function checkAndNotifyAlerts(pool, fetchYahooQuotes, userId) {
  const toEmail = process.env.ALERT_EMAIL_TO || "binandmolly@gmail.com";
  const aRes = await pool.query(
    "SELECT id, symbol, name, condition, price, COALESCE(notified,0) AS notified FROM alerts WHERE user_id=$1 AND active=1",
    [userId]
  );
  if (!aRes.rows.length) return { checked: 0, notified: 0 };

  const symbols = [...new Set(aRes.rows.map(a => a.symbol))];
  let prices = {};
  try { prices = await fetchYahooQuotes(symbols); }
  catch (e) { console.warn("Alert price fetch failed:", e.message); return { checked: aRes.rows.length, notified: 0, error: e.message }; }

  const hits = [];     // 新触达 → 发邮件 + notified=1
  const rearm = [];    // 已回撤 → notified 复位 0(不发邮件)
  for (const a of aRes.rows) {
    const cur = prices[a.symbol] && prices[a.symbol].price;
    if (cur == null) continue;
    const trig = isTriggered(a.condition, a.price, cur);
    if (trig && a.notified != 1) hits.push({ id: a.id, symbol: a.symbol, name: a.name, condition: a.condition, price: a.price, cur });
    else if (!trig && a.notified == 1) rearm.push(a.id);
  }

  if (rearm.length) {
    try { await pool.query("UPDATE alerts SET notified=0 WHERE id = ANY($1::int[])", [rearm]); }
    catch (e) { console.warn("Alert re-arm failed:", e.message); }
  }
  if (!hits.length) return { checked: aRes.rows.length, notified: 0, rearmed: rearm.length };

  try {
    await sendAlertDigest(toEmail, hits);
    await pool.query("UPDATE alerts SET notified=1 WHERE id = ANY($1::int[])", [hits.map(h => h.id)]);
  } catch (e) {
    console.error("Alert email send failed:", e.message);
    return { checked: aRes.rows.length, notified: 0, error: e.message };
  }
  console.log(`🔔 Alert digest sent: ${hits.length} newly-triggered for user ${userId}`);
  return { checked: aRes.rows.length, notified: hits.length, rearmed: rearm.length };
}

module.exports = { checkAndNotifyAlerts };
