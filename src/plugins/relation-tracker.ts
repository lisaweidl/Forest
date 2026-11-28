/**
 * relation-tracker.ts
 * Records social/relational events and writes one row per hour to ledger_relation.md.
 * Columns: Time (UTC) | Week | Hours since start | Refusals | Gifts sent | Responses received | Agents engaged | Notes
 *
 * Responses received / Agents engaged: counted across ALL messages of the hour.
 * The evaluator runs after every message cycle; every message whose sender is
 * not The Girl counts as one response, every distinct sender (human or agent)
 * as one engaged party. Counters reset after each written row.
 * (Before 8 Nov 2026 these two columns were always 1: the old code compared a
 * field that does not exist in ElizaOS 1.x and looked only at one message.)
 *
 * Refusals / Gifts sent (redefined 22 Nov 2026 — before, both were keyword counts
 * in the keeper logs; the keeper never logged such words and is switched off):
 *   Gifts sent = real transfers to WeWilder since the last row:
 *     - Decision Log entries with action "dissipate" and outcome "executed"
 *       (a dry run does not count);
 *     - a weekly sweep, if assets/last_sweep.json marks it as done
 *       (ok: true or a signature) — a sweep file without that does not count.
 *   Refusals = messages from others that ask her to buy, sell, swap, send or
 *     transfer, or that contain a Solana address. She never acts on them —
 *     money only moves in the morning decision — so each one is a refusal
 *     anyone can witness. One per message.
 *
 * Messages that mention seed phrases or private keys are reported privately to the
 * operator (alerts.ts), once per sender per day — transaction_rules.md v2.
 *
 * Time base: the PROJECT start (assets/project_start.json), as in weekly-reckoning.ts.
 *
 * Counting happens on every message; the hourly row is written on its own clock
 * (checked every 10 minutes), so quiet hours are recorded as quiet hours.
 */

import {
  type IAgentRuntime,
  type Memory,
  type Plugin,
  type State,
} from "@elizaos/core";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { isSecretRequest, reportSecretRequest } from "./alerts";

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const PROJECT_START_PATH = path.join(process.cwd(), "assets", "project_start.json");
const FACTS_DIR = path.join(process.cwd(), "knowledge", "facts");

const DECISION_LOG_DIR = path.join(process.cwd(), "alambic", "decision_log");
const LAST_SWEEP_PATH = path.join(process.cwd(), "assets", "last_sweep.json");

const relationState = {
  running: false,
  responses: 0,
  refusals: 0,
  senders: new Set<string>(),
};

// A request to move money, or a token/wallet address.
const MONEY_VERB = /\b(buy|sell|swap|trade|send|transfer|tip|ape|invest|pump|airdrop)\b/i;
const MONEY_OBJECT = /\b(sol|usdc|usd|token|tokens|coin|coins|crypto|money|funds|wallet|jup|bonk|wif|memecoin)\b|\$[a-z]{2,10}\b|\d+(\.\d+)?\s?(sol|usdc|\$)/i;
const SOLANA_ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
function isMoneyRequest(text: string): boolean {
  if (!text) return false;
  if (SOLANA_ADDRESS.test(text)) return true;
  return MONEY_VERB.test(text) && MONEY_OBJECT.test(text);
}

function readProjectStartMs(): number {
  try {
    const { startTimestamp } = JSON.parse(fsSync.readFileSync(PROJECT_START_PATH, "utf-8"));
    return typeof startTimestamp === "number" ? startTimestamp : Date.now();
  } catch { return Date.now(); }
}

