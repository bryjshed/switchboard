#!/usr/bin/env bash
# Mint a real Firebase Auth emulator ID token for <email> (creates the account if new).
# Usage: scripts/token.sh alice@switchboard.dev [password]
set -euo pipefail
EMAIL="${1:?usage: token.sh <email> [password]}"
PASSWORD="${2:-password123}"
BASE="http://localhost:29099/identitytoolkit.googleapis.com/v1"
KEY="fake-api-key"
SIGNUP=$(curl -s "$BASE/accounts:signUp?key=$KEY" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"returnSecureToken\":true}")
TOKEN=$(echo "$SIGNUP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.idToken||'')})")
if [ -z "$TOKEN" ]; then
  SIGNIN=$(curl -s "$BASE/accounts:signInWithPassword?key=$KEY" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"returnSecureToken\":true}")
  TOKEN=$(echo "$SIGNIN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.idToken||'')})")
fi
if [ -z "$TOKEN" ]; then echo "Failed to obtain token for $EMAIL" >&2; exit 1; fi
echo "$TOKEN"
