# 评估：能否参考 DSH 源码优化 api2kiro-dual 的 DeepSeek 表现

日期：2026-09-15 · 类型：只读评估，未改动任何代码

---

## 一、结论摘要（先看这个）

1. **前提需要纠正**：你的 DeepSeek 缓存命中率**已经是 97.7%**。这不是「可以再提高」的指标，
   而是接近上限。把精力放在缓存命中率上，ROI 接近于零。
2. **真正的瓶颈是首 token 延迟（TTFT），而且它在上下文超过 200K token 后跳升约 3 倍**
   ——在缓存命中率 ≥95% 的条件下依然如此。原因是 DeepSeek 的 KV cache 省的是「重算」，
   省不掉「在长上下文上做注意力」和「中转站按 prompt 长度排队」。
3. DSH 的优势**不在缓存技巧，而在上下文纪律**：主动压缩 + 确定性裁剪工具输出 + 只追加不重写。
   它的 231 个包里 517 个 README 都有强制性的「KV Cache 影响」一节，这是一套成文的设计约定。
4. **今天就能零代码验证的头号假设**：把报给 Kiro 的上下文窗口从 1,000,000 调到 200,000，
   让 Kiro 提前压缩。用插件自己的用量账本前后对比 TTFT 分布即可判定。

---

## 二、能看到 DSH 源码吗？—— 能，而且比想象的完整

位置：`~/Documents/dsh-sandbox`，DSH = **DeepSeek Harness**，官方包 `@deepseek-ai/dsh`。

| 项目 | 结论 |
|---|---|
| 版本 | `0.1.5-alpha.2`（npm 上已有 `0.1.5-rc.1`、`0.1.6-alpha.1`） |
| 包数量 | 231 个 `@deepseek-ai/dsh-*` 子包 |
| 源码形态 | **未压缩、保留完整 JSDoc 的编译产物** `lib/*.js` + `.d.ts`，无 sourcemap |
| TypeScript 原文件 | 仅第三方 vendored 库有 `src/*.ts`（cordis、schemastery 等 28 个），dsh-* 自身没有 |
| LLM 底座 | `@earendil-works/pi-ai` 0.84.4 / 0.85.1；DeepSeek 官方适配器是 `dsh-llm-deepseek`（92KB 单文件） |
| 模型目录 | `deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`，窗口均声明 **1,000,000** |

**所以「读源码」完全可行**——编译产物可读性接近 TS 原稿，注释、设计意图、不变式都在。
真实的金矿不是代码本身，而是**每个包 README 里的「KV Cache 影响」小节**（全库 517 处），
它把「这个改动会不会打掉上游前缀缓存」变成了一条必须写明的设计交付物。

> 附带发现：你的 DSH 沙箱 `settings.yaml` 里对**同一批中转站**配置了
> `commandcode / deepseek/deepseek-v4.1-flash`，窗口 **1,000,000**、`maxTokens` **384,000**（opencode-go 条目）。
> 也就是说，DSH 与 Kiro 插件正在打同一批上游，A/B 对照的条件是成立的。

---

## 三、前提纠正：缓存命中率已经到顶了

数据来源：插件自己的持久化账本 `usage.ledger.v1`
（`~/Library/Application Support/Kiro/User/globalStorage/state.vscdb` → key `api2kiro-dual.api2kiro-dual`），
最近 2000 条记录，其中 DeepSeek 相关 697 条。

### 3.1 总体

| 指标 | 全部 | DeepSeek |
|---|---|---|
| 请求数 | 2000 | 697（成功 688，失败 9 = 1.3%） |
| 未命中输入 | 17,030,111 | 4,094,893 |
| 缓存读 | 432,091,596 | 168,459,008 |
| **缓存命中率** | **96.2%** | **97.6%** |

按 provider/model 拆分：

| 渠道 / 模型 | n | 命中率 | 未命中输入 | 缓存读 |
|---|---|---|---|---|
| commandcode / `deepseek/deepseek-v4.1-flash` | 665 | **97.7%** | 3,478,941 | 150,543,744 |
| snaillmou / `deepseek-v4-pro` | 31 | 97.0% | 551,341 | 17,915,008 |
| commandcode / `deepseek/deepseek-v4-pro` | 1 | 0.4% | 64,611 | 256 |

### 3.2 单次请求命中率分布（输入 >5000 token，686 次）

| 命中率区间 | 次数 |
|---|---|
| 99–100% | **549** |
| 95–99% | 86 |
| 80–95% | 28 |
| 50–80% | 7 |
| 0–50% | 13 |
| 0% | 3 |

**80% 的请求命中 99–100%。** 距离上限只剩 2.3 个百分点可挤。

### 3.3 残余 miss 高度集中，且成因是「事件」而非「系统性前缀漂移」

未命中成本按单次请求排序，**前 20 次请求就占全部未命中输入的 80.6%**：

| 排名 | 未命中 | 命中率 | 上下文构成 | 时间 |
|---|---|---|---|---|
| 1 | 521,413 | 8.4% | hist=496,867 tools=24,333 | 09-10 08:42 |
| 2 | 455,931 | 12.0% | — | 09-15 19:30 |
| 3 | 393,731 | 5.0% | — | 09-15 17:35 |
| 4 | 346,658 | 0.0% | — | 09-15 16:35 |
| 5 | 276,941 | 7.7% | — | 09-15 20:06 |

自动检测「高命中 → 骤降」事件共 12 次，**几乎每一次都伴随模型切换或会话新建**：

```
骤降 #2: 99.0% (gemini-3.8-flash)  →  8.4% (deepseek-v4-pro)   ← 换模型
骤降 #3: 99.9% (deepseek-v4-pro)   →  0.0% (gpt-5.6-luna)      ← 换模型
骤降 #10: 99.9% (gpt-5.6-sol)      →  0.0% (gpt-5.6-terra)     ← 换模型
骤降 #11: 99.6% (gpt-5.6-terra)    →  0.0% (gemini-3.8-flash)  ← 换模型
```

典型会话形态（`sess_0034671c`）：一次冷重建后，后续全部 98.9% → 100.0% 长期稳定。
**这说明插件在 DeepSeek 通路上对前缀是「透明」的，没有系统性地打掉缓存。**

唯一一例无法用「换模型 / 新会话」解释的骤降：
`sess_c81865ea` 在 20:04:43 还是 97.7%，20:08:44 掉到 9.8%（in=110,486 / cache=12,032），
4 分钟内、同一会话、同一模型。可能原因：用户在会话中途换了启用的提示词
（`messages[0]` 被重写 → 从第 0 个 token 起全失效），或 Kiro 重排了工具列表，
或中转站在多个上游后端之间做了负载均衡（各自独立缓存）。
这条值得单独抓一次现场确认。

---

## 四、真正的瓶颈：TTFT 随上下文体积非线性上升

### 4.1 延迟画像（688 次成功请求）

| 指标 | p50 | p90 | max | 平均 |
|---|---|---|---|---|
| 总延迟 | 20,825 ms | 40,661 ms | 142,938 ms | 22,788 ms |
| **首 token（TTFT）** | **14,994 ms** | 33,511 ms | 95,282 ms | 17,262 ms |

**TTFT 占总延迟的中位数是 82%。** 时间基本都花在「等第一个字」上，不是花在生成上。

### 4.2 关键交叉表：只取命中率 ≥95% 的请求

| 上下文总量 | n | TTFT 中位 | 总延迟中位 | 输出中位 |
|---|---|---|---|---|
| < 50K | 3 | 2,820 ms | 8,214 ms | 363 |
| 50–100K | 49 | 5,316 ms | 8,279 ms | 459 |
| 100–200K | 190 | **7,224 ms** | **12,250 ms** | 800 |
| 200–400K | 290 | **21,808 ms** | **28,244 ms** | 836 |
| > 400K | 103 | 19,201 ms | 27,545 ms | 721 |

**从 100–200K 跨到 200–400K，TTFT 跳了 3 倍（7.2s → 21.8s），而输出量几乎没变（800 → 836）。**
也就是说：同样长度的答案，因为上下文躺在 300K，每次请求要多等约 15 秒。

机制是清楚的，也不是插件的锅：
1. KV cache 命中省掉的是「重算前缀」，但解码每一步仍要在全部 300K 位置上做注意力；
2. 中转站按 prompt 长度排队 / 计费和调度，缓存命中不改变这一点；
3. 未命中的那 2.3%（300K × 2.3% ≈ 7K token）仍要实打实 prefill。

> ⚠️ 这条是强相关的观察，不是严格因果实验：200–400K 的请求集中在长会话里，
> 可能同时叠加了「时段 / 中转站负载」的混淆因素（同一会话内也出现过 93s 的离群请求）。
> 因此第五节给了零代码的 A/B 方案来证实或推翻它。

### 4.3 其他值得注意的延迟信号

- 最慢一次 `latencyMs = 816,893 ms`（**13.6 分钟**），status=200，模型 `deepseek/deepseek-v4.1-flash`。
- 失败 9 次：400 × 2、429 × 1、status=0（超时/连接） × 3、status=200 但 ok=false × 3。
- 有一条记录 `firstTokenMs = 28,330 / latencyMs = 28,465` —— TTFT 占 99.5%。

