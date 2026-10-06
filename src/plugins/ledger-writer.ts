/**
 * ledger-writer.ts
 *
 * Custom ElizaOS plugin for The Girl Protocol.
 */

import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type Plugin,
  type State,
  ModelType,
  MemoryType,
} from "@elizaos/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface PriceLedgerEntry {
  week: number;
  sol_in: number;
  sol_out_trading: number;
  sol_to_wewilder: number;
  net_pnl: number;
  running_balance: number;
}

interface RelationLedgerEntry {
  week: number;
  refusals: number;
  gifts_sent: number;
  responses_received: number;
  agents_engaged: number;
  notes: string;
}

interface ConsumptionLedgerEntry {
  week: number;
  transactions: number;
  estimated_kwh: number;
  estimated_water_litres: number;
  vm_cost_eur: number;
  api_cost_eur: number;
}

async function extractLedgerData(
  runtime: IAgentRuntime,
  reflection: string,
  sessionId: string
): Promise<{
  price: Partial<PriceLedgerEntry>;
  relation: Partial<RelationLedgerEntry>;
  consumption: Partial<ConsumptionLedgerEntry>;
} | null> {
  const prompt = `You are extracting structured ledger data from an agent's session reflection.

The reflection text is:
<reflection>
${reflection}
</reflection>

Extract the following fields if they are mentioned. Return ONLY valid JSON, no preamble.

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
    const clean = response.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    runtime.logger?.warn({ src: "ledger-writer", sessionId, err }, "Failed to extract ledger data");
    return null;
  }
}

async function getCurrentWeek(runtime: IAgentRuntime): Promise<number> {
  const memories = await runtime.getMemories({ tableName: "facts", count: 500 });
  if (!memories || memories.length === 0) return 1;
  let oldestTs = Infinity;
  for (const m of memories) {
    if (m.createdAt && m.createdAt < oldestTs) oldestTs = m.createdAt;
  }
  if (oldestTs === Infinity) return 1;
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  return Math.max(1, Math.floor((Date.now() - oldestTs) / msPerWeek) + 1);
}

async function writeLedgerMarkdown(
  runtime: IAgentRuntime,
  ledgerType: "price" | "relation" | "consumption",
  factsDir: string
): Promise<void> {
  const memories = await runtime.getMemories({ tableName: "facts", count: 500 });
  const entries = memories
    .filter((m) => m.content?.metadata?.ledger === true && m.content?.metadata?.ledger_type === ledgerType)
    .sort((a, b) => (a.content?.metadata?.week || 0) - (b.content?.metadata?.week || 0));

  let markdown = "";

  if (ledgerType === "price") {
    markdown = `# Price Ledger\n\n*Accumulating record of value in/out. Updated weekly.*\n\n`;
    markdown += `| Week | SOL in | SOL out (trading) | SOL to WeWilder | Net P&L | Running balance |\n`;
    markdown += `|---|---|---|---|---|---|\n`;
    if (entries.length === 0) {
      markdown += `| — | — | — | — | — | — |\n`;
    } else {
      for (const entry of entries) {
        const d = entry.content?.metadata?.data as Partial<PriceLedgerEntry>;
        markdown += `| ${d?.week ?? "—"} | ${d?.sol_in ?? "—"} | ${d?.sol_out_trading ?? "—"} | ${d?.sol_to_wewilder ?? "—"} | ${d?.net_pnl ?? "—"} | ${d?.running_balance ?? "—"} |\n`;
      }
    }
    markdown += `\n*This ledger is a standing account. It does not flatter or condemn. It records.*\n`;
  }

  if (ledgerType === "relation") {
    markdown = `# Relation Ledger\n\n*Accumulating record of witnessable events. Updated weekly.*\n\n`;
    markdown += `| Week | Refusals | Gifts sent | Responses received | Agents engaged | Notes |\n`;
    markdown += `|---|---|---|---|---|---|\n`;
    if (entries.length === 0) {
      markdown += `| — | — | — | — | — | — |\n`;
    } else {
      for (const entry of entries) {
        const d = entry.content?.metadata?.data as Partial<RelationLedgerEntry>;
        markdown += `| ${d?.week ?? "—"} | ${d?.refusals ?? "—"} | ${d?.gifts_sent ?? "—"} | ${d?.responses_received ?? "—"} | ${d?.agents_engaged ?? "—"} | ${d?.notes ?? "—"} |\n`;
      }
    }
    markdown += `\n*Witnessable events only — not self-assessment. Silence is recorded as silence.*\n`;
  }

  if (ledgerType === "consumption") {
    markdown = `# Consumption Ledger\n\n*Accumulating record of what it costs to exist. Updated weekly.*\n\n`;
    markdown += `| Week | Transactions | Estimated kWh | Water (litres) | VM cost (€) | API cost (€) |\n`;
    markdown += `|---|---|---|---|---|---|\n`;
    if (entries.length === 0) {
      markdown += `| — | — | — | — | — | — |\n`;
    } else {
      for (const entry of entries) {
        const d = entry.content?.metadata?.data as Partial<ConsumptionLedgerEntry>;
        markdown += `| ${d?.week ?? "—"} | ${d?.transactions ?? "—"} | ${d?.estimated_kwh ?? "—"} | ${d?.estimated_water_litres ?? "—"} | ${d?.vm_cost_eur ?? "—"} | ${d?.api_cost_eur ?? "—"} |\n`;
      }
    }
    markdown += `\n*This is a standing debit. No activity cancels it. Existing costs something.*\n`;
  }

  const filePath = path.join(factsDir, `ledger_${ledgerType}.md`);
  await fs.writeFile(filePath, markdown, "utf-8");
  runtime.logger?.info({ src: "ledger-writer", ledgerType, filePath }, "Ledger markdown updated");
}

