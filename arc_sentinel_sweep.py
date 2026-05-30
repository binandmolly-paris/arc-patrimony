#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
财报哨兵 · 全量巡检靶场(规模硬化)— 故意全量跑,暴露结构差异。
37 只持仓(去金ETF)逐只路由→采集→只看分部能不能落,崩点=下一批活清单。
"""
import urllib.request, json, traceback
import arc_sentinel_multi as M

UA = {"User-Agent": "ArcPatrimony research binandmolly@gmail.com"}

# SEC ticker→CIK(美股+中概ADR分部要)
def cik_map():
    d = json.loads(urllib.request.urlopen(
        urllib.request.Request("https://www.sec.gov/files/company_tickers.json", headers=UA), timeout=40).read())
    return {v["ticker"].upper(): str(v["cik_str"]).zfill(10) for v in d.values()}

CIK = cik_map()

# 持仓清单(region, symbol, name)— 去 2840.HK 金ETF
HOLD = [
    ("中国","300750.SZ","宁德时代"),("中国","300760.SZ","迈瑞医疗"),("中国","600036.SS","招商银行"),
    ("中国","0700.HK","腾讯控股"),("中国","1211.HK","比亚迪股份"),("中国","1810.HK","小米集团"),
    ("中国","9660.HK","地平线机器人"),("中国","9992.HK","泡泡玛特"),
    ("中国","BABA","阿里巴巴"),("中国","PDD","拼多多"),("中国","TCOM","携程集团"),
    ("日本","4063.T","信越化学"),("日本","6501.T","日立制作所"),("日本","7203.T","丰田汽车"),
    ("日本","8001.T","伊藤忠商事"),("日本","8002.T","丸红"),("日本","8031.T","三井物产"),
    ("日本","8035.T","东京电子"),("日本","8053.T","住友商事"),("日本","8058.T","三菱商事"),
    ("日本","8306.T","三菱日联金融"),("日本","8316.T","三井住友金融"),("日本","8766.T","东京海上"),
    ("美国","AAPL","苹果"),("美国","AMZN","亚马逊"),("美国","AVGO","博通"),("美国","BRK-B","伯克希尔"),
    ("美国","GOOGL","谷歌"),("美国","MSFT","微软"),("美国","MU","美光"),("美国","NFLX","Netflix"),
    ("美国","NVDA","英伟达"),("美国","PANW","PaloAlto"),("美国","PLTR","Palantir"),
    ("美国","TSM","台积电"),("美国","UNH","联合健康"),("美国","V","Visa"),
]

def run_one(region, symbol, name):
    if symbol.endswith(".HK"):
        code = symbol.split(".")[0].zfill(5)
        return M.fetch_hk(code, name)
    if symbol.endswith(".SS") or symbol.endswith(".SZ"):
        ts = symbol.replace(".SS", ".SH")
        return M.fetch_ashare_normal(ts, name, ["20241231", "20251231"])
    if symbol.endswith(".T"):
        return M.fetch_jp(symbol.split(".")[0] + "0", name)
    # 美股/中概 ADR
    cik = CIK.get(symbol.upper()) or CIK.get(symbol.replace("-", ".").upper())
    if not cik:
        raise RuntimeError(f"无CIK映射:{symbol}")
    return M.fetch_us(symbol, name, cik)

def seg_verdict(data):
    """从落库 dict 抽分部结论:ok段数+勾稽 / manual / A股自带 / 缺。"""
    seg = data.get("segment")
    if isinstance(seg, dict) and "status" in seg:
        st = seg.get("status")
        if st == "ok":
            # A+H 港股复用 A 股通道:分部在 by_product
            if "by_product" in seg:
                return f"✅A+H {len(seg['by_product'])}段(by_product) {seg.get('a_share_code','')}"
            n = len([x for x in seg.get("segments", []) if "其他·调整" not in x.get("segment", "")])
            rec = seg.get("reconciliation", {})
            p = rec.get("pass")
            tag = seg.get("standard") or seg.get("basis", "")[:14]
            return f"✅ {n}段 [{tag}] 勾稽pass={p}"
        if st == "manual":
            return "🟡 纯港股·人工旗"
        if st == "needs_human":
            return f"🟡 人工旗:{str(seg.get('reason',''))[:46]}"
        if st == "err":
            return f"❌ {seg.get('error','')[:70]}"
        if st and "needs_review" in str(st):
            return f"⚠️ needs_review:{seg.get('reason','')[:46]}"
        return f"⚠️ {str(st)[:60]}"
    # A股普通股轨:segment 是按年份 dict(无 status 键)
    if isinstance(seg, dict) and seg:
        yrs = sorted(seg.keys())
        last = seg.get(yrs[-1], {})
        bp = len(last.get("by_product", [])) if isinstance(last, dict) else 0
        return f"✅A股 {bp}段(by_product·{yrs[-1]})"
    return "⚠️ 无segment字段"

if __name__ == "__main__":
    print(f"全量巡检 {len(HOLD)} 只\n" + "=" * 70)
    rows = []
    for region, symbol, name in HOLD:
        try:
            data = run_one(region, symbol, name)
            v = seg_verdict(data)
        except Exception as e:
            v = f"❌崩 {type(e).__name__}: {str(e)[:80]}"
        rows.append((region, symbol, name, v))
        print(f"{region} {symbol:11s} {name:10s} {v}", flush=True)
    print("=" * 70)
    ok = sum(1 for *_, v in rows if v.startswith("✅"))
    man = sum(1 for *_, v in rows if v.startswith("🟡"))
    bad = sum(1 for *_, v in rows if v.startswith("❌") or v.startswith("⚠️"))
    print(f"📊 ✅{ok}  🟡{man}  ❌/⚠️{bad}  / 共{len(rows)}")
