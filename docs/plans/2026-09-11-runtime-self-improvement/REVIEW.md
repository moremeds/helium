# Self-review / adversarial review — v1.1

2026-09-11. 对象是前版完整计划、83 项验证、Schema 与示例，不是已实现的 runtime-control。评审者与原作者为同一助手；这是自审与反方推演，不是独立第三方认证。

## 结论

保留“runtime-first、不可变策略版本、独立评价、受控激活”方向，但前版不宜直接视为完整生产控制协议。以下问题在 v1.1 的设计中补齐；**设计已补不等于实现已修**。初期交付收缩为 P0–P3 的 test-only 纵向切片；真实量化与自动晋级仍需 P4–P7 证据。

## 发现与修订

| ID / 严重度 | 反例 / 原缺口 | 本版决定 | 验收 |
|---|---|---|---|
| R1 / High | 前版允许 measurement supersedes，但旧 PASS receipt 没有明确失效协议；更正后仍可能被拿去激活。 | receipt 绑定依赖和 certification epoch；更正/资格撤销推动 epoch，激活同事务复核；历史不改，当前可用性可撤销。 | A-01/02 |
| R2 / High | 前版 consumer_offsets.last_event_id 容易被实现为高水位游标。低 ID 事务晚提交时，即使不丢日志也会丢消费。 | 每事件 ack，不用取号顺序代替提交完备性；投影/ack 原子、按 aggregate revision 防倒退。 | A-03/04 |
| R3 / High | lease 失效恢复没有明确 fencing；暂停的旧 worker 恢复后可能覆盖新 worker。provider timeout 又不等于没执行。 | epoch 条件写与受信 dispatch；未知消耗继续占预留，未确认不自动释放/重付费；retry 不增加独立统计样本。 | A-05/06/07 |
| R4 / High | 单个实验限制开封，不足以限制长期 controller 换 campaign 重复用同一批数据；持续选择会污染 holdout。 | case/cluster 血缘、跨 campaign decision family、一次确认 cohort、真实新证据或独立批准的 adaptive-valid 方法。 | A-08/09 |
| R5 / High | 激活伪代码只检查 AUTO grant，未区分手动/初始化/回滚；模板 environment=evaluation 与 production target 的关系不明确；grant 到期是否停生产也含糊。 | 四动作专用授权；targetDeployment 与 executionContext 分开；automation grant 与 active configuration approval 分离。 | A-10/11/12 |
| R6 / High | “投递前检查撤销”不能原子包住外部邮件接受；数据库事务或 request hash 不能保证外部 exactly-once。 | delivery intent、短效 permit、线性化边界、DELIVERY_UNKNOWN 与 channel 能力相关的 reconciliation；无证据不盲重发。 | A-13/14 |
| R7 / Medium | 只看 cap 改了不证明 model context 变了；反之要求模型调用路径完全相同又会拒绝合法候选。 | 保存真实 treatment/context 差异、截断及补查；strict transcript 用于证据，pipeline 允许 frozen world 可支持的合法路径。 | A-15/16 |
| R8 / High | ACL 能阻止 proposer 写分数，但不能阻止 candidate/source 文字诱导 LLM grader 自己给错分。 | 单独测试 grader prompt injection、自报支持/伪来源/隐藏文本；按真实 final artifact 与证据裁定；未 qualified 不自动质量晋级。 | A-17/18 |
| R9 / Medium | 一个 knob 的验证可能被十阶段大平台阻塞；有限 {1,2,3} 空间也不需要无限模型提案。 | 优先小型 test-only 纵向切片，确定性枚举先行；明确空间穷尽停止。 | A-19/20 |
| R10 / Medium | Schema 验证发生在 JSON.parse 后，不能检测被覆盖的重复键；canonical 字节实现不一致可破坏身份。 | 原始严格 parser + JSON Schema 分工；数字/Unicode/数组/键排序向量，禁止靠 JSONB 文本计算共享 hash。 | A-21/22 |

## 证据与方法

本轮通过连接重读 master、news builder、extensions 及 CI 配置。master 仍是 e217534；这不是 mini 部署证明。仅文档分支提交，不主动创建 PR/触发付费 eval 或部署。前版三个文件和 ZIP 的具体版本由容器中实际存在的附件核对。

R2 的反例由 PostgreSQL sequence/事务规则推导：T1 获取低序号后等待，T2 高序号先提交被消费，之后 T1 提交；只读 id>cursor 会漏 T1。[D1] R4 的方向受 adaptive holdout 研究支持，但本版不声称实现了论文的可复用 holdout 算法。[D5] 外部重试风险采用 AWS 的请求身份/不确定副作用原则，不假设 Helium provider 具备文档中所有 API 能力。[D2]

Anthropic 的评测资料支持结果/轨迹区别、隔离、校准与渐进建设。[D4] 这不构成对 Helium 的质量测量或独立审查。所有解决方案为针对本计划的设计选择。

## 本地验证与剩余阻塞

`verification/validate_package.py` 检查 JSON/Schema、例子、105 个唯一检查、77 个映射和模板禁用；`counterexamples.py` 是纯 Python 规范模型。其结果只能标 PACKAGE_STATIC / SPEC_MODEL，不能把 checks.json 改为 PASS。

本环境没有 psql，没有数据库集成结果；没有连接 mini、运行 Helium tests 或真实模型比较。自动质量激活仍被真实数据库权限/竞态验证、provider 隔离、真实 corpus、评价器资格、统计 policy、预算、scope 授权和实际成品验收阻塞。自审不能保证没有其他漏洞。

在全部这些验证前，允许开始本地 P0–P3 工程，不允许宣称 production-ready。任何未来测量更正需要新 receipt，不擦除原失败。

一手链接与出处编号见 PLAN.md 第 14 节；本审查不把引用文献里的收益数字移植成项目成绩。
