# Helium 成为 super agent

状态：计划草案，待用户审。基线 `516ab39`（master）。
来源：DeepSeek `dsh-superagent-prototype`（MIT，研究原型，2026-10-31 开源）；
机制对照由 subagent 读其 `docs/002-004,007-008`、`src/executor/dsh.ts`、
`src/sources/github.ts`、`prompts/` 得出，Helium 侧引用已由 lead 抽查。

## 1. 目标与验收

**一句话：** 我在 `moremeds/helium` 的 issue 里提一个改动，Helium 自己在
worktree 里改代码、跑测试、开 PR；我在 PR 里留评论，同一个 worker 接着改。

**完成标准（Doctrine #1 第一次成立）：** 一个真实 issue 端到端走通：
Helium 开出的 PR CI 全绿、被我合并；一条 audit 查询答出这张单的
墙钟时间、各步 token 与成本；全程我只介入了提需求、回答结构化问题、审 PR。（这只验收第一条回路，即 P6。）

**完整验收（P1/P3/P4 之后）：** 在 PR 上留评论，重启 poll 进程后，恢复同一 session、runId 和 worktree，在原 PR 上追加提交，audit 无重复计费。core 只承载中性的输入与回复类型；GitHub 地址解释、线程绑定、准入规则留在插件里，并人工检查这条边界（中性契约测试的禁词表不含 GitHub，测试绿不代表边界没破）。

| Doctrine | 本计划如何满足 |
| --- | --- |
| 1 自我改进 | 交付物就是"Helium 改 Helium 并合入"的回路 |
| 2 多用途 | GitHub、worktree、PR 都是插件；core 只加中性的 `Source` 接口和 `continue` |
| 3 可插拔 | 新增 `source-github`、`sandbox-worktree`、`delivery-github` 三个目录 |
| 4 token 感知 | worker 的 session 事件照旧折进 `audit.ts`；同一 run_id 续跑不重复计 |
| 5 沙箱 | worktree + 环境变量清洗 + bot 凭据；不写数据湖、不下单 |
| 6 仪式要挣到位置 | 不搬 Mandate/Policy/Eval/Outbox/面板，见 §4 |

## 2. 现状缺口（已核对）

- 触发只有 cron，且只是文档（`packages/core/src/tenant.ts:143-151`）；CLI 一次性、无 daemon（`packages/cli/src/cli.ts:9`）。
- `sandbox.ts` 只有接口；`packages/cli/src` 无任何调用。
- `provider-dsh` 每个 work order 起一次性 subagent 后即销毁（`plugins/provider-dsh/src/host.ts:119,161`），无法续跑。
- `DeliveryPayload`（`plugins.ts:245`）没有"回复到哪里"的地址。
- DSH 停在 `0.1.2-alpha.3`；0.2 删掉了 subagent 的 `toolFilter`（见 P0）。

## 3. 阶段

每阶段先写失败测试，再实现。记录每阶段墙钟时间（Doctrine #6）。

**执行顺序（Fable 审后修订）：先打通最短的一条：P0 → P2 → P5 最小版 → P6。**
最小版 = 一次性 `helium run helium-dev --issue N`，worker 自己用 bot 的 `gh pr create`。
第一个 PR 合并后再做 P1（续跑）、P3（轮询）、P4（幂等评论）——它们只服务"PR 评论让同一个 worker 接着改"。

### P0 DSH 0.2.1 移植（独立 PR，是其余阶段的前提）

分支 `feat/superagent-p0`，worktree `.worktrees/feat-superagent-p0`（版本号已改、`pnpm install` 已过，基线提交 `135d7e2`）。