---

## 五、DSH 的「缓存教义」：它到底做了什么

DSH 把「会不会打掉上游前缀缓存」当成一等公民的设计约束，每个包 README 必须写明
`#### KV Cache 影响`，用词固定为三类：**仅追加 / 前缀稳定 / 替换（会失效）**。
以下均为源码与 README 实证，非推测。

### 5.1 工具 schema 强制确定性排序

`dsh-system-prompt` 的 `orderTools()`：

```js
function compareNames(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function compareToolNames(a, b) { return compareNames(a.name, b.name); }
function orderTools(tools, toolOrder, knownNames) {
  if (toolOrder === undefined) return tools.sort(compareToolNames);
  ...
}
```

注释原文：**「Code-unit name comparison — locale-independent, so the order is identical on every machine.」**
还提供 `toolOrder` 配置项，带 `"<unlisted-tools>"` 占位符，让用户把工具顺序钉死。

`dsh-mcp-client` README 补充了关键判据：
> 「恢复未变列表的重连会生成**完全相同**的定义，前缀保持稳定。」

**为什么这条最重要**：tools 排在 token 流的 systems 之后、messages 之前，
一旦顺序或描述有一个字节变化，**它后面的全部内容都失效**。

### 5.2 系统提示是固定序号表，且「变更追加到历史」而不是重写头部

`SECTION_ORDERS` 是一张写死的数值表（`HARNESS_IDENTITY: -1000`、
`PLAN_POLICY: 500`、`TOOL_BASH: 1000`、`TOOL_READ: 1100` …），
`comparePromptSections` 按 `order` 再按名字确定性排序。

`dsh-agent-loop` README 给出了核心决策规则：
> 「原地替换某个系统节点的提示词变更会使请求**从该节点的第一个 token 起就不同**——
> 该节点是第 0 号节点时则**整个请求都不同**……
> 当已准备调用声明 `systemPromptUpdate: 'in-history'` 时，同一请求序列延续期间的
> 非空提示词变更会**追加到已缓存历史之后**，因此直到该历史末尾的前缀仍可复用。」

这是「在不具备重写头部能力时，宁可在尾部追一条新指令，也不要动头部」的完整论述。

### 5.3 时间注入：尾部 + 节流 + 默认关闭

`dsh-time-context`（README 原文：**opt-in request clock context**）：
- 时间戳作为**独立 user 消息追加在 messages 末尾**，不是塞进 system；
- 有 `refreshIntervalMs` 节流：距上次注入不足该间隔就**整条跳过**，不产生新消息；
- `intervalMs` 省略或为 0 时每次合格尝试都注入（README 明确把它列为「已知限制：压缩之间的历史成本」）。

代码：
```js
return { ...decision, messages: [...decision.messages, createUserMessage({...})] };
```

### 5.4 压缩：主动、有预算，且摘要调用本身复用缓存

`dsh-compaction-basic` 默认参数：`thresholdRatio 0.8`、`retainRatio 0.16`。
即在窗口用到 80% 时压缩，只保留 **16% 的逐字尾部**，其余换成一个结构化 checkpoint。

它的摘要调用设计得相当讲究——**把指令放在尾部，让这次辅助调用本身成为主请求的前缀**：

```js
const COMPACTION_INSTRUCTION = [ ... ];  // 以「最后一条 user 消息」的形式追加
/** The summarization directive, delivered as the FINAL user message after the
 *  replayed conversation rather than as a distinct summarizer system prompt.
 *  Keeping the conversation's own system prompt, tools, and message prefix in
 *  front of it makes the auxiliary call a genuine prefix of the last routed
 *  request, so the provider's KV cache is reused instead of invalidated. */
```

以及 `buildSummarizationInput()` 的说明：
> 「the system prompt held by the `system/message` at surface node 0, the header's
> tool schemas, then the region's own derived messages in surface order.」

其 README 也如实承认代价：
> 「它是替换，而非仅追加。每个检查点都会使从第一个已替换历史 token 起的复用失效；
> **该范围之前未更改的请求前缀仍可复用。**」

### 5.5 工具输出：确定性的头/中/尾裁剪

`dsh-compaction-tool-result-pruner`：

```js
const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
const DEFAULTS = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 };
```

- 纯字符预算、无模型参与、可重放（`Replay-safe, model-free`）；
- 配置校验保证 `head + marker + tail <= threshold`；
- 已存在的截断标记会**复用而不是叠加**（`dsh-tool-jobs` README）；
- README 如实标注：「替换较早的结果会使从第一个改变的 token 起的复用失效。
  当其路由、envelope 与之前的历史保持一致时，已剪枝前缀可以复用。」

配套的 `dsh-output-retention` 是一个**无 ctx、无事件、无状态的纯库**，
在工具产出阶段就把体量卡住（`ItemRetainer` / `TextRetainer`），而不是事后补救。

### 5.6 DeepSeek 适配器：用量口径与字段处理

`dsh-llm-deepseek` 的 `mapUsage()`：

```js
const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
...
inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
```

注释说明了它为什么这么算：
> 「DeepSeek's `prompt_tokens` INCLUDES cache hits
> （`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`）；
> the harness TokenUsage convention is DISJOINT counts, so cache reads are subtracted out.」

序列化侧要点（`serialize.js` region）：
- `serializeAssistant()` **无条件**带上 `reasoning_content`（只要历史里有 reasoning 块）；
- 不排序 tools，顺序由 harness 决定；
- 可选字段**省略而不是发 null**，让上游默认值生效；
- 恒定 `stream: true` + `stream_options: { include_usage: true }`；
- 常量：`DEFAULT_CONTEXT_WINDOW = 1_000_000`、`DEFAULT_MAX_TOKENS = 256_000`。

### 5.7 其他相关约定

| 包 | 「KV Cache 影响」原文结论 |
|---|---|
| `dsh-llm-deepseek` | 官方适配器，`thinking:{type}` + `reasoning_effort` |
| `dsh-repeat-tool-reminder` | 仅追加；新内容位于可复用前缀之后 |
| `dsh-plan-mode` | 段落内部稳定，但**进出计划模式会从顺序 500 起改变系统提示词** |
| `dsh-tool-fs` / `dsh-tool-bash` | 工具集合与指导文本不变时前缀稳定 |
| `dsh-token-meter` | 不直接失效；消费方负责。只在**规范 envelope 完全相同时**复用上游用量 |
| `dsh-session-title-llm` | 副请求不使主请求失效 |
| `dsh-agent-loop` | 「只有在同一提供方与模型路由下，且系统文本、schema 与此前历史都保持**逐字节一致**时，请求才保持仅追加」 |

**注意最后一条的范围限定**：「同一提供方与模型路由下」——这正好解释了
你的数据里为什么换模型 = 缓存归零。

---

## 六、逐条对照：哪些已经等价、哪些是真缺口、哪些抄了没用

### 6.1 已经等价或插件做得更好的（不必动）

| 维度 | DSH | api2kiro-dual | 判定 |
|---|---|---|---|
| 请求体确定性 | 固定字段序、省略可选 | 固定字面量字段序、无随机/时间字段 | ✅ 等价 |
| 历史改写 | 只追加 | 不裁剪、不摘要、不重排（唯一改动是 `pairToolResults`，确定性） | ✅ 等价 |
| 系统提示位置 | node 0 单条 | `messages.unshift` 单条 | ✅ 等价 |
| 凭证粘性 | 路由固定 | `credentialPool` 按 `conversationId` 固定同一把 key | ✅ 等价（且 README 写明理由） |
| 流式设置 | `stream:true` + `include_usage` | 完全相同 | ✅ 等价 |
| 可选字段 | 省略而非 null | 省略而非 null | ✅ 等价 |
| 窗口声明 | 手工 1,000,000 | 从渠道 `context_length` 自动取到 **1,000,000** | ✅ **实测正确** |
| 用量口径 | `prompt_tokens - cacheRead`（互斥口径） | `splitCachedInput` 同样相减 | ✅ 等价 |

> 关于窗口：我实测过 commandcode 的 `/models`，返回
> `{"id":"deepseek/deepseek-v4.1-flash","context_length":1000000}`，
> 而 `modelStore.parseContextWindow()` 恰好读了 `context_length`（第 231 行）。
> **这条链路是对的**，我原先怀疑「窗口被降级成 200000」是错的，特此更正。

### 6.2 真缺口（值得做，按 ROI 排序）

#### 缺口 1：没有主动压缩，窗口给满 1,000,000 导致长会话滞留高延迟区

DSH：80% 就压，保留 16% 逐字尾部。
插件：把渠道声明的 1,000,000 原样报给 Kiro → Kiro 到 800K 才触发自动摘要。
现实数据：290 次请求落在 200–400K 区间、103 次 >400K，中位总延迟 28s，而 100–200K 只有 12s。

#### 缺口 2：`maxOutputTokens` 报给 Kiro 的值与实际发送的 `max_tokens` 不一致

- `cpsServer.ts:227` → `maxOutputTokens: g.maxOutputTokens || cap?.maxOutputTokens || 64000`
- 实测 commandcode 的 `/models` **不声明**输出上限 → 报给 Kiro 的是 **64,000**
- 但 `openaiTranslate.buildOpenaiRequest` 发的是 `getMaxTokens()`，默认 **32,000**
- 你的 DSH 沙箱对同一渠道同一模型配的是 **384,000**

