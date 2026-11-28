// test-trade-check.ts — checks a real Jupiter order against the transaction rules
// WITHOUT signing or sending anything.
// Run on the server:  cd /root/the-girl && bun test-trade-check.ts [USDC|SOL] [amount in USD]
//   default: bun test-trade-check.ts USDC 1   (1 USD of USDC -> SOL)
// Shows which programs the transaction calls, the network fee and whether the
// simulation matches her intention. A program that is not approved shows up as
// "unapproved program …" — add it to TRADING_EXTRA_PROGRAMS only after checking it.
import * as fs from "node:fs";

for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^(SOLANA_PRIVATE_KEY|SOLANA_PUBLIC_KEY|SOLANA_RPC_URL|JUPITER_API_KEY|TRADING_EXTRA_PROGRAMS)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const side = (process.argv[2] ?? "USDC").toUpperCase() === "SOL" ? "SOL" : "USDC";
const amount = Number(process.argv[3] ?? 1) || 1;
const { checkTradeOnly } = await import("./src/plugins/decision-cycle");   // after .env is loaded
checkTradeOnly(side, amount)
  .then((r) => console.log(r))
  .catch((e) => console.log("CHECK FAILED:", e instanceof Error ? e.message : String(e)));
