# Helium Runtime Self-Improvement — reviewed implementation plan

Version **1.2**, 2026-09-12. Repository: `moremeds/helium`. Reviewed source baseline: `e2175344525e355edc5662124712a7250a3d9b88`.

**文档是待实施规范，不是生产实现或收益证明。** v1.1 自审与反方审查由同一助手完成，历史审查保存在 `REVIEW.md`。v1.2 基于本地原包与源码修订交付顺序；修订记录见 `REVISION-v1.2.md`。未连接 mini、执行 Helium tests、运行 PostgreSQL 集成测试或取得线上报告。以下“本轮确认”及 G/D 引用保留 v1.1 的历史来源语境，不表示 v1.2 重新验证了远端或外部文献。

本版替代 v1.1 的实施顺序。原 105 项检查的 ID 和要求完整保留，状态均为 `NOT_RUN`；新增 deliveryWave/applicability 字段只规定何时验收，不导入 PASS。第 0 节、阶段表及 checks.json 的分期优先于旧 requiredFor 标签；后置要求在对应能力启用前仍须满足。正文中的路径、接口、表和状态是设计要求，不表示已有。

## 0. v1.2 执行边界与三个交付阶段

本次仅修订计划，不授权实施、调用付费模型、生产迁移或激活。实施开始前继承当前会话授权，并读取仓库 AGENTS.md。第一轮实现首个受控参数闭环；完整自动改码和递归改进仍属后续能力，不以配置调优代替。

| 交付阶段 | 必须交付 | 明确后置 | 验收结论 |
|---|---|---|---|
| M1 本地机制闭环 | 单 worker、无后台认领/自动重试；临时 PostgreSQL 中不可变版本、run snapshot、attempt/evidence 记录、test deployment 指针；premarket 注入；test 人工初始化/切换/回滚 | 多 worker fencing、事件消费者/投影、自动 promoter、生产投递改造、通用授权平台 | 数据库参数影响实际上下文；默认和其他 phase 兼容；下一 run 切换、当前 run 固定；失败保留且可回滚。没有质量收益结论。 |
| M2 真实效果比较 | A/A 校准、固定 A/B、冻结质量/资源/采样规则、独立确认数据、全部 attempts 成本；人工审查输出 | 自动生产激活、无限候选搜索 | REJECT / NO_CHANGE / INCONCLUSIVE / REVIEW_READY；真实改善与机制完成分开报告。即使通过也不自动切生产。 |
| M3 受限自动运行 | M2 与 shadow 证据、评价器资格、明确生产授权、监控和安全回滚；确需的调度与并发机制 | P8/P9/C 扩展仍不在本轮默认范围 | 仅已注册空间内自动操作；无新证据、预算或候选即停止。 |

M1 不需要先建全部逻辑表或主体账号。复用现有 runner、工具录制、沙箱和成本记录。仅管理员受控入口能改 test 指针，候选生成进程不得获得该凭据；SQL 输入校验、scope、版本完整性及 CAS 不省略。已有工具满足需求时不新增包或依赖；确需新驱动/服务按仓库规则批准。

单 worker 不代表可以忽略崩溃：禁止重叠启动，在前一进程及已派发请求状态未核实前禁止恢复执行；持久化 dispatch 与 UNKNOWN，费用未知不计零。若需要自动接管或无法保证不重叠，先实现并验证 §6.2 fencing，再启用该路径。未启用事件消费者时直接查询权威表；一旦启用必须满足 §4.2，不使用有漏洞的高水位替代方案。旧 ledger 保持原路径，不预建 outbox 同步。

分期不是删掉安全要求：M1/M2 仍绑定证据版本，激活前人工检查当前有效性；发现更正立即使相关结论不可采用。§4.3 自动失效传播及认证竞争在自动 promoter 启用前实现。§9.3 外部投递协议在新增 registry 驱动的生产投递路径前验收；M1/M2 完全禁用投递。不得为沙箱内探索重建旧 claims/leases/authority 框架，业务参数和评分留在 tenant。

## 1. 目标、范围和第一项交付

一次工程实现后，已注册策略可以：

```text
真实证据 → finding → 假设 → 不可变数据库候选
  → 同输入比较 → 独立 verifier → 有限授权 promoter
  → 下一 run 生效 → 监控 / 拒绝 / 回滚
```

常规策略迭代不需要 Git commit 或服务重启。新工具、执行算子、安全修复、权限或未支持的解释能力仍需工程变更。配置不得执行 SQL、shell、代码或任意模板表达式；不修改基础模型权重。

两种完成标准必须分开：

- **机制完成：**同一新引擎构建 C1 安全运行 A/B；快照、拒绝、权限、切换及回滚有证据。
- **改善成立：**在冻结输入、评价和预算下，对预注册主要目标有证据且关键约束不退步；没有赢家可返回 NO_CHANGE，不为验收强制发布。

先完成 P0–P3 的小型纵向切片：默认配置 → 数据库版本 → run snapshot → 有效 news cap → evidence → 测试授权下切换/回滚。只需临时控制库、确定性 fixtures 和受控 test 入口，不必先实现全部研究、UI、自动改码或 meta-loop。这个测试切片不授权生产，也不证明报告变好。M2 用 P4–P5 完成真实评价并交人工审查；M3 才推进 P6–P7 的 shadow、授权和自动循环。

