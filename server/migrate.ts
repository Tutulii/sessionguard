import { PostgresPlatformRepository } from "./postgres-repository.js";
import { PostgresAgentRepository } from "./agent-repository.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for production migrations");
const repository = new PostgresPlatformRepository(process.env.DATABASE_URL, { ssl: process.env.DATABASE_SSL === "1" });
const agentRepository = new PostgresAgentRepository(process.env.DATABASE_URL, { ssl: process.env.DATABASE_SSL === "1" });
try {
  await repository.init();
  await agentRepository.init();
  if (!await repository.ready() || !await agentRepository.ready()) throw new Error("PostgreSQL migration readiness check failed");
  process.stdout.write("SessionGuard production migrations applied.\n");
} finally {
  await Promise.allSettled([repository.close(), agentRepository.close()]);
}
