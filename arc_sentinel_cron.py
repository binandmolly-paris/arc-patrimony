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
import sys, os, json, hashlib, urllib.request, traceback
import arc_sentinel_multi as M
from arc_sentinel_sweep import run_one, CIK  # 复用路由 + SEC CIK 映射

CRON_TOKEN = M._key("CRON_SECRET")   # env 优先 → arc_keys fallback(提交代码零密钥)
HOLDINGS_URL = "https://arc-patrimony.onrender.com/api/cron/holdings"
REGION_DIR = {"中国": "中国", "日本": "日本", "美国": "美国"}
# 无财报标的(ETF 等)→ 跳过
SKIP = {"2840.HK"}

# ───── V0.3 变化才发邮件 (Bin 2026-05-31):跨运行记忆 notify 指纹,只在"新出现/变化"时才打扰 ─────
STATE_PATH = os.environ.get("SENTINEL_STATE") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), ".sentinel_notify_state.json")


def _load_state():
    try:
        return json.load(open(STATE_PATH, encoding="utf-8"))
    except Exception:
        return {}          # 首跑/cache miss = 空 → 本轮如有异常照发(安全降级:宁可多发一次,不漏报)


def _save_state(state):
    try:
        json.dump(state, open(STATE_PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"⚠️ notify 状态写入失败(不影响巡检):{e}", flush=True)


def _fingerprint(level, msg):
    """一只标的本轮指纹 = 级别 + 消息摘要;与上轮相同 = 无变化,不再打扰。"""
    return level + "|" + hashlib.md5((msg or "").encode("utf-8")).hexdigest()[:10]


# ───── Fix A(Bin 2026-06-04):已知·结构性·恒定的人工旗 = 预期内噪音,不触发邮件 ─────
# 病根:纯港股(腾讯/小米/泡泡/地平线)无程序化分部源 → 永久挂"manual"人工旗;notify 状态一旦
# 在云端漂移(Actions cache miss),这 4 只老相识就被当"新出现的 attention"→ exit2 → 天天假红。
# 修:把"已知恒定人工旗"排除出【邮件触发】(仍在日志/汇总里可见,Claude 财报季照常人工读披露易);
# 只有【真·新转变】(采集报错 / 勾稽 FAIL / 跨期变化 / 新冒出的人工旗)才标黄发邮件。
EXPECTED_NOISE_MARKS = ("纯港股·无干净程序化分部源",)


def _is_expected_noise(msg):
    return bool(msg) and any(mk in msg for mk in EXPECTED_NOISE_MARKS)


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
    # 候选池追加巡检(非持仓 · Bin 指定):2026-06-10 Costco(美国组合第8席候选,等价格回落,财报照拉入库)
    EXTRA_WATCH = [("美国", "COST", "Costco")]
    _have = {u[1] for u in universe}
    universe += [e for e in EXTRA_WATCH if e[1] not in _have]
    if only:
        universe = [u for u in universe if u[1].split(".")[0] in only or u[1] in only]
    summary = {"ok": [], "attention": [], "error": []}
    old_state = _load_state()          # V0.3 上一轮 notify 指纹(跨运行)
    new_state = {}
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
        new_state[symbol] = _fingerprint(level, msg)   # V0.3 本轮指纹
        print(f"[{level:9s}] {symbol:11s} {name} {msg}", flush=True)

    # ───── NOTIFY 汇总(隐形:只报需关注的)─────
    att, err = summary["attention"], summary["error"]
    # ─ Fix A(Bin 2026-06-04):先剔除"已知恒定人工旗"(纯港股),它们不进邮件触发(根治假红)─
    notifiable = [(s, n, m) for (s, n, m) in (att + err) if not _is_expected_noise(m)]
    expected = [(s, n, m) for (s, n, m) in (att + err) if _is_expected_noise(m)]
    # ─ V0.3 变化才发邮件(Bin 2026-05-31):只挑相对上一轮"新增/变化"的项 ─
    changed_notify = [(s, n, m) for (s, n, m) in notifiable
                      if new_state.get(s) != old_state.get(s)]
    _save_state(new_state)             # 落本轮指纹,供下次比对

    print("\n" + "=" * 64)
    print(f"📊 哨兵巡检完成:{len(summary['ok'])} 静默OK · {len(att)} 需人工 · {len(err)} 报错 / 共 {len(universe)}")
    if att or err:
        print(f"   全部需关注 {len(att)+len(err)} 项(仅日志记录):")
        for sym, nm, msg in att:
            print(f"  🟡 {nm}({sym}): {msg}")
        for sym, nm, msg in err:
            print(f"  ❌ {nm}({sym}): {msg}")
        if expected:
            print(f"   └ 其中 {len(expected)} 项=已知恒定人工旗(纯港股,Fix A),不触发邮件(财报季人工读披露易)")
    if changed_notify:
        print(f"\n📨 本轮【新变化】{len(changed_notify)} 项 → 发邮件:")
        for sym, nm, msg in changed_notify:
            print(f"  🔺 {nm}({sym}): {msg}")
    else:
        print("✅ 与上一轮一致,无新变化 → 静默不打扰。")
    # 退出码:仅当有【新变化】才标黄发邮件;持续不变的老 attention/error → 0 静默
    return 2 if changed_notify else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
