#!/bin/bash
# update-ledgers.sh — writes price ledger every hour via cron

LEDGER_DIR="/root/the-girl/knowledge/facts"
PRICE_LEDGER="$LEDGER_DIR/ledger_price.md"

# get SOL price
SOL_PRICE=$(curl -s "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd" | grep -o '"usd":[0-9.]*' | cut -d: -f2)
[ -z "$SOL_PRICE" ] && SOL_PRICE="0"

# get balances via RPC
WALLET="CpCFbUYxzLDa6REgPaMK9DZAwXDjnoZkMrprosygARV9"
RPC="https://api.mainnet-beta.solana.com"

SOL_RAW=$(curl -s -X POST "$RPC" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"$WALLET\"]}" \
  | grep -o '"value":[0-9]*' | head -1 | cut -d: -f2)
SOL_BAL=$(echo "scale=4; ${SOL_RAW:-0} / 1000000000" | bc)

USDC_MINT="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDC_RAW=$(curl -s -X POST "$RPC" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getTokenAccountsByOwner\",\"params\":[\"$WALLET\",{\"mint\":\"$USDC_MINT\"},{\"encoding\":\"jsonParsed\"}]}" \
  | grep -o '"uiAmount":[0-9.]*' | head -1 | cut -d: -f2)
USDC_BAL="${USDC_RAW:-0}"

# uptime
START_FILE="/root/the-girl/.start_time"
if [ ! -f "$START_FILE" ]; then
  date +%s > "$START_FILE"
fi
START_TS=$(cat "$START_FILE")
NOW_TS=$(date +%s)
UPTIME_H=$(echo "scale=2; ($NOW_TS - $START_TS) / 3600" | bc)
WEEK=$(echo "scale=0; (($NOW_TS - $START_TS) / 604800) + 1" | bc)

TIME=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

# write header if file doesn't exist
if [ ! -f "$PRICE_LEDGER" ]; then
  mkdir -p "$LEDGER_DIR"
  cat > "$PRICE_LEDGER" << 'EOF'
# Price Ledger

*This ledger is a standing account. It does not flatter or condemn. It records.*

| Time (UTC) | Week | Uptime (h) | SOL price (USD) | USDC balance | SOL balance | Note |
|---|---|---|---|---|---|---|
EOF
fi

echo "| $TIME | $WEEK | $UPTIME_H | $SOL_PRICE | $USDC_BAL | $SOL_BAL |  |" >> "$PRICE_LEDGER"