Kiro 以为能出 64K，实际 32K 就被截断 → `stopReason=MAX_TOKENS` → Kiro 判定
`truncation_suspected` 自动重发续写。**每次多一个来回 ≈ 20 秒**（p50）。
在 20–40 秒的延迟水平下，省一个来回远比值 2% 的缓存。

#### 缺口 3：单次请求内没有对超大工具结果做确定性裁剪

插件把 Kiro 的 tool result 原样透传。Kiro 一次「读整个文件」「跑一条长命令」
就能往上下文里塞进几万 token，而且这会永久留在后续每一轮的 prompt 里。
DSH 的 `8192 / 4096 / 1024 + 固定标记` 方案是可重放、可复现的。
**但注意**：任何裁剪都必须幂等，否则就是自己制造前缀漂移。

#### 缺口 4：`prompt_cache_hit_tokens` 兜底缺失（低成本保险，非当前痛点）

DSH 读的是 `prompt_tokens_details?.cached_tokens ?? prompt_cache_hit_tokens`。
插件只读前者 + `cache_read_input_tokens`。

**实测结论：commandcode 返回 `prompt_tokens_details.cached_tokens`，所以现在不缺。**
我原先判断这是缺口，实测后撤回。但对直连 `api.deepseek.com` 或别的中转站
（snaillmou 余额不足无法实测）仍可能是缺口，补一个 `??` 是零风险的。

#### 缺口 5：`promptCaching` 能力声明是硬编码的「善意的谎」

`cpsServer.ts:219` 对**所有**模型无差别广播：

```js
promptCaching: { maximumCacheCheckpointsPerRequest: 4,
                 minimumTokensPerCacheCheckpoint: 1024,
                 supportsPromptCaching: true }
```

DeepSeek 是**自动前缀缓存**，没有显式断点概念。我核查了 Kiro 的 agent 日志，
**Kiro 并没有真的下发 `cachePoint`**（该日志里出现的 `cachePoint` 全部是我自己
grep 命令文本被记录下来的假阳性，特此撤回我此前的推测）。
所以这个声明目前是**惰性**的。但它是一条潜在的谎：一旦 Kiro 未来据此改变
上下文策略或真的插入断点，DeepSeek 通路就会莫名其妙。
DSH 的做法是只声明真实能力。

### 6.3 我做了实测、结论与直觉相反的部分

我对 commandcode 中转站做了三次真实探针（输出限 1 token，成本可忽略）：

#### (a) 思考回传：**只在带 `tool_calls` 的 assistant 消息上生效**

构造 2130 字符（≈532 token）的推理文本，回传到历史 assistant 消息，看 `prompt_tokens` 变化：

| 场景 | 回传字段 | prompt_tokens |
|---|---|---|
| 普通 assistant 消息 · 基线 | 无 | 42 |
| 普通 assistant 消息 | `reasoning_content` | **42** |
| 普通 assistant 消息 | `reasoning` | **42** |
| 普通 assistant 消息 | `reasoning_details` | **42** |
| **对照组**：同文本塞进 `content` | — | **552** |
| assistant 带 `tool_calls` · 基线 | 无 | 338 |
| assistant 带 `tool_calls` | `reasoning_content` | **729** |
| assistant 带 `tool_calls` | `reasoning` | **729** |
| assistant 带 `tool_calls` | `reasoning_details` | **729** |

**结论**：中转站精确实现了 DeepSeek 的语义——`reasoning_content` 只在工具循环里
才真正进 prompt（+391 token），普通问答轮直接丢弃。三种字段名都被接受。
对照组（552 vs 42）证明测量方法有效、我的 JSON 没有被 shell 引号搞坏。

⇒ 插件的 `wantsReasoningEcho` 逻辑**在真正需要它的场景（工具循环）里是生效的**，
不是空转。但普通轮次上它加的字段会被上游静默丢弃——无害，但也无收益。

#### (b) 流式 delta 的字段名是 `reasoning`，不是 `reasoning_content`

```json
"delta": { "reasoning": "We",
           "reasoning_details": [{"type":"reasoning.text","text":"We","format":"unknown","index":0}] }
```

插件 `handleDelta` 先读 `delta.reasoning_content`、再读 `delta.reasoning` —— **✅ 覆盖到了。**

#### (c) 缓存字段存在，且命中的就是 90.6%

同一个 1554-token 前缀，连打三次：

| 次序 | prompt_tokens | cached_tokens | 命中率 |
|---|---|---|---|
| 第 1 次（冷） | 1554 | 0 | 0% |
| 第 2 次 | 1554 | 1408 | 90.6% |
| 第 3 次 | 1554 | 1408 | 90.6% |

⇒ 插件的 `captureUsage` 读 `prompt_tokens_details.cached_tokens` 是**对的**。

### 6.4 抄不得 / 抄了没用的

| DSH 的做法 | 为什么不能直接搬 |
|---|---|
| `systemPromptUpdate: 'in-history'`（提示词变更追加到尾部） | Kiro 的 `messages[0]` 由 Kiro 决定内容，插件只是翻译器；要模拟得自己维护状态，且模型会同时看到新旧两份提示词，语义变了 |
| `dsh-compaction-basic` 的压缩引擎 | 压缩由 **Kiro 客户端**执行，插件只能上报窗口 + 把超长错误翻成 `CONTENT_LENGTH_EXCEEDS_THRESHOLD` 去**触发**它，无法控制它怎么压 |
| 工具 schema 排序 | Kiro 给的顺序本来就是稳定的（数据上没看到无序导致的失效）。加了排序如果与 Kiro 顺序不同，反而**制造**一次失效 |
| `orderTools` 的 `toolOrder` 配置 | 同上，且在插件侧没有对应的稳定真值来源 |
| `dsh-spill` / `dsh-output-retention` | 是 DSH 的工具层概念；Kiro 的工具产出插件碰不到源头 |

---

## 七、建议（按 ROI 排序）

### 第 0 步：零代码、今天就能做的 A/B（验证第四节的核心假设）

插件已经内置了这个旋钮，不需要改一行代码：

```jsonc
// settings.json
"api2kiroDual.contextWindowOverrides": {
  "deepseek/deepseek-v4.1-flash": 200000
}
```

（或在侧边栏模型页 / Kiro 聊天框的「上下文」下拉里直接选 200K）

**判据**：改之前 / 改之后，各取 ≥100 次成功请求，对比 `firstTokenMs` 与
`latencyMs` 的 p50/p90。数据源就是插件的用量账本（本报告第四节用的那个）。

- 若 TTFT p50 从 ~21s 掉到 ~7s ⇒ 假设成立，这就是最大的那颗果子。
- 若无明显差异 ⇒ 说明 200–400K 的高延迟主要是中转站负载/时段造成的，
  那么本报告第四节的因果链需要重写，而缺口 1 的优先级随之下降。

**代价与风险**：Kiro 的自带压缩是「截断式摘要」，会丢信息；
长会话的连续性会受影响。这不是没成本的优化，需要用 J 型曲线判断。

### 第 1 步：把 `maxTokens` 调到与渠道能力匹配

`api2kiroDual.maxTokens` 默认 32,000，而报给 Kiro 的是 64,000（见 6.2 缺口 2）。
建议先对齐：至少把 `maxTokens` 提到 64,000，消除「Kiro 以为能出 64K、
实际 32K 就断」引起的续写来回。你的 DSH 配置对同一渠道给的是 384,000，
所以上游大概率支持更大的值，但**需要一次实测确认**再往上调。

### 第 2 步：补 `prompt_cache_hit_tokens` 兜底（5 行代码）

```ts
const cached = num(details?.cached_tokens) || num(u.prompt_cache_hit_tokens);
```

对当前渠道无收益，但对直连 DeepSeek / 其他中转站是零风险保险。
注意与 `prompt_cache_miss_tokens` 的口径关系（`prompt = hit + miss`）。

### 第 3 步（需先论证）：确定性裁剪超大工具结果

参照 DSH 的 `8192 / 4096 / 1024 + 固定标记`，但**必须**满足：
- 幂等：同一份原始输入永远产出同一份裁剪结果；
- 无模型参与；
- 只在超过阈值时触发，且标记文本固定。

风险：Kiro 可能依赖完整工具结果（例如 diff 的精确匹配）。
建议先**只做度量**——在账本里记录「若按 8192 阈值裁剪能省多少 token」，
不改行为，观察一两周再决定是否落地。

### 第 4 步（可选）：把 `promptCaching` 声明改成按协议区分

DeepSeek / OpenAI 兼容通路声明 `supportsPromptCaching: true` 但
`maximumCacheCheckpointsPerRequest: 0`；只有 Anthropic 通路才报 4 / 1024。
属于「消除善意谎言」，不影响当前行为。

---

## 八、明确不建议做的事

1. **不要为了刷缓存命中率去改前缀构造逻辑。** 97.7% 到 99% 的收益约等于
   全部输入成本的 1.3%，而任何一次失误造成的失配都是几十万 token 的满价。
