// drive-upsert.js — Arc Patrimony · Google Drive 原地更新(upsert)端点
// ─────────────────────────────────────────────────────────────────────────
// 解决的问题:Claude 的 Drive MCP 工具【只有新建、没有原地更新】,
//   每改一次真相源文件(病历卡主档 / _说明.md / 宪法.md / 配置表)就会生一个重复文件,
//   且无删除工具 → 违反"防撞车·无合并"。本端点用 Drive API files.update 做【真·原地覆盖】。
//
// 用途定位(配合 SKILL 解法 D):
//   - 报告/估值卡/判定卡/论道 = 不可变档(一稿一档·日期命名)→ 仍用 MCP create_file,不走这里。
//   - 真相源/主档/索引/配置 = 需原地改的活文件 → 走本端点 upsert(by fileId 覆盖,零重复)。
//
// 鉴权:复用现有 CRON_SECRET(header x-cron-token 或 ?token=),与 /api/cron/holdings 一致。
// Drive 授权:个人 Gmail Drive 用 OAuth2 refresh token(service account 访问不了个人盘,故用 OAuth)。
//   需要的 env:GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN
//   refresh token 一次性用 get-refresh-token.js 换取(见 DRIVE_UPSERT_SETUP.md)。
// ─────────────────────────────────────────────────────────────────────────
const { google } = require("googleapis");
const { Readable } = require("stream");

function getDriveClient() {
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new Error("Google OAuth env 缺失:需 GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN");
  }
  const oauth2 = new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });
  return google.drive({ version: "v3", auth: oauth2 });
}

function authOK(req, res) {
  const token = req.headers["x-cron-token"] || req.query.token;
  if (!process.env.CRON_SECRET) { res.status(500).json({ error: "CRON_SECRET not configured on server" }); return false; }
  if (!token || token !== process.env.CRON_SECRET) { res.status(401).json({ error: "unauthorized" }); return false; }
  return true;
}

function bufferFrom(content, encoding) {
  return Buffer.from(content, encoding === "base64" ? "base64" : "utf-8");
}

function registerDriveUpsert(app) {
  // 注:请求体解析依赖 server.js 的全局 app.use(express.json({ limit: "25mb" }))

  // POST /api/drive/upsert
  // body: {
  //   fileId?     : 给了 → 原地覆盖(files.update,真更新,零重复);没给 → 走新建分支
  //   title?      : 新建时的文件名(无 fileId 时必填)
  //   parentId?   : 新建时的父文件夹 id(无 fileId 时建议给)
  //   content     : 文件内容(默认 utf-8 文本;encoding:"base64" 时为 base64)
  //   mimeType?   : 默认 "text/markdown"(.md);html 用 "text/html"
  //   encoding?   : "base64" | 省略(=utf-8)
  // }
  app.post("/api/drive/upsert", async (req, res) => {
    if (!authOK(req, res)) return;
    try {
      const { fileId, title, parentId, content, mimeType = "text/markdown", encoding } = req.body || {};
      if (typeof content !== "string") return res.status(400).json({ error: "content (string) 必填" });

      const drive = getDriveClient();
      const media = { mimeType, body: Readable.from(bufferFrom(content, encoding)) };

      if (fileId) {
        // 真·原地覆盖 —— 不产生重复文件
        const r = await drive.files.update({
          fileId,
          media,
          fields: "id,name,modifiedTime,parents",
          supportsAllDrives: true,
        });
        return res.json({ action: "updated", ...r.data });
      }

      // 无 fileId → 新建(upsert 的"insert"分支)
      if (!title) return res.status(400).json({ error: "无 fileId 时 title 必填" });
      const r = await drive.files.create({
        requestBody: { name: title, ...(parentId ? { parents: [parentId] } : {}) },
        media,
        fields: "id,name,modifiedTime,parents",
        supportsAllDrives: true,
      });
      return res.json({ action: "created", ...r.data });
    } catch (e) {
      console.error("[drive-upsert] error:", e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/drive/find?title=...&parentId=...  —— 按名查 fileId(给 upsert 用)
  app.get("/api/drive/find", async (req, res) => {
    if (!authOK(req, res)) return;
    try {
      const { title, parentId } = req.query;
      if (!title) return res.status(400).json({ error: "title 必填" });
      const drive = getDriveClient();
      const safe = String(title).replace(/'/g, "\\'");
      let q = `name = '${safe}' and trashed = false`;
      if (parentId) q += ` and '${parentId}' in parents`;
      const r = await drive.files.list({
        q, fields: "files(id,name,modifiedTime,parents)", pageSize: 20, supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      return res.json({ files: r.data.files || [] });
    } catch (e) {
      console.error("[drive-find] error:", e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/drive/health —— 自检 OAuth 通不通(不暴露密钥)
  app.get("/api/drive/health", async (req, res) => {
    if (!authOK(req, res)) return;
    try {
      const drive = getDriveClient();
      const r = await drive.about.get({ fields: "user(emailAddress)" });
      return res.json({ ok: true, drive_user: r.data.user?.emailAddress });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { registerDriveUpsert };
