const coreProductionVariables = [
  "APP_ORIGIN",
  "DATABASE_URL",
  "REDIS_URL",
  "DECISION_SIGNING_KEY",
  "ADMIN_TOKEN",
  "METRICS_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
] as const;

const managedProductionVariables = [
  "KMS_KEY_ID",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_NAME",
  "VAPID_SUBJECT",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "SENTRY_DSN",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
] as const;

export function isHackathonDeploymentProfile() {
  return process.env.SESSIONGUARD_DEPLOYMENT_PROFILE === "HACKATHON";
}

export function validateProductionEnvironment(production: boolean, allowLocal: boolean) {
  if (!production || allowLocal) return;
  const profile = process.env.SESSIONGUARD_DEPLOYMENT_PROFILE;
  if (profile && profile !== "HACKATHON") throw new Error("SESSIONGUARD_DEPLOYMENT_PROFILE is invalid");
  const required = isHackathonDeploymentProfile()
    ? [...coreProductionVariables, "LOCAL_KMS_MASTER_KEY"] : [...coreProductionVariables, ...managedProductionVariables];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing required production configuration: ${missing.join(", ")}`);

  const origin = new URL(process.env.APP_ORIGIN!);
  if (origin.protocol !== "https:") throw new Error("APP_ORIGIN must use HTTPS in production");
  if (origin.href !== `${origin.origin}/`) throw new Error("APP_ORIGIN must not include a path, query, or fragment");
  const database = new URL(process.env.DATABASE_URL!);
  if (!["postgres:", "postgresql:"].includes(database.protocol)) throw new Error("DATABASE_URL must use PostgreSQL");
  const redis = new URL(process.env.REDIS_URL!);
  if (!["redis:", "rediss:"].includes(redis.protocol)) throw new Error("REDIS_URL must use Redis");
  const secretNames = ["DECISION_SIGNING_KEY", "ADMIN_TOKEN", "METRICS_TOKEN", "TELEGRAM_WEBHOOK_SECRET"] as const;
  for (const name of secretNames) {
    if (process.env[name]!.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  }
  if (new Set(secretNames.map((name) => process.env[name])).size !== secretNames.length) {
    throw new Error("Production signing, admin, metrics, and webhook secrets must be independent");
  }
  if (process.env.VAPID_SUBJECT
    && !process.env.VAPID_SUBJECT.startsWith("mailto:") && !process.env.VAPID_SUBJECT.startsWith("https://")) {
      throw new Error("VAPID_SUBJECT must be a mailto: or HTTPS URI");
  }
  if (process.env.AGENT_RUNTIME_ENABLED === "1") {
    const agentMissing = ["QWEN_API_KEY", "QWEN_BASE_URL", "QWEN_MODEL", "QWEN_PROMPT_VERSION", "SEC_USER_AGENT"]
      .filter((name) => !process.env[name]?.trim());
    if (agentMissing.length) throw new Error(`Missing agent production configuration: ${agentMissing.join(", ")}`);
    if (!process.env.SEC_USER_AGENT!.includes("@")) throw new Error("SEC_USER_AGENT must include a descriptive contact address");
    if (new URL(process.env.QWEN_BASE_URL!).protocol !== "https:") throw new Error("QWEN_BASE_URL must use HTTPS in production");
  }
  for (const name of ["SENTRY_DSN", "OTEL_EXPORTER_OTLP_ENDPOINT"] as const) {
    const value = process.env[name];
    if (!value) continue;
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:") throw new Error(`${name} must use HTTPS in production`);
  }
}