2. **不要抄 DSH 的压缩引擎到插件侧。** 那需要插件自己维护会话状态、
   重写 Kiro 的历史，一旦不一致就是静默的上下文丢失。
3. **不要抄 DSH 的工具排序。** 数据上没有证据表明 Kiro 的工具顺序不稳定；
   引入排序只会多一次与 Kiro 原始顺序不一致的失效风险。
4. **不要照搬 DSH 把时间戳注入上下文。** 插件现在**不注入**时间，这是优点，保持它。

---

## 九、本报告的验证状态声明

| 结论 | 证据等级 |
|---|---|
| 缓存命中率 97.6% / 97.7% | **实测**（插件账本 697 条记录） |
| TTFT 随上下文体积 3 倍跳升 | **强相关观察**，有机制解释，有混淆因素未排除 → 见第 0 步 A/B |
| 中转站返回 `prompt_tokens_details.cached_tokens` | **实测**（3 次探针） |
| 中转站只在 `tool_calls` 消息上保留 reasoning 回传 | **实测**（含对照组） |
| 流式字段名是 `reasoning` | **实测** |
| 渠道声明 `context_length` 且插件正确读取 | **实测**（源头 + 代码双向核对） |
| Kiro 下发 `cachePoint` | **已撤回**（日志命中是我自己命令文本的假阳性） |
| 缺 `prompt_cache_hit_tokens` 是当前痛点 | **已撤回**（该渠道不返回此字段） |
| DSH 的各类设计细节 | **源码实证**（`lib/*.js` + README「KV Cache 影响」） |
| `sess_c81865ea` 20:08 那次骤降的成因 | **未确定**，三种候选（改提示词 / 工具列表变化 / 上游负载均衡），需现场复现 |

---

## 十、一句话回答你最初的问题

> 插件能不能参考 DSH 优化 DeepSeek 表现？

**能，但方向要换。** 缓存命中率已经没有空间可优化了（97.7%）；
DSH 真正值得借鉴的是它那套「主动压缩 + 确定性裁剪 + 只追加不重写」的
**上下文纪律**——用在你的场景里，就是**让 Kiro 更早压缩，把工作上下文
压在 200K 以下**，因为 200K 以上每次请求要多等约 15 秒。

DSH 的源码可以作为一份很好的**规范参照**（尤其那 517 处「KV Cache 影响」，
可以直接当 checklist 用），但它不是一个可以直接搬运的实现。

---
---

# 附录 A：改动适用范围核查与第 0 步执行记录

补充日期：2026-09-15 晚 · 仍为只读评估 + 一次用户配置变更

## A1. 回答「是不是所有模型都受益」

结论：**四项建议里没有一项是「所有模型都受益」。** 逐项拆开：

| 建议 | 生效范围 | 谁受益 | 证据 |
|---|---|---|---|
| 下调上下文窗口 | **按模型**（override 是 per-model 的） | **只有 DeepSeek 被证明受益** | 见 A2 的拐点对照 |
| `maxTokens` 对齐 | **全局单一值** | 理论上所有模型，**实测 0 次触发** | 见 A3 |
| `prompt_cache_hit_tokens` 兜底 | 全局代码改动 | 只有「上游用 DeepSeek 原生 usage 形状」的渠道 | commandcode 实测不返回该字段 |
| `promptCaching` 声明 | 全局，按协议分 | **当前对所有模型都零收益**（Kiro 不下发 cachePoint） | 见正文 6.3(c) |

## A2. 拐点是 DeepSeek 独有的（这是最关键的一条）

用同一份账本，取「命中率 ≥95% 的暖请求」，计算
**200–250K 档位的 TTFT ÷ 150–200K 档位的 TTFT**：

| 模型 | 倍数 | 200–250K 样本数 | 判定 |
|---|---|---|---|
| `gpt-5.6-sol` | **1.01x** | 130 | ✓ **完全平坦** |
| `gpt-5.6-terra` | **1.14x** | 33 | ✓ 平坦 |
| **`deepseek/deepseek-v4.1-flash`** | **1.77x** | 144 | ⚠ **明显拐点** |

GPT-5.6-sol 在同一档位有 **130 个样本**，倍数是 1.01 —— 这不是样本量不足造成的假象。

### 为什么 GPT-5.6 进不了悬崖？—— 它的窗口只有 272,000

从**运行中的 CPS 实时查询**（`http://127.0.0.1:19811/listAvailableModels`）拿到的权威值：

| modelId | 报给 Kiro 的 maxInput | 目录输出上限 |
|---|---|---|
| `deepseek/deepseek-v4.1-flash` | **1,000,000** | 384,000 |
| `deepseek/deepseek-v4-pro` | 1,000,000 | 384,000 |
| `deepseek-v4-pro`（snaillmou） | 1,000,000 | 384,000 |
| `deepseek-v4-flash` | 1,000,000 | 384,000 |
| `deepseek-v4-flash-vision-exp` | 1,048,576 | 384,000 |
| `google/gemini-3.8-flash` | 1,000,000 | 65,536 |
| `gemini-3.8-flash-high` | 1,048,576 | 65,536 |
| `glm-5.3` / `glm-5.3-flash` | 1,000,000 | 131,072 |
| `qwen3.8-flash` | 991,808 | 131,072 |
| `grok-4.6` | 500,000 | 450,000 |
| **`gpt-5.6-*` / `gpt-5.5` / `gpt-6-astra`（Codex 订阅口径）** | **272,000** | 128,000 |

**结构性解释**：GPT-5.6 的窗口是 272K，Kiro 在 80%（218K）就压缩，
所以它的上下文 p50 停在 191,472 —— **天然进不了 200K 以上的悬崖区**。
而 DeepSeek 被允许长到 1,000,000，上下文 p50 = **226,332**，**一半以上请求越过了拐点**。

⇒ 换句话说：**GPT-5.6 现在跑得好，不是因为它抗长上下文，而是因为它的窗口小、被强制压缩了。**
这反而印证了「把 DeepSeek 的窗口也压下来」的方向是对的。

> ⚠️ 更正：正文 6.2 之前的静态推断曾把 GPT-5.6 的窗口写成 1,050,000，那是错的。
> 实际 272,000 来自 `codexSubscriptionWindow()` 的订阅口径，只有查运行中的 CPS 才能看到。

## A3. `maxTokens` 的实测结论：结构性不一致，但从未咬到人

我原先把这一条排在推荐第 1 位，理由是「报给 Kiro 64,000 / 实发 32,000」。
**实测数据推翻了这个排序**：

全部 1967 条成功请求的输出 token 分布：

| 指标 | 值 |
|---|---|
| p50 | 401 |
| p90 | 2,095 |
| p99 | 6,040 |
| **max** | **13,334** |
| **落在 31,000–33,000（疑似撞顶）的请求** | **0 次** |

⇒ 2000 次请求里**从来没有一次撞到 32,000 上限**，历史最大输出只有 13,334。
不一致是真的（DeepSeek 报 384,000、实发 32,000，差 12 倍），
但在当前「大量小编工具调用」的使用形态下**没有造成任何可观测损失**。

**因此把这一条从第 1 位降到第 3 位。** 只有在出现「一次性写超长文件」的用法时才需要动它。
真实值（来自 CPS）是 DeepSeek 声明 384,000、GPT-5.6 声明 128,000、Gemini 声明 65,536。

## A4. Gemini 的情况（未能定论）

| 上下文档位 | n | TTFT 中位 |
|---|---|---|
| 100–150K | 11 | 8,745 ms |
| 150–200K | 13 | 10,668 ms |
| 200–400K | **0** | — |
| **600K+** | 16 | **30,589 ms** |

Gemini 在 150–200K 是 10.7s，在 600K+ 是 30.6s，看起来也有 3 倍级的劣化，
但**中间 200–400K 完全没有样本**（请求直接从 ~190K 跳到 600K+），
无法定位拐点，也无法排除是「该档位恰好都落在高负载时段」。
⇒ **暂不把 Gemini 纳入第 0 步**；如果后续样本增多且出现 200–400K 的观测，再单独评估。

## A5. 第 0 步执行记录

### A5.1 新增的只读测量工具

`dev/measure-latency.mjs` —— 从插件账本取数，按模型 × 上下文档位切 TTFT / 总延迟。
纯只读（只 `select` + 解析 JSON），不写插件状态、不改配置。

```bash
node dev/measure-latency.mjs                     # 全部历史
node dev/measure-latency.mjs --model=deepseek    # 只看 DeepSeek
node dev/measure-latency.mjs --since=2026-09-16  # 只看某时刻之后（做 A/B 用这个）
node dev/measure-latency.mjs --json              # 原始 JSON
```

它直接输出「拐点倍数」一行，这就是判定标准。

### A5.2 基线已冻结

```
dev/baselines/before-20260915.json        (11,650 字节)
```

基线（`deepseek/deepseek-v4.1-flash`，739 次请求，命中率 97.9%）：

| 上下文档位 | n | TTFT 中位 | 总延迟中位 |
|---|---|---|---|
| <50K | 3 | 2,820 ms | 8,214 ms |
| 50–100K | 49 | 5,316 ms | 8,279 ms |
| 100–150K | 60 | 6,312 ms | 8,721 ms |
| **150–200K** | **137** | **8,015 ms** | **14,016 ms** |
| **200–250K** | **142** | **14,352 ms** | **20,893 ms** |
| 250–300K | 109 | 16,275 ms | 24,615 ms |
| 300–400K | 101 | 31,592 ms | 36,475 ms |
| 400–600K | 73 | 18,234 ms | 22,662 ms |

