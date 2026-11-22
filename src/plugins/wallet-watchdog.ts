/**
 * wallet-watchdog.ts — warns Lisa-Marie privately when money leaves The Girl's
 * wallet in a way The Girl did not cause (22 Nov 2026).
 *
 * Every 5 minutes:
 *   1. New transactions: reads the wallet's latest transactions. Every transaction
 *      that SHE signed must be known — its signature has to be in the Decision Log
 *      (alambic/decision_log/*.json) or in assets/last_sweep.json. An unknown one
 *      means someone else used her key → alert, with what moved and a Solscan link.
 *      Transactions younger than 5 minutes wait one round, so the decision cycle has
 *      time to log its own trades first.
 *   2. Balance drop: if SOL or USDC fell by 20 % or more since the last check
 *      (at least 0.01 SOL / 1 USDC) and no known transaction happened in the last
 *      15 minutes → alert.
 *
 * It cannot stop a transfer — whoever has the key can send. It buys time.
 * No Claude calls; a few Solana RPC requests per round.
 *
 * .env:
 *   TELEGRAM_ALERT_CHAT_ID=<your own Telegram user id>  (private chat with the bot)
 *   TELEGRAM_BOT_TOKEN, SOLANA_PUBLIC_KEY, SOLANA_RPC_URL  (already there)
 * Without TELEGRAM_ALERT_CHAT_ID alerts only go to the log.
 *
 * State: assets/watchdog_state.json. First run = baseline, no alerts for the past.
 */

import { type IAgentRuntime, type Plugin } from "@elizaos/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const STATE_PATH = path.join(process.cwd(), "assets", "watchdog_state.json");
const DECISION_LOG_DIR = path.join(process.cwd(), "alambic", "decision_log");
const LAST_SWEEP_PATH = path.join(process.cwd(), "assets", "last_sweep.json");
const INTERVAL_MS = 5 * 60 * 1000;
const SETTLE_MS = 5 * 60 * 1000;
const KNOWN_WINDOW_MS = 15 * 60 * 1000;
const DROP_SHARE = 0.2;

interface State {
  lastSignature: string | null;
  last: { sol: number; usdc: number; at: number } | null;
  alerted: string[];
  announcedAt: number;
}

async function readState(): Promise<State> {
  try { return { lastSignature: null, last: null, alerted: [], announcedAt: 0, ...JSON.parse(await fs.readFile(STATE_PATH, "utf-8")) }; }
  catch { return { lastSignature: null, last: null, alerted: [], announcedAt: 0 }; }
}
async function writeState(s: State): Promise<void> {
  s.alerted = s.alerted.slice(-200);
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(s, null, 2));
}

// Signatures (and times) of everything The Girl did herself.
async function knownTransactions(): Promise<{ sigs: Set<string>; lastAt: number }> {
  const sigs = new Set<string>();
  let lastAt = 0;
  try {
    for (const f of (await fs.readdir(DECISION_LOG_DIR)).filter((n) => n.endsWith(".json"))) {
      try {
        const list = JSON.parse(await fs.readFile(path.join(DECISION_LOG_DIR, f), "utf-8"));
        if (!Array.isArray(list)) continue;
        for (const e of list) {
          if (typeof e?.signature === "string" && e.signature) {
            sigs.add(e.signature);
            const t = Date.parse(String(e.timestamp) + "Z");
            if (!isNaN(t)) lastAt = Math.max(lastAt, t);
          }
        }
      } catch { /* unreadable file */ }
    }
  } catch { /* no decision log yet */ }
  try {
    const s = JSON.parse(await fs.readFile(LAST_SWEEP_PATH, "utf-8"));
    if (s?.signature) { sigs.add(s.signature); lastAt = Math.max(lastAt, Number(s.timestamp) || 0); }
  } catch { /* no sweep yet */ }
  return { sigs, lastAt };
}

async function sendAlert(runtime: IAgentRuntime, text: string): Promise<void> {
  runtime.logger?.warn({ src: "wallet-watchdog" }, text);
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chat) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    if (!r.ok) runtime.logger?.error({ src: "wallet-watchdog", status: r.status, body: (await r.text()).slice(0, 200) }, "Watchdog alert could not be sent to Telegram");
  } catch (err) { runtime.logger?.error({ src: "wallet-watchdog", err: String(err) }, "Watchdog alert could not be sent to Telegram"); }
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);

// What a transaction moved for the owner: SOL change and per-token changes.
async function describe(connection: Connection, sig: string, owner: string) {
  const tx = await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) return null;
  const keys = tx.transaction.message.accountKeys;
  const idx = keys.findIndex((k) => k.pubkey.toBase58() === owner);
  const signed = idx >= 0 && !!keys[idx].signer;
  const solChange = idx >= 0 && tx.meta ? (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9 : 0;
  const tokens: Record<string, number> = {};
  for (const b of tx.meta?.preTokenBalances ?? []) if (b.owner === owner) tokens[b.mint] = (tokens[b.mint] ?? 0) - (b.uiTokenAmount.uiAmount ?? 0);
  for (const b of tx.meta?.postTokenBalances ?? []) if (b.owner === owner) tokens[b.mint] = (tokens[b.mint] ?? 0) + (b.uiTokenAmount.uiAmount ?? 0);
  // Who received: accounts other than hers whose SOL went up.
  const receivers = tx.meta ? keys.map((k, i) => ({ k: k.pubkey.toBase58(), d: tx.meta!.postBalances[i] - tx.meta!.preBalances[i] })).filter((x) => x.d > 0 && x.k !== owner).map((x) => x.k) : [];
  return { signed, solChange, tokens, receivers, blockTime: (tx.blockTime ?? 0) * 1000 };
}

