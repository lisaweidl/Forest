/**
 * decision-cycle.ts
 *
 * Custom ElizaOS plugin for The Girl Protocol (rewritten 11 Nov 2026, rules v2 28 Nov 2026).
 *
 * Once a day at 07:00 Europe/Vienna The Girl decides — on her own — whether to buy,
 * sell, hold or give (dissipate to WeWilder). She sees her SOUL, her girl math
 * principles and her transaction rules (knowledge/girl_math_principles.md,
 * knowledge/transaction_rules.md), ledgers, history, holdings, SOL's price and
 * Jupiter's trending list as a market mood. She writes a Decision Log entry (v4).
 * Only then does the code execute — through hard, deterministic checks that follow
 * knowledge/transaction_rules.md v2:
 *
 *   WHAT SHE MAY SIGN: SOL<->USDC swaps through Jupiter, USDC transfers to WeWilder.
 *   LIMITS: TRADING_ENABLED=true or nothing executes; at most 5 USDC a day (trades and
 *     gifts together); no move under 0.50 USDC; price impact <= 1 %, slippage <= 3 %,
 *     >= 90 % of the value back; network fee <= 0.001 SOL; 0.02 SOL kept for fees.
 *   BEFORE SIGNING (swaps): the quote must be fresh (< 45 s) and match the intention;
 *     every top-level program must be on the approved list; no Approve / SetAuthority,
 *     no transfers out of her accounts except small fee-sized ones (counted as fee),
 *     no account closed to someone else; the transaction is simulated and her
 *     balances must change as intended — only the input token goes down, by no more
 *     than intended, and >= 90 % of the value comes back. Gifts are simulated too.
 *   AFTER SENDING: the on-chain status decides — confirmed: recorded once and
 *     balances re-read; definitely failed: fee recorded, retry at the earliest next
 *     morning; pending / unknown / inconsistent: STOP + private alert.
 *   STOP: assets/trading_halt.json (see alerts.ts). While it exists she still decides
 *     and logs, but nothing executes. Set by: anomalies before signing, unknown status,
 *     the wallet watchdog, a transaction left in flight by a restart. Only a human
 *     removes it. The sweep (jupiter-trading.ts) is not affected.
 *   One decision per day, triggered only by this clock — never by a message.
 *
 * Jupiter: Swap API V2 (/order + /execute), Tokens API V2, Price API V3 on api.jup.ag.
 * JUPITER_API_KEY is optional. TRADING_EXTRA_PROGRAMS (comma-separated program ids)
 * adds programs to the approved list — check them first with test-trade-check.ts.
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
import { tradingHalt, haltAndAlert } from "./alerts";

// ── allowlist: the only tokens she may trade. ─────────────────────────────────
// mint -> expected symbol (checked against Jupiter's token data at run time; "A|B" = either, "$" ignored)
const ALLOWLIST: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
};   // transaction_rules.md v2: SOL and USDC only

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
const FEE_CAP_LAMPORTS = 1_000_000;  // 0.001 SOL network fee per transaction
const ORDER_MAX_AGE_MS = 45_000;     // a quote older than this is stale
const SOL_IN_MARGIN_LAMPORTS = 6_000_000; // selling SOL: fees + rent for temporary accounts on top of the amount
const STATUS_WAIT_MS = 150_000;      // how long to wait for an on-chain status

// Top-level programs a transaction may call. DEXes are reached through Jupiter (CPI)
// and are covered by the simulation.
const APPROVED_PROGRAMS = new Set<string>([
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111",               // System
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",    // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",    // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",   // Associated Token Account
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",    // Jupiter Aggregator v6
  "61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnESmms1",    // Jupiter Order Engine (RFQ)
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",    // Memo
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",    // Memo (v1)
  ...String(process.env.TRADING_EXTRA_PROGRAMS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
]);

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
const PENDING_PATH = path.join(ROOT, "assets", "pending_transaction.json");
const GIRL_MATH_PATH = path.join(ROOT, "knowledge", "girl_math_principles.md");
const RULES_PATH = path.join(ROOT, "knowledge", "transaction_rules.md");
const TOKEN_2022_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type Action = "buy" | "sell" | "hold" | "dissipate" | "no_action";

interface ModelDecision {
  observation: { pattern_type: string; token: string | null; signals: string[]; confidence: number };
  decision: { action: Action; token?: string | null; amount_usdc: number; reasoning: string; girl_math_principle: string; girl_math_rule?: string };
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

// An anomaly = the transaction does not match her intention or contains something
// unapproved. Rule: reject, stop, alert. Other failures (RPC down, stale quote, limit
// exceeded, simulation failing) only mean "not sent today".
class Anomaly extends Error {}

type Status = "executed" | "failed" | "unknown";
interface Settled { status: Status; signature: string; feeLamports: number | null; detail: string }

interface SwapResult {
  status: Status; signature: string | null; detail: string;
  inAmount: string; outAmount: string; priceImpact: number; router: string;
  inUsd: number | null; outUsd: number | null; feeLamports: number | null; programs: string[];
}

const u64 = (b: Buffer | Uint8Array, off: number) => Buffer.from(b).readBigUInt64LE(off);

function writePending(p: Record<string, unknown>): void {
  fsSync.mkdirSync(path.dirname(PENDING_PATH), { recursive: true });
  fsSync.writeFileSync(PENDING_PATH, JSON.stringify({ ...p, at: new Date().toISOString() }, null, 2));
}
function clearPending(): void { try { fsSync.rmSync(PENDING_PATH, { force: true }); } catch { /* fine */ } }

