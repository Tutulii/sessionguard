import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
const production = fs.readFileSync(path.join(root, "server/production-bitget.ts"), "utf8");
if (!/paperTrading:\s*true/.test(production) || /paperTrading:\s*false/.test(production)) throw new Error("Production Bitget adapter must remain Demo-only");
const files = ["server/agent-guard.ts", "server/production-trading.ts", "server/agent-grant.ts", "server/agent-orchestrator.ts", "server/production-worker.ts"];
for (const file of files) { const text = fs.readFileSync(path.join(root, file), "utf8"); if (/LIVE_AUTO|paperTrading:\s*false|executionMode:\s*["']LIVE["']/.test(text)) throw new Error("Forbidden live-money execution branch in " + file); }
process.stdout.write("Agent execution boundary scan passed: Demo-only, no LIVE_AUTO branch.\n");