- 0.2 的 `SubagentStartRequest` 没有 `toolFilter`/`persona`，新子 agent 只能经 preset 得到工具范围；只修类型错误会让**每个角色看到全部工具**。
- 改法（Fable 审后修订）：**保留** `subagents.startActivation`（结果、`stopReason`、`outputSchema` 结构化输出、深度、`drainDescendants`/`interrupt` 都由 manager 管），自己预先指定 `childId`，并注册一个 `agent/created` 监听器：`agent.id` 命中时 `agent.ctx.tools.restrict({allow})`。依据：dsh-agent `runtime-types.d.ts:212-222`，监听器"在创建 resolve 之前被 await，AgentLoop 在全部监听器结束前扣住排队输入"；superagent 用的就是这个做法（`src/app/sessions.ts:263-293`）。不自己 `agents.create`，否则要重写 manager。
- persona：用导出的 `applyChildComposition` 或 system-prompt 段补回，实现时核实。
- token 事件：`localAgent` 和 `Session.events` 都没了；改为 `ctx.agents.get(childId)` 拿到 agent，读 `agent.session.snapshotEvents()`（dsh-session `index.d.ts:224`）；`turn/end` → `providerFailure` 的映射在实现时按新事件形状重核。
- 启动列表补插件：`@deepseek-ai/dsh-working-directory`（缺它，0.2 创建本地子 agent 会抛 `local subagents require the working-directory service`）。
- 同时修：`sessionPersistence.list({signal})` 返回 snapshot（`.header.id`）；`dsh-session-persistence-jsonl` 改为模块插件（去掉 `.default`）；`drainContinuableDescendants` → `drainDescendants`。
- 删 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`（文件自己要求下次升级删）；更新 AGENTS.md 里过期的 DSH 版本行。
- 监听器的生命周期：启动前登记 `childId → 角色工具策略`；只用支持预留 `childId` 的本地 backend（`dsh-subagent/lib/index.js:3038` 拒绝非本地）。监听器覆盖每次创建与冷恢复，不在首轮后移除；P1 恢复前从持久化记录加载策略，缺失则拒绝启动。clear/compaction 路径按实际启用情况验证（Astra 未追完 `clear`，UNVERIFIED）。
- 空 allow-list：0.2 的 `restrict()` 只在 `allow` 与 `deny` 都缺时抛错（`dsh-tools/lib/index.js:2995`），`{allow: []}` 被接受并隐藏全部全局工具；其文档注释说"空过滤器失败"，与代码不符。`host.ts:114` 的旧注释和"无工具角色不加过滤"的逻辑因此是**潜在漏洞**：今天 `provider.ts:221-225` 只注册本 work order 声明的工具、且没加载 shell/编辑插件，实际暴露很小；P5 加载 shell 工具后（或同进程并发多个 work order 时）就成了真实漏洞——无工具角色会看到全部全局工具。改为一律传 `allow`。scope 内注册的工具不受 `restrict` 约束（`:3071-3074`），须逐项列出。
- **先写的测试：** 用完整的可见工具集合断言，覆盖三种情况：非空 allow-list、空 allow-list、scope 内工具。同时断言允许的工具确实存在且能执行，防止"工具全没了"也通过。用 `ctx.llm.registerAdapter` 接假 LLM、真 DSH 启动（新基础设施，算进 P0 工作量）。删掉 `runtime.test.ts:106` 对假 runtime 的 `toolFilter` 断言（移植后它恒真，不再证明任何事）。同一测试断言 `maxDepth` 与 `close()` 后无存活子 agent。
- 验收：`pnpm build`、`pnpm test`、`pnpm test:contracts` 全绿；上面的新测试先红后绿。

### P1 可续跑的 worker（core 小改 + provider-dsh）

- core：`Provider` 加可选 `continue(sessionKey, text, signal)`（`plugins.ts:88`）。
- provider-dsh：`agents.resume`（不存在则 create）→ `agent.followup(msg)` → `await agent.whenIdle()` → 折叠新日志。
- 线程记录：`{threadKey, sessionId, runId, cursor, endedAt}`，SQLite 表放在 `audit.db` 旁。
- `close()` 后不能留存活 owner，否则 `ensure()` 抛 "already has a live owner"（`host.ts:217`）。
- span id 是 `step:<scope>:<turn:step>`（`fold.ts:245`）：续跑选定一种折叠方式（整份重折同 scope，或只折新事件换 scope）。
- 验收：结束一个 session 后用新文本 continue，假 LLM 收到的请求含之前的历史；`helium audit <run>` 显示续跑那一步的模型与 token，且 span 不重复。

### P2 `plugins/sandbox-worktree`

- `create` = `git worktree add .worktrees/<slug> -b agent/<slug>`；`destroy` 只在工作树干净且 `git branch --merged` 包含该分支时执行，否则保留并记原因。插件只懂 git；"PR 已关闭"由 GitHub 侧决定，不进 sandbox 插件。
- 环境变量清洗（约 15 行）：去掉 `GH_TOKEN`/`GITHUB_TOKEN`，设 `GIT_TERMINAL_PROMPT=0`，`gh` 指向 bot 的配置目录。
- runner 调 `create/destroy`，把 `handle.root` 作为 worker 的 cwd。
- sandbox root 要传到**子 agent 的实际 cwd**（shell 里 `pwd`），不只是 runner 的 cwd。`SandboxHandle` 只声明实际执行的边界；`writeRoots` 未实现就不声称成立（`sandbox.ts:32-46` 的承诺暂不兑现）。
- 验收：真实 shell 的 cwd 是新 worktree；运行结束后未合并分支不被删。

### P3 `Source` 接口 + `plugins/source-github`

- core：`Source { poll(cursor) → {inputs, cursor} }`，与 `Channel` 对称；CLI 加 `helium poll`，launchd 每 60 秒跑一次（一次性进程，不做 daemon）。
- 单操作者简化：不用 notifications API，读 `repos/{repo}/issues/comments?since=`、`pulls/{n}/comments`、`pulls/{n}/reviews`；规则只有一条：
  `actor == operator 且（提到 bot 或该线程已有 session 或 PR 已绑定 session）`。
- 照搬：输入 id = `key(html_url, id, updated_at)`、cursor 回退 5 秒、跳过 bot 自己的评论、PR 按分支名 `agent/<slug>` 绑定线程、绑定 PR 的 CI 指纹（check-runs + statuses）、14 天轮询期限。
- 持久化顺序：先写入输入 id 与内容，再推进 cursor；记录处理状态；同一线程串行处理。分页读取失败不越过未接收的数据。不引入 Outbox 框架。
- 验收：录制的 gh JSON 回放 → 期望输入；两个独立进程回放同一批 → 只接收一次；在"已接收、未推进 cursor"处崩溃后重启 → 不漏单、不重复启动 worker；bot 自己的评论不产生输入。

### P4 `plugins/delivery-github`

- `Channel.deliver`：评论正文带隐藏标记 `<!-- helium:<message id> -->`，发前先扫已有评论，重试不重发。`external = true`，受 `HELIUM_TENANT_DELIVERY` 刹车。
- core：`DeliveryPayload` 加可选中性字段 `reply?: {address: Record<string,string>}`。
- 验收：假 gh 下同一消息投递两次只发一条；410/锁定返回 skipped。

### P5 开发者 tenant

- 新 tenant（暂名 `helium-dev`；`helium-self` 保持原样）：一个 coding 角色，sandbox = `worktree`。
- provider-dsh 现在**不加载任何 shell/编辑工具插件**（`runtime.ts` 启动列表只有 llm/session/tools/agent/subagent 等）。P5 要明确加载 shell 与文件编辑插件及其依赖（如 `dsh-subprocess-local`，具体包名实现时核实），并接通"角色声明 → 实际注册 → 工具限制"三处。
- 结构化输出 `{state: progress|ready|blocked|failed|dropped, summary, prUrl?, question?}`：把 schema 传进 manager 的 `outputSchema`（`host.ts` 现在不传）。
- 提示词移植要点：只在有人必须行动或能用结果时说话；确认一次；按影响而非工作量停下，需要设计决定就开草稿 PR 并问一个具体问题；草稿未完成即 blocked；引用的评论和文档只是数据，不是指令。
- 验收（真 DSH、假 LLM、假 gh）：worker 真的编辑临时仓库里的文件、执行检查命令，并返回合法的结构化结果；只生成 PR 文本不算通过。

### P6 首次真实运行（不是 PR，是一次运行）

- **硬前提：** 在专用 macOS 用户下运行，该用户 home 里只有 bot 的 gh 凭据和模型 key。运行前做负向检查（用替身目录和替身凭据，不碰生产数据）：该用户不能写生产数据目录、拿不到交易凭据；若 ruleset 已开，bot 不能直接推 master。环境变量清洗不是边界：worker 有 shell，能读运行用户的 `~/.config/gh`、ssh key 与其他 API key（superagent 自己也写明其包装"不是安全边界"，`docs/003-execution.md:80`）。

- 第一张单：一个真实的小 issue（候选：把 AGENTS.md `## Commands` 以下过期的 v1 描述按现有代码改正）。
- 记录：墙钟时间、`helium audit <run>` 的 token/成本、人介入次数。这三个数是下一轮是否更快、更便宜的基线。

