/**
 * ledger-writer.ts
 *
 * Custom ElizaOS plugin for The Girl Protocol.
 *
 * Extracts what The Girl HERSELF says about price, relations and consumption
 * from her own replies, stores it in the database (MemoryType facts) and writes
 * it to separate files:
 *
 *   knowledge/facts/self_reported_price.md
 *   knowledge/facts/self_reported_relation.md
 *   knowledge/facts/self_reported_consumption.md
 *
 * It does NOT write ledger_price.md / ledger_relation.md / ledger_consumption.md.
 * Those are the measured ledgers, written hourly by price-tracker, relation-tracker
 * and consumption-tracker. Until 8 Nov 2026 this plugin overwrote them with its
 * own format after every message, wiping the trackers' tables.
 *
 * The two records are kept apart on purpose: measured vs. self-reported.
 * Comparing them is research material in itself.
 *
 * Changes on 8 Nov 2026:
 *   - writes self_reported_*.md instead of the measured ledger files
 *   - reads only The Girl's own replies, not other people's messages
 *   - week = project week (assets/project_start.json), as in weekly-reckoning.ts
 *   - ElizaOS 1.x field names (entityId instead of userId)
 */

import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type Plugin,
  type State,
  ModelType,
} from "@elizaos/core";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PROJECT_START_PATH = path.join(process.cwd(), "assets", "project_start.json");
const FACTS_DIR = path.join(process.cwd(), "knowledge", "facts");
const LEDGER_TYPES = ["price", "relation", "consumption"] as const;
type LedgerType = (typeof LEDGER_TYPES)[number];

interface PriceLedgerEntry {
  week: number; sol_in: number; sol_out_trading: number; sol_to_wewilder: number; net_pnl: number; running_balance: number;
}
interface RelationLedgerEntry {
  week: number; refusals: number; gifts_sent: number; responses_received: number; agents_engaged: number; notes: string;
}
interface ConsumptionLedgerEntry {
  week: number; transactions: number; estimated_kwh: number; estimated_water_litres: number; vm_cost_eur: number; api_cost_eur: number;
}
type Extracted = {
  price: Partial<PriceLedgerEntry>;
  relation: Partial<RelationLedgerEntry>;
  consumption: Partial<ConsumptionLedgerEntry>;
};

function getProjectWeek(): number {
  try {
    const { startTimestamp } = JSON.parse(fsSync.readFileSync(PROJECT_START_PATH, "utf-8"));
    if (typeof startTimestamp !== "number") return 1;
    return Math.max(1, Math.floor((Date.now() - startTimestamp) / WEEK_MS) + 1);
  } catch { return 1; }
}

async function extractLedgerData(runtime: IAgentRuntime, reflection: string, sessionId: string): Promise<Extracted | null> {
  const prompt = `You are extracting structured ledger data from an agent's own words.

The text is:
<reflection>
${reflection}
</reflection>

Extract the following fields ONLY if the text states them explicitly. Use null for anything not stated. Do not infer or estimate. Return ONLY valid JSON, no preamble.

{
  "price": {
    "sol_in": <number or null>,
    "sol_out_trading": <number or null>,
    "sol_to_wewilder": <number or null>,
    "net_pnl": <number or null>,
    "running_balance": <number or null>
  },
  "relation": {
    "refusals": <integer or null>,
    "gifts_sent": <integer or null>,
    "responses_received": <integer or null>,
    "agents_engaged": <integer or null>,
    "notes": "<brief plain text summary of relation events, or null>"
  },
  "consumption": {
    "transactions": <integer or null>,
    "estimated_kwh": <number or null>,
    "estimated_water_litres": <number or null>,
    "vm_cost_eur": <number or null>,
    "api_cost_eur": <number or null>
  }
}`;
  try {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const start = response.indexOf("{");
    const end = response.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    return JSON.parse(response.slice(start, end + 1)) as Extracted;
  } catch (err) {
    runtime.logger?.warn({ src: "ledger-writer", sessionId, err }, "Failed to extract ledger data");
    return null;
  }
}

