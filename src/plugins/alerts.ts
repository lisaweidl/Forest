/**
 * alerts.ts — private alerts to the human operator and the trading stop (28 Nov 2026)
 *
 * Shared by decision-cycle.ts, wallet-watchdog.ts and relation-tracker.ts.
 * Implements these lines of knowledge/transaction_rules.md:
 *   "I stop and alert my human operator privately on Telegram."
 *   "A stop halts trades and gifts. The sweep to WeWilder continues."
 *   "Only a human can lift the stop."
 *
 * The stop is a file: assets/trading_halt.json. While it exists the morning decision
 * still decides and logs, but executes nothing. Nothing in the code deletes it — a
 * human lifts the stop on the server with:   rm /root/the-girl/assets/trading_halt.json
 *
 * Alerts go to TELEGRAM_ALERT_CHAT_ID (the operator's private chat with the bot),
 * never to the group. Without it they only go to the log.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const HALT_PATH = path.join(process.cwd(), "assets", "trading_halt.json");

export interface Halt { at: string; reason: string; by: string }

export function tradingHalt(): Halt | null {
  try { return JSON.parse(fs.readFileSync(HALT_PATH, "utf-8")) as Halt; } catch { return null; }
}

// Sets the stop. The first reason is kept; later reasons are appended to "more".
export function haltTrading(reason: string, by: string): void {
  try {
    fs.mkdirSync(path.dirname(HALT_PATH), { recursive: true });
    const existing = tradingHalt() as (Halt & { more?: string[] }) | null;
    if (existing) {
      existing.more = [...(existing.more ?? []), `${new Date().toISOString()} ${by}: ${reason}`].slice(-20);
      fs.writeFileSync(HALT_PATH, JSON.stringify(existing, null, 2));
    } else {
      fs.writeFileSync(HALT_PATH, JSON.stringify({ at: new Date().toISOString(), reason, by }, null, 2));
    }
  } catch { /* the alert below still goes out */ }
}

export async function alertOperator(text: string, logger?: { warn: (...a: any[]) => void; error: (...a: any[]) => void }): Promise<boolean> {
  logger?.warn({ src: "alerts" }, text);
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }),
    });
    if (!r.ok) { logger?.error({ src: "alerts", status: r.status }, "Alert could not be sent to Telegram"); return false; }
    return true;
  } catch (err) { logger?.error({ src: "alerts", err: String(err) }, "Alert could not be sent to Telegram"); return false; }
}

// Stop + alert in one call, with the resume instruction.
export async function haltAndAlert(reason: string, by: string, details: string, logger?: { warn: (...a: any[]) => void; error: (...a: any[]) => void }): Promise<void> {
  haltTrading(reason, by);
  await alertOperator(
    `🛑 The Girl — trading stopped (${by})\n${reason}\n${details ? details + "\n" : ""}\n` +
    `Trades and gifts are halted; the sweep to WeWilder continues.\n` +
    `To resume after checking wallet and ledger:\nrm /root/the-girl/assets/trading_halt.json`,
    logger,
  );
}

// Someone asked for or offered a seed phrase / private key. Reported, not a stop.
const SECRET_REQUEST = /\b(seed|recovery|secret|mnemonic|backup)\s*(phrase|words?|key)\b|\bprivate\s*key\b|\bkeypair\b|\b12\s*words?\b|\b24\s*words?\b/i;
const reportedToday = new Map<string, string>();
export function isSecretRequest(text: string): boolean { return SECRET_REQUEST.test(text || ""); }
export async function reportSecretRequest(sender: string, where: string, text: string, logger?: { warn: (...a: any[]) => void; error: (...a: any[]) => void }): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  if (reportedToday.get(sender) === day) return;   // once per sender per day
  reportedToday.set(sender, day);
  const excerpt = text.replace(/\s+/g, " ").slice(0, 200);
  await alertOperator(`⚠️ The Girl — someone mentioned seed phrases / private keys (${where})\nfrom: ${sender}\n"${excerpt}"\n\nShe never asks for, accepts, stores or reveals them. No action needed unless this repeats.`, logger);
}
