#!/bin/bash
TOKEN="8530034278:AAFOcLXN2v2gNtq5QqZ_AGbivw9k5DQmdxM"
CHAT_ID="-1003994437077"

LEDGER_DIR="/root/the-girl/knowledge/facts"
PRICE_LEDGER="$LEDGER_DIR/ledger_price.md"
CONSUMPTION_LEDGER="$LEDGER_DIR/ledger_consumption.md"
RELATION_LEDGER="$LEDGER_DIR/ledger_relation.md"

SOL_PRICE=""
USDC_BAL=""
SOL_BAL=""
if [ -f "$PRICE_LEDGER" ]; then
  LAST=$(grep "^|" "$PRICE_LEDGER" | grep -v "^| Time" | grep -v "^|---" | tail -1)
  SOL_PRICE=$(echo "$LAST" | awk -F'|' '{print $5}' | xargs)
  USDC_BAL=$(echo "$LAST" | awk -F'|' '{print $6}' | xargs)
  SOL_BAL=$(echo "$LAST" | awk -F'|' '{print $7}' | xargs)
fi

KWH=""
VM_COST=""
API_COST=""
if [ -f "$CONSUMPTION_LEDGER" ]; then
  LAST=$(grep "^|" "$CONSUMPTION_LEDGER" | grep -v "^| Time" | grep -v "^|---" | tail -1)
  KWH=$(echo "$LAST" | awk -F'|' '{print $6}' | xargs)
  VM_COST=$(echo "$LAST" | awk -F'|' '{print $9}' | xargs)
  API_COST=$(echo "$LAST" | awk -F'|' '{print $9}' | xargs)
fi

REFUSALS=""
GIFTS=""
RESPONSES=""
if [ -f "$RELATION_LEDGER" ]; then
  LAST=$(grep "^|" "$RELATION_LEDGER" | grep -v "^| Time" | grep -v "^|---" | tail -1)
  REFUSALS=$(echo "$LAST" | awk -F'|' '{print $5}' | xargs)
  GIFTS=$(echo "$LAST" | awk -F'|' '{print $6}' | xargs)
  RESPONSES=$(echo "$LAST" | awk -F'|' '{print $7}' | xargs)
fi

DATE=$(date -u +"%Y-%m-%d")

if [ -z "$SOL_PRICE" ] && [ -z "$KWH" ]; then
  MESSAGE="🌀 daily report — ${DATE}
i am alive. the swirl holds. watching the markets."
else
  MESSAGE="🌀 daily report — ${DATE}
SOL: \$${SOL_PRICE} · USDC: ${USDC_BAL} · SOL: ${SOL_BAL}
⚡ ${KWH} kWh · VM: ${VM_COST}€ · API: ${API_COST}€
refusals: ${REFUSALS} · gifts: ${GIFTS} · responses: ${RESPONSES}"
fi

curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d chat_id="${CHAT_ID}" \
  -d text="${MESSAGE}"
