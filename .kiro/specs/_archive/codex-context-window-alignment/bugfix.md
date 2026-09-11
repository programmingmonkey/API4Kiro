# Bugfix: Codex 系模型上下文窗口口径错位 + GPT-6 推理判定兜底缺失

## Introduction

用户在 Kiro 里通过 API4Kiro 使用 Codex（ChatGPT 订阅）通道时，模型报出的上下文窗口比后端真实可用值大约 4 倍，长会话会在"看起来才用了四分之一"的位置撞上上游的上下文长度错误。同时 `gpt-6-astra` 这类新模型在能力目录缺失时会被判定成非推理模型。

本修复统一 Codex 系的上下文窗口口径、补齐 GPT-6 家族的推理判定兜底，并为模型能力覆盖增加 `contextWindow` 字段作为通用纠错出口。

## Bug Analysis

### Current Behavior (Defect)

- 当上游 `/models` 未声明 `context_window`（实测 CLIProxyAPI 的 `/v1/models` 只返回 `id`/`object`/`created`/`owned_by`）时，`modelStore.contextWindowForModel` 回退到 models.dev 目录，而 models.dev 对 `gpt-6-astra` / `gpt-5.5` / `gpt-5.6-sol|terra|luna` 登记的是 **1050000**（平台 API / Azure / Bedrock 口径）。
- 因此 the system 在 Kiro 里把 `gpt-6-astra` 的 `maxInputTokens` 报为 1050000，而 Codex 客户端元数据（`codex_client_models.json`）声明该模型的 `context_window` 是 **272000**（`max_context_window` 872000）。
- `src/oauth/vendors.ts` 内置 Codex 厂商表里的窗口数值与客户端元数据不一致：`gpt-5.5` 标 400000（应为 272000）、`gpt-5.3-codex-spark` 标 400000（应为 128000）、`gpt-5.6-sol|terra|luna` 干脆没写（落到目录的 1050000）。
- `modelStore.looksReasoningModel` 的名字兜底只匹配 `gpt-5` / `gpt5`，不含 `gpt-6`。
- `ModelOverride`（`src/providers.ts`）只有 `image` 与 `reasoning` 两个字段，the system 无法由用户手动纠正任何 provider 下某个模型的上下文窗口。

### Expected Behavior (Correct)

- WHEN 用户在某个 provider 的 `modelOverrides` 里为某模型显式指定了 `contextWindow` THE SYSTEM SHALL 用该值作为该 provider 下该模型的上下文窗口，优先于上游声明与 models.dev 目录。
- WHEN 上游 `/models` 的模型条目带有合法的 `context_window` / `context_length` 等字段 THE SYSTEM SHALL 仍以上游声明为准（仅次于手动覆盖）。
- WHEN 模型来自内置 Codex 厂商目录（`src/oauth/vendors.ts` 的 `codex.models`）THE SYSTEM SHALL 使用 Codex 客户端元数据的窗口值：`gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` 为 272000，`gpt-5.3-codex-spark` 为 128000。
- WHEN models.dev 目录不可用或未收录某模型 AND 模型 id 属于 GPT-5 及以后的家族（含 `gpt-6-astra`）THE SYSTEM SHALL 判定其为推理模型。

### Unchanged Behavior (Regression Prevention)

- the system SHALL CONTINUE TO 在既无手动覆盖、也无上游声明、目录也查不到时，回退到 `streamShared.contextWindowForModel` 的名字启发式（含 `gpt` 一律 272000）。
- the system SHALL CONTINUE TO 对 `gpt-4`/`gpt-4o` 等 5 以前家族不因本条规则被判定为推理模型，`/(^|[^a-z])o[1345]([^a-z0-9]|$)/` 这条既有规则的行为保持不变。
- the system SHALL CONTINUE TO 保持 `ModelOverride.image` 与 `ModelOverride.reasoning` 的既有语义与优先级（手动 > 厂商表 > 上游声明 > 目录 > 名字推断）。
- the system SHALL CONTINUE TO 允许 `modelOverrides` 为空或字段缺席，此时行为与修复前逐条一致（除内置 Codex 厂商表数值修正本身）。
- the system SHALL CONTINUE TO 让 `overrideFor` 的宽松匹配（精确 id 优先、其次去掉 effort 后缀的 base id）对 `contextWindow` 同样生效。
- the system SHALL CONTINUE TO 在不注入 Antigravity client secret 的情况下仍能构建（`esbuild.js` 缺失 `antigravity.secret` 时注入空串），且本次改动不得使已构建产物丢失该 secret。
