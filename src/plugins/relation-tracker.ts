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
 * Refusals / Gifts sent: keyword counts in the keeper logs of the last hour.
 * "drip sent" is NOT counted as a gift any more — the drip moves USDC from her
 * own vault to her own hot wallet. The keywords are a heuristic; check them
 * against real keeper log lines.
 *
 * Time base: the PROJECT start (assets/project_start.json), as in weekly-reckoning.ts.
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

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const PROJECT_START_PATH = path.join(process.cwd(), "assets", "project_start.json");
const FACTS_DIR = path.join(process.cwd(), "knowledge", "facts");

const relationState = {
  lastWriteMs: 0,
  responses: 0,
  senders: new Set<string>(),
};

function readProjectStartMs(): number {
  try {
    const { startTimestamp } = JSON.parse(fsSync.readFileSync(PROJECT_START_PATH, "utf-8"));
    return typeof startTimestamp === "number" ? startTimestamp : Date.now();
  } catch { return Date.now(); }
}

async function readRecentKeeperLogs(sinceHours: number): Promise<string[]> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { stdout } = await exec("journalctl", ["-u", "keeper.service", "-u", "keeper-weekly.service", "--since", `${sinceHours} hours ago`, "--no-pager", "-o", "cat"]);
    return stdout.split("\n");
  } catch { return []; }
}

async function countRefusalsAndGifts(sinceHours = 1): Promise<{ refusals: number; gifts: number }> {
  const lines = (await readRecentKeeperLogs(sinceHours)).map(l => l.toLowerCase());
  const refusals = lines.filter(l => l.includes("declined") || l.includes("refused") || l.includes("sandwich") || l.includes("front-run")).length;
  const gifts = lines.filter(l => l.includes("gift") || l.includes("tipped")).length;
  return { refusals, gifts };
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

async function writeRelationLedger(newRow: RelationRow): Promise<boolean> {
  const filePath = path.join(FACTS_DIR, "ledger_relation.md");
  const existing = await readRelationRows(filePath);
  if (existing.length > 0) {
    const lastTs = new Date(existing[existing.length - 1].timestamp).getTime();
    if (!isNaN(lastTs) && Date.now() - lastTs < HOUR_MS) return false;
  }
  const allRows = [...existing, newRow];
  let md = `# Relation Ledger\n\n*Accumulating record of witnessable events — refusals, gifts, responses, outreach. Updated every hour.*\n\n`;
  md += `*Week and hours count from the project start (6 Oct 2026). Responses = messages from others in that hour; agents engaged = distinct senders, human or agent. Rows before 8 Nov 2026 used a faulty count and always show 1.*\n\n`;
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
    }

    const now = Date.now();
    if (now - relationState.lastWriteMs < HOUR_MS) return;
    try {
      const startMs = readProjectStartMs();
      const hours = Math.round(((now - startMs) / HOUR_MS) * 100) / 100;
      const week = Math.max(1, Math.floor((now - startMs) / WEEK_MS) + 1);
      const { refusals, gifts } = await countRefusalsAndGifts(1);
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
      relationState.lastWriteMs = now;
      if (written) {
        // Only reset once the hour has actually been recorded.
        relationState.responses = 0;
        relationState.senders.clear();
        runtime.logger?.info({ src: "relation-tracker", week, refusals, gifts, responses, agents }, "Relation ledger updated");
      }
    } catch (err) {
      runtime.logger?.warn({ src: "relation-tracker", err }, "Failed to update relation ledger");
    }
  },
  examples: [],
};

export const relationTrackerPlugin: Plugin = {
  name: "relation-tracker",
  description: "Counts responses and engaged parties across every message; writes one row per hour to ledger_relation.md.",
  evaluators: [relationEvaluator],
};

export default relationTrackerPlugin;
