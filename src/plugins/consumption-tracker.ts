/**
 * consumption-tracker.ts
 *
 * Tracks real resource consumption autonomously.
 * Does NOT rely on The Girl mentioning these values.
 *
 * Runs as an ElizaOS evaluator after every message cycle.
 * Reads transaction count from keeper log, calculates kWh/water
 * from fixed physical constants, writes ledger_consumption.md.
 *
 * Constants (Hetzner CX22, NBG1 datacenter):
 *   VM power draw:  ~8W continuous = 0.008 kWh/h
 *   PUE:            1.3 (datacenter overhead)
 *   WUE:            1.6 L/kWh (water usage effectiveness)
 *   VM cost:        €3.79/month = ~€0.000174/h (CX22 Hetzner)
 *   API cost:       estimated from token usage at Anthropic pricing
 *     claude-3-5-haiku: $0.80/M input, $4.00/M output tokens
 *     (≈ €0.75/M input, €3.75/M output at 0.94 EUR/USD)
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
const INPUT_TOKEN_COST_EUR_PER_M = 0.75;
const OUTPUT_TOKEN_COST_EUR_PER_M = 3.75;
const TOKENS_INPUT_PER_CYCLE = 2000;
const TOKENS_OUTPUT_PER_CYCLE = 500;

interface SessionStats {
  messageCycles: number;
  solanaTransactions: number;
  sessionStartMs: number;
  lastLedgerWriteMs: number;
}

const sessionStats: SessionStats = {
  messageCycles: 0,
  solanaTransactions: 0,
  sessionStartMs: Date.now(),
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
  const thirtyMinMs = 60 * 60 * 1000;
  const now = Date.now();
  if (existingRows.length > 0) {
    const lastTs = new Date(existingRows[existingRows.length - 1].timestamp).getTime();
    if (!isNaN(lastTs) && now - lastTs < thirtyMinMs) return;
  }
  const allRows = [...existingRows, newRow];
  let markdown = `# Consumption Ledger\n\n`;
  markdown += `*Accumulating record of what it costs to exist. Updated every hour.*\n\n`;
  markdown += `*Constants: Hetzner CX22 NBG1 — 8W draw, PUE 1.3, WUE 1.6 L/kWh, €3.79/mo VM.*\n\n`;
  markdown += `| Time (UTC) | Week | Uptime (h) | Transactions | Estimated kWh | Water (litres) | VM cost (€) | API cost (€) |\n`;
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
  description: "Tracks real resource consumption (VM, energy, water, API) and writes ledger_consumption.md every 30 minutes.",
  alwaysRun: true,
  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => true,
  handler: async (runtime: IAgentRuntime, _message: Memory, _state: State | undefined): Promise<void> => {
    sessionStats.messageCycles++;
    const thirtyMinMs = 60 * 60 * 1000;
    const now = Date.now();
    if (now - sessionStats.lastLedgerWriteMs < thirtyMinMs) return;
    sessionStats.lastLedgerWriteMs = now;
    try {
      sessionStats.solanaTransactions = await readKeeperTransactionCount();
      const uptimeMs = now - sessionStats.sessionStartMs;
      const uptimeHours = Math.round((uptimeMs / (1000 * 60 * 60)) * 100) / 100;
      const consumption = calculateConsumption(sessionStats, uptimeHours);
      const timestamp = new Date(now).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
      const week = Math.max(1, Math.ceil(uptimeHours / 168));
      const newRow: ConsumptionRow = { timestamp, week, uptime_h: uptimeHours, ...consumption };
      const factsDir = path.join(process.cwd(), "knowledge", "facts");
      await fs.mkdir(factsDir, { recursive: true });
      await writeConsumptionLedger(factsDir, newRow);
      runtime.logger?.info({ src: "consumption-tracker", uptime_h: uptimeHours, ...consumption }, "Consumption ledger updated");
    } catch (err) {
      runtime.logger?.warn({ src: "consumption-tracker", err }, "Failed to update consumption ledger");
    }
  },
  examples: [],
};

// --- Ledger Provider ---
export const ledgerProvider = {
  name: "LEDGER_STATE",
  dynamic: false,
  description: "Current state of all three ledgers",
  get: async (_runtime: IAgentRuntime, _message: Memory): Promise<string> => {
    const base = "/root/the-girl/knowledge/facts";
    const read = (file: string): string => {
      try {
        const lines = fsSync.readFileSync(`${base}/${file}`, "utf8")
          .split("\n")
          .filter(l => l.startsWith("| 2"))
          .slice(-1)[0] ?? "no data yet";
        return lines;
      } catch { return "not available"; }
    };
    return { text: `CURRENT LEDGER STATE (last entry each):\n\nPRICE LEDGER (columns: Time | Week | Inflow_USDC | Balance_USDC | Outflow_USDC | SOL_balance | Notes):\n${read("ledger_price.md")}\n\nCONSUMPTION LEDGER (columns: Time | Week | Uptime_h | Transactions | kWh | Water_L | VM_cost_EUR | API_cost_EUR):\n${read("ledger_consumption.md")}\n\nRELATION LEDGER (columns: Time | Week | Uptime_h | Refusals | Gifts_sent | Responses_received | Agents_engaged | Notes):\n${read("ledger_relation.md")}` };
  }
};

export const consumptionTrackerPlugin: Plugin = {
  name: "consumption-tracker",
  description: "Autonomously tracks VM energy, water, transaction, and API cost consumption. Writes ledger_consumption.md every 30 minutes.",
  evaluators: [consumptionEvaluator],
  providers: [ledgerProvider],
};

export default consumptionTrackerPlugin;