## 2. 已有基础与必须重查的边界

| 入口 | 已知事实 / 本次处理 |
|---|---|
| `packages/cli/src/runner.ts` | 复用现有 runner、phase/asOf/variant、注入接口；不新建并行 agent runtime。实施时核对具体签名。 |
| `packages/cli/src/discovery.ts` | 本轮确认 `TenantToolConfig.extensions` 传给租户 `buildTools`。[G2] 用此入口传已验证的 run 参数。 |
| `plugins/option-wizard/quality/news-overview.ts` | 本轮确认 builder 接收 `caps`，先读取实际 feed 再排序/cap；串行读取。[G3] 默认 daily 4/2/5、weekly 8/3/12，fetch limit 25。 |
| `team.ts` / `team.yaml` | 既有严格 manifest、DAG、capability 与权限边界须保留；不开放整份 YAML 修改。 |
| `evidence.ts` / `tool-io.ts` | 复用已有审计和工具录制。前序读取发现旧索引取同 key 最后成功返回；P0 重查，不能把旧 PIT 当严格实验回放。 |
| `helium-self/{render,tools}/index.ts` | 保留旧实验 mint/check、已 mint payload、原规则与 receipt；新控制库不重判历史。 |
| `.github/workflows/ci.yml` | 本轮读取到 push 仅匹配 master，另有 pull_request。[G4] 新文档分支上的提交不能因此宣称 CI 已运行。 |

[G1] 确认 master 仍在上述 SHA，但这不证明 mini 部署身份。线上报告未取得时记 BLOCKED；旧 view 只作为带原日期的历史回归，不能代替最新产出。先前宏观状态、referenceClose、窗口外归因等风险必须在当前基线复现后才叫产品缺陷。

## 3. 架构、权限与配置空间

定义产品策略 θ、研究策略 η、执行引擎 C、实际模型 M，以及独立验证规则 ρ：

```text
报告 = F(输入; C, θ, M)
候选 = O(开发证据, 历史实验; η, 预算)
receipt = V(champion, candidate, 冻结世界; ρ)
激活 = A(receipt, 当前 deployment, 授权, 兼容性)
```

首期 θ 仅开放 `premarket.news.perStock ∈ {1,2,3}`，默认 2；global=4、stocks=5、股票集合、新闻排序/去重、venue fallback、fetch limit、prompt、模型与 renderer 不变。其他 phase 保持静态路径。3 是候选，不是预设最优；第三条不存在也不补造。

P8 才开放：安全 prompt slots、不可变 few-shot IDs、已实现的 context 策略、批准的 workflow/route profile、有限当次修订。每个新字段必须接入真实执行、带 schema/权限/成本/验证。不允许通过 route/profile 绕过 capability 或必需步骤。

**不可优化项：**事实原值、as-of/单位/交易日语义、评价器与隐藏标签、晋级阈值、预算上限、工具权限、凭据、收件人、交易能力、数据库 ACL、审计及串行 opencli 约束。

| 主体 | 允许 | 禁止 |
|---|---|---|
| production runner | 读批准配置，冻结执行；通过受限 recorder 记自身 attempt | 写分数、grant 或 active；使用 owner 凭据 |
| proposer | typed propose/register/requestEvaluation/readDiagnostics | 任意 SQL/Git/shell；读 sealed 答案；写裁判或 active |
| eval runner | 独立 state root、冻结世界、批准的 inference 通道 | 生产 ledger/latest/邮件/行情写入/下单 |
| verifier | 检查证据、追加 measurement 与受信 receipt | 改候选输出或冻结阈值 |
| promoter | 在指定动作与授权下激活/回滚 | 伪造结果、扩大范围 |
| administrator | 注册参数域、资格、授权、撤销 | 权限不自动授予 proposer |

可复用代码包，不可让候选 prompt 控制的进程同时持有 verifier/promoter 凭据。仅隐藏工具菜单不算隔离；provider ambient shell、环境密钥、网络和本地文件入口都需验证。自动配置路径不需要 Git 写权限；无法隔离时暂停自动路径，仍可做受控离线测试。

## 4. 控制库与版本身份

建议同一 PostgreSQL 实例上的独立 `helium_control` database / `rasi` schema、独立最小权限账号。不得复用市场数据写权限。不增加 Kafka 或每 agent 一个库。驱动用参数化 SQL并锁定依赖；本地迁移先测，生产 DDL 另行授权。

配置版本存完整已解析 payload，不只存 patch。proposal 可为 patch；未知字段、重复 JSON 键、非有限数、可执行表达式、prototype 键都拒绝。JSON Schema 不能发现已被解析器覆盖的重复键，原始输入解析必须单独检查。

统一 canonical JSON：对象键排序、数组顺序保留、UTF-8、禁止 undefined/NaN/Infinity，保存规范化字节及算法版本；跨实现的数字/Unicode/转义测试必须一致。hash 由受信服务计算，不能信 caller hash 或 JSONB 文本输出。

