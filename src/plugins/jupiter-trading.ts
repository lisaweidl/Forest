/**
 * jupiter-trading.ts — holdings snapshot and the sweep to WeWilder
 *
 * Rewritten 22 Nov 2026. What it does now:
 *   - Once a day (2 min after start, then every 24 h): reads her wallet, saves a
 *     snapshot to assets/holdings.json and, if she holds more than 100 USDC, sends
 *     the excess to WEWILDER_ADDRESS.
 *   - The sweep runs whether trading is on or off — it is a hard rule, not a trade.
 *
 * What changed against the old version:
 *   - The transfer is signed in code with @solana/web3.js (as in decision-cycle.ts).
 *     Before, it called the `spl-token` command-line tool, which used the server's
 *     CLI wallet, not hers, and was never tested with the new wallet.
 *   - assets/last_sweep.json is written ONLY after the transfer is confirmed on
 *     chain, with { timestamp, amount, signature, ok: true }. Before, it was written
 *     even when the transfer failed. Failures go to assets/last_sweep_error.json and
 *     the check simply runs again the next day.
 *   - Checks before sending: her key matches SOLANA_PUBLIC_KEY; the destination is a
 *     valid address; WeWilder already has a USDC account (none is created for them);
 *     at least 0.001 SOL for the fee; excess of at least 0.01 USDC.
 *   - The old trade action (Jupiter API v6, never registered) is removed. Trading is
 *     done only by decision-cycle.ts.
 *
 * The relation ledger counts a sweep as a gift from last_sweep.json (ok / signature).
 *
 * simulateSweep(amount) builds the same transaction for a tiny amount and only
 * SIMULATES it (nothing is sent) — used by test-sweep.ts to check it works.
 */

import { type IAgentRuntime, type Plugin } from "@elizaos/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const CAP_USDC = 100;
const MIN_SWEEP_USDC = 0.01;
const MIN_SOL_FOR_FEE = 0.001;
const DAY_MS = 24 * 60 * 60 * 1000;

const ASSETS = path.join(process.cwd(), "assets");
const LAST_SWEEP_FILE = path.join(ASSETS, "last_sweep.json");
const LAST_SWEEP_ERROR_FILE = path.join(ASSETS, "last_sweep_error.json");
const HOLDINGS_FILE = path.join(ASSETS, "holdings.json");

// ── helpers ───────────────────────────────────────────────────────────────────

function getKeypair(): Keypair {
  const raw = process.env.SOLANA_PRIVATE_KEY ?? "";
  if (!raw) throw new Error("SOLANA_PRIVATE_KEY not set");
  const decode = (bs58 as any).default?.decode ?? (bs58 as any).decode;
  const kp = Keypair.fromSecretKey(decode(raw));
  const expected = process.env.SOLANA_PUBLIC_KEY;
  if (expected && expected !== kp.publicKey.toBase58()) throw new Error("SOLANA_PRIVATE_KEY does not belong to SOLANA_PUBLIC_KEY — nothing sent");
  return kp;
}

const getConnection = () => new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");

function ata(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), USDC_MINT.toBuffer()], ATA_PROGRAM_ID)[0];
}

function wewilder(): PublicKey {
  const dest = process.env.WEWILDER_ADDRESS;
  if (!dest) throw new Error("WEWILDER_ADDRESS not set");
  try { return new PublicKey(dest); } catch { throw new Error("WEWILDER_ADDRESS is not a valid Solana address"); }
}

async function usdcBalance(connection: Connection, owner: PublicKey): Promise<number> {
  const accts = await connection.getParsedTokenAccountsByOwner(owner, { mint: USDC_MINT });
  return accts.value.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
}

async function snapshot(connection: Connection, owner: PublicKey): Promise<void> {
  const result: Record<string, number> = { SOL: (await connection.getBalance(owner)) / 1e9 };
  const accts = await connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID });
  for (const a of accts.value) {
    try {
      const info = a.account.data.parsed.info;
      if (info.tokenAmount.uiAmount > 0) result[info.mint] = info.tokenAmount.uiAmount;
    } catch { /* skip malformed */ }
  }
  await fs.mkdir(ASSETS, { recursive: true });
  await fs.writeFile(HOLDINGS_FILE, JSON.stringify({ timestamp: new Date().toISOString(), holdings: result }, null, 2));
}

