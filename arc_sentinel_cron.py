#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
财报哨兵 · cron 入口(隐形闭环大脑)— 与运行平台无关,本地/GitHub Actions/Render Cron 通用。
一次运行 = 巡检全持仓 → 逐只采集(内含勾稽硬闸门 + 跨期 diff) → 落库 → 汇总【只报异常】。

隐形铁律:正常静默,只有 needs_human / 跨期changed / 报错 才进 notify 汇总。
用法:
  python arc_sentinel_cron.py            # 全持仓(live holdings API)
  python arc_sentinel_cron.py 4063 8001  # 只跑指定(调试/子集)
输出:
  - 落库 JSON(经 save(),含 period_diff)
  - stdout 末尾一段 NOTIFY 汇总(给 GitHub Actions / 邮件 / 人工)
  - 退出码:有需人工项=2(便于 CI 标黄),纯报错=1,全静默=0
"""
import sys, json, urllib.request, traceback
import arc_sentinel_multi as M
from arc_sentinel_sweep import run_one, CIK  # 复用路由 + SEC CIK 映射

CRON_TOKEN = M._key("CRON_SECRET")   # env 优先 → arc_keys fallback(提交代码零密钥)
HOLDINGS_URL = "https://arc-patrimony.onrender.com/api/cron/holdings"
REGION_DIR = {"中国": "中国", "日本": "日本", "美国": "美国"}
# 无财报标的(ETF 等)→ 跳过
SKIP = {"2840.HK"}


def live_holdings():
    req = urllib.request.Request(HOLDINGS_URL, headers={"x-cron-token": CRON_TOKEN})
    d = json.loads(urllib.request.urlopen(req, timeout=40).read())
    out = []
    for h in (d.get("holdings_active") or d.get("holdings") or []):
        sym = h.get("symbol")
        if not sym or sym in SKIP:
            continue
        out.append((h.get("region") or h.get("market") or "?", sym, h.get("name") or sym))
    return out


def classify(data):
    """落库结果 → (级别, 一句话)。级别:ok / attention(需人工) / error。"""
    seg = data.get("segment")
    pdiff = data.get("period_diff", {}) or {}
    # 跨期有变 = 一定要人工瞄
    if pdiff.get("status") == "changed":
        return "attention", "跨期变化:" + " · ".join(pdiff.get("flags", []))[:120]
    if isinstance(seg, dict):
        st = seg.get("status")
        if st in ("needs_human", "manual"):
            return "attention", "挂人工旗:" + str(seg.get("reason") or seg.get("segment_status") or "")[:90]
        if st == "err":
            return "error", "采集报错:" + str(seg.get("error"))[:90]
        if st == "ok":
            rec = seg.get("reconciliation", {})
            if rec.get("pass") is False or rec.get("gate") == "FAIL":
                return "attention", "勾稽未过(已闸门拦截)"
    return "ok", ""


def main(argv):
    only = set(argv[1:])
    universe = live_holdings()
    if only:
        universe = [u for u in universe if u[1].split(".")[0] in only or u[1] in only]
    summary = {"ok": [], "attention": [], "error": []}
    for region, symbol, name in universe:
        mdir = REGION_DIR.get(region, region)
        try:
            data = run_one(region, symbol, name)
            M.save(data, mdir, name)
            level, msg = classify(data)
        except Exception as e:
            level, msg = "error", f"{type(e).__name__}: {str(e)[:90]}"
            traceback.print_exc()
        summary[level].append((symbol, name, msg))
        print(f"[{level:9s}] {symbol:11s} {name} {msg}", flush=True)

    # ───── NOTIFY 汇总(隐形:只报需关注的)─────
    att, err = summary["attention"], summary["error"]
    print("\n" + "=" * 64)
    print(f"📊 哨兵巡检完成:{len(summary['ok'])} 静默OK · {len(att)} 需人工 · {len(err)} 报错 / 共 {len(universe)}")
    if att or err:
        print("\n🔔 NOTIFY —— 需要人工的:")
        for sym, nm, msg in att:
            print(f"  🟡 {nm}({sym}): {msg}")
        for sym, nm, msg in err:
            print(f"  ❌ {nm}({sym}): {msg}")
    else:
        print("✅ 全部静默通过,无需打扰。")
    return 2 if att else (1 if err else 0)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