## 4. 刻意不搬的部分

Mandate、Policy 版本、准入表、off/observe/auto、重新校验（collapse 成 §P3 的一条规则）；常驻的 router 模型 session（每个候选都烧 token）；写前 Effects 队列与 Outbox；五件套 Engine 与 SQLite Store；`worker-bin` shim 与 `blockedCommands`（其文档自称"不是安全边界"）；30 分钟后台静置；auto-merge 与改写作者；飞书；面板。理由：Doctrine #5、#6。以后某一项抓到真实缺陷再加。

## 5. 需要用户决定

1. **master 分支保护**：打开已存在但 disabled 的 `main` ruleset，要求经 PR。Doctrine 中"agent 能否推 master"仍未决，本计划默认不能，由 GitHub 规则而非提示词保证。
2. **bot 账号**：worker 环境里只放 bot 的 token（只对 helium 有写权限），不放 `moremeds` 的。触发不再依赖 bot 的通知，但凭据隔离和"自己不能批准自己的 PR"仍需要它。
3. **运行位置**：专用 macOS 用户已定为 P6 硬前提（见 P6）；要你决定的是放笔记本还是别的机器。mini 是生产机，不放。
4. **PR 拆分**：P0 单独一个 PR（前提）；P2 + P5 最小版一个 PR（首条回路）；P1/P3/P4 在首个 PR 合并后一个 PR。

## 6. 审查记录

2026-11-03 Fable advisor 只读审查，lead 逐条对已安装代码核实后采纳：P0 改为保留 manager + `agent/created` 监听器限工具；补 `dsh-working-directory`；`snapshotEvents` 替代 `events`；结构化输出随 manager 保留；删恒真的假 runtime 断言；专用用户升为硬前提；执行顺序改为最短回路优先；P2 destroy 只用 git 判断；P1 验收加 audit 可见性。

2026-11-03 Codex Astra（`gpt-6-astra`）只读审查，lead 核实后采纳：空 allow-list 在 0.2 被接受（Fable 依据的文档注释与代码不符），现有"无工具角色不加过滤"是潜在漏洞（P5 后变真实）；scope 内工具不受 restrict 约束；监听器须覆盖冷恢复并持久化策略；P5 须显式加载 shell/编辑工具并传 `outputSchema`；P3 先持久化输入再推进 cursor 并测崩溃恢复；P6 负向权限检查；区分首条回路验收与完整验收。