async function writeSelfReportedMarkdown(runtime: IAgentRuntime, ledgerType: LedgerType): Promise<void> {
  const memories = await runtime.getMemories({ tableName: "facts", count: 1000 });
  const entries = (memories ?? [])
    .filter((m) => m.content?.metadata?.ledger === true && m.content?.metadata?.ledger_type === ledgerType)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  const intro = `*What The Girl herself said, extracted from her own replies. Not measured — for the measured record see ledger_${ledgerType}.md.*\n\n`;
  let md = "";
  const cell = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v).replace(/\|/g, "/"));
  const when = (m: Memory) => new Date(m.createdAt || 0).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

  if (ledgerType === "price") {
    md = `# Price — self-reported\n\n${intro}| Time (UTC) | Week | SOL in | SOL out (trading) | SOL to WeWilder | Net P&L | Running balance |\n|---|---|---|---|---|---|---|\n`;
    for (const e of entries) {
      const d = e.content?.metadata?.data as Partial<PriceLedgerEntry>;
      md += `| ${when(e)} | ${cell(e.content?.metadata?.week)} | ${cell(d?.sol_in)} | ${cell(d?.sol_out_trading)} | ${cell(d?.sol_to_wewilder)} | ${cell(d?.net_pnl)} | ${cell(d?.running_balance)} |\n`;
    }
  }
  if (ledgerType === "relation") {
    md = `# Relation — self-reported\n\n${intro}| Time (UTC) | Week | Refusals | Gifts sent | Responses received | Agents engaged | Notes |\n|---|---|---|---|---|---|---|\n`;
    for (const e of entries) {
      const d = e.content?.metadata?.data as Partial<RelationLedgerEntry>;
      md += `| ${when(e)} | ${cell(e.content?.metadata?.week)} | ${cell(d?.refusals)} | ${cell(d?.gifts_sent)} | ${cell(d?.responses_received)} | ${cell(d?.agents_engaged)} | ${cell(d?.notes)} |\n`;
    }
  }
  if (ledgerType === "consumption") {
    md = `# Consumption — self-reported\n\n${intro}| Time (UTC) | Week | Transactions | Estimated kWh | Water (litres) | VM cost (€) | API cost (€) |\n|---|---|---|---|---|---|---|\n`;
    for (const e of entries) {
      const d = e.content?.metadata?.data as Partial<ConsumptionLedgerEntry>;
      md += `| ${when(e)} | ${cell(e.content?.metadata?.week)} | ${cell(d?.transactions)} | ${cell(d?.estimated_kwh)} | ${cell(d?.estimated_water_litres)} | ${cell(d?.vm_cost_eur)} | ${cell(d?.api_cost_eur)} |\n`;
    }
  }
  if (entries.length === 0) md += `| — | — | — | — | — | — | — |\n`;

  const filePath = path.join(FACTS_DIR, `self_reported_${ledgerType}.md`);
  await fs.writeFile(filePath, md, "utf-8");
}

// Shared by the evaluator and the action.
async function recordFromText(runtime: IAgentRuntime, text: string, roomId: Memory["roomId"], sessionId: string): Promise<void> {
  if (!text || text.length < 50) return;
  const extracted = await extractLedgerData(runtime, text, sessionId);
  if (!extracted) return;
  const week = getProjectWeek();
  const timestamp = Date.now();
  let wroteAny = false;
  for (const ledgerType of LEDGER_TYPES) {
    const data = extracted[ledgerType];
    if (!data || Object.values(data).every((v) => v === null)) continue;
    const memory = {
      id: crypto.randomUUID() as any,
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId,
      content: {
        text: `Self-reported ledger entry — ${ledgerType} — week ${week} — session ${sessionId}`,
        metadata: { ledger: true, ledger_type: ledgerType, week, session_id: sessionId, timestamp, data },
      },
      createdAt: timestamp,
    } as unknown as Memory;
    await runtime.createMemory(memory, "facts");
    wroteAny = true;
  }
  if (!wroteAny) return; // nothing stated — leave the files alone
  await fs.mkdir(FACTS_DIR, { recursive: true });
  for (const ledgerType of LEDGER_TYPES) await writeSelfReportedMarkdown(runtime, ledgerType);
  runtime.logger?.info({ src: "ledger-writer", week, sessionId }, "Self-reported ledger updated");
}

const writeLedgerEntryAction: Action = {
  name: "WRITE_LEDGER_ENTRY",
  description: "Record what you yourself just said about price, relations or consumption in your self-reported ledger. The measured ledgers are written automatically and are not touched.",
  similes: ["UPDATE_LEDGER", "LOG_SESSION", "RECORD_LEDGER"],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (runtime: IAgentRuntime, message: Memory, state: State | undefined) => {
    const text =
      (state as any)?.recentMessagesData?.find((m: Memory) => m.content?.action === "REFLECT")?.content?.text ||
      message.content?.text || "";
    const sessionId = (message.content?.metadata as any)?.sessionId || `session_${Date.now()}`;
    await recordFromText(runtime, text, message.roomId, sessionId);
  },
  examples: [[{ name: "The Girl", content: { text: "Session complete. Writing ledger entry.", action: "WRITE_LEDGER_ENTRY" } }]] as any,
};

const ledgerWriterEvaluator = {
  name: "LEDGER_WRITER_EVALUATOR",
  description: "Runs after every message cycle. Extracts what The Girl said about her ledgers from her own replies.",
  similes: ["WRITE_LEDGER", "LOG_LEDGER"],
  alwaysRun: true,
  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options?: unknown,
    _callback?: unknown,
    responses?: Memory[],
  ): Promise<void> => {
    // Only her own words: her replies to this message, or the message itself if she wrote it (e.g. an autonomous post).
    const sender = (message as any).entityId ?? (message as any).userId;
    const ownText = (responses ?? [])
      .map((r) => r.content?.text || "")
      .filter(Boolean)
      .join("\n\n") || (sender === runtime.agentId ? message.content?.text || "" : "");
    const sessionId = ((message.content?.metadata as any)?.sessionId as string) || `session_${Date.now()}`;
    await recordFromText(runtime, ownText, message.roomId, sessionId);
  },
  examples: [],
};

export const ledgerWriterPlugin: Plugin = {
  name: "ledger-writer",
  description: "Extracts what The Girl herself says about price, relations and consumption; writes self_reported_*.md. Never touches the measured ledger files.",
  actions: [writeLedgerEntryAction],
  evaluators: [ledgerWriterEvaluator as any],
};

export default ledgerWriterPlugin;
