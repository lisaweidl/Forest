/**
 * consumption-tracker.ts
 *
 * Tracks real resource consumption autonomously.
 * Runs as ElizaOS evaluator, writes ledger_consumption.md every 30 min.
 *
 * Constants (Hetzner CX22, NBG1):
 *   VM power: ~8W, PUE 1.3, WUE 1.6 L/kWh, VM €3.79/mo
 *   API: claude haiku ~€0.75/M input, €3.75/M output
 */
import { type IAgentRuntime, type Memory, type Plugin, type State } from "@elizaos/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const VM_WATTS = 8;
const PUE = 1.3;
const WUE = 1.6;
const VM_COST_PER_HOUR_EUR = 3.79 / (30 * 24);
const INPUT_TOKEN_COST_EUR_PER_M = 0.75;
const OUTPUT_TOKEN_COST_EUR_PER_M = 3.75;
const TOKENS_INPUT_PER_CYCLE = 2000;
const TOKENS_OUTPUT_PER_CYCLE = 500;

const sessionStats = {
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
      "-u", "keeper.service", "-u", "keeper-weekly.service",
      "--since", "7 days ago", "--no-pager", "-o", "cat",
    ]);
    let count = 0;
    for (const line of stdout.split("\n")) {
      if (line.includes("gas top-up sent") || line.includes("drip sent") ||
          line.includes("Transaction confirmed") || line.includes("tx signature")) {
        count++;
      }
    }
    return count;
  } catch { return 0; }
}

function calculateConsumption(cycles: number, txCount: number, uptimeHours: number) {
  const estimated_kwh = Math.round((VM_WATTS * uptimeHours * PUE / 1000) * 10000) / 10000;
  const estimated_water_litres = Math.round(estimated_kwh * WUE * 100) / 100;
  const vm_cost_eur = Math.round(uptimeHours * VM_COST_PER_HOUR_EUR * 10000) / 10000;
  const api_cost_eur = Math.round(
    ((cycles * TOKENS_INPUT_PER_CYCLE / 1_000_000) * INPUT_TOKEN_COST_EUR_PER_M +
     (cycles * TOKENS_OUTPUT_PER_CYCLE / 1_000_000) * OUTPUT_TOKEN_COST_EUR_PER_M) * 100000
  ) / 100000;
  return { transactions: txCount, estimated_kwh, estimated_water_litres, vm_cost_eur, api_cost_eur };
}

async function readExistingRows(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content.split("\n")
      .filter(l => l.startsWith("|") && !l.startsWith("| Time") && !l.startsWith("|---") && !l.includes("— |"));
  } catch { return []; }
}

async function writeConsumptionLedger(factsDir: string, newRow: string, now: number): Promise<void> {
  const filePath = path.join(factsDir, "ledger_consumption.md");
  const existingRows = await readExistingRows(filePath);

  if (existingRows.length > 0) {
    const lastLine = existingRows[existingRows.length - 1];
    const match = lastLine.match(/\|\s*([^|]+UTC)/);
    if (match) {
      const lastTs = new Date(match[1].trim().replace(" UTC", "Z")).getTime();
      if (!isNaN(lastTs) && now - lastTs < 30 * 60 * 1000) return;
    }
  }

  let md = `# Consumption Ledger\n\n`;
  md += `*Accumulating record of what it costs to exist. Updated every 30 minutes.*\n\n`;
  md += `*Constants: Hetzner CX22 NBG1 — 8W draw, PUE 1.3, WUE 1.6 L/kWh, €3.79/mo VM.*\n\n`;
  md += `| Time (UTC) | Uptime (h) | Transactions | Estimated kWh | Water (litres) | VM cost (€) | API cost (€) |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  for (const row of [...existingRows, newRow]) md += row + "\n";
  md += `\n*This is a standing debit. No activity cancels it. Existing costs something.*\n`;

  await fs.writeFile(filePath, md, "utf-8");
}

const consumptionEvaluator = {
  name: "CONSUMPTION_TRACKER",
  description: "Tracks VM energy, water, Solana transactions, API cost. Writes ledger_consumption.md every 30 min.",
  alwaysRun: true,
  validate: async () => true,
  handler: async (runtime: IAgentRuntime, _message: Memory, _state: State | undefined): Promise<void> => {
    sessionStats.messageCycles++;
    const now = Date.now();
    if (now - sessionStats.lastLedgerWriteMs < 30 * 60 * 1000) return;
    sessionStats.lastLedgerWriteMs = now;
    try {
      sessionStats.solanaTransactions = await readKeeperTransactionCount();
      const uptimeHours = Math.round((now - sessionStats.sessionStartMs) / (1000 * 60 * 60) * 100) / 100;
      const c = calculateConsumption(sessionStats.messageCycles, sessionStats.solanaTransactions, uptimeHours);
      const ts = new Date(now).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
      const row = `| ${ts} | ${uptimeHours} | ${c.transactions} | ${c.estimated_kwh} | ${c.estimated_water_litres} | ${c.vm_cost_eur} | ${c.api_cost_eur} |`;
      const factsDir = path.join(process.cwd(), "knowledge", "facts");
      await fs.mkdir(factsDir, { recursive: true });
      await writeConsumptionLedger(factsDir, row, now);
      runtime.logger?.info({ src: "consumption-tracker", uptimeHours, ...c }, "Consumption ledger updated");
    } catch (err) {
      runtime.logger?.warn({ src: "consumption-tracker", err }, "Failed to update consumption ledger");
    }
  },
  examples: [],
};

export const consumptionTrackerPlugin: Plugin = {
  name: "consumption-tracker",
  description: "Autonomously tracks VM energy, water, transactions, API cost. Writes ledger_consumption.md every 30 min.",
  evaluators: [consumptionEvaluator],
};

export default consumptionTrackerPlugin;
