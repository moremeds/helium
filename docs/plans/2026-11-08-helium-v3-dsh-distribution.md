# Helium v3：Helium 就是一个 DSH 发行版（破坏性重写，全新架构）

日期：2026-11-08（2026-11-09 修订：先做框架，内容另起）　状态：P0 通过，P1 进行中
取代：`2026-11-03-helium-superagent.md` 的 P0；`.worktrees/chore-dsh-0-2-1` 作废（只改了版本号）。
方法论依据：`docs/research/2026-11-08-tradingagents-ai-hedge-fund-methods.md`

## 0. 已定的决定（用户）

| # | 决定 | 日期 |
|---|---|---|
| 1 | 模型用 Claude | 11-08 |
| 2 | position-review 并入这次升级 | 11-08 |
| 3 | 不回填 argon 的历史内容 | 11-08 |
| 4 | 能删的都删；破坏性更新，全新架构 | 11-08 |
| 5 | **option-wizard 只发 argon；position-review 只发邮件** | 11-09 |
| 6 | **本计划只做框架。** 现有内容质量很差；框架完成后重新检视，按 TradingAgents / ai-hedge-fund 重新设计两个产品的内容（第二阶段，另写计划） | 11-09 |

由决定 6 推出：
- 第一阶段的验收不看简报内容，只看框架能力（第 4 节）。
- 旧的 option-wizard 在 mini 上继续运行，直到第二阶段的新内容上线；第一阶段不改 mini 上的 `current` 和 launchd。
- BriefView v4 和 argon 页面改动属于第二阶段。

## 1. 为什么（证据）

| 事实 | 来源 |
|---|---|
| Helium 锁在 `0.1.2-alpha.3`（2026-08-31）；npm latest 是 `0.2.2-rc.1` | `package.json`；`npm view @deepseek-ai/dsh` |
| Helium `new Context()` + 手工 `ctx.plugin()`，绕开 profile/bundle | `plugins/provider-dsh/src/runtime.ts:60-103` |
| 0.2 删了 `toolFilter`、`Session.events`，新增必需服务 `dsh-working-directory` | superagent 计划 P0 节 |
| 官方结构：`dsh` 启动器 + profile（bundle 有序叠加）+ `engines.dsh` 检查 | 上游 `apps/cli/README.md`、`docs/user/develop/basic/publish.zh.md` |
| SDK JSON-RPC 太薄：一个运行时一个模型，无 preset、无工具限制、无 outputSchema、无取消 | `@deepseek-ai/dsh-sdk-protocol@0.2.2-rc.1` `InitializeParams` |
| 代码可确定性驱动子 agent：`ctx.subagents.startActivation({provider:'spawn', request:{agentPreset, outputSchema, agentOptions, maxDepth, parent, prompt, signal}, delivery:'caller'})` | `@deepseek-ai/dsh-subagent` `types.d.ts:127`；上游 subagent README |
| preset 工具限制是强制的（preset 外返回 `UNKNOWN_TOOL`）；host 层（base 行）工具对所有 agent 可见，必须在 host 层禁用 | 上游 `packages/core/tools/README.zh.md`；`web-app/cordis.patch.yml` |
| patch 无 `remove`：用 `- id: X` + `disabled: true`；`config` 整体替换 | 上游 `vendor/include/src/patch.ts` |
| headless 文档的做法：禁用 `headless-runner`，挂自己的 runner | 上游 `packages/bundle/headless/README.zh.md` |
| DSH 没有按 agent 的 token/cost 表；用量在 session jsonl 的 `assistant/message.usage` | 上游 token-meter、persistence-catalog |
| `dsh@0.2.2-rc.1` 要求 Node `>=24.9.0` | tarball `package.json` `engines` |

## 2. 架构

