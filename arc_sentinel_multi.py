#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
财报哨兵 · 多市场采集器 V0.2 — 投委会 4 市场试跑
港=泡泡玛特9992 / 美=微软MSFT / 日=伊藤忠8001 / A=迈瑞医疗300760。
每市场一个适配器:触发(扳机)+ 结构化核心 + 分部(turnkey则拉)+ 交叉验证 + 数据护照。
对照哨兵目标(快/准/隐形/落库)逐项判。
"""
import akshare as ak
import pandas as pd
import urllib.request, json, datetime, os, math
from arc_edinet_segment import edinet_segment
from arc_sec_segment import sec_segment
from arc_period_diff import diff_against_prior

def _key(name):
    """密钥解析:环境变量优先 → 本地 arc_keys.py(gitignored)fallback。提交代码零密钥。"""
    v = os.environ.get(name)
    if v:
        return v
    try:
        import arc_keys
        return getattr(arc_keys, name, None)
    except ImportError:
        return None

TUSHARE_TOKEN = _key("TUSHARE_TOKEN")
JQUANTS_KEY = _key("JQUANTS_KEY")
SEC_UA = "ArcPatrimony research binandmolly@gmail.com"
REPORT_LIB = os.path.expanduser(
    "~/Library/CloudStorage/GoogleDrive-binandmolly@gmail.com/我的云端硬盘/凯旋门/6_财报库")
TODAY = "2026-05-30"

def _sanitize(o):
    if isinstance(o, float) and not math.isfinite(o): return None
    if isinstance(o, dict): return {k: _sanitize(v) for k, v in o.items()}
    if isinstance(o, list): return [_sanitize(v) for v in o]
    return o

def _http_json(url, headers=None, data=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    return json.loads(urllib.request.urlopen(req, timeout=40).read())

def _tushare(api, params, fields):
    d = _http_json("http://api.tushare.pro", {"Content-Type": "application/json"},
                   json.dumps({"api_name": api, "token": TUSHARE_TOKEN, "params": params, "fields": fields}).encode())
    if d.get("code") != 0: raise RuntimeError(f"Tushare {api}: {d.get('msg')}")
    return [dict(zip(d["data"]["fields"], r)) for r in d["data"]["items"]]

def _load_prior(d, name):
    """该标的现存最新 sentinel 文件(=上一次落库)= 跨期 diff 的对照。"""
    import glob
    fs = sorted(glob.glob(os.path.join(d, f"{name}_sentinel_*.json")))
    if not fs:
        return None
    try:
        return json.load(open(fs[-1], encoding="utf-8"))
    except Exception:
        return None

def save(data, market_dir, name):
    fname = f"{name}_sentinel_{TODAY}.json"
    # ☁️ 云端模式(GitHub Actions/Render):经 Node /api/drive/upsert 写财报库,无本地盘
    if os.environ.get("SENTINEL_CLOUD"):
        from arc_drive_io import _set_secret, cloud_save
        _set_secret(os.environ.get("DRIVE_WRITE_SECRET"))
        prior = None   # 云端跨期对照后续接 /find 读旧文件(二期);先按首次处理
        data["period_diff"] = diff_against_prior(prior, data)
        data = _sanitize(data)
        return cloud_save(market_dir, name, fname,
                          json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False))
    # 🖥️ 本地模式:直接写 Google Drive 挂载盘
    d = os.path.join(REPORT_LIB, market_dir, name, "JSON"); os.makedirs(d, exist_ok=True)
    # ⭐跨期 diff(良心的历史那一半):写前比上期(=现存最新文件),变了挂旗
    data["period_diff"] = diff_against_prior(_load_prior(d, name), data)
    data = _sanitize(data)
    p = os.path.join(d, fname)
    json.dump(data, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2, allow_nan=False)
    return p

# A+H 双重上市映射:港股代码 → A股 Tushare 代码(分部走已建 A 股通道,零新增工程)
AH_MAP = {
    "01211": "002594.SZ",   # 比亚迪股份 1211.HK = 002594.SZ
    "01088": "601088.SH",   # 中国神华 1088.HK = 601088.SH
    "03968": "600036.SH",   # 招商银行 3968.HK = 600036.SH
}


def ashare_segment(ts_code, year):
    """复用 A 股 akshare stock_zygc_em 取某年分部(按产品+按地区)。A+H 港股分部复用此通道。"""
    code6 = ts_code.split(".")[0]
    pre = "SH" if ts_code.endswith(".SH") else "SZ"
    segdf = ak.stock_zygc_em(symbol=pre + code6)
    d = datetime.date(int(year), 12, 31)
    seg = {"by_product": [], "by_geography": []}
    for kind, key in [("按产品分类", "by_product"), ("按地区分类", "by_geography")]:
        sub = segdf[(segdf["报告日期"] == d) & (segdf["分类类型"] == kind)]
        for _, r in sub.iterrows():
            seg[key].append({"item": r["主营构成"],
                             "revenue": int(r["主营收入"]) if r["主营收入"] else None,
                             "pct": round(float(r["收入比例"]), 4) if r["收入比例"] else None,
                             "gross_margin": round(float(r["毛利率"]), 4)
                             if pd.notna(r.get("毛利率")) and r.get("毛利率") != "" else None})
    return seg


# ============ A股普通股轨(迈瑞 300760.SZ)============
def fetch_ashare_normal(ts_code, name, periods):
    out = {"ticker": ts_code, "name": name, "market": "A股", "currency": "CNY", "track": "普通股轨",
           "pulled_at": TODAY, "income": {}, "ratios": {}, "cashflow": {}, "segment": {},
           "cross_validation": {}, "data_passport": {}}
    yysj = ak.stock_yysj_em(symbol="沪深A股", date=periods[-1])
    code6 = ts_code.split(".")[0]
    row = yysj[yysj["股票代码"] == code6]
    out["data_passport"] = {"report_period_end": periods[-1],
                            "disclosure_date": str(row["实际披露时间"].iloc[0]) if len(row) else None,
                            "source_tier": "L1 Tushare + L2 akshare交叉", "invalidates": ["判定卡", "估值卡", "病历卡复诊"]}
    pre = "SH" if ts_code.endswith(".SH") else "SZ"
    segdf = ak.stock_zygc_em(symbol=pre + code6)
    for p in periods:
        y = p[:4]
        inc = _tushare("income", {"ts_code": ts_code, "period": p, "report_type": "1"},
                       "total_revenue,operate_profit,n_income_attr_p,basic_eps")[0]
        out["income"][y] = {"total_revenue": inc.get("total_revenue"), "operate_profit": inc.get("operate_profit"),
                            "net_income_attr_p": inc.get("n_income_attr_p"), "basic_eps": inc.get("basic_eps")}
        fi = _tushare("fina_indicator", {"ts_code": ts_code, "period": p},
                      "roe,grossprofit_margin,netprofit_margin,bps")[0]
        out["ratios"][y] = {"roe": fi.get("roe"), "gross_margin": fi.get("grossprofit_margin"),
                            "net_margin": fi.get("netprofit_margin"), "bps": fi.get("bps")}
        cf = _tushare("cashflow", {"ts_code": ts_code, "period": p, "report_type": "1"},
                      "n_cashflow_act,c_pay_acq_const_fiolta")[0]
        ocf, capex = cf.get("n_cashflow_act"), cf.get("c_pay_acq_const_fiolta")
        out["cashflow"][y] = {"ocf": ocf, "capex": capex, "fcf": (ocf - capex) if (ocf and capex) else None}
        d = datetime.date(int(y), 12, 31)
        seg = {"by_product": [], "by_geography": []}
        for kind, key in [("按产品分类", "by_product"), ("按地区分类", "by_geography")]:
            sub = segdf[(segdf["报告日期"] == d) & (segdf["分类类型"] == kind)]
            for _, r in sub.iterrows():
                seg[key].append({"item": r["主营构成"], "revenue": int(r["主营收入"]) if r["主营收入"] else None,
                                 "pct": round(float(r["收入比例"]), 4) if r["收入比例"] else None,
                                 "gross_margin": round(float(r["毛利率"]), 4) if pd.notna(r.get("毛利率")) and r.get("毛利率") != "" else None})
        out["segment"][y] = seg
        ts_rev = inc.get("total_revenue") or 0
        ak_sum = sum(s["revenue"] for s in seg["by_product"] if s.get("revenue"))
        out["cross_validation"][y] = {"tushare_revenue": ts_rev, "akshare_segment_sum": ak_sum,
                                      "diff_pct": round(abs(ts_rev - ak_sum) / ts_rev * 100, 3) if ts_rev else None,
                                      "pass": (abs(ts_rev - ak_sum) / ts_rev < 0.02) if ts_rev else False}
    return out

# ============ 港股(泡泡玛特 9992)轮询 ============
def fetch_hk(code, name):
    out = {"ticker": code + ".HK", "name": name, "market": "港股", "currency": "HKD/CNY",
           "pulled_at": TODAY, "indicators": {}, "segment": {}, "data_passport": {}}
    df = ak.stock_financial_hk_analysis_indicator_em(symbol=code, indicator="年度")
    df = df.sort_values("REPORT_DATE", ascending=False)
    latest = df.iloc[0]
    rpt_end = str(latest.get("REPORT_DATE"))[:10]
    out["data_passport"] = {"report_period_end": rpt_end,
                            "disclosure_date": "轮询探测(港股无日历源)", "source_tier": "L2 akshare HK 主源",
                            "invalidates": ["判定卡", "估值卡", "病历卡复诊"]}
    for _, r in df.head(3).iterrows():
        y = str(r.get("REPORT_DATE"))[:10]
        out["indicators"][y] = {"营业总收入": r.get("OPERATE_INCOME"), "净利润": r.get("HOLDER_PROFIT"),
                                "EPS": r.get("BASIC_EPS"), "ROE": r.get("ROE_AVG"), "毛利率": r.get("GROSS_PROFIT_RATIO")}
    # ⭐分部:A+H 双重上市→复用已建 A 股分部通道;纯港股→唯一权威源=HKEX 官方公告(无API,挂人工旗)
    if code in AH_MAP:
        ts_code = AH_MAP[code]
        try:
            seg = ashare_segment(ts_code, rpt_end[:4])
            out["segment"] = {"status": "ok", "basis": "A+H 复用A股通道(akshare stock_zygc_em)",
                              "a_share_code": ts_code, "currency": "CNY",
                              "by_product": seg["by_product"], "by_geography": seg["by_geography"]}
        except Exception as e:
            out["segment"] = {"status": "err", "a_share_code": ts_code, "error": repr(e)[:120]}
    else:
        out["segment"] = {"status": "manual",
                          "segment_status": "纯港股·无干净程序化分部源→轮询触发后挂人工旗,"
                                            "由 Claude 读 HKEX 披露易官方业绩公告抽取(隐形铁律的人工逃生口)",
                          "authoritative_source": "HKEX 披露易 official results announcement(PDF/HTML,无API)"}
    return out

# ============ 美股(微软 MSFT)SEC ============
def fetch_us(symbol, name, cik):
    out = {"ticker": symbol, "name": name, "market": "美股", "currency": "USD", "pulled_at": TODAY,
           "income": {}, "segment": {}, "data_passport": {}}
    sub = _http_json(f"https://data.sec.gov/submissions/CIK{cik}.json", {"User-Agent": SEC_UA})
    r = sub["filings"]["recent"]
    trig = None
    for f, dt in zip(r["form"], r["filingDate"]):
        if f in ("10-K", "10-Q"): trig = (f, dt); break
    out["data_passport"] = {"latest_filing": f"{trig[0]} @ {trig[1]}" if trig else None,
                            "disclosure_date": trig[1] if trig else None, "source_tier": "L1 SEC EDGAR 官方一手",
                            "invalidates": ["判定卡", "估值卡", "病历卡复诊"]}
    for concept, key in [("RevenueFromContractWithCustomerExcludingAssessedTax", "revenue"), ("NetIncomeLoss", "net_income")]:
        try:
            cc = _http_json(f"https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/us-gaap/{concept}.json", {"User-Agent": SEC_UA})
            for x in cc["units"]["USD"]:
                if x.get("form") == "10-K" and x.get("fp") == "FY":
                    y = x["end"][:4]
                    out["income"].setdefault(y, {})[key] = x["val"]
        except Exception as e:
            out["income"]["_err_" + key] = str(e)[:80]
    # 只留最近3年(注:income 走 companyconcept 仅 10-K/USD;中概 20-F/CNY 此段空,分部走下方模块)
    yrs = sorted([k for k in out["income"] if k.isdigit()])[-3:]
    out["income"] = {y: out["income"][y] for y in yrs}
    # ⭐分部(二期 SEC XBRL instance:微软型业务分部 / 阿里型多轴 / PDD携程按产品回退)
    try:
        out["segment"] = sec_segment(cik)
    except Exception as e:
        out["segment"] = {"status": "err", "error": repr(e)[:120]}
    return out

# ============ 日股(伊藤忠 8001→80010)J-Quants ============
def fetch_jp(code5, name):
    out = {"ticker": code5[:4] + ".T", "name": name, "market": "日股", "currency": "JPY", "pulled_at": TODAY,
           "fins": {}, "segment": {}, "data_passport": {}}
    d = _http_json(f"https://api.jquants.com/v2/fins/summary?code={code5}", {"x-api-key": JQUANTS_KEY})
    rows = [r for r in d["data"] if r.get("DocType") and "FY" in str(r.get("CurPerType", ""))][-3:] or d["data"][-3:]
    latest = d["data"][-1]
    out["data_passport"] = {"report_period_end": latest.get("CurPerEn"), "disclosure_date": latest.get("DiscDate"),
                            "source_tier": "L1 J-Quants JPX官方(決算短信)", "invalidates": ["判定卡", "估值卡", "病历卡复诊"]}
    for r in rows:
        y = str(r.get("CurPerEn", ""))[:4] or str(r.get("DiscDate"))[:4]
        out["fins"][r.get("DiscDate", y)] = {"period_end": r.get("CurPerEn"), "sales": r.get("Sales"),
                                             "operating_profit": r.get("OP"), "net_income": r.get("NP"),
                                             "eps": r.get("EPS"), "bps": r.get("BPS"), "roe_equity": r.get("Eq")}
    # ⭐分部(EDINET 有報·二期):最新FY有報未交则回退上一FY(短信早7周,有報6月下旬才出)
    fy_cands = []
    for r in sorted(rows, key=lambda x: str(x.get("CurPerEn", "")), reverse=True):
        pe = str(r.get("CurPerEn", ""))           # "2026-03-31"
        if len(pe) >= 7 and pe[:4].isdigit():
            try:
                fy_cands.append((int(pe[:4]), int(pe[5:7]), float(r["Sales"]) if r.get("Sales") else None))
            except (ValueError, TypeError):
                pass
    seg = {"status": "needs_human", "reason": "缺·有報未定位(EDINET窗口内无)"}
    for fy_year, fy_month, sales in fy_cands:
        try:
            s = edinet_segment(code5, fy_end_month=fy_month, fy_end_year=fy_year, total_revenue=sales)
        except Exception as e:
            s = {"status": "err", "error": repr(e)[:120]}
        st = s.get("status")
        if st == "ok":
            seg = s
            break
        if st == "needs_human":          # 有報已找到但解析/勾稽未过→定论,不再回退旧FY
            seg = s
            break
        # status 以"缺"开头(有報未定位)→ 回退上一 FY 再试
    out["segment"] = seg
    return out


if __name__ == "__main__":
    jobs = [
        ("A股 迈瑞医疗", lambda: fetch_ashare_normal("300760.SZ", "迈瑞医疗", ["20241231", "20251231"]), "中国", "迈瑞医疗"),
        ("港股 泡泡玛特", lambda: fetch_hk("09992", "泡泡玛特"), "中国", "泡泡玛特"),
        ("美股 微软", lambda: fetch_us("MSFT", "微软", "0000789019"), "美国", "微软"),
        ("日股 伊藤忠", lambda: fetch_jp("80010", "伊藤忠商事"), "日本", "伊藤忠商事"),
    ]
    summary = []
    for label, fn, mdir, nm in jobs:
        print(f"\n{'='*54}\n▶ {label}\n{'='*54}")
        try:
            data = fn()
            path = save(data, mdir, nm)
            pp = data.get("data_passport", {})
            print(f"  ✅ 落库: ...{os.path.basename(path)}")
            print(f"  报告期: {pp.get('report_period_end') or pp.get('latest_filing')} | 披露日: {pp.get('disclosure_date')}")
            cv = data.get("cross_validation")
            if cv:
                for y, v in cv.items(): print(f"  交叉验证 {y}: diff {v.get('diff_pct')}% pass={v.get('pass')}")
            if data.get("segment_status"): print(f"  分部: {data['segment_status']}")
            seg = data.get("segment")
            if isinstance(seg, dict) and seg.get("status") == "ok":
                rec = seg.get("reconciliation", {})
                tag = seg.get("standard") or seg.get("basis", "")          # JP=准则 / US=basis
                src = seg.get("docID") or seg.get("form", "")              # JP=docID / US=form
                rp = rec.get("residual_pct")
                print(f"  分部[{tag}·{src}]: {len(seg['segments'])}段"
                      + (f" · 勾稽{'残差%.1f%%'%(rp*100) if rp is not None else '行概念不匹配'} pass={rec.get('pass')}" if rec else ""))
                for s in seg["segments"][:6]:
                    print(f"     {s['segment']:34s} {(s['pct'] or 0)*100:5.1f}%")
            elif isinstance(seg, dict) and seg.get("segment_status"):
                print(f"  分部: {seg['segment_status']}")
            summary.append((label, "✅", pp.get("disclosure_date")))
        except Exception as e:
            print(f"  ❌ {repr(e)[:160]}")
            summary.append((label, "❌ " + repr(e)[:60], None))
    print(f"\n{'='*54}\n📊 4 市场试跑汇总\n{'='*54}")
    for l, s, d in summary: print(f"  {l}: {s}  披露日={d}")
