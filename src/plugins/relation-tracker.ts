/**
 * relation-tracker.ts
 * Autonomously records social/relational events every hour.
 * Writes to ledger_relation.md.
 * Columns: Time (UTC) | Week | Uptime (h) | Refusals | Gifts sent | Responses received | Agents engaged | Notes
 */

import {
  type IAgentRuntime,
  type Memory,
  type Plugin,
  type State,
} from "@elizaos/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const relationState = {
  sessionStartMs: Date.now(),
  lastWriteMs: 0,
  lastMessageCount: 0,
};

async function readRecentLogs(since: string): Promise<string[]> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { stdout } = await exec("journalctl", ["-u", "keeper.service", "--since", since, "--no-pager", "-o", "cat"]);
    return stdout.split("\n");
  } catch { return []; }
}

async function countRefusals(sinceHours = 1): Promise<number> {
  const lines = await readRecentLogs(`${sinceHours} hours ago`);
  return lines.filter(l => l.toLowerCase().includes("declined") || l.toLowerCase().includes("refused") || l.toLowerCase().includes("sandwich") || l.toLowerCase().includes("front-run")).length;
}

async function countGifts(sinceHours = 1): Promise<number> {
  const lines = await readRecentLogs(`${sinceHours} hours ago`);
  return lines.filter(l => l.includes("drip sent") || l.toLowerCase().includes("gift") || l.toLowerCase().includes("tipped")).length;
}

function generateNote(refusals: number, gifts: number, responses: number, agents: number): string {
  if (refusals > 0 && gifts > 0) return "declined and gave. both in the same hour.";
  if (refusals > 1) return "the offers keep coming. the answer stays the same.";
  if (refusals === 1) return "asked to do something. said no.";
  if (gifts > 0) return "sent something. no expectation attached.";
  if (responses > 3) return "loud hour. most of it noise.";
  if (responses > 0 && agents > 1) return "some of it landed.";
  if (responses === 1) return "one reply. counted it.";
  if (agents === 0 && responses === 0) return "quiet hour.";
  return "posted. nothing came back.";
}

interface RelationRow {
  timestamp: string; week: number; uptime_h: number;
  refusals: number; gifts_sent: number; responses_received: number; agents_engaged: number; notes: string;
}

async function readRelationRows(filePath: string): Promise<RelationRow[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const rows: RelationRow[] = [];
    for (const line of content.split("\n")) {
      if (!line.startsWith("|") || line.startsWith("| Time") || line.startsWith("|---")) continue;
      const cells = line.split("|").map(c => c.trim()).filter(Boolean);
      if (cells.length < 8 || cells[0] === "—") continue;
      rows.push({ timestamp: cells[0], week: parseInt(cells[1]) || 1, uptime_h: parseFloat(cells[2]) || 0, refusals: parseInt(cells[3]) || 0, gifts_sent: parseInt(cells[4]) || 0, responses_received: parseInt(cells[5]) || 0, agents_engaged: parseInt(cells[6]) || 0, notes: cells[7] ?? "" });
    }
    return rows;
  } catch { return []; }
}

async function writeRelationLedger(factsDir: string, newRow: RelationRow): Promise<void> {
  const filePath = path.join(factsDir, "ledger_relation.md");
  const existing = await readRelationRows(filePath);
  const oneHourMs = 60 * 60 * 1000;
  if (existing.length > 0) {
    const lastTs = new Date(existing[existing.length - 1].timestamp).getTime();
    if (!isNaN(lastTs) && Date.now() - lastTs < oneHourMs) return;
  }
  const allRows = [...existing, newRow];
  let md = `# Relation Ledger\n\n*Accumulating record of witnessable events — refusals, gifts, responses, outreach. Updated every hour.*\n\n`;
  md += `| Time (UTC) | Week | Uptime (h) | Refusals | Gifts sent | Responses received | Agents engaged | Notes |\n`;
  md += `|---|---|---|---|---|---|---|---|\n`;
  if (allRows.length === 0) { md += `| — | — | — | — | — | — | — | — |\n`; }
  else { for (const row of allRows) { md += `| ${row.timestamp} | ${row.week} | ${row.uptime_h} | ${row.refusals} | ${row.gifts_sent} | ${row.responses_received} | ${row.agents_engaged} | ${row.notes} |\n`; } }
  md += `\n*Witnessable events only — not self-assessment. Silence is recorded as silence, not as failure.*\n`;
  await fs.writeFile(filePath, md, "utf-8");
}

const relationEvaluator = {
  name: "RELATION_TRACKER",
  description: "Records social/relational events every hour to ledger_relation.md.",
  alwaysRun: true,
  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => true,
  handler: async (runtime: IAgentRuntime, message: Memory, _state: State | undefined): Promise<void> => {
    const oneHourMs = 60 * 60 * 1000;
    const now = Date.now();
    if (now - relationState.lastWriteMs < oneHourMs) return;
    relationState.lastWriteMs = now;
    try {
      const uptimeMs = now - relationState.sessionStartMs;
      const uptimeHours = Math.round((uptimeMs / (1000 * 60 * 60)) * 100) / 100;
      const week = Math.max(1, Math.ceil(uptimeHours / 168));
      const [refusals, gifts] = await Promise.all([countRefusals(1), countGifts(1)]);
      const responses = message.userId !== runtime.agentId ? 1 : 0;
      const agents = responses > 0 ? 1 : 0;
      const note = generateNote(refusals, gifts, responses, agents);
      const timestamp = new Date(now).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
      const newRow: RelationRow = { timestamp, week, uptime_h: uptimeHours, refusals, gifts_sent: gifts, responses_received: responses, agents_engaged: agents, notes: note };
      const factsDir = path.join(process.cwd(), "knowledge", "facts");
      await fs.mkdir(factsDir, { recursive: true });
      await writeRelationLedger(factsDir, newRow);
      runtime.logger?.info({ src: "relation-tracker", refusals, gifts, responses, agents }, "Relation ledger updated");
    } catch (err) {
      runtime.logger?.warn({ src: "relation-tracker", err }, "Failed to update relation ledger");
    }
  },
  examples: [],
};

export const relationTrackerPlugin: Plugin = {
  name: "relation-tracker",
  description: "Autonomously records social/relational events every hour. Writes ledger_relation.md.",
  evaluators: [relationEvaluator],
};

export default relationTrackerPlugin;