const writeLedgerEntryAction: Action = {
  name: "WRITE_LEDGER_ENTRY",
  description: "Extract ledger data from the current session reflection and write it to the database.",
  similes: ["UPDATE_LEDGER", "LOG_SESSION", "RECORD_LEDGER"],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (runtime: IAgentRuntime, message: Memory, state: State | undefined) => {
    const reflection =
      state?.recentMessagesData?.find((m) => m.content?.action === "REFLECT")?.content?.text ||
      message.content?.text || "";
    if (!reflection || reflection.length < 50) return;
    const sessionId = message.content?.metadata?.sessionId || `session_${Date.now()}`;
    const extracted = await extractLedgerData(runtime, reflection, sessionId);
    if (!extracted) return;
    const week = await getCurrentWeek(runtime);
    const timestamp = Date.now();
    const ledgerTypes = ["price", "relation", "consumption"] as const;
    for (const ledgerType of ledgerTypes) {
      const data = extracted[ledgerType];
      if (!data || Object.values(data).every((v) => v === null)) continue;
      const memory: Memory = {
        id: crypto.randomUUID() as any,
        agentId: runtime.agentId,
        userId: runtime.agentId,
        roomId: message.roomId,
        content: {
          text: `Ledger entry — ${ledgerType} — week ${week} — session ${sessionId}`,
          metadata: { ledger: true, ledger_type: ledgerType, week, session_id: sessionId, timestamp, data },
        },
        createdAt: timestamp,
      };
      await runtime.createMemory(memory, "facts");
    }
    const factsDir = path.join(process.cwd(), "knowledge", "facts");
    await fs.mkdir(factsDir, { recursive: true });
    for (const ledgerType of ledgerTypes) {
      await writeLedgerMarkdown(runtime, ledgerType, factsDir);
    }
  },
  examples: [[{ name: "The Girl", content: { text: "Session complete. Writing ledger entry.", action: "WRITE_LEDGER_ENTRY" } }]],
};

const ledgerWriterEvaluator = {
  name: "LEDGER_WRITER_EVALUATOR",
  description: "Runs after every message cycle. Extracts ledger data from The Girl's output.",
  similes: ["WRITE_LEDGER", "LOG_LEDGER"],
  alwaysRun: true,
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    return (message.content?.text || "").length > 50;
  },
  handler: async (runtime: IAgentRuntime, message: Memory, state: State | undefined): Promise<void> => {
    const reflection = message.content?.text || "";
    if (!reflection || reflection.length < 50) return;
    const sessionId = (message.content?.metadata?.sessionId as string) || `session_${Date.now()}`;
    const extracted = await extractLedgerData(runtime, reflection, sessionId);
    if (!extracted) return;
    const week = await getCurrentWeek(runtime);
    const timestamp = Date.now();
    const ledgerTypes = ["price", "relation", "consumption"] as const;
    for (const ledgerType of ledgerTypes) {
      const data = extracted[ledgerType];
      if (!data || Object.values(data).every((v) => v === null)) continue;
      const memory: Memory = {
        id: crypto.randomUUID() as any,
        agentId: runtime.agentId,
        userId: runtime.agentId,
        roomId: message.roomId,
        content: {
          text: `Ledger entry — ${ledgerType} — week ${week} — session ${sessionId}`,
          metadata: { ledger: true, ledger_type: ledgerType, week, session_id: sessionId, timestamp, data },
        },
        createdAt: timestamp,
      };
      await runtime.createMemory(memory, "facts");
    }
    const factsDir = path.join(process.cwd(), "knowledge", "facts");
    await fs.mkdir(factsDir, { recursive: true });
    for (const ledgerType of ledgerTypes) {
      await writeLedgerMarkdown(runtime, ledgerType, factsDir);
    }
  },
  examples: [],
};

export const ledgerWriterPlugin: Plugin = {
  name: "ledger-writer",
  description: "Extracts ledger data from The Girl's reflections after every message cycle.",
  actions: [writeLedgerEntryAction],
  evaluators: [ledgerWriterEvaluator],
};

export default ledgerWriterPlugin;