整体：TTFT p50 = 14,424 ms / p90 = 33,519 ms；上下文 p50 = 226,332。

### A5.3 已应用的变更

文件：`~/Library/Application Support/Kiro/User/settings.json`（备份在同目录 `.bak-20260915-deepseek-ctx`）

```jsonc
"api2kiroDual.contextWindowOverrides": {
    "deepseek/deepseek-v4.1-flash": 200000,
    "deepseek/deepseek-v4-pro": 200000,
    "deepseek-v4-pro": 200000,
    "deepseek-v4-flash": 200000,
    "deepseek-v4-flash-vision-exp": 200000
},
```

**只改 DeepSeek 的 5 个 model id，其余 12 个模型一字未动** —— 依据是 A2 的拐点对照
（GPT-5.6 平坦 = 压窗口对它只有损失没有收益）。

**已通过运行中的 CPS 验证实时生效**：

```
deepseek/deepseek-v4.1-flash     1,000,000 → 200,000   ✅
deepseek/deepseek-v4-pro         1,000,000 → 200,000   ✅
deepseek-v4-pro                  1,000,000 → 200,000   ✅
deepseek-v4-flash                1,000,000 → 200,000   ✅
deepseek-v4-flash-vision-exp     1,048,576 → 200,000   ✅
gpt-5.6-* / gemini-* / glm-* / qwen / grok            （未变）
```

200,000 意味着 Kiro 在 **160,000（80%）** 触发自动摘要，工作上下文落在
150–200K 档位 —— 也就是基线里 TTFT 8,015 ms 的那一档，而当前 p50 是 226K / 14,424 ms。

### A5.4 回滚方式（一行）

```bash
cp "$HOME/Library/Application Support/Kiro/User/settings.json.bak-20260915-deepseek-ctx" \
   "$HOME/Library/Application Support/Kiro/User/settings.json"
```

或直接在设置里删掉 `api2kiroDual.contextWindowOverrides` 中的对应项。

### A5.5 判定方法

等累积到 **≥100 次新的 DeepSeek 暖请求**（建议一两天正常使用后）再跑：

```bash
node dev/measure-latency.mjs --model=deepseek --since=2026-09-15T13:15:00Z
```

**判定标准**：

| 观测 | 判定 |
|---|---|
| 上下文 p50 从 226K 降到 ~160K，TTFT p50 从 14.4s 降到 ~8s | ✅ 假设成立，保留 |
| 上下文 p50 降了但 TTFT 没降 | ⚠️ 拐点是「时段/负载」造成的，假设被推翻，回滚 |
| 拐点倍数从 1.77x 降到 1.2x 以下 | ✅ 悬崖被绕开 |
| 出现大量失败请求或明显质量退化 | ❌ 立即回滚 |

### A5.6 已知的一次性代价

**已经很大的存量会话会被立即压缩。** 本次会话自身就是一个例子 ——
执行改动时它正跑在 **251K–325K** 区间（账本 21:10–21:12 的 8 条记录，命中率 99.8%，
TTFT 10.9–34.7s）。窗口降到 200K 后，这类会话会在下一次请求触发一次压缩，
**那一次会丢掉最旧的一段上下文**。这是一次性成本，之后每个请求都受益。

如果这次压缩对正在进行的重要工作造成困扰，先回滚，等会话结束再做实验。

## A6. ⚠️ 执行中发现一个会污染本实验的真实缺陷

### A6.1 现象：改动已生效，但上下文不降反升

- 21:21:01 Kiro **确实重新拉取了**模型列表（`network.listAvailableModels.ok`，节奏约每 10 分钟一次）
- 之后 6 分钟、7 次 DeepSeek 请求，上下文仍从 **349K 涨到 354K**，没有任何压缩
- 命中率保持 99.9%（除了 21:22:02 那次 5.9% 的骤降）

### A6.2 根因：插件同时向 Kiro 报了两个互相矛盾的窗口值

存在**两个同名函数** `contextWindowForModel`，取值来源不同：

| 路径 | 实现 | 是否读 `contextWindowOverrides` |
|---|---|---|
| **CPS 声明**<br>`listAvailableModels.tokenLimits.maxInputTokens` | `cpsServer.ts:202` → `resolveContextWindow({...}, getContextWindowOverride(kiroIds[gi]))` | ✅ **读了** → 报 200,000 |
| **流式占用百分比**<br>`contextUsageEvent.contextUsagePercentage` | `streamShared.ts:69` → `modelStore.ts:726` → `mergedCache[].contextWindow` | ❌ **没读** → 按 1,000,000 算 |

证据链（全部来自源码）：

```ts
// streamShared.ts:2
import { contextWindowForModel as relayContextWindow } from "./modelStore";

// streamShared.ts:69 —— 只问 relay 和名字启发式，不问用户覆盖
export function contextWindowForModel(modelId: string): number {
  const fromRelay = relayContextWindow(modelId);   // → modelStore → mergedCache（1,000,000）
  if (fromRelay && fromRelay > 0) return fromRelay;
  ...
}

// streamShared.ts:~102 —— 占用百分比就用这个窗口
export function contextUsagePercentFloat(tokens: number, modelId: string): number | null {
  const window = contextWindowForModel(modelId);
  return Math.max(0, Math.min(100, (tokens / window) * 100));
}
```

**后果**：对当前这个 354K 的会话，插件告诉 Kiro 的是

- 「窗口是 **200,000**」（CPS）
- 「已用 **35.4%**」（`354098 / 1000000`）

两个数放在一起是自相矛盾的（按 200K 算应该是 177%）。Kiro 的上下文进度条现在应当显示约 35%，
而不是接近满格。

### A6.3 这让第 0 步的 A/B 无法干净地跑完

有两个候选原因，**目前无法区分**：

| 候选 | 含义 | 需要的动作 |
|---|---|---|
| (a) Kiro 用 `contextUsagePercentage` 驱动压缩/截断 | 覆盖永远不会生效，除非修 A6.2 的两行 | **改源码**（2 行） |
| (b) Kiro 在会话创建时绑定 `tokenLimits`，不中途刷新 | 存量会话无效，新会话有效 | **开一个新会话** |

### A6.4 建议的下一步（需要你决定，我没有动插件源码）

1. **先做一个 5 秒的目视检查**：现在这个会话的上下文进度条显示的是 ~35% 还是接近满？
   - 显示 ~35% ⇒ 候选 (a) 成立，即插件在发矛盾数据，**必须修**
   - 显示接近满 / 显示 200K 口径 ⇒ 候选 (b)，只需开新会话
2. 若确认 (a)，修法是让两条路径共用同一个 `resolveContextWindow`，
   即 `contextUsagePercentFloat` 也接受 `getContextWindowOverride(modelId)`。
   这是约 2 行的改动，但属于**插件源码变更**，超出你授权的「第 0 步」范围，等你点头。
3. 无论 (a)/(b)，**A/B 的样本都不要用当前这个存量大会话** ——
   它已被 1,000,000 的窗口养到 354K。请在**新会话**里采集「后」数据。

### A6.5 此刻的状态

| 项 | 状态 |
|---|---|
| `dev/measure-latency.mjs` | 已就绪，只读 |
| 基线 `dev/baselines/before-20260915.json` | 已冻结 |
| settings.json 覆盖（5 个 DeepSeek id → 200000） | **已生效**（CPS 实测确认） |
| settings.json 备份 | `settings.json.bak-20260915-deepseek-ctx` |
| 插件源码 | **一字未改** |
| 实验是否可判定 | ❌ 暂时不能，被 A6.2 阻塞 |

---

# 附录 B：第 0 步被证伪 —— 真正的杠杆不在窗口

补充日期：2026-09-15 晚（同一次会话）· 只读分析

## B1. 你的观察确认了 A6 的诊断

进度条显示 **28%**。对照账本：最近 6 次 DeepSeek 请求的上下文是 272K–357K，

| 上下文 | ÷ 1,000,000 | ÷ 200,000 |
|---|---|---|
| 272,198 | **27.2%** | 100% |
| 277,943 | **27.8%** | 100% |

⇒ **28% 出自「÷1,000,000」那一列**，即 `contextUsagePercentFloat` 那条忽略覆盖的路径。
A6 的诊断成立。

## B2. 但继续追下去，发现一个更根本的事实：窗口信号根本不驱动压缩

如果 `cpsServer.ts:198` 那句注释是对的
（「Kiro 按 maxInputTokens 算百分比与 80% / 95% 阈值——这里报多少，Kiro 就在多少处压缩」），
那么 **`gpt-5.6-*` 就是一个天然实验**：它的声明窗口是 272,000，
而 Kiro 在 80%（217,600）就该压缩。

实测（账本 2000 条，09-11 ~ 09-15）：

