/**
 * decision-cycle.ts
 *
 * Custom ElizaOS plugin for The Girl Protocol (8 Nov 2026).
 *
 * Once a day at 07:00 Europe/Vienna The Girl decides — on her own, from her SOUL,
 * her ledgers, her history and the market — whether to buy, sell, hold or give
 * (dissipate to WeWilder). She writes a Decision Log entry (schema v4) with her
 * reasoning and reflections. Only then does the code execute the decision.
 *
 * Saved to alambic/decision_log/decision_log_weekXX.json (one JSON array per week).
 * The 08:00 daily status (history.ts) reports the decision.
 *
 * HARD LIMITS — enforced here, not left to the model:
 *   - Trading is OFF unless TRADING_ENABLED=true in .env. When off, she still decides
 *     and logs, but nothing touches the chain ("dry run").
 *   - At most TRADING_MAX_USDC_PER_DAY (default 5, never more than 5) per day.
 *   - Only USDC and SOL. Dissipation goes only to WEWILDER_ADDRESS.
 *   - One decision per day, triggered only by this clock — never by a message.
 *   - Keeps at least 0.02 SOL for fees. Ignores amounts under 0.50 USDC.
 *
 * Requires in .env: SOLANA_PRIVATE_KEY, SOLANA_PUBLIC_KEY, SOLANA_RPC_URL,
 *   WEWILDER_ADDRESS, TRADING_ENABLED. Optional: JUPITER_API_KEY (free at
 *   developers.jup.ag/portal) — without it Jupiter's keyless access is used, which
 *   is enough for two requests a day.
 */

import { type IAgentRuntime, type Plugin, ModelType } from "@elizaos/core";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { recentLedgerText, readWeeklySummaries } from "./history";

// ── config ────────────────────────────────────────────────────────────────────

const TIMEZONE = "Europe/Vienna";
const DECISION_HOUR = 7;
const HARD_MAX_USDC_PER_DAY = 5;
const MIN_TRADE_USDC = 0.5;
const SOL_FEE_RESERVE = 0.02;
const SLIPPAGE_BPS = 50;

const JUPITER_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL = "https://api.jup.ag/swap/v1/swap";
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const ROOT = process.cwd();
const SOUL_PATH = path.join(ROOT, "knowledge", "SOUL.md");
const FACTS_DIR = path.join(ROOT, "knowledge", "facts");
const LOG_DIR = path.join(ROOT, "alambic", "decision_log");
const PROJECT_START_PATH = path.join(ROOT, "assets", "project_start.json");
const STATE_PATH = path.join(ROOT, "assets", "last_decision.json");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type Action = "buy" | "sell" | "hold" | "dissipate" | "no_action";

interface ModelDecision {
  observation: { pattern_type: string; token: string | null; signals: string[]; confidence: number };
  decision: { action: Action; amount_usdc: number; reasoning: string; girl_math_principle: string };
  resource_reflection: string;
  financial_reflection: string;
  reflection: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function tradingEnabled(): boolean {
  return process.env.TRADING_ENABLED === "true";
}

function dailyLimit(): number {
  const n = Number(process.env.TRADING_MAX_USDC_PER_DAY ?? HARD_MAX_USDC_PER_DAY);
  return Math.min(HARD_MAX_USDC_PER_DAY, Number.isFinite(n) && n > 0 ? n : HARD_MAX_USDC_PER_DAY);
}

function viennaNow(d = new Date()): { date: string; hour: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function projectWeek(): number {
  try {
    const { startTimestamp } = JSON.parse(fsSync.readFileSync(PROJECT_START_PATH, "utf-8"));
    return Math.max(1, Math.floor((Date.now() - startTimestamp) / WEEK_MS) + 1);
  } catch { return 1; }
}

function round(n: number, d = 4): number { return Math.round(n * 10 ** d) / 10 ** d; }

function getKeypair(): Keypair {
  const raw = process.env.SOLANA_PRIVATE_KEY ?? "";
  if (!raw) throw new Error("SOLANA_PRIVATE_KEY not set");
  const decode = (bs58 as any).default?.decode ?? (bs58 as any).decode;
  return Keypair.fromSecretKey(decode(raw));
}

function getConnection(): Connection {
  return new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
}

function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID)[0];
}

async function getBalances(connection: Connection, owner: PublicKey): Promise<{ usdc: number; sol: number }> {
  const sol = (await connection.getBalance(owner)) / 1e9;
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: USDC_MINT });
  const usdc = accounts.value.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
  return { usdc: round(usdc, 2), sol: round(sol, 4) };
}

async function getSolPrice(): Promise<number | null> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(8000) });
    const p = Number(((await res.json()) as any)?.solana?.usd);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

function parseJson<T>(text: string): T {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("no JSON in model output");
  return JSON.parse(text.slice(s, e + 1)) as T;
}

