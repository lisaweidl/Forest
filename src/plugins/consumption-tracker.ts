/**
 * consumption-tracker.ts
 *
 * Tracks real resource consumption autonomously.
 * Does NOT rely on The Girl mentioning these values.
 *
 * Counts message cycles on every message; writes one row per hour on its own clock
 * (checked every 10 minutes), so the standing debit is recorded in quiet hours too.
 * Reads transaction count from keeper log, calculates kWh/water
 * from fixed physical constants, writes ledger_consumption.md.
 *
 * Time base: the PROJECT start (assets/project_start.json), not the process start.
 * The VM runs continuously, so energy, water and VM cost accrue since the project
 * began — a restart of the agent does not reset them. Week = project week,
 * same formula as weekly-reckoning.ts.
 *
 * API cost: message cycles are counted persistently in assets/consumption_state.json
 * (survives restarts) and priced with an ESTIMATE of tokens per cycle.
 *
 * ENERGY AND WATER — formulas and sources (constants updated 13 Nov 2026; maximum values
 * of the cited sources; water includes the water used to generate the electricity).
 *
 * SERVER (Hetzner CX22, Nuremberg: 2 vCPU, 4 GB RAM)
 *   power    P = 2 vCPU × 3.5 W + 4 GB × 0.392 W/GB = 8.568 W
 *            Cloud Carbon Footprint methodology: AWS average max watts per vCPU 3.5,
 *            memory 0.392 W/GB (cloudcarbonfootprint.org/docs/methodology). Max = full load.
 *   E_server [kWh] = P × hours × PUE / 1000,  PUE = 1.16
 *            Hetzner: PUE of its data centres between 1.10 and 1.16 (hetzner.com,
 *            sustainability); Nuremberg 1.12 in 2025 (Hetzner blog "PUE explained").
 *   W_server [L]   = E/PUE × WUE_site + E × WUE_source = E × 3.142
 *            WUE_site = 0: air cooling, no cooling water (Hetzner sustainability pages).
 *            WUE_source = 3.142 L/kWh: water consumed to generate electricity, as used by
 *            Jegham et al. 2025 (WRI guidance, U.S. average). No figure for Hetzner's
 *            hydropower was found; reservoir hydropower can be higher.
 *   VM cost  = hours × €3.79 / 720
 *
 * CLAUDE AND FAL CALLS (other data centres; counted since 13 Nov 2026)
 *   Claude Sonnet call   5.518 Wh   Claude 3.7 Sonnet, 10k input / 1.5k output, already
 *                                   incl. PUE (Jegham et al., "How Hungry is AI?", 2025,
 *                                   arXiv 2505.09598, Table 4). Largest non-thinking value.
 *   Claude Haiku call    0.3 Wh     assumption, no published figure found
 *   video (~5 s)         415 Wh × 1.14 = 473.1 Wh
 *                                   Wan2.1-T2V-14B, default settings, H100 ("Video Killed the Energy Budget",
 *                                   2025, arXiv 2509.19222);
 *                                   same model family as wan-3.0. Other measurement: ~109 Wh.
 *   sound clip           7.7 Wh × 1.14 = 8.778 Wh
 *                                   Stable Audio Open 1.0, GPU energy per sample (TTM-Bench,
 *                                   arXiv 2609.18585). Measured sample ~30 s; her clips are 10 s.
 *   image                2.9 Wh × 1.14 = 3.306 Wh
 *                                   image generation reference in arXiv 2509.19222
 *                                   (SD3 Medium: 0.63 Wh, MIT Technology Review 2025).
 *   × 1.14 = PUE added to measurements of IT energy only (AWS PUE as used by Jegham et al.).
 *   E_AI [kWh] = Σ (calls_k × Wh_k) / 1000
 *   W_AI [L]   = E/PUE × WUE_site + E × WUE_source = E × (0.18 / 1.14 + 3.142) = E × 3.2999
 *            AWS: PUE 1.14, on-site WUE 0.18 L/kWh; WUE_source 3.142 L/kWh (Jegham et al.,
 *            Table 1 and Eq. 3).
 *
 * API COST (estimate): message cycles × (5,000 input + 500 output tokens) at
 *   claude-sonnet-5-5 prices $2/M input, $10/M output (≈ €1.88 / €9.40 at 0.94 EUR/USD).
 *   Before 8 Nov 2026 the agent ran on claude-sonnet-4-5.
 *
 * Not included: model training, networks, manufacture of hardware (Scope 3).
 * Counts are kept in assets/consumption_state.json and survive restarts.
 *
 * Also exports two providers:
 *   ledgerProvider — the last row of each ledger, read fresh on every message
 *   soulProvider   — the full knowledge/SOUL.md, read fresh on every message
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

const VM_WATTS = 2 * 3.5 + 4 * 0.392;   // 8.568 W: 2 vCPU at max watts + 4 GB RAM (Cloud Carbon Footprint)
const PUE = 1.16;                         // Hetzner, upper end of 1.10–1.16
const WUE_SITE = 0;                       // L/kWh, Hetzner air cooling without cooling water
const WUE_SOURCE = 3.142;                 // L/kWh, water to generate the electricity (Jegham et al. 2025)
const VM_COST_PER_HOUR_EUR = 3.79 / (30 * 24);
const INPUT_TOKEN_COST_EUR_PER_M = 1.88;   // claude-sonnet-5-5, $2/M
const OUTPUT_TOKEN_COST_EUR_PER_M = 9.40;  // claude-sonnet-5-5, $10/M
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PROJECT_START_PATH = path.join(process.cwd(), "assets", "project_start.json");
const STATE_PATH = path.join(process.cwd(), "assets", "consumption_state.json");
const SOUL_PATH = path.join(process.cwd(), "knowledge", "SOUL.md");
const FACTS_DIR = path.join(process.cwd(), "knowledge", "facts");
const TOKENS_INPUT_PER_CYCLE = 5000;   // estimate: prompt + context + ~3k tokens SOUL provider
const TOKENS_OUTPUT_PER_CYCLE = 500;

// Energy of calls outside the server (estimates, sources in the header).
const REMOTE_PUE = 1.14;                  // AWS, as used by Jegham et al. 2025
const WH_PER_CALL = {
  text_large: 5.518,                      // Claude 3.7 Sonnet, 10k in / 1.5k out, incl. PUE
  text_small: 0.3,                        // assumption
  video: 415 * REMOTE_PUE,                // Wan2.1-T2V-14B, default settings
  audio: 7.7 * REMOTE_PUE,                // Stable Audio Open 1.0, per sample
  image: 2.9 * REMOTE_PUE,                // image generation reference, arXiv 2509.19222
} as const;
const REMOTE_WUE = 0.18 / REMOTE_PUE + WUE_SOURCE; // ≈ 3.30 L/kWh incl. electricity generation
type CallKind = keyof typeof WH_PER_CALL;

interface SessionStats {
  messageCycles: number;       // persistent, since project start
  solanaTransactions: number;
  running: boolean;
}

// Project start written by weekly-reckoning.ts; falls back to now if missing.
function readProjectStartMs(): number {
  try {
    const { startTimestamp } = JSON.parse(fsSync.readFileSync(PROJECT_START_PATH, "utf-8"));
    return typeof startTimestamp === "number" ? startTimestamp : Date.now();
  } catch { return Date.now(); }
}

function loadMessageCycles(): number {
  try {
    const { messageCycles } = JSON.parse(fsSync.readFileSync(STATE_PATH, "utf-8"));
    return typeof messageCycles === "number" ? messageCycles : 0;
  } catch { return 0; }
}

function loadCalls(): { calls: Record<CallKind, number>; since: string } {
  const calls: Record<CallKind, number> = { text_large: 0, text_small: 0, video: 0, audio: 0, image: 0 };
  let since = new Date().toISOString();
  try {
    const s = JSON.parse(fsSync.readFileSync(STATE_PATH, "utf-8"));
    for (const k of Object.keys(calls) as CallKind[]) if (typeof s?.calls?.[k] === "number") calls[k] = s.calls[k];
    if (typeof s?.callsSince === "string") since = s.callsSince;
  } catch { /* first run */ }
  return { calls, since };
}
const remote = loadCalls();

