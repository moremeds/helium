# Option-wizard Phase Remits Implementation Plan

> **For agentic workers:**执行用 `/execute-plan`。步骤是 checkbox (`- [ ]`)。

**Goal:** 让五个 phase 各有各的职责——premarket 最丰富、intraday 只报变化、close 复盘今天自己的判断并讲今天的故事、weekly 总结上周展望下周、frank 不动——并让邮件真的把这些内容送出去。

**Architecture:** 差异全部落在 `team.yaml` 的任务与提示词里。渲染器**不认识 phase**:它渲染报告里实际存在的叙述区块(`sections`),有几块渲染几块。唯一保持强类型的是候选结构(价格与失效价)。thesis 的台账就是报告本身,`ow_reports` 已经能读回来,不新建存储。

**Tech Stack:** TypeScript ESM, vitest, zod, YAML manifests.

**Spec:** 用户 2026-09-03 的口头规格(本文件"Global Constraints"逐条抄录),无独立 spec 文件。

## Global Constraints

- **不新建存储。** thesis 台账 = 报告文件;读回靠已有的 `ow_reports`(支持 `days` + `phase`)和 `extractJson`。
- **渲染器不得出现 phase 分支。** `grep -rn 'phase' plugins/option-wizard/render/*.ts` 必须保持 **0 匹配**。
- **候选结构保持强类型。** 价格、腿、失效价走 JSON 解析,永远不透传模型自由文本。原因:2026-09-02 的报告第 263 行漏出了模型草稿(`Wait, I need to double-check the exit rule text...`)。
- **叙述区块走 JSON**(`{"sections":[{"title","body"}]}`),不从 markdown 正则抠标题——JSON 里没有地方放草稿思维。
- **不含 quantity / 仓位大小**,任何地方。
- **邮件正文不含 run metadata。**
- **frank 保持现状**:`phases: [frank]`,plist `{'Weekday': 1, 'Hour': 21}` = 周一 09:00 ET,一个字节都不改。五个 plist 不动,mini 零部署改动。
- **时区**:一个日期,ET,来自 `report.day`。
- **core 中立**:`packages/core/src` 不得出现任何业务词。

---

### Task 1: 叙述区块自适应,渲染器忘掉 phase

**Files:**
- Modify: `plugins/option-wizard/render/index.ts`(`BriefView`、`buildView`)
- Modify: `plugins/option-wizard/render/text.ts:66-98`(`renderText`)
- Modify: `plugins/option-wizard/render/html.ts`
- Test: `plugins/option-wizard/tests/render.spec.ts`

**Interfaces:**
- Produces: `BriefView.sections: Array<{ title: string; body: string }>`,按任务顺序;`RegimeView.paragraph` 删除(并入 sections),`direction`/`volatility`/`hedge` 保留。
- Consumes: 每个叙述任务的 JSON `{"sections":[{"title","body"}]}`(Task 5 写进提示词)。

- [ ] **Step 1: 写失败的测试**

```ts
it("renders whatever sections the run produced, in task order", () => {
  const view: BriefView = {
    date: "2026-09-02", tenant: "option-wizard", outcome: "completed",
    sections: [
      { title: "利率是第一因", body: "10y 4.21%,曲线 bear-flatten。" },
      { title: "Path B — In-line CPI", body: "base case。" },
    ],
    regime: {}, candidates: [], riskList: [],
  };
  const text = renderText(view);
  expect(text).toContain("【利率是第一因】");
  expect(text).toContain("【Path B — In-line CPI】");
  expect(text.indexOf("利率是第一因")).toBeLessThan(text.indexOf("Path B"));
});

it("renders a run with no narrative sections at all", () => {
  const view: BriefView = {
    date: "2026-09-02", tenant: "option-wizard", outcome: "completed",
    sections: [], regime: {}, candidates: [], riskList: [],
  };
  expect(renderText(view)).not.toContain("【");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/render.spec.ts -t "sections"`
