#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
财报哨兵 · 云端写盘(本地无 Google Drive 挂载时,经 Node /api/drive/upsert 写财报库)
本地跑=直接写文件系统(arc_sentinel_multi.save);云端跑(GitHub Actions/Render)=用本模块。

链路(实测通 2026-05-30):find 标的文件夹 → find 其下 JSON → upsert(同名则按 fileId 覆盖,无则建)。
⚠️ 端点只能建【文件】不能建【文件夹】:标的/JSON 文件夹不存在 → 返回 missing,挂一次性建夹清单(不静默吞)。
"""
import urllib.request, json

DRIVE_BASE = "https://arc-patrimony.onrender.com/api/drive"
DRIVE_SECRET = None   # 由环境注入(DRIVE_WRITE_SECRET);云端 os.environ 读
REPORT_LIB_ID = "1BgmQUeFIhLhd6x4UXyTTrhFcUODk9TJC"   # 6_财报库 folder id(实测)


def _set_secret(secret):
    global DRIVE_SECRET
    DRIVE_SECRET = secret


def _req(path, method="GET", params=None, body=None):
    url = DRIVE_BASE + path
    if params:
        from urllib.parse import urlencode
        url += "?" + urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    headers = {"x-drive-token": DRIVE_SECRET}
    if data:
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    return json.loads(urllib.request.urlopen(r, timeout=50).read())


def _find_child(name, parent_id):
    """在 parent 下按名找子(folder 或 file);返回 id 或 None。"""
    r = _req("/find", params={"title": name, "parentId": parent_id})
    fs = r.get("files") or []
    return fs[0]["id"] if fs else None


def _ensure_folder(name, parent_id):
    """在 parent 下"有则返回、无则创建"文件夹;返回 id。(需 server.js 部署 ensure-folder 路由)"""
    r = _req("/ensure-folder", method="POST", body={"name": name, "parentId": parent_id})
    return r["id"]


def cloud_save(market_dir, name, filename, content_str):
    """把一份 sentinel JSON 写进 财报库/<market_dir>/<name>/JSON/<filename>(缺夹自动建)。
    返回 {ok, action, id}。"""
    mkt = _ensure_folder(market_dir, REPORT_LIB_ID)
    holder = _ensure_folder(name, mkt)
    json_dir = _ensure_folder("JSON", holder)
    # 同名文件已存在 → 按 fileId 覆盖(幂等,防重复);否则新建
    existing = _find_child(filename, json_dir)
    body = {"content": content_str, "mimeType": "application/json"}
    if existing:
        body["fileId"] = existing
    else:
        body["title"] = filename
        body["parentId"] = json_dir
    r = _req("/upsert", method="POST", body=body)
    return {"ok": True, "action": r.get("action"), "id": r.get("id")}
