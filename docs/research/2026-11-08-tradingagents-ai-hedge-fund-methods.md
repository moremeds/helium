# TradingAgents 与 ai-hedge-fund：方法论拆解（2026-11-08）

只取方法，不取界面和代码。源码快照：
- TradingAgents `TauricResearch/TradingAgents` HEAD `9fa1196`（2026-11-04）
- ai-hedge-fund `virattt/ai-hedge-fund` main `6640aca`（v2，`hedge_fund/`）；v1 取自 `6c41ae8`（`src/`，在 `a7a99e5` 被删除）

路径相对各自仓库根目录。两份原始拆解由 Sonnet worker 读源码完成，lead 抽查了关键结论。

## A. TradingAgents

| 方法 | 做法 | 来源 |
|---|---|---|
| 并行分析师 + 汇合 | 市场、情绪、新闻、基本面 4 个分析师并行，各自有私有消息历史；全部完成后才进入辩论 | `graph/setup.py:53-90,166` |
| 工具轮数上限 | `max_tool_rounds=20`，超过后注入 WRAP_UP 强制出报告 | `analysts/turn.py:7-10` |
| 多空辩论 + 裁判必须表态 | Bull/Bear 轮流（默认 1 轮）；Research Manager "冲突本身不是 Hold 的理由，选更强的一方"，不看发言先后 | `researchers/*`、`research_manager.py:36` |
| 风控三方辩论 | 激进 / 保守 / 中立三个人格轮流评审交易员方案 | `risk_mgmt/*.py` |
| 路由是代码 | 辩论轮数、谁下一个发言都由代码决定，不由 LLM 决定 | `conditional_logic.py:15-28` |
| 分级模型 | 分析师、辩手用 quick 档；两个裁判（Research Manager、Portfolio Manager）用 deep 档；每档可用不同 provider | `setup.py:125-140`、`default_config.py:101-107` |
| 结构化决策 | 5 档评级 Buy/Overweight/Hold/Underweight/Sell；解析失败记为 `REVIEW`，不默认成 Hold | `schemas.py:66-73`、`rating.py:30` |
| 决策日志 + 结算 | 每个 (ticker, date) 一条；入场 = 决策日后第一个收盘，持有 5 个交易日，算原始收益和相对 SPY 的 alpha；当天的 bar 不结算 | `memory/settlement.py:60-125` |
| 反思 | 代码算好收益数字，quick LLM 只写 2-4 句：alpha 说明了什么、论点哪部分被支持或推翻、一条教训 | `reflection.py:22-61` |
| 经验回灌 | 只给最终决策者看：同 ticker 最近 5 条 + 跨 ticker 3 条反思；按时间和 ticker 取，不用向量检索 | `log.py:93-133`、`setup.py:158` |
| Point-in-time | `trade_date` 由框架注入，模型不能传；模型给的日期一律截到 as-of；FRED 固定 realtime 区间；SEC 只用 `filed <= as_of` 的值；没有日期的数据在历史运行中扣留；数据不可得时写"unavailable"而不是"没有" | `dataflows/date_window.py:24-111`、`vendors/fred.py:195`、`vendors/sec_edgar.py:154-224` |
| 回测 | ticker × 日期网格，每格独立运行、独立日志，按评级统计命中率和平均 alpha；自己承认文本数据没有归档，结果"仅供参考" | `backtest.py:9-14,100-260` |

**与我们规则冲突（不采用）：** 交易员让 LLM 写 `entry_price`、`stop_loss`、`price_target`、`position_sizing`，没有代码校验（`trader/trader.py:56-59`）；辩手可以自由复述或推导数字；没有期权；token 统计只有 CLI 总数。

## B. ai-hedge-fund

| 方法 | 做法 | 来源 |
|---|---|---|
| 代码打分 → LLM 映射（v1） | Buffett 等人格：代码按阈值算子分数和安全边际，LLM 只拿到这些事实，输出 `{signal, confidence, reasoning}`，提示"不要编造数据" | `v1:src/agents/warren_buffett.py:108-125,156,746` |
| 代码预判（v1） | Burry：代码先给初步信号（≥0.7 满分看多、≤0.3 看空），再交给 LLM | `v1:src/agents/michael_burry.py:109-115` |
| 纯代码分析师（v1） | 估值、技术、情绪、风控都是代码，置信度来自效应大小 | `v1:src/agents/valuation.py`、`technicals.py` |
| 允许动作菜单（v1） | 代码先算出每个 ticker 允许的动作和最大数量；没有可做动作的直接记 hold，不送 LLM；LLM 只在菜单里选 | `v1:src/agents/portfolio_manager.py:96,191-205` |
| LLM 退出交易决策（v2） | 信号按置信度加权混合（只做多的分析师不能制造空头）→ 七级"只缩不放"的风控限额 → 代码下单 | `portfolio/construction.py:29-105`、`risk/limits.py:127-279` |
| 弃权 | 数据失败时弃权，弃权不计入混合 | `construction.py:71-72` |
| T 决策、T+1 成交 | 修复了 v1 同日收盘决策又成交的泄漏 | `pipeline/session.py:11-18` |
| 按申报日过滤 | v2 用 `filing_date_lte`（v1 的 `report_period_lte` 有前视） | `data/client.py:159-168` |
| 盲化提示 | 回测时提示里去掉 ticker、日期和金额，减少模型对历史的记忆泄漏 | `llm_agent.py:58-65` |
| 记分卡 → 调权重 | 每个观点按其声明的期限打分：命中率、slugging、每日 Spearman IC 及 t 值；至少 20 个已评分日期后，按 `clip(1+0.25·t, 0.25, 2.0)` 调分析师权重；不回灌提示词 | `scorecard/analysts.py:50-135`、`scorecard/allocation.py:23-71` |
| 哈希链账本 + 提示缓存 | 每次决策的输入输出、代码版本、模型都入账；相同快照不重复花 token | `pipeline/session.py:83-108`、`llm/cache.py` |

**与我们规则冲突（不采用）：** v2 人格直接读原始比率表让 LLM 判断（比 v1 退步）；v1 组合经理的数量由 LLM 定、只靠提示约束；LLM 自报置信度未校准；会下单（纸面/模拟券商）；没有期权；没有 token 统计。

## C. 两者共同点（= 我们要靠拢的骨架）

1. 角色分工：多个窄分析师并行 → 对立观点 → 一个裁判做最终决定。
2. 结构化信号：每个分析师输出 `{signal, confidence, abstained, reasoning}`，而不是一段散文。
3. 决策入账并按期限结算，结算结果反过来影响下一次（TA：回灌教训；AHF：调权重）。
4. Point-in-time 由框架强制，而不是靠提示。

我们已经比两者更严格的地方：LLM 不做算术、数字必须逐字来自工具（gate）、只做 defined-risk、不下单、按 agent/步的 token 审计。