Expected: FAIL — `sections` 不在 `BriefView` 上。

- [ ] **Step 3: 改 `BriefView`**

```ts
export interface RegimeView {
  direction?: string;
  volatility?: string;
  hedge?: string;
}

export interface BriefView {
  date: string;
  tenant: string;
  outcome: "completed" | "DEGRADED" | "FAILED";
  /** 报告里实际存在的叙述区块,按任务顺序。渲染器不知道 phase,
   *  也不该知道:哪个 phase 产出哪些区块是 team.yaml 的事。 */
  sections: Array<{ title: string; body: string }>;
  regime: RegimeView;
  candidates: CandidateView[];
  riskList: Array<{ ticker: string; reason: string }>;
  degradation?: string;
  empty?: string;
}
```

- [ ] **Step 4: `buildView` 收集 sections**

在 `buildView` 里,遍历 `report.steps`(保持顺序),对每一步 `extractJson`,把 `parsed.sections` 里形状合法的条目追加进 `sections`:

```ts
const sections: Array<{ title: string; body: string }> = [];
for (const step of report.steps) {
  const parsed = extractJson(step.text);
  if (parsed === null || !Array.isArray(parsed.sections)) continue;
  for (const raw of parsed.sections) {
    if (raw === null || typeof raw !== "object") continue;
    const { title, body } = raw as Record<string, unknown>;
    // 标题和正文都必须是非空字符串。一个空 body 的区块在邮件里
    // 是一个空标题,比没有更糟:读者会以为内容丢了。
    if (typeof title !== "string" || typeof body !== "string") continue;
    if (title.trim() === "" || body.trim() === "") continue;
    sections.push({ title: title.trim(), body: body.trim() });
  }
}
```

- [ ] **Step 5: `renderText` 用 sections 取代硬编码的 regime 块**

`text.ts` 里删掉 `lines.push("【今日 regime】", view.regime.paragraph, "")`,换成:

```ts
for (const section of view.sections)
  lines.push(`【${section.title}】`, section.body, "");
```

stance 行、候选结构、风险清单保持原样。`html.ts` 做同一处替换。

- [ ] **Step 6: 跑测试并确认 phase 匹配数为 0**

```bash
pnpm vitest run --project unit plugins/option-wizard/tests/render.spec.ts
test $(grep -rc 'phase' plugins/option-wizard/render/*.ts | grep -v ':0$' | wc -l) -eq 0 && echo "renderer is phase-blind"
```

- [ ] **Step 7: Commit**

```bash
git add plugins/option-wizard/render/index.ts plugins/option-wizard/render/text.ts plugins/option-wizard/render/html.ts plugins/option-wizard/tests/render.spec.ts
git commit -m "feat(option-wizard): the brief renders the sections the run produced, not a fixed five"
```

---

### Task 2: proposal 带 id 与 horizon

**Files:**
- Modify: `plugins/option-wizard/render/index.ts`(`CandidateView`、proposal 解析)
- Modify: `plugins/option-wizard/team.yaml`(`review` 任务提示词)
- Modify: `plugins/option-wizard/render/text.ts`(`candidateLines`)
- Test: `plugins/option-wizard/tests/render.spec.ts`

**Interfaces:**
- Produces: `CandidateView.id: string`、`CandidateView.horizon: "intraday" | "day" | "multiday"`。
- Consumes: review JSON 每条 proposal 新增 `"id"` 与 `"horizon"`。

**为什么需要 id:** 复盘要说"AVGO 那条反转了",下一次运行必须能精确指认是哪一条。没有 id,look-back 只能靠字符串模糊匹配。

- [ ] **Step 1: 写失败的测试**