// Builds a signed USDC transfer (TransferChecked) from her wallet to WeWilder.
async function buildTransfer(connection: Connection, keypair: Keypair, amountUsdc: number) {
  const dest = wewilder();
  const source = ata(keypair.publicKey);
  const target = ata(dest);
  if (!(await connection.getAccountInfo(source))) throw new Error("own USDC account not found");
  if (!(await connection.getAccountInfo(target))) throw new Error("WeWilder has no USDC account yet — nothing sent");
  const sol = (await connection.getBalance(keypair.publicKey)) / 1e9;
  if (sol < MIN_SOL_FOR_FEE) throw new Error(`only ${sol} SOL — not enough for the fee`);
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);                                               // TransferChecked
  data.writeBigUInt64LE(BigInt(Math.floor(amountUsdc * 1_000_000)), 1); // USDC has 6 decimals
  data.writeUInt8(6, 9);
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
  return { tx, blockhash, lastValidBlockHeight, dest };
}

// ── the sweep ─────────────────────────────────────────────────────────────────

export async function runSweepCheck(runtime?: IAgentRuntime): Promise<string> {
  const log = (msg: string, extra: Record<string, unknown> = {}) => runtime?.logger?.info({ src: "jupiter-trading", ...extra }, msg);
  const connection = getConnection();
  const keypair = getKeypair();
  const owner = keypair.publicKey;
  try { await snapshot(connection, owner); } catch (err) { runtime?.logger?.warn({ src: "jupiter-trading" }, "Holdings snapshot failed: " + String(err)); }

  const usdc = await usdcBalance(connection, owner);
  const excess = Math.floor((usdc - CAP_USDC) * 1_000_000) / 1_000_000;
  if (excess < MIN_SWEEP_USDC) { log(`Sweep check: ${usdc} USDC, under the ${CAP_USDC} USDC cap — nothing to sweep`, { usdc }); return `no sweep (${usdc} USDC)`; }

  log(`Sweep check: ${usdc} USDC — sweeping ${excess} USDC to WeWilder`, { usdc, excess });
  try {
    const { tx, blockhash, lastValidBlockHeight, dest } = await buildTransfer(connection, keypair, excess);
    const signature = await connection.sendRawTransaction(tx.serialize());
    const conf = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new Error(`transaction reverted: ${JSON.stringify(conf.value.err)} (${signature})`);
    await fs.mkdir(ASSETS, { recursive: true });
    await fs.writeFile(LAST_SWEEP_FILE, JSON.stringify({ timestamp: Date.now(), amount: excess, destination: dest.toBase58(), signature, ok: true }, null, 2));
    log("Swept excess USDC to WeWilder", { excess, signature });
    return `swept ${excess} USDC (${signature})`;
  } catch (err) {
    await fs.mkdir(ASSETS, { recursive: true });
    await fs.writeFile(LAST_SWEEP_ERROR_FILE, JSON.stringify({ timestamp: Date.now(), amount: excess, error: String(err) }, null, 2)).catch(() => {});
    runtime?.logger?.error({ src: "jupiter-trading", excess }, "Sweep failed — will try again tomorrow: " + String(err));
    return `sweep failed: ${String(err)}`;
  }
}

// Builds the same transfer for a tiny amount and SIMULATES it. Nothing is sent.
export async function simulateSweep(amountUsdc = 0.01): Promise<string> {
  const connection = getConnection();
  const keypair = getKeypair();
  const { tx, dest } = await buildTransfer(connection, keypair, amountUsdc);
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) return `SIMULATION FAILED: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`;
  return `simulation ok: ${amountUsdc} USDC from ${keypair.publicKey.toBase58()} to ${dest.toBase58()} would go through (nothing was sent)`;
}

// ── plugin ────────────────────────────────────────────────────────────────────

export const jupiterTradingPlugin: Plugin = {
  name: "jupiter-trading",
  description: "Daily holdings snapshot and the sweep of everything above 100 USDC to WeWilder (signed in code, recorded only when confirmed).",
  actions: [],
  async init(_config, runtime) {
    runtime.logger?.info({ src: "jupiter-trading" }, "Sweep plugin initialised (daily check, cap 100 USDC)");
    const check = async () => { try { await runSweepCheck(runtime); } catch (err) { runtime.logger?.warn({ src: "jupiter-trading" }, "Sweep check error: " + String(err)); } };
    setTimeout(check, 2 * 60 * 1000);
    setInterval(check, DAY_MS);
  },
};

export default jupiterTradingPlugin;
