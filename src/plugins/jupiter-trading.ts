/**
 * jupiter-trading.ts
 *
 * Jupiter DEX trading plugin for The Girl Protocol.
 * - Executes swaps via Jupiter API v6
 * - Updates price ledger after each trade
 * - Weekly: checks holdings, converts excess to USDC, sweeps to WeWilder
 */

import {
  type IAgentRuntime,
  type Memory,
  type Plugin,
} from "@elizaos/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

// ── Constants ────────────────────────────────────────────────────────────────

const JUPITER_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_URL  = "https://quote-api.jup.ag/v6/swap";
const USDC_MINT  = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT   = "So11111111111111111111111111111111111111112";
const CAP_USDC   = 100;
const LAST_SWEEP_FILE = path.join(process.cwd(), "assets", "last_sweep.json");
const HOLDINGS_FILE   = path.join(process.cwd(), "assets", "holdings.json");

// ── Helpers ───────────────────────────────────────────────────────────────────

function getKeypair(): Keypair {
  const raw = process.env.SOLANA_PRIVATE_KEY ?? "";
  if (!raw) throw new Error("SOLANA_PRIVATE_KEY not set");
  const decode = (bs58 as any).default?.decode ?? (bs58 as any).decode;
  const bytes = decode(raw);
  return Keypair.fromSecretKey(bytes);
}

function getConnection(): Connection {
  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  return new Connection(rpc, "confirmed");
}

async function getUsdcBalance(connection: Connection, wallet: PublicKey): Promise<number> {
  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet, {
      mint: new PublicKey(USDC_MINT),
    });
    if (!accounts.value.length) return 0;
    return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0;
  } catch (err) {
    console.warn("[JUPITER-TRADING] getUsdcBalance failed:", err);
    return 0;
  }
}

async function getSolBalance(connection: Connection, wallet: PublicKey): Promise<number> {
  const lamports = await connection.getBalance(wallet);
  return lamports / 1e9;
}

async function getAllTokenBalances(connection: Connection, wallet: PublicKey): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
    for (const acc of accounts.value) {
      try {
        const info = acc.account.data.parsed.info;
        const mint = info.mint as string;
        const amount = info.tokenAmount.uiAmount as number;
        if (amount > 0) result[mint] = amount;
      } catch { /* skip malformed account */ }
    }
  } catch (err) {
    console.warn("[JUPITER-TRADING] getParsedTokenAccountsByOwner failed:", err);
  }
  result["SOL"] = await getSolBalance(connection, wallet);
  return result;
}