| 模型 | 声明窗口 | p50 | max | 超 80% 的请求 | 超 95% | **超 100%** |
|---|---|---|---|---|---|---|
| `gpt-5.6-sol` | 272,000 | 190,504 | **355,034** | 430 | 305 | **256** |
| `gpt-5.6-luna` | 272,000 | 328,547 | 343,489 | 32 | 32 | **32** |
| `gpt-5.6-terra` | 272,000 | 196,463 | 231,802 | 6 | 0 | 0 |
| `deepseek/deepseek-v4.1-flash` | 1,000,000 | 233,092 | 535,248 | 0 | 0 | 0 |

**gpt-5.6 有 256 次请求超过了声明窗口的 100%，最高到 130%，却从未被压缩。**

三个高频会话的完整轨迹（单调爬升，无任何回落）：

| 会话 | 轨迹 |
|---|---|
| `sess_d4ed281a` | 227K → 285K（超 272K）→ 上游报错 → 286K → … → **355K** |
| `sess_911711e8` | 119K → … → **348K**（09-14 一整夜） |
| `sess_69c846dd` | 60K → … → **339K**（09-13 全天） |

并且在整个 2000 条记录里，**检测不到任何一次 Kiro 自动压缩**——
唯一两次「大幅回落」经核查是会话失败（403）与请求失败，不是压缩。

⇒ **结论：`cpsServer.ts:198` 那条注释是实证错误的。**
⇒ **`contextWindowOverrides`（4.13.55 引进）从未对压缩生效过**，它只改变了模型选择器里的元数据。
⇒ 因此**附录 A 的第 0 步设计是错的**：调低窗口不会让 Kiro 提前压缩。这一点由你自己环境里的
`gpt-5.6` 数据直接否证，无需再跑 A/B。

## B3. 那么真正的杠杆在哪？—— 插件手里已经有了

`src/contextOverflow.ts` 的文件头注释（作者逆向到 offset 级别）：

> Kiro 1.0.437 的**被动恢复性压缩**只在异常被判定为「上下文溢出」时才走：
> `ValidationException` 且 `reason === "CONTENT_LENGTH_EXCEEDS_THRESHOLD"` …… → `WLl`：
> `u4` 为真 → **截断式摘要 → 重置上下文** → 下一轮继续。

而 `contextOverflowException()` **已经能构造这个异常**：

```ts
{
  exceptionType: "ValidationException",
  payload: { message: "Input is too long. Upstream 400: …",
             reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" }
}
```

**关键差别在于它是「被动」的**：现在只在**上游返回 400/413/422 且文案像上下文超长**时才发
（`looksLikeContextOverflow` 要求状态码 ∈ {400,413,422}）。
而 DeepSeek 走 commandcode 时上游接受了最高 **535K** token —— 上游根本不报错，
所以这条恢复路径**永远不触发**，上下文就无限长下去。

⇒ **唯一能真正把 DeepSeek 压回 200K 以下的做法，是把这条信号从「被动」改成「主动」**：
插件在派发前自己发现 prompt 超过阈值，就**直接抛出那个 Kiro 认得的异常**，
让 Kiro 走它自己的截断式摘要。

这是可行的、也是唯一可行的路径，因为：

- 窗口声明（CPS `maxInputTokens`）—— **不驱动压缩**（B2 已证伪）
- 占用百分比（`contextUsageEvent`）—— **不驱动压缩**（gpt-5.6 到 130% 也没动）
- 主动溢出异常 —— **Kiro 唯一认得的信号**，且有 `WLl` 的完整行为描述

代价与注意：

1. 会**主动触发** Kiro 的截断式摘要 —— 丢上下文是设计的一部分，不是 bug；
   这正是「省 15 秒 TTFT」要付的价。
2. 需要新增一个设置项（阈值、开关），默认应**关闭**。
3. Kiro 侧若 `disableAutoCompaction` 为真，会变成「要求手动压缩」而不是自动压缩 ——
   需要确认你环境里它是怎么配的（你的 settings.json 里没有显式禁用项）。
4. 顺带：`CONTEXT_OVERFLOW_USER_HINT` 那句
   「请新开会话或在侧边栏模型页把该模型的『上下文』挡位调低」
   **现在是误导性的** —— 按 B2，调低挡位不会让 Kiro 压缩。

## B4. 回到你的问题：修那两行是 bug，还是收益？

| 问题 | 答案 |
|---|---|
| 是 bug 吗？ | **是。** 插件对同一个模型同时报 200,000（CPS）和「按 1,000,000 算的 28%」，这两者自相矛盾，而且用户能在进度条上看到错的那个。 |
| 修了有收益吗？ | **没有。** 因为它所服务的那条路径（窗口 → Kiro 压缩）**本来就不通**。修完进度条会从 28% 变成 100%，然后 Kiro 仍然什么都不做 —— 只是把一个错误显示成一个更准确但更令人困惑的显示。 |
| 该不该修？ | **该修，但定级为「显示/一致性 bug」，不是性能优化。** 顺手应该一起改掉 `cpsServer.ts:198` 那条实证错误的注释，否则下一个人还会照它做设计。 |
| 真正的性能项是什么？ | **B3 的「主动溢出信号」** —— 那是一个新功能，不是 2 行改动。 |

## B5. 此刻的状态与建议

| 项 | 状态 / 建议 |
|---|---|
| settings.json 里的 200,000 覆盖 | **已生效但惰性无害**。它不驱动压缩，只影响选择器元数据。**建议回滚**（因为 A6.4 已确认它达不到目的），或保留作为「元数据诚实」用。 |
| `dev/measure-latency.mjs` + 基线 | 保留 —— 它对评估 B3 的新功能同样有用（可以直接对比启用前后的 TTFT 分布） |
| 报告正文的「缺口 1」 | **需重写**：杠杆不是「下调窗口」，而是「主动溢出信号」 |
| 第 0 步 A/B | **应当终止**，前提已被否证 |

---

# 附录 C：修正执行记录（2026-09-15 晚）

按附录 B5 的建议执行了 (a) 修 bug + 纠正错误文档、(c) 回滚覆盖。
(b)「主动溢出信号」按计划**只出设计、未实现**。

## C1. 代码修正

| 文件 | 改动 |
|---|---|
| `src/streamShared.ts` | `contextWindowForModel` 现在**优先读 `getContextWindowOverride(modelId)`**，使占用百分比与 CPS 声明的 `maxInputTokens` 同口径。重写 doc 注释，显式标注「此值只决定进度条显示，不驱动压缩」，并指向附录 B2。 |
| `src/cpsServer.ts` | 把被证伪的注释（「Kiro 按 maxInputTokens 算百分比与 80% / 95% 阈值——这里报多少，Kiro 就在多少处压缩」）替换为带证据的实证更正块：gpt-5.6-sol 256 次请求超声明窗口、最高 355,034（130%）、零压缩；并明确该值真实作用只有「挡位展示 + 百分比基准」两条。 |
| `src/contextOverflow.ts` | 删除 `CONTEXT_OVERFLOW_USER_HINT` 里无效的建议「在侧边栏模型页把该模型的「上下文」挡位调低」，改为「新开会话」，并显式说明调低挡位无效。补 doc 注释说明改动理由。 |
| `src/contextWindow.ts` | 头部「Kiro 据此算 80% / 95% 阈值与百分比」替换为实证更正。 |
| `src/sidebar.ts` | 两处**用户可见文案**改准确：上下文卡的 hint、每行「上下文」下拉的 `sel.title`。一处注释同步。 |

## C2. 文档修正（同一句错误说法共 7 处）

`package.json`（设置项 description）、`docs/CONFIGURATION.md`（**由 `scripts/gen-config-doc.js`
从 package.json 生成，已重新生成**，版本 v4.13.61）、`README.md`。

`docs/ARCHITECTURE.md` 与 `docs/SECURITY-MODEL.md` 的表述**本来就是准确的**（它们说的是
「上游超长时回 Kiro ValidationException 触发**被动**压缩」），未改。

`package.json` 版本 `4.13.60 → 4.13.61`；diff 仅 2 行，无整体重排。

## C3. 验证

| 项 | 结果 |
|---|---|
| `npm run compile`（`tsc --noEmit`） | **退出码 0**，无诊断错误 |
| `npm run bundle`（esbuild） | 成功；`dist/` 已被 `.gitignore` 忽略，不污染仓库 |
| 产物含核心修复 | ✅ `function contextWindowForModel2(modelId){ const override=getContextWindowOverride(modelId); if(override&&override>0) return override; … }` |
| 产物含 6 条新文案 | ✅ 全部命中 |
| 产物已移除 5 条旧文案 | ✅ 全部未命中 |
| 全仓 grep 残留错误说法 | 0 处 |

> **产物核对的方法学坑**（值得记一笔）：esbuild 输出是「原始字符 + `\uXXXX` **大写**转义」
> 的混合形态，且会剥离注释。直接 `grep` 中文会得到**假阴性**。
> 正确做法是先把产物里所有 `\uXXXX` 全局解码，再搜索。

## C4. 覆盖回滚

`settings.json` 的 `api2kiroDual.contextWindowOverrides` 已移除，JSON 合法，
`globalState` 中无 `fallback.*` 兜底副本。经运行中的 CPS 确认：

