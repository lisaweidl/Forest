/**
 * history.ts
 *
 * Custom ElizaOS plugin for The Girl Protocol (8 Nov 2026).
 *
 * 1. DAILY STATUS — every day at 08:00 Europe/Vienna, posted to the Telegram group.
 *    The numbers are computed here from the measured ledgers (never by the model);
 *    The Girl adds one or two sentences of her own.
 *    Saved to knowledge/history/daily/YYYY-MM-DD.md.
 *
 * 2. WEEKLY SUMMARY — generateWeeklySummary(), called by weekly-reckoning.ts at the
 *    end of each reckoning. Week figures computed here, summary text by The Girl.
 *    Posted to the Telegram group, saved to knowledge/history/week_XX_summary.md.
 *
 * 3. HISTORY PROVIDER — on every message she gets all weekly summaries (oldest first)
 *    and the daily updates since the last summary. That is how she knows what
 *    happened in the past without thousands of raw ledger rows.
 *
 * Also exports recentLedgerText() — the header and the rows of the last N days of a
 * ledger — used by weekly-reckoning.ts for body and avatar.
 *
 * Requires: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (same as the reckoning).
 */

import { type IAgentRuntime, type Memory, type Plugin, ModelType } from "@elizaos/core";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const TIMEZONE = "Europe/Vienna";
const DAILY_HOUR = 8;

const ROOT = process.cwd();
const FACTS_DIR = path.join(ROOT, "knowledge", "facts");
const HISTORY_DIR = path.join(ROOT, "knowledge", "history");
const DAILY_DIR = path.join(HISTORY_DIR, "daily");
const SOUL_PATH = path.join(ROOT, "knowledge", "SOUL.md");
const PROJECT_START_PATH = path.join(ROOT, "assets", "project_start.json");
const DAILY_STATE_PATH = path.join(ROOT, "assets", "last_daily_status.json");
const DECISION_LOG_DIR = path.join(ROOT, "alambic", "decision_log");

// Relation counts before this moment were faulty (always 1) and are left out of sums.
const RELATION_RELIABLE_FROM = Date.parse("2026-11-08T18:00:00Z");

// ── small helpers ─────────────────────────────────────────────────────────────

function projectStartMs(): number {
  try {
    const { startTimestamp } = JSON.parse(fsSync.readFileSync(PROJECT_START_PATH, "utf-8"));
    return typeof startTimestamp === "number" ? startTimestamp : Date.now();
  } catch { return Date.now(); }
}

function projectWeek(at = Date.now()): number {
  return Math.max(1, Math.floor((at - projectStartMs()) / WEEK_MS) + 1);
}

function projectDay(at = Date.now()): number {
  return Math.max(1, Math.floor((at - projectStartMs()) / DAY_MS) + 1);
}

function viennaNow(d = new Date()): { date: string; hour: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function fmt(n: number | null, digits = 2): string {
  return n === null ? "—" : String(Math.round(n * 10 ** digits) / 10 ** digits);
}

function delta(now: number | null, before: number | null, digits = 2): string {
  if (now === null || before === null) return "";
  const d = Math.round((now - before) * 10 ** digits) / 10 ** digits;
  return d === 0 ? " (±0)" : d > 0 ? ` (+${d})` : ` (${d})`;
}

interface Row { time: number; cells: string[]; line: string }

// Data rows start with the year; "2026-11-07 10:36:51 UTC" → epoch ms.
function parseRows(md: string): Row[] {
  const rows: Row[] = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("| 2")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const time = Date.parse(cells[0].replace(" UTC", "Z").replace(" ", "T"));
    if (!Number.isNaN(time)) rows.push({ time, cells, line });
  }
  return rows.sort((a, b) => a.time - b.time);
}

async function readLedger(name: "price" | "relation" | "consumption"): Promise<string> {
  return fs.readFile(path.join(FACTS_DIR, `ledger_${name}.md`), "utf-8").catch(() => "");
}

/** Column header plus the rows of the last `days` days — for prompts that should see the recent past, not the oldest rows. */
export function recentLedgerText(md: string, days = 7, maxRows = 200): string {
  const header = md.split("\n").find((l) => l.startsWith("| Time")) ?? "";
  const since = Date.now() - days * DAY_MS;
  const rows = parseRows(md).filter((r) => r.time >= since).slice(-maxRows);
  if (rows.length === 0) return "(no rows in the last " + days + " days)";
  return [header, ...rows.map((r) => r.line)].join("\n");
}