async function jupiterSwap(
  connection: Connection,
  keypair: Keypair,
  inputMint: string,
  outputMint: string,
  amountLamports: number
): Promise<string> {
  // Get quote
  const quoteResp = await fetch(
    `${JUPITER_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=50`
  );
  if (!quoteResp.ok) throw new Error(`Quote failed: ${await quoteResp.text()}`);
  const quote = await quoteResp.json();

  // Get swap transaction
  const swapResp = await fetch(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toString(),
      wrapAndUnwrapSol: true,
    }),
  });
  if (!swapResp.ok) throw new Error(`Swap failed: ${await swapResp.text()}`);
  const { swapTransaction } = await swapResp.json() as { swapTransaction: string };

  // Sign and send
  const txBuf = Buffer.from(swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

async function updatePriceLedger(entry: {
  week: number;
  description: string;
  amount_in: number;
  amount_out: number;
  token: string;
  signature: string;
}): Promise<void> {
  const ledgerPath = path.join(process.cwd(), "knowledge", "facts", "ledger_price.md");
  const line = `| ${entry.week} | ${entry.description} | ${entry.token} | +${entry.amount_in} / -${entry.amount_out} | ${entry.signature.slice(0,8)}... |\n`;
  try {
    let content = await fs.readFile(ledgerPath, "utf-8");
    content = content.replace("| — | — | — | — | — |", line + "| — | — | — | — | — |");
    await fs.writeFile(ledgerPath, content, "utf-8");
  } catch {
    // ignore if ledger not ready
  }
}

// ── Weekly Sweep ──────────────────────────────────────────────────────────────

async function weeklyHoldingsCheck(runtime: IAgentRuntime): Promise<void> {
  const weiWilderAddress = process.env.WEWILDER_ADDRESS;
  if (!weiWilderAddress) {
    runtime.logger?.warn({ src: "jupiter-trading" }, "WEWILDER_ADDRESS not set, skipping sweep");
    return;
  }

  const keypair = getKeypair();
  const connection = getConnection();

  runtime.logger?.info({ src: "jupiter-trading" }, "Weekly holdings check starting");

  const usdcBalance = await getUsdcBalance(connection, keypair.publicKey);
  runtime.logger?.info({ src: "jupiter-trading", usdcBalance }, "Current USDC balance");

  // Save holdings snapshot
  const holdings = await getAllTokenBalances(connection, keypair.publicKey);
  await fs.mkdir(path.dirname(HOLDINGS_FILE), { recursive: true });
  await fs.writeFile(HOLDINGS_FILE, JSON.stringify({ timestamp: new Date().toISOString(), holdings }, null, 2));

  if (usdcBalance <= CAP_USDC) {
    runtime.logger?.info({ src: "jupiter-trading" }, `Balance ${usdcBalance} USDC under cap, no sweep needed`);
    return;
  }

  const excess = usdcBalance - CAP_USDC;
  runtime.logger?.info({ src: "jupiter-trading", excess }, "Excess USDC to sweep to WeWilder");

  // Send excess USDC to WeWilder
  // USDC has 6 decimals
  const excessLamports = Math.floor(excess * 1_000_000);

  try {
    const { execSync } = await import("child_process");
    // Use spl-token transfer for USDC
    execSync(
      `spl-token transfer ${USDC_MINT} ${excess} ${weiWilderAddress} --from ${keypair.publicKey.toString()} --allow-unfunded-recipient --fund-recipient`,
      { stdio: "pipe" }
    );
    runtime.logger?.info({ src: "jupiter-trading", excess, weiWilderAddress }, "Swept excess USDC to WeWilder");
  } catch (err) {
    runtime.logger?.warn({ src: "jupiter-trading" }, "Sweep failed: " + String(err));
  }

  await fs.writeFile(LAST_SWEEP_FILE, JSON.stringify({ timestamp: Date.now(), amount: excess }));
}

// ── Trade Action ──────────────────────────────────────────────────────────────

const tradeAction = {
  name: "EXECUTE_TRADE",
  description: "Execute a token swap via Jupiter DEX",
  similes: ["SWAP", "TRADE", "BUY", "SELL"],
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content?.text ?? "";
    return /swap|trade|buy|sell/i.test(text);
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content?.text ?? "";
    runtime.logger?.info({ src: "jupiter-trading", text }, "Trade action triggered");

    try {
      const keypair = getKeypair();
      const connection = getConnection();

      // Simple parser: "swap 10 USDC for SOL"
      const match = text.match(/swap\s+([\d.]+)\s+(\w+)\s+for\s+(\w+)/i);
      if (!match) {
        runtime.logger?.warn({ src: "jupiter-trading" }, "Could not parse trade instruction");
        return false;
      }

      const [, amountStr, fromToken, toToken] = match;
      const amount = parseFloat(amountStr);

      const mintMap: Record<string, string> = {
        USDC: USDC_MINT,
        SOL: SOL_MINT,
      };

      const inputMint = mintMap[fromToken.toUpperCase()] ?? fromToken;
      const outputMint = mintMap[toToken.toUpperCase()] ?? toToken;
      const decimals = fromToken.toUpperCase() === "SOL" ? 1e9 : 1e6;
      const amountRaw = Math.floor(amount * decimals);

      const sig = await jupiterSwap(connection, keypair, inputMint, outputMint, amountRaw);
      runtime.logger?.info({ src: "jupiter-trading", sig }, "Trade executed");

      await updatePriceLedger({
        week: 1,
        description: `swap ${amount} ${fromToken} → ${toToken}`,
        amount_in: amount,
        amount_out: 0,
        token: fromToken,
        signature: sig,
      });

      return true;
    } catch (err) {
      runtime.logger?.error({ src: "jupiter-trading" }, "Trade error: " + String(err));
      return false;
    }
  },
  examples: [],
};

// ── Plugin ────────────────────────────────────────────────────────────────────

export const jupiterTradingPlugin: Plugin = {
  name: "jupiter-trading",
  description: "Jupiter DEX trading — swaps, holdings check, weekly WeWilder sweep",
  actions: [tradeAction],
  async init(_config, runtime) {
    runtime.logger?.info({ src: "jupiter-trading" }, "Jupiter trading plugin initialised");

    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const msPerDay  = 24 * 60 * 60 * 1000;

    async function checkWeeklySweep() {
      try {
        let lastSweep = 0;
        try {
          const raw = await fs.readFile(LAST_SWEEP_FILE, "utf-8");
          lastSweep = JSON.parse(raw).timestamp ?? 0;
        } catch { /* first run */ }

        if (Date.now() - lastSweep >= msPerWeek) {
          await weeklyHoldingsCheck(runtime);
        }
      } catch (err) {
        runtime.logger?.warn({ src: "jupiter-trading" }, "Weekly check error: " + String(err));
      }
    }

    // Check after 2 min startup delay, then every 24h
    setTimeout(() => checkWeeklySweep(), 2 * 60 * 1000);
    setInterval(() => checkWeeklySweep(), msPerDay);
  },
};

export default jupiterTradingPlugin;
