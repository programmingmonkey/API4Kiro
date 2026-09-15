# 设计提案：主动溢出信号（proactive context compaction）

## 🔻 状态：已降级为兜底方案，暂不实施（2026-09-15 深夜更新）

**不要按本提案实施。** 本提案的前提（「Kiro 不响应窗口/百分比，只有溢出异常能让它压缩」）
已在[附录 D](./2026-09-15-dsh-vs-api2kiro-deepseek-assessment.md) 中**被推翻** ——
那是基于一份有混淆因素的数据得出的错误结论。

实际情况：Kiro 的 `SummarizationDetectionNode` **就是**按插件上报的
`contextUsageEvent.contextUsagePercentage` 在 **80%（摘要）/ 95%（截断）** 触发压缩。
所以主路径是：

1. 让「生效窗口」只有**一个来源**（4.13.61 已修：`modelStore.resolveWindowForGroup`）；
2. 把该模型的窗口调到你想要的档位（`api2kiroDual.contextWindowOverrides`）；
3. Kiro 自己就会在 80% 处压缩 —— 原生、用户可见、**没有死锁风险**。

本提案仅在这些情况下才值得重新考虑（届时需重新论证）：Kiro 原生压缩的**保留比例**不合适、
或它压完之后仍高于拐点、或需要按「绝对 token 数」而不是「窗口百分比」来控阈值。

下面的内容保留作为兜底方案的设计存档。若要实施，第 3 节（防死锁）与第 6 节（阻塞未知项）
仍然是最关键的部分 —— 尤其「Kiro 的摘要请求是否也走本插件」这一条，**至今仍未实测**。

---

状态：**仅设计，未实现** — 等待批准（⚠️ 见上方的降级说明）
日期：2026-09-15
前置证据：[2026-09-15-dsh-vs-api2kiro-deepseek-assessment.md](./2026-09-15-dsh-vs-api2kiro-deepseek-assessment.md) ——
⚠️ 原引「附录 B」，该附录已作废，请改读**附录 D**

---

## 0. 目标与非目标

### 目标
让**工作上下文稳定停在阈值以下**（默认按生效窗口的 80%），使请求落进低延迟档位。

实测依据（DeepSeek，命中率 ≥95% 的暖请求）：

| 上下文档位 | n | TTFT 中位 |
|---|---|---|
| 100–150K | 60 | 6,266 ms |
| 150–200K | 137 | 8,015 ms |
| **200–250K** | 142 | **14,352 ms** |
| 250–300K | 109 | 16,275 ms |
| 300–400K | 101 | 31,592 ms |

拐点在 200K：**150–200K → 200–250K 的 TTFT 倍数是 1.77×**，而同期
`gpt-5.6-sol` 在同一档位是 **1.01×**（130 个样本）。这是 DeepSeek 特有的行为。

### 非目标
- **不是**提高缓存命中率。DeepSeek 当前已是 97.7%，从 97.7% 挤到 99% 只值约 1.3% 的输入成本。
- **不是**修 `contextWindowOverrides`。~~那个功能的作用已在附录 B2 里被限定为「挡位展示 + 用量百分比基准」，不能用来触发压缩。~~
  **更正**：调低生效窗口**确实**会让 Kiro 更早压缩（Kiro 按占用百分比在 80% 摘要、95% 截断），
  所以「调窗口」才是主路径，本提案反而只是兜底。原判断基于已作废的附录 B2。

---

## 1. 唯一可用的机制

Kiro 的被动恢复性压缩路径（作者已逆向到 Kiro 1.0.437 的 offset 级别，
见 `src/contextOverflow.ts` 文件头）：

```
上游/代理返回 ValidationException{ reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" }
        │
        ▼  Kiro Bfe（错误分类）命中官方溢出分支
   Dfe (ContextWindowExceededError, CLIENT_ERROR, 不进 TRANSIENT 重试)
        │
        ▼  u4（溢出判定）为真
   WLl：截断式摘要 → 重置上下文 → 下一轮继续
        （disableAutoCompaction 时改为「要求手动压缩」）
```

`contextOverflowException(status, text)` **已经能构造这个异常**，形状完全正确：

```ts
{ exceptionType: "ValidationException",
  payload: { message: "Input is too long. Upstream 400: …",
             reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" } }
```

**现在的差别只在触发时机**：它只在 `looksLikeContextOverflow(status, text)` 为真时发，
而该判定要求上游状态码 ∈ {400, 413, 422} 且文案像超长。