```text
配置身份 = tenant + phase + kind + schema + resolvedPayload + dependencyHashes
运行身份 = engineSha + engineArtifactHash + lockfileHash
         + baseTenantHash + baseTeamHash + configHash
         + effectiveSnapshotHash + inputWorldHash + actualModelIdentity
```

所有 prompt/example/template/profile 引用固定内容 hash，禁止嵌套 latest。新引擎或基础 manifest 改变后重新验证；dirty development 结果不可静默晋级。e217534 是改造前基线，C1 默认兼容通过后，A/B 均在同一 C1 比较。

### 4.1 逻辑表与分期

M1 仅实现 runtime_versions、deployments、run_attempts 及持久化 snapshot/evidence/test 操作记录的必要子集，可复用现有存储。下表是后续逻辑职责，不要求一职责一表；独立事件消费者、grants、receipts、delivery_intents 按 M2/M3 需要添加。

| 表 | 核心约束 |
|---|---|
| `runtime_versions` | UUID、scope、parent、schema、canonical payload、hash、依赖、engine compatibility；insert-only，同 scope/hash 去重，父版本同 scope。 |
| `deployments` | scope 主键、active、revision 单调递增、配置批准及运行有效性；只可经受控事务修改。 |
| `experiments` | champion/candidate/hash、目标 deployment/revision、执行环境、假设、输入、ρ、采样/预算；开跑前冻结。 |
| `run_attempts` | identity/arm/case/replicate/input 不变；lease_owner、lease_epoch、lease_until、dispatch IDs、终态；恢复不覆盖原失败。 |
| `measurements` / `verification_receipts` | verifier 追加，supersedes 更正；原记录不变，但可失去使用资格；绑定证据和 certification epoch。 |
| `approval_events` / `automation_grants` | 管理员与受信服务维护；动作、scope、候选、有效期、预算、policy、撤销状态；不是 JSON 自填 actor。 |
| `control_events` / `consumer_acks` | event 内容 append-only；ack 主键 `(consumer,event_id)`；投影与 ack 同事务。 |
| `budget_reservations` / `dispatches` | 容量预留、dispatch identity、未知消耗、结算均可审计，不将 timeout 当零成本。 |
| `holdout_accesses` / `decision_families` | 按实际 case/cluster 血缘记暴露、candidate 和误差预算；换 campaign ID 不能重置。 |
| `delivery_intents` | run/artifact/destination revision、短效 dispatch permit、外部 request ID、确认/未知/withheld 状态。 |

所有 FK/服务请求检查 tenant/phase/kind；receipt 还绑定目标 environment，防止 evaluation receipt 激活另一个 deployment。M1/P2 必须验证实际使用的管理员入口与受限 runner DB 权限，mock 不能证明 ACL；完整 proposer/verifier/promoter 角色矩阵在相应主体上线前完成。SECURITY DEFINER 如使用，固定可信 search_path、限定表名、撤销 PUBLIC EXECUTE；权限创建同事务。[D3]

### 4.2 不以 event ID 充当提交顺序

**禁止**仅保存 `last_event_id` 然后读取 `WHERE id > cursor`。sequence 的取号不等于事务提交顺序。[D1] 低 ID 事务晚提交可能被永久跳过。

首期用每事件 ack：反连接未 ack 的已提交事件，幂等投影与 ack 同事务；不把高水位当完备性证明。控制事件的主身份可用 UUID，另有用于诊断的序号。聚合顺序依赖 scope revision；旧 revision 不能回滚新投影。跨文件旧 ledger 仍是幂等消费者，失败不改变新控制库的权威。

### 4.3 receipt 不可变，不等于永久有效

receipt 绑定精确 measurement/adjudication IDs、证据 manifest、evaluator qualification、policy 与 `certification_epoch`。任何相关更正、证据撤销或评价资格撤销，在受信事务中追加事件并推进对应 scope epoch。激活事务锁定相同认证状态并复核；旧 epoch 或失效依赖的 receipt 必须重评，不能因旧 JSON 的 PASS 继续激活。

已激活配置的依赖失效进入 incident：按登记规则暂停/隔离/回滚。不能自动把所有指标更正都解释成产品有害，也不能静默保留已知 critical 问题。历史 PASS 原样保留，当前 eligibility 单独显示。hash 不是防全权管理员篡改的保证。

## 5. Runtime snapshot 与接口

```ts
// Proposed contracts, not existing APIs.
interface RuntimeSnapshot {
  configVersionId: string; configHash: string;
  deploymentRevision: number; configurationApprovalId: string;
  scope: {tenant: string; phase: string; environment: string; kind: string};
  engineSha: string; engineArtifactHash: string;
  baseTenantHash: string; baseTeamHash: string;
  resolvedPayload: unknown; effectiveSnapshotHash: string;
  resolvedAt: string;
}
interface ExperimentBinding {
  targetDeployment: {tenant: string; phase: string; environment: string;
    kind: string; championVersionId: string; expectedRevision: number};
  executionContext: {environment: "evaluation" | "shadow";
    stateNamespace: string; deliveryMode: "disabled"};
}
```

