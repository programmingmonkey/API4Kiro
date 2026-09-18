/**
 * 上游认得出「我们是谁」的两样东西：自报家门的 User-Agent，和「一个会话内稳定」的会话 id。
 *
 * 起因：OpenCode Go（opencode.ai/zen/go）对客户端有硬要求——请求里必须带 x-opencode-session，
 * 否则一律 400「Request is missing x-opencode-session and cannot be routed efficiently」；
 * 文档还要求客户端用自己的 UA（形如 my-coding-agent/1.0），而不是通用 SDK / HTTP 库的名字。
 * Node 的 http 默认不发 UA，之前我们在这家上游眼里等于匿名客户端。
 *
 * 会话 id 必须在**同一个会话内稳定**：上游靠它做路由亲和与提示缓存，每轮换一个会让缓存永远打不中。
 * 所以不能每个请求现生成——这里用「安装级随机前缀 + Kiro 的 conversationId」拼出来：
 * 前缀落 globalState（同一安装的所有窗口 / 会话共用，重启不变），会话之间互不串味。
 */

import * as crypto from "crypto";
import * as vscode from "vscode";

/** globalState 里存安装级前缀的键。 */
const INSTALL_KEY = "client.installId";
const INSTALL_ID_RE = /^[0-9a-f]{32}$/;
/** 会话 id 里的会话部分只保留 header 安全的字符（Kiro 的 conversationId 一般是 UUID，这里是兜底）。 */
const UNSAFE_RE = /[^A-Za-z0-9._-]/g;
/** 会话 id 总长上限，防一个病态长的 conversationId 把请求头撑大。 */
const MAX_SESSION_LEN = 128;
/** conversationId 太长时改用它定长的 sha256 摘要，避免截断导致两个会话撞成同一个 id。 */
const DIGEST_LEN = 32;

let extCtx: vscode.ExtensionContext | undefined;
let installId = "";
let clientVersion = "";
/** initClientIdentity 还没跑就被问到时的进程内兜底：至少保证同一进程稳定。 */
let ephemeralId = "";

/** 激活时调用：载入安装级前缀（首次则生成并落盘），并记下扩展版本供 UA 用。 */
export function initClientIdentity(context: vscode.ExtensionContext): void {
  extCtx = context;
  clientVersion = String(context.extension?.packageJSON?.version || "");
  const saved = context.globalState.get<string>(INSTALL_KEY);
  if (saved && INSTALL_ID_RE.test(saved)) {
    installId = saved;
    return;
  }
  installId = newInstallId();
  void context.globalState.update(INSTALL_KEY, installId);
}

function newInstallId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** 安装级前缀；没初始化过就用进程内兜底（视图/探测早于激活的极端情况）。 */
function installPrefix(): string {
  if (installId) {
    return installId;
  }
  if (!ephemeralId) {
    ephemeralId = newInstallId();
  }
  return ephemeralId;
}

/** 自报家门的 UA：让上游一眼看出这是个正经客户端，而不是匿名脚本。 */
export function clientUserAgent(): string {
  const v = clientVersion || String(extCtx?.extension?.packageJSON?.version || "");
  return v ? `api2kiro-dual/${v}` : "api2kiro-dual";
}

/**
 * 某个会话用的会话 id。同一会话的每一轮都一样（上游靠它做路由 / 缓存亲和），不同会话不同。
 * 没给会话 id（测活、拉模型列表这类不在会话里的请求）就退回安装级前缀。
 */
export function sessionIdFor(conversationId?: string): string {
  const prefix = installPrefix();
  const cid = String(conversationId || "").replace(UNSAFE_RE, "");
  // translate.conversationId 取不到真值时给的是 "unknown"：那不是会话，按"没有会话"处理。
  if (!cid || cid === "unknown") {
    return prefix;
  }
  const room = MAX_SESSION_LEN - prefix.length - 1;
  if (room <= 0) {
    return prefix.slice(0, MAX_SESSION_LEN);
  }
  const part = cid.length > room ? crypto.createHash("sha256").update(cid).digest("hex").slice(0, DIGEST_LEN) : cid;
  return `${prefix}-${part.slice(0, room)}`;
}
