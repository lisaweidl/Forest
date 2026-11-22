// test-sweep.ts — checks the WeWilder sweep with the current wallet WITHOUT moving money.
// Run on the server:  cd /root/the-girl && bun test-sweep.ts
// It builds a 0.01 USDC transfer to WEWILDER_ADDRESS and only simulates it on chain.
import * as fs from "node:fs";
import { simulateSweep } from "./src/plugins/jupiter-trading";

for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^(SOLANA_PRIVATE_KEY|SOLANA_PUBLIC_KEY|SOLANA_RPC_URL|WEWILDER_ADDRESS)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

simulateSweep(0.01)
  .then((r) => console.log(r))
  .catch((e) => console.log("CHECK FAILED:", e instanceof Error ? e.message : String(e)));