```
helium/                          pnpm workspace，engines.node >=24.9
├─ bundles/
│  ├─ helium-base/               发行版层：不含任何业务词
│  │  ├─ cordis.patch.yml        禁用 host 层 bash/写文件/plugin_manager/web 等；Claude 路由；挂载下列插件
│  │  └─ src/
│  │     ├─ runner.ts            app 插件：读 ctx.cmdlineArgs → 跑一次 `<bundle> --phase <p> [--as-of D]`
│  │     ├─ pipeline.ts          ctx.heliumPipeline：任务 DAG。原语：代码任务、agent 任务(preset+outputSchema)、
│  │     │                       并行扇出、按 key map、辩论轮次、菜单选择、gate、工具轮数上限+强制收尾
│  │     ├─ asof.ts              包装每个工具：as-of 由框架注入；模型给的日期截到 as-of；无日期数据在回放中扣留
│  │     ├─ models.ts            capability → Claude 档位（agentOptions）；角色只写 requires
│  │     ├─ ledger.ts            决策入账；到期结算（结算函数由 bundle 提供）；反思；记分卡（命中率、IC、t 值）
│  │     ├─ audit.ts             run 结束把所有子 session 用量写进 SQLite span 表（含 cache_write）
│  │     ├─ replay.ts            `helium replay`：ticker × 日期网格，每格独立运行（取代 pit-replay.sh）
│  │     └─ delivery/            ctx.heliumDelivery：argon、email(Resend)、markdown、file；
│  │                             每个 bundle 在 patch 里声明允许的通道，越界直接拒绝
│  ├─ smoke/                    第一阶段的验收 bundle：只用假数据和一个真 Claude 调用跑通全部原语
│  ├─ option-wizard/            第二阶段：盘前 / 盘中 / 盘后 / 周报 → 只发 argon
│  └─ position-review/          第二阶段：持仓复盘 → 只发邮件
├─ profile/                      profile 模板（dsh.profile.bundles + cordis.patch.yml）
├─ scripts/{install-profile.sh,deploy.sh,receive-deploy.sh,run.sh}
└─ launchd/
```

Profile `helium` 的 bundle 顺序：`@deepseek-ai/dsh-base` → `helium-base` → 各产品 bundle。

### 2.1 Doctrine 对照（验收标准）

| Doctrine | 怎么满足 |
|---|---|
| 1 自我改进 | 框架提供内容层的学习回路：记分卡按角色打分，≥20 个评分日后给出权重建议（是否自动生效由第二阶段决定）；反思回灌给裁判；`helium replay` 让每次改动可以在历史日期上对比。仓库层的自我改进（agent 改 Helium 自己的代码）不在本计划内，见第 10 节 |
| 2 多用途 | helium-base 不含业务词（一条 grep 测试）；业务全在 bundle |
| 3 可插拔 | 新产品 = 新 bundle；角色 = preset，只写 `requires` |
| 4 token 意识 | span 表按 run/角色/步记录；记分卡同时报"每个角色的 IC / 每百万 token"；相同输入快照命中缓存 |
| 5 沙箱边界 | host 层禁用执行和写入工具；不写生产数据湖；没有任何下单工具 |
| 6 仪式要有回报 | 删掉 router/lease/budget/scoreboard/runtime-*/contracts；只留守输出和守安全的测试 |

## 3. 框架要提供的能力（第一阶段的范围）

第二阶段的内容会按 TradingAgents / ai-hedge-fund 重新设计。框架不预设内容，但必须让这些方法可以直接用配置和小段代码表达：