```ts
it("carries the proposal id and horizon into the brief", () => {
  const view = buildView(reportWithReview({
    proposals: [{
      id: "AVGO-2026-09-02-premarket-1", horizon: "multiday",
      ticker: "AVGO", strategy: "put spread",
      legs: [{ right: "put", expiry: "2026-09-25", strike: 370, action: "sell", ratio: 1, mid: 20.58 },
             { right: "put", expiry: "2026-09-25", strike: 360, action: "buy", ratio: 1, mid: 15.30 }],
      invalidation: "closes above 375", target: "50%", rationale: "skew",
    }],
  }), cfg);
  expect(view.candidates[0]?.id).toBe("AVGO-2026-09-02-premarket-1");
  expect(view.candidates[0]?.horizon).toBe("multiday");
});

it("drops a proposal with no id — an unidentifiable thesis cannot be reviewed", () => {
  const view = buildView(reportWithReview({ proposals: [{ ticker: "AVGO", legs: [] }] }), cfg);
  expect(view.candidates).toHaveLength(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/render.spec.ts -t "horizon"`
Expected: FAIL — `id` 不在 `CandidateView` 上。

- [ ] **Step 3: 加字段并在解析处校验**

```ts
const HORIZONS = new Set(["intraday", "day", "multiday"]);
```

`CandidateView` 增加 `id: string` 与 `horizon: "intraday" | "day" | "multiday"`。在 proposal 循环里,`id` 非空字符串、`horizon` 属于 `HORIZONS`,否则 `continue`——理由写成注释:一条无法被指认的 thesis 复盘不了,收盘时没人知道该结算哪一条。

- [ ] **Step 4: 邮件里印出 horizon**

`candidateLines` 首行改为:

```ts
`${candidate.ticker} — ${candidate.strategy}${dte} · horizon ${candidate.horizon}`,
```

- [ ] **Step 5: review 提示词声明契约**

`team.yaml` 的 `review` 任务 prompt 追加:

```
Every proposal carries `id` and `horizon`. `id` is
`<TICKER>-<report day>-<phase>-<n>`, n starting at 1. `horizon` is one of
intraday / day / multiday and it is YOUR call: it says when this thesis is
due to be settled, and the close run will look for exactly that. A proposal
without both is dropped before it reaches the reader.
```

