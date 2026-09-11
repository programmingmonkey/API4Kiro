# 已归档的 Spec

归档 = **不再推进**。但归档有两种原因，别混淆：

| Spec | 状态 | 结论 |
|---|---|---|
| [`codex-builtin-direct-connection`](./codex-builtin-direct-connection/) | ⛔ **决定不做（NOT PLANNED）** | 只写了需求、**未开发任何代码**。既定方案是 Codex 一律走 CLIProxyAPI 网关（`p3` → `127.0.0.1:8317`），插件内置的 Codex OAuth 通道不启用、不验证。**按本目录开工前，先读其 `requirements.md` 顶部的重启条件。** |
| [`codex-astra-catalog-and-build-guard`](./codex-astra-catalog-and-build-guard/) | ✅ **已交付** | 4.13.56 / 4.13.57。唯一未完成项是 `antigravity.secret` 需用户自备，属**外部依赖（等外部输入）**，**不是「决定不做」**。 |
| [`codex-context-window-alignment`](./codex-context-window-alignment/) | ✅ **已完成并发布** | 4.13.55（Codex 窗口口径 272000 + GPT-6 判定兜底）、4.13.57（审查收口，补接两处 `RelayModel` 构造点）。 |
| [`gateway-seam-hardening`](./gateway-seam-hardening/) | ✅ **已完成并发布** | 4.13.58 / 4.13.59（条目 c 上游错误透明化 + 条目 a Codex 窗口目录）、4.13.60（5.6 系改取两来源保守下限）。其原**需求 3（Codex 配额可见）经决定不做**，见该 spec 的 `Out of Scope`。 |

说明：

- 上一级目录的 `_active` 是 spec 工具的会话指针（瞬态），已在 `.gitignore` 中排除。
- `tasks.meta.json` 是 spec 工具的执行记录，随目录一并归档。
