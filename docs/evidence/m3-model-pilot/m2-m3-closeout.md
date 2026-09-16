# M2 / M3 收尾与重新规划

日期：2026-09-16。用户决定结束这条路线，保留成果，退一步重新规划。

结案状态：M2 `CLOSED_DIAGNOSTIC / NOT_QUALIFIED`；M3
`CLOSED_PILOT / IMPROVEMENT_NOT_DEMONSTRATED`。不是成功完成原研究目标。
停止新增实验、参数搜索和此路线的自动推进。关闭未合并 PR，保留分支、
worktree、已有代码和原始证据；不合并、不部署、不删除、不改写历史。
M1 不在本次关闭范围内。

## 各自做了什么

| | 原本要解决的问题 | 实际交付 | 没有证明的事 |
| --- | --- | --- | --- |
| M2 | 固定评价标准下比较 agent 输出，验证改进是否可信 | 受控推理入口、请求/用量记录、回放与缺失输入停止、配对分析、weekly 输入诊断修复、coverage/depth 评审材料 | 没有合格的 A/A 校准与独立确认；不能证明 weekly 质量提升，不能认定真实请求模型身份已绑定 |
| M3 | 根据反馈提出候选、执行、评价、保留，逐步改善工作结果 | 约束优先 utility、候选保留规则、预算/停滞函数、framework 对照比较器、持久化 CLI、Argon 真实数据的模型定价适配和一次辅助研究闭环 | 没有自动提出并迭代改进的完整优化器；没有新旧 framework 对照；没有证明策略改善或 framework 效率提升 |

M2 收尾依据：[原 M2 closeout](../../../tmp/herd-m2/m3-close-1/m2-closeout.md)。
M3 实现依据：[utility 说明](../m3-utility/README.md)、[真实 pilot 说明](README.md)。
M3 分支实现提交：`9a2f805`、`e039f28`、`89e64a8`。
Argon adapter 提交：`c3b3fbbf`。

## 实验结论与必要纠正

- Weekly 路线混入了模型路由未解析回退、非 JSON/envelope 输出、回放输入缺失等问题。
  它们帮助定位工程缺陷，但无法充当质量提升的对照证据。
- 最早的 38.9% 回撤是另一组多标的 capital sweep 的初始本金归一化指标。
  不能据此断言 SPX 的 15% OOS 目标失败。旧记录由后续纠正说明覆盖，原件保留。
- 最后一次 SPX pilot 用真实历史输入，但价格来自模型、成本是假设、净值仅累计
  已实现结算盈亏。不是 NBBO 成交回测，也没有持仓期间市值回撤或独立 OOS 证据。
- 固定 $2 成本情景：20% 基准 / 10% 候选 / 5% 对照的已实现回撤为
  82.14% / 47.25% / 24.78%。候选改善基准但在约束优先 utility 下不如缩仓对照。
  最终拒绝候选，保留原 baseline。三种成本情景决定一致，9 项结果复跑一致。
- 单纯缩仓降低回撤不等于发现更好的交易机制；本次并未验证新入场条件。
- Pilot 的 runtimeModelCalls=0 只描述确定性执行器，不包含开发 agents。
  开发 token/成本、人工干预总量未测得，不能据此宣称低成本或效率提升。
- “闭环完成”仅表示一次人指定候选的执行与判定结束，不等于自主 self-improvement。
  最终结果明确 `targetStatus=UNVERIFIED`、`framework.comparison=NOT_RUN`。

## 为什么这条路线停止

问题并非只有缺少 NBBO。我们没有先确定一个可靠且便宜的评价任务，就先扩展了
回放、证据、控制器和评分工具。为了证明 framework 有用，测试对象不断变化：
weekly 写作、输入 coverage、模型协议、量化策略。主目标被环境修复和研究工作吞没。

我作为 lead 的失误：把单项实现和测试通过说得过于接近目标完成；在没有统一指标
时给出策略失败结论；对 minion 的检查/证据任务分派过细，却没有尽早验证最短
端到端路径；把回测任务的进展与 framework 的因果贡献混在一起。

最终测到了“一个流程能执行”，没有测到“这个流程比简单基线更有效”。
因此继续沿当前实验堆叠功能，缺乏可检验的收益依据。

## 保留与停止

保留可复用的 evaluator、预算/停止规则、失败/未知状态、原始证据保存和输入绑定。
这些是候选组件，不因保留而自动进入生产，也不要求将整条分支合并。

停止 weekly 重跑、VRP sizing 搜索、为本次失败补齐所有行情设施、继续增加调度
和评分模块。剩余 MTM/NBBO、sealed holdout、自动提案和 framework A/B 记录为
未完成，不再作为本案待办。若重新启动，需要新的问题定义和实验边界。

## 下一次规划的顺序（尚未执行）

1. 选一个已经有可信、廉价评价器的真实任务。优先评估现有软件的性能/资源优化：
   固定真实输入、固定输出正确性检查、可重复测量的执行成本。先确认无额外数据建设。
2. 先用一次普通 agent 会话完成同一任务，记录结果、人工干预和总消耗，建立简单基线。
3. framework 只增加一个被基线暴露的问题所支持的机制，例如让下一次尝试利用上次
   测试失败。工具、模型、预算、输入与评价器固定。
4. 比较有效任务结果和完整成本；数据不足写未知。收益没有超过普通基线，就不保留
   该机制。预先设定有限尝试数，不能为了“做成”无限延长实验。
5. 一项有效后才考虑通用化。策略优化可以作为独立真实项目继续，但不再承担证明
   整个 framework 的全部责任。

本次不选定新项目、不发起新实验；先以此收尾材料重新讨论问题定义。

## 存档清单

- Helium #129：M2；关闭，未合并。依赖的 #127/#128 不在本次关闭范围。
- Helium #131：M3；关闭，未合并。
- Argon #431：模型定价适配；关闭，未合并。
- Helium worktree `.worktrees/m3-self-improvement`：保留。
  私有输出 `tmp/m3-utility-v1/`、`tmp/m3-closed-loop-1/`、`tmp/m3-closed-loop-2/` 保留。
- Argon worktree `.worktrees/m3-vrp-killswitch`：保留。
  `tmp/m3-pilot-1/`、`tmp/m3-pilot-2/` 和早期 preflight/experiment 原件保留。
- M2 历史实现、route guard、input repair worktrees/证据继续保留，未清理。
- 已知 herdr 工作者 `helium-m2-implementer` 与 `argon-m3-vrp-implementer`
  收尾时均为 idle；未重新派发。其 pane/context 保留，避免丢失交接上下文。


## 2026-09-16 交付决定更新

用户在研究结案后授权 merge and release，条件是不影响 production。本节覆盖上文
“关闭、未合并”和“不合并”的交付决定；原研究结论及历史记录保留。

Helium 通过 #131 向 master 汇总 #127/#128/#129 的依赖内容，保留原提交历史。
Argon #431 已合并，merge commit 为 `a7cc531f7d432951f439eb4f1508c26c74f91ef6`。
发布采用非生产 prerelease：Helium 仅发布源码存档；Argon 使用既有 prerelease
路径，不更新 `latest` 镜像。不得调用 Helium deploy 或修改 Mac mini 服务。
合并和发布不代表 M2 qualification、M3 改进有效或生产验收。

下一步仍从上文的新任务定义开始；本次不重启实验，不清理任何证据或 worktree。