// Waits for the on-chain status of a signature. Definitely failed = an error on chain,
// or never landed and its blockhash has expired. Anything else after the wait = unknown.
async function settle(connection: Connection, signature: string, blockhash: string): Promise<Settled> {
  const started = Date.now();
  while (Date.now() - started < STATUS_WAIT_MS) {
    try {
      const st = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        let fee: number | null = null;
        try { fee = (await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }))?.meta?.fee ?? null; } catch { /* fee unknown */ }
        if (st.err) return { status: "failed", signature, feeLamports: fee, detail: `failed on chain: ${JSON.stringify(st.err)}` };
        return { status: "executed", signature, feeLamports: fee, detail: "confirmed" };
      }
      if (!st) {
        const valid = await connection.isBlockhashValid(blockhash, { commitment: "confirmed" }).then((r) => r.value).catch(() => true);
        if (!valid) {
          // one last look: it could have landed just before expiry
          const again = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
          if (!again) return { status: "failed", signature, feeLamports: 0, detail: "never landed, blockhash expired — no funds moved" };
          continue;
        }
      }
    } catch { /* RPC hiccup: keep waiting */ }
    await sleep(3000);
  }
  return { status: "unknown", signature, feeLamports: null, detail: `no final status after ${STATUS_WAIT_MS / 1000} s` };
}

// Balances of her accounts: lamports of the wallet, token amount (raw) of token accounts.
async function snapshotAccounts(connection: Connection, addrs: PublicKey[]): Promise<Map<string, bigint | null>> {
  const infos = await connection.getMultipleAccountsInfo(addrs, "confirmed");
  const m = new Map<string, bigint | null>();
  addrs.forEach((a, i) => {
    const info = infos[i];
    if (!info) m.set(a.toBase58(), null);
    else if (i === 0) m.set(a.toBase58(), BigInt(info.lamports));
    else m.set(a.toBase58(), info.data.length >= 72 ? u64(info.data, 64) : null);
  });
  return m;
}