| modelId | 原始 | 有覆盖 | 回滚后 |
|---|---|---|---|
| `deepseek/deepseek-v4.1-flash` | 1,000,000 | 200,000 | **1,000,000** ✅ |
| `deepseek/deepseek-v4-pro` | 1,000,000 | 200,000 | **1,000,000** ✅ |
| `deepseek-v4-pro` | 1,000,000 | 200,000 | **1,000,000** ✅ |
| `deepseek-v4-flash` | 1,000,000 | 200,000 | **1,000,000** ✅ |
| `deepseek-v4-flash-vision-exp` | 1,048,576 | 200,000 | **1,048,576** ✅ |

备份 `settings.json.bak-20260915-deepseek-ctx` 保留（= 实验前状态）。

## C5. ⚠️ 本次修正尚未生效

**已安装并运行中的扩展仍是 `4.13.60`（bundle 时间 09-15 20:05），早于本次改动。**
源码修正要生效需要 `npm run package` 重新打 vsix 再安装 —— 那是**发布动作，本次未执行**。

因此当前运行行为与修正前完全一致（唯一差别是我把实验用的覆盖回滚了，回到了原始状态）。

## C6. 结论变更汇总

| 附录 A/B 里的说法 | 现在的状态 |
|---|---|
| 缺口 1「下调上下文窗口可让 Kiro 提前压缩」 | ❌ **已推翻**，并已从所有文档中移除 |
| 缺口 2「`maxTokens` 不一致」排第 1 | ❌ 降级 —— 1967 次请求里 0 次撞 32,000 上限 |
| 上下文窗口两处口径不一致 | ✅ **已修**（定级：显示一致性 bug，非性能优化） |
| 真正的性能杠杆 | 🔄 **改为**：主动溢出信号 → 见 [2026-09-15-proactive-compaction-proposal.md](./2026-09-15-proactive-compaction-proposal.md) |
| 缓存命中率 | ⏸ 维持原判：97.7%，**无空间**，不必再优化 |
| Gemini 是否有拐点 | ⏸ 数据不足，200–400K 无样本，未定论 |

---
---

# 附录 D：附录 B 的结论是错的 —— 撤回与更正

日期：2026-09-15 深夜 · 本轮包含代码修复，已通过编译与产物核对

## D1. 结论：附录 B2 的「窗口不驱动压缩」是错误推断

**附录 B2 断言**：`cpsServer.ts:198` 那句「Kiro 按 maxInputTokens 算百分比与 80% / 95% 阈值——这里报多少，
Kiro 就在多少处压缩」是实证错误的；进而推断 `contextWindowOverrides` 从未对压缩生效过。

**实际情况**：**那句话是对的。** 我错了，而且把这个错误结论写进了 7 处文件（含用户可见文案）。

## D2. 决定性证据：Kiro 自己的 bundle

`/Applications/Kiro.app/Contents/Resources/app/extensions/kiro.kiro-agent/dist/extension.js`（12.6 MB）：

```js
function Oxo(t){
  return t >= 95 ? {type:"truncate", reason:"critical_overflow", projectedUsage:t}
       : t >= 80 ? {type:"summarize", reason:"high_usage",   projectedUsage:t}
       :           {type:"proceed",  reason:"usage_ok"};
}

function KJl(t){                                  // SummarizationDetectionNode
  let e = t.context.getPendingToolResponseMessage() !== void 0;
  if (t.execution.sessionServices.disableAutoCompaction) return …{SummarizationDisabled:1}…;
  if (!t.contextUsagePercentage || t.needsSummarization || t.summarizationComplete || …) return …;
  let r = t.contextUsagePercentage;               // ← 就用这个值
  … // 若有 pending tool 响应，用 Pxo(当前%, 文本, modelId, maxInputTokens) 做投影
  let n = Oxo(r ?? 0);
  return n.type === "truncate"  ? {shouldSummarize:!0, shouldTruncate:!0, …}
       : n.type === "summarize" ? {shouldSummarize:!0, shouldTruncate:!1, …}
       : {summarizationResult:void 0};
}
```

而事件解析处把插件发的 `contextUsageEvent` 直接映射过去：

```js
let p = rF(e.contextUsageEvent);
p && typeof p.contextUsagePercentage === "number"
  && r.push({ kind:"context_usage", contextUsagePercentage: p.contextUsagePercentage });
```

⇒ **插件上报的百分比就是 Kiro 的压缩判据，阈值 80% / 95%。**
`disableAutoCompaction` 在本机 211 个会话里全为 `false`，没有把它关掉。

## D3. 我为什么会得出错误结论：一个混淆因素

我用 `gpt-5.6` 当「天然实验」（它声明 272K 却跑到 355K）。但 gpt-5.6 恰好是**唯一存在窗口口径分歧**的模型：

| 模型 | CPS 声明的窗口 | 百分比路径用的窗口 | 倍数 |
|---|---|---|---|
| `deepseek/*`、`glm-5.3*`、`qwen3.8-flash`、`grok-4.6` | 1,000,000 等 | 完全相同 | ×1.00 |
| `gemini-3.8-flash` | 1,000,000 | 完全相同 | ×1.00 |
| **`gpt-5.6-sol/terra/luna`、`gpt-5.5`、`gpt-6-astra`** | **272,000** | **1,050,000**（models.dev 目录值） | **×3.86** |

于是：

| 模型 | 实测峰值上下文 | CPS 口径 % | 百分比路径 % | 是否该压缩 |
|---|---|---|---|---|
| `deepseek/deepseek-v4.1-flash` | 535,248 | 53.5% | **53.5%** | 否（未达 80%）✅ 正确 |
| `gemini-3.8-flash` | 608,483 | 60.8% | **60.8%** | 否 ✅ 正确 |
| `gpt-5.6-sol` | 355,034 | 130.5% | **33.8%** | 否 ← 这里不对 |

**数据其实完全自洽。** DeepSeek 峰值 535K ÷ 1M = 53.5%，本来就低于 80% 阈值 ——
**不压缩是正确的行为，不是异常**。而 gpt-5.6 不压缩是因为它的百分比被算错了。

我把「一个被算错的百分比」当成了「窗口不驱动压缩」的证据，这是**把一个 bug 误读成了机制**。

> 教训：用「天然实验」做因果推断时，必须先确认实验组与对照组在该变量上**没有被别的因素污染**。
> 我当时只核对了 CPS 的值，没有核对百分比路径的值。

## D4. 真正的根因：两个同名函数，只有一条走完整的来源链

| 路径 | 取值逻辑 | override | vendor | Codex 订阅口径 |
|---|---|---|---|---|
| `cpsServer`（广播 `maxInputTokens`） | `resolveContextWindow(...)` 完整四级链 | ✅ | ✅ | ✅ |
| 侧边栏「上下文」下拉 | `contextWindowRows()` — 同一套链 | ✅ | ✅ | ✅ |
| **流式占用百分比**（`streamShared`） | `modelStore.contextWindowForModel(id)` → 只查 `mergedCache` + models.dev | ❌ | ❌ | ❌ |

第三个是异类，指标签还叫 `relayContextWindow`（"relay 窗口"），看不出它漏了三级来源。

**后果**：Codex 系模型少报 3.86 倍 → 进度条永远偏低 → 到不了 80% → **永不压缩、上下文无界增长**。
这是「DeepSeek 太慢」的孪生问题，只是发生在别的模型上，且更严重（实测到 130% 的声明窗口）。

## D5. 已实施的修复（4.13.61）

| 文件 | 改动 |
|---|---|
| `src/modelStore.ts` | 新增 `resolveWindowForGroup(g, kiroId)` —— **生效窗口的唯一来源**；`contextWindowRows()` 改用它；新增 `effectiveContextWindowFor(kiroModelId)`；**删除**重复的 `contextWindowForModel(id)` |
| `src/cpsServer.ts` | 改为调用 `resolveWindowForGroup`，不再自带一份来源组装 |
| `src/streamShared.ts` | 改用 `effectiveContextWindowFor`；原包装改名 `fallbackContextWindowFor` 并取消导出（纯兜底） |
| `src/contextWindow.ts` / `contextOverflow.ts` / `sidebar.ts` / `package.json` / `README.md` | 撤回错误结论、恢复被我误删的**正确**建议（「把该模型上下文挡位调低」是有效的）、补上真正的机制说明 |

三条消费路径现在同源。编译 `tsc --noEmit` 通过，产物核对通过，vsix 已生成
（`api2kiro-dual-4.13.61.vsix`，244 文件）。

## D6. 对原计划的影响

| 原计划项 | 现在的状态 |
|---|---|
| 「缺口 1：下调窗口可让 Kiro 提前压缩」 | ✅ **恢复有效** —— 这就是正确的杠杆，我中途误判为无效 |
| 第 0 步 A/B（override → 200K） | ✅ **恢复有效**，但必须**先装 4.13.61**，否则百分比路径仍读不到 override |
| 「主动溢出信号」提案 | ⬇️ **降级为兜底**。Kiro 原生路径已足够（占比到 80% 自动摘要），无需插件主动抛异常 —— 也就没有死锁风险。见提案文档头部的状态说明 |
| 缓存命中率 | ⏸ 维持原判：97.7%，无空间 |
| 真实性能杠杆 | ✅ **生效窗口**（决定 Kiro 何时压缩）+ **避免长会话滞留在 200K+**（DeepSeek 的 TTFT 拐点） |

