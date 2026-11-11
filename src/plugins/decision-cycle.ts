/**
 * decision-cycle.ts
 *
 * Custom ElizaOS plugin for The Girl Protocol (rewritten 11 Nov 2026).
 *
 * Once a day at 07:00 Europe/Vienna The Girl decides — on her own — whether to buy,
 * sell, hold or give (dissipate to WeWilder). She sees her SOUL, ledgers, history,
 * her holdings, the prices of the tokens she may trade, and Jupiter's trending list
 * as a market signal. She writes a Decision Log entry (schema v4). Only then does
 * the code execute — through hard, deterministic checks.
 *
 * WHAT SHE MAY TRADE: only the fixed ALLOWLIST below. Trending tokens are shown as
 * a signal; she can name them in her reasoning but cannot buy them unless they are
 * on the list. Every allowlisted mint is checked against Jupiter's token data at
 * run time (symbol must match, token must be verified) — a typo or a changed token
 * drops out instead of being traded.
 *
 * HARD LIMITS (code, not model):
 *   - TRADING_ENABLED=true required, otherwise dry run (decides and logs only).
 *   - At most TRADING_MAX_USDC_PER_DAY (default 5, never more than 5) per day.
 *   - Buy = USDC -> allowlisted token. Sell = allowlisted token -> USDC.
 *     Dissipate = USDC -> WEWILDER_ADDRESS only.
 *   - Refused if: price impact > 1%, slippage > 3%, or the quote returns less than
 *     90% of the value put in (fees + impact), or no SOL for fees (unless gasless).
 *   - Keeps 0.02 SOL when selling SOL. Ignores amounts under 0.50 USDC.
 *   - One decision per day, triggered only by this clock — never by a message.
 *   - Token names from the trending list are sanitised before she sees them.
 *
 * Jupiter: Swap API V2 (/order + /execute), Tokens API V2, Price API V3 on api.jup.ag.
 * JUPITER_API_KEY is optional; without it, keyless access (0.5 req/s) is used and
 * requests are spaced accordingly.
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

// ── allowlist: the only tokens she may trade. Edit here. ──────────────────────
// mint -> expected symbol (checked against Jupiter's token data at run time; "A|B" = either, "$" ignored)
const ALLOWLIST: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "Bonk",
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: "WIF",       // listed as "$WIF"
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: "JTO",
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: "PYTH",
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "RAY",
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: "ORCA",
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL",
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: "RENDER|RNDR",
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": "POPCAT",
};

// ── config ────────────────────────────────────────────────────────────────────

const TIMEZONE = "Europe/Vienna";
const DECISION_HOUR = 7;
const HARD_MAX_USDC_PER_DAY = 5;
const MIN_TRADE_USDC = 0.5;
const SOL_FEE_RESERVE = 0.02;
const MIN_SOL_FOR_FEES = 0.003;
const MAX_PRICE_IMPACT_PCT = 1;      // percentage points
const MAX_SLIPPAGE_BPS = 300;        // 3%
const MIN_VALUE_RETURNED = 0.9;      // out value must be >= 90% of in value

const JUP = "https://api.jup.ag";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
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
  decision: { action: Action; token?: string | null; amount_usdc: number; reasoning: string; girl_math_principle: string };
  resource_reflection: string;
  financial_reflection: string;
  reflection: string;
}

interface TokenInfo { mint: string; symbol: string; decimals: number; usdPrice: number | null; change24h: number | null; verified: boolean }

// ── helpers ───────────────────────────────────────────────────────────────────

const tradingEnabled = () => process.env.TRADING_ENABLED === "true";

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

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Names and symbols come from token creators: keep only short plain text.
const clean = (s: unknown, max = 16) => String(s ?? "").replace(/[^A-Za-z0-9 .$_-]/g, "").trim().slice(0, max) || "?";

function getKeypair(): Keypair {
  const raw = process.env.SOLANA_PRIVATE_KEY ?? "";
  if (!raw) throw new Error("SOLANA_PRIVATE_KEY not set");
  const decode = (bs58 as any).default?.decode ?? (bs58 as any).decode;
  return Keypair.fromSecretKey(decode(raw));
}

const getConnection = () => new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");

function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID)[0];
}

// Jupiter calls, spaced for keyless rate limits (0.5 req/s) unless a key is set.
let lastJup = 0;
async function jup(pathAndQuery: string, init: RequestInit = {}): Promise<any> {
  const key = process.env.JUPITER_API_KEY;
  const gap = key ? 1100 : 2200;
  const wait = lastJup + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastJup = Date.now();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> ?? {}) };
  if (key) headers["x-api-key"] = key;
  const res = await fetch(JUP + pathAndQuery, { ...init, headers, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new Error(`jupiter ${pathAndQuery.split("?")[0]} ${res.status}: ${text.slice(0, 200)}`);
  return body;
}

// Allowlisted tokens, checked against Jupiter's token data. Drops anything that doesn't match.
async function verifiedAllowlist(): Promise<Map<string, TokenInfo>> {
  const mints = Object.keys(ALLOWLIST);
  const found = (await jup(`/tokens/v2/search?query=${mints.join(",")}`)) as any[];
  const prices = (await jup(`/price/v3?ids=${mints.join(",")}`)) as Record<string, any>;
  const out = new Map<string, TokenInfo>();
  for (const t of Array.isArray(found) ? found : []) {
    const mint = t?.id;
    const expected = ALLOWLIST[mint];
    if (!expected) continue;
    const norm = (x: string) => x.replace(/^\$/, "").toLowerCase();
    if (!expected.split("|").some((e) => norm(e) === norm(String(t.symbol)))) continue; // typo or changed token
    if (mint !== USDC_MINT && mint !== SOL_MINT && t.isVerified === false) continue;
    const p = prices?.[mint];
    out.set(mint, {
      mint, symbol: expected.split("|")[0], decimals: Number(t.decimals),
      usdPrice: Number.isFinite(Number(p?.usdPrice)) ? Number(p.usdPrice) : (Number.isFinite(Number(t.usdPrice)) ? Number(t.usdPrice) : null),
      change24h: Number.isFinite(Number(p?.priceChange24h)) ? Number(p.priceChange24h) : null,
      verified: true,
    });
  }
  return out;
}

async function trending(allow: Map<string, TokenInfo>): Promise<string> {
  try {
    const list = (await jup(`/tokens/v2/toptrending/1h?limit=15`)) as any[];
    return (Array.isArray(list) ? list : []).map((t, i) => {
      const ch = Number(t?.stats1h?.priceChange);
      return `${i + 1}. ${clean(t?.symbol, 12)} (${clean(t?.name, 24)}) — ${Number.isFinite(ch) ? (ch >= 0 ? "+" : "") + round(ch, 1) + "% 1h" : "change n/a"}${t?.isVerified ? ", verified" : ""}${allow.has(t?.id) ? " — TRADEABLE" : " — not on your list, observe only"}`;
    }).join("\n") || "(empty)";
  } catch (err) {
    return `(trending list unavailable: ${String(err instanceof Error ? err.message : err).slice(0, 80)})`;
  }
}

async function holdings(connection: Connection, owner: PublicKey): Promise<{ sol: number; tokens: Map<string, number>; unknown: number }> {
  const sol = (await connection.getBalance(owner)) / 1e9;
  const accts = await connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID });
  const tokens = new Map<string, number>();
  let unknown = 0;
  for (const a of accts.value) {
    const info = a.account.data.parsed.info;
    const amt = Number(info.tokenAmount.uiAmount ?? 0);
    if (amt <= 0) continue;
    if (ALLOWLIST[info.mint]) tokens.set(info.mint, (tokens.get(info.mint) ?? 0) + amt);
    else unknown++; // airdropped or foreign tokens: never touched
  }
  return { sol: round(sol, 6), tokens, unknown };
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
      try { const d = JSON.parse(await fs.readFile(path.join(LOG_DIR, f), "utf-8")); if (Array.isArray(d)) all.push(...d); } catch { /* skip */ }
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

