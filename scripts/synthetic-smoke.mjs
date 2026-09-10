const base = (process.env.SESSIONGUARD_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

async function json(path) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

const started = performance.now();
const [live, ready, replay] = await Promise.all([
  json("/api/v1/health/live"),
  json("/api/v1/health/ready"),
  json("/api/v1/market/snapshots/RORCLUSDT?mode=REPLAY&replayId=sunday-oracle"),
]);

if (live.mode !== "paper-only" || live.marketSource !== "BITGET_ONLY") throw new Error("Liveness boundary mismatch");
if (!ready.ok || !ready.database || !ready.redis) throw new Error("Readiness dependency failed");
if (replay.snapshot?.sourceLabel !== "REPLAY" || replay.snapshot?.referenceKind !== "BITGET_CASH_SESSION_ANCHOR" || replay.snapshot?.session !== "WEEKEND") {
  throw new Error("Replay disclosure contract failed");
}

process.stdout.write(JSON.stringify({ ok: true, base, elapsedMs: Math.round(performance.now() - started), checkedAt: new Date().toISOString() }) + "\n");