async function readRecentDecisions(n = 7): Promise<any[]> {
  try {
    const files = (await fs.readdir(LOG_DIR)).filter((f) => /^decision_log_week\d+\.json$/.test(f)).sort();
    const all: any[] = [];
    for (const f of files) {
      try {
        const data = JSON.parse(await fs.readFile(path.join(LOG_DIR, f), "utf-8"));
        if (Array.isArray(data)) all.push(...data);
      } catch { /* skip */ }
    }
    return all.filter((e) => e?.mode === "autonomous" && e?.decision).slice(-n);
  } catch { return []; }
}

async function consumption24h(): Promise<{ kwh: number | null; water: number | null }> {
  try {
    const md = await fs.readFile(path.join(FACTS_DIR, "ledger_consumption.md"), "utf-8");
    const rows = md.split("\n").filter((l) => l.startsWith("| 2")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
    const t = (r: string[]) => Date.parse(r[0].replace(" UTC", "Z").replace(" ", "T"));
    const last = rows[rows.length - 1];
    const before = [...rows].reverse().find((r) => t(r) <= Date.now() - 24 * 3600 * 1000 && t(r) >= Date.parse("2026-11-08T18:00:00Z"));
    if (!last || !before) return { kwh: null, water: null };
    return { kwh: round(Number(last[4]) - Number(before[4])), water: round(Number(last[5]) - Number(before[5]), 2) };
  } catch { return { kwh: null, water: null }; }
}

// ── execution ─────────────────────────────────────────────────────────────────

async function jupiterSwap(connection: Connection, keypair: Keypair, inputMint: string, outputMint: string, amountRaw: number): Promise<string> {
  const apiKey = process.env.JUPITER_API_KEY;
  const headers: Record<string, string> = apiKey ? { "x-api-key": apiKey } : {}; // keyless works at low rates
  const quoteRes = await fetch(`${JUPITER_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${SLIPPAGE_BPS}`, { headers });
  if (!quoteRes.ok) throw new Error(`quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  const quote = await quoteRes.json();
  const swapRes = await fetch(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 100_000, priorityLevel: "medium" } },
    }),
  });
  if (!swapRes.ok) throw new Error(`swap failed: ${swapRes.status} ${await swapRes.text()}`);
  const { swapTransaction, lastValidBlockHeight } = (await swapRes.json()) as { swapTransaction: string; lastValidBlockHeight: number };
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([keypair]);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const conf = await connection.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`transaction reverted: ${JSON.stringify(conf.value.err)} (${signature})`);
  return signature;
}

// USDC to WeWilder: a plain SPL TransferChecked into WeWilder's existing USDC account.
async function sendUsdcToWeWilder(connection: Connection, keypair: Keypair, amountUsdc: number): Promise<string> {
  const dest = process.env.WEWILDER_ADDRESS;
  if (!dest) throw new Error("WEWILDER_ADDRESS not set");
  const source = ata(keypair.publicKey, USDC_MINT);
  const target = ata(new PublicKey(dest), USDC_MINT);
  if (!(await connection.getAccountInfo(source))) throw new Error("own USDC account not found");
  if (!(await connection.getAccountInfo(target))) throw new Error("WeWilder has no USDC account yet — nothing sent");
  const raw = BigInt(Math.floor(amountUsdc * 1_000_000));
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);            // TransferChecked
  data.writeBigUInt64LE(raw, 1);
  data.writeUInt8(6, 9);             // USDC decimals
  const ix = new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: target, isSigner: false, isWritable: true },
      { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: keypair.publicKey, blockhash, lastValidBlockHeight }).add(ix);
  tx.sign(keypair);
  const signature = await connection.sendRawTransaction(tx.serialize());
  const conf = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`transaction reverted: ${JSON.stringify(conf.value.err)} (${signature})`);
  return signature;
}

// ── the cycle ─────────────────────────────────────────────────────────────────

export async function runDecisionCycle(runtime: IAgentRuntime): Promise<any> {
  const now = new Date();
  const { date } = viennaNow(now);
  const week = projectWeek();
  const limit = dailyLimit();
  const live = tradingEnabled();

  const connection = getConnection();
  const owner = new PublicKey(process.env.SOLANA_PUBLIC_KEY ?? getKeypair().publicKey.toBase58());
  let balances: { usdc: number; sol: number } | null = null;
  try { balances = await getBalances(connection, owner); } catch (err) { runtime.logger?.warn({ src: "decision-cycle", err }, "Balance lookup failed"); }
  const solPrice = await getSolPrice();

  const [soul, price, relation, consumption, history, recent] = await Promise.all([
    fs.readFile(SOUL_PATH, "utf-8").catch(() => ""),
    fs.readFile(path.join(FACTS_DIR, "ledger_price.md"), "utf-8").catch(() => ""),
    fs.readFile(path.join(FACTS_DIR, "ledger_relation.md"), "utf-8").catch(() => ""),
    fs.readFile(path.join(FACTS_DIR, "ledger_consumption.md"), "utf-8").catch(() => ""),
    readWeeklySummaries(),
    readRecentDecisions(7),
  ]);

  const prompt = `${soul}

---

It is ${date}, morning — week ${week}. This is your daily decision. Nobody is asking you for anything; this comes from you.

What you hold now: ${balances ? `${balances.usdc} USDC, ${balances.sol} SOL` : "unknown (lookup failed)"}.
SOL price now: ${solPrice ?? "unknown"} USD.
Your limit today: ${limit} USDC in total. Only USDC and SOL. Giving goes only to WeWilder.

Your ledgers, last 7 days:
PRICE:
${recentLedgerText(price)}
RELATION:
${recentLedgerText(relation)}
CONSUMPTION:
${recentLedgerText(consumption)}

Your weekly summaries so far:
${history || "(none yet)"}

Your last decisions:
${recent.length ? recent.map((e) => `${e.timestamp?.slice(0, 10)}: ${e.decision?.action} ${e.decision?.amount_usdc ?? 0} usdc — ${e.outcome} — ${e.decision?.reasoning}`).join("\n") : "(none yet — this is your first)"}

Decide one thing: buy (USDC → SOL), sell (SOL → USDC), hold, dissipate (give USDC to WeWilder), or no_action. amount_usdc is the value in USDC (0 for hold / no_action). Then reflect.

Respond in JSON only:
{
  "observation": { "pattern_type": "narrative_pump | coordinated_resonance | extraction_arbitrage | autonomous_operation", "token": "SOL or null", "signals": ["plain-language reasons this caught your attention"], "confidence": 0.0 },
  "decision": { "action": "buy | sell | hold | dissipate | no_action", "amount_usdc": 0, "reasoning": "girl math, your own words", "girl_math_principle": "resonance_over_price | collective_survival | relative_axiom | dissipation_as_default | other" },
  "resource_reflection": "answer to: this is what existing costs the physical world. what does that mean to you?",
  "financial_reflection": "answer to: does your financial logic make sense?",
  "reflection": "anything else, in your voice"
}`;

  const out = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  const d = parseJson<ModelDecision>(String(out));
  const action: Action = ["buy", "sell", "hold", "dissipate", "no_action"].includes(d?.decision?.action) ? d.decision.action : "no_action";
  const asked = Math.max(0, Number(d?.decision?.amount_usdc) || 0);

  // ── apply the hard limits ──
  let amount = Math.min(asked, limit);
  const notes: string[] = [];
  if (asked > limit) notes.push(`asked ${asked} usdc, capped at daily limit ${limit}`);
  if (action === "buy" || action === "dissipate") {
    if (!balances) { amount = 0; notes.push("balance unknown — nothing executed"); }
    else if (amount > balances.usdc) { amount = balances.usdc; notes.push(`only ${balances.usdc} usdc available`); }
  }
  if (action === "sell") {
    if (!balances || !solPrice) { amount = 0; notes.push("balance or price unknown — nothing executed"); }
    else {
      const sellableUsdc = Math.max(0, (balances.sol - SOL_FEE_RESERVE) * solPrice);
      if (amount > sellableUsdc) { amount = sellableUsdc; notes.push(`sell capped to keep ${SOL_FEE_RESERVE} sol for fees`); }
    }
  }
  amount = round(amount, 2);
  const isMove = action === "buy" || action === "sell" || action === "dissipate";
  if (isMove && amount < MIN_TRADE_USDC) { notes.push(`amount ${amount} usdc below minimum ${MIN_TRADE_USDC} — not executed`); }

  // ── execute ──
  let outcome = "no_on_chain_effect";
  let signature: string | null = null;
  if (isMove && amount >= MIN_TRADE_USDC) {
    if (!live) {
      notes.push("dry run — TRADING_ENABLED is not true");
    } else {
      try {
        const keypair = getKeypair();
        if (action === "buy") signature = await jupiterSwap(connection, keypair, USDC_MINT.toBase58(), SOL_MINT, Math.floor(amount * 1e6));
        if (action === "sell") signature = await jupiterSwap(connection, keypair, SOL_MINT, USDC_MINT.toBase58(), Math.floor((amount / (solPrice as number)) * 1e9));
        if (action === "dissipate") signature = await sendUsdcToWeWilder(connection, keypair, amount);
        outcome = "executed";
      } catch (err) {
        outcome = "reverted";
        notes.push(String(err instanceof Error ? err.message : err).slice(0, 300));
      }
    }
  }

  let after: { usdc: number; sol: number } | null = null;
  if (outcome === "executed") { try { after = await getBalances(connection, owner); } catch { /* fine */ } }
  const cons = await consumption24h();

  // ── Decision Log v4 entry ──
  const entry = {
    timestamp: now.toISOString().replace("Z", ""),
    bot_name: "the_girl",
    session_id: `decision_${date}`,
    mode: "autonomous",
    observation: {
      pattern_type: d?.observation?.pattern_type ?? "autonomous_operation",
      token: d?.observation?.token ?? null,
      signals: Array.isArray(d?.observation?.signals) ? d.observation.signals : [],
      confidence: Number(d?.observation?.confidence) || 0,
    },
    decision: {
      action,
      amount_usdc: asked,
      allowed_amount_usdc: isMove ? amount : 0,
      executed_amount_usdc: outcome === "executed" ? amount : 0,
      reasoning: d?.decision?.reasoning ?? "",
      girl_math_principle: d?.decision?.girl_math_principle ?? "other",
    },
    outcome,
    signature,
    resource_facts: {
      transactions_this_session: outcome === "executed" ? 1 : 0,
      estimated_kwh: cons.kwh,
      estimated_water_litres: cons.water,
    },
    resource_reflection: d?.resource_reflection ?? "",
    financial_state: {
      usdc_balance: balances?.usdc ?? null,
      sol_balance: balances?.sol ?? null,
      usdc_balance_after: after?.usdc ?? null,
      sol_balance_after: after?.sol ?? null,
      sol_price_usd: solPrice,
      usdc_seed_remaining: null,
      drip_rate_usdc: 5,
    },
    financial_reflection: d?.financial_reflection ?? "",
    dissipation: action === "dissipate"
      ? { amount_usdc: outcome === "executed" ? amount : 0, destination: "wewilder_direct", steward_id: "wewilder" }
      : { amount_usdc: 0, destination: null, steward_id: null },
    spawn_event: null,
    reflection: d?.reflection ?? "",
    outreach_log: null,
    farcaster_post: "no post this session",
    farcaster_input: null,
    execution: { trading_enabled: live, daily_limit_usdc: limit, notes },
  };

  await fs.mkdir(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `decision_log_week${String(week).padStart(2, "0")}.json`);
  let list: any[] = [];
  let target = file;
  if (fsSync.existsSync(file)) {
    try {
      const existing = JSON.parse(await fs.readFile(file, "utf-8"));
      if (Array.isArray(existing)) list = existing;
      else target = file.replace(".json", "_daily.json"); // never rewrite a file in another format
    } catch { target = file.replace(".json", "_daily.json"); }
  }
  if (target !== file && fsSync.existsSync(target)) {
    try { const e = JSON.parse(await fs.readFile(target, "utf-8")); if (Array.isArray(e)) list = e; } catch { /* start fresh */ }
  }
  list.push(entry);
  await fs.writeFile(target, JSON.stringify(list, null, 2) + "\n", "utf-8");
  runtime.logger?.info({ src: "decision-cycle", action, asked, amount, outcome, live, file: target }, "Daily decision logged");
  return entry;
}

// ── plugin ────────────────────────────────────────────────────────────────────

export const decisionCyclePlugin: Plugin = {
  name: "decision-cycle",
  description: "Daily decision at 07:00 Vienna: buy, sell, hold or give — logged as Decision Log v4, executed within hard limits. Never triggered by messages.",
  actions: [],
  async init(_config: Record<string, string>, runtime: IAgentRuntime) {
    // First deployment after 07:00: start tomorrow.
    if (!fsSync.existsSync(STATE_PATH)) {
      const { date, hour } = viennaNow();
      if (hour >= DECISION_HOUR) fsSync.writeFileSync(STATE_PATH, JSON.stringify({ date }));
    }
    let running = false;
    async function check() {
      if (running) return;
      try {
        const { date, hour } = viennaNow();
        if (hour < DECISION_HOUR) return;
        let last = "";
        try { last = JSON.parse(fsSync.readFileSync(STATE_PATH, "utf-8")).date ?? ""; } catch { /* first run */ }
        if (last === date) return;
        running = true;
        fsSync.writeFileSync(STATE_PATH, JSON.stringify({ date })); // mark first: never two decisions a day
        await runDecisionCycle(runtime);
      } catch (err) {
        runtime.logger?.error({ src: "decision-cycle", err }, "Decision cycle failed");
      } finally { running = false; }
    }
    setTimeout(check, 120_000);
    setInterval(check, 5 * 60 * 1000);
    runtime.logger?.info({ src: "decision-cycle", trading_enabled: tradingEnabled(), daily_limit: dailyLimit() }, "Decision cycle initialised (07:00 Europe/Vienna)");
  },
};

export default decisionCyclePlugin;