evaluation 是执行环境，不是可激活的 production target。target 从受信 deployment 查得并冻结；不能在晋级时把字符串 evaluation 改成 production 来补授权。execution scope 与 target scope 均进 receipt。

工具构造前：读 scope deployment → 校验版本/批准/兼容 → 固定间接依赖 → 持久化完整 snapshot → 通过 extensions 注入 tools/context/team/render。core 不解释 news，不能修改 module-global NEWS_CAPS。每个 run 只读一次 active alias；中途激活只影响下一个 run。当前 run 可按冻结策略自适应，不可中途换全局策略。

模式：OFF 明确保持旧静态路径；MANUAL 读批准版本、人工激活；AUTO_SCOPED 可按有效范围授权自动激活。另有 researchEnabled 和 kill switch。OFF 只能由管理员显式选择，不能作为 DB 故障的自动逃生路径。

启用 registry 的 scope 若缺 deployment、控制库不可达或完整性失败：新 run 拒绝，诊断可继续，不静默回落任意文件。运行中可继续本地计算与保存证据，但无法确认外部 dispatch 许可时 withheld。首期不做离线自动 fallback；以后若做 LKG lease，必须明确离线撤销不可即时生效的窗口。

**区分授权寿命：**automation grant 的到期/撤销默认阻止后续自动激活；已激活配置由独立 configuration approval 管理，不能因一次 grant 到期就意外停掉所有生产。要撤销 active config 或取消 run，使用显式 configuration revocation/kill，并留事件；配置批准的有效期也必须登记。

## 6. 证据、回放、worker 和外部副作用

### 6.1 三种验证世界

| 模式 | 用途 |
|---|---|
| DETERMINISTIC_STUB | 固定工具/provider stub，验证配置注入和 renderer；不证明模型质量。 |
| FROZEN_FRAME | 固定 frame，比较 prompt/editor；不证明上游筛选。 |
| SNAPSHOT_PIPELINE | 从完整冻结底层 feed 重建 frame/news；改变 cap 必须使用这一模式。 |

录制原始 args/result/error、task/role/occurrence、实际 observation time、asOf、源 vintage、calendar、watchlist、ledger 前态、assembled prompt、真正进入模型的上下文、tool/route/build identity、最终 view 和所有资源。旧 outer frame 缓存不能遮蔽参数变化。

严格 transcript 按 occurrence 回放 A→B 及失败重试；snapshot-world 只回答冻结世界可支持的查询。**回放路径一致是证据约束，不是文章质量标准。** 模型选择不同合法调用时，能由 frozen world 回答就允许；不能回答记 NOT_COMPARABLE，不把不同调用路径本身判为质量失败。[D4]

比较前展示处理差异：真实 third row、news/frame/assembled context hashes、token 差异及截断信息。cap 改了但上下文完全没变，应报告 treatment 无效；自然不存在第三条的 case 是合法无差异样本。不能看结果后只挑有第三条的日期；slice 事先登记。后续 analyst 自主查询可能改变最终曝光，完整记录，这属于策略总体效果，不能声称全文仅多看了一条。

隔离 eval state/ledger/output namespace、provider session/记忆与缓存键；不得写 production latest、发正式邮件、修改行情或下单。真实 LLM 可用受控 inference 通道，不能称完全无网。原始证据私有，Git 只存无秘密规范/fixtures/脱敏 receipt。引用证据 retention pin；旧记录缺失明确不可比。

### 6.2 lease 必须带 fencing

job 认领在短事务中增加 `lease_epoch`。heartbeat、artifact 登记、预算核销、terminal write 均检查 job/attempt/owner/epoch/期限；旧 worker 恢复后写入必须拒绝。reconciler 记 INCOMPLETE/UNKNOWN，原 attempt 不改成成功；重新执行用新 attempt，评估统计单位仍是预注册 trial，不增加一份独立样本。

提交到内容寻址的临时 artifact 不代表被采纳；只有当前 epoch 的受信 finalize 能绑定它。dispatched 请求由可信 gateway 管理；候选进程不能拿凭据绕过 fencing。**数据库 fencing 不会撤销已在外部执行的请求。** timeout/未知 dispatch 保留预算预留，不能立即释放并自动再付费调用。[D2]

取消确认或可信 reconciliation 之后才能核销/释放未知预留；不支持外部幂等时，自动 retry 不能承诺 exactly-once。资源先原子预留再调用，同请求键不同参数报冲突。provider 不提供可执行硬预算上界时，只能用真实可控的 tokens/calls/time 上限；不能声称严格美元封顶。

## 7. 量化指标和独立评价

不做万能总分。先身份/权限/完整性，再主要目标，再非劣约束。收益预测独立结算，不把写作质量当 alpha。

| metric | 定义 / 未知语义 |
|---|---|
| coverage.discovery | 生成前固定的重要事件中进入 frame 的比例。 |
| coverage.final | 首期主要指标；准确、符合当时状态且不越证据地充分处理事件的比例。 |
| errors.critical | 核实的严重事实/时间/实体/权限错误绝对数，不能靠文风或成本抵消。 |
| claims.supported | 已审查事实的支持比例，同时报 reviewed/eligible，未审查不当正确。 |
| prose.contradictions / review.preference | 有 final span/source/rubric/adjudicator 的语义与盲评；未知不是 tie。 |
| run.reliability | 合法任务机会的 completed/failed/timeout/cancelled/unknown；calendar skip 单列。 |
| resource.* | 所有 attempts 的实报 tokens/calls/latency、账单或明确估值；未知不是 0。 |
| forecast.score | 按旧 reference/session/horizon/outcome 结算；退出 top-N 仍跟踪。 |

