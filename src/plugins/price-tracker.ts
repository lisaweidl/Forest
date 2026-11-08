/**
 * price-tracker.ts
 * Autonomously records SOL price and USDC balance every hour.
 * Writes to ledger_price.md.
 * Columns: Time (UTC) | Week | Hours since start | SOL price (USD) | USDC balance | SOL balance | Note
 *
 * Time base: the PROJECT start (assets/project_start.json), not the process start,
 * so week and hours don't reset when the agent restarts. Week = same formula as
 * weekly-reckoning.ts.
 * Failed lookups are written as "—" with a note, never as 0 — a 0 would read
 * as a real price or an empty wallet.
 * Existing rows are kept exactly as written (stored as text), so older rows
 * with their old week/uptime values stay unchanged.
 *
 * Runs on its own clock (checked every 10 minutes, one row per hour), not only
 * when a message is processed — so quiet hours are recorded too. This replaces
 * the cron script update-ledgers.sh.
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

let priceRunning = false;

function readProjectStartMs(): number {
  try {
    const { startTimestamp } = JSON.parse(fsSync.readFileSync(PROJECT_START_PATH, "utf-8"));
    return typeof startTimestamp === "number" ? startTimestamp : Date.now();
  } catch { return Date.now(); }
}

async function getSolPrice(): Promise<number | null> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(8000) });
    const json = await res.json() as { solana?: { usd?: number } };
    const price = Number(json?.solana?.usd);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch { return null; }
}

async function getBalances(): Promise<{ usdc: number; sol: number } | null> {
  try {
    const walletAddress = process.env.SOLANA_PUBLIC_KEY ?? "";
    if (!walletAddress) return null;
    const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
    const solRes = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [walletAddress] }),
      signal: AbortSignal.timeout(8000),
    });
    const solJson = await solRes.json() as any;
    if (solJson?.error || solJson?.result?.value === undefined) return null;
    const sol = solJson.result.value / 1e9;
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const usdcRes = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "getTokenAccountsByOwner", params: [walletAddress, { mint: USDC_MINT }, { encoding: "jsonParsed" }] }),
      signal: AbortSignal.timeout(8000),
    });
    const usdcJson = await usdcRes.json() as any;
    if (usdcJson?.error || !Array.isArray(usdcJson?.result?.value)) return null;
    const usdc = usdcJson.result.value.reduce((sum: number, acc: any) => sum + parseFloat(acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? "0"), 0);
    return { usdc: Math.round(usdc * 100) / 100, sol: Math.round(sol * 10000) / 10000 };
  } catch { return null; }
}

// All cells as text so existing rows are rewritten exactly as they were.
interface PriceRow {
  timestamp: string; week: string; hours: string;
  sol_price_usd: string; usdc_balance: string; sol_balance: string; note: string;
}

async function readPriceRows(filePath: string): Promise<PriceRow[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const rows: PriceRow[] = [];
    for (const line of content.split("\n")) {
      if (!line.startsWith("| 2")) continue; // data rows start with the year
      const cells = line.split("|").slice(1, -1).map(c => c.trim());
      if (cells.length < 6) continue;
      rows.push({ timestamp: cells[0], week: cells[1], hours: cells[2], sol_price_usd: cells[3], usdc_balance: cells[4], sol_balance: cells[5], note: cells[6] ?? "" });
    }
    return rows;
  } catch { return []; }
}

function rowTime(r: PriceRow): number {
  return Date.parse(r.timestamp.replace(" UTC", "Z").replace(" ", "T"));
}

async function isPriceDue(): Promise<boolean> {
  const existing = await readPriceRows(path.join(FACTS_DIR, "ledger_price.md"));
  if (existing.length === 0) return true;
  const lastTs = rowTime(existing[existing.length - 1]);
  return isNaN(lastTs) || Date.now() - lastTs >= HOUR_MS;
}

async function writePriceLedger(newRow: PriceRow): Promise<boolean> {
  const filePath = path.join(FACTS_DIR, "ledger_price.md");
  const existing = await readPriceRows(filePath);
  if (existing.length > 0) {
    const lastTs = rowTime(existing[existing.length - 1]);
    if (!isNaN(lastTs) && Date.now() - lastTs < HOUR_MS) return false;
  }
  const allRows = [...existing, newRow];
  let md = `# Price Ledger\n\n*Accumulating record of value and market position. Updated every hour.*\n\n`;
  md += `*Week and hours count from the project start (6 Oct 2026). Rows before 8 Nov 2026 counted from the last agent restart. "—" means the lookup failed that hour.*\n\n`;
  md += `| Time (UTC) | Week | Hours since start | SOL price (USD) | USDC balance | SOL balance | Note |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  for (const r of allRows) {
    md += `| ${r.timestamp} | ${r.week} | ${r.hours} | ${r.sol_price_usd} | ${r.usdc_balance} | ${r.sol_balance} | ${r.note} |\n`;
  }
  md += `\n*This ledger is a standing account. It does not flatter or condemn. It records.*\n`;
  await fs.writeFile(filePath, md, "utf-8");
  return true;
}

const priceEvaluator = {
  name: "PRICE_TRACKER",
  description: "Records SOL price and wallet balances every hour to ledger_price.md.",
  alwaysRun: true,
  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => true,
  handler: async (runtime: IAgentRuntime, _message: Memory, _state: State | undefined): Promise<void> => {
    await recordPrice(runtime);
  },
  examples: [],
};

async function recordPrice(runtime: IAgentRuntime): Promise<void> {
    if (priceRunning) return;
    priceRunning = true;
    const now = Date.now();
    try {
      if (!(await isPriceDue())) return;
      const startMs = readProjectStartMs();
      const hours = Math.round(((now - startMs) / HOUR_MS) * 100) / 100;
      const week = Math.max(1, Math.floor((now - startMs) / WEEK_MS) + 1);
      const [solPrice, balances] = await Promise.all([getSolPrice(), getBalances()]);
      const notes: string[] = [];
      if (solPrice === null) notes.push("price unavailable");
      if (balances === null) notes.push("balance unavailable");
      const timestamp = new Date(now).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
      const newRow: PriceRow = {
        timestamp, week: String(week), hours: String(hours),
        sol_price_usd: solPrice === null ? "—" : String(solPrice),
        usdc_balance: balances === null ? "—" : String(balances.usdc),
        sol_balance: balances === null ? "—" : String(balances.sol),
        note: notes.join(", "),
      };
      await fs.mkdir(FACTS_DIR, { recursive: true });
      const written = await writePriceLedger(newRow);
      if (written) runtime.logger?.info({ src: "price-tracker", week, sol_price: solPrice, usdc: balances?.usdc, sol: balances?.sol }, "Price ledger updated");
    } catch (err) {
      runtime.logger?.warn({ src: "price-tracker", err }, "Failed to update price ledger");
    } finally { priceRunning = false; }
}

export const priceTrackerPlugin: Plugin = {
  name: "price-tracker",
  description: "Autonomously records SOL price and wallet balances every hour. Writes ledger_price.md.",
  evaluators: [priceEvaluator],
  async init(_config: Record<string, string>, runtime: IAgentRuntime) {
    setTimeout(() => recordPrice(runtime), 2 * 60 * 1000);
    setInterval(() => recordPrice(runtime), 10 * 60 * 1000);
  },
};

export default priceTrackerPlugin;
