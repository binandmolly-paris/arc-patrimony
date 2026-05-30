#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
财报哨兵 · 美股/中概分部解析器(二期固化) — SEC EDGAR XBRL instance 事業セグメント
微软[10-K native]端到端实测:3 分部合计==官方 FY25 营收 $281.7B 分毫不差。

⚠️ SEC `companyfacts`/`companyconcept` 只返默认维度(合计),拿不到分部成员;
   分部数字在 10-K/20-F 的 XBRL instance(`*_htm.xml`)带 segment-axis 的 context 里,
   与 EDINET 同构。本模块下 instance → 解析 us-gaap:StatementBusinessSegmentsAxis。

用法:
    from arc_sec_segment import sec_segment
    seg = sec_segment("0000789019")          # 微软 CIK(10位,前补0)
    # → {status, form, segments:[{segment,revenue,pct,operating_income}], fy_end, ...}

中概 ADR(PDD/BABA/TCOM)走 20-F;若 instance 用 IFRS/不同分部轴,标 needs_review 不硬解。
"""
import urllib.request, json, re
from xml.etree import ElementTree as ET

UA = {"User-Agent": "ArcPatrimony research binandmolly@gmail.com"}
SEG_AXIS = "us-gaap:StatementBusinessSegmentsAxis"
PRODUCT_AXIS = "srt:ProductOrServiceAxis"     # ⚠️ srt: 命名空间;单一分部公司按产品/服务拆(PDD/携程)
COITEMS_AXIS = "srt:ConsolidationItemsAxis"   # ⚠️ 在 srt: 命名空间,非 us-gaap:
COITEMS_SEG = "us-gaap:OperatingSegmentsMember"   # 分部合计层标记(阿里型双轴)
REV_TAGS = ["RevenueFromContractWithCustomerExcludingAssessedTax",
            "RevenueFromContractWithCustomerIncludingAssessedTax", "Revenues"]
OP_TAGS = ["OperatingIncomeLoss"]


def _seg_total_member(dims):
    """判断 context 是否=某分部的"合计层";是则返回分部成员名,否则 None。
    两形态:① 微软=纯单轴 {SEG_AXIS:X};② 阿里=分部轴×OperatingSegments 双轴
    {SEG_AXIS:X, ConsolidationItemsAxis:OperatingSegments}。带 ProductOrService/
    TypeOfArrangement 等更细轴(3+)=子行,排除。"""
    if SEG_AXIS not in dims:
        return None
    others = {k: v for k, v in dims.items() if k != SEG_AXIS}
    if not others:
        return dims[SEG_AXIS]
    if set(others) == {COITEMS_AXIS} and others.get(COITEMS_AXIS) == COITEMS_SEG:
        return dims[SEG_AXIS]
    return None


def _get(url, timeout=90):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()


def _ln(tag):
    return tag.split("}")[-1]


def _camel(member):
    """msft:ProductivityAndBusinessProcessesMember → 'Productivity And Business Processes'"""
    name = member.split(":")[-1]
    name = re.sub(r'Member$', '', name)
    name = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', name)
    name = re.sub(r'(?<=[A-Z])(?=[A-Z][a-z])', ' ', name)
    name = re.sub(r'(?<=[A-Za-z])(?=\d)', ' ', name)
    return name.strip()


def locate_latest_annual(cik):
    """最新年报:优先 10-K(美企),无则 20-F(中概 ADR)。返回 form/accession/reportDate。"""
    sub = json.loads(_get(f"https://data.sec.gov/submissions/CIK{cik}.json", 40))
    r = sub["filings"]["recent"]
    for want in ("10-K", "20-F"):
        for i, f in enumerate(r["form"]):
            if f == want:
                return {"form": f, "accession": r["accessionNumber"][i],
                        "report_date": r["reportDate"][i], "filing_date": r["filingDate"][i]}
    return None


def _instance_url(cik, accession):
    accn = accession.replace("-", "")
    base = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accn}"
    fl = json.loads(_get(base + "/index.json", 40))
    insts = [it["name"] for it in fl["directory"]["item"] if it["name"].endswith("_htm.xml")]
    return (base + "/" + insts[0]) if insts else None


def _parse_contexts(root):
    ctx = {}
    for c in root:
        if _ln(c.tag) != "context":
            continue
        dims, start, end = {}, None, None
        for ch in c.iter():
            t = _ln(ch.tag)
            if t == "explicitMember":
                dims[_ln(ch.get("dimension"))] = ch.text.split(":")[-1] if ch.text else ""
            elif t == "startDate":
                start = ch.text
            elif t == "endDate":
                end = ch.text
        # 还原带前缀的维度名(explicitMember dimension 属性是 QName,需保前缀比对)
        dims_q = {}
        for ch in c.iter():
            if _ln(ch.tag) == "explicitMember":
                dims_q[ch.get("dimension").split("}")[-1]] = ch.text
        ctx[c.get("id")] = {"dims": dims_q, "start": start, "end": end}
    return ctx


def _is_fy(c, report_date):
    if not (c["start"] and c["end"] and c["end"] == report_date):
        return False
    try:
        from datetime import date
        s = date(*map(int, c["start"].split("-")))
        e = date(*map(int, c["end"].split("-")))
        return 350 <= (e - s).days <= 380
    except Exception:
        return False


def _parse_units(root):
    """unitId → 币种(iso4217:CNY → 'CNY')。"""
    units = {}
    for u in root:
        if _ln(u.tag) != "unit":
            continue
        for ch in u.iter():
            if _ln(ch.tag) == "measure" and ch.text and "iso4217" in ch.text:
                units[u.get("id")] = ch.text.split(":")[-1]
                break
    return units


def _report_ccy(root, units):
    """报告币种=全 instance 货币型 fact 用得最多的币种(USD 便利换算只点缀几行)。"""
    cnt = {}
    for el in root:
        uref = el.get("unitRef")
        ccy = units.get(uref)
        if ccy:
            cnt[ccy] = cnt.get(ccy, 0) + 1
    return max(cnt, key=cnt.get) if cnt else None


def parse_segment(instance_xml, report_date):
    root = ET.fromstring(instance_xml)
    ctx = _parse_contexts(root)
    units = _parse_units(root)
    rccy = _report_ccy(root, units)

    def collect(tags, ctx_map):
        """逐成员取值;只认报告币种的 fact(滤掉 USD 便利换算);tag 优先级靠前者胜。"""
        out = {}
        for tag in tags:
            for el in root:
                if _ln(el.tag) != tag:
                    continue
                cref = el.get("contextRef")
                if cref not in ctx_map:
                    continue
                if rccy and units.get(el.get("unitRef")) not in (rccy, None):
                    continue
                out.setdefault(ctx_map[cref], el.text)
        return out

    # 路径①:事業セグメント合计层(微软纯单轴 / 阿里分部×OperatingSegments 双轴)
    seg_ctx = {cid: m for cid, c in ctx.items() if _is_fy(c, report_date)
               for m in [_seg_total_member(c["dims"])] if m}
    basis, axis = "事業セグメント(business segment)", SEG_AXIS
    rev = collect(REV_TAGS, seg_ctx)
    op = collect(OP_TAGS, seg_ctx)
    # 路径②回退:单一经营分部→按产品/服务拆(纯 ProductOrService 单轴)
    if not rev:
        pos_ctx = {cid: c["dims"][PRODUCT_AXIS] for cid, c in ctx.items()
                   if _is_fy(c, report_date) and list(c["dims"].keys()) == [PRODUCT_AXIS]}
        if pos_ctx:
            basis, axis = "按产品/服务(product/service · 单一经营分部)", PRODUCT_AXIS
            rev = collect(REV_TAGS, pos_ctx)
            op = {}
    if not rev:
        return {"status": "needs_review",
                "reason": "无事業セグメント亦无ProductOrService分部context(IFRS/自定义轴/单值)"}

    # 按值去重:同一分部被新旧两个 element 各标一遍(如阿里改名过渡 AIDC),
    # 十亿量级精确同值=别名,只保一份(留较长/更具体的名),防合计虚高。
    by_val, aliases = {}, []
    for mem, v in rev.items():
        if not v:
            continue
        iv = int(v)
        if iv in by_val:
            keep, drop = (by_val[iv], mem) if len(by_val[iv]) >= len(mem) else (mem, by_val[iv])
            by_val[iv] = keep
            aliases.append(_camel(drop) + " = " + _camel(keep))
        else:
            by_val[iv] = mem
    seg_sum = sum(by_val.keys())
    segments = []
    for iv, mem in by_val.items():
        segments.append({"segment": _camel(mem), "revenue": iv,
                         "pct": round(iv / seg_sum, 4) if seg_sum else None,
                         "operating_income": int(op[mem]) if op.get(mem) else None})
    segments.sort(key=lambda s: -(s["revenue"] or 0))
    out = {"status": "ok", "basis": basis, "segment_axis": axis,
           "currency": rccy, "segments": segments, "segment_sum": seg_sum}
    if aliases:
        out["deduped_aliases"] = aliases
    # 勾稽:合并总营收 vs 分部合计;残差补"其他·调整"。
    # 合并总营收=无维度全年 context 上所有收入标签的最大值(真总额=最大者,
    # 自动对齐分部所用概念;防 RevenueFromContract-excluding 漏掉 Revenues 的差额)。
    nodim = {cid for cid, c in ctx.items() if _is_fy(c, report_date) and not c["dims"]}
    total = None
    for el in root:
        if (_ln(el.tag) in REV_TAGS and el.get("contextRef") in nodim
                and units.get(el.get("unitRef")) in (rccy, None) and el.text):
            total = max(total or 0, int(el.text))
    if total and total >= seg_sum * 0.95:
        # 正常:合并行≥分部合计(残差=公司未分配/抵销,正值)
        resid = total - seg_sum
        out["reconciliation"] = {"consolidated_revenue": total, "segment_sum": seg_sum,
                                 "residual_other_adjust": resid,
                                 "residual_pct": round(resid / total, 4),
                                 "pass": abs(resid) / total < 0.05}
        if resid and abs(resid) / total >= 0.005:
            out["segments"].append({"segment": "其他·调整(Other/Adjust)", "revenue": resid,
                                    "pct": round(resid / total, 4), "operating_income": None})
            for s in out["segments"]:
                s["pct"] = round(s["revenue"] / total, 4)
    else:
        # 无维度合并行<分部合计→该行是更窄概念(如合同收入子集),分部合计本身≈外部总营收
        out["reconciliation"] = {"consolidated_revenue": total, "segment_sum": seg_sum,
                                 "pass": None,
                                 "note": "无干净合并行≥分部合计(合并行系更窄概念);分部外部收入合计即≈总营收,占比以其为分母"}
    return out


def sec_segment(cik):
    """端到端:定位最新年报 → 取 instance → 解析分部营收+营业利润。"""
    loc = locate_latest_annual(cik)
    if not loc:
        return {"status": "缺·无10-K/20-F", "cik": cik}
    inst = _instance_url(cik, loc["accession"])
    if not inst:
        return {"status": "缺·无XBRL instance", "cik": cik, "form": loc["form"]}
    seg = parse_segment(_get(inst), loc["report_date"])
    seg.update({"source": f"SEC EDGAR {loc['form']} XBRL instance(一手)",
                "form": loc["form"], "fy_end": loc["report_date"],
                "filing_date": loc["filing_date"], "accession": loc["accession"]})
    return seg


if __name__ == "__main__":
    tests = [("微软", "0000789019"), ("拼多多", "0001737806"),
             ("阿里巴巴", "0001577552"), ("携程", "0001269238")]
    for nm, cik in tests:
        print(f"\n{'='*56}\n▶ {nm} (CIK={cik})\n{'='*56}")
        try:
            r = sec_segment(cik)
        except Exception as e:
            print("  ❌", repr(e)[:120]); continue
        print(f"  form={r.get('form')} fy_end={r.get('fy_end')} status={r.get('status')}")
        if r.get("status") == "ok":
            print(f"  分部合计={r['segment_sum']:,}")
            for s in r["segments"]:
                print(f"   {s['segment']:36s} rev={s['revenue']:>15,} ({(s['pct'] or 0)*100:5.1f}%) "
                      f"op={s['operating_income']}")
        else:
            print(f"  {r.get('reason','')}")
