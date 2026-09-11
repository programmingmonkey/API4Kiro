# Requirements Document

> ⛔ **状态：决定不做（NOT PLANNED）** —— 本 spec **只写了需求，未开发任何代码**，2026-09-11 归档。
>
> **不做的原因**：既定方案是 **Codex 一律走 CLIProxyAPI 网关**（`p3` provider → `127.0.0.1:8317` → `/v1/responses`），
> 插件**内置的 Codex OAuth 直连通道不启用、不验证**；本 spec 描述的正是那条被放弃的路径。
>
> **重启条件**：若日后弃用 CLIProxyAPI、或需要让其它客户端与 Kiro 共用同一账号，可复用本需求；
> 但需先复核「astra 上架」与「订阅口径窗口」是否已被 `codex-astra-catalog-and-build-guard` /
> `gateway-seam-hardening` 覆盖。**在此之前不要按本文件开工。**

## Introduction

目标：打通并验证 API4Kiro 的**内置 Codex（OAuth 直连 ChatGPT 订阅）**通道，使 Codex 系模型（含 `gpt-6-astra`）在不依赖 CLIProxyAPI 中转的情况下也可用。

本轮调查得到的事实（作为需求依据）：

- `gpt-6-astra` 在用户的 ChatGPT **Plus** 账号上**实测可调**（经 CLIProxyAPI 中转，HTTP 与 SSE 双通，`store:false` + `reasoning.encrypted_content` 形状）。
- 同一账号上 `gpt-5.3-codex-spark` 被上游明确拒绝：`400 {"detail":"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account."}`（CLIProxyAPI 日志 2026-09-11 16:46:10，auth 文件 `codex-<account>-plus.json`）。而内置厂商目录在 plus/pro（默认分支）会把它列出来 —— **清单比实际可用性更大**。
- 登录回调端口 1455 本机空闲可绑定。
- API4Kiro 已有请求去向日志（`src/krsServer.ts:896`：`→ [provider] /responses model=… (kiro=…, reasoning=…)`）。

## Glossary

| 术语 | 含义 |
|---|---|
| 内置 Codex 通道 | `auth=oauth` + `oauthVendor=codex` 的 provider，token 由扩展内的 PKCE 登录取得 |
| 中转通道 | p3：CLIProxyAPI 网关（`127.0.0.1:8317`）作为 OpenAI Responses 端点 |
| 订阅通道 | `chatgpt.com/backend-api/codex`，只接受 ChatGPT 订阅可用的模型 |
| 套餐门控 | `codex.modelsFor(tok)`，按 token 里的 `chatgpt_plan_type` 裁剪可用模型 |
| 端到端 | Kiro 发起 → API4Kiro KRS（19810/19811）→ 上游 → 流式回 Kiro |

## Requirements

### 1. 内置 Codex 通道可登录与自动续期

**User Story:** 作为拥有 ChatGPT 订阅的用户，我希望能在 API4Kiro 里直接登录 Codex，这样不必额外运行一个中转网关。

#### Acceptance Criteria

1. WHEN 用户对内置 Codex 厂商发起登录 THE SYSTEM SHALL 打开浏览器授权页，并在本机 1455 端口监听回调以完成 PKCE 交换。
2. WHEN 授权码换取 token 成功 THE SYSTEM SHALL 持久化 access / refresh token，并解析出 email、`chatgpt_account_id`（`Chatgpt-Account-Id` 头所需）与 `chatgpt_plan_type`。
3. WHILE refresh token 存在 AND access token 已过期 THE SYSTEM SHALL 自动刷新，且不要求用户重新登录。
4. WHEN 回调端口 1455 已被占用 THE SYSTEM SHALL 以指明端口的可读错误结束登录，而不是静默失败或停在等待状态。

### 2. 模型清单与账号实际可用性一致

**User Story:** 作为用户，我希望内置通道给出的模型清单都是我账号真能用的，这样不会选了才被上游打回。

#### Acceptance Criteria

1. WHEN 账号套餐为 `plus` THE SYSTEM SHALL 在内置 Codex 通道的可用清单中包含 `gpt-6-astra`。
2. WHEN 某模型在订阅通道已被上游明确拒绝（已知样本 `gpt-5.3-codex-spark`）THE SYSTEM SHALL 不把它作为内置 Codex 通道的可选项暴露给用户。
3. WHEN 账号套餐字段缺失或无法识别 THE SYSTEM SHALL 仍给出一个不含已知不可用条目的清单。

### 3. gpt-6-astra 在内置通道端到端可用

**User Story:** 作为用户，我希望在内置通道里选 `gpt-6-astra` 就能像中转通道那样正常干活。

#### Acceptance Criteria

1. WHEN 用户在内置 Codex 通道选择 `gpt-6-astra` 并发送请求 THE SYSTEM SHALL 经 Responses 通道完成流式返回，并在 Kiro 侧正常呈现。
2. WHEN 该请求触发工具调用 THE SYSTEM SHALL 完成 Codex 侧的完整工具往返（`reasoning.encrypted_content` 回放不丢）。
3. WHEN 用户把推理档位设为 `high` / `xhigh` / `max` THE SYSTEM SHALL 以 `reasoning.effort` 透传且不产生 400。
4. WHEN Kiro 计算上下文用量 THE SYSTEM SHALL 以 272000 作为该模型窗口（不采用 models.dev 的 1050000）。

### 4. 失败可诊断

**User Story:** 作为用户，我希望失败时能看懂原因，而不是只看到"没反应"。

#### Acceptance Criteria

1. WHEN 上游返回 4xx / 5xx THE SYSTEM SHALL 把上游错误正文（或可辨识摘要）呈现为 Kiro 侧可读错误。
2. the system SHALL CONTINUE TO 在 API4Kiro 输出通道记录每次请求的 provider、model、推理档位与目标端点。

### 5. 回归保护

**User Story:** 作为现有用户，我希望新增这条通道不要动到我正在用的东西。

#### Acceptance Criteria

1. the system SHALL CONTINUE TO 让既有 key 类 provider（p1 / p2 / p3）正常路由，且其模型清单不因本次改动而变化。
2. the system SHALL CONTINUE TO 允许内置 Codex 通道与 CLIProxyAPI 中转通道共存，二者互不影响。
3. the system SHALL CONTINUE TO 把 OAuth token 只发往该厂商允许的宿主（`allowedOAuthHosts` 守卫行为不变）。
4. the system SHALL CONTINUE TO 在未登录状态下不占用 1455 端口、不发起对该厂商的网络请求。

## Constraints

- 浏览器授权必须由用户本人完成，agent 无法代为登录；该步骤在 tasks 中显式标记为人工步骤。

## Out of Scope

- 为内置通道实现 WebSocket 传输（CLIProxyAPI 侧的 `prefer_websockets` 不在本次范围）。
- 多账号池、配额看板与网关侧的稳健性开关。
