# Design Document
> 有修订：见文末 `## Amendments`。

## Overview

三条独立接缝，按"能立刻做完的先做"排序：Req 1（错误正文）→ Req 2（窗口目录）→ Req 3（配额，阻塞于网关管理密钥）。

## Architecture

### Req 1：错误正文

```
上游非 2xx ──► errText = readBody(body)
                  │
                  ├─► assistantResponseEvent.content  ← 已有（❌ 上游返回 N：正文）
                  └─► encodeException.message         ← 新增：同一份摘要
                                                     （原为 "Upstream N" 裸状态码）

上游 2xx 但流内报错 ──► seText ──► 聊天消息（已有）+ encodeException（新增摘要）
```

关键：**两处呈现必须同源**，否则又会出现"聊天里看得见、异常里看不见"的分叉。新增一个共享提取器，聊天与异常都调它。

### Req 2：窗口目录

```
modelStore 能力解析链（现有）：
  手动覆盖 > 上游 /models 声明 > 厂商表 > models.dev > 名字启发式

改造后：
  手动覆盖 > 上游 /models 声明 > Codex 目录(新) > 厂商表 > models.dev > 名字启发式
```

`modelCatalog.ts` 已具备「远端 JSON + 磁盘缓存 + TTL + 失败即回退」的完整骨架（models.dev 用），Codex 目录复用同一套：独立 URL、独立缓存键、独立 TTL（跟随网关的 3h 刷新节奏，取 6h 留余量）、失败静默回退。

### Req 3：配额

网关公开路由没有配额端点（实测 `/v1/usage`、`/v1/me`、`/v1/quota` 均 404），`/v0/management/*` 无 key 一律 401。故需二者之一：**(a)** 用户提供 `secret-key` 明文；**(b)** 在 `config.yaml` 里改配一个已知 key 并重启网关。二者都属外部依赖，未决。

## Components and Interfaces

### 新增：`src/upstreamError.ts`

- `export function readableUpstreamError(status: number, body: string): string`
  - JSON 优先取 `error.message` / `msg` / `detail`，否则整段压平；
  - 截断到固定长度（沿用既有 160/800 两档中的一档）；
  - **返回前过 `redactText`**（复用 `src/log.ts:261`）。
- 纯函数，无 IO，便于断言。

### 改动：`src/krsServer.ts`

- `:1207` 聊天消息与 `:1212` 异常帧共用 `readableUpstreamError(upstream.statusCode, errText)` 的结果。
- `:1275` 流内错误消息与 `:1278` 异常帧共用 `readableUpstreamError(seStatus, seText)`。
- 保留 hint 拼接与既有 `errText.slice(0,800)` 的展示宽窄（不缩水）。

### 改动：`src/modelCatalog.ts`

- 新增 `lookupCodexWindow(modelId): number | undefined`：按模型 id 归一化后查 Codex 目录的窗口。
- 目录源：`https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json`
  - 该 JSON 的 `codex-free|team|plus|pro` 四个池都是模型数组，每条含 `id` 与 `context_length`（实测 `gpt-5.5` → 272000）。
  - 合并策略：四池取**同一 id 的最小 `context_length`**（保守；跨套餐不一致时宁可早提示压缩）。
- 缓存：沿用 models.dev 的 `globalState` 快照 + TTL 机制，独立键。
- 失败：返回 `undefined`，调用方继续走原回退链。

### 改动：`src/modelStore.ts`

- 在能力解析链里插入 `lookupCodexWindow`：位置在上游声明之后、厂商表之前。
- 仅对 Codex 家族 id 生效（避免误伤同名中转模型）。

## Data Models

| 来源 | 字段 | 例 |
|---|---|---|
| 网关 `/v1/models` | 仅 `id` | `gpt-6-astra` |
| Codex 目录 `models.json` | `id`, `context_length` | `272000` |
| models.dev | `limit.context`（平台 API 口径） | `1050000` |

## Correctness Properties

### Property 1: 异常帧与聊天同源

对同一 `(status, body)`，异常帧里的原因字符串与聊天消息里的是同一份内容（前缀文案可不同）。