| 能力 | 对应的方法 | 模块 |
|---|---|---|
| 代码任务、agent 任务（preset + outputSchema）、并行扇出、按 key map（每个 ticker / 每个持仓） | 并行窄分析师 | `pipeline.ts` |
| 辩论轮次（A/B 轮流 N 轮，代码决定谁发言） | 多空辩论、风控辩论 | `pipeline.ts` |
| 菜单选择：代码给候选列表，agent 的 outputSchema 只能是列表里的 id 或"不做" | 允许动作菜单 | `pipeline.ts` |
| 工具轮数上限 + 强制收尾 | 无人值守有界 | `pipeline.ts` |
| gate：阻断 / 建议两级；数字逐字来自被引用的工具输出 | 我们自己的规则 | `pipeline.ts` + bundle 的 gate 函数 |
| as-of 注入与截断；回放中扣留无日期数据；"不可得"≠"没有" | point-in-time | `asof.ts` |
| capability → Claude 档位（Sonnet 便宜档 / Opus 强档） | 分级模型 | `models.ts` |
| 决策入账、到期结算（bundle 提供结算函数）、反思（只用代码数字）、回灌只给指定角色且只给 `resolved <= as_of` | 记忆与结算 | `ledger.ts` |
| 记分卡：命中率、IC、t 值；≥20 个评分日后才输出权重建议 | 记分卡调权重 | `ledger.ts` |
| ticker × 日期网格回放，每格独立运行、独立账本 | 回测网格 | `replay.ts` |
| 每 run / 角色 / 步的 token、成本、上下文大小落表；相同输入快照命中缓存 | doctrine #4 | `audit.ts` |
| 通道白名单：option-wizard 只能 argon（+ 本地 markdown）；position-review 只能 email（+ 本地 markdown） | 决定 5 | `delivery/` |

Claude 档位：

| capability | 默认模型 | 用途 |
|---|---|---|
| `reason.quick` | Claude Sonnet（档位内最新） | 分析师、辩手、反思 |
| `reason.deep` | Claude Opus（档位内最新） | 裁判、写作、复盘 |

具体 model id 在 P0 锁定，写在 helium-base 配置里。凭据沿用订阅 OAuth token（需要 `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`，见旧 `runtime.ts` 的 `authHeaders`）；P0 验证 0.2 的 pi-ai 配置能否带这两个 header，不能就改用 API key。

## 4. 第一阶段：框架

全部在 `.worktrees/helium-v3/`（分支 `v3/dsh-distribution`）里做。

### P0 Spike（约 1 天，假 LLM，不碰 master，mini 只读）

| # | 要证明的事 | 通过标准 |
|---|---|---|
| 1 | Node | 笔记本和 mini 都能跑 Node ≥24.9（mini 用 login PATH 打印版本） |
| 2 | 自定义 runner | `dsh --profile helium <args>` 启动；headless runner 已禁用；runner 拿到参数；退出码正确 |
| 3 | 代码驱动子 agent | `startActivation` + `agentPreset` + `outputSchema` 拿到结构化结果；`agentOptions` 换模型生效；多个子 agent 并行 |
| 4 | 工具范围 | 子 agent 只看到 preset 内工具；host 层 bash/write/edit/plugin_manager 不可见（断言完整集合 + 允许的工具能执行） |
| 5 | Claude 路由 | 经代理，用订阅 token 调用一次 Sonnet 和 Opus 成功 |
| 6 | 用量 | 从子 session jsonl 读出每步 input/output/cache_read/cache_write |
| 7 | 测试启动 | vitest 在临时 `$DSH_HOME` 启动 profile，`ctx.llm.registerAdapter` 接假 LLM |
| 8 | 给 superagent 留路 | 某一个 preset 能重新打开 base 的 bash / 文件编辑工具，cwd 限定在一个 worktree；同一进程里其他角色仍然看不到这些工具（第 11 节） |

任何一项失败 → 停下来回报。第 2 项的退路：用 `@deepseek-ai/dsh/profile-boot` 的 `runProfile()` 从一个小 Node 入口启动同一个 profile。

### P0 结果（2026-11-09，全部通过）

Spike 代码在 `/tmp/v3-spike/`（一次性），证据如下。

