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
  - 退出码(V0.5 · 2026-06-14):仅【真·财务硬信号=跨期变化/勾稽FAIL】或【系统性采集故障】=2(CI标黄发邮件);
    常驻人工旗 / 单次瞬时采集报错 = 噪音,只记日志、不发邮件 → 0(静默)。
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
        return {}          # 首跑/cache miss = 空 → V0.5 安全降级:只发硬信号(见 main),不再"照发全部"


def _save_state(state):
    try:
        json.dump(state, open(STATE_PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"⚠️ notify 状态写入失败(不影响巡检):{e}", flush=True)


def _fingerprint(level, msg):
    """一只标的本轮指纹 = 级别 + 消息摘要;与上轮相同 = 无变化,不再打扰。"""
    return level + "|" + hashlib.md5((msg or "").encode("utf-8")).hexdigest()[:10]


# ───── Fix A(Bin 2026-06-04):已知·结构性·恒定的人工旗 = 预期内噪音,不触发邮件 ─────
# (V0.5 已被下方 _is_hard_signal 涵盖:除"跨期变化/勾稽FAIL"外一切均不发邮件;此处保留不删,无副作用。)
EXPECTED_NOISE_MARKS = ("纯港股·无干净程序化分部源",)


def _is_expected_noise(msg):
    return bool(msg) and any(mk in msg for mk in EXPECTED_NOISE_MARKS)


# ───── V0.5(Bin 2026-06-14):只有"真·财务硬信号"才发邮件,根治"红绿天天翻" ─────
# 病根:旧版 cache(GitHub Actions)偶发 miss → old_state 读空 → 旧"安全降级=照发全部"→ 常驻
# 人工旗 / 瞬时采集报错被当"新出现"→ exit2 假红 → 红绿随 cache 命中/失效天天翻(annotation 实锤 exit code 2)。
# 修:① 只有【跨期变化 / 勾稽FAIL】=真财务信号才进邮件触发(这两者由"本轮数据 vs 财报库"判定,
#      不依赖 GitHub cache,可靠);② 常驻人工旗 + 单次采集报错 → 只记日志、永不单独触发红;
#    ③ cache miss 的安全降级从"照发全部"改成"只发硬信号"(根治假红风暴);
#    ④ 系统性采集故障(报错 ≥ 1/3 持仓)→ 单条汇总发(防真·全盘宕机被静默吞)。
HARD_SIGNAL_MARKS = ("跨期变化", "勾稽")   # 跨期变化 / 勾稽未过 = 唯一邮件触发源


def _is_hard_signal(msg):
    return bool(msg) and any(mk in msg for mk in HARD_SIGNAL_MARKS)


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

    # ───── NOTIFY 汇总(V0.5 · Bin 2026-06-14:只让"真·财务硬信号"发邮件)─────
    att, err = summary["attention"], summary["error"]
    # 真·硬信号 = 跨期变化 / 勾稽FAIL(本轮数据 vs 财报库判定,不依赖 GitHub cache);
    # 常驻人工旗 + 单次采集报错 = 噪音 → 只记日志,永不单独触发红。
    hard = [(s, n, m) for (s, n, m) in (att + err) if _is_hard_signal(m)]
    # 硬信号去重:cache 命中 → 只发"相对上轮新变化"的;cache 丢失 → 全发硬信号(本就稀少,宁多发不漏;
    # 不再像旧版 cache 丢就"发全部"= 根治假红风暴)。
    if old_state:
        changed_notify = [(s, n, m) for (s, n, m) in hard if new_state.get(s) != old_state.get(s)]
    else:
        changed_notify = hard
    # 系统性采集故障安全网:报错 ≥ max(5, 持仓1/3) → 疑数据源/网络全盘宕机 → 单条汇总发(防被静默吞)。
    systemic = len(err) >= max(5, len(universe) // 3)
    _save_state(new_state)             # 落本轮指纹,供下次比对

    print("\n" + "=" * 64)
    print(f"📊 哨兵巡检完成:{len(summary['ok'])} 静默OK · {len(att)} 需人工 · {len(err)} 报错 / 共 {len(universe)}")
    if att or err:
        print(f"   需关注 {len(att)+len(err)} 项(仅日志;非硬信号=噪音不发邮件):")
        for sym, nm, msg in att:
            print(f"  🟡 {nm}({sym}): {msg}")
        for sym, nm, msg in err:
            print(f"  ❌ {nm}({sym}): {msg}")
    if changed_notify:
        print(f"\n📨 本轮【真·财务硬信号】{len(changed_notify)} 项 → 发邮件(标红 exit2):")
        for sym, nm, msg in changed_notify:
            print(f"  🔺 {nm}({sym}): {msg}")
    if systemic:
        print(f"\n🔧 系统性采集故障:{len(err)}/{len(universe)} 只报错 → 发汇总(疑数据源/网络全盘问题)。")
    if not changed_notify and not systemic:
        print("✅ 无新财务硬信号(人工旗/瞬时报错=噪音已静默)→ 绿灯不打扰。")
    # 退出码:仅【真·财务硬信号】或【系统性故障】才 exit2 标红发邮件;其余一律 0(绿,静默)
    return 2 if (changed_notify or systemic) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