**Validates: Requirements 1.1, 1.2**

### Property 2: 呈现前脱敏

给定含 `Bearer sk-…` / `GOCSPX-…` / JWT 的正文，`readableUpstreamError` 的输出中不含原文。

**Validates: Requirements 1.3**

### Property 3: JSON 错误优先取 message/detail

`{"error":{"message":"boom"}}` → 输出含 `boom`；`{"detail":"nope"}` → 输出含 `nope`。

**Validates: Requirements 1.4**

### Property 4: Codex 目录窗口优先于 models.dev

给定某 Codex 模型、上游未声明窗口、无手动覆盖，解析结果为 272000（而非 1050000）。

**Validates: Requirements 2.1**

### Property 5: 手动覆盖与上游声明仍然优先

覆盖值存在时取覆盖值；上游声明合法窗口时取上游值（二者都不受本次改动影响）。

**Validates: Requirements 2.2, 2.3**

### Property 6: 目录不可用即回退

目录拉取失败时 `lookupCodexWindow` 返回 `undefined`，解析链继续走到 models.dev / 名字启发式。

**Validates: Requirements 2.4**

## Error Handling

- 所有新逻辑都是"纯增强"：目录不可达、JSON 形状变化、字段缺失 → 一律返回 `undefined`/原文回退，绝不抛给请求路径。
- 脱敏只覆盖已知形态（与日志同一套规则），不追求语义级完整。

## Testing Strategy

1. `npx tsc --noEmit`。
2. 纯函数断言（复用 `vscode` stub bundle 方案）：Property 2/3（脱敏与提取）、Property 6（缺字段回退）。
3. 目录解析断言：用真实的 `models.json` 快照校验 `gpt-6-astra` → 272000、`gpt-5.5` → 272000。
4. 构建：`node esbuild.js` + 打包 vsix + 安装，确认版本。

## Risks

- **R1（数据源第三方）**：Codex 目录是 CLIProxyAPI 维护的仓库，不是 OpenAI 官方数据。缓解：它正是你网关当前信任的同一份数据；且手动覆盖仍可纠正。
- **R2（四池取最小值可能偏保守）**：若某套餐实际窗口更大，Kiro 会较早提示压缩。方向性可接受（宁早勿晚）。
- **R3（Req 3 阻塞）**：无管理密钥则无法读取配额，本 spec 不阻塞其余两条。
- **R4**：只对 Codex 家族 id 生效，避免误伤中转站上同名的平台 API 模型（其窗口确为 1.05M）。

## Amendments

> 补充修正

### 2026-09-11 · 目录改为两份来源 + 保守下限（5.6 系冲突）

实施后实测发现**目录内部数据冲突**，据此追加一处设计修订：

`models.json`（按套餐池）与 `codex_client_models.json`（OpenAI Codex 客户端元数据）对 `gpt-5.6-sol|terra|luna` 的窗口不一致：

| 模型 | `models.json` | `codex_client_models.json` |
|---|---|---|
| `gpt-6-astra` / `gpt-5.5` / `gpt-5.3-codex-spark` | 272000 / 272000 / 128000 | 272000 / 272000 / 128000（一致） |
| `gpt-5.6-sol/terra/luna` | **372000**（free/team/plus）、**921000**（pro） | **272000** |

且 `models.json` 自身跨套餐不自洽（free 与 plus 同为 372000，pro 却 921000）。原先只取四池最小 → 得到 372000，
比 OpenAI 客户端声明的 272000 **乐观 1.37 倍** —— 与本次修复要消除的失效模式同向。

**处置**：`codexCatalog.ts` 改为拉取**两个**文件（`models.json` + `codex_client_models.json`），
`mergeConservatively` 在两个来源与四个池之间统一**取最小**；`max_context_window`（如 872000）**不采用**，
因为上报上限就是偏乐观。取舍理由：上报偏小只让 Kiro 早提示压缩，上报偏大可致长会话中途失败。
单个文件失败不影响另一个；两个都失败则返回 `undefined` 走既有回退链。

验证：新增第五轮断言 12 条，合计 **80/80** 通过。