⇒ **本提案 = 把这个信号从「被动（等上游报错）」改成「主动（插件自己发现超阈值就发）」。**

### ~~为什么没有别的选择~~（本节前提已作废，见上方降级说明）

| 候选机制 | 原判断 | **更正后的实际结论** |
|---|---|---|
| `tokenLimits.maxInputTokens`（CPS 声明） | ~~❌ 不驱动压缩~~ | ✅ **驱动**。它是占用百分比的**分母**，而 Kiro 按该百分比在 80%/95% 触发压缩 |
| `contextUsageEvent.contextUsagePercentage` | ~~❌ 不驱动压缩~~ | ✅ **驱动**。Kiro 的 `KJl` 直接读它。原判断所用反例（gpt-5.6）恰好是窗口口径分歧的模型，百分比被算错了 3.86 倍 |
| 溢出异常 | ✅ Kiro 认得的信号 | ✅ 仍然成立，但它**只是兜底**，不是唯一路径 |

与 DSH 的对照：DSH 用 `thresholdRatio 0.8` / `retainRatio 0.16` 主动压缩，
并把指令放在**尾部**让摘要调用复用主请求的 KV cache。本提案借用的是「主动 + 阈值」这个思路；
「摘要复用缓存」那部分取决于 Kiro 自己的摘要实现（见 §6 未知项 1）。

---

## 2. 触发条件

### 为什么不用估算
插件**没有 tokenizer**。任何「字符数 ÷ 系数」的估算都会在中文 / 代码 / 工具结果上系统性地偏，
而偏低的后果是白跑一轮、偏高的后果是过早压缩（丢上下文）。不划算。

### 采用「上一轮的真实用量」作为判据
插件在每次响应里都拿到上游返回的真实 `prompt_tokens`（`streamShared.CapturedUsage`），
并且有 per-conversation 状态（`turnLedger`）。因此：

```ts
// 判据（每个 conversationId 独立）
trigger ⟺ lastPromptTokens(conversationId) > threshold
```

- `lastPromptTokens` = 该会话**最近一次成功响应**上报的 `prompt_tokens`。真实值，不是估算。
- 代价：**滞后一步**。真正超过阈值的那一次请求会被放行，压缩在**下一次**触发。
  由于拐点是一条缓坡而非硬墙（200–250K 已是 14.4s，250–300K 才 16.3s），
  多跑一轮高延迟的代价可接受，换来的是**零估算误差、零误判**。

### 阈值
`threshold = clamp(round(0.8 × 生效窗口), MIN, MAX)`

- `生效窗口` = `contextWindowForModel(modelId)` —— 本次已修好，与 CPS 同口径，
  用户的 `contextWindowOverrides` 也会被尊重（这是那个设置唯一真正有用的地方）。
- 兜底：若用户显式配置了绝对值，用绝对值。
- 默认值的效果：DeepSeek（窗口 1,000,000）→ 阈值 800,000，**触发不了**。
  所以这个功能**默认关闭**，并且默认不依赖窗口百分比——见 §4 的配置项设计。

> 这一点很重要：如果阈值按 80% 窗口算，DeepSeek 的窗口是 1M，阈值就是 800K，
> 而拐点在 200K —— 什么都不会发生。所以**必须允许直接指定绝对阈值**，
> 并且把 DeepSeek 一类「窗口虚高但实际有性能拐点」的模型单独标注。

---

## 3. 防死锁设计（本提案最关键的部分）

「主动拒绝请求」天然带着**把用户卡死**的风险。以下约束是强制的，不是可选优化。

### 3.1 失效模式与对策

| # | 失效模式 | 后果 | 对策 |
|---|---|---|---|
| F1 | Kiro 压缩后重发的请求**仍然超阈值**（压缩不到位） | 无限拒绝 | **相同请求体熔断**：若连续 `maxIdenticalRetries`（默认 2）次的请求体与上次被拒的**逐字节相同**，判定 Kiro 没有改变上下文 → 永久放行该会话 + 记警告日志 |
| F2 | Kiro 的摘要请求本身也走本插件，且它也是大请求 | 摘要被拒 → 死锁 | **辅助请求白名单**：命中辅助调用特征一律放行。特征待实测确认（§6 未知项 1） |
| F3 | `disableAutoCompaction` 为真 | Kiro 改为「要求手动压缩」，不会自动重发 → 用户看到一个错误 | 首次拒绝后若在 `graceMs`（默认 90s）内没有观察到该会话的新请求，停止对该会话介入 + 提示用户手动开新会话 |
| F4 | Kiro 升级改了 `reason` 常量或 `WLl` 行为 | 拒绝变成一条普通错误，用户卡住 | 见 3.2 的「先探测后介入」 |
| F5 | 多窗口 / 多会话并发共用同一 conversationId | 状态串味 | 状态键用 `conversationId + 首个 user 消息指纹`，并设上限（LRU 32） |
| F6 | 阈值配得过低（例如 20K） | 每两轮压一次，上下文反复重建，反而更慢 | 阈值下限强制 `MIN_THRESHOLD = 32_768`；UI 上拒绝更低的值 |

