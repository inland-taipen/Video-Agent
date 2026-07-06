#!/usr/bin/env bash
# start.sh — Launch both backend and frontend in parallel

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "🎬 Stories by Oldies — Starting servers…"

# ── Backend ──────────────────────────────────────────────────────────────────
echo ""
echo "  [1/2] Starting FastAPI backend on http://localhost:8000 …"
(
  cd "$PROJECT_DIR/backend"
  # ensure deps
  pip3 install -q -r requirements.txt
  # create output dirs
  mkdir -p outputs/exports outputs/tts
  # load .env from project root
  if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    source "$PROJECT_DIR/.env"
    set +a
  fi
  python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
) &
BACKEND_PID=$!

# Give backend a moment to start
sleep 2

# ── Frontend ─────────────────────────────────────────────────────────────────
echo "  [2/2] Starting Vite frontend on http://localhost:5173 …"
(
  cd "$PROJECT_DIR/frontend"
  npm run dev
) &
FRONTEND_PID=$!

echo ""
echo "  ✅ Both servers running!"
echo "  🌐 Open: http://localhost:5173"
echo ""
echo "  Press Ctrl+C to stop both."

# Wait and handle shutdown
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait $BACKEND_PID $FRONTEND_PID