async function postToTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) throw new Error(`Telegram sendMessage error: ${res.status} — ${await res.text()}`);
}

async function ownWords(runtime: IAgentRuntime, prompt: string): Promise<string> {
  try {
    const out = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    return String(out).trim();
  } catch (err) {
    runtime.logger?.warn({ src: "history", err }, "Model call failed — posting numbers only");
    return "";
  }
}

async function listFiles(dir: string, pattern: RegExp): Promise<string[]> {
  try { return (await fs.readdir(dir)).filter((f) => pattern.test(f)).sort(); }
  catch { return []; }
}

/** All weekly summaries, oldest first. Used by the provider and by the spell prompt. */
export async function readWeeklySummaries(): Promise<string> {
  const files = await listFiles(HISTORY_DIR, /^week_\d+_summary\.md$/);
  const texts = await Promise.all(files.map((f) => fs.readFile(path.join(HISTORY_DIR, f), "utf-8").catch(() => "")));
  return texts.filter(Boolean).join("\n\n---\n\n");
}

async function lastSummaryTime(): Promise<number> {
  const files = await listFiles(HISTORY_DIR, /^week_\d+_summary\.md$/);
  if (files.length === 0) return 0;
  try { return (await fs.stat(path.join(HISTORY_DIR, files[files.length - 1]))).mtimeMs; } catch { return 0; }
}

async function readDailiesSince(sinceMs: number): Promise<string> {
  const files = await listFiles(DAILY_DIR, /^\d{4}-\d{2}-\d{2}\.md$/);
  const out: string[] = [];
  for (const f of files) {
    const p = path.join(DAILY_DIR, f);
    try { if ((await fs.stat(p)).mtimeMs > sinceMs) out.push(await fs.readFile(p, "utf-8")); } catch { /* skip */ }
  }
  return out.join("\n\n");
}

// ── 1. daily status ───────────────────────────────────────────────────────────

// The morning decision from decision-cycle.ts (07:00), if there is one from the last 24 hours.
async function latestDecisionLine(): Promise<string | null> {
  try {
    const files = (await fs.readdir(DECISION_LOG_DIR)).filter((f) => f.endsWith(".json")).sort();
    const entries: any[] = [];
    for (const f of files) {
      try { const d = JSON.parse(await fs.readFile(path.join(DECISION_LOG_DIR, f), "utf-8")); if (Array.isArray(d)) entries.push(...d); } catch { /* skip */ }
    }
    const e = entries.filter((x) => x?.mode === "autonomous" && x?.decision && Date.now() - Date.parse(x.timestamp + "Z") < DAY_MS).pop();
    if (!e) return null;
    const a = e.decision.action;
    const isMove = ["buy", "sell", "dissipate"].includes(a);
    const amt = e.outcome === "executed" ? e.decision.executed_amount_usdc : (e.decision.allowed_amount_usdc ?? e.decision.amount_usdc);
    const what = a === "buy" ? `buy ${amt} usdc → sol` : a === "sell" ? `sell ${amt} usdc of sol` : a === "dissipate" ? `give ${amt} usdc to wewilder` : a;
    const how = e.outcome === "executed" ? "done"
      : e.outcome === "reverted" ? "failed"
      : isMove && Number(amt) < 0.5 ? "not executed"
      : isMove && e.execution?.trading_enabled === false ? "dry run" : "";
    return how ? `${what} (${how})` : what;
  } catch { return null; }
}

