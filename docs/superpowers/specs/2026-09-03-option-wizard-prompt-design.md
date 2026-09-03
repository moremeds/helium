# option-wizard prompt 重写 — 设计

**日期**：2026-09-03
**上游**：`docs/superpowers/specs/2026-09-02-option-wizard-render-design.md`（子项目 A，已落地）
**调研**：`docs/research/option-wizard/2026-09-02-frank.md`
**旧 skill**：`~/.claude/skills/option-wizard/`（424 行 SKILL.md + 13195 行 references，**不在仓库里**）

这是三分之二：A（渲染）已完成，本文是 C（prompt），B（数据工具）在后。

---

## 1. 问题

`plugins/option-wizard/team.yaml` 的 prompt 是每步一句话。review 步全文：

> Keep at most five proposals. Move the rest to the risk list with the reason each was dropped.

四个 step（universe → regime → design → review）里没有任何一步要求模型交代推理链、声明数据时效、或者回头核对自己昨天说过什么。邮件质量的上限就卡在这里，A 把渲染修好之后剩下的全部问题都在这一层。

2026-09-03 从两次真实 run 里翻出的两个具体后果：

1. **混时效**。盘前那封把 09-02 的收益率（"live today"）和 09-01 的 tide（"session 2026-09-01"）写进同一段，读者分辨不出哪句是今天的。根因是 18:00 HKT = 06:00 ET，UW 的 tide 在 RTH 之外是冻结的 —— 旧 skill 的 pitfall 07 早就写过这件事。
2. **编时间戳**。盘中那封写 "into 16:28 ET"，但那次 run 12:29 ET 就结束了。UW 返回的最后一根是 `2026-09-02T12:45:00-04:00`（带显式偏移），金额 $48.67M 和它写的 +$49M 对得上 —— **数字真，标签错 4 小时**，把 UTC 当成了 ET。

第 2 条是最危险的一类错误：读者只核对金额，永远发现不了。

---

## 2. 目标 / 非目标

**目标**

- 把旧 skill 里能在无人值守 cron 上执行的 hard rules 装回 prompt
- 把 Frank 的章节骨架和推理流水线变成固定的输出结构
- 从一天一封变成一天三封，让"预测"和"结果"落进同一天同一份状态
- 周日出周总结，周一对照 Frank

**非目标（明确删除，不做）**

| 删                                                                                                                           | 原因                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| hard rule 5 全部 FCN / AQ / DQ，`references/{fcn,aq-dq}-framework.md`，`scripts/fair_coupon.py`、`fair_aq_dq.py`，pitfall 02 | PB 结构化产品，本期不做，要交互了再说 |
| hard rule 3 下单 preflight + "恰好一个 YES/NO 问题"                                                                          | 要交互                                |
| hard rule 4 的 21DTE 动作菜单（trader 选 close / roll / hold）                                                               | 要交互                                |
| hard rule 9 的 Layer B（broker 对账）和 Layer C（人工 cross-cut）                                                            | 要 broker 连接 + 人工判断             |
| `scripts/{ib_order,manage_positions}.py`、`references/execution.md`                                                          | 要交互                                |
| 下单、改单、平仓                                                                                                             | 这条 lane 不下单，doctrine 第 5 点    |

---

## 3. 排期

五个 trigger。时区一律写 `Asia/Hong_Kong`，不写 UTC 偏移（`tenant.yaml` 现有约定）。

| #   | HKT   | ET    | 频率   | 名称        | tape               |
| --- | ----- | ----- | ------ | ----------- | ------------------ |
| 1   | 18:00 | 06:00 | 每日   | `premarket` | **冻结**，必须声明 |
| 2   | 21:00 | 09:00 | 仅周一 | `frank`     | —                  |
| 3   | 01:00 | 13:00 | 每日   | `intraday`  | live               |
| 4   | 04:15 | 16:15 | 每日   | `close`     | 已收盘，终值       |
| 5   | 20:00 | 08:00 | 仅周日 | `weekly`    | —                  |

**邮件上限**：`plugins/option-wizard/tenant.yaml` 的 `maxPerDay: 2` → `5`。

计数按 UTC 日（`plugins/delivery-email/src/channel.ts:120` 用 `toISOString().slice(0,10)`），边界在 00:00 UTC = 08:00 HKT。1/2/3/4 全部落在同一个 UTC 日：周一 4 封，其余工作日 3 封，周日 1 封。**以后加第六封的人必须先确认它没有跨过 08:00 HKT。**

**为什么 frank 单独一个触发**：他周一 12:37 UTC = 20:37 HKT 发文（实测 `publish_time: 2026-08-31T12:37:14.509Z`），比周一的盘前晚两个半小时，挂不上去。

**为什么尾盘定在收盘后**：04:15 HKT 用的是终值，markout 不用估。代价是读者第二天早上才看到。

---

## 4. 输出结构