| # | 结果 | 证据 |
|---|---|---|
| 1 | 通过：笔记本 Node v25.1.0；mini v25.9.0（`/opt/homebrew/bin/node`，login PATH 已打印） | ssh 输出 |
| 2 | 通过：`dsh --profile helium run smoke --phase premarket` 启动自定义 runner；`ctx.cmdlineArgs.get()` 返回 `["run","smoke","--phase","premarket"]`；`ctx.appExit` 给出退出码 | runner 日志 |
| 3 | 通过：无 prompt 的 driver agent（`agents.create` + `whenIdle`）可作 `startActivation` 的 parent；两个子 agent 并行；`agentOptions` 分别用了不同模型；`outputSchema` 经 `structured_output` 工具返回 `structured` | 子 session 日志 |
| 4 | 通过：role-a 只看到 `["structured_output","tool_a"]`，role-b 只看到 `["structured_output","tool_b"]`；host 层 bash/fs/plugin_manager 不可见。`tool-working-directory`、`plan-mode` 也要在 host 层禁用（已加） | fake LLM 记录的工具列表；`--dump-config` |
| 5 | 通过：订阅 token（`sk-ant-oat…`）pi-ai 原生支持，不需要自定义 header；`apiKeyEnv: CLAUDE_CODE_OAUTH_TOKEN`；`claude-sonnet-5-5` 和 `claude-opus-5-5` 都成功，提示缓存生效。mini 上经 Clash 代理同样成功（exit 0，8 秒）；mini 没有 zstd，未在 mini 上解码日志核对 model id | 笔记本子 session 日志的 `model` 和 `usage` |
| 6 | 通过：每个 `assistant/message` 带 `usage{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}`；`request/context` 带 model | 解码后的 `session.v4.jsonl.zstd` |
| 7 | 通过：全新临时 `$DSH_HOME` 安装 profile 约 1 秒、跑一次约 1 秒 → 组合测试直接启动真 `dsh` 子进程 | 计时 |
| 8 | 通过：rsi preset 在同一进程里看到 bash/read/write/edit，其他角色看不到。沙箱可写根 = **session 创建时的 cwd**（不是 `request.cwd`）；driver agent 的 `meta.cwd` 设为 worktree 后，只有 worktree 可写，外面写入被 Seatbelt 拒绝（`/tmp` 例外，macOS 默认可写） | `~/.cache` 下的探针（已删除） |
| a | outputSchema 不满足 → `stopReason: "error"`，无 `structured`，DSH 不重试 | noschema 模式 |
| b | 整体超时：`AbortSignal.timeout` → `dispose()` → 子 agent `aborted`，runner 退出 1，不挂起 | hang 模式 |

## 4.1 第一阶段范围修订（采纳 Fable 建议，2026-11-09）

Fable 只读审查后，lead 对照 spike 核实并采纳：
- **留在第一阶段**：runner、agent 任务原语（startActivation 包装 + 并行）、models（含价格）、audit span 表、ledger 的入账和结算钩子、delivery + 通道白名单、as-of 约定（工具包装，模型不能传日期）、整体超时、smoke。
- **移到第二阶段**（等第一个真实调用方）：辩论、菜单、gate 都只是 agent 任务原语上的薄形状（菜单 = outputSchema 的 enum；辩论 = 代码决定发言顺序的循环；gate = bundle 的函数），不需要框架代码；反思、记分卡、`helium replay` 没有真实数据时只能测公式。
- 角色分隔只靠 preset，不用 `tools.restrict`（spawn 子 agent 不继承父方的限制）。
- 部署陷阱：profile 用 `link:` 指向发布目录，每次部署要重新指向，而 `$DSH_HOME`（sessions、storages）保持不变 → 写进 `install-profile.sh`。
- helium-rsi 以后要用 git worktree 时，共享的 `.git` 目录需要 `additionalWritableRoots`，这是部署级配置。

### P1 删除 + helium-base

