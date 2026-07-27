# moomoo 实盘同步 · 笔记本端安装说明(10 分钟)

目标:让台账系统(arc-patrimony.onrender.com)始终有 moomoo 8369 户的真实持仓/期权/现金,
Claude 从台账读,不再靠日历笔记重建。

链路(只出不进,交易网关不暴露公网):

    moomoo 账号 → 本机 OpenD 网关(127.0.0.1)→ moomoo_push.py → Render /api/holdings

## 一次性安装

1. **装 OpenD**(moomoo 官方行情交易网关)
   - 下载:https://www.moomoo.com/download/OpenAPI (选 macOS 图形版 OpenD)
   - 打开 OpenD,用 moomoo 账号登录(手机验证码)。保持它开着即可,无需其他设置。

2. **装 Python 库**

       pip3 install futu-api

3. **配令牌**(= Render 环境变量里的 `HOLDINGS_WRITE_SECRET`,在 Render Dashboard → arc-patrimony → Environment 里看)

       echo 'export ARC_HOLDINGS_TOKEN="<把值贴这里>"' >> ~/.zshrc && source ~/.zshrc

4. **拉脚本并试跑**

       git pull
       python3 moomoo_push.py --dry     # 只打印,确认能读到持仓
       python3 moomoo_push.py           # 真推送一次

## 日常使用

- 盘中挂着(每 5 分钟同步一次):`python3 moomoo_push.py --loop 300`
- 或开机自启(macOS launchd):

      cat > ~/Library/LaunchAgents/com.arc.moomoo-push.plist <<'EOF'
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0"><dict>
        <key>Label</key><string>com.arc.moomoo-push</string>
        <key>ProgramArguments</key><array>
          <string>/usr/bin/python3</string>
          <string>/PATH/TO/arc-patrimony/moomoo_push.py</string>
        </array>
        <key>StartInterval</key><integer>300</integer>
        <key>EnvironmentVariables</key><dict>
          <key>ARC_HOLDINGS_TOKEN</key><string>把值贴这里</string>
        </dict>
      </dict></plist>
      EOF
      launchctl load ~/Library/LaunchAgents/com.arc.moomoo-push.plist

  (把 `/PATH/TO/` 换成仓库实际路径)

## 排错

| 现象 | 处理 |
|---|---|
| `连不上 OpenD` | OpenD 没开或没登录;打开 OpenD 界面确认状态为已连接 |
| `缺 ARC_HOLDINGS_TOKEN` | 第 3 步没配,或终端没 `source ~/.zshrc`;先用 `--dry` 验证读数 |
| 推送 401 | 令牌值和 Render `HOLDINGS_WRITE_SECRET` 不一致 |
| 期权代码看不懂 | `US.MU260821P500000` = MU 2026-08-21 到期 500 Put;qty 为负 = 卖出(义务)仓 |
| 只想看不想推 | `--dry` 永远安全 |

## 边界(设计如此)

- 脚本**只读不下单**:仅调用账户/持仓查询接口,不含任何交易调用。
- 令牌只放笔记本本地与 Render,两头之外不落盘。
- `/api/holdings` 按 symbol 幂等覆盖,重复跑不会产生重复行。