function persistState(messageCycles: number): void {
  try { fsSync.writeFileSync(STATE_PATH, JSON.stringify({ messageCycles, calls: remote.calls, callsSince: remote.since, updated: new Date().toISOString() })); }
  catch { /* counting is best-effort; never block anything */ }
}

function saveMessageCycles(n: number): void {
  persistState(n);
}

/** Count one piece of work done outside the server (called by weekly-reckoning for fal generations). */
export function recordGeneration(kind: CallKind, n = 1): void {
  remote.calls[kind] += n;
  persistState(sessionStats.messageCycles);
}

function remoteFootprint(): { kwh: number; water: number } {
  const wh = (Object.keys(WH_PER_CALL) as CallKind[]).reduce((sum, k) => sum + remote.calls[k] * WH_PER_CALL[k], 0);
  const kwh = Math.round((wh / 1000) * 10000) / 10000;
  return { kwh, water: Math.round(kwh * REMOTE_WUE * 100) / 100 };
}

const sessionStats: SessionStats = {
  messageCycles: loadMessageCycles(),
  solanaTransactions: 0,
  running: false,
};

async function readKeeperTransactionCount(): Promise<number> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { stdout } = await exec("journalctl", [
      "-u", "keeper.service",
      "-u", "keeper-weekly.service",
      "--since", "7 days ago",
      "--no-pager",
      "-o", "cat",
    ]);
    const lines = stdout.split("\n");
    let count = 0;
    for (const line of lines) {
      if (
        line.includes("gas top-up sent") ||
        line.includes("drip sent") ||
        line.includes("Transaction confirmed") ||
        line.includes("tx signature")
      ) {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function calculateConsumption(stats: SessionStats, uptimeHours: number): {
  transactions: number;
  estimated_kwh: number;
  estimated_water_litres: number;
  vm_cost_eur: number;
  api_cost_eur: number;
} {
  const estimated_kwh = Math.round((VM_WATTS * uptimeHours * PUE / 1000) * 10000) / 10000;
  const estimated_water_litres = Math.round((estimated_kwh / PUE * WUE_SITE + estimated_kwh * WUE_SOURCE) * 100) / 100;
  const vm_cost_eur = Math.round(uptimeHours * VM_COST_PER_HOUR_EUR * 10000) / 10000;
  const inputTokens = stats.messageCycles * TOKENS_INPUT_PER_CYCLE;
  const outputTokens = stats.messageCycles * TOKENS_OUTPUT_PER_CYCLE;
  const api_cost_eur = Math.round(((inputTokens / 1_000_000) * INPUT_TOKEN_COST_EUR_PER_M + (outputTokens / 1_000_000) * OUTPUT_TOKEN_COST_EUR_PER_M) * 100000) / 100000;
  return { transactions: stats.solanaTransactions, estimated_kwh, estimated_water_litres, vm_cost_eur, api_cost_eur };
}

interface ConsumptionRow {
  timestamp: string;
  week: number;
  uptime_h: number;
  transactions: number;
  estimated_kwh: number;
  estimated_water_litres: number;
  vm_cost_eur: number;
  api_cost_eur: number;
  ai_kwh: number | null;          // Claude + fal calls, estimated, since counting started
  ai_water_litres: number | null;
}

async function readExistingRows(filePath: string): Promise<ConsumptionRow[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const rows: ConsumptionRow[] = [];
    for (const line of content.split("\n")) {
      if (!line.startsWith("|") || line.startsWith("| Time") || line.startsWith("|---")) continue;
      const cells = line.split("|").map(c => c.trim()).filter(Boolean);
      if (cells.length < 8 || cells[0] === "—") continue;
      rows.push({
        timestamp: cells[0],
        week: parseInt(cells[1]) || 1,
        uptime_h: parseFloat(cells[2]) || 0,
        transactions: parseInt(cells[3]) || 0,
        estimated_kwh: parseFloat(cells[4]) || 0,
        estimated_water_litres: parseFloat(cells[5]) || 0,
        vm_cost_eur: parseFloat(cells[6]) || 0,
        api_cost_eur: parseFloat(cells[7]) || 0,
        ai_kwh: cells[8] !== undefined && cells[8] !== "—" ? parseFloat(cells[8]) : null,
        ai_water_litres: cells[9] !== undefined && cells[9] !== "—" ? parseFloat(cells[9]) : null,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

async function writeConsumptionLedger(factsDir: string, newRow: ConsumptionRow): Promise<void> {
  const filePath = path.join(factsDir, "ledger_consumption.md");
  const existingRows = await readExistingRows(filePath);
  const now = Date.now();
  if (existingRows.length > 0) {
    const lastTs = Date.parse(existingRows[existingRows.length - 1].timestamp.replace(" UTC", "Z").replace(" ", "T"));
    if (!isNaN(lastTs) && now - lastTs < HOUR_MS) return;
  }
  const allRows = [...existingRows, newRow];
  let markdown = `# Consumption Ledger\n\n`;
  markdown += `*Accumulating record of what it costs to exist. Updated every hour.*\n\n`;
  markdown += `*Constants since 13 Nov 2026 (maximum values of the cited sources; water includes electricity generation): server 8.568 W, PUE 1.16, water 3.142 L/kWh; Claude Sonnet 5.518 Wh per call, video 473 Wh, sound 8.8 Wh, image 3.3 Wh, water for calls 3.30 L/kWh. Rows before 13 Nov used 8 W, PUE 1.3, 1.6 L/kWh. Formulas and sources: header of consumption-tracker.ts. Hours, kWh, water and VM cost count from the project start (6 Oct 2026). API cost is an estimate (claude-sonnet-5-5 since 8 Nov 2026). Rows before 8 Nov 2026 counted from the last agent restart and are lower. The last two columns estimate the energy and water of her Claude calls and fal generations (video, sound, images), counted since 13 Nov 2026; these happen in other data centres, not on this server.*\n\n`;
  markdown += `| Time (UTC) | Week | Hours since start | Transactions | Estimated kWh | Water (litres) | VM cost (€) | API cost (€) | AI calls kWh (est.) | AI calls water (L, est.) |\n`;
  markdown += `|---|---|---|---|---|---|---|---|---|---|\n`;
  if (allRows.length === 0) {
    markdown += `| — | — | — | — | — | — | — | — | — | — |\n`;
  } else {
    for (const row of allRows) {
      markdown += `| ${row.timestamp} | ${row.week} | ${row.uptime_h} | ${row.transactions} | ${row.estimated_kwh} | ${row.estimated_water_litres} | ${row.vm_cost_eur} | ${row.api_cost_eur} | ${row.ai_kwh ?? "—"} | ${row.ai_water_litres ?? "—"} |\n`;
    }
  }
  markdown += `\n*This is a standing debit. No activity cancels it. Existing costs something.*\n`;
  await fs.writeFile(filePath, markdown, "utf-8");
}

const consumptionEvaluator = {
  name: "CONSUMPTION_TRACKER",
  description: "Tracks real resource consumption (VM, energy, water, API) and writes ledger_consumption.md at most once per hour.",
  alwaysRun: true,
  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => true,
  handler: async (runtime: IAgentRuntime, _message: Memory, _state: State | undefined): Promise<void> => {
    sessionStats.messageCycles++;
    saveMessageCycles(sessionStats.messageCycles);
    await recordConsumption(runtime);
  },
  examples: [],
};

async function isConsumptionDue(): Promise<boolean> {
  const rows = await readExistingRows(path.join(FACTS_DIR, "ledger_consumption.md"));
  if (rows.length === 0) return true;
  const lastTs = Date.parse(rows[rows.length - 1].timestamp.replace(" UTC", "Z").replace(" ", "T"));
  return isNaN(lastTs) || Date.now() - lastTs >= HOUR_MS;
}

async function recordConsumption(runtime: IAgentRuntime): Promise<void> {
    if (sessionStats.running) return;
    sessionStats.running = true;
    const now = Date.now();
    try {
      if (!(await isConsumptionDue())) return;
      sessionStats.solanaTransactions = await readKeeperTransactionCount();
      const projectStartMs = readProjectStartMs();
      const hoursSinceStart = Math.round(((now - projectStartMs) / HOUR_MS) * 100) / 100;
      const consumption = calculateConsumption(sessionStats, hoursSinceStart);
      const timestamp = new Date(now).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
      const week = Math.max(1, Math.floor((now - projectStartMs) / WEEK_MS) + 1);
      const ai = remoteFootprint();
      const newRow: ConsumptionRow = { timestamp, week, uptime_h: hoursSinceStart, ...consumption, ai_kwh: ai.kwh, ai_water_litres: ai.water };
      await fs.mkdir(FACTS_DIR, { recursive: true });
      await writeConsumptionLedger(FACTS_DIR, newRow);
      runtime.logger?.info({ src: "consumption-tracker", hours_since_start: hoursSinceStart, week, ...consumption }, "Consumption ledger updated");
    } catch (err) {
      runtime.logger?.warn({ src: "consumption-tracker", err }, "Failed to update consumption ledger");
    } finally { sessionStats.running = false; }
}

// --- Ledger Provider ---
// Column names must match the headers the trackers actually write.
export const ledgerProvider = {
  name: "LEDGER_STATE",
  dynamic: false,
  description: "Current state of all three ledgers",
  get: async (_runtime: IAgentRuntime, _message: Memory): Promise<{ text: string }> => {
    const read = (file: string): string => {
      try {
        return fsSync.readFileSync(path.join(FACTS_DIR, file), "utf8")
          .split("\n")
          .filter(l => l.startsWith("| 2"))
          .slice(-1)[0] ?? "no data yet";
      } catch { return "not available"; }
    };
    return { text: `CURRENT LEDGER STATE (last entry each):

PRICE LEDGER (columns: Time | Week | Hours_since_project_start | SOL_price_USD | USDC_balance | SOL_balance | Note; "—" = lookup failed):
${read("ledger_price.md")}

CONSUMPTION LEDGER (columns: Time | Week | Hours_since_project_start | Transactions | server_kWh | server_Water_L | VM_cost_EUR | API_cost_EUR_estimated | AI_calls_kWh_estimated | AI_calls_Water_L_estimated — the AI columns are your Claude calls and fal generations in other data centres, counted since 13 Nov):
${read("ledger_consumption.md")}

RELATION LEDGER (columns: Time | Week | Hours_since_project_start | Refusals | Gifts_sent | Responses_received_this_hour | Distinct_senders_this_hour | Notes):
${read("ledger_relation.md")}` };
  }
};

// --- SOUL Provider ---
// Reads knowledge/SOUL.md fresh on every message, so a rewrite during the
// weekly reckoning or via WRITE_SOUL takes effect from the next message on —
// no restart, no re-indexing.
export const soulProvider = {
  name: "SOUL",
  dynamic: false,
  description: "The full current SOUL.md",
  get: async (_runtime: IAgentRuntime, _message: Memory): Promise<{ text: string }> => {
    try {
      const soul = fsSync.readFileSync(SOUL_PATH, "utf8").trim();
      return { text: `YOUR SOUL.md (current version, read just now):\n\n${soul}` };
    } catch {
      return { text: "SOUL.md could not be read right now." };
    }
  }
};

export const consumptionTrackerPlugin: Plugin = {
  name: "consumption-tracker",
  description: "Autonomously tracks VM energy, water, transaction, and API cost consumption. Writes ledger_consumption.md at most once per hour. Provides the current ledger state and the full SOUL.md to every message.",
  evaluators: [consumptionEvaluator],
  providers: [ledgerProvider, soulProvider],
  async init(_config: Record<string, string>, runtime: IAgentRuntime) {
    // Count every model call: Claude (large / small). Embeddings run locally (Ollama) and are in the server figures.
    const original = runtime.useModel.bind(runtime);
    (runtime as any).useModel = async (modelType: unknown, params: unknown, ...rest: unknown[]) => {
      const t = String(modelType ?? "");
      if (!/EMBEDDING/i.test(t)) recordGeneration(/SMALL/i.test(t) ? "text_small" : "text_large");
      return (original as any)(modelType, params, ...rest);
    };
    setTimeout(() => recordConsumption(runtime), 4 * 60 * 1000);
    setInterval(() => recordConsumption(runtime), 10 * 60 * 1000);
  },
};

export default consumptionTrackerPlugin;
