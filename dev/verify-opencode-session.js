#!/usr/bin/env node
/**
 * OpenCode Go 会话头（x-opencode-session）修复的验证脚本。
 *
 * 背景：opencode.ai/zen/go（OpenCode Go）要求请求带 x-opencode-session，否则一律 400
 * "Request is missing x-opencode-session and cannot be routed efficiently"；这之前扩展从不发这个头
 * （仓库里连字面量都没有），于是「第三方 Key 直连 + OpenCode Go 渠道」配好了也连不上。
 * 上游文档还要求客户端用自己的 UA，而不是通用 SDK / HTTP 库的名字（Node 的 http 默认不发 UA）。
 *
 * 本脚本不用真机、不用外网：把一个 vscode 桩 + 真实的 src 代码用 esbuild 打成一份，
 * 再起一个**本地假网关**（没带 x-opencode-session 就回 400、带了回 200），
 * 让 authHeaders 造出来的头真的走一遍 src/upstream.ts 的 HTTP 层，验证：
 *   P1  models.dev 的 opencode-go 条目能造出预设（md:opencode-go）
 *   P2  预设造出的 provider 带着对的地址 / presetId
 *   P3  authHeaders 发 x-opencode-session（三种协议都发）
 *   P4  同一会话每轮的值相同 —— 稳定，不是每个请求现生成
 *   P5  不同会话的值不同
 *   P6  手填地址 / 导入来的 provider（没有 presetId）也命中
 *   P7  同域的 Zen 本体（/zen/v1）不发 —— 不误伤
 *   P8  其它 provider 一个字节都不变
 *   P9  仿冒域名（opencode.ai.evil.tld）不发
 *   P10 值只含 header 安全字符、长度有上限
 *   P11 端到端：带这个头 → 假网关 200；去掉这个头 → 400（证明头就是那个开关）
 *
 * 用法：node dev/verify-opencode-session.js
 */

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const esbuild = require("esbuild");

const REPO = path.resolve(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "a2k-osc-"));
const STUB = path.join(WORK, "vscode-stub.js");
const ENTRY = path.join(WORK, "entry.ts");
const OUT = path.join(WORK, "entry.js");

// ---------------------------------------------------------------- vscode 桩
const VSCODE_STUB = `
"use strict";
const config = {
  get: (key, def) => def,
  has: () => false,
  inspect: () => undefined,
  update: async () => undefined,
};
const channel = { appendLine() {}, append() {}, replace() {}, clear() {}, show() {}, hide() {}, dispose() {} };
const disposable = { dispose() {} };
module.exports = {
  version: "1.90.0",
  workspace: { getConfiguration: () => config, onDidChangeConfiguration: () => disposable },
  window: {
    createOutputChannel: () => channel,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    withProgress: async (_o, task) => task({ report() {} }, { isCancellationRequested: false }),
    createStatusBarItem: () => ({ text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} }),
    createWebviewPanel: () => ({ webview: { html: "", onDidReceiveMessage: () => disposable, postMessage: async () => true }, onDidDispose: () => disposable, dispose() {} }),
  },
  env: { appRoot: "/tmp", appName: "Kiro", machineId: "stub-machine", openExternal: async () => true },
  Uri: {
    file: (p) => ({ fsPath: p, toString: () => String(p) }),
    parse: (s) => ({ toString: () => String(s) }),
    joinPath: (...parts) => ({ fsPath: parts.map((x) => (x && x.fsPath) || x).join("/") }),
  },
  commands: { executeCommand: async () => undefined, registerCommand: () => disposable },
  EventEmitter: class { constructor() { this.event = () => disposable; } fire() {} dispose() {} },
  Disposable: class { dispose() {} },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { One: 1 },
  ExtensionMode: { Production: 1 },
  l10n: { t: (s) => s },
};
`;