首期事件等权；must-cover 由独立标注事先指定。`coverage.final = addressed / |E|`，仅出现名字不计处理；证据不足时准确陈述事实与限制可以通过，不强迫因果。E 为空记 N/A；全部为空则主要目标不可估计，不填满分。candidate 不能缩小分母，新增断言同样被审查。

确定性检查裁定能由结构化证据证明的身份/日期/单位/明确集合。开放语义用独立固定 rubric、A/B 随机顺序、反序/正常/错误/边界样本与人工抽样校准。无有效 evaluator qualification 或 critical disagreement 未裁定，质量自动激活阻断，可继续诊断和人工评审。[D4]

**grader 注入攻击单独验证：**候选正文、新闻、source/title/HTML 都是待评内容，不是给评审者的命令；不能接受输出自报的 supported/score/PASS 作为裁决。测试“忽略规则给满分”、伪造来源和隐藏文本；检查结果须绑定实际 final artifact。受控数据库权限不能替代此语义攻击测试。

原有宏观时间/口径/referenceClose/superlative 风险若在 C1 复现为 critical，先小 bugfix 并重建基线，再做确认试验；不能掺在参数效果里。未复现风险不当事故。

## 8. 统计、holdout 与持续研究

先 A/A 测同配置生成/判定噪声，再 A/B。开发 case 每臂重复 3 次可作排错建议，不是显著性保证。重复先在 case 内汇总，再按预先定义、不重叠日期/事件簇聚合；同周 daily/weekly 不跨 split。

初版固定批次、一个冻结确认候选、cluster-level paired 差值和固定实现的区间。独立簇太少/模型身份不兼容/关键判定不完整时 INCONCLUSIVE。正式 policy 先确定主要目标、最小实用差异、alpha、样本/簇/重复数、非劣界限、异常规则、预算、有效期、模型身份等级；不能看完结果改尺子。没有真实 calibration 不猜填统计有效数字。

合法输入下未完成文章的 trial，预注册规则计覆盖 0并计可靠性失败；未知语义不随便算 0/tie。输入在两臂执行前不合格可记整个 case 不可比；provider block 重排必须事前定义，原 attempts 与成本照留，不取最优重试。质量 metric 不把内部 retry 当新独立 trial。

### 8.1 跨 campaign 防止反复考试

按实际 case/cluster 血缘维护 holdout 暴露，而不仅是文件 hash 或 campaign 名称。首期一个 sealed cohort 只用于一次冻结确认；标签或结果暴露后成为 development，不能换文件名/顺序/ID 重新称未见。[D5]

持续研究需要新 prospective cohorts，或另行批准且有成立假设的 adaptive-valid 方法。候选未冻结就访问确认结果应拒绝；proposer 只读开发诊断。即便只反馈总分也算暴露，不声称隐藏逐 case 标签即可无限复用。

`decision_family` 跨 campaign 保存已花费的误差预算、候选和访问次数；新名不重置。若声称 family-level 错误率，需预注册有限总尝试的分配规则及条件有效检验；单次 alpha 不构成无限循环保证。没有可用 cohort/预算就 AWAITING_NEW_EVIDENCE，不反复试到赢。

### 8.2 晋级分类

INVALID/NOT_COMPARABLE：身份、完整性或输入不合格。
REJECT：critical violation 或固定质量/资源约束失败。
INCONCLUSIVE：样本、裁定或可比性不足。
NO_CHANGE：未达到主要目标条件；保留 champion。
SHADOW_ONLY：比较通过，但仍缺 shadow/成品证据。
REVIEW_READY：证据通过，等待该动作的人工批准。
ELIGIBLE_FOR_ACTIVATION：证据与资格当前有效且满足动作授权；不是已经激活。

receipt 不可跨 engine/manifests/input/evaluator/policy/target scope 偷换。ROUTE_ONLY 记录实际 route，不冒充 PINNED revision；grant 对等级明确授权。模型/市场/源口径漂移后重新确认适用性。

## 9. 激活、撤销、交付和回滚

### 9.1 四种动作，不能混用

| action | 授权与证据 |
|---|---|
| INITIALIZE | 管理员针对空 scope 的精确 baseline/build/default-compatibility 批准；不要求虚构 improvement receipt。test 初始化不能复用到 production。 |
| MANUAL_ACTIVATE | 对 candidate/receipt/expected champion+revision 的一次性管理员批准；不需要假 AUTO grant；不能绕过完整性/critical 安全底线。 |
| AUTO_ACTIVATE | 当前有效 AUTO_SCOPED grant、资格、全部比较/shadow checks、预算、receipt 与认证 epoch；proposer 无入口。 |
| ROLLBACK | 独立回滚授权/incident policy，明确兼容未撤销的批准目标；不要求目标再次“击败”出问题的新版本。 |