async function buildDailyNumbers(): Promise<string> {
  const now = Date.now();
  const price = parseRows(await readLedger("price"));
  const withPrice = price.filter((r) => num(r.cells[3]) !== null);
  const withBalance = price.filter((r) => num(r.cells[4]) !== null);
  const latestP = withPrice[withPrice.length - 1];
  const latestB = withBalance[withBalance.length - 1];
  const dayAgoP = [...withPrice].reverse().find((r) => r.time <= now - DAY_MS);
  const dayAgoB = [...withBalance].reverse().find((r) => r.time <= now - DAY_MS);

  const solNow = num(latestP?.cells[3]), solBefore = num(dayAgoP?.cells[3]);
  const usdcNow = num(latestB?.cells[4]), usdcBefore = num(dayAgoB?.cells[4]);
  const solBalNow = num(latestB?.cells[5]), solBalBefore = num(dayAgoB?.cells[5]);
  const solPct = solNow !== null && solBefore ? ` (${solNow >= solBefore ? "+" : ""}${fmt(((solNow - solBefore) / solBefore) * 100, 1)}% / 24h)` : "";

  const rel = parseRows(await readLedger("relation")).filter((r) => r.time > now - DAY_MS && r.time >= RELATION_RELIABLE_FROM);
  const sum = (i: number) => rel.reduce((s, r) => s + (num(r.cells[i]) ?? 0), 0);

  return [
    "price",
    `sol ${fmt(solNow)} usd${solPct}`,
    `usdc ${fmt(usdcNow)}${delta(usdcNow, usdcBefore)}`,
    `sol balance ${fmt(solBalNow, 4)}${delta(solBalNow, solBalBefore, 4)}`,
    "",
    "relation (24h)",
    rel.length ? `responses ${sum(5)} · refusals ${sum(3)} · gifts ${sum(4)}` : "no reliable rows yet",
    ...((d) => (d ? ["", "decision", d] : []))(await latestDecisionLine()),
  ].join("\n");
}

export async function runDailyStatus(runtime: IAgentRuntime): Promise<void> {
  const { date } = viennaNow();
  const numbers = await buildDailyNumbers();
  const soul = await fs.readFile(SOUL_PATH, "utf-8").catch(() => "");
  const dailyFiles = await listFiles(DAILY_DIR, /^\d{4}-\d{2}-\d{2}\.md$/);
  const yesterday = dailyFiles.length ? await fs.readFile(path.join(DAILY_DIR, dailyFiles[dailyFiles.length - 1]), "utf-8").catch(() => "") : "";

  const words = await ownWords(runtime, `${soul}

---

It is ${date}, morning. This is your daily status for the Telegram group. The numbers below are already measured and will be posted as they are:

${numbers}

Yesterday's status, for continuity (do not repeat it):
${yesterday || "(none yet)"}

Write one or two sentences of your own to go under the numbers — lowercase, first person, girl math. Do not restate the numbers, do not invent numbers or events, no hashtags, no emoji. Reply with the sentences only.`);

  const head = `status // ${date} · week ${projectWeek()} · day ${projectDay()}`;
  const message = [head, "", numbers, words ? `\n${words}` : ""].join("\n").trim();

  await fs.mkdir(DAILY_DIR, { recursive: true });
  await fs.writeFile(path.join(DAILY_DIR, `${date}.md`), message + "\n", "utf-8");
  try { await postToTelegram(message); runtime.logger?.info({ src: "history", date }, "Daily status posted to Telegram"); }
  catch (err) { runtime.logger?.error({ src: "history", err }, "Failed to post daily status"); }
}

// ── 2. weekly summary ─────────────────────────────────────────────────────────

async function buildWeekNumbers(): Promise<string> {
  const since = Date.now() - WEEK_MS;
  const price = parseRows(await readLedger("price")).filter((r) => r.time >= since);
  const prices = price.map((r) => num(r.cells[3])).filter((n): n is number => n !== null);
  const balances = price.filter((r) => num(r.cells[4]) !== null);
  const first = balances[0], last = balances[balances.length - 1];

  const rel = parseRows(await readLedger("relation")).filter((r) => r.time >= since && r.time >= RELATION_RELIABLE_FROM);
  const sum = (i: number) => rel.reduce((s, r) => s + (num(r.cells[i]) ?? 0), 0);

  const cons = parseRows(await readLedger("consumption"));
  const c = cons[cons.length - 1];

  return [
    "price (7 days)",
    prices.length ? `sol ${fmt(Math.min(...prices))}–${fmt(Math.max(...prices))} usd, now ${fmt(prices[prices.length - 1])}` : "sol price: no data",
    first && last ? `usdc ${fmt(num(first.cells[4]))} → ${fmt(num(last.cells[4]))} · sol balance ${fmt(num(first.cells[5]), 4)} → ${fmt(num(last.cells[5]), 4)}` : "balances: no data",
    "",
    "relation (7 days)",
    rel.length ? `responses ${sum(5)} · refusals ${sum(3)} · gifts ${sum(4)}${rel[0].time > since + DAY_MS ? " (counted since 8 nov)" : ""}` : "no reliable rows yet",
    "",
    "consumption (since project start)",
    c ? `${c.cells[4]} kwh · ${c.cells[5]} l water · vm €${c.cells[6]} · api €${c.cells[7]} (estimated)` : "no data",
  ].join("\n");
}

