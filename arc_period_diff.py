#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
财报哨兵 · 跨期 diff(自动化良心的"历史"那一半)
单期勾稽闸门管"这期自不自洽";本模块管"这期跟上期对不对得上"。

逮三类静默腐蚀(单期闸门一律放行的):
  ① 选中的营收元素变了(我自动选元素的后门:丸红今年Revenue2IFRS、明年换一个,两个都过闸但序列=苹果拼橘子)
  ② 分部数/名变了(公司重组,如阿里改名)
  ③ 状态翻转(ok↔needs_human;占比剧烈漂移)
变了 → 不是报错,是【报警挂旗请人瞄一眼】(隐形铁律:失败时一定出声)。

用法(落库前):new_data["period_diff"] = diff_against_prior(prior_data, new_data)
prior_data = 该标的上一份 sentinel JSON(无则 None)。
"""


def signature(data):
    """从一份 sentinel 结果抽可比签名:{lane, basis(选中的元素/口径), names[], pct{}, period}。"""
    market = data.get("market")
    seg = data.get("segment")
    period = (data.get("data_passport", {}) or {}).get("report_period_end")

    # A股普通股轨:segment = {year: {by_product, by_geography}}
    if isinstance(seg, dict) and "status" not in seg and seg:
        yrs = sorted(k for k in seg if isinstance(seg.get(k), dict))
        last = seg.get(yrs[-1], {}) if yrs else {}
        bp = last.get("by_product", []) if isinstance(last, dict) else []
        return {"lane": "struct", "basis": "A股_zygc_em",
                "names": [x.get("item") for x in bp],
                "pct": {x.get("item"): x.get("pct") for x in bp}, "period": yrs[-1] if yrs else period}

    if isinstance(seg, dict) and "status" in seg:
        st = seg.get("status")
        if st != "ok":
            return {"lane": "human", "basis": st, "names": [], "pct": {}, "period": period}
        # HK A+H:by_product
        if "by_product" in seg:
            bp = seg["by_product"]
            return {"lane": "struct", "basis": "A+H/" + str(seg.get("a_share_code", "")),
                    "names": [x.get("item") for x in bp],
                    "pct": {x.get("item"): x.get("pct") for x in bp}, "period": period}
        # JP/US:segments[]
        segs = [s for s in seg.get("segments", []) if "其他·调整" not in s.get("segment", "")]
        basis = seg.get("rev_tag") or seg.get("segment_axis") or seg.get("basis")
        return {"lane": "struct", "basis": basis,
                "names": [s.get("segment") for s in segs],
                "pct": {s.get("segment"): s.get("pct") for s in segs}, "period": period}

    return {"lane": "none", "basis": None, "names": [], "pct": {}, "period": period}


def diff_against_prior(prior_data, new_data, pct_shift_pp=15):
    """比上一期 → verdict{status, flags[], detail}。status: first|stable|changed。"""
    new = signature(new_data)
    if prior_data is None:
        return {"status": "first", "flags": [], "basis": new["basis"],
                "note": "首次入库,无上期可比"}
    old = signature(prior_data)
    flags, detail = [], {}

    # 同期重跑 vs 真跨期(报告期相同=幂等校验,不同=真跨期)
    detail["period_prev"], detail["period_new"] = old.get("period"), new.get("period")

    # ① 状态翻转(struct↔human)
    if old["lane"] != new["lane"]:
        flags.append(f"状态翻转 {old['lane']}→{new['lane']}")
    if old["lane"] == "human" and new["lane"] == "human":
        return {"status": "stable", "flags": [], "note": "两期均人工旗(设计内尾巴)"}

    # ② 选中的营收元素/口径变了(我自选元素的后门)
    if old["basis"] and new["basis"] and old["basis"] != new["basis"]:
        flags.append(f"⚠️营收元素/口径变了:{old['basis']} → {new['basis']}(序列可能苹果拼橘子)")
        detail["basis_switch"] = [old["basis"], new["basis"]]

    # ③ 分部数变
    if len(old["names"]) != len(new["names"]):
        flags.append(f"分部数变 {len(old['names'])}→{len(new['names'])}")
    # ④ 分部名增减
    so, sn = set(old["names"]), set(new["names"])
    if so != sn:
        added, removed = sn - so, so - sn
        if added:
            flags.append("新增分部:" + "/".join(map(str, sorted(added)))[:60])
        if removed:
            flags.append("消失分部:" + "/".join(map(str, sorted(removed)))[:60])

    # ⑤ 占比剧烈漂移(同名分部 pct 变化 > 阈值pp)
    big = []
    for nm in so & sn:
        po, pn = old["pct"].get(nm), new["pct"].get(nm)
        if po is not None and pn is not None and abs(pn - po) * 100 >= pct_shift_pp:
            big.append(f"{nm} {po*100:.0f}%→{pn*100:.0f}%")
    if big:
        flags.append("占比剧烈漂移(≥%dpp):%s" % (pct_shift_pp, " · ".join(big)[:80]))

    return {"status": "changed" if flags else "stable", "flags": flags, "detail": detail,
            "note": "🔴 跨期有变,请人工瞄一眼" if flags else "🟢 与上期一致"}


if __name__ == "__main__":
    # 自测:伪造上一期(换了营收元素 + 少一个分部 + 占比漂移)
    base = {"market": "日股", "data_passport": {"report_period_end": "2026-03-31"},
            "segment": {"status": "ok", "rev_tag": "jpigp_cor:Revenue2IFRS",
                        "segments": [{"segment": "Food", "pct": 0.34}, {"segment": "Energy", "pct": 0.21},
                                     {"segment": "Machinery", "pct": 0.10}]}}
    prior = {"market": "日股", "data_passport": {"report_period_end": "2025-03-31"},
             "segment": {"status": "ok", "rev_tag": "jpigp_cor:RevenueFromExternalCustomers2IFRS",
                         "segments": [{"segment": "Food", "pct": 0.50}, {"segment": "Energy", "pct": 0.21},
                                      {"segment": "Machinery", "pct": 0.10}, {"segment": "Textile", "pct": 0.05}]}}
    import json
    print("【变了】", json.dumps(diff_against_prior(prior, base), ensure_ascii=False, indent=2))
    print("\n【一致】", json.dumps(diff_against_prior(base, base), ensure_ascii=False))
    print("\n【首次】", json.dumps(diff_against_prior(None, base), ensure_ascii=False))
    print("\n【两期人工旗】", json.dumps(diff_against_prior(
        {"market": "日股", "segment": {"status": "needs_human"}},
        {"market": "日股", "segment": {"status": "needs_human"}}), ensure_ascii=False))