- 按第 5 节删除。
- 建 `bundles/helium-base`：第 2、3 节的全部模块。delivery 三个通道的行为从 `plugins/delivery-*/src/channel.ts` 搬过来（argon 幂等键 `(tenant, run_id)`；email 每个 ET 日上限、`[TEST] ` 前缀规则、`HELIUM_TENANT_DELIVERY` 刹车不变）。
- `profile/` 模板 + `scripts/install-profile.sh`。
- AGENTS.md 重写 Commands/Architecture；Doctrine 六条不动，头部改成"Helium 是一个 DSH 发行版"。

### P2 smoke bundle：验收全部能力

`bundles/smoke` 用假数据工具，覆盖第 3 节每一行。验收：

1. 组合测试（真 DSH、假 LLM，进 CI）：
   - 一次运行走完：代码任务 → 按 key map 的并行 agent → 一轮辩论 → 菜单选择（菜单外的选项被拒绝）→ 阻断 gate 拦下一个编造的数字 → 渲染 → markdown + span 行 + 入账。
   - 下一次运行：先结算上次的决定，反思写入，回灌只出现在指定角色的上下文里。
   - 模型传入晚于 as-of 的日期被截断。
   - 工具范围：完整可见集合断言。
   - 通道白名单：声明只发 email 的 bundle 调 argon 通道被拒绝。
2. 真模型一次（不进 CI）：同一流程用 Sonnet + Opus 跑一遍；`helium audit <run>` 一条查询给出每个角色的 token 和成本。
3. `helium replay` 在 3 个日期 × 2 个 key 上跑完，每格独立账本。
4. 记分卡在合成的 25 个评分日上算出命中率、IC、t 值，并给出权重建议。

### P3 mini 环境验证（不切换）

- 把框架装到 mini 的独立目录（例如 `~/projects/helium-v3-releases/<sha>`）和独立的 `$DSH_HOME`；**不改** `~/projects/helium-releases/current`，**不改** 现有 launchd。
- 在 mini 上手动跑一次 smoke（真 Claude，经 Clash 代理），只写 markdown。
- 用一个新脚本 `scripts/install-mini-v3.sh` 安装，不改 mini 上手装的 `~/.config/helium/receive-deploy.sh`（旧版本的发布仍走它）。`deploy.sh` / `receive-deploy.sh` 的改造放到第二阶段切换时做。
- 验收：mini 上 smoke 成功；`helium audit` 有记录；旧 option-wizard 的定时运行不受影响（当天的 argon 记录照常出现）。

### 交付

- 第一阶段是一个 PR（分支 `v3/dsh-distribution` → master），P3 验收通过后合并。
- 合并后 master 上没有旧 option-wizard。mini 上的旧版本如果需要紧急修复，从 `516ab39` 拉 `v2-maintenance` 分支修，按旧流程发布。

### 工作量估计（估计，不是承诺）

| 阶段 | 估计 |
|---|---|
| P0 | 1 天 |
| P1 | 3–4 天 |
| P2 | 2–3 天 |
| P3 | 0.5 天 |

第一阶段到此结束。完成后写第二阶段计划。

## 4B. 第二阶段（另写计划，这里只记录起点）

1. 重新检视现有内容：两个产品各自要回答什么问题、给谁看、什么算好。
2. 按 TradingAgents / ai-hedge-fund 的骨架重新设计：代码算事实 → 窄分析师并行出结构化信号 → 代码列菜单 → 对立观点 → 裁判只从菜单选 → 代码只缩不放的限额 → 写作 → gate → 发布 → 入账 → 结算 → 反思和记分卡。
3. option-wizard → 只发 argon（BriefView v4，argon 配套改动交给 argon 的 session）；position-review → 只发邮件（数据层沿用 PR #135 的 IB/Futu 只读快照，之后关闭 #135）。
4. 切换：mini 上新版本先只写 markdown 跑 2 个交易日，再打开 argon/email，停旧 launchd；回滚 = 恢复旧 `current` 和旧 plist。