// ---------------------------------------------------------------- 验证入口（TypeScript，跑真实 src 代码）
const entry = (providersPath, clientIdPath, upstreamPath) => `
import * as http from "http";
import { authHeaders, presetFromCatalog, providerFromPreset, type Preset, type ProviderConfig } from ${JSON.stringify(providersPath)};
import { clientUserAgent, initClientIdentity, sessionIdFor } from ${JSON.stringify(clientIdPath)};
import { requestUpstream } from ${JSON.stringify(upstreamPath)};

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra === undefined ? "" : "\\n        " + String(extra))); }
};
const section = (t: string) => console.log("\\n== " + t);

// ---- 激活期：注入一个假的 ExtensionContext，走真实的 initClientIdentity
const stored: Record<string, unknown> = {};
const fakeCtx: any = {
  globalState: {
    get: (k: string, d?: unknown) => (k in stored ? stored[k] : d),
    update: async (k: string, v: unknown) => { stored[k] = v; },
    keys: () => Object.keys(stored),
  },
  extension: { packageJSON: { version: "9.9.9" } },
};
initClientIdentity(fakeCtx);

/** models.dev 上 opencode-go 的条目（2026-06-25 抓自 providers/opencode-go/provider.toml）。 */
const OPENCODE_GO_ENTRY = {
  id: "opencode-go",
  name: "OpenCode Go",
  api: "https://opencode.ai/zen/go/v1",
  npm: "@ai-sdk/openai-compatible",
  env: ["OPENCODE_API_KEY"],
  doc: "https://opencode.ai/docs/zen",
  models: [{ id: "deepseek-v4.1-flash" }, { id: "qwen3.8-max" }],
} as any;
/** 同域另一条通道：opencode.ai/zen/v1（Zen 本体），不要求这个头。 */
const OPENCODE_ZEN_ENTRY = { ...OPENCODE_GO_ENTRY, id: "opencode", name: "OpenCode Zen", api: "https://opencode.ai/zen/v1" } as any;

const mk = (over: Partial<ProviderConfig>): ProviderConfig => ({
  id: "p1", name: "T", protocol: "openai", openaiApi: "chat",
  baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "sk-test", enabled: true,
  exactBase: true, ...over,
} as ProviderConfig);

const main = async () => {
  // ---------------------------------------------------------------- P1/P2 预设链路
  section("预设链路（models.dev 条目 -> 预设 -> provider）");
  const goPreset: Preset | undefined = presetFromCatalog(OPENCODE_GO_ENTRY);
  check("P1  opencode-go 条目能造出预设", !!goPreset && goPreset.id === "md:opencode-go", goPreset && goPreset.id);
  check("P1b 预设地址 = https://opencode.ai/zen/go/v1", goPreset?.baseUrl === "https://opencode.ai/zen/go/v1", goPreset?.baseUrl);
  check("P1c 预设走 openai/chat 协议", goPreset?.protocol === "openai" && goPreset?.openaiApi === "chat", goPreset?.protocol + "/" + goPreset?.openaiApi);
  const goProv = goPreset ? providerFromPreset(goPreset, []) : undefined;
  check("P2  预设造出的 provider 带 presetId=md:opencode-go", goProv?.presetId === "md:opencode-go", goProv?.presetId);
  check("P2b 预设造出的 provider 地址一致", goProv?.baseUrl === "https://opencode.ai/zen/go/v1", goProv?.baseUrl);

  // ---------------------------------------------------------------- P3 头发出来了
  section("请求头");
  const fromPreset = { ...(goProv as ProviderConfig), apiKey: "sk-test" };
  const h1 = authHeaders(fromPreset, false, undefined, "conv-1");
  console.log("        实际会发出去的请求头: " + JSON.stringify(h1));
  check("P3  authHeaders 发 x-opencode-session", typeof h1["x-opencode-session"] === "string" && h1["x-opencode-session"] !== "", JSON.stringify(h1));
  check("P3b authHeaders 发自报家门的 UA", typeof h1["User-Agent"] === "string" && /^api2kiro-dual(\\/|$)/.test(h1["User-Agent"]), h1["User-Agent"]);
  check("P3c 鉴权头没被挤掉", h1["Authorization"] === "Bearer sk-test", h1["Authorization"]);
  check("P3d 手填地址（无 presetId）也命中", (() => { const h = authHeaders(mk({ presetId: undefined }), false, undefined, "c"); return !!h["x-opencode-session"]; })());
  check("P3e anthropic 协议也发", (() => { const h = authHeaders(mk({ protocol: "anthropic", anthropicMode: "official" }), false, undefined, "c"); return !!h["x-opencode-session"] && !!h["x-api-key"]; })());
  check("P3f gemini 协议也发", (() => { const h = authHeaders(mk({ protocol: "gemini" }), false, undefined, "c"); return !!h["x-opencode-session"] && !!h["x-goog-api-key"]; })());

  // ---------------------------------------------------------------- P4/P5 稳定性
  section("会话 id 稳定性");
  const turns = [authHeaders(fromPreset, false, undefined, "conv-A"), authHeaders(fromPreset, false, undefined, "conv-A"), authHeaders(fromPreset, false, undefined, "conv-A")];
  check("P4  同一会话三轮的值完全相同", turns[0]["x-opencode-session"] === turns[1]["x-opencode-session"] && turns[1]["x-opencode-session"] === turns[2]["x-opencode-session"], turns.map((t) => t["x-opencode-session"]).join(" | "));
  const other = authHeaders(fromPreset, false, undefined, "conv-B");
  check("P5  不同会话的值不同", other["x-opencode-session"] !== turns[0]["x-opencode-session"], other["x-opencode-session"]);
  check("P5b 无会话上下文（测活/拉模型列表）落在一个稳定值上", sessionIdFor() === sessionIdFor() && sessionIdFor() !== "", sessionIdFor());

  // ---------------------------------------------------------------- P7/P8/P9 不误伤
  section("不误伤");
  const zen = authHeaders(mk({ presetId: undefined, baseUrl: "https://opencode.ai/zen/v1" }), false, undefined, "c");
  check("P7  Zen 本体（/zen/v1）不发这个头", !("x-opencode-session" in zen), JSON.stringify(zen));
  const deepseek = authHeaders(mk({ presetId: undefined, baseUrl: "https://api.deepseek.com/v1" }), false, undefined, "c");
  check("P8  普通 provider 头部逐字不变", JSON.stringify(deepseek) === JSON.stringify({ Authorization: "Bearer sk-test" }), JSON.stringify(deepseek));
  const evil = authHeaders(mk({ presetId: undefined, baseUrl: "https://opencode.ai.evil.tld/zen/go/v1" }), false, undefined, "c");
  check("P9  仿冒域名不发", !("x-opencode-session" in evil), JSON.stringify(evil));
  const evil2 = authHeaders(mk({ presetId: undefined, baseUrl: "https://not-opencode.ai/zen/go/v1" }), false, undefined, "c");
  check("P9b 别的域名不带 /zen/go 也不发", !("x-opencode-session" in evil2), JSON.stringify(evil2));

  // ---------------------------------------------------------------- P10 值本身
  section("会话 id 取值");
  const messy = sessionIdFor("a b/c\\\\d 中文 \\u0000" + "x".repeat(500));
  check("P10 只含 header 安全字符", /^[A-Za-z0-9._-]+$/.test(messy), messy.slice(0, 60) + "…");
  check("P10b 长度有上限（<=128）", messy.length <= 128, String(messy.length));
  check("P10c 病态长 id 不会两个会话撞一起", sessionIdFor("y".repeat(400)) !== sessionIdFor("z".repeat(400)));
  check("P10d UA 不是通用 SDK 名", /^api2kiro-dual\\/9\\.9\\.9$/.test(clientUserAgent()), clientUserAgent());
  check("P10e 安装级前缀落了 globalState", typeof stored["client.installId"] === "string" && /^[0-9a-f]{32}$/.test(String(stored["client.installId"])), String(stored["client.installId"]));

  // ---------------------------------------------------------------- P11 端到端过 HTTP 层
  section("端到端（真发一次 HTTP，走 src/upstream.ts 那一层）");
  const seen: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    seen.push({ ...req.headers });
    const has = typeof req.headers["x-opencode-session"] === "string" && String(req.headers["x-opencode-session"]) !== "";
    res.writeHead(has ? 200 : 400, { "content-type": "application/json" });
    res.end(JSON.stringify(has ? { ok: true } : { error: { message: "Request is missing x-opencode-session and cannot be routed efficiently." } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  const url = "http://127.0.0.1:" + port + "/zen/go/v1/chat/completions";

  const post = async (headers: Record<string, string>) => {
    const res = await requestUpstream("POST", url, { "Content-Type": "application/json", ...headers }, JSON.stringify({ hi: 1 }), 5000);
    const text = await new Promise<string>((r) => { let s = ""; res.body.setEncoding("utf8"); res.body.on("data", (c: string) => (s += c)); res.body.on("end", () => r(s)); });
    return { status: res.statusCode, text };
  };
  const lastHdr = (n: string) => String((seen[seen.length - 1] || {})[n] || "");

  // 预设那一路（地址被改到本地假网关）——presetId 命中
  const withHeader = await post(authHeaders(fromPreset, false, undefined, "conv-A"));
  check("P11 带头的请求过网关（200）", withHeader.status === 200, withHeader.status + " " + withHeader.text);
  const gotSession = lastHdr("x-opencode-session");
  check("P11b 网关真收到了这个头，且值与 authHeaders 一致", gotSession === authHeaders(fromPreset, false, undefined, "conv-A")["x-opencode-session"], gotSession);
  check("P11c 网关也收到了自报家门的 UA", /^api2kiro-dual\\//.test(lastHdr("user-agent")), lastHdr("user-agent"));

  // 反向对照：把修复加的那个头摘掉，网关必须回 400 —— 证明是它把结果翻过来的
  const old = authHeaders(fromPreset, false, undefined, "conv-A");
  delete old["x-opencode-session"];
  const without = await post(old);
  check("P11d 摘掉这个头就回 400（它就是那个开关）", without.status === 400 && /x-opencode-session/.test(without.text), without.status + " " + without.text);

  // 同会话第二轮：值必须和第一轮一致
  await post(authHeaders(fromPreset, false, undefined, "conv-A"));
  const second = lastHdr("x-opencode-session");
  check("P11e 同会话第二轮的值与第一轮相同", second === gotSession, gotSession + " vs " + second);

  // 按域名命中（没有 presetId）的 provider，头同样真的发得出去
  const hostRes = await post(authHeaders(mk({ presetId: undefined }), false, undefined, "conv-H"));
  check("P11f 按域名命中的 provider 也过网关（200）", hostRes.status === 200, String(hostRes.status));
  check("P11g 其会话值与安装级前缀同源", lastHdr("x-opencode-session").startsWith(String(stored["client.installId"])), lastHdr("x-opencode-session"));

  await new Promise<void>((r) => server.close(() => r()));

  console.log("\\n" + (fail === 0 ? "ALL PASS" : "FAILED") + "  " + pass + " passed, " + fail + " failed");
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((e) => { console.error("harness crashed:", e); process.exit(2); });
`;

