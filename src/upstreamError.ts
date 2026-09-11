/**
 * 上游错误正文 → 给用户看的可读原因。
 *
 * 两条硬约束：
 *  1. **同源**：聊天消息（`assistantResponseEvent`）与协议异常帧（`encodeException`）必须用同一份原因，
 *     否则会出现"聊天里看得见、异常帧里只有裸状态码"的分叉（历史行为正是如此）。
 *  2. **脱敏**：上游正文可能回显请求头里的 Key / Bearer，呈现给用户前必须过与日志同一套规则
 *     （`src/log.ts` 的 `redactText`）。此前这里是直接把原始正文切 800 字塞进聊天消息的。
 */
import { redactText } from "./log";

/** 单条原因的最大展示长度（与既有聊天消息的 800 字对齐，不缩水）。 */
const MAX_REASON_LEN = 800;

/**
 * 从上游响应正文里取一条可读原因（已脱敏、已截断）。
 *
 * JSON 优先取 `error.message` / `msg` / `detail`（多数中转站与 OpenAI 系都在这几个字段里给真实原因），
 * 取不到才退回压平后的原文。非 JSON 同样退原文。
 */
export function upstreamErrorReason(body: string, maxLen = MAX_REASON_LEN): string {
  const raw = String(body ?? "");
  let detail = "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const outer = parsed as Record<string, unknown>;
      const inner = (outer.error && typeof outer.error === "object" ? outer.error : outer) as Record<string, unknown>;
      const candidate = inner.message ?? inner.msg ?? inner.detail;
      if (typeof candidate === "string" && candidate.trim()) {
        detail = candidate;
      }
    }
  } catch {
    /* 非 JSON：走原文 */
  }
  // 先脱敏再截断：截断可能把密钥切成半截，脱敏规则多半就认不出来了。
  const text = redactText((detail || raw).replace(/\s+/g, " ").trim());
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

/** 异常帧用：`HTTP <status>: <原因>`，原因与聊天消息同源。 */
export function formatUpstreamError(status: number, body: string, maxLen = MAX_REASON_LEN): string {
  const reason = upstreamErrorReason(body, maxLen);
  return reason ? `HTTP ${status}: ${reason}` : `HTTP ${status}`;
}