下面是 11-08 写的内容草稿，第二阶段检视时作为输入，不是验收标准：

<details>
<summary>11-08 内容草稿（option-wizard 13 步流程、position-review 8 步流程）</summary>

### 草稿：两个 bundle 的设计

共同骨架（来自两个参考项目）：**代码算事实 → 窄分析师并行出结构化信号 → 代码列菜单 → 对立观点 → 裁判只从菜单选 → 代码只缩不放的限额 → 写作 → gate → 发布 → 入账 → 到期结算 → 反思和记分卡影响下一次。**
我们比两者更严：LLM 不做任何算术；数字必须逐字来自工具（gate）；只做 defined-risk；不下单。

#### 1 统一的信号 schema（所有分析师）

```
{ subject, signal: bullish|bearish|neutral, abstained: bool, abstain_reason?,
  evidence_ids: [tool_call_id...], reasoning }
```
- 置信度不由 LLM 自报。由代码从子分数的强度算，或由记分卡校准。
- `evidence_ids` 必须指向本步的工具调用；gate 检查 reasoning 里的每个数字都逐字出现在被引用的工具输出里。
- 数据缺失时必须弃权；弃权不计入汇总；页面写"不可得"，不写"平静"。

#### 2 option-wizard

| 步 | 内容 | 谁做 | 档位 |
|---|---|---|---|
| 1 settle | 先结算所有到期的旧决策（结构 P&L，代码算），写反思（只用代码数字） | 代码 + reflector | quick |
| 2 universe | 观察列表 → ticker 集合 | 代码 | — |
| 3 frame | 时段框架、轮动、事件日、宏观发布、盘前异动 | 代码 | — |
| 4 scores | 每个 ticker 的子分数：IV rank、skew、期限结构、flow、GEX、趋势、距财报/事件 | 代码（工具） | — |
| 5 analysts（并行） | regime（市场）、flow/GEX、news/overnight、catalyst/scenario、vol（按 ticker 把子分数映射成信号） | agent | quick |
| 6 screen | 按代码置信度加权汇总信号，取前 N 个候选（默认 3） | 代码 | — |
| 7 menu | 每个候选枚举 defined-risk 结构：已过 strike band、max loss、财报日、流动性检查 | 代码 | — |
| 8 debate | 每个候选 1 轮 bull / bear，只能引用证据 id 和菜单里的数字 | agent | quick |
| 9 judge | 每个候选：从菜单选一个结构或"不做"；5 档评级或 `REVIEW`；读入 `resolved <= as_of` 的反思教训 | agent | deep |
| 10 limits | 只缩不放：单名、行业、总风险预算、事件禁区 | 代码 | — |
| 11 editor | 把结构化结果写成简报正文 | agent | deep |
| 12 gates | as-of 逐字、cause 引用、数字逐字、meta-leak、字数预算 | 代码 | — |
| 13 render + deliver + ledger | BriefView v4 → argon + 本地 markdown；每个裁判决定入账 | 代码 | — |

各 phase 的取舍：
- premarket：全部 13 步。
- intraday：1、3、4、5（regime + flow）、11、12、13，不辩论、不出新决定。
- close：1–7、10–13，不辩论；出"已有决定的状态更新"。
- weekly：结算 + 记分卡 + 周复盘（deep）+ 全部 13 步面向下周，候选上限 5。

保留的工具代码：UW、TradingView/opencli、apex、argon 读接口、`ow_price_structure`、`ow_strike_check` 等（`plugins/option-wizard/tools/index.ts` 拆文件后改成 `defineTool`），以及工具里记录的线上响应形状注释。gate 逻辑和 `render/math.ts` 保留；renderer 改为输出 v4。

#### 3 position-review（并入本次升级）

数据层来自 PR #135（`feat/position-review`，head `f2677cd`）：`broker/snapshot.py` 只读连接 IB（TWS API）和 Futu（OpenD），只调用持仓/账户/挂单/历史/报价方法。