// Checks a Jupiter transaction against her intention before she signs it.
async function inspectSwap(
  connection: Connection, owner: PublicKey, vtx: VersionedTransaction, ownTokenAccounts: PublicKey[],
  intent: { inputMint: string; outputMint: string; inAmountRaw: bigint; inUsd: number; solPrice: number; gasless: boolean },
): Promise<{ feeLamports: number; programs: string[] }> {
  const msg = vtx.message;
  // resolve address lookup tables so every account is known
  const alts = [];
  for (const l of msg.addressTableLookups) {
    const t = (await connection.getAddressLookupTable(l.accountKey)).value;
    if (!t) throw new Error(`lookup table ${l.accountKey.toBase58()} unavailable — not sent`);
    alts.push(t);
  }
  const keys = msg.getAccountKeys({ addressLookupTableAccounts: alts });
  const key = (i: number) => keys.get(i)?.toBase58() ?? "?";
  const me = owner.toBase58();
  const usdcAta = ata(owner, new PublicKey(USDC_MINT)).toBase58();
  const wsolAta = ata(owner, new PublicKey(SOL_MINT)).toBase58();
  const mine = new Set([me, usdcAta, wsolAta, ...ownTokenAccounts.map((a) => a.toBase58())]);

  let cuLimit = 200_000, cuPriceMicro = 0n, smallTransfers = 0n;
  const programs: string[] = [];
  for (const ix of msg.compiledInstructions) {
    const prog = key(ix.programIdIndex);
    programs.push(prog);
    if (!APPROVED_PROGRAMS.has(prog)) throw new Anomaly(`unapproved program ${prog}`);
    const d = Buffer.from(ix.data);
    const acc = (n: number) => key(ix.accountKeyIndexes[n]);
    if (prog === "ComputeBudget111111111111111111111111111111") {
      if (d[0] === 2) cuLimit = d.readUInt32LE(1);
      if (d[0] === 3) cuPriceMicro = u64(d, 1);
    } else if (prog === "11111111111111111111111111111111") {
      const kind = d.length >= 4 ? d.readUInt32LE(0) : -1;
      if (kind === 2) {                                   // Transfer
        const lamports = u64(d, 4);
        if (acc(0) === me && acc(1) !== wsolAta) smallTransfers += lamports;  // tip / fee to someone else
        else if (acc(0) !== me) throw new Anomaly("SOL transfer from an account that isn't hers");
      } else if (kind !== 0 && kind !== 1 && kind !== 8) {  // CreateAccount, Assign, Allocate allowed
        throw new Anomaly(`unexpected System instruction ${kind}`);
      }
    } else if (prog === TOKEN_PROGRAM_ID.toBase58() || prog === TOKEN_2022_ID.toBase58()) {
      const op = d[0];
      if (op === 4 || op === 13) throw new Anomaly("token Approve (delegate) in transaction");
      if (op === 6) throw new Anomaly("token SetAuthority in transaction");
      if (op === 9 && acc(1) !== me) throw new Anomaly(`token account closed to ${acc(1)}, not to her`);
      if ((op === 3 || op === 12) && mine.has(acc(0)) && !mine.has(acc(op === 3 ? 1 : 2))) throw new Anomaly("token transfer out of her account at top level");
      if (![1, 3, 5, 9, 12, 16, 17, 18].includes(op)) throw new Anomaly(`unexpected token instruction ${op}`);
    } else if (prog === ATA_PROGRAM_ID.toBase58()) {
      if (acc(2) !== me) throw new Anomaly(`token account created for ${acc(2)}, not for her`);
    }
  }

  // network fee: signatures + priority fee (+ small transfers to others, counted as fee)
  const priority = (cuPriceMicro * BigInt(cuLimit) + 999_999n) / 1_000_000n;
  const payerIsHer = key(0) === me;
  const fee = Number((payerIsHer ? BigInt(msg.header.numRequiredSignatures) * 5000n + priority : 0n) + smallTransfers);
  if (fee > FEE_CAP_LAMPORTS) throw new Error(`network fee ${fee / 1e9} SOL > ${FEE_CAP_LAMPORTS / 1e9} SOL — not sent`);

  // simulate and compare her balances
  const watch = [owner, new PublicKey(usdcAta), new PublicKey(wsolAta), ...ownTokenAccounts.filter((a) => a.toBase58() !== usdcAta && a.toBase58() !== wsolAta)];
  const before = await snapshotAccounts(connection, watch);
  const sim = await connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { addresses: watch.map((a) => a.toBase58()), encoding: "base64" } });
  if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)} — not sent`);
  const after = new Map<string, bigint | null>();
  (sim.value.accounts ?? []).forEach((a, i) => {
    const addr = watch[i].toBase58();
    if (!a) after.set(addr, null);
    else if (i === 0) after.set(addr, BigInt(a.lamports));
    else { const raw = Buffer.from((a.data as string[])[0], "base64"); after.set(addr, raw.length >= 72 ? u64(raw, 64) : null); }
  });
  const delta = (addr: string) => (after.get(addr) ?? 0n) - (before.get(addr) ?? 0n);
  const dSol = delta(me), dUsdc = delta(usdcAta);
  for (const a of watch.slice(2)) {
    const addr = a.toBase58();
    if (addr === usdcAta) continue;
    if (delta(addr) < 0n && !(addr === wsolAta && intent.inputMint === SOL_MINT)) throw new Anomaly(`simulation: balance of her account ${addr} would drop`);
  }
  const value = intent.inUsd * MIN_VALUE_RETURNED;
  if (intent.inputMint === USDC_MINT) {
    if (-dUsdc > intent.inAmountRaw) throw new Anomaly(`simulation: ${Number(-dUsdc) / 1e6} USDC would leave, intended ${Number(intent.inAmountRaw) / 1e6}`);
    const wsolGain = delta(wsolAta) > 0n ? delta(wsolAta) : 0n;   // output may stay wrapped
    const solGotUsd = (Number(dSol + wsolGain) + fee) / 1e9 * intent.solPrice;
    if (solGotUsd < value) throw new Anomaly(`simulation: only ≈${round(solGotUsd, 3)} USD of SOL would come back for ${round(intent.inUsd, 3)} USD`);
  } else {
    if (-dSol > intent.inAmountRaw + BigInt(SOL_IN_MARGIN_LAMPORTS)) throw new Anomaly(`simulation: ${Number(-dSol) / 1e9} SOL would leave, intended ${Number(intent.inAmountRaw) / 1e9}`);
    if (dUsdc < 0n) throw new Anomaly("simulation: USDC would drop on a SOL sale");
    if (Number(dUsdc) / 1e6 < value) throw new Anomaly(`simulation: only ${Number(dUsdc) / 1e6} USDC would come back for ${round(intent.inUsd, 3)} USD`);
  }
  return { feeLamports: fee, programs: [...new Set(programs)] };
}

// Jupiter Swap V2: /order, checks against the intention, sign, /execute, then the on-chain status decides.
export async function swapV2(
  connection: Connection, keypair: Keypair, inputMint: string, outputMint: string, amountRaw: number,
  solBalance: number, solPrice: number, ownTokenAccounts: PublicKey[], opts: { send: boolean } = { send: true },
): Promise<SwapResult> {
  const orderedAt = Date.now();
  const order = await jup(`/swap/v2/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${Math.floor(amountRaw)}&taker=${keypair.publicKey.toBase58()}&slippageBps=100`);
  if (!order?.transaction) throw new Error(`no transaction: ${order?.errorMessage ?? order?.error ?? "unknown"}`);
  if (order.inputMint && order.inputMint !== inputMint) throw new Anomaly(`order input ${order.inputMint} ≠ ${inputMint}`);
  if (order.outputMint && order.outputMint !== outputMint) throw new Anomaly(`order output ${order.outputMint} ≠ ${outputMint}`);
  if (order.inAmount && BigInt(order.inAmount) > BigInt(Math.floor(amountRaw))) throw new Anomaly(`order spends ${order.inAmount}, intended ${Math.floor(amountRaw)}`);
  const impact = Math.abs(Number(order.priceImpact ?? 0));
  if (impact > MAX_PRICE_IMPACT_PCT) throw new Error(`price impact ${round(impact, 3)}% > ${MAX_PRICE_IMPACT_PCT}%`);
  if (Number(order.slippageBps ?? 0) > MAX_SLIPPAGE_BPS) throw new Error(`slippage ${order.slippageBps} bps > ${MAX_SLIPPAGE_BPS}`);
  const inUsd = Number(order.inUsdValue), outUsd = Number(order.outUsdValue);
  if (Number.isFinite(inUsd) && Number.isFinite(outUsd) && inUsd > 0 && outUsd < inUsd * MIN_VALUE_RETURNED) {
    throw new Error(`would get back ${round(outUsd, 3)} usd for ${round(inUsd, 3)} usd (< ${MIN_VALUE_RETURNED * 100}%)`);
  }
  if (!order.gasless && solBalance < MIN_SOL_FOR_FEES) throw new Error(`not enough SOL for fees (${solBalance})`);
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  const intentUsd = Number.isFinite(inUsd) && inUsd > 0 ? inUsd : (inputMint === USDC_MINT ? amountRaw / 1e6 : amountRaw / 1e9 * solPrice);
  const checked = await inspectSwap(connection, keypair.publicKey, tx, ownTokenAccounts,
    { inputMint, outputMint, inAmountRaw: BigInt(Math.floor(amountRaw)), inUsd: intentUsd, solPrice, gasless: !!order.gasless });
  const base = { inAmount: String(order.inAmount ?? amountRaw), outAmount: String(order.outAmount ?? ""), priceImpact: impact, router: String(order.router ?? ""),
    inUsd: Number.isFinite(inUsd) ? inUsd : null, outUsd: Number.isFinite(outUsd) ? outUsd : null, programs: checked.programs };
  if (!opts.send) return { ...base, status: "unknown", signature: null, detail: "checked and simulated only — not signed, not sent", feeLamports: checked.feeLamports };
  if (Date.now() - orderedAt > ORDER_MAX_AGE_MS) throw new Error("quote is stale — not sent");

  tx.sign([keypair]);
  const decode58 = (bs58 as any).default?.encode ?? (bs58 as any).encode;
  const signature: string = decode58(tx.signatures[0]);
  writePending({ signature, kind: "swap", inputMint, outputMint, amountRaw: Math.floor(amountRaw) });
  let execStatus = "no answer";
  try {
    const exec = await jup(`/swap/v2/execute`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString("base64"), requestId: order.requestId }),
    });
    execStatus = String(exec?.status ?? "no status");
    if (exec?.outputAmountResult) base.outAmount = String(exec.outputAmountResult);
    if (exec?.inputAmountResult) base.inAmount = String(exec.inputAmountResult);
  } catch (err) { execStatus = `error: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`; }
  const s = await settle(connection, signature, tx.message.recentBlockhash);
  const inconsistent = (s.status === "executed" && execStatus !== "Success") || (s.status !== "executed" && execStatus === "Success");
  clearPending();
  return { ...base, status: inconsistent && s.status !== "executed" ? "unknown" : s.status, signature, feeLamports: s.feeLamports,
    detail: `${s.detail}; jupiter said: ${execStatus}${inconsistent ? " — INCONSISTENT" : ""}` };
}

// USDC to WeWilder: a plain SPL TransferChecked into WeWilder's existing USDC account.
// Simulated before sending; the on-chain status decides afterwards.
async function sendUsdcToWeWilder(connection: Connection, keypair: Keypair, amountUsdc: number): Promise<Settled> {
  const dest = process.env.WEWILDER_ADDRESS;
  if (!dest) throw new Error("WEWILDER_ADDRESS not set");
  const mint = new PublicKey(USDC_MINT);
  const source = ata(keypair.publicKey, mint);
  const target = ata(new PublicKey(dest), mint);
  if (!(await connection.getAccountInfo(source))) throw new Error("own USDC account not found");
  if (!(await connection.getAccountInfo(target))) throw new Error("WeWilder has no USDC account yet — nothing sent");
  const raw = BigInt(Math.floor(amountUsdc * 1_000_000));
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(raw, 1);
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
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)} — not sent`);
  const decode58 = (bs58 as any).default?.encode ?? (bs58 as any).encode;
  const signature: string = decode58(tx.signature!);
  writePending({ signature, kind: "gift", amountUsdc, destination: dest });
  try { await connection.sendRawTransaction(tx.serialize()); } catch { /* the status check below decides */ }
  const s = await settle(connection, signature, blockhash);
  clearPending();
  return s;
}