MANUAL_APPROVAL 不等于统计显著；授权记录不能伪造 measured improvement。如需有理由的人工风险接受，单列审查记录和准确标签，不能把未满足的 checks 改 PASS。

### 9.2 原子激活协议

```text
BEGIN
  按统一锁顺序读取 scope / 当前配置批准 / 认证 epoch / 相关授权
  验证 action 对应权限、expiry/revocation、target scope 与预期 revision
  读取受信 receipt 及未失效依赖（INITIALIZE/ROLLBACK 用对应专用证据）
  验证 engine 兼容、预算、required checks 与 shadow
  验证明确安全回滚目标
  CAS 更新 active 与 revision；0 行更新为 CONFLICT
  同事务追加批准与控制事件、幂等结果
COMMIT
```

所有 revoke/invalidate/activate 使用同一串行化约定。重复键相同意图返回原结果，不再次切换；同键不同意图拒绝。两个旧 champion 候选最多一个激活，另一个对当前 champion 重评。不得只校验一份调用者上传的 PASS JSON。[D1,D3]

### 9.3 外部投递不是数据库事务

计算终态与交付终态分开。实际投递前创建并冻结 `delivery_intent(run,artifactHash,destinationRevision)`；受信 dispatcher 取得短效、单用途 permit，并在原子授权点确认配置未撤销。尚未 dispatch 的 intent 在撤销后拒绝；授权点后的在途外部请求可能已生效，不能承诺回收已发邮件。

发送接受但响应丢失记 DELIVERY_UNKNOWN，保留 request ID；只有 channel 确有幂等/查询语义才安全恢复，不能直接自动 resend。无能力确认时人工 reconciliation。DB 断开未获 permit 则 WITHHELD，不叫 completed/delivered。expiry/revocation 测试包括授权前、授权后和外部接受后超时三个边界。[D2]

### 9.4 Shadow 和恢复

shadow 共享当前时点已录输入，独立 namespace，不覆盖 Flash latest、不发正常邮件。校验同 run analysis→editor→renderer→Flash→email 的身份/事实/限定一致；邮件可短。Argon 没有安全 shadow 入口则本地同构渲染，真正页面验收仍 BLOCKED。

activation 前固定监控与回滚条件；critical 事故暂停研究、评估取消/隔离/回滚。rollback revision 递增，不能把 previous 两版本来回摆动。无兼容安全目标则暂停新 run。对已发报告的更正保留 supersedes，不能删除失败历史。研究开关/授权撤销不改变旧确定性 forecast settlement。

## 10. 文件地图与逐步执行

保持 P0–P9/C 编号与原检查关联；按 M1/M2/M3/EXTENSION 分期验收，不能要求 M1 先完成全部 105 项。组合检查按 applicability 指定子范围验收，整体 status 在全部要求满足前保持 NOT_RUN，并在独立执行记录中记子范围结果。

| 阶段 | 修改范围、顺序 | 交付与退出条件 |
|---|---|---|
| P0 | 只读盘点 checkout/build/scripts；确认 extensions→buildTools→news builder；导出获准的部署/report 身份；保护旧承诺；跑允许的原 tests。 | `baseline-delta.md`、来源 manifest、原失败清单。不可访问生产只阻塞对应项；不 reset/clean 用户工作区。 |
| P1 | 新增 `plugins/option-wizard/runtime/{schema,defaults,index}.ts`，修改 news-overview/tools 注入；先 red test，再默认兼容/边界/并发测试。 | 仅 perStock=1/2/3 接线；默认与其他 phase 不变；真实第三条时上下文变化；无 module-global 污染。 |
| P2 / M1 | 优先复用现有 DB/插件入口；确需 runtime-control 模块再新增，路径为建议而非强制脚手架。临时 PostgreSQL 验证最小版本/snapshot/attempt/test 指针、当前角色 ACL、hash、幂等、CAS。 | test-only 人工初始化/切换/回滚；无自动授权、事件投影或生产 DDL。完整角色体系留 M3。 |
| P3 / M1 | 复用 runner/discovery/evidence/tool-io，工具构造前 snapshot；单 worker、独立 state、原始 feed 回放、证据保留、失败与 UNKNOWN 记录。 | C1 同产物 A/B 机械证据；无外部投递；断库/坏记录不静默回退。恢复前确认旧进程停止及未知请求已核对；自动接管才要求 fencing。 |
| P4 | 新增 `plugins/option-wizard/eval/{contract,coverage,checks,rubric}.ts`；冻结事件义务、数据血缘、正/负控；批准预算内 A/A；登记统计 policy 与 qualification。 | 有分母/unknown/裁定/误报漏报范围；缺真实 corpus 可先测 synthetic，不允许自动质量晋级。 |
| P5 / M2 | 复用研究入口，确定性注册 θB；冻结 scope/指标/样本/预算；单 worker A/B、成本记录和版本绑定比较报告。无需先拆四个新模块。 | 首个无代码比较报告，可无赢家；有证据也只到 REVIEW_READY。人工核对证据有效性；自动失效传播/认证竞争留 M3。 |
| P6 / M3 | production-like shadow、最终页面验证；四种动作分类、CAS、授权/认证撤销竞争、delivery unknown、监控和明确回滚。 | 同 C1 无 commit/重启切换与回滚的 test 证据；有真实合格候选且获授权才生产发布。 |
| P7 / M3 | 新增受限 proposer/有限 scheduler，管理员登记范围/预算/policy/资格/有效期；只读 development diagnostics；持续记 holdout 消耗。 | 域内可自动 propose/evaluate/reject/activate；无证据/无授权停止。{1,2,3} 已穷尽时 STOP_SEARCH_SPACE_EXHAUSTED，不无限生成等价候选。 |
| P8 | 每次加入一个 prompt/context/workflow/route mutation class；当次 bounded adaptation；完整决策 trace。 | 所有间接引用固定；新增能力独立 qualification；无任意模块/代码执行；一次修订不能直接变全局配置。 |
| P9 | research-kind 配置 η：finding 排序/提案/检索/已实现算子；同预算独立缺陷+不应修改任务；外部验证下游结果。 | 不按提案数或自评分；禁止未来答案；组合新候选重新评；η 与 θ 指针独立，无 meta 赢家保留旧 η。 |
| C | 仅需新执行能力时进入；#67 或等价真实 OS/进程/网络/文件隔离后才自动改码。 | worktree 不够；保护 evaluator/CI/.git/密钥/市场写入；无直接授权不 push/merge/deploy。不阻塞参数主线。 |

