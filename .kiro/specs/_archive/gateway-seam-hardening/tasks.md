# Implementation Plan

> ✅ **状态：已完成并发布** —— 4.13.58（条目 c 错误透明化 + 条目 a Codex 窗口目录）、4.13.59（文档与配置项同步）已安装。
> 原**需求 3（Codex 配额可见）经决定不做**，已移入 requirements 的 Out of Scope；未归档：作为在役记录保留。

## Overview

先做无阻塞的 Req 1（错误正文与脱敏），再做 Req 2（Codex 目录驱动窗口），最后统一验证发布；Req 3 阻塞于网关管理密钥，单列。

## Task Dependency Graph

```json
{"waves":[{"id":0,"tasks":["1.1","2.1"]},{"id":1,"tasks":["1.2","2.2"]},{"id":2,"tasks":["1.3","2.3"]},{"id":3,"tasks":["2.4"]},{"id":4,"tasks":["4.1"]}]}
```

## Tasks

- [ ] 1. 上游错误正文传递与脱敏
  - [x] 1.1 新增 `src/upstreamError.ts`：`upstreamErrorReason` / `formatUpstreamError`（JSON 优先取 message/detail、先脱敏后截断）　_Requirements: 1.3, 1.4_
  - [x] 1.2 `src/krsServer.ts`：非 2xx 与流内错误两条路径的聊天消息与异常帧改为共用该提取器　_Requirements: 1.1, 1.2_
  - [x] 1.3 断言：JSON 提取、脱敏、缺字段回退；`tsc` 通过　_Requirements: 1.3, 1.4, 1.5_
- [ ] 2. Codex 目录驱动窗口
  - [x] 2.1 `src/modelCatalog.ts`：拉取并缓存 Codex 目录（独立 URL / 缓存键 / TTL），四池同 id 取最小 `context_length`　_Requirements: 2.1, 2.5_
  - [x] 2.2 `src/modelCatalog.ts`：暴露 `lookupCodexWindow(modelId)`，失败返回 `undefined`　_Requirements: 2.1, 2.4_
  - [x] 2.3 `src/modelStore.ts`：解析链插入「上游声明 > Codex 目录 > 厂商表 > models.dev」，仅对 Codex 家族 id 生效　_Requirements: 2.1, 2.2, 2.3_
  - [x] 2.4 断言：astra/5.5 → 272000（真实目录快照）、目录缺失回退、上游声明与手动覆盖仍优先　_Requirements: 2.1, 2.2, 2.3, 2.4_
- [ ] 4. 发布
  - [x] 4.1 版本递增 → 打包 vsix → `kiro --install-extension` → 确认安装版本

## Notes

- **条目 b（Req 3 配额可见）经用户决定不做**：网关公开路由无配额端点（`/v1/usage`、`/v1/me`、`/v1/quota`、`/v1/credits` 全 404），`/v0/management/*` 无密钥一律 401，且无法确认管理 API 是否真的暴露 5h/7d 数据。已从任务清单与依赖图移出。

- **条目 c（Req 1）已完成**：新增 `src/upstreamError.ts`（`upstreamErrorReason` / `formatUpstreamError`），
  `krsServer.ts` 两处聊天消息与两处异常帧改为共用它；断言 52/52、`tsc` 通过。附带发现并修掉一个隐含泄露：
  原来进聊天的正文是 `errText.slice(0,800)` **未经脱敏**，现在统一先过 `redactText`（`log.ts:233` 的 `sk-` 规则已覆盖你的 `sk-cpa-…`）。
- **条目 a（Req 2）待决的设计点**：实测 `models.json` 的 `codex-*` 四池带 `context_length`（`gpt-5.5` → 272000），是唯一带订阅口径的现成来源。
  但另有一个**零依赖**方案：`streamShared.ts:87-90` 早已有"名字含 `gpt` → 272000"的启发式，只是被 models.dev 挡在后面成了死代码。
  三个候选见最终汇报；A3（目录优先 + 启发式兜底）能同时满足"准确"与"目录不可用也能自愈"。
- **条目 b（Req 3）阻塞**：网关公开路由无配额端点（`/v1/usage`、`/v1/me`、`/v1/quota` 均 404），`/v0/management/*` 无 key 一律 401。

- Req 2 只做「窗口能力」；模型清单在 `p3` 上本来就是动态的（来自网关 `/v1/models`），无需改造。
- Req 3 的阻塞已写入 design「Req 3」小节：网关公开路由无配额端点，管理路由需密钥。
- 2026-09-11 · DSH · 条目 c：新增 upstreamError.ts，聊天消息与异常帧共用同源原因并统一脱敏（原来进聊天的正文未脱敏）。条目 a：新增 codexCatalog.ts（远端订阅口径目录 + 缓存）并把 6 处 RelayModel 构造点收敛为 resolveContextWindow（覆盖 > 上游声明 > Codex 目录 > GPT 家族启发式 > models.dev）。条目 b 经决定不做，移入 Out of Scope。发布 4.13.58。