### 3.2 先探测后介入（对 F4 的正面防御）

不要一上来就拒绝。**首次触发时先做一次「探测性拒绝」并观察**：

1. 发溢出异常，同时把该会话标记为 `probing`（附时间戳）。
2. 若在 `probeWindow`（默认 120s）内该会话**出现新请求且 `prompt_tokens` 明显下降**
   → 判定机制有效 → 该会话转入 `armed`，之后正常介入。
3. 若在窗口内没有新请求，或新请求的 `prompt_tokens` 没下降
   → 判定机制在当前 Kiro 版本上无效 → **全局降级为 off**，记一条明确的诊断日志，并提示用户。

这条把「Kiro 版本漂移」从「用户被卡住」降级成「功能自动关闭 + 一条日志」。

### 3.3 硬性上限

- `maxBlocksPerSession`（默认 3）：同一会话累计拒绝达上限后停止介入。
- 全局开关默认 `off`；未经用户显式启用，代码路径完全不执行。

---

## 4. 配置项

```jsonc
// 总开关。off = 完全不执行（默认）
"api2kiroDual.proactiveCompaction": "off",   // "off" | "on"

// 绝对阈值（tokens）。留空 = 按生效窗口的 80% 算。
// ⚠️ 对 DeepSeek 这类「窗口虚高但有性能拐点」的模型必须显式填，
//    否则 80% × 1,000,000 = 800,000，永远触发不了。
"api2kiroDual.proactiveCompactionByModel": {
    "deepseek/deepseek-v4.1-flash": 160000,
    "deepseek-v4-pro": 160000
},

// 安全阀（一般不用改）
"api2kiroDual.proactiveCompactionLimits": {
    "maxBlocksPerSession": 3,
    "maxIdenticalRetries": 2,
    "probeWindowMs": 120000
}
```

`proactiveCompactionByModel` 的键与 `contextWindowOverrides` **同一套 id 空间**
（Kiro 选择器里的模型 id），可以共用侧边栏那一行的下拉位置再加一个输入框。

---

## 5. 接入点

| 位置 | 改动 |
|---|---|
| `krsServer.handleGenerate` | 在两协议分派**之前**（`dispatchOpenai` / `dispatchAnthropic` 之前）插入一次判定 —— 两个协议共用同一条路径，不重复实现 |
| `turnLedger` | 复用其 per-conversation 结构，新增 `lastPromptTokens` / `proactiveState` |
| `contextOverflow.ts` | 复用 `contextOverflowException()`，不改形状。新增一个**主动版**的 message 与用户提示（现在那句「Upstream 400: …」在主动场景下是错的，因为没有上游参与） |
| `streamShared.contextWindowForModel` | 复用（本次已修好口径） |
| `sidebar.ts` 设置页 | 新增开关 + 每模型阈值输入 |

主动版异常帧的形状（**reason 必须逐字保持**，否则 Kiro 认不出来）：

```ts
{ exceptionType: "ValidationException",
  payload: { message: "Input is too long. Proactive compaction at 162,431 tokens (threshold 160,000).",
             reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" } }
```

> `message` 首句 `Input is too long.` 是 Kiro `u4` / `kAr` 逐字认得的三个关键词之一，**不能改**；
> 后缀可以自由写。见 `contextOverflow.CONTEXT_OVERFLOW_MESSAGE_PREFIX`。

---

## 6. 实现前必须先解决的未知项（阻塞）

### 未知项 1（最高优先）：Kiro 的摘要请求是否走本插件？形态是什么？

**为什么阻塞**：若走本插件且被 §3 的白名单漏掉，就是 F2 死锁 —— 用户完全卡住。

**现状**：作者的研究笔记 `.verify-artifacts/ctx-window-research.md` **未入库**，
仓库里只有 `contextOverflow.ts` 的一句概括（「截断式摘要 → 重置上下文 → 下一轮继续」），
无法判断「摘要」是本地截断还是额外的模型调用。

