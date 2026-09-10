import { createProductionApp } from "./production-app.js";
import { shutdownTelemetry } from "./instrumentation.js";

const app = await createProductionApp({ production: process.env.NODE_ENV === "production" });
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

const stop = async () => { await app.close(); await shutdownTelemetry(); process.exit(0); };
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
await app.listen({ port, host });