interface SwapResult { signature: string; inAmount: string; outAmount: string; priceImpact: number; router: string; inUsd: number | null; outUsd: number | null }

// Jupiter Swap V2: /order (quote + transaction), checks, sign, /execute.
async function swapV2(keypair: Keypair, inputMint: string, outputMint: string, amountRaw: number, solBalance: number): Promise<SwapResult> {
  const order = await jup(`/swap/v2/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${Math.floor(amountRaw)}&taker=${keypair.publicKey.toBase58()}&slippageBps=100`);
  if (!order?.transaction) throw new Error(`no transaction: ${order?.errorMessage ?? order?.error ?? "unknown"}`);
  const impact = Math.abs(Number(order.priceImpact ?? 0));
  if (impact > MAX_PRICE_IMPACT_PCT) throw new Error(`price impact ${round(impact, 3)}% > ${MAX_PRICE_IMPACT_PCT}%`);
  if (Number(order.slippageBps ?? 0) > MAX_SLIPPAGE_BPS) throw new Error(`slippage ${order.slippageBps} bps > ${MAX_SLIPPAGE_BPS}`);
  const inUsd = Number(order.inUsdValue), outUsd = Number(order.outUsdValue);
  if (Number.isFinite(inUsd) && Number.isFinite(outUsd) && inUsd > 0 && outUsd < inUsd * MIN_VALUE_RETURNED) {
    throw new Error(`would get back ${round(outUsd, 3)} usd for ${round(inUsd, 3)} usd (< ${MIN_VALUE_RETURNED * 100}%)`);
  }
  if (!order.gasless && solBalance < MIN_SOL_FOR_FEES) throw new Error(`not enough SOL for fees (${solBalance})`);
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  tx.sign([keypair]);
  const exec = await jup(`/swap/v2/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString("base64"), requestId: order.requestId }),
  });
  if (exec?.status !== "Success") throw new Error(`execute ${exec?.status ?? "failed"}: ${exec?.error ?? exec?.code ?? ""} ${exec?.signature ?? ""}`.trim());
  return {
    signature: exec.signature, inAmount: String(exec.inputAmountResult ?? order.inAmount), outAmount: String(exec.outputAmountResult ?? order.outAmount),
    priceImpact: impact, router: String(order.router ?? ""), inUsd: Number.isFinite(inUsd) ? inUsd : null, outUsd: Number.isFinite(outUsd) ? outUsd : null,
  };
}

// USDC to WeWilder: a plain SPL TransferChecked into WeWilder's existing USDC account.
async function sendUsdcToWeWilder(connection: Connection, keypair: Keypair, amountUsdc: number): Promise<string> {
  const dest = process.env.WEWILDER_ADDRESS;
  if (!dest) throw new Error("WEWILDER_ADDRESS not set");
  const mint = new PublicKey(USDC_MINT);
  const source = ata(keypair.publicKey, mint);
  const target = ata(new PublicKey(dest), mint);
  if (!(await connection.getAccountInfo(source))) throw new Error("own USDC account not found");
  if (!(await connection.getAccountInfo(target))) throw new Error("WeWilder has no USDC account yet — nothing sent");
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(BigInt(Math.floor(amountUsdc * 1_000_000)), 1);
  data.writeUInt8(6, 9);
  const ix = new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
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
  const notes: string[] = [];

  const connection = getConnection();
  const owner = new PublicKey(process.env.SOLANA_PUBLIC_KEY ?? getKeypair().publicKey.toBase58());

  let allow = new Map<string, TokenInfo>();
  try { allow = await verifiedAllowlist(); } catch (err) { notes.push("token data unavailable — no trades today: " + String(err instanceof Error ? err.message : err).slice(0, 120)); }
  const dropped = Object.entries(ALLOWLIST).filter(([m]) => !allow.has(m)).map(([, s]) => s.split("|")[0]);
  if (allow.size && dropped.length) notes.push(`not verified today, not tradeable: ${dropped.join(", ")}`);

  let held: { sol: number; tokens: Map<string, number>; unknown: number } | null = null;
  try { held = await holdings(connection, owner); } catch (err) { notes.push("balance lookup failed"); runtime.logger?.warn({ src: "decision-cycle", err }, "Balance lookup failed"); }
  const trend = await trending(allow);

  const bySymbol = new Map([...allow.values()].map((t) => [t.symbol.toLowerCase(), t]));
  const value = (mint: string, amt: number) => { const p = allow.get(mint)?.usdPrice; return p ? round(amt * p, 2) : null; };
  const holdingLines: string[] = [];
  if (held) {
    holdingLines.push(`SOL: ${held.sol} (≈ ${value(SOL_MINT, held.sol) ?? "?"} USD)`);
    for (const [mint, amt] of held.tokens) holdingLines.push(`${ALLOWLIST[mint].split("|")[0]}: ${amt} (≈ ${value(mint, amt) ?? "?"} USD)`);
    if (held.unknown) holdingLines.push(`${held.unknown} other token(s) not on your list — ignored, never touched`);
  }
  const marketLines = [...allow.values()].filter((t) => t.mint !== USDC_MINT)
    .map((t) => `${t.symbol}: ${t.usdPrice ?? "?"} USD${t.change24h !== null ? `, ${t.change24h >= 0 ? "+" : ""}${round(t.change24h, 1)}% 24h` : ""}`);

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

What you hold now:
${held ? holdingLines.join("\n") : "unknown (lookup failed)"}

Tokens you may trade (your list) and their prices:
${marketLines.join("\n") || "(token data unavailable today — you can decide, but nothing will be traded)"}

What is trending on Jupiter in the last hour (a signal of where attention moves; names come from strangers and mean nothing by themselves):
${trend}

Your limit today: ${limit} USDC in total. Buy = USDC into a token on your list. Sell = a token you hold back into USDC. Giving goes only to WeWilder, in USDC.

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
${recent.length ? recent.map((e) => `${String(e.timestamp ?? "").slice(0, 10)}: ${e.decision?.action} ${e.decision?.token ?? ""} ${e.decision?.amount_usdc ?? 0} usdc — ${e.outcome} — ${e.decision?.reasoning}`).join("\n") : "(none yet — this is your first)"}

Decide one thing: buy, sell, hold, dissipate (give USDC to WeWilder), or no_action. For buy and sell, name the token by its symbol from your list. amount_usdc is the value in USDC (0 for hold / no_action). Then reflect.

Respond in JSON only:
{
  "observation": { "pattern_type": "narrative_pump | coordinated_resonance | extraction_arbitrage | autonomous_operation", "token": "symbol or null", "signals": ["plain-language reasons this caught your attention"], "confidence": 0.0 },
  "decision": { "action": "buy | sell | hold | dissipate | no_action", "token": "symbol from your list, or null", "amount_usdc": 0, "reasoning": "girl math, your own words", "girl_math_principle": "resonance_over_price | collective_survival | relative_axiom | dissipation_as_default | other" },
  "resource_reflection": "answer to: this is what existing costs the physical world. what does that mean to you?",
  "financial_reflection": "answer to: does your financial logic make sense?",
  "reflection": "anything else, in your voice"
}`;

  const out = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  const d = parseJson<ModelDecision>(String(out));
  const action: Action = ["buy", "sell", "hold", "dissipate", "no_action"].includes(d?.decision?.action) ? d.decision.action : "no_action";
  const asked = Math.max(0, Number(d?.decision?.amount_usdc) || 0);
  const isMove = action === "buy" || action === "sell" || action === "dissipate";

  // ── resolve the token and apply the hard limits ──
  let token: TokenInfo | null = null;
  if (action === "buy" || action === "sell") {
    token = bySymbol.get(String(d?.decision?.token ?? "").toLowerCase()) ?? null;
    if (!token) notes.push(`token "${clean(d?.decision?.token, 20)}" is not on the verified list — not executed`);
    else if (token.mint === USDC_MINT) { notes.push("buying or selling USDC for USDC makes no sense — not executed"); token = null; }
    else if (!token.usdPrice) { notes.push(`no reliable price for ${token.symbol} — not executed`); token = null; }
  }

  let amount = Math.min(asked, limit);
  if (asked > limit) notes.push(`asked ${asked} usdc, capped at daily limit ${limit}`);
  const usdcHeld = held?.tokens.get(USDC_MINT) ?? 0;
  if (action === "buy" || action === "dissipate") {
    if (!held) { amount = 0; notes.push("balance unknown — nothing executed"); }
    else if (amount > usdcHeld) { amount = usdcHeld; notes.push(`only ${usdcHeld} usdc available`); }
  }
  if (action === "sell" && token && held) {
    const have = token.mint === SOL_MINT ? Math.max(0, held.sol - SOL_FEE_RESERVE) : (held.tokens.get(token.mint) ?? 0);
    const haveUsd = have * (token.usdPrice ?? 0);
    if (amount > haveUsd) { amount = haveUsd; notes.push(`only ≈${round(haveUsd, 2)} usdc of ${token.symbol} available${token.mint === SOL_MINT ? ` (keeping ${SOL_FEE_RESERVE} sol for fees)` : ""}`); }
  }
  amount = round(amount, 2);
  const tokenOk = action === "dissipate" || !!token;
  if (isMove && tokenOk && amount < MIN_TRADE_USDC) notes.push(`amount ${amount} usdc below minimum ${MIN_TRADE_USDC} — not executed`);

  // ── execute ──
  let outcome = "no_on_chain_effect";
  let signature: string | null = null;
  let trade: SwapResult | null = null;
  if (isMove && tokenOk && amount >= MIN_TRADE_USDC) {
    if (!live) notes.push("dry run — TRADING_ENABLED is not true");
    else {
      try {
        const keypair = getKeypair();
        if (action === "buy" && token) trade = await swapV2(keypair, USDC_MINT, token.mint, amount * 1e6, held?.sol ?? 0);
        if (action === "sell" && token) trade = await swapV2(keypair, token.mint, USDC_MINT, (amount / (token.usdPrice as number)) * 10 ** token.decimals, held?.sol ?? 0);
        if (action === "dissipate") signature = await sendUsdcToWeWilder(connection, keypair, amount);
        if (trade) signature = trade.signature;
        outcome = "executed";
      } catch (err) {
        outcome = "reverted";
        notes.push(String(err instanceof Error ? err.message : err).slice(0, 300));
      }
    }
  }

  let after: { sol: number; tokens: Map<string, number> } | null = null;
  if (outcome === "executed") { try { after = await holdings(connection, owner); } catch { /* fine */ } }
  const cons = await consumption24h();
  const snapshot = (h: typeof held | typeof after) => h ? { SOL: h.sol, ...Object.fromEntries([...h.tokens].map(([m, a]) => [ALLOWLIST[m].split("|")[0], a])) } : null;

  // ── Decision Log v4 entry ──
  const entry = {
    timestamp: now.toISOString().replace("Z", ""),
    bot_name: "the_girl",
    session_id: `decision_${date}`,
    mode: "autonomous",
    observation: {
      pattern_type: d?.observation?.pattern_type ?? "autonomous_operation",
      token: d?.observation?.token ? clean(d.observation.token, 20) : null,
      signals: Array.isArray(d?.observation?.signals) ? d.observation.signals : [],
      confidence: Number(d?.observation?.confidence) || 0,
    },
    decision: {
      action,
      token: token?.symbol ?? (d?.decision?.token ? clean(d.decision.token, 20) : null),
      token_mint: token?.mint ?? null,
      amount_usdc: asked,
      allowed_amount_usdc: isMove && tokenOk ? amount : 0,
      executed_amount_usdc: outcome === "executed" ? amount : 0,
      reasoning: d?.decision?.reasoning ?? "",
      girl_math_principle: d?.decision?.girl_math_principle ?? "other",
    },
    outcome,
    signature,
    trade: trade ? { in_amount_raw: trade.inAmount, out_amount_raw: trade.outAmount, in_usd: trade.inUsd, out_usd: trade.outUsd, price_impact_pct: trade.priceImpact, router: trade.router } : null,
    resource_facts: { transactions_this_session: outcome === "executed" ? 1 : 0, estimated_kwh: cons.kwh, estimated_water_litres: cons.water },
    resource_reflection: d?.resource_reflection ?? "",
    financial_state: {
      holdings_before: snapshot(held),
      holdings_after: snapshot(after),
      usdc_balance: held ? usdcHeld : null,
      sol_price_usd: allow.get(SOL_MINT)?.usdPrice ?? null,
      usdc_seed_remaining: null,
      drip_rate_usdc: null,
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
    market_context: { trending_1h: trend.split("\n").slice(0, 15), tradeable: [...allow.values()].map((t) => t.symbol) },
    execution: { trading_enabled: live, daily_limit_usdc: limit, notes },
  };

  await fs.mkdir(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `decision_log_week${String(week).padStart(2, "0")}.json`);
  let list: any[] = [];
  let target = file;
  if (fsSync.existsSync(file)) {
    try {
      const existing = JSON.parse(await fs.readFile(file, "utf-8"));
      if (Array.isArray(existing)) list = existing; else target = file.replace(".json", "_daily.json");
    } catch { target = file.replace(".json", "_daily.json"); }
  }
  if (target !== file && fsSync.existsSync(target)) {
    try { const e = JSON.parse(await fs.readFile(target, "utf-8")); if (Array.isArray(e)) list = e; } catch { /* start fresh */ }
  }
  list.push(entry);
  await fs.writeFile(target, JSON.stringify(list, null, 2) + "\n", "utf-8");
  runtime.logger?.info({ src: "decision-cycle", action, token: entry.decision.token, asked, amount, outcome, live, file: target }, "Daily decision logged");
  return entry;
}

// ── plugin ────────────────────────────────────────────────────────────────────

export const decisionCyclePlugin: Plugin = {
  name: "decision-cycle",
  description: "Daily decision at 07:00 Vienna: buy, sell, hold or give — allowlisted tokens only, Jupiter trending as signal, hard limits in code. Never triggered by messages.",
  actions: [],
  async init(_config: Record<string, string>, runtime: IAgentRuntime) {
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
    runtime.logger?.info({ src: "decision-cycle", trading_enabled: tradingEnabled(), daily_limit: dailyLimit(), allowlist: Object.values(ALLOWLIST).map((s) => s.split("|")[0]) }, "Decision cycle initialised (07:00 Europe/Vienna)");
  },
};

export default decisionCyclePlugin;