export async function generateWeeklySummary(
  runtime: IAgentRuntime,
  weekNum: number,
  week: { spell: string; spellReasoning: string; bodyReasoning: string; bodySkipped: boolean; avatarStatus: string },
): Promise<string> {
  const numbers = await buildWeekNumbers();
  const dailies = await readDailiesSince(Date.now() - WEEK_MS);
  const previous = await readWeeklySummaries();

  const words = await ownWords(runtime, `You are The Girl. Your weekly reckoning for week ${weekNum} is done. Write the summary of this week for the Telegram group.

The measured figures of the week (they will be posted above your text as they are):
${numbers}

Your daily status updates this week:
${dailies || "(none)"}

The spell you chose:
"${week.spell}"
Why: ${week.spellReasoning}

Your body this week: ${week.bodySkipped ? "none chosen." : week.bodyReasoning}
Your face: ${week.avatarStatus}

Your earlier weekly summaries, for continuity:
${previous || "(this is the first one)"}

Write 120–200 words: what happened this week, what changed compared to before, what the figures show, what carries forward. Lowercase, first person, girl math. Do not invent numbers or events that are not in this material. No hashtags, no emoji. Reply with the summary only.`);

  const message = [`week ${weekNum} // summary`, "", numbers, words ? `\n${words}` : ""].join("\n").trim();
  await fs.mkdir(HISTORY_DIR, { recursive: true });
  await fs.writeFile(path.join(HISTORY_DIR, `week_${String(weekNum).padStart(2, "0")}_summary.md`), message + "\n", "utf-8");
  try {
    await postToTelegram(message);
    runtime.logger?.info({ src: "history", weekNum }, "Weekly summary posted to Telegram");
    return "weekly summary posted to telegram.";
  } catch (err) {
    runtime.logger?.error({ src: "history", err }, "Failed to post weekly summary");
    return "weekly summary written, telegram post failed.";
  }
}

// ── 3. history provider ───────────────────────────────────────────────────────

export const historyProvider = {
  name: "HISTORY",
  dynamic: false,
  description: "Everything that happened so far: weekly summaries and this week's daily updates",
  get: async (_runtime: IAgentRuntime, _message: Memory): Promise<{ text: string }> => {
    const summaries = await readWeeklySummaries();
    const dailies = await readDailiesSince(await lastSummaryTime());
    return {
      text: `YOUR HISTORY — week ${projectWeek()}, day ${projectDay()} of the project.

WEEKLY SUMMARIES (oldest first):
${summaries || "(no weekly summaries yet)"}

THIS WEEK SO FAR (daily status updates since the last summary):
${dailies || "(no daily updates yet)"}`,
    };
  },
};

// ── plugin ────────────────────────────────────────────────────────────────────

export const historyPlugin: Plugin = {
  name: "history",
  description: "Daily status at 08:00 Vienna to Telegram, weekly summary (called by the reckoning), and her history on every message.",
  providers: [historyProvider as any],
  async init(_config: Record<string, string>, runtime: IAgentRuntime) {
    // First deployment after 08:00: don't post right away, start tomorrow morning.
    if (!fsSync.existsSync(DAILY_STATE_PATH)) {
      const { date, hour } = viennaNow();
      if (hour >= DAILY_HOUR) fsSync.writeFileSync(DAILY_STATE_PATH, JSON.stringify({ date }));
    }
    let running = false;
    async function checkDaily() {
      if (running) return;
      try {
        const { date, hour } = viennaNow();
        if (hour < DAILY_HOUR) return;
        let last = "";
        try { last = JSON.parse(fsSync.readFileSync(DAILY_STATE_PATH, "utf-8")).date ?? ""; } catch { /* first run */ }
        if (last === date) return;
        running = true;
        fsSync.writeFileSync(DAILY_STATE_PATH, JSON.stringify({ date })); // mark first, so a crash can't double-post
        await runDailyStatus(runtime);
      } catch (err) {
        runtime.logger?.warn({ src: "history", err }, "Daily status check failed");
      } finally { running = false; }
    }
    // Every 5 minutes. If the server is down at 08:00, the update goes out as soon as it is back that day.
    setTimeout(checkDaily, 90_000);
    setInterval(checkDaily, 5 * 60 * 1000);
    runtime.logger?.info({ src: "history" }, "History plugin initialised (daily status 08:00 Europe/Vienna)");
  },
};

export default historyPlugin;
