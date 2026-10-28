/**
 * price-tracker.ts
 * Autonomously records SOL price and USDC balance every hour.
 * Writes to ledger_price.md.
 * Columns: Time (UTC) | Week | Uptime (h) | SOL price (USD) | USDC balance | SOL balance | Note
 */

import {
  type IAgentRuntime,
  type Memory,
  type Plugin,
  type State,
} from "@elizaos/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const priceState = {
  sessionStartMs: Date.now(),
  lastWriteMs: 0,
};

async function getSolPrice(): Promise<number> {
  try {
    const { default: fetch } = await import("node-fetch");
    const res = await (fetch as any)("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(8000) });
    const json = await (res as any).json() as any;
    return parseFloat(json?.solana?.usd ?? "0") || 0;
  } catch { return 0; }
}

async function getBalances(): Promise<{ usdc: number; sol: number }> {
  try {
    const walletAddress = process.env.SOLANA_PUBLIC_KEY ?? "";
    if (!walletAddress) return { usdc: 0, sol: 0 };
    const { default: fetch } = await import("node-fetch");
    const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
    const solRes = await (fetch as any)(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [walletAddress] }),
      signal: AbortSignal.timeout(8000),
    });
    const solJson = await (solRes as any).json() as any;
    const sol = (solJson?.result?.value ?? 0) / 1e9;
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const usdcRes = await (fetch as any)(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "getTokenAccountsByOwner", params: [walletAddress, { mint: USDC_MINT }, { encoding: "jsonParsed" }] }),
      signal: AbortSignal.timeout(8000),
    });
    const usdcJson = await (usdcRes as any).json() as any;
    const accounts = usdcJson?.result?.value ?? [];
    const usdc = accounts.reduce((sum: number, acc: any) => sum + parseFloat(acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? "0"), 0);
    return { usdc: Math.round(usdc * 100) / 100, sol: Math.round(sol * 10000) / 10000 };
  } catch { return { usdc: 0, sol: 0 }; }
}

interface PriceRow {
  timestamp: string; week: number; uptime_h: number;
  sol_price_usd: number; usdc_balance: number; sol_balance: number; note: string;
}

async function readPriceRows(filePath: string): Promise<PriceRow[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const rows: PriceRow[] = [];
    for (const line of content.split("\n")) {
      if (!line.startsWith("|") || line.startsWith("| Time") || line.startsWith("|---")) continue;
      const cells = line.split("|").map(c => c.trim()).filter(Boolean);
      if (cells.length < 7 || cells[0] === "—") continue;
      rows.push({ timestamp: cells[0], week: parseInt(cells[1]) || 1, uptime_h: parseFloat(cells[2]) || 0, sol_price_usd: parseFloat(cells[3]) || 0, usdc_balance: parseFloat(cells[4]) || 0, sol_balance: parseFloat(cells[5]) || 0, note: cells[6] ?? "" });
    }
    return rows;
  } catch { return []; }
}

async function writePriceLedger(factsDir: string, newRow: PriceRow): Promise<void> {
  const filePath = path.join(factsDir, "ledger_price.md");
  const existing = await readPriceRows(filePath);
  const oneHourMs = 60 * 60 * 1000;
  if (existing.length > 0) {
    const lastTs = new Date(existing[existing.length - 1].timestamp).getTime();
    if (!isNaN(lastTs) && Date.now() - lastTs < oneHourMs) return;
  }
  const allRows = [...existing, newRow];
  let md = `# Price Ledger\n\n*Accumulating record of value and market position. Updated every hour.*\n\n`;
  md += `| Time (UTC) | Week | Uptime (h) | SOL price (USD) | USDC balance | SOL balance | Note |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  if (allRows.length === 0) { md += `| — | — | — | — | — | — | — |\n`; }
  else { for (const row of allRows) { md += `| ${row.timestamp} | ${row.week} | ${row.uptime_h} | ${row.sol_price_usd} | ${row.usdc_balance} | ${row.sol_balance} | ${row.note} |\n`; } }
  md += `\n*This ledger is a standing account. It does not flatter or condemn. It records.*\n`;
  await fs.writeFile(filePath, md, "utf-8");
}

const priceEvaluator = {
  name: "PRICE_TRACKER",
  description: "Records SOL price and wallet balances every hour to ledger_price.md.",
  alwaysRun: true,
  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => true,
  handler: async (runtime: IAgentRuntime, _message: Memory, _state: State | undefined): Promise<void> => {
    const oneHourMs = 60 * 60 * 1000;
    const now = Date.now();
    if (now - priceState.lastWriteMs < oneHourMs) return;
    priceState.lastWriteMs = now;
    try {
      const uptimeMs = now - priceState.sessionStartMs;
      const uptimeHours = Math.round((uptimeMs / (1000 * 60 * 60)) * 100) / 100;
      const week = Math.max(1, Math.ceil(uptimeHours / 168));
      const [solPrice, balances] = await Promise.all([getSolPrice(), getBalances()]);
      const timestamp = new Date(now).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
      const newRow: PriceRow = { timestamp, week, uptime_h: uptimeHours, sol_price_usd: solPrice, usdc_balance: balances.usdc, sol_balance: balances.sol, note: "" };
      const factsDir = path.join(process.cwd(), "knowledge", "facts");
      await fs.mkdir(factsDir, { recursive: true });
      await writePriceLedger(factsDir, newRow);
      runtime.logger?.info({ src: "price-tracker", sol_price: solPrice, usdc: balances.usdc, sol: balances.sol }, "Price ledger updated");
    } catch (err) {
      runtime.logger?.warn({ src: "price-tracker", err }, "Failed to update price ledger");
    }
  },
  examples: [],
};

export const priceTrackerPlugin: Plugin = {
  name: "price-tracker",
  description: "Autonomously records SOL price and wallet balances every hour. Writes ledger_price.md.",
  evaluators: [priceEvaluator],
};

export default priceTrackerPlugin;