async function balances(connection: Connection, owner: PublicKey): Promise<{ sol: number; usdc: number }> {
  const sol = (await connection.getBalance(owner)) / 1e9;
  const accts = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(USDC_MINT) });
  const usdc = accts.value.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
  return { sol, usdc };
}

export async function watchOnce(runtime: IAgentRuntime): Promise<void> {
  const ownerStr = process.env.SOLANA_PUBLIC_KEY;
  if (!ownerStr) { runtime.logger?.warn({ src: "wallet-watchdog" }, "SOLANA_PUBLIC_KEY not set — watchdog idle"); return; }
  const owner = new PublicKey(ownerStr);
  const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const state = await readState();
  const known = await knownTransactions();

  // 1. New transactions
  const sigs = await connection.getSignaturesForAddress(owner, { limit: 25 });
  if (state.lastSignature === null) {
    state.lastSignature = sigs[0]?.signature ?? "";       // baseline: the past is not checked
  } else {
    const fresh: typeof sigs = [];
    for (const s of sigs) { if (s.signature === state.lastSignature) break; fresh.push(s); }
    for (const s of fresh.reverse()) {                    // oldest first
      const at = (s.blockTime ?? 0) * 1000;
      if (at && Date.now() - at < SETTLE_MS) break;       // too young: next round
      state.lastSignature = s.signature;
      if (s.err || known.sigs.has(s.signature) || state.alerted.includes(s.signature)) continue;
      const d = await describe(connection, s.signature, ownerStr).catch(() => null);
      if (!d || !d.signed) continue;                      // not signed by her: an incoming transfer
      const moved = [
        d.solChange < 0 ? `${fmt(-d.solChange)} SOL out` : "",
        ...Object.entries(d.tokens as Record<string, number>).filter(([, v]) => v < 0).map(([m, v]) => `${fmt(-v)} ${m === USDC_MINT ? "USDC" : short(m)} out`),
      ].filter(Boolean).join(", ") || "no balance change (fees only)";
      state.alerted.push(s.signature);
      await sendAlert(runtime,
        `⚠️ The Girl — unknown transaction signed with her key\n${moved}\n` +
        (d.receivers.length ? `to: ${d.receivers.slice(0, 3).map(short).join(", ")}\n` : "") +
        `https://solscan.io/tx/${s.signature}\n\nNot in her Decision Log or sweep. If this wasn't you: stop the agent (pm2 stop the-girl), send no more top-ups, check the server.`);
    }
  }

  // 2. Balance drop
  const now = await balances(connection, owner);
  if (state.last) {
    const solDrop = state.last.sol - now.sol, usdcDrop = state.last.usdc - now.usdc;
    const big = (solDrop >= 0.01 && solDrop >= state.last.sol * DROP_SHARE) || (usdcDrop >= 1 && usdcDrop >= state.last.usdc * DROP_SHARE);
    if (big && Date.now() - known.lastAt > KNOWN_WINDOW_MS) {
      await sendAlert(runtime,
        `⚠️ The Girl — balance dropped since the last check\nSOL ${fmt(state.last.sol)} → ${fmt(now.sol)}\nUSDC ${fmt(state.last.usdc)} → ${fmt(now.usdc)}\n` +
        `No own decision or sweep in the last 15 minutes.\nhttps://solscan.io/account/${ownerStr}`);
    }
  }
  state.last = { ...now, at: Date.now() };
  await writeState(state);
}

export const walletWatchdogPlugin: Plugin = {
  name: "wallet-watchdog",
  description: "Every 5 minutes: alerts privately on Telegram when a transaction signed with The Girl's key is not her own, or her balance drops sharply.",
  async init(_config: Record<string, string>, runtime: IAgentRuntime) {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try { await watchOnce(runtime); } catch (err) { runtime.logger?.warn({ src: "wallet-watchdog", err: String(err) }, "Watchdog round failed"); }
      busy = false;
    };
    runtime.logger?.info({ src: "wallet-watchdog", alerts: process.env.TELEGRAM_ALERT_CHAT_ID ? "telegram" : "log only" }, "Wallet watchdog initialised (every 5 min)");
    // A short "I'm on" note to the private chat, at most once a day, so you know alerts arrive.
    setTimeout(async () => {
      const s = await readState();
      if (process.env.TELEGRAM_ALERT_CHAT_ID && Date.now() - s.announcedAt > 24 * 60 * 60 * 1000) {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        try {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: process.env.TELEGRAM_ALERT_CHAT_ID, text: `🛡️ wallet watchdog is on — watching ${short(process.env.SOLANA_PUBLIC_KEY ?? "?")} every 5 minutes.` }),
          });
          s.announcedAt = Date.now(); await writeState(s);
        } catch { /* next start */ }
      }
      await tick();
    }, 60 * 1000);
    setInterval(tick, INTERVAL_MS);
  },
};

export default walletWatchdogPlugin;
