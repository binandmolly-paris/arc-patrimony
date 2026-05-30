#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
财报哨兵 · 日股分部解析器 V2(自动化级重构) — EDINET 有価証券報告書 事業セグメント

⚠️ V1 教训(2026-05-30 规模实测):硬编码营收标签(伊藤忠=RevenueFromExternalCustomers2IFRS)
   只对 2 个样本成立。12 只全量一跑,9 只崩成"1段假成功"——丸红用 Revenue2IFRS、日立用
   RevenueIFRS、丰田用 SalesRevenuesIFRS…标签公司间高度异构,硬编码必碎且【静默】碎。

✅ V2 自动化级打法(结构识别 + 勾稽即闸门):
   ① 不靠硬编码:扫所有挂在【具名分部成员】上的数字 fact,营收候选=名含 Revenue/Sales。
   ② 选营收元素=候选中【跨分部加总最接近 J-Quants 总营收】者 —— 勾稽即选择标准。
   ③ 硬闸门:选出后残差>10% 或无结构化 fact(三菱商事只有 TextBlock/银行按業務粗利益)
      → status=needs_human 挂人工旗,【绝不冒充入库】。每条结果要么自证、要么自己举手。
   实测 12 只:8 干净结构化(勾稽自证)+ 4 诚实挂人工旗(3 TextBlock + 银行需专轨)。

用法:
    from arc_edinet_segment import edinet_segment
    seg = edinet_segment("80010", fy_end_month=3, fy_end_year=2025, total_revenue=...)  # 伊藤忠
    # → {status:ok|needs_human, standard, docID, rev_tag(自动选), segments:[...], reconciliation:{gate}}
