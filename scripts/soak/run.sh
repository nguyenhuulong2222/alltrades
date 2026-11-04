#!/bin/bash
# Starts the 3-hour autopilot soak on testnet: worker, simulated client and monitor, each with
# nohup so they survive the terminal, plus caffeinate tied to the monitor so the Mac stays awake.
# Prerequisites: baseline taken (scripts/soak/baseline.mjs pre-soak) and autopilot unpaused.
set -euo pipefail
cd "$(dirname "$0")/../.."
D=backups/soak
mkdir -p "$D"
if [ -e "$D/TRIPPED" ] || [ -e agent/STOP ]; then echo "TRIPPED or agent/STOP exists; clear it first"; exit 1; fi
START_MS=$(node -e 'console.log(Date.now())')
WU=$(node -e "console.log(new Date($START_MS + 180*60000).toISOString())")
MU=$(node -e "console.log(new Date($START_MS + 185*60000).toISOString())")
printf '{"start_ms":%s,"worker_until":"%s","monitor_until":"%s"}\n' "$START_MS" "$WU" "$MU" > "$D/run.json"

WORKER_MAX_JOBS_PER_RUN=1 WORKER_MAX_COST_NEAR_PER_DAY=0.5 \
  nohup node --env-file=.env agent/worker.mjs --loop --interval 60 --until "$WU" >> "$D/worker.log" 2>&1 &
echo $! > "$D/worker.pid"
nohup node scripts/soak/client.mjs --start "$START_MS" --worker-until "$WU" >> "$D/client.out" 2>&1 &
echo $! > "$D/client.pid"
nohup node scripts/soak/monitor.mjs --until "$MU" --worker-until "$WU" >> "$D/monitor.out" 2>&1 &
MPID=$!
echo $MPID > "$D/monitor.pid"
nohup caffeinate -dims -w "$MPID" > /dev/null 2>&1 &
echo $! > "$D/caffeinate.pid"
cat "$D/run.json"
echo "worker $(cat $D/worker.pid) client $(cat $D/client.pid) monitor $MPID caffeinate $(cat $D/caffeinate.pid)"
