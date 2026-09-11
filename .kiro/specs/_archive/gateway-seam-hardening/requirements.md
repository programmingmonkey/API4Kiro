# Requirements Document

## Introduction

用户在用 CLIProxyAPI 网关代理 Codex（`p3` provider）。实测确认两处信息在接缝上丢失或需要人工兜底：

1. **错误正文**：上游非 2xx 时正文会进聊天消息（`krsServer.ts:1207`），但异常帧只带状态码（`:1212` → `Upstream 400`；`:1278` → `Upstream stream error`）；且进聊天的正文**未经脱敏**（`errText = await readBody(...)`，直接 `slice(0,800)`）。
2. **窗口元数据**：网关 `/v1/models` 只返回 `id/object/created/owned_by`（实测 `?detail`/`?include`/`?full` 形状不变），插件回退 models.dev 拿到平台 API 口径的 1,050,000，而订阅通道实为 272,000 —— 目前靠 `p3` 的 6 条手工 `modelOverrides` 兜住。

3. **配额**：Codex 的 5h/7d 窗口在插件里不可见，只能被限流时从错误中得知。

## Glossary

| 术语 | 含义 |
|---|---|
| 接缝 | API4Kiro（`p3` provider）↔ CLIProxyAPI 网关（`127.0.0.1:8317`）之间的适配层 |
| Codex 目录 | 网关使用的远端模型目录 `router-for-me/models`（`models.json` 按 `codex-free/team/plus/pro` 分池，含 `context_length`；`codex_client_models.json` 含逐模型元数据） |
| 异常帧 | `encodeException(...)` 写出的协议级异常事件 |
| 管理 API | 网关 `/v0/management/*`，本机也需 `remote-management.secret-key`（配置里只有 bcrypt 哈希） |

## Requirements

### 1. 上游错误可读且不泄露密钥

**User Story:** 作为用户，我希望失败时聊天里和协议异常里都能看到上游给的真实原因，同时不要把密钥带出来。

#### Acceptance Criteria

1. WHEN 上游返回非 2xx THE SYSTEM SHALL 让聊天消息与异常帧都带上同一份可读原因（异常帧不得只有状态码）。
2. WHEN 上游在 2xx 流内报错 THE SYSTEM SHALL 以同样方式给出可读原因（异常帧不得只有 `Upstream stream error`）。
3. WHEN 上游正文里含已知形态的密钥或 Bearer token THE SYSTEM SHALL 在呈现给用户前脱敏。
4. WHEN 上游正文是 JSON 且含 `error.message` / `detail` THE SYSTEM SHALL 优先呈现该字段，而非整段原文。
5. the system SHALL CONTINUE TO 在输出通道记录上游错误（含状态码与正文摘要，同样脱敏）。

### 2. Codex 模型窗口由 Codex 目录驱动

**User Story:** 作为用户，我希望新模型上架后窗口自动正确，不必每次手工钉值。

#### Acceptance Criteria

1. WHEN 上游 `/models` 未声明窗口 AND 模型属于 Codex 家族（`gpt-5.*` / `gpt-6.*` 等）THE SYSTEM SHALL 采用 Codex 目录的 `context_length`（订阅通道口径），而不是 models.dev 的平台 API 口径。
2. WHEN 用户为该模型显式设置了 `modelOverrides.contextWindow` THE SYSTEM SHALL 以手动值为准（优先级不变）。
3. WHEN 上游 `/models` 明确声明了合法窗口 THE SYSTEM SHALL 以上游声明为准（优先级不变）。
4. WHEN Codex 目录拉取失败或超时 THE SYSTEM SHALL 回退到既有链路（models.dev → 名字启发式），不得因目录不可用降低可用性。
5. WHEN 目录中的新模型出现在该 provider 的模型列表里 THE SYSTEM SHALL 无需重新构建插件即可得到正确窗口。

## Constraints

- 不改动 CLIProxyAPI（预编译二进制）与 Kiro 本体。

## Out of Scope

- 把厂商目录改成任意 provider 的通用动态清单（本次只做 Codex 家族的窗口能力）。
- WebSocket 传输、多账号池、网关稳健性开关。
- **Codex 配额窗口可见（原需求 3，已决定不做）**：网关公开路由没有配额端点（实测 `/v1/usage`、`/v1/me`、`/v1/quota`、`/v1/credits` 全 404），`/v0/management/*` 无密钥一律 401，且无法确认管理 API 是否真暴露 5h/7d 数据（README 提到的是第三方工具）。要恢复此项需先提供网关管理密钥并探明端点。