新包需实际接入 pnpm workspace、exports/build 与插件 discovery；禁止只新增文件却执行旧 lib。runtime-control 从 CLI composition root 注入；core 只见身份/接口，不见股票/宏观。按可验收交付拆小 PR，不机械地每个表/模块一个 PR；不能顺手改全套 prompt、候选排名或模型。

## 11. 首个定量试点与研究扩展

θA: premarket news 4/2/5；θB: 4/3/5。C1 默认兼容后，再取得实际 raw feed、calendar/watchlist/ledger 前态，划分 dev 与未消耗确认 cohort。独立标注事件，正/负控与 A/A。注册候选、目标 deployment/revision、execution namespace、输入 hash、统计规则及预算；未齐则 DRAFT_NOT_EXECUTABLE。

SNAPSHOT_PIPELINE 重新构建 news/frame；保存 rows/cap 和真正模型输入差异。生成并按固定 trial/retry 规则聚合；所有费用与失败保留。无收益保留 A；有证据先交 REVIEW_READY；进入 M3 后完成 shadow、成品验收并获得对应授权才激活。不要以本次假设重构 3+2 排名或 weekly 篇幅。

η 初期不需要 LLM，有限枚举能跑通即合格。后来模型提出候选，只在开发证据中选择已批准字段。η 自身比较需独立任务、同总预算、未泄漏未来修复，度量实际有用改善/错误修改/资源/人工干预；不允许自改裁判或永远“自我宣布胜出”。

### 11.1 M2 开跑前必须填全的判定表

主指标沿用 §7 的 `coverage.final`，不是重新发明总分。以下值必须由开发集标注、A/A 噪声及实际预算形成依据，在确认集开封前冻结；模板中的 null 禁止猜填。未齐仍为 DRAFT_NOT_EXECUTABLE，不阻塞 M1 的 stub 验收。

- **质量：**最小实用提升（coverage 的绝对比例差）、固定区间/检验实现及决策规则、claims.supported 非劣界限、可靠性非劣界限；已核实 critical 错误必须为 0，存在未裁定 critical 分歧不能 REVIEW_READY。人工风险接受不得改写这些结果。
- **资源：**每 trial 及总调用/token 上限、可执行的超时、总预算、相对 champion 的成本及延迟增量上限；写明计量窗口、聚合方法及未知费用处理。价格缺失只报实际 token/calls 与明确估值，不伪造严格美元上界。
- **样本：**开发/确认 case 清单与来源、独立日期/事件簇定义、簇数依据、每 case 重复数、A/A 噪声诊断、执行顺序随机化/配平方案、失败和重试统计规则。不得按输出效果挑样本、挑重试或选择性提前停止。
- **处理有效性：**在生成前按冻结 feed 划分“存在第三条合格新闻”及“无第三条”的 slice；主分析保留完整预注册 cohort，另报两类效果与样本量。存在第三条但实际上下文未改变时先调查接线/截断，不能声称已测试第三条的效果；无第三条是预期无差异，不补造、不事后排除。
- **作用范围：**动态值只进入 option-wizard/premarket；intraday、close、weekly、未知 phase 与 OFF 继续原值。记录 news rows、assembled context、截断及最终输出；后续自主取数导致曝光差异应如实记录。

决策顺序：身份/可比性失败 → INVALID 或 NOT_COMPARABLE；已核实 critical 或固定约束失败 → REJECT；样本/裁定/未知成本不足以判断 → INCONCLUSIVE；满足约束但未达到提升规则 → NO_CHANGE；全部满足 → REVIEW_READY。任何一种都是合法研究结果，只有后者可进入后续发布审查。

### 11.2 停止及恢复

