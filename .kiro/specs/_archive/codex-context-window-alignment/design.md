# Design: Codex 上下文窗口口径统一
> 有修订：见文末 `## Amendments`。

## Overview

修复不引入新的取值来源，只做两件事：**把"手动覆盖"这一档补上**（让口径可被显式钉死），以及**修正内置 Codex 厂商表里与客户端元数据不符的数值**；名字兜底只做加法式放宽，不改既有匹配语义。

## Glossary

| 术语 | 含义 |
|---|---|
| 窗口 / contextWindow | 模型可用输入上下文长度（token 数），驱动 Kiro 上下文条与 `maxInputTokens` |
| Codex 订阅通道 | 通过 ChatGPT Plus/Pro 订阅走 `chatgpt.com/backend-api/codex` 的通道（内置厂商表 或 CLIProxyAPI 中转） |
| 平台 API 口径 | OpenAI 官方 API / Azure / Bedrock 的窗口声明，即 models.dev 登记值 |
| 厂商表 | `src/oauth/vendors.ts` 里 OAuth 厂商的内置模型目录 |
| 覆盖 / ModelOverride | `provider.modelOverrides[modelId]`，用户手动钉死的单模型能力 |
| mergedCache | `modelStore` 合并全部 provider 模型后的全量缓存，`contextWindowForModel` 的第一查询点 |

## Bug Details

窗口值在代码里取自四个来源，实际生效顺序为：

```
上游 /models 声明 (parseContextWindow)
  > [缺失] 手动覆盖 (ModelOverride)        ← 本修复新增
  > 内置厂商表 (vendors.ts codex.models)
  > models.dev 能力目录 (lookupCapability)
  > 名字启发式 (streamShared: 含 "gpt" → 272000)
```

- `contextWindowForModel`（`src/modelStore.ts:713`）先查 `mergedCache`，未命中再查 `lookupCapability`。`mergedCache` 条目由 `normalizeModel`（`:325`）以 `cw || cap?.contextWindow` 生成；CLIProxyAPI 的 `/v1/models` 不带任何窗口字段（实测 `?detail`/`?include`/`?full` 均无效），`cw` 恒为 0 → **必然落到 models.dev**。
- models.dev 的 `openai/gpt-6-astra` 登记 `limit.context = 1050000`（平台 API 口径）；ChatGPT 订阅的 Codex 通道按 `codex_client_models.json` 是 272000。差异约 3.9 倍，Kiro 因此在"用了约 26%"时才提示上下文压力。
- 内置 Codex 通道同样走这条链：`vendorCatalog`（`:347`）用 `m.contextWindow || cap?.contextWindow`，所以厂商表没写值就会落到目录 —— `vendors.ts:349-351` 的 5.6 系三条正是如此；`gpt-5.5`、`gpt-5.3-codex-spark` 写的 400000 也与元数据不符。
- 用户侧无出口：`ModelOverride`（`src/providers.ts:73`）只有 `image`/`reasoning`。
- `looksReasoningModel`（`src/modelStore.ts:733`）名字兜底只认 `gpt-5`/`gpt5`，目录缺失时 `gpt-6-astra` 被判成非推理模型。

## Hypothesized Root Cause

窗口的**权威来源缺失**：上游中转不声明、内置表存在数值错误、能力目录登记的是另一条产品线的口径，而唯一能表达"对这条通道而言正确值是多少"的手动覆盖机制里恰好没有这个字段。于是三方各自"有值"的情况下，目录值静默胜出，错误无人能纠正。

## Expected Behavior

- WHEN 用户在 provider 的 `modelOverrides` 里显式指定 `contextWindow` THE SYSTEM SHALL 用该值，优先于厂商表与 models.dev 目录，但让位于上游 `/models` 的明确声明。
- WHEN 模型来自内置 Codex 厂商目录 THE SYSTEM SHALL 使用客户端元数据值：`gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` = 272000，`gpt-5.3-codex-spark` = 128000。
- WHEN models.dev 不可用或未收录 AND 模型属于 GPT-5 及以后家族 THE SYSTEM SHALL 判定为推理模型。

## Correctness Properties

### Property 1: 覆盖优先于厂商表与目录

provider 的 `modelOverrides[m].contextWindow = N` ⇒ 该 provider 下模型 `m` 的 `RelayModel.contextWindow === N`；对"上游给了窗口"与"上游没给窗口"两条路径都成立。

### Property 2: 上游声明不被降级

无覆盖且上游 `/models` 明确给了合法 `context_window`/`context_length` ⇒ 结果取上游值，不被厂商表或 models.dev 顶掉。

### Property 3: 目录兜底保持

无覆盖、上游未给、厂商表无值 ⇒ 仍取 models.dev 目录值（不因本次改动丢失兜底）。

### Property 4: 内置 Codex 厂商表数值正确