Frank 四篇骨架完全一致。他是周更，我们是日频，所以"本周复盘"落成"本日"。

| Frank                                         | 我们                                                                                | 出现在哪几封        |
| --------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------- |
| 一、策略复盘（逐笔点名兑现/止损，亏了写亏了） | **markout**：按真实收盘价重报昨天每条建议                                           | premarket、close    |
| 二(一) 挑"最反常的那一件事"，不罗列涨跌       | **今天最大的分化是什么**（必答项）                                                  | 全部                |
| ── 国债                                       | 2Y / 10Y 绝对水位 + bps 变化 + 2s10s 形状 + 加息概率（无工具，skipped）             | premarket、weekly   |
| ── 信用                                       | HYG（ow_spot 可取）；**HY OAS / CCC OAS 本期无工具**，Layer Coverage 里写 `skipped` | premarket、weekly   |
| ── 事件深挖                                   | 每期 1–2 件，只挖结构性问题，不挖 EPS                                               | premarket、weekly   |
| ── 情景 A/B/C/D                               | 4 条互斥路径 + 显式 base case + **选它的理由** + 每条的**传导顺序**                 | premarket、weekly   |
| 二(二) GEX/DEX                                | 固定字段表（见 §6）                                                                 | premarket、intraday |
| 二(三) 重点关注                               | 每个 catalyst 写"**什么组合算证实 / 证伪**"，禁止单点预测                           | premarket           |
| 三、交易策略                                  | 编号 1–5，每条带**入场触发 / 加仓线 / 失效价 / 目标**                               | premarket           |
| —                                             | **决策块**（hard rule 10）                                                          | 全部                |

**推理流水线**（写进 prompt，编号照做）：

1. 先 mark-to-market 上一次的判断，不美化。
2. 从当日表现里挑最反常的一件事，而不是罗列涨跌。
3. **"利好落地反而下跌 = 定价权耗尽"**：对当日 beat-and-raise 却收跌的名字自动打标（earnings surprise × 当日收益率，可计算）。
4. **利率是第一因**：先定 2Y / 10Y / 2s10s + 加息概率，再按现金流久期排序谁最受伤。
5. 政策讲话剥成 reaction function，不猜下一步。
6. 对下一个事件写 A/B/C/D + 传导顺序，声明 base case 和选它的理由。
7. 板块分化归因到"预期门槛"而非"景气度"。
8. 单名深挖只挖结构性资产负债表问题。
9. **GEX 不定方向**，只给触发价和失效价；方向来自 tape + catalyst。
10. catalyst 预案写成证实/证伪组合。
11. 落到编号仓位，每条带方向 + 触发 + 加仓线 + 失效价 + 目标。

**语言**：中文口语 + 英文术语混排；粗体只给结论句；数字永远带单位和变化量（"2Y +10bps 到 4.34%"）；不写"可能会涨"，只写"站上 X 是结构修复，跌破 Y 是短线转弱"；反向风险单独成段。

---

## 5. 装回来的 hard rules

旧 skill 十条，删掉 PB 和要交互的之后剩五条。

| #     | 内容                                                                                                                              | 落地形式                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1     | Defined-risk only                                                                                                                 | **已在 `gates/ib-preflight.ts`**，代码不是 prompt，不搬    |
| 2     | 源纪律 + 每个数字带 `data_provenance`                                                                                             | 减配：只有 UW / TV / argon / apex，没有 xenon / IB Gateway |
| 6     | 止盈 50% max gain、止损 2× credit received                                                                                        | 每条建议自带，不问人                                       |
| **7** | **Freshness gate**：不许拿上一 session 收盘当 live；写"未重拉"必须说明试过什么；**引用工具返回的 timestamp 原文，不自己换算时区** | 直接修 §1 的两个 bug                                       |
| 8     | Layer Coverage 表：每层声明来源 + 时效 + ✓/skipped，跳过的必须显式标                                                              | 反"静默漏层"                                               |
| 10    | **决策块**：当前判断／我的行动／进攻程度／为什么现在／最大风险／失效条件／下一步触发器／数据可信度                                | 每封邮件结尾                                               |

**pitfalls**：旧 skill 的 7 条，删 02（AQ）后剩 6 条。不全量注入 —— 按 `situation → 1–3 条规则` 懒加载（doctrine 第 4 点）。**pitfall 07（index premarket UW feed frozen）无条件注入 premarket 那一封**，它就是这次的根因。

---

## 6. 新增 step 与工具

### role 拓扑

现在四步装不下这个结构，加两步。模型由 `requires:` 决定，不写模型名（doctrine 第 3 点）。

| step              | requires                           | 为什么这个档                              |
| ----------------- | ---------------------------------- | ----------------------------------------- |
| universe          | `[]`                               | 集合运算                                  |
| **markout**（新） | `[]`                               | 读昨天的报告 + 拉收盘价，机械对账，无推理 |
| **gex**（新）     | `[structured.output]`              | 数字填固定字段表，不允许发挥              |
| regime + 情景     | `[reason.deep]`                    | 利率第一因、分化归因、A/B/C/D             |
| design            | `[reason.deep, structured.output]` | 出结构                                    |
| review            | `[long.context]`                   | 砍到 5 条 + risk list                     |

