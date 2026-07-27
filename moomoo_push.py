#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
moomoo_push.py — 笔记本端:从本机 OpenD 读 moomoo 实盘(持仓+期权+现金),推送到 Arc Patrimony 台账。

链路:moomoo App 账号 → 本机 OpenD 网关(127.0.0.1:11111,只出不进)→ 本脚本
     → POST https://arc-patrimony.onrender.com/api/holdings(x-holdings-token 鉴权,按 symbol 幂等 upsert)

用法:
  python3 moomoo_push.py            # 推一次
  python3 moomoo_push.py --loop 300 # 每 300 秒推一次(盘中挂着)
  python3 moomoo_push.py --dry      # 只打印,不推送

环境变量(必填一个):
  ARC_HOLDINGS_TOKEN  = Render 上的 HOLDINGS_WRITE_SECRET
可选:
  ARC_BASE     (默认 https://arc-patrimony.onrender.com)
  OPEND_HOST   (默认 127.0.0.1)
  OPEND_PORT   (默认 11111)

安装与排错见 MOOMOO_PUSH_SETUP.md。
"""
import argparse
import json
import os
import sys
import time
import urllib.request

ARC_BASE = os.environ.get("ARC_BASE", "https://arc-patrimony.onrender.com")
TOKEN = os.environ.get("ARC_HOLDINGS_TOKEN")
OPEND_HOST = os.environ.get("OPEND_HOST", "127.0.0.1")
OPEND_PORT = int(os.environ.get("OPEND_PORT", "11111"))

# 期权代码形如 US.MU260821P500000 / US.HXSCL260918P80000 → 属性标记为期权,数量保留正负(负=卖出义务仓)
def is_option(code: str) -> bool:
    tail = code.split(".")[-1]
    return len(tail) > 10 and tail[-7] in ("C", "P") and tail[-6:].isdigit()


def post_holding(row: dict, dry: bool) -> str:
    if dry:
        print("  [dry] ", json.dumps(row, ensure_ascii=False))
        return "dry"
    req = urllib.request.Request(
        ARC_BASE + "/api/holdings",
        data=json.dumps(row).encode(),
        headers={"Content-Type": "application/json", "x-holdings-token": TOKEN},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read()).get("ok") and "ok" or "fail"


def snapshot_and_push(dry: bool) -> None:
    from futu import OpenSecTradeContext, TrdMarket, TrdEnv, SecurityFirm, RET_OK

    trd = OpenSecTradeContext(
        filter_trdmarket=TrdMarket.US,
        host=OPEND_HOST, port=OPEND_PORT,
        security_firm=SecurityFirm.FUTUSG,   # moomoo 新加坡
    )
    try:
        ret, acc = trd.get_acc_list()
        if ret != RET_OK:
            sys.exit(f"取账户列表失败:{acc}")
        real = acc[acc["trd_env"] == "REAL"]
        print(f"账户:{real['acc_id'].tolist()}")

        ret, funds = trd.accinfo_query(trd_env=TrdEnv.REAL, currency="USD")
        if ret == RET_OK and len(funds):
            f = funds.iloc[0]
            print(f"现金 US${f['cash']:.2f} · 总资产 US${f['total_assets']:.2f} · 购买力 US${f['power']:.2f}")

        ret, pos = trd.position_list_query(trd_env=TrdEnv.REAL)
        if ret != RET_OK:
            sys.exit(f"取持仓失败:{pos}")

        print(f"持仓 {len(pos)} 条:")
        for _, p in pos.iterrows():
            code = p["code"]
            qty = float(p["qty"])
            if str(p.get("position_side", "LONG")).upper() == "SHORT":
                qty = -abs(qty)
            row = {
                "symbol": code,
                "name": p.get("stock_name") or code,
                "qty": qty,
                "avg_cost": float(p.get("cost_price") or 0),
                "currency": p.get("currency") or "USD",
                "market": "US",
                "region": "美股",
                "attribute": "期权" if is_option(code) else "正股",
                "sector": "moomoo同步",
            }
            status = post_holding(row, dry)
            print(f"  {code:28s} qty={qty:>10.1f} cost={row['avg_cost']:>10.2f}  → {status}")
    finally:
        trd.close()
    print(f"完成 {time.strftime('%Y-%m-%d %H:%M:%S')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--loop", type=int, default=0, help="循环间隔秒数;0=只跑一次")
    ap.add_argument("--dry", action="store_true", help="只打印不推送")
    args = ap.parse_args()

    if not args.dry and not TOKEN:
        sys.exit("缺 ARC_HOLDINGS_TOKEN 环境变量(= Render 的 HOLDINGS_WRITE_SECRET);或先用 --dry 试跑")

    while True:
        try:
            snapshot_and_push(args.dry)
        except ConnectionRefusedError:
            print("连不上 OpenD——请确认 OpenD 已启动并登录(默认 127.0.0.1:11111)")
        except Exception as e:
            print(f"出错:{e}")
        if not args.loop:
            break
        time.sleep(args.loop)


if __name__ == "__main__":
    main()