`codex.models` 中 `gpt-5.5`/`gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna` 的 `contextWindow === 272000`，`gpt-5.3-codex-spark === 128000`，`gpt-5.4`/`gpt-5.4-mini` 保持 400000。

### Property 5: GPT-6 家族推理判定兜底

目录不可用时 `looksReasoningModel("gpt-6-astra")`、`("gpt-6.0")` 为 `true`；`("gpt-4o")`、`("gpt-3.5-turbo")`、空串仍为 `false`；`gpt-5` 系既有判定不变。

### Property 6: 既有覆盖字段不受影响

`ModelOverride.contextWindow` 缺席时，`overrideFor` 返回的对象在 `image`/`reasoning` 判定上与原实现完全一致。

### Property 7: 覆盖的宽松匹配对窗口同样生效

`modelOverrides["gpt-6-astra"]` 能命中查询 `gpt-6-astra-high`（base-id 归一后命中）。

## Fix Implementation

- **D1（新出口）**：`ModelOverride` 增加 `contextWindow?: number`（`src/providers.ts:73`）。纯数据字段，`overrideFor`（`providers.ts:652`）原样返回对象，判定逻辑无需改动。
- **D2（接线）**：在生成 `RelayModel` 的四条路径上把覆盖插到"上游声明"之下、目录/厂商表之上（`src/modelStore.ts`）：
  - `normalizeModel`（`:325`）：`ov?.contextWindow || cw || cap?.contextWindow`
  - `vendorCatalog`（`:347`）：`ov?.contextWindow || m.contextWindow || cap?.contextWindow`
  - `stubModels`（`:397`，拉取超时/失败时的替身清单）：`ov?.contextWindow || cap?.contextWindow`
  - 官方在线清单分支（`:426`）：`ov?.contextWindow || m.contextWindow`
- **D3（修正厂商表）**：`src/oauth/vendors.ts:344-352` 的 `codex.models` 按 `codex_client_models.json` 写对数值；只改有权威证据的条目。
- **D4（名字兜底）**：`src/modelStore.ts:733-741` 保留原 `gpt-5`/`gpt5` 判断，另加 `/(^|[^a-z])gpt-?[6-9]/.test(m)`（加法式）。
- **D5（配置落地）**：给实际使用的 CLIProxyAPI provider（Kiro `settings.json` 的 `p3`）补 `modelOverrides`，把 5 个已启用模型钉到 272000。

## Testing Strategy

本仓库开源精简时已移除测试框架，故采用三层验证：

1. 静态：`npx tsc --noEmit` 全量类型检查。
2. 纯函数断言：一次性 Node 脚本对 Property 1/3/5/7 做断言（`overrideFor`、`looksReasoningModel`、`parseContextWindow`）。
3. 端到端：`node esbuild.js` 构建 → 打包 vsix → `kiro --install-extension` → 在 Kiro 里确认 `gpt-6-astra` 报出 272000 且思考档位可见。

## Risks

- **R1（构建）**：`antigravity.secret` 本地缺失且环境变量未设，直接 `node esbuild.js` 会把 Antigravity client secret 注入为空串，破坏该厂商登录。缓解：构建前从现有 `dist/extension.js` 提取该字面量并以 `A2K_ANTIGRAVITY_CLIENT_SECRET` 注入，构建后比对一致性。
- **R2（数值）**：272000 来自 Codex 客户端元数据，未做超长上下文压测；取保守值是刻意的方向性选择（宁可早提示压缩）。
- **R3（范围）**：本次不把 `gpt-6-astra` 加入内置 Codex 厂商目录（属新增模型支持，需另行决定 free/team 门控），只修窗口口径与判定兜底。
- **R4（配置外置）**：`modelOverrides` 写在 Kiro 的 `settings.json`，若用户日后从 UI 重建该 provider，需重新补写。

## Amendments

> 补充修正

### 2026-09-11 · 审查收口：补接两处 RelayModel 构造点

复核发现 **Property 1 过度承诺**：`RelayModel` 的构造点在 `src/modelStore.ts` 中共 **6 处**，首轮只接了 4 处（`normalizeModel` / `vendorCatalog` / `stubModels` / 官方在线清单分支），遗漏：

- `seedProviderModels`（`:519`）—— 入口是侧栏「刷新模型」探测（`sidebar.ts:1071`）。因其先展开 `...(old || {})`，已缓存条目仍带覆盖值；只有"探针新发现且尚未缓存"的模型会短暂走 models.dev 值，下次全量拉取自愈。
- `catalogFallbackModels`（`:541`）—— 入口是 stub 最终兜底（`:404`）与「key 类 provider 上游 `/models` 为空」（`:472` / `:486`）。这类 provider 会**完全忽略覆盖**，与本次修复的失效模式同类（正是 p3 那一类，只是 p3 的 `/models` 非空所以没触发）。

处置：两处均补 `overrideFor(p, id)?.contextWindow` 接线（覆盖 > 缓存/厂商表 > 目录），使 Property 1 按字面成立。已随 4.13.57 发布。
