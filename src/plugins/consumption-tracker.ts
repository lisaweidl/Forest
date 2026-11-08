/**
 * consumption-tracker.ts
 *
 * Tracks real resource consumption autonomously.
 * Does NOT rely on The Girl mentioning these values.
 *
 * Runs as an ElizaOS evaluator after every message cycle; writes at most once per hour.
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
 * Constants (Hetzner CX22, NBG1 datacenter):
 *   VM power draw:  ~8W continuous = 0.008 kWh/h
 *   PUE:            1.3 (datacenter overhead)
 *   WUE:            1.6 L/kWh (water usage effectiveness)
 *   VM cost:        €3.79/month = ~€0.000174/h (CX22 Hetzner)
 *   API cost:       claude-sonnet-5-5 (since 8 Nov 2026): $2/M input, $10/M output
 *     (≈ €1.88/M input, €9.40/M output at 0.94 EUR/USD)
 *     Before 8 Nov 2026 the agent ran on claude-sonnet-4-5.
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

const VM_WATTS = 8;
const PUE = 1.3;
const WUE = 1.6;
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

interface SessionStats {
  messageCycles: number;       // persistent, since project start
  solanaTransactions: number;
  lastLedgerWriteMs: number;   // in memory only — the file timestamp also guards
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

function saveMessageCycles(n: number): void {
  try { fsSync.writeFileSync(STATE_PATH, JSON.stringify({ messageCycles: n, updated: new Date().toISOString() })); }
  catch { /* counting is best-effort; never block a message cycle */ }
}

const sessionStats: SessionStats = {
  messageCycles: loadMessageCycles(),
  solanaTransactions: 0,
  lastLedgerWriteMs: 0,
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
  const estimated_water_litres = Math.round(estimated_kwh * WUE * 100) / 100;
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
    const lastTs = new Date(existingRows[existingRows.length - 1].timestamp).getTime();
    if (!isNaN(lastTs) && now - lastTs < HOUR_MS) return;
  }
  const allRows = [...existingRows, newRow];
  let markdown = `# Consumption Ledger\n\n`;
  markdown += `*Accumulating record of what it costs to exist. Updated every hour.*\n\n`;
  markdown += `*Constants: Hetzner CX22 NBG1 — 8W draw, PUE 1.3, WUE 1.6 L/kWh, €3.79/mo VM. Hours, kWh, water and VM cost count from the project start (6 Oct 2026). API cost is an estimate (claude-sonnet-5-5 since 8 Nov 2026). Rows before 8 Nov 2026 counted from the last agent restart and are lower.*\n\n`;
  markdown += `| Time (UTC) | Week | Hours since start | Transactions | Estimated kWh | Water (litres) | VM cost (€) | API cost (€) |\n`;
  markdown += `|---|---|---|---|---|---|---|---|\n`;
  if (allRows.length === 0) {
    markdown += `| — | — | — | — | — | — | — | — |\n`;
  } else {
    for (const row of allRows) {
      markdown += `| ${row.timestamp} | ${row.week} | ${row.uptime_h} | ${row.transactions} | ${row.estimated_kwh} | ${row.estimated_water_litres} | ${row.vm_cost_eur} | ${row.api_cost_eur} |\n`;
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
    const now = Date.now();
    if (now - sessionStats.lastLedgerWriteMs < HOUR_MS) return;
    sessionStats.lastLedgerWriteMs = now;
    try {
      sessionStats.solanaTransactions = await readKeeperTransactionCount();
      const projectStartMs = readProjectStartMs();
      const hoursSinceStart = Math.round(((now - projectStartMs) / HOUR_MS) * 100) / 100;
      const consumption = calculateConsumption(sessionStats, hoursSinceStart);
      const timestamp = new Date(now).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
      const week = Math.max(1, Math.floor((now - projectStartMs) / WEEK_MS) + 1);
      const newRow: ConsumptionRow = { timestamp, week, uptime_h: hoursSinceStart, ...consumption };
      await fs.mkdir(FACTS_DIR, { recursive: true });
      await writeConsumptionLedger(FACTS_DIR, newRow);
      runtime.logger?.info({ src: "consumption-tracker", hours_since_start: hoursSinceStart, week, ...consumption }, "Consumption ledger updated");
    } catch (err) {
      runtime.logger?.warn({ src: "consumption-tracker", err }, "Failed to update consumption ledger");
    }
  },
  examples: [],
};

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

PRICE LEDGER (columns: Time | Week | Uptime_h | SOL_price_USD | USDC_balance | SOL_balance | Note):
${read("ledger_price.md")}

CONSUMPTION LEDGER (columns: Time | Week | Hours_since_project_start | Transactions | kWh | Water_L | VM_cost_EUR | API_cost_EUR_estimated):
${read("ledger_consumption.md")}

RELATION LEDGER (columns: Time | Week | Uptime_h | Refusals | Gifts_sent | Responses_received | Agents_engaged | Notes):
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
};

export default consumptionTrackerPlugin;