## D7. 对被错误修改的用户可见文案的处置

| 位置 | 原文（正确） | 现在的处置 |
|---|---|---|
| `CONTEXT_OVERFLOW_USER_HINT` | 「…请新开会话或在侧边栏模型页把该模型的「上下文」挡位调低」 | ✅ **已恢复原文** |
| `sidebar.ts` 上下文卡提示 | 「Kiro 按每个模型报出的窗口算用量百分比：≥ 80% 自动摘要、≥ 95% 截断。」 | ✅ 已恢复，并加了一句「所以调低窗口就会让 Kiro 更早压缩」 |
| `sidebar.ts` 下拉 `sel.title` | 「…到 80% 自动摘要、95% 截断；上游拒收长输入时选小一档…」 | ✅ **已恢复原文** |
| `package.json` 设置项描述 | 「…可让 Kiro 提前压缩而不是撞 400」 | ✅ **已恢复原文**（`docs/CONFIGURATION.md` 已重新生成） |
| `README.md` 上下文挡位条目 | 「选小一档后 Kiro 按新窗口算 80% / 95% 压缩阈值」 | ✅ 已恢复，并补了「4.13.61 修口径分歧」一条 |

## D8. 附录 B2 / B3 / B5、附录 C 的效力

- **附录 B2**（窗口不驱动压缩）：❌ **作废**，见本附录。
- **附录 B3**（主动溢出信号是唯一杠杆）：❌ **作废** —— 杠杆是生效窗口，不是异常帧。
- **附录 B5**（第 0 步应当终止）：❌ **作废** —— 第 0 步应当继续，只是要等 4.13.61 装好。
- **附录 C**（4.13.60 那次「修复」）：🔄 **已重做**。当时改的 7 处文案方向是错的（把正确信息改错），
  代码改动也只是点补丁（只补 override，漏了 vendor / Codex）。本轮换成修根因。

---

# 附录 E：安装与 A/B 执行说明

交付物：`api2kiro-dual-4.13.61.vsix`（930 KB，244 文件）—— **已生成，未安装**。

## E1. 装之前必须知道的两件事

### ① 4.13.61 会改变 Codex 系模型的行为（无需你设任何东西）

修口径分歧之后，Codex 系模型的占用百分比会从「÷1,050,000」变成「÷272,000」。
这意味着它们的**进度条读数会跳大约 3.86 倍**，并且**会开始压缩**：

| 模型 | 之前 | 装后 |
|---|---|---|
| `gpt-5.6-sol` 等 | 355K 时进度条显示 33.8%，永不压缩，上下文无界增长 | 355K 时显示 130%（截断为 100%），**在 218K 处开始摘要** |
| `deepseek/*`、`gemini-3.8-flash`、`glm-5.3*` 等 | 无变化 | **无变化**（这些模型两条路径本来就一致） |

这是**修 bug 的必然结果**，不是回归。但如果你已经习惯了 Codex 会话「能一直跑不压缩」，
装后会看到它开始裁剪上下文。想保持原状就设 `api2kiroDual.contextWindowOverrides` 把对应模型调回大窗口。

### ② 本机的打包命令会卡住

`npm run package` 里的 `npx @vscode/vsce` 在本机会挂起（15 分钟无进展，我遇到过）。
绕开方式（用 npx 缓存里已有的 vsce 4.0.0）：

```bash
node "$HOME/.npm/_npx/66fbc91407e86cd3/node_modules/.bin/vsce" package \
  --allow-star-activation --skip-license --allow-missing-repository --no-dependencies
```

## E2. 安装

```bash
# 方式一：Kiro 命令面板 → "Extensions: Install from VSIX..." → 选 api2kiro-dual-4.13.61.vsix
# 方式二（CLI）：
"/Applications/Kiro.app/Contents/Resources/app/bin/kiro" \
  --install-extension ./api2kiro-dual-4.13.61.vsix   # 在仓库根目录执行
```

装完**重载窗口**（`Developer: Reload Window`）。

### 装完先做这两个核对

1. **版本**：插件 OutputChannel「API4Kiro」里应出现 `activating, version 4.13.61`。
2. **口径已收敛**：`curl -s http://127.0.0.1:19811/listAvailableModels` 里
   DeepSeek 的 `maxInputTokens` 应仍是 `1,000,000`（没有覆盖时），
   但**进度条读数**对同一上下文应与之一致（下面 E3 第一步会直接验证）。

## E3. A/B 执行

### 第 1 步：确认修复真的生效（1 分钟）

先不设覆盖，在一个 DeepSeek 会话里看进度条。此时窗口 = 1,000,000，所以
**进度条读数应该 ≈ 上下文 / 1M**（与修复前相同，因为无覆盖时两条路径本来就一致）。
这一步只是确认没坏。

### 第 2 步：设覆盖（这才是有行为变化的一步）

```jsonc
"api2kiroDual.contextWindowOverrides": {
    "deepseek/deepseek-v4.1-flash": 200000,
    "deepseek/deepseek-v4-pro": 200000,
    "deepseek-v4-pro": 200000,
    "deepseek-v4-flash": 200000,
    "deepseek-v4-flash-vision-exp": 200000
}
```
（或直接在侧边栏模型页每行的「上下文」下拉里选 200K）

**立即验证点**：同一个 DeepSeek 会话的进度条读数应立刻改变 —— 它从「÷1,000,000」变成「÷200,000」。
例如上下文 280K 时：修复前显示 **28%**，设了覆盖后应显示 **100%**（140% 被截断到 100%）。
160K 时显示 80%。**如果读数没变，说明修复没生效，不要继续**，回头查插件版本与
`modelStore.effectiveContextWindowFor` 是否被编进 bundle。

预期行为：上下文长到 **160,000** 时 Kiro 触发摘要，到 **190,000** 触发截断。
工作上下文会稳定在 150–200K 档（基线 TTFT 8.0s），而不再是 226K p50（14.4s）。

**记下设置生效的准确时刻**，后面 `--since` 要用它。

### 第 3 步：正常使用 1–2 天，累积 ≥100 次暖请求

### 第 4 步：判定

```bash
node dev/measure-latency.mjs --model=deepseek --since=<设置生效时刻，ISO 格式>
```

> ⚠️ **账本是 2000 条环形缓冲**，所以 `dev/baselines/*.json` 是**时点快照**，会随使用而滚动。
> 本文早前引用的「上下文 p50 = 226,332 / TTFT p50 = 14,424ms / 拐点 1.77×」是 21:09 那次冻结的记录，
> 属于「分析当时」的历史值（§A5.2、§B、§D3 引用它们作为叙述依据，保留）。
> **做 A/B 请以「安装前重新快照」为准**，不要拿旧快照当基线：

```bash
# 安装 4.13.61 之前先快照一次（会覆盖，或改名留存）
node dev/measure-latency.mjs --model=deepseek --json > dev/baselines/before-<日期>.json
```

参考：仓库里现存的那份快照（23:20 生成）里 DeepSeek 是
n=978、命中率 98.0%、上下文 p50 = 259,250、TTFT p50 = 16,215ms、拐点 **1.73×**。

| 指标 | 目标 | 说明 |
|---|---|---|
| 上下文 p50 | **< 170,000** | 落到 150–200K 档（该档 TTFT 约 8.0s） |
| 拐点倍数（200–250K ÷ 150–200K 的 TTFT） | **≤ 1.3×** | 基线是 1.73–1.77×，降下来说明绕开了悬崖 |
| 200K 以上请求占比 | **< 10%** | 基线约 50% |
| TTFT p50 | **< 9,000 ms** | 基线 14,400–16,200ms |
| 失败率 | 不上升 | 基线 1.3% |

工具会直接打印「拐点倍数」那一行。

### 第 5 步：判断

| 观测 | 结论 |
|---|---|
| 上下文 p50 降到 ~160K，TTFT p50 降到 ~8s | ✅ 成立，保留 |
| 进度条读数变了但上下文不降 | ⚠️ Kiro 侧的压缩没触发（阈值/保留比例），把 `disableAutoCompaction` 与摘要后的回落幅度查清楚 |
| 完全没变化 | ❌ 修复没生效，回滚 |

## E4. 回滚

```bash
# 删掉 contextWindowOverrides 里的对应项即可；或整段移除
```

行为立即回到「窗口 = 渠道声明值」。**没有需要清理的状态。**
注意：Codex 系的百分比修正（E1①）是代码修复，回滚设置项不会撤销它 —— 要撤销需装回 4.13.60。

## E5. 仍未验证的事项（诚实清单）

| 项 | 状态 |
|---|---|
| 修复后 Kiro 是否真的在 160K 触发摘要 | **未验证** —— 这正是 E3 要测的 |
| Kiro 摘要后的保留比例（决定下一次压缩间隔） | **未验证** |
| Kiro 的摘要请求是否也走本插件 | **未验证**（原提案的阻塞未知项，已因降级而不再是阻塞） |
| `gemini-3.8-flash-high` 的 1,048,576 来自哪一级来源 | **未查清** —— models.dev 与 `vendors.ts` 都没有它的精确条目 |
| Codex 模型开始压缩后对使用体验的影响 | **未观察** |
