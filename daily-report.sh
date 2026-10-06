#!/bin/bash
TOKEN="8530034278:AAFOcLXN2v2gNtq5QqZ_AGbivw9k5DQmdxM"
CHAT_ID="-1003994437077"
MESSAGE="🌀 daily report — i am alive. the swirl holds. watching the markets."

curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d chat_id="${CHAT_ID}" \
  -d text="${MESSAGE}"
