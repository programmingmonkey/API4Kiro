#!/usr/bin/env node
/**
 * 只读的延迟/缓存测量工具：从插件的用量账本里取数，按模型和上下文档位切延迟。
 *
 * 用途：做「下调上下文窗口」这类改动的 A/B。改动前后各跑一次，对比 TTFT / 总延迟分位。
 *
 *   node dev/measure-latency.mjs                       # 全部历史
 *   node dev/measure-latency.mjs --since=2026-09-16    # 只看某时刻之后的记录
 *   node dev/measure-latency.mjs --model=deepseek      # 只看模型 id 含该子串的记录
 *   node dev/measure-latency.mjs --json                # 输出原始 JSON 供二次分析
 *
 * 数据源：Kiro 的 globalStorage/state.vscdb → ItemTable → key `api2kiro-dual.api2kiro-dual`
 *         → `usage.ledger.v1.records`（环形缓冲，最多 2000 条）。
 *
 * 注意：本脚本只读，不写任何配置、不碰插件状态。
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DB = path.join(
  os.homedir(),
  "Library/Application Support/Kiro/User/globalStorage/state.vscdb"
);
const STATE_KEY = "api2kiro-dual.api2kiro-dual";

/** 命中率低于此值的请求视为「冷启动」，不计入延迟分位（它们的前缀本来就要重建）。 */
const WARM_HIT = 0.95;

const args = process.argv.slice(2);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const AS_JSON = args.includes("--json");
const MODEL_FILTER = opt("model");
const SINCE = opt("since") ? Date.parse(opt("since")) : undefined;

function readLedger() {
  if (!existsSync(DB)) throw new Error(`找不到 state.vscdb：${DB}`);
  const raw = execFileSync(
    "sqlite3",
    [DB, `select value from ItemTable where key='${STATE_KEY}';`],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
  );
  const state = JSON.parse(raw);
  const recs = state?.["usage.ledger.v1"]?.records;
  if (!Array.isArray(recs)) throw new Error("账本结构不符合预期：usage.ledger.v1.records 不是数组");
  return recs;
}

const ctxOf = (r) => (r.inputTokens || 0) + (r.cacheReadTokens || 0);
const hitOf = (r) => {
  const t = ctxOf(r);
  return t ? (r.cacheReadTokens || 0) / t : 0;
};

const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
const med = (a) => pct([...a].sort((x, y) => x - y), 0.5);

/** 标准分档：用于定位延迟拐点。 */
const BUCKETS = [
  ["       <50K", 0, 50_000],
  ["  50–100K", 50_000, 100_000],
  ["100–150K", 100_000, 150_000],
  ["150–200K", 150_000, 200_000],
  ["200–250K", 200_000, 250_000],
  ["250–300K", 250_000, 300_000],
  ["300–400K", 300_000, 400_000],
  ["400–600K", 400_000, 600_000],
  ["    600K+", 600_000, Infinity],
];

function summarize(rows, label) {
  const ok = rows.filter((r) => r.ok && r.latencyMs);
  const total = rows.reduce((n, r) => n + 1, 0);
  const tin = rows.reduce((n, r) => n + (r.inputTokens || 0), 0);
  const cr = rows.reduce((n, r) => n + (r.cacheReadTokens || 0), 0);
  const ctxs = ok.map(ctxOf).sort((a, b) => a - b);
  const ttf = ok.filter((r) => r.firstTokenMs).map((r) => r.firstTokenMs).sort((a, b) => a - b);
  const lat = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const warm = ok.filter((r) => hitOf(r) >= WARM_HIT);
  return {
    label,
    n: total,
    okN: ok.length,
    failN: total - ok.length,
    hitRate: tin + cr ? cr / (tin + cr) : 0,
    ctxP50: med(ctxs),
    ctxP90: pct(ctxs, 0.9),
    ttft: { p50: med(ttf), p90: pct(ttf, 0.9), n: ttf.length },
    lat: { p50: med(lat), p90: pct(lat, 0.9) },
    warmN: warm.length,
    buckets: BUCKETS.map(([lbl, lo, hi]) => {
      const sub = warm.filter((r) => ctxOf(r) >= lo && ctxOf(r) < hi);
      return {
        label: lbl.trim(),
        n: sub.length,
        ttft: sub.length >= 3 ? med(sub.map((r) => r.firstTokenMs || 0)) : null,
        lat: sub.length >= 3 ? med(sub.map((r) => r.latencyMs)) : null,
      };
    }),
  };
}