| 步 | 内容 | 谁做 | 档位 |
|---|---|---|---|
| 1 settle | 结算到期的旧建议：止损止盈是否被触及、按实际价格路径打分 | 代码 + reflector | quick |
| 2 snapshot | IB + Futu 持仓、挂单、成本 | 代码（Python，Helium 管理的 venv） | — |
| 3 facts | 每个持仓：距止损、回撤、R 倍数、到期、事件距离、是否已有止损/止盈单 | 代码 | — |
| 4 analysts（并行） | 每个持仓：趋势/vol、flow/GEX、事件；输出 3.1 信号 | agent | quick |
| 5 menu | 持有 / 减仓 / 平仓 / 展期 + 止损止盈候选价位（`tools/levels.ts`） | 代码 | — |
| 6 judge | 每个持仓从菜单选动作和价位，写理由 | agent | deep |
| 7 limits + gate | 只缩不放；VRP SPX 价差不设止盈、止损不低于 cushion-zero；价位 gate（固化 `/tmp/pr-check/check.py` 的检查） | 代码 | — |
| 8 deliver + ledger | 邮件 + markdown + 给 xenon 的建议 JSON 文件；每条建议入账 | 代码 | — |

硬规则：delivery 对 position-review 拒绝 argon 通道（测试守住）；不加任何下单/改单/撤单能力。运行方式沿用 #135：先手动运行，定时以后再定。

#### 4 Claude 模型档位

| capability | 默认模型 | 用在 |
|---|---|---|
| `reason.quick` | Claude Sonnet（档位内最新） | 分析师、辩手、reflector |
| `reason.deep` | Claude Opus（档位内最新） | 裁判、editor、周复盘 |

具体 model id 在 P0 按当时可用的 Claude 模型锁定，写在 `helium-base` 配置里，角色文件不写模型。凭据：沿用订阅 OAuth token（`sk-ant-oat…` 需要 `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`，见 `runtime.ts` 的 `authHeaders`）；P0 验证 0.2 的 pi-ai 配置能否带这两个 header，不能就改用 API key。


</details>

## 5. 删除清单

| 删除 | 原因 |
|---|---|
| `packages/core`、`packages/cli`、`packages/provider-sdk`、`packages/fake-flat-rate` | 由 DSH + helium-base 取代 |
| `plugins/provider-*`（dsh、claude/codex/devin-subscription） | Claude 由 DSH 路由；订阅 CLI 执行器不再需要 |
| `plugins/helium-self`、`flash-review`、`runtime-control`、`fake-tenant`、`2026-09-11-runtime-self-improvement` | 实验性，未在生产；仓库层自我改进以后按新结构重新设计（第 10 节） |
| `plugins/delivery-*` | 搬进 helium-base |
| `plugins/option-wizard`（旧 tenant 形式） | 第二阶段重写。第一阶段在 v3 分支上就删掉；工具、gate、`render/math.ts` 里值得留的代码在第二阶段从 git 历史取回。mini 上运行的是已发布的旧 sha，不受影响 |
| `contracts/`、旧 `team.yaml` DAG 机制、scoreboard、runtime-* 命令 | 仪式；只留工具范围测试和 grep 中立性测试 |
| `frank` phase 和 `ow_frank` | mini 上 Substack 读取已失败（memory `opencli-substack-fails-on-mini`）。你要保留就说 |
| 磁盘上未入 git 的 `livewire-shepherd`、`ops-agent`、`plugins/helium`、`packages/evals`、`v1-compat`、`fake-metered` 的 `lib/` 残留 | 已不在 git 里 |

不动：`plugins/earnings-readthrough`（暂停中，未跟踪，代码在它自己的 worktree）。

## 6. 测试