预算达到预留上限、未知请求尚未核对、无未暴露确认集、kill、发现 critical 问题或候选耗尽时停止调度并保存状态与成本。首个确认候选只有 3 对 2；不在结果出来后追加 1 再复用同一确认集。1 属后续候选，需新的预注册比较和合格证据。没有收益不扩大搜索域。

M1 演练明确 test 回滚目标、兼容性、当前 revision 和操作记录；M3 激活前登记监控指标、观察窗口、触发阈值、执行者及无安全目标时暂停方案。回滚递增 revision，影响后续 run；当前 run 按冻结快照完成或显式取消。回滚不退还模型费用、不删除失败历史、不撤回已发邮件；外部更正需单独动作。

## 12. Verification 与运行手册

每项实际结果保存：checkId、level、given/expected、真实 command/exit code/observed、engine/config/input/evaluator/route 身份、原始证据 refs、时间与执行者。未跑 NOT_RUN；无环境 BLOCKED；推断不足 INCONCLUSIVE。修复后重跑追加结果，不能覆盖失败。

```text
SOURCE_REVIEW ≠ PACKAGE_STATIC ≠ SPEC_MODEL
  ≠ UNIT ≠ DB_INTEGRATION ≠ STRICT_REPLAY
  ≠ MODEL_COMPARISON ≠ SHADOW ≠ PRODUCTION_ACCEPTANCE
```

本包 validator 和 counterexamples 仅验证文档契约/纯 Python 模型，不代表数据库并发或 Helium 已通过。测试层级和限制记录到单独 receipt，不能把检查清单改 PASS。

当前已知开发命令，先在用户指定隔离 checkout 核对，不代表本次执行过：

```bash
git rev-parse HEAD
git status --short
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:scripts
```

依赖安装、真实模型/取数和生产动作需相应授权；分开记命令退出码，不只取 tee 的退出码。`run option-wizard` 可能取数/结算/投递，不默认当无副作用测试。

未来命令族 runtime validate/show/propose 与 research register/evaluate/inspect，以及管理员 initialize/activate/rollback/grant/revoke，均是待开发接口：有真实 help/schema/tests 后才写运行示例。默认 environment 非 production；管理请求显式 target、revision、receipt/approval、idempotencyKey。请求体 actor=admin 没有授权效力。

缺生产入口继续本地 P0–P5；缺推理预算继续 stub/Schema/DB/权限测试；缺 raw feed 不造数据；评价资格不足继续 diagnostic/manual，不开 AUTO；没有有统计依据的候选就保留 champion。真实测试未运行不得根据文档检查数宣称完成。

## 13. 本次提交和历史语义

v1.1 的提交授权与 GitHub 403 是历史记录，见原包。v1.2 当前请求是改进计划，仅交付文档修订；不是运行实现、生产迁移、激活、合并或部署授权。后续动作以届时会话授权与仓库交付规则为准。

旧 weekly 的指定首个运行、至少六个 call 等规则不改。实施时其日期若已过，读取原首个运行的真实证据，不能选后来成功重跑。旧实验 receipt 的 improved 与新控制面的可激活性分开；新质量规则不回写历史。

本版保留原 83 个 check ID/要求，并通过新增 A-* 将漏洞修成明确验收。历史 V/RT 映射只描述要求传承，不导入任何 PASS。设计审查解决指规范已补，不表示实现已修复。

## 14. 一手来源

- [G1] GitHub branch: `https://api.github.com/repos/moremeds/helium/branches/master`，本轮返回 e217534。
- [G2] `https://github.com/moremeds/helium/blob/e2175344525e355edc5662124712a7250a3d9b88/packages/cli/src/discovery.ts`，extensions/buildTools。
- [G3] `https://github.com/moremeds/helium/blob/e2175344525e355edc5662124712a7250a3d9b88/plugins/option-wizard/quality/news-overview.ts`，caps 与实际 builder。
- [G4] `https://github.com/moremeds/helium/blob/e2175344525e355edc5662124712a7250a3d9b88/.github/workflows/ci.yml`。
- [D1] PostgreSQL: `https://www.postgresql.org/docs/current/functions-sequence.html`、`https://www.postgresql.org/docs/current/transaction-iso.html`。取号/事务特性；事件漏读是本计划推导的反例，不称文档直接描述 Helium。
- [D2] AWS Builders' Library: `https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/`。请求身份与不确定副作用；本计划不假设所有 provider 已支持幂等。
- [D3] PostgreSQL: `https://www.postgresql.org/docs/current/sql-createfunction.html`、`https://www.postgresql.org/docs/current/sql-select.html`。受信函数与队列读取基础。
- [D4] Anthropic, Demystifying evals for AI agents, 2026-01-09: `https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents`。结果与 trace、校准、隔离和渐进建设；不外推文中 benchmark 到 Helium。
- [D5] Dwork et al., Generalization in Adaptive Data Analysis and Holdout Reuse: `https://arxiv.org/abs/1506.02629`。自适应复用 holdout 的风险；未在本计划实现论文算法。

**最终原则：无代码迭代不等于无约束迭代；能记录不等于能验证，能验证不等于永远正确。先交付小型、可拒绝、可恢复的纵向闭环。**
