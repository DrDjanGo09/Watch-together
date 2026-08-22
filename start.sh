#!/usr/bin/env bash
# One-shot setup + run for Watch Together: installs dependencies, builds the
# app, starts the server, and opens a public Cloudflare Tunnel link.
#
# Usage:
#   ./start.sh
#
# Stop everything with Ctrl+C (this also stops the background server).

set -euo pipefail
cd "$(dirname "$0")"

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo ""
    echo "==> Stopping server..."
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "==> Checking for Node.js..."
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it from https://nodejs.org (LTS version) and re-run this script."
  exit 1
fi
echo "    Found: $(node --version)"

echo "==> Installing client dependencies..."
(cd client && npm install --no-fund --no-audit)

echo "==> Building client for production..."
rm -f client/.env
(cd client && npm run build)

echo "==> Installing server dependencies..."
(cd server && npm install --no-fund --no-audit)

echo "==> Starting server on http://localhost:4000 ..."
(cd server && npm start) > server.log 2>&1 &
SERVER_PID=$!

# Wait for the server to actually be up before starting the tunnel.
for i in $(seq 1 20); do
  if curl -s -o /dev/null "http://localhost:4000/"; then
    break
  fi
  sleep 0.5
done
if ! curl -s -o /dev/null "http://localhost:4000/"; then
  echo "Server did not start correctly. Check server.log for details."
  exit 1
fi
echo "    Server is up."

echo "==> Checking for cloudflared..."
CLOUDFLARED_CMD=""
if command -v cloudflared >/dev/null 2>&1; then
  CLOUDFLARED_CMD="cloudflared"
elif [ -x "./cloudflared" ]; then
  CLOUDFLARED_CMD="./cloudflared"
else
  echo "    Downloading cloudflared..."
  OS="$(uname -s)"
  ARCH="$(uname -m)"
  if [ "$OS" = "Darwin" ]; then
    curl -sL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz" -o cloudflared.tgz
    tar -xzf cloudflared.tgz
    rm -f cloudflared.tgz
  else
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
      URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
    else
      URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
    fi
    curl -sL "$URL" -o cloudflared
  fi
  chmod +x cloudflared
  CLOUDFLARED_CMD="./cloudflared"
fi

echo ""
echo "==> Starting Cloudflare Tunnel — your public link will appear below."
echo "    Send the https://....trycloudflare.com link to your relatives."
echo "    Press Ctrl+C here to stop everything (tunnel + server) when you're done."
echo ""
"$CLOUDFLARED_CMD" tunnel --url http://localhost:4000