const fmt = (n) => (n ? n.toLocaleString("en-US") : "—");
const ms = (n) => (n ? `${Math.round(n).toLocaleString("en-US")}ms` : "—");

function print(s) {
  console.log(`\n════ ${s.label} ════`);
  console.log(
    `  请求 ${s.n}（成功 ${s.okN}，失败 ${s.failN}）  缓存命中率 ${
      (s.hitRate * 100).toFixed(1)
    }%  上下文 p50=${fmt(s.ctxP50)} p90=${fmt(s.ctxP90)}`
  );
  console.log(
    `  TTFT    p50=${ms(s.ttft.p50)}  p90=${ms(s.ttft.p90)}   (n=${s.ttft.n})`
  );
  console.log(`  总延迟  p50=${ms(s.lat.p50)}  p90=${ms(s.lat.p90)}`);
  console.log(`\n  ${"上下文档位".padEnd(12)}${"n".padStart(5)}${"TTFT中位".padStart(11)}${"总延迟中位".padStart(12)}   （仅命中率≥95%的暖请求）`);
  for (const b of s.buckets) {
    if (!b.n) continue;
    const bar = b.ttft ? "█".repeat(Math.min(40, Math.round(b.ttft / 800))) : "";
    console.log(
      `  ${b.label.padEnd(12)}${String(b.n).padStart(5)}${
        b.ttft ? ms(b.ttft).padStart(11) : "样本不足".padStart(11)
      }${b.lat ? ms(b.lat).padStart(12) : "".padStart(12)}  ${bar}`
    );
  }
}

/** 拐点检测：200K 后 TTFT 相对 150–200K 的放大倍数。 */
function knee(s) {
  const lo = s.buckets.find((b) => b.label === "150–200K");
  const hi = s.buckets.find((b) => b.label === "200–250K");
  if (!lo?.ttft || !hi?.ttft) return null;
  return hi.ttft / lo.ttft;
}

// ── 主流程 ────────────────────────────────────────────────────────────────
let recs = readLedger();
const allN = recs.length;

if (SINCE) recs = recs.filter((r) => (r.ts || 0) >= SINCE);
if (MODEL_FILTER) {
  const f = MODEL_FILTER.toLowerCase();
  recs = recs.filter((r) => String(r.model || "").toLowerCase().includes(f));
}

if (!recs.length) {
  console.log("没有符合条件的记录。");
  process.exit(0);
}

// 按模型 id 聚合
const byModel = new Map();
for (const r of recs) {
  const k = r.model || "(unknown)";
  if (!byModel.has(k)) byModel.set(k, []);
  byModel.get(k).push(r);
}

const summaries = [...byModel.entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .map(([m, rows]) => summarize(rows, m));

if (AS_JSON) {
  // db 写成家目录相对形式：这个 JSON 可能被提交进仓库，不应带出用户名。
  console.log(
    JSON.stringify(
      { db: DB.replace(os.homedir(), "~"), since: SINCE ?? null, modelFilter: MODEL_FILTER ?? null, summaries },
      null,
      2
    )
  );
  process.exit(0);
}

console.log(`数据源 ${DB}`);
console.log(
  `账本共 ${allN} 条` +
    (SINCE ? ` · 过滤后 ${recs.length} 条（--since=${new Date(SINCE).toISOString()}）` : "") +
    (MODEL_FILTER ? ` · 模型含 "${MODEL_FILTER}"` : "")
);

for (const s of summaries) print(s);

// 汇总每个模型的拐点倍数
const kn = summaries
  .map((s) => [s.label, knee(s), s.buckets.find((b) => b.label === "200–250K")?.n || 0])
  .filter(([, k]) => k !== null);
if (kn.length) {
  console.log(`\n════ 拐点（200–250K 的 TTFT ÷ 150–200K 的 TTFT）════`);
  for (const [m, k, n] of kn) {
    const verdict = k >= 1.6 ? "⚠ 明显拐点" : k >= 1.25 ? "· 轻微" : "✓ 平坦";
    console.log(`  ${m.padEnd(34)} ${k.toFixed(2)}x  (200–250K 样本 ${n})  ${verdict}`);
  }
}
console.log();