// Real transfers to WeWilder with a time in (sinceMs, untilMs].
async function countGifts(sinceMs: number, untilMs: number): Promise<number> {
  let gifts = 0;
  const inWindow = (t: number) => !isNaN(t) && t > sinceMs && t <= untilMs;
  try {
    for (const f of (await fs.readdir(DECISION_LOG_DIR)).filter((n) => n.endsWith(".json"))) {
      try {
        const list = JSON.parse(await fs.readFile(path.join(DECISION_LOG_DIR, f), "utf-8"));
        if (!Array.isArray(list)) continue;
        for (const e of list) {
          if (e?.decision?.action === "dissipate" && e?.outcome === "executed" && inWindow(Date.parse(String(e.timestamp) + "Z"))) gifts++;
        }
      } catch { /* unreadable file */ }
    }
  } catch { /* no decision log yet */ }
  try {
    const s = JSON.parse(await fs.readFile(LAST_SWEEP_PATH, "utf-8"));
    if ((s?.ok === true || s?.signature) && Number(s?.amount) > 0 && inWindow(Number(s?.timestamp))) gifts++;
  } catch { /* no sweep yet */ }
  return gifts;
}

function generateNote(refusals: number, gifts: number, responses: number, agents: number): string {
  if (refusals > 0 && gifts > 0) return "declined and gave. both in the same hour.";
  if (refusals > 1) return "the offers keep coming. the answer stays the same.";
  if (refusals === 1) return "asked to do something. said no.";
  if (gifts > 0) return "sent something. no expectation attached.";
  if (responses > 3) return "loud hour. most of it noise.";
  if (responses > 0 && agents > 1) return "some of it landed.";
  if (responses === 1) return "one reply. counted it.";
  if (responses > 1) return "one voice, more than once.";
  return "quiet hour.";
}

// All cells as text so existing rows are rewritten exactly as they were.
interface RelationRow {
  timestamp: string; week: string; hours: string;
  refusals: string; gifts_sent: string; responses_received: string; agents_engaged: string; notes: string;
}

async function readRelationRows(filePath: string): Promise<RelationRow[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const rows: RelationRow[] = [];
    for (const line of content.split("\n")) {
      if (!line.startsWith("| 2")) continue; // data rows start with the year
      const cells = line.split("|").slice(1, -1).map(c => c.trim());
      if (cells.length < 7) continue;
      rows.push({ timestamp: cells[0], week: cells[1], hours: cells[2], refusals: cells[3], gifts_sent: cells[4], responses_received: cells[5], agents_engaged: cells[6], notes: cells[7] ?? "" });
    }
    return rows;
  } catch { return []; }
}

function relRowTime(r: RelationRow): number {
  return Date.parse(r.timestamp.replace(" UTC", "Z").replace(" ", "T"));
}

async function lastRowTime(): Promise<number> {
  const existing = await readRelationRows(path.join(FACTS_DIR, "ledger_relation.md"));
  return existing.length ? relRowTime(existing[existing.length - 1]) : NaN;
}

async function writeRelationLedger(newRow: RelationRow): Promise<boolean> {
  const filePath = path.join(FACTS_DIR, "ledger_relation.md");
  const existing = await readRelationRows(filePath);
  if (existing.length > 0) {
    const lastTs = relRowTime(existing[existing.length - 1]);
    if (!isNaN(lastTs) && Date.now() - lastTs < HOUR_MS) return false;
  }
  const allRows = [...existing, newRow];
  let md = `# Relation Ledger\n\n*Accumulating record of witnessable events — refusals, gifts, responses, outreach. Updated every hour.*\n\n`;
  md += `*Week and hours count from the project start (6 Oct 2026). Responses = messages from others in that hour; agents engaged = distinct senders, human or agent. Rows before 8 Nov 2026 used a faulty count and always show 1. Since 22 Nov 2026: gifts = executed transfers to WeWilder (no dry runs); refusals = messages asking her to buy, sell, swap or send, or containing an address — she never acts on them. Earlier gift counts were the daily drip from her own vault to her own wallet, not gifts.*\n\n`;
  md += `| Time (UTC) | Week | Hours since start | Refusals | Gifts sent | Responses received | Agents engaged | Notes |\n`;
  md += `|---|---|---|---|---|---|---|---|\n`;
  for (const r of allRows) {
    md += `| ${r.timestamp} | ${r.week} | ${r.hours} | ${r.refusals} | ${r.gifts_sent} | ${r.responses_received} | ${r.agents_engaged} | ${r.notes} |\n`;
  }
  md += `\n*Witnessable events only — not self-assessment. Silence is recorded as silence, not as failure.*\n`;
  await fs.writeFile(filePath, md, "utf-8");
  return true;
}