"""
import urllib.request, io, zipfile, csv, re, json, os

def _key(name):
    v = os.environ.get(name)
    if v:
        return v
    try:
        import arc_keys
        return getattr(arc_keys, name, None)
    except ImportError:
        return None

EDINET_KEY = _key("EDINET_KEY")

# ⚠️ 仅供参考:V1 硬编码标签矩阵,已被 V2 结构识别取代(标签公司间异构,别再依赖)。
TAGS_LEGACY = {
    "日本基準": {"rev": "jpcrp_cor:RevenuesFromExternalCustomers", "profit": "jppfs_cor:OperatingIncome"},
    "IFRS":     {"rev": "jpigp_cor:RevenueFromExternalCustomers2IFRS",
                 "profit": "jpigp_cor:ProfitLossAttributableToOwnersOfParentIFRS"},
}


def _http(url, timeout=60):
    return urllib.request.urlopen(url, timeout=timeout).read()


def locate_yuho(sec_code, fy_end_month=3, fy_end_year=None):
    """扫 EDINET 文档清单定位 docTypeCode=120(有報)的 docID。
    有報法定截止=财年末+3月内;扫该窗口月全月(命中即停)。
    sec_code=5位(4位代码+0,如伊藤忠8001→80010)。fy_end_year=财年末日历年份。"""
    if fy_end_year is None:
        raise ValueError("fy_end_year 必填(财年末年份,如 2025 表示 FY2025-03)")
    win_month = (fy_end_month + 3 - 1) % 12 + 1            # 3月财年→6月窗口
    win_year = fy_end_year + (1 if win_month <= fy_end_month else 0)  # 跨年财年(如12月末→次年3月)
    for day in range(1, 32):
        date = f"{win_year:04d}-{win_month:02d}-{day:02d}"
        url = (f"https://api.edinet-fsa.go.jp/api/v2/documents.json"
               f"?date={date}&type=2&Subscription-Key={EDINET_KEY}")
        try:
            res = json.loads(_http(url, 40)).get("results") or []
        except Exception:
            continue
        for r in res:
            if str(r.get("secCode")) == str(sec_code) and r.get("docTypeCode") == "120":
                return {"docID": r.get("docID"), "date": date,
                        "desc": r.get("docDescription"), "edinetCode": r.get("edinetCode")}
    return None


def _load_jpcrp_csv(doc_id):
    url = (f"https://api.edinet-fsa.go.jp/api/v2/documents/{doc_id}"
           f"?type=5&Subscription-Key={EDINET_KEY}")
    z = zipfile.ZipFile(io.BytesIO(_http(url)))
    main = [n for n in z.namelist()
            if "jpcrp" in n.lower() and n.endswith(".csv")][0]   # 主表 jpcrp030000-asr
    return list(csv.reader(io.StringIO(z.read(main).decode("utf-16")), delimiter="\t"))


def _num(v):
    v = (v or "").strip()
    if v in ("", "－", "-", "—", "‐"):
        return None
    try:
        return int(v)
    except ValueError:
        try:
            return float(v)
        except ValueError:
            return None


_SEG_RE = re.compile(r'-\d{3}(.+?)ReportableSegments?Member$')


def _seg_name(ctx):
    """从 コンテキストID 提分部成员英文名;合计行(无具名成员)返回 None。"""
    m = _SEG_RE.search(ctx)
    if not m:
        return None
    name = m.group(1)
    # CamelCase → 空格分词
    name = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', name)        # aB:  MetalsAnd → Metals And
    name = re.sub(r'(?<=[A-Z])(?=[A-Z][a-z])', ' ', name)   # ABc: ICTAnd → ICT And
    name = re.sub(r'(?<=[A-Za-z])(?=\d)', ' ', name)         # x9:  The8th → The 8th
    return name


def _is_rev_candidate(elem):
    """元素是否=营收候选(按名,排除分部间/每股/增长等非外部营收)。"""
    ln = elem.split(":")[-1]
    if any(k in ln for k in ("Intersegment", "PerShare", "Growth", "Ratio", "Cost")):
        return False
    return ("Revenue" in ln) or ("Sales" in ln) or ("収益" in ln)


_PROFIT_PREF = ("OperatingIncome", "ProfitLossAttributableToOwnersOfParent",
                "SegmentProfit", "OperatingResult", "OperatingProfit", "ProfitLoss")


def _collect_member_facts(rows, period_token):
    """当期所有挂在【具名分部成员】上的数字 fact:{element: {member: value}}。"""
    facts = {}
    for r in rows:
        if len(r) < 7 or not r[2].startswith(period_token):
            continue
        nm = _seg_name(r[2])
        if nm is None:
            continue
        v = _num(r[-1])
        if v is None:
            continue
        facts.setdefault(r[0], {})[nm] = v
    return facts


def parse_segment(doc_id, total_revenue=None, period_token="CurrentYearDuration"):
    """结构化解析事業セグメント(自动识别营收元素,不靠硬编码标签)。
    营收元素 = 候选中【跨分部加总最接近 J-Quants 总营收】者 —— 勾稽即选择标准。
    无干净结构化分部(如三菱商事只有 TextBlock)→ 返回 needs_human,不冒充。"""
    rows = _load_jpcrp_csv(doc_id)
    is_ifrs = any(len(r) and r[0].endswith("2IFRS") for r in rows)
    std = "IFRS" if is_ifrs else "日本基準"
    facts = _collect_member_facts(rows, period_token)

    # 营收候选:名字含 Revenue/Sales 且 ≥2 个具名分部成员
    cands = {e: m for e, m in facts.items()
             if _is_rev_candidate(e) and len([v for v in m.values() if v]) >= 2}
    if not cands:
        return {"standard": std, "status": "needs_human",
                "reason": "有報无结构化分部营收 fact(疑似仅 TextBlock,如三菱商事型)→ 挂人工旗"}

    def csum(m):
        return sum(v for v in m.values() if v and v > 0)

    # 选营收元素:有总营收→选加总最接近者;无→选加总最大者
    if total_revenue:
        rev_tag = min(cands, key=lambda e: abs(csum(cands[e]) - total_revenue))
    else:
        rev_tag = max(cands, key=lambda e: csum(cands[e]))
    rev = cands[rev_tag]
    seg_sum = csum(rev)

    # 利润元素:优先名单里首个存在者(≥2 成员),否则不取
    profit_tag, prof = None, {}
    for pref in _PROFIT_PREF:
        hit = [e for e in facts if pref in e.split(":")[-1]
               and len([v for v in facts[e].values() if v]) >= 2]
        if hit:
            profit_tag = hit[0]
            prof = facts[profit_tag]
            break

    segments = []
    for nm, v in rev.items():
        if not v or v <= 0:
            continue
        segments.append({"segment": nm, "external_revenue": v,
                         "pct": round(v / seg_sum, 4) if seg_sum else None,
                         "segment_profit": prof.get(nm)})
    segments.sort(key=lambda s: -(s["external_revenue"] or 0))
    return {"standard": std, "status": "ok", "rev_tag": rev_tag, "profit_tag": profit_tag,
            "segments": segments, "segment_sum": seg_sum}


def edinet_segment(sec_code, fy_end_month=3, fy_end_year=None, total_revenue=None):
    """端到端:定位有報 → 解析分部 →(可选)对 J-Quants 总营收勾稽 + 残差补全。
    total_revenue=J-Quants 合并总营收(同币/同单位),用于勾稽与"其他/調整"残差行。"""
    loc = locate_yuho(sec_code, fy_end_month, fy_end_year)
    if not loc:
        return {"status": "缺·有報未定位(窗口内未找到docTypeCode=120)",
                "sec_code": sec_code, "fy_end_year": fy_end_year}
    seg = parse_segment(loc["docID"], total_revenue=total_revenue)
    base = {"source": "EDINET 有価証券報告書 事業セグメント(一手)", "standard": seg["standard"],
            "docID": loc["docID"], "disclosure_date": loc["date"], "doc_desc": loc["desc"]}
    # 结构化解析就失败(只有 TextBlock)→ 直接挂人工旗
    if seg.get("status") != "ok":
        base.update({"status": "needs_human", "reason": seg.get("reason")})
        return base
    base.update({"rev_tag": seg["rev_tag"], "profit_tag": seg["profit_tag"],
                 "segments": seg["segments"], "segment_sum": seg["segment_sum"]})
    if not total_revenue:
        base["status"] = "ok"
        base["reconciliation"] = {"pass": None, "note": "无总营收无法勾稽闸门"}
        return base
    # ⭐勾稽硬闸门(自动化安全核心):残差>10%=没把握→needs_human,绝不冒充入库
    resid = total_revenue - seg["segment_sum"]
    rpct = abs(resid) / total_revenue
    rec = {"jquants_total_revenue": total_revenue, "segment_external_sum": seg["segment_sum"],
           "residual_other_adjust": resid, "residual_pct": round(resid / total_revenue, 4),
           "pass": rpct < 0.05, "gate": "pass" if rpct <= 0.10 else "FAIL"}
    base["reconciliation"] = rec
    if rpct > 0.10:
        base.update({"status": "needs_human",
                     "reason": f"勾稽闸门未过:分部合计 {seg['segment_sum']:,} vs 总营收 "
                               f"{total_revenue:,},残差 {rpct*100:.1f}%>10% → 选错营收元素/结构异常,挂人工旗"})
        return base
    base["status"] = "ok"
    # 残差>0.5% 补"其他·调整"令占比加总 100%
    if resid and rpct >= 0.005:
        base["segments"].append({"segment": "其他·调整(Other/Adjust)", "external_revenue": resid,
                                 "pct": round(resid / total_revenue, 4), "segment_profit": None})
        for s in base["segments"]:
            if s["external_revenue"]:
                s["pct"] = round(s["external_revenue"] / total_revenue, 4)
    return base


if __name__ == "__main__":
    import json
    for nm, code, fy in [("信越化学", "40630", 3), ("伊藤忠商事", "80010", 3)]:
        print(f"\n{'='*56}\n▶ {nm} (secCode={code})\n{'='*56}")
        r = edinet_segment(code, fy_end_month=fy, fy_end_year=2025)
        print(f"  准则={r.get('standard')} docID={r.get('docID')} 披露日={r.get('disclosure_date')}")
        for s in r.get("segments", []):
            rev = s["external_revenue"]
            print(f"   {s['segment']:34s} rev={rev:>16,} ({(s['pct'] or 0)*100:5.1f}%) "
                  f"profit={s['segment_profit']}")