- 第一阶段只测框架：P2 列出的组合测试 + 各模块单元测试（pipeline 原语、as-of 截断、结算、记分卡、通道白名单、audit 折叠）。
- 真模型只在 P2 第 2 项和 P3 用，不进 CI。
- CI：build、typecheck、test。
- 旧的 renderer、gate、工具形状测试随旧 option-wizard 一起删除；第二阶段按新内容重写。

## 7. 风险

| 风险 | 处理 |
|---|---|
| DSH 仍是预发布 | 精确锁版本；bundle 声明 `engines.dsh`；只用 README 写明的接口 |
| mini 没有 Node 24.9 | P0 第 1 项；不行就整个方案暂停 |
| 订阅 token 的 header 在 0.2 pi-ai 配置里带不上 | P0 第 5 项；退路是 API key |
| 框架按想象中的内容设计，第二阶段用不上 | 第 3 节每一项都对应两个参考项目里实际存在的方法；smoke 覆盖每一项 |
| 第一阶段误伤 mini 上的生产运行 | P3 只装独立目录和独立 `$DSH_HOME`，不碰 `current` 和 launchd；验收里检查当天 argon 记录照常 |

## 8. 未验证（UNVERIFIED）

- 无人值守时 `--approval-policy` 遇到需批准调用的表现（preset 不给需批准的工具，应碰不到）。
- MCP client 行能否放进 preset 的 `plugins` 列表（本计划不需要）。
- mini 上 `helium.env` 的实际 key（没有 ssh 查）。
- 当前可用的 Claude model id 和订阅 token 在 0.2 下的调用方式（P0 第 5 项）。

## 9. 剩下的开放问题

1. `frank` phase：默认随旧 option-wizard 删除；第二阶段检视时决定要不要。
2. 辩论候选数等内容参数：移到第二阶段。
3. superagent（helium-rsi）放在哪：第一阶段之后、第二阶段之前（先有"Helium 改 Helium"的回路，第二阶段的内容迭代可以用它），还是第二阶段之后（先把内容做好）？

## 10. 不在本计划内

- 仓库层自我改进（superagent / helium-rsi）。见第 11 节。
- earnings-readthrough（暂停中）。
- 第二阶段的内容设计（第 4B 节）。

## 11. 与 superagent 计划（2026-11-03）的关系

superagent 计划的目标是 doctrine #1：我在 issue 里提需求 → Helium 在 worktree 里改自己的代码、跑测试、开 PR → 我在 PR 里评论，同一个 worker 接着改。它建在 v2 的 core/cli/provider-dsh 上。

| superagent 的部分 | 状态 | 在 v3 里怎么处理 |
|---|---|---|
| P0 DSH 0.2.1 移植（PR #133，未合并） | 被 v3 取代 | v3 用官方 profile/bundle 结构完成同一件事；#133 关闭 |
| P2 sandbox-worktree + P5 最小版 helium-rsi（PR #134，未合并） | 代码建在要删除的 core 上，作废；设计保留 | worktree 创建/保留规则、环境变量清洗、bot 凭据、结构化结果 `{state, summary, prUrl?, question?}` 搬进 v3 的 `helium-rsi` bundle；#134 关闭 |
| P1 可续跑 worker | 设计保留 | DSH 0.2 自带可续跑的子 agent 和 session 恢复，v3 直接用 |
| P3 Source（轮询 GitHub）、P4 delivery-github | 设计保留 | 变成 helium-rsi bundle 里的代码；GitHub 通道只对 helium-rsi 开放（通道白名单） |
| P6 首次真实运行的硬前提（专用 macOS 用户、不放 mini、bot 账号、master 保护） | 不变 | 原样沿用 |
| "刻意不搬"清单（Mandate、Policy、Outbox 等） | 不变 | 原样沿用 |

v3 第一阶段为它做的准备：P0 第 8 项（某个 preset 能在 worktree 里打开 bash/编辑工具，其他角色看不到）。如果这一项不成立，superagent 在 v3 上做不了，必须在第一阶段就知道。

顺序待定（见第 9 节问题 3）。