// For test-trade-check.ts: builds and checks a real order, simulates it, never signs or sends.
export async function checkTradeOnly(inputSymbol: "USDC" | "SOL", amount: number): Promise<string> {
  const connection = getConnection();
  const keypair = getKeypair();
  const allow = await verifiedAllowlist();
  const solPrice = allow.get(SOL_MINT)?.usdPrice;
  if (!solPrice) throw new Error("no SOL price");
  const held = await holdings(connection, keypair.publicKey);
  const own = await ownTokenAccounts(connection, keypair.publicKey);
  const [inMint, outMint, raw] = inputSymbol === "USDC" ? [USDC_MINT, SOL_MINT, amount * 1e6] : [SOL_MINT, USDC_MINT, (amount / solPrice) * 1e9];
  const r = await swapV2(connection, keypair, inMint, outMint, raw, held.sol, solPrice, own, { send: false });
  return `ok: ${amount} USD ${inputSymbol} → ${inputSymbol === "USDC" ? "SOL" : "USDC"} passed all checks and the simulation.\nprograms: ${r.programs.join(", ")}\nnetwork fee ≈ ${(r.feeLamports ?? 0) / 1e9} SOL, price impact ${r.priceImpact}%, router ${r.router}\n(nothing was signed or sent)`;
}