// ---------------------------------------------------------------- 构建
async function build() {
  fs.writeFileSync(STUB, VSCODE_STUB, "utf8");
  fs.writeFileSync(
    ENTRY,
    entry(path.join(REPO, "src/providers"), path.join(REPO, "src/clientIdentity"), path.join(REPO, "src/upstream")),
    "utf8"
  );
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: OUT,
    logLevel: "warning",
    plugins: [
      {
        name: "vscode-stub",
        setup(b) {
          b.onResolve({ filter: /^vscode$/ }, () => ({ path: STUB }));
        },
      },
    ],
  });
}

/** 结构检查：krsServer 里每个 upstreamHeaders 调用都必须把会话 id 传下去。 */
function structuralChecks() {
  let pass = 0;
  let fail = 0;
  const check = (name, ok, extra) => {
    if (ok) {
      pass++;
      console.log(`  PASS  ${name}`);
    } else {
      fail++;
      console.log(`  FAIL  ${name}${extra === undefined ? "" : `\n        ${extra}`}`);
    }
  };
  console.log("\n== krsServer 调用点（会话 id 有没有一路传到底）");
  const src = fs.readFileSync(path.join(REPO, "src/krsServer.ts"), "utf8");
  const calls = [...src.matchAll(/this\.upstreamHeaders\((.*?)\);/gs)].map((m) => m[1]);
  check("S1  找得到 upstreamHeaders 调用点", calls.length >= 6, `found ${calls.length}`);
  const missing = calls.filter((a) => !/opts\.convId/.test(a));
  check(`S2  每个调用点都传了 convId（共 ${calls.length} 处）`, missing.length === 0, missing.join(" | "));
  check("S3  upstreamHeaders 形参里有 sessionKey", /private upstreamHeaders\([^)]*sessionKey\?/.test(src));
  check("S4  sessionKey 真的透传给了 authHeaders", /authHeaders\(provider, (true|false), cred, sessionKey\)/.test(src));
  check("S5  DispatchOpts 里带了 convId", /interface DispatchOpts \{[\s\S]*?convId: string;/.test(src));
  check("S6  retryOpts 回填了 convId", /credential: opts\.credential,\s*\n\s*convId,/.test(src));
  return { pass, fail };
}

console.log(`workdir: ${WORK}`);
build().then(() => {
  console.log("\n== 运行验证（真实 src 代码 + 本地假网关）");
  let childOut = "";
  let childFailed = false;
  try {
    childOut = execFileSync(process.execPath, [OUT], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    childOut = String((e && e.stdout) || "");
    childFailed = true;
    if (e && e.stderr) childOut += "\n" + String(e.stderr);
  }
  process.stdout.write(childOut);
  const c = structuralChecks();
  const totalFail = c.fail + (childFailed ? 1 : 0);
  console.log("\n---------------------------------");
  console.log(totalFail === 0 ? "VERIFY OK" : "VERIFY FAILED");
  console.log(`  运行时断言：${childFailed ? "有失败" : "全过"}    结构断言：${c.pass} passed, ${c.fail} failed`);
  process.exit(totalFail === 0 ? 0 : 1);
}).catch((e) => {
  console.error("build failed:", e);
  process.exit(2);
});