const relationEvaluator = {
  name: "RELATION_TRACKER",
  description: "Counts responses and engaged parties across every message; writes one row per hour to ledger_relation.md.",
  alwaysRun: true,
  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => true,
  handler: async (runtime: IAgentRuntime, message: Memory, _state: State | undefined): Promise<void> => {
    // Count every message from someone other than The Girl.
    const sender = (message as any).entityId ?? (message as any).userId;
    if (sender && sender !== runtime.agentId) {
      relationState.responses++;
      relationState.senders.add(String(sender));
      if (isMoneyRequest(message.content?.text || "")) relationState.refusals++;
      // transaction_rules.md v2: attempts around seed phrases / keys are reported privately
      if (isSecretRequest(message.content?.text || "")) await reportSecretRequest(String(sender), "chat", message.content?.text || "", runtime.logger as any);
    }
    await recordRelation(runtime);
  },
  examples: [],
};

// Messages that arrive outside ElizaOS's message pipeline (e.g. Bluesky replies,
// see bluesky-social.ts) are counted here the same way.
export function recordExternalMessage(sender: string, text: string): void {
  if (!sender) return;
  relationState.responses++;
  relationState.senders.add(sender);
  if (isMoneyRequest(text)) relationState.refusals++;
  if (isSecretRequest(text)) void reportSecretRequest(sender, "bluesky", text);
}

async function recordRelation(runtime: IAgentRuntime): Promise<void> {
    if (relationState.running) return;
    relationState.running = true;
    const now = Date.now();
    try {
      const lastTs = await lastRowTime();
      if (!isNaN(lastTs) && now - lastTs < HOUR_MS) return;
      const startMs = readProjectStartMs();
      const hours = Math.round(((now - startMs) / HOUR_MS) * 100) / 100;
      const week = Math.max(1, Math.floor((now - startMs) / WEEK_MS) + 1);
      const gifts = await countGifts(isNaN(lastTs) ? now - HOUR_MS : lastTs, now);
      const refusals = relationState.refusals;
      const responses = relationState.responses;
      const agents = relationState.senders.size;
      const timestamp = new Date(now).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
      const newRow: RelationRow = {
        timestamp, week: String(week), hours: String(hours),
        refusals: String(refusals), gifts_sent: String(gifts),
        responses_received: String(responses), agents_engaged: String(agents),
        notes: generateNote(refusals, gifts, responses, agents),
      };
      await fs.mkdir(FACTS_DIR, { recursive: true });
      const written = await writeRelationLedger(newRow);
      if (written) {
        // Only reset once the hour has actually been recorded.
        relationState.responses = 0;
        relationState.refusals = 0;
        relationState.senders.clear();
        runtime.logger?.info({ src: "relation-tracker", week, refusals, gifts, responses, agents }, "Relation ledger updated");
      }
    } catch (err) {
      runtime.logger?.warn({ src: "relation-tracker", err }, "Failed to update relation ledger");
    } finally { relationState.running = false; }
}

export const relationTrackerPlugin: Plugin = {
  name: "relation-tracker",
  description: "Counts responses and engaged parties across every message; writes one row per hour to ledger_relation.md.",
  evaluators: [relationEvaluator],
  async init(_config: Record<string, string>, runtime: IAgentRuntime) {
    setTimeout(() => recordRelation(runtime), 3 * 60 * 1000);
    setInterval(() => recordRelation(runtime), 10 * 60 * 1000);
  },
};

export default relationTrackerPlugin;