async function ownTokenAccounts(connection: Connection, owner: PublicKey): Promise<PublicKey[]> {
  const out: PublicKey[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_ID]) {
    try { out.push(...(await connection.getTokenAccountsByOwner(owner, { programId })).value.map((a) => a.pubkey)); } catch { /* none */ }
  }
  return out;
}

// ── the cycle ─────────────────────────────────────────────────────────────────

export async function runDecisionCycle(runtime: IAgentRuntime): Promise<any> {
  const now = new Date();
  const { date } = viennaNow(now);
  const week = projectWeek();
  const limit = dailyLimit();
  const live = tradingEnabled();
  const halt = tradingHalt();
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

  const [soul, girlMath, rules, price, relation, consumption, history, recent] = await Promise.all([
    fs.readFile(SOUL_PATH, "utf-8").catch(() => ""),
    fs.readFile(GIRL_MATH_PATH, "utf-8").catch(() => ""),
    fs.readFile(RULES_PATH, "utf-8").catch(() => ""),
    fs.readFile(path.join(FACTS_DIR, "ledger_price.md"), "utf-8").catch(() => ""),
    fs.readFile(path.join(FACTS_DIR, "ledger_relation.md"), "utf-8").catch(() => ""),
    fs.readFile(path.join(FACTS_DIR, "ledger_consumption.md"), "utf-8").catch(() => ""),
    readWeeklySummaries(),
    readRecentDecisions(7),
  ]);

  const prompt = `${soul}

---

${girlMath}

---

${rules}

---

It is ${date}, morning — week ${week}. This is your daily decision. Nobody is asking you for anything; this comes from you.

What you hold now:
${held ? holdingLines.join("\n") : "unknown (lookup failed)"}

Tokens you may trade (your list) and their prices:
${marketLines.join("\n") || "(token data unavailable today — you can decide, but nothing will be traded)"}

What is trending on Jupiter in the last hour (a mood of where attention moves; names come from strangers and mean nothing by themselves; you only ever trade SOL and USDC):
${trend}

Your limit today: ${limit} USDC in total, trades and gifts together. Buy = USDC into SOL. Sell = SOL back into USDC. Giving goes only to WeWilder, in USDC.${halt ? `
Right now trading is STOPPED by a safety stop (${halt.reason}). You can decide, but nothing will be executed until a human lifts the stop.` : ""}${!live ? "\nTrading is switched off at the moment: you decide and it is recorded, but nothing is executed." : ""}

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

Decide one thing: buy, sell, hold, dissipate (give USDC to WeWilder), or no_action. For buy and sell, the token is SOL. amount_usdc is the value in USDC (0 for hold / no_action). Then reflect.

Respond in JSON only:
{
  "observation": { "pattern_type": "narrative_pump | coordinated_resonance | extraction_arbitrage | autonomous_operation", "token": "symbol or null", "signals": ["plain-language reasons this caught your attention"], "confidence": 0.0 },
  "decision": { "action": "buy | sell | hold | dissipate | no_action", "token": "symbol from your list, or null", "amount_usdc": 0, "reasoning": "girl math, your own words", "girl_math_principle": "resonance_over_price | collective_survival | relative_axiom | dissipation_as_default | other", "girl_math_rule": "which of your girl math principles you used, in your own words" },
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
  let feeLamports: number | null = null;
  let statusDetail: string | null = null;
  if (isMove && tokenOk && amount >= MIN_TRADE_USDC) {
    if (!live) notes.push("dry run — TRADING_ENABLED is not true");
    else if (halt) { outcome = "halted"; notes.push(`trading stopped since ${halt.at} (${halt.reason}) — nothing executed`); }
    else {
      try {
        const keypair = getKeypair();
        const own = await ownTokenAccounts(connection, owner);
        const solPrice = allow.get(SOL_MINT)?.usdPrice ?? 0;
        if (action === "buy" && token) trade = await swapV2(connection, keypair, USDC_MINT, token.mint, amount * 1e6, held?.sol ?? 0, solPrice, own);
        if (action === "sell" && token) trade = await swapV2(connection, keypair, token.mint, USDC_MINT, (amount / (token.usdPrice as number)) * 10 ** token.decimals, held?.sol ?? 0, solPrice, own);
        let s: { status: string; signature: string | null; feeLamports: number | null; detail: string } | null = trade;
        if (action === "dissipate") s = await sendUsdcToWeWilder(connection, keypair, amount);
        if (s) {
          signature = s.signature; feeLamports = s.feeLamports; statusDetail = s.detail;
          if (s.status === "executed") outcome = "executed";
          else if (s.status === "failed") { outcome = "failed"; notes.push(`failed, no funds moved beyond fees (${s.detail}) — next attempt at the earliest tomorrow`); }
          else {
            outcome = "unknown";
            notes.push(`status unknown (${s.detail}) — trading stopped`);
            await haltAndAlert(`transaction status unknown after the morning ${action}`, "decision-cycle",
              `${action} ${amount} USDC${token ? " " + token.symbol : ""}\n${s.detail}\n${signature ? "https://solscan.io/tx/" + signature : ""}`, runtime.logger as any);
          }
        }
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err).slice(0, 300);
        if (err instanceof Anomaly) {
          outcome = "rejected";
          notes.push(`rejected before signing: ${msg} — trading stopped`);
          await haltAndAlert(`transaction did not match her intention: ${msg}`, "decision-cycle", `${action} ${amount} USDC${token ? " " + token.symbol : ""} — nothing was signed`, runtime.logger as any);
        } else {
          outcome = "not_sent";
          notes.push(msg);
        }
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
      girl_math_rule: d?.decision?.girl_math_rule ?? "",
    },
    outcome,
    signature,
    trade: trade ? { in_amount_raw: trade.inAmount, out_amount_raw: trade.outAmount, in_usd: trade.inUsd, out_usd: trade.outUsd, price_impact_pct: trade.priceImpact, router: trade.router, programs: trade.programs } : null,
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
    execution: { trading_enabled: live, trading_halted: halt ? { since: halt.at, reason: halt.reason } : null, daily_limit_usdc: limit, fee_lamports: feeLamports, status_detail: statusDetail, rules: "transaction_rules.md v2", notes },
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
  description: "Daily decision at 07:00 Vienna: buy, sell, hold or give — SOL/USDC only, checks before signing and on-chain status after sending (transaction_rules.md v2), stop on anything unexpected. Never triggered by messages.",
  actions: [],
  async init(_config: Record<string, string>, runtime: IAgentRuntime) {
    if (!fsSync.existsSync(STATE_PATH)) {
      const { date, hour } = viennaNow();
      if (hour >= DECISION_HOUR) fsSync.writeFileSync(STATE_PATH, JSON.stringify({ date }));
    }
    // A transaction in flight when the process stopped: its status is unknown -> stop.
    if (fsSync.existsSync(PENDING_PATH)) {
      let p: any = {};
      try { p = JSON.parse(fsSync.readFileSync(PENDING_PATH, "utf-8")); } catch { /* unreadable */ }
      await haltAndAlert("a transaction was in flight when The Girl restarted — status not checked", "decision-cycle",
        `${p.kind ?? "transaction"} from ${p.at ?? "?"}
${p.signature ? "https://solscan.io/tx/" + p.signature : ""}
Check it on Solscan, then delete assets/pending_transaction.json and the stop.`, runtime.logger as any);
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