markout 和 gex 走最便宜的档：这两步 token 最多、推理量最小。

### `ow_uw_gex`（新工具）

放弃 `ow_argon_metrics`（`uw_scan.greek_exposure_daily` 只有日频聚合 `net_gex`/`net_dex`/`call_gex`/`put_gex`，没有 strike 级）。新增租户工具走现成的 `uwGet` 模式，输出固定字段：

```
spot / HVL / 0DTE HVL / Call Resistance / Put Support /
Total GEX / Total DEX / 1D change / 1D Min / 1D Max
```

**REST 路径实现时对着 UW OpenAPI 文档核一遍再写死**，并按 `plugins/option-wizard/tools/index.ts` 的既有约定，把核对日期和验证过的响应形状写进行内注释。不凭记忆填路径。

### markout 的输入

- 昨天的报告：`$HELIUM_STATE_ROOT/reports/option-wizard-<date>-run-*.md`，现成
- 收盘价：`ow_apex_bars`
- 不依赖 B，不依赖 broker

### Frank 对照

- 枚举：`opencli substack publication https://franktrading.substack.com --limit 5 -f json`
- 全文：`opencli web read --url <post url>`（Chromium bridge，**需要登录态**）
- 本地 2026-09-03 实测通过：`08/31/2026 复盘与展望`，26.6 KB，`status: success`，无 paywall 截断
- mini 上的登录态由操作者准备
- 对照的是**我们周日的周总结**和**他周一的 note**：哪些判断一致、哪些相反、相反的那些谁对，用真实价格结算

---

## 7. 验收标准

1. `pnpm test` 全绿；新 step 各有单测。
2. 本地 preview（不发信）渲染出的 premarket 邮件包含：markout 段、分化段、A/B/C/D + base case 理由、GEX 固定字段表、编号仓位（每条四元组齐全）、决策块。
3. **每个引用的时间戳与工具返回值逐字一致**（针对 §1 的第 2 个 bug，写一条测试：把带 `-04:00` 的 fixture 喂进去，断言输出里不出现被换算过的时间）。
4. premarket 邮件显式声明 tape 的 as-of 是上一交易日。
5. 没有失效价的建议不输出。
6. `maxPerDay: 5`，五个 trigger 都在 `tenant.yaml` 里。
7. 全文不出现 `quantity` 或任何仓位规模数字（沿用 A 的既定决策）。
8. mini 上跑一次真实 premarket run，邮件人可读。

---

## 8. 不在本期 → 子项目 B

原清单是按"当时想到什么"写的延期项，没有排序。2026-09-03 的真实 premarket
run 给了排序键：**这个缺口能不能让一条已发出的候选是错的。** designer 在
rationale 里断言了 "non-earnings window"，而本 build 没有任何工具能支持它——
财报日期不在原清单里，却是唯一同时有消费行、又能让候选错的项。

| # | 项 | team.yaml 消费行 | 能让候选错 | 决定（2026-09-03） |
|---|---|---|---|---|
| B-1 | 财报日期 `ow_uw_earnings`（UW `/api/stock/{t}/info`；只查个股；到期早于财报日不带声明，渲染层核对） | design / review | 能 | 完成，live run `run-2a417b21` |
| B-2 | 政策讲话 → 市场解读：`ow_uw_calendar`（何时谁讲）+ `ow_argon_policy_path`（Frenzy 期货隐含概率，mini argon）+ `ow_macro_rates` liveNow（反应）；`ow_uw_headlines` / `ow_x_posts`（白名单 handle）只许引用不许汇总 | regime 反应函数 | 不能，但为重点内容 | 完成；UW 无 FedWatch 端点，`/api/economy/*` 403 |
| B-3 | 信用 OAS、IV 期限结构 | regime Layer Coverage / design | 不能 | 完成；HY OAS 本来就在 `ow_macro_rates`（prompt 曾错写成 NO TOOL），CCC 无源；`ow_uw_iv_term` 丢 0DTE |
| — | 大宗 `ow_tv_commodities`（TradingView 前月期货，mini 已验） | regime 按需 | 不能 | 完成 |
| — | `OW_IB_API_BASE` / `ow_ib_positions` / `toolsUnconfigured` | hard rule 4 | — | 做，但**任何 IB 项都不是 blocker**，不进排序 |
| — | NLV | 无，且 §4 明令禁止 | — | 废弃，与"无仓位规模"冲突 |

- hard rule 4（21DTE 复查）依赖持仓 → 跟 IB 项走，同样不阻塞
- 加息概率：无数据源时 prompt 里显式 `skipped`，不许由模型估；B-2 验证 UW 是否有 implied probability