- [ ] **Step 6: 跑测试**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/render.spec.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add plugins/option-wizard/render/index.ts plugins/option-wizard/render/text.ts plugins/option-wizard/team.yaml plugins/option-wizard/tests/render.spec.ts
git commit -m "feat(option-wizard): a thesis states when it is due to be settled, and can be named later"
```

---

### Task 3: intraday 只报变化

**Files:**
- Modify: `plugins/option-wizard/team.yaml`(新增 `drift-watcher` role 与 `drift` 任务;`design`/`review` 移出 intraday)
- Test: `plugins/option-wizard/tests/team-manifest.spec.ts`

**为什么:** 现在 intraday 跑的是和 premarket **完全相同**的六个任务,等于同一天把盘重新看一遍,再出一套新 setup。用户要的是"早上的判断现在还成立吗"。

- [ ] **Step 1: 写失败的测试**

```ts
it("intraday does not design or review — it only checks drift", () => {
  const team = parseTeamYaml(readFileSync(TEAM, "utf8"));
  const inIntraday = (id: string) =>
    team.tasks.find((t) => t.id === id)?.phases?.includes("intraday") ?? true;
  expect(inIntraday("design")).toBe(false);
  expect(inIntraday("review")).toBe(false);
  expect(inIntraday("drift")).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/team-manifest.spec.ts -t "drift"`
Expected: FAIL — 没有 `drift` 任务。

- [ ] **Step 3: 加 role**

```yaml
  - id: drift-watcher
    requires: [tool.use, reason.deep, long.context]
    prompt: >-
      You are re-reading a judgement you already made today, with the tape
      that has happened since. You are not looking for new trades and there
      is no design step behind you: the only question is whether this
      morning's thesis still holds.
```

- [ ] **Step 4: 加任务,`design`/`review` 的 `phases` 去掉 intraday**

```yaml
  - id: drift
    role: drift-watcher
    phases: [intraday]
    dependsOn: [gex, regime]
    requires: [tool.use, reason.deep, long.context]
    prompt: >-
      Call ow_reports with days:1 phase:premarket for this morning's report.
      For every proposal id in it, say whether the thesis is 加强 / 不变 /
      反转 against the levels you were just handed, and why, in one line each.
      Reply as ONE JSON object: {"sections":[{"title","body"}]}. When nothing
      moved, that IS the answer — say "无变化" and name what you checked;
      never invent a change to fill the mail. Anything you call 反转 gets a
      平仓建议 in the same line.
```

`design` 与 `review` 的 `phases:` 从 `[premarket, intraday, close]` 改为 `[premarket, close]`。

- [ ] **Step 5: 跑测试**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/team-manifest.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add plugins/option-wizard/team.yaml plugins/option-wizard/tests/team-manifest.spec.ts
git commit -m "feat(option-wizard): intraday re-reads the morning's thesis instead of writing a new one"
```

---

### Task 4: close 结算今天自己的判断,并讲今天的故事

**Files:**
- Modify: `plugins/option-wizard/team.yaml`(`markout` 提示词重写;新增 `recap-writer` role 与 `recap` 任务)
- Test: `plugins/option-wizard/tests/team-manifest.spec.ts`

**为什么:** `markout` 现在读的是 `days:2 phase:close`(昨天收盘)与 `days:8 phase:weekly`(周报)——按固定窗口捞,永远读不到今天早上的判断,和 horizon 是否到期也无关。

- [ ] **Step 1: 写失败的测试**

```ts
it("markout settles today's own calls, by horizon", () => {
  const team = parseTeamYaml(readFileSync(TEAM, "utf8"));
  const markout = team.tasks.find((t) => t.id === "markout")?.prompt ?? "";
  expect(markout).toContain("phase:premarket");
  expect(markout).toContain("phase:intraday");
  expect(markout).toContain("horizon");
});

it("close writes today's story", () => {
  const team = parseTeamYaml(readFileSync(TEAM, "utf8"));
  expect(team.tasks.find((t) => t.id === "recap")?.phases).toEqual(["close"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/team-manifest.spec.ts -t "markout settles"`
Expected: FAIL

- [ ] **Step 3: 重写 `markout` 提示词**

```yaml
  - id: markout
    role: markout-clerk
    phases: [close]
    requires: [tool.use, long.context]
    prompt: >-
      Call ow_reports with days:1 phase:premarket and days:1 phase:intraday
      for today's own calls, then days:5 phase:close for the ones still open
      from earlier in the week. Settle by horizon, not by age: an `intraday`
      or `day` thesis is due today and must get a verdict; a `multiday` one
      stays open unless it 反转. Every thesis gets 加强 / 不变 / 反转 by its
      id, one line, with the price that decided it. 反转 gets a 平仓建议.
      Reply as ONE JSON object: {"sections":[{"title","body"}]}.
```

- [ ] **Step 4: 加 `recap` role 与任务**

```yaml
  - id: recap-writer
    requires: [reason.deep, long.context]
    prompt: >-
      You write what today WAS, for someone who did not watch it.

  - id: recap
    role: recap-writer
    phases: [close]
    dependsOn: [gex, regime, markout]
    requires: [reason.deep, long.context]
    prompt: >-
      Two sections. First 今日故事: what actually drove the tape today, in
      the order it transmitted, with the numbers copied from the tools.
      Second 今日市场: breadth, vol, rates and where the money went, and
      what changed versus how the morning framed it. Reply as ONE JSON
      object: {"sections":[{"title","body"}]}.
```

- [ ] **Step 5: 跑测试**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/team-manifest.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add plugins/option-wizard/team.yaml plugins/option-wizard/tests/team-manifest.spec.ts
git commit -m "feat(option-wizard): close settles the day's own theses by horizon and tells the day's story"
```

---

### Task 5: 叙述任务改为输出 sections JSON

**Files:**
- Modify: `plugins/option-wizard/team.yaml`(`regime`、`scenarios`、`weekly`、`frank` 提示词)
- Test: `plugins/option-wizard/tests/team-manifest.spec.ts`

**为什么:** premarket 今天已经生成了 regime 四节 + Path A–D + base case + reverse risk,`render/text.ts` 只取了其中一段。让这些任务输出 sections,Task 1 的渲染器就会把它们全部送进邮件。

- [ ] **Step 1: 写失败的测试**

```ts
it("every narrative task replies as one sections JSON", () => {
  const team = parseTeamYaml(readFileSync(TEAM, "utf8"));
  for (const id of ["regime", "scenarios", "weekly", "frank", "drift", "markout", "recap"]) {
    const prompt = team.tasks.find((t) => t.id === id)?.prompt ?? "";
    expect(prompt, id).toContain('{"sections":[{"title","body"}]}');
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/team-manifest.spec.ts -t "sections JSON"`
Expected: FAIL

- [ ] **Step 3: 四个提示词各追加一句**

`regime`、`scenarios`、`weekly`、`frank` 的 prompt 末尾各加:

```
Reply as ONE JSON object and nothing else: {"sections":[{"title","body"}]} —
one entry per section you were asked for, in that order, no prose outside the
JSON. Your working notes are not a section.
```

最后一句是针对 2026-09-02 报告第 263 行的:模型把 `Wait, I need to double-check the exit rule text...` 写进了归档报告。

`weekly` 的 prompt 同时把"上周总结 + 下周展望"说成两组区块:上周每条 call 一节,下周 A/B/C/D 加 base case 一节。

- [ ] **Step 4: 跑测试并 typecheck**

```bash
pnpm vitest run --project unit plugins/option-wizard/tests/team-manifest.spec.ts
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add plugins/option-wizard/team.yaml plugins/option-wizard/tests/team-manifest.spec.ts
git commit -m "feat(option-wizard): narrative steps return sections, so the mail can carry them"
```

---

### Task 6: 五个 phase 的真实运行证据

**Files:**
- 无代码改动;产出物是 `.helium-state/reports/` 下的报告与实际收到的邮件。

- [ ] **Step 1: 构建**

```bash
pnpm build && pnpm typecheck && pnpm test
```

- [ ] **Step 2: 按顺序跑,premarket 先跑(intraday/close 依赖它的报告)**

```bash
export HELIUM_STATE_ROOT="$PWD/.helium-state"
export HELIUM_TENANT_DELIVERY=1
export HELIUM_EMAIL_MAX_PER_DAY=9
export CODEX_ACCESS_TOKEN="$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.codex/auth.json')))['tokens']['access_token'])")"
for p in premarket intraday close weekly frank; do
  echo "=== $p"
  node packages/cli/lib/cli.js run option-wizard --phase "$p" 2>&1 | grep -E '^(outcome|delivery|providers)'
done
```

- [ ] **Step 3: 逐条验收**

| phase | 验收条件 |
|---|---|
| premarket | 邮件含 regime 四节 + Path A–D + base case + reverse risk;每条候选带 `horizon` 与 id |
| intraday | 邮件只讲变化;无变化时出现"无变化"且**没有**新候选结构 |
| close | 每条今日 thesis 按 id 得到 加强/不变/反转;反转的带平仓建议;含 今日故事 与 今日市场 |
| weekly | 上周逐条结算 + 下周 A/B/C/D |
| frank | happy path 未验证(opencli 未登录),记为 `[unverified]` 并说明原因 |

- [ ] **Step 4: 确认渲染器仍不认识 phase**

```bash
grep -rn 'phase' plugins/option-wizard/render/*.ts; echo "exit=$?  (期望 1 = 零匹配)"
```

- [ ] **Step 5: 推送并更新 PR #77**

```bash
git push
gh pr view 77 --json url,statusCheckRollup
```