**怎么解决（一次实验即可）**：
1. 临时打开插件日志的请求转储（`log.ts` 已有 OutputChannel）。
2. 造一个必然溢出的会话（或用 §3.2 的探测拒绝触发一次）。
3. 观察紧随其后的请求：
   - 若**没有**新请求，或新请求就是压缩后的正常续写 ⇒ 摘要是本地的，**F2 不存在**，设计可简化。
   - 若出现一个「无 `tools`、无 `toolResults`、history 为空或极短」的请求 ⇒ 那就是摘要调用，
     必须加白名单。识别方式可参考已有的 `intentClassifier.isIntentClassifierRequest`
     （靠内容标记）——它是同类问题的既有解法。

### 未知项 2：`disableAutoCompaction` 的实际取值与来源

它是 Kiro 的设置项还是内部常量、默认值是什么、用户能否在本机查到？
决定 F3 的兜底是否会被真实触发。注意本机 `settings.json` 里**没有**显式配置它。

### 未知项 3：压缩后的回落幅度

`WLl` 保留多少？若它保留的仍超过阈值，就会撞上 F1。
这决定默认阈值该定在多少（如果回落幅度小，阈值就不能贴太近拐点）。
**用现成工具就能测**：`node dev/measure-latency.mjs --model=deepseek` 里的上下文档位分布，
在启用后是否出现「降到 100K 以下再爬升」的锯齿。

### 未知项 4：摘要调用是否复用缓存

DSH 的做法是把摘要指令放在**尾部**，让摘要调用成为主请求的前缀从而命中 KV cache。
Kiro 自己的摘要实现是否这么做，决定了压缩的**一次成本**：
- 复用 ⇒ 压缩几乎免费（只有被替换的那段失效）
- 不复用 ⇒ 每次压缩都是一次满价的大输入请求

如果是不复用，可以考虑在启用前先提示用户这个成本。

---

## 7. 风险与回退

| 风险 | 等级 | 缓解 |
|---|---|---|
| 用户被卡在错误上（死锁） | **高** | §3 全部措施；默认关闭；探测式介入；硬上限 |
| 上下文丢失影响正在做的工作 | 中 | 这是设计的一部分，但要在 UI 文案里说清；建议只在长会话主动启用 |
| Kiro 升级导致机制失效 | 中 | §3.2 探测 + 自动降级为 off |
| 压缩本身耗时（TTFT 的一次性成本） | 低 | 一次压缩换后续每轮省 7–15s，J 型曲线明显划算 |

**回退**：把 `proactiveCompaction` 设回 `off` 即完全回到当前行为 —— 代码路径不执行，
没有需要清理的状态。

---

## 8. 验收标准（可测量，用现成工具）

基线已冻结在 `dev/baselines/before-20260915.json`。启用后累积 ≥100 次暖请求再跑：

```bash
node dev/measure-latency.mjs --model=deepseek --since=<启用时刻>
```

| 指标 | 基线 | 目标 |
|---|---|---|
| 上下文 p50 | 226,332 | **< 170,000** |
| 拐点倍数（200–250K ÷ 150–200K 的 TTFT） | 1.77× | **≤ 1.3×** |
| 200K 以上的请求占比 | 约 50% | **< 10%** |
| TTFT p50 | 14,424 ms | **< 9,000 ms** |
| 失败率 | 1.3% | **不上升** |
| 熔断日志（相同请求体 / 探测失败） | — | **为 0** |

最后一项是**必须为 0 的硬条件** —— 只要出现一次，说明 §3 的假设有漏洞，应回退并重新设计。

---

## 9. 建议的落地顺序

1. **先做 §6 未知项 1 的实验**（只加日志、不改行为）——它决定整个设计的形状。
2. 若摘要是本地的：设计可大幅简化（不需要白名单），风险等级从「高」降到「中」。
3. 实现 §3 的探测 + 熔断骨架，**不接阈值逻辑**，先跑通「拒绝 → Kiro 压缩 → 回落」这一个循环。
4. 接上阈值与配置项，默认 off，交给用户按模型逐个启用。
5. 按 §8 验收。

---

## 附：本提案不做什么

- 不自己实现压缩引擎（不重写 Kiro 的历史）——那需要插件维护会话状态并改写 Kiro 的真相，
  一旦不一致就是静默的上下文丢失，且与 Kiro 自己的压缩会互相打架。
- 不改 `tokenLimits.maxInputTokens` 的语义（已在本轮修正为「展示口径」，不再声称它驱动压缩）。
- 不改缓存相关逻辑（97.7% 已无空间）。
