import { createHash, randomUUID } from "node:crypto";
import { AgentSettingsV1Schema, agentPolicy, type AgentAssessmentV1, type AgentContextV1, type AgentSettingsV1, type OfficialEventV1 } from "../shared/agent-types.js";
import type { AgentRepository } from "./agent-repository.js";
import { evaluateAgentGuard } from "./agent-guard.js";
import { agentEligibility, agentGrantHash } from "./agent-grant.js";
import type {
  GuardDecision,
  GuardEvaluationInput,
  PaperOrderReceiptV1,
  PortfolioSnapshot,
  ProductionSymbol,
  UserPolicy,
} from "../shared/production-types.js";
import { defaultUserPolicy, platformPolicy, UserPolicySchema } from "../shared/production-types.js";
import type { Coordinator } from "./coordinator.js";
import { PersistentCredentialVault } from "./envelope-vault.js";
import type { PlatformRepository } from "./platform-repository.js";
import type { DemoTradingAdapter, PortfolioPrices } from "./production-bitget.js";
import { replayPortfolio } from "./production-bitget.js";
import { ProductionMarketService } from "./production-market.js";
import { evaluateProductionGuard, productionHash } from "./production-rules.js";
import { ProductionDecisionTokenService, walletSessionHash } from "./production-token.js";
import type { NotificationService } from "./notifications.js";

function startOfUtcDay(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function isPending(receipt: PaperOrderReceiptV1) {
  return ["RESERVED", "SUBMITTING", "RECONCILING"].includes(receipt.status);
}

export class ProductionTradingService {
  constructor(
    private readonly repository: PlatformRepository,
    private readonly coordinator: Coordinator,
    private readonly market: ProductionMarketService,
    private readonly credentialVault: PersistentCredentialVault,
    private readonly bitget: DemoTradingAdapter,
    private readonly tokens: ProductionDecisionTokenService,
    private readonly notifications: NotificationService,
    private readonly onDuplicateOrder?: () => void,
    private readonly agentRepository?: AgentRepository,
  ) {}

  async connectionStatus(userId: string) {
    const record = await this.repository.getConnection(userId);
    return { connected: Boolean(record), executionEnabled: Boolean(record?.executionEnabled), mode: "paper-only" as const,
      lastValidatedAt: record?.lastValidatedAt ?? null };
  }

  async connect(userId: string, credentials: { apiKey: string; secretKey: string; passphrase: string }) {
    const validation = await this.bitget.validate(credentials);
    await this.credentialVault.save(userId, credentials, validation.executionEnabled);
    if (!validation.executionEnabled) await this.disableAgentExecution(userId, "CREDENTIAL_INVALIDATED");
    await this.repository.saveAudit(userId, "BITGET_DEMO_CONNECTED", userId, { executionEnabled: validation.executionEnabled });
    if (!validation.executionEnabled) {
      await this.notifications.emit(userId, { kind: "CREDENTIAL", severity: "WARNING", title: "Demo connection limited",
        body: "Credentials are valid, but all three supported Reality instruments were not available." }, `credential-limited:${Date.now()}`);
    }
    return this.connectionStatus(userId);
  }

  async disconnect(userId: string) {
    await this.credentialVault.destroy(userId);
    await this.disableAgentExecution(userId, "DEMO_DISCONNECTED");
    await this.repository.saveAudit(userId, "BITGET_DEMO_DISCONNECTED", userId, {});
    return this.connectionStatus(userId);
  }

  async getPolicy(userId: string) {
    return await this.repository.getPolicy(userId) ?? { policy: defaultUserPolicy, version: "default" };
  }

  async updatePolicy(userId: string, input: UserPolicy) {
    const policy = UserPolicySchema.parse(input);
    const version = productionHash({ policy, updatedAt: new Date().toISOString() }).slice(0, 16);
    await this.repository.savePolicy(userId, policy, version);
    await this.disableAgentExecution(userId, "USER_POLICY_CHANGED");
    await this.repository.saveAudit(userId, "POLICY_UPDATED", version, { policy });
    return { policy, version };
  }

  async portfolio(userId: string, mode: "LIVE_BITGET" | "REPLAY", replayId?: string, now = new Date(), fresh = false) {
    if (mode === "REPLAY") {
      const portfolio = replayPortfolio(userId, now);
      await this.repository.savePortfolio(portfolio);
      return portfolio;
    }
    const stored = await this.credentialVault.read(userId);
    if (!stored) throw new Error("BITGET_DEMO_NOT_CONNECTED");
    const snapshots = await Promise.all((["RNVDAUSDT", "RTSLAUSDT", "RORCLUSDT"] as ProductionSymbol[])
      .map((symbol) => this.market.snapshot(symbol, { mode: "LIVE_BITGET", now, fresh })));
    const prices = Object.fromEntries(snapshots.map((snapshot) => [snapshot.symbol, snapshot.rTokenPriceMicros])) as PortfolioPrices;
    const portfolio = await this.bitget.portfolio(userId, stored.credentials, prices);
    await this.repository.savePortfolio(portfolio);
    return portfolio;
  }

  async evaluate(userId: string, sessionId: string, input: GuardEvaluationInput, now = new Date()) {
    const [snapshot, portfolio, policyRecord, usage] = await Promise.all([
      this.market.snapshot(input.symbol, { mode: input.dataMode, replayId: input.replayId, now }),
      this.portfolio(userId, input.dataMode, input.replayId),
      this.getPolicy(userId),
      this.repository.getDailyOrderUsage(userId, startOfUtcDay(now)),
    ]);
    const decision = evaluateProductionGuard({ userId, input, snapshot, portfolio, policy: policyRecord.policy,
      policyVersion: policyRecord.version, dailyUsage: usage, now });
    if (decision.permission === "TRADE") {
      const issued = this.tokens.issue({
        decisionId: decision.id,
        userId,
        walletSessionHash: walletSessionHash(sessionId),
        symbol: decision.symbol,
        side: decision.side,
        allowedNotionalCents: decision.allowedNotionalCents,
        maxSlippageBps: decision.maxSlippageBps,
        policyVersion: decision.policyVersion,
        inputHash: decision.inputHash,
        marketHash: decision.marketHash,
        portfolioHash: decision.portfolioHash,
        dataMode: decision.dataMode,
        replayId: input.replayId,
        earningsWindow: input.earningsWindow,
      }, platformPolicy.decisionTtlMs);
      decision.decisionToken = issued.token;
      decision.expiresAt = issued.expiresAt;
    }
    await this.repository.saveDecision(decision);
    await this.repository.saveAudit(userId, "GUARD_EVALUATED", decision.id, { permission: decision.permission, reasonCodes: decision.reasonCodes });
    if (decision.permission !== "TRADE") {
      const stress = decision.reasonCodes.includes("COLLATERAL_STRESS");
      await this.notifications.emit(userId, { kind: stress ? "STRESS_BLOCK" : "DECISION_BLOCKED",
        severity: decision.permission === "BLOCK" ? "WARNING" : "INFO",
        title: stress ? "Collateral stress blocked" : decision.permission === "BLOCK" ? "Paper order blocked" : "Alert only",
        body: `${decision.snapshot.displaySymbol}: ${decision.reasons[0]}` }, `decision:${decision.id}`);
    }
    return decision;
  }

  async execute(userId: string, sessionId: string, decisionToken: string, now = new Date()) {
    const token = this.tokens.verify(decisionToken, { userId, sessionId });
    const decision = await this.repository.getDecision(token.decisionId, userId);
    if (!decision || decision.permission !== "TRADE") throw new Error("DECISION_NOT_EXECUTABLE");
    this.assertBindings(decision, token);

    const existing = await this.repository.getOrderByDecision(decision.id, userId);
    if (existing) {
      this.onDuplicateOrder?.();
      if (!isPending(existing)) return existing;
      await this.reconcilePendingOrders({ userId, decisionId: decision.id, now });
      const reconciled = await this.repository.getOrderByDecision(decision.id, userId);
      if (reconciled && !isPending(reconciled)) return reconciled;
      throw new Error("ORDER_RECONCILIATION_PENDING");
    }

    await this.reconcilePendingOrders({ userId, symbol: token.symbol, now });
    if (await this.hasPendingOrder(userId, token.symbol)) throw new Error("ORDER_RECONCILIATION_PENDING");
    if (await this.killSwitchActive(userId, token.symbol)) throw new Error("PAPER_EXECUTION_KILLED");
    await this.tokens.consumePayload(token);

    const currentPolicy = await this.getPolicy(userId);
    if (`${platformPolicy.version}:${currentPolicy.version}` !== token.policyVersion) throw new Error("POLICY_CHANGED");
    const currentMarket = await this.market.snapshot(token.symbol, { mode: token.dataMode, replayId: token.replayId, now });
    const currentPortfolio = await this.portfolio(userId, token.dataMode, token.replayId);
    const usage = await this.repository.getDailyOrderUsage(userId, startOfUtcDay(now));
    const rechecked = evaluateProductionGuard({
      userId,
      input: { symbol: token.symbol, side: token.side, notionalCents: token.allowedNotionalCents,
        maxSlippageBps: token.maxSlippageBps, dataMode: token.dataMode, replayId: token.replayId,
        earningsWindow: token.earningsWindow ?? false },
      snapshot: currentMarket,
      portfolio: currentPortfolio,
      policy: currentPolicy.policy,
      policyVersion: currentPolicy.version,
      dailyUsage: usage,
      now,
    });
    if (rechecked.permission !== "TRADE" || rechecked.allowedNotionalCents < token.allowedNotionalCents) throw new Error("MARKET_OR_PORTFOLIO_CHANGED");
    const slippageBps = Math.abs(currentMarket.rTokenPriceMicros / decision.snapshot.rTokenPriceMicros - 1) * 10_000;
    if (slippageBps > token.maxSlippageBps) throw new Error("SLIPPAGE_LIMIT_CHANGED");

    const clientOrderId = `sg_${createHash("sha256").update(`${userId}:${decision.id}`).digest("hex").slice(0, 24)}`;
    const at = now.toISOString();
    const reservation: PaperOrderReceiptV1 = {
      id: randomUUID(), decisionId: decision.id, userId, clientOrderId,
      executionMode: token.dataMode === "REPLAY" ? "LOCAL_REPLAY" : "BITGET_DEMO",
      status: "RESERVED", providerOrderId: null,
      message: token.dataMode === "REPLAY" ? "Reserved for local replay simulation." : "Reserved before Bitget Demo submission.",
      submittedAt: at, updatedAt: at, attemptCount: 0,
    };
    const reserved = await this.repository.reserveOrder(reservation, token.allowedNotionalCents, token.side);
    if (!reserved.created) {
      this.onDuplicateOrder?.();
      return reserved.receipt;
    }

    if (token.dataMode === "REPLAY") {
      return this.recordFinal(decision, { ...reservation, status: "SIMULATED", providerOrderId: `local_${decision.id.slice(0, 8)}`,
        message: "Order simulated locally from disclosed replay fixtures; nothing was sent to Bitget.", updatedAt: new Date().toISOString() });
    }

    const stored = await this.credentialVault.read(userId);
    if (!stored?.executionEnabled) {
      const rejected = { ...reservation, status: "REJECTED" as const, message: "Bitget Demo execution is not enabled for this connection.", updatedAt: new Date().toISOString() };
      await this.repository.updateOrder(rejected);
      throw new Error("BITGET_DEMO_EXECUTION_DISABLED");
    }
    const beforeSubmission = await this.bitget.reconcile(stored.credentials, token.symbol, clientOrderId);
    if (beforeSubmission) return this.recordFinal(decision, this.providerReceipt(reservation, beforeSubmission.orderId, beforeSubmission.status,
      "Existing Bitget Demo order reconciled by deterministic client order ID."));

    const submitting: PaperOrderReceiptV1 = { ...reservation, status: "SUBMITTING", attemptCount: 1,
      message: "Bitget Demo request started; deterministic client ID reserved.", updatedAt: new Date().toISOString() };
    await this.repository.updateOrder(submitting);
    try {
      const result = await this.bitget.placeOrder({ credentials: stored.credentials, symbol: token.symbol, side: token.side,
        notionalCents: token.allowedNotionalCents, priceMicros: currentMarket.rTokenPriceMicros, clientOrderId });
      if (!result.orderId) throw new Error("BITGET_DEMO_RESPONSE_UNCERTAIN");
      return this.recordFinal(decision, { ...submitting, status: "SUBMITTED", providerOrderId: result.orderId,
        message: "Order submitted to Bitget Demo with paper-trading mode enforced.", updatedAt: new Date().toISOString() });
    } catch {
      const pending: PaperOrderReceiptV1 = { ...submitting, status: "RECONCILING",
        message: "Bitget Demo response was uncertain; no retry will occur until client-ID reconciliation completes.", updatedAt: new Date().toISOString() };
      await this.repository.updateOrder(pending);
      const afterError = await this.bitget.reconcile(stored.credentials, token.symbol, clientOrderId);
      if (afterError) return this.recordFinal(decision, this.providerReceipt(pending, afterError.orderId, afterError.status,
        "Bitget response was uncertain; the Demo order was reconciled without a blind retry."));
      throw new Error("BITGET_DEMO_ORDER_RECONCILIATION_PENDING");
    }
  }


  async evaluateAgentProposal(input: {
    userId: string; runId: string; context: AgentContextV1; assessment: AgentAssessmentV1;
    settings: AgentSettingsV1; event: OfficialEventV1 | null; now?: Date;
  }) {
    if (!this.agentRepository) throw new Error("AGENT_REPOSITORY_UNAVAILABLE");
    const now = input.now ?? new Date();
    const storedRun = await this.agentRepository.getRun(input.userId, input.runId);
    if (!storedRun || storedRun.state !== "AUTHORIZING" || storedRun.userId !== input.userId ||
      storedRun.symbol !== input.assessment.symbol ||
      (storedRun.sourceMode === "LIVE_BITGET" && storedRun.eventId !== (input.event?.id ?? null)) ||
      storedRun.policyVersion !== input.settings.policyVersion || storedRun.settingsVersion !== input.settings.settingsVersion ||
      storedRun.context?.contextHash !== input.context.contextHash || productionHash(storedRun.assessment) !== productionHash(input.assessment)) {
      throw new Error("AGENT_PROPOSAL_RUN_BINDING_INVALID");
    }
    const guardInput = await this.agentGuardInput(input, now);
    const authorization = evaluateAgentGuard(guardInput);
    if (authorization.guardDecision) await this.repository.saveDecision(authorization.guardDecision);
    await this.repository.saveAudit(input.userId, "AGENT_PROPOSAL_AUTHORIZED", input.runId,
      { permission: authorization.permission, reasonCodes: authorization.reasonCodes, requestedNotionalCents: authorization.requestedNotionalCents,
        allowedNotionalCents: authorization.allowedNotionalCents, contextHash: input.context.contextHash });
    let capability: { token: string; expiresAt: string } | null = null;
    if (authorization.permission === "TRADE" && input.settings.mode === "PAPER_AUTO" && authorization.guardDecision) {
      const grant = guardInput.grant;
      if (!grant) throw new Error("AGENT_GRANT_REQUIRED");
      const decision = authorization.guardDecision;
      capability = this.tokens.issueAgent({ decisionId: decision.id, userId: input.userId, grantId: grant.id,
        grantHash: agentGrantHash(grant), settingsVersion: input.settings.settingsVersion, contextHash: input.context.contextHash,
        runId: input.runId, symbol: decision.symbol, side: decision.side, allowedNotionalCents: authorization.allowedNotionalCents,
        maxSlippageBps: decision.maxSlippageBps, policyVersion: decision.policyVersion, inputHash: decision.inputHash,
        marketHash: decision.marketHash, portfolioHash: decision.portfolioHash, dataMode: "LIVE_BITGET",
        earningsWindow: Boolean(input.event && ["10-Q", "10-K"].includes(input.event.formType)) }, agentPolicy.decisionTtlMs);
      await this.repository.saveAudit(input.userId, "AGENT_CAPABILITY_ISSUED", input.runId,
        { grantId: grant.id, expiresAt: capability.expiresAt, contextHash: input.context.contextHash });
    }
    return { authorization, capability };
  }

  async issueStoredAgentCapability(userId: string, runId: string, now = new Date()) {
    if (!this.agentRepository) throw new Error("AGENT_REPOSITORY_UNAVAILABLE");
    const [run, settings, grant] = await Promise.all([this.agentRepository.getRun(userId, runId),
      this.agentRepository.getSettings(userId), this.agentRepository.getCurrentGrant(userId)]);
    if (!run?.context || !["EXECUTION_READY", "REVALIDATING"].includes(run.state) ||
      !run.authorization?.guardDecision || run.authorization.permission !== "TRADE" ||
      !settings || settings.mode !== "PAPER_AUTO" || !grant || grant.revokedAt || new Date(grant.expiresAt).getTime() <= now.getTime()) {
      throw new Error("AGENT_CAPABILITY_REISSUE_BLOCKED");
    }
    if (settings.settingsVersion !== run.settingsVersion || grant.settingsVersion !== settings.settingsVersion ||
      grant.policyVersion !== settings.policyVersion) throw new Error("AGENT_CAPABILITY_VERSION_CHANGED");
    const decision = run.authorization.guardDecision;
    const capability = this.tokens.issueAgent({ decisionId: decision.id, userId, grantId: grant.id,
      grantHash: agentGrantHash(grant), settingsVersion: settings.settingsVersion, contextHash: run.context.contextHash,
      runId, symbol: decision.symbol, side: decision.side, allowedNotionalCents: run.authorization.allowedNotionalCents,
      maxSlippageBps: decision.maxSlippageBps, policyVersion: decision.policyVersion, inputHash: decision.inputHash,
      marketHash: decision.marketHash, portfolioHash: decision.portfolioHash, dataMode: "LIVE_BITGET",
      earningsWindow: false }, agentPolicy.decisionTtlMs);
    await this.repository.saveAudit(userId, "AGENT_CAPABILITY_REISSUED", runId, { grantId: grant.id, expiresAt: capability.expiresAt });
    return capability;
  }

  async executeAgentDecision(input: { userId: string; runId: string; decisionToken: string; now?: Date }) {
    if (!this.agentRepository) throw new Error("AGENT_REPOSITORY_UNAVAILABLE");
    const now = input.now ?? new Date();
    const [run, settings, grant] = await Promise.all([this.agentRepository.getRun(input.userId, input.runId),
      this.agentRepository.getSettings(input.userId), this.agentRepository.getCurrentGrant(input.userId)]);
    if (!run?.context || run.state !== "REVALIDATING" || !run.assessment || !run.authorization?.guardDecision || run.authorization.permission !== "TRADE") throw new Error("AGENT_RUN_NOT_EXECUTABLE");
    if (!settings || settings.mode !== "PAPER_AUTO" || !grant || grant.revokedAt || new Date(grant.expiresAt).getTime() <= now.getTime()) throw new Error("AGENT_GRANT_INACTIVE");
    const token = this.tokens.verifyAgent(input.decisionToken, { userId: input.userId, grantId: grant.id,
      grantHash: agentGrantHash(grant), runId: input.runId });
    if (token.contextHash !== run.context.contextHash || token.settingsVersion !== settings.settingsVersion) throw new Error("AGENT_CAPABILITY_BINDING_MISMATCH");
    const decision = run.authorization.guardDecision;
    this.assertBindings(decision, token);
    const existing = await this.repository.getOrderByDecision(decision.id, input.userId);
    if (existing) {
      this.onDuplicateOrder?.();
      if (!isPending(existing)) return existing;
      await this.reconcilePendingOrders({ userId: input.userId, decisionId: decision.id, now });
      const reconciled = await this.repository.getOrderByDecision(decision.id, input.userId);
      if (reconciled && !isPending(reconciled)) return reconciled;
      throw new Error("ORDER_RECONCILIATION_PENDING");
    }
    await this.reconcilePendingOrders({ userId: input.userId, symbol: token.symbol, now });
    if (await this.hasPendingOrder(input.userId, token.symbol)) throw new Error("ORDER_RECONCILIATION_PENDING");
    if (await this.agentKillSwitchActive(input.userId, token.symbol)) throw new Error("AGENT_EXECUTION_KILLED");
    const event = run.eventId ? await this.agentRepository.getOfficialEvent(run.eventId) : null;
    const rechecked = evaluateAgentGuard(await this.agentGuardInput({ userId: input.userId, runId: input.runId,
      context: run.context, assessment: run.assessment, settings, event }, now));
    if (rechecked.permission !== "TRADE" || rechecked.allowedNotionalCents < token.allowedNotionalCents || !rechecked.guardDecision) throw new Error("AGENT_REVALIDATION_BLOCKED");
    if (rechecked.guardDecision.policyVersion !== token.policyVersion) throw new Error("AGENT_POLICY_CHANGED");
    if (rechecked.guardDecision.snapshot.session !== "CASH_OPEN") throw new Error("CASH_OPEN_REQUIRED");
    const slippageBps = Math.abs(rechecked.guardDecision.snapshot.rTokenPriceMicros / decision.snapshot.rTokenPriceMicros - 1) * 10_000;
    if (slippageBps > token.maxSlippageBps) throw new Error("SLIPPAGE_LIMIT_CHANGED");
    await this.tokens.consumeAgent(input.decisionToken, { userId: input.userId, grantId: grant.id,
      grantHash: agentGrantHash(grant), runId: input.runId });
    await this.agentRepository.reserveAutomaticExecution({ runId: input.runId, userId: input.userId, eventId: run.eventId,
      symbol: token.symbol, side: token.side, notionalCents: token.allowedNotionalCents, createdAt: now.toISOString() },
    { count: Math.min(settings.automaticOrdersPerDay, grant.automaticOrdersPerDay),
      grossNewNotionalCents: Math.min(settings.automaticGrossNewNotionalCents, grant.automaticGrossNewNotionalCents),
      cooldownMs: agentPolicy.symbolCooldownMs });
    await this.repository.saveAudit(input.userId, "AGENT_CAPABILITY_CONSUMED", input.runId,
      { grantId: grant.id, decisionId: decision.id, contextHash: token.contextHash });

    const clientOrderId = `sg_${createHash("sha256").update(`${input.userId}:${decision.id}`).digest("hex").slice(0, 24)}`;
    const at = now.toISOString();
    const reservation: PaperOrderReceiptV1 = { id: randomUUID(), decisionId: decision.id, userId: input.userId, clientOrderId,
      executionMode: "BITGET_DEMO", status: "RESERVED", providerOrderId: null,
      message: "Reserved before autonomous Bitget Demo submission.", submittedAt: at, updatedAt: at, attemptCount: 0 };
    const reserved = await this.repository.reserveOrder(reservation, token.allowedNotionalCents, token.side);
    if (!reserved.created) { this.onDuplicateOrder?.(); return reserved.receipt; }
    let stored;
    try { stored = await this.credentialVault.read(input.userId); }
    catch (error) {
      await this.disableAgentExecution(input.userId, "CREDENTIAL_INVALIDATED");
      throw error;
    }
    if (!stored?.executionEnabled) {
      await this.disableAgentExecution(input.userId, "CREDENTIAL_INVALIDATED");
      const rejected = { ...reservation, status: "REJECTED" as const, message: "Bitget Demo execution is not enabled for this connection.", updatedAt: new Date().toISOString() };
      await this.repository.updateOrder(rejected); throw new Error("BITGET_DEMO_EXECUTION_DISABLED");
    }
    const beforeSubmission = await this.bitget.reconcile(stored.credentials, token.symbol, clientOrderId);
    if (beforeSubmission) return this.recordFinal(decision, this.providerReceipt(reservation, beforeSubmission.orderId,
      beforeSubmission.status, "Existing Bitget Demo order reconciled by deterministic client order ID."));
    const submitting: PaperOrderReceiptV1 = { ...reservation, status: "SUBMITTING", attemptCount: 1,
      message: "Autonomous Bitget Demo request started; deterministic client ID reserved.", updatedAt: new Date().toISOString() };
    await this.repository.updateOrder(submitting);
    try {
      const result = await this.bitget.placeOrder({ credentials: stored.credentials, symbol: token.symbol, side: token.side,
        notionalCents: token.allowedNotionalCents, priceMicros: rechecked.guardDecision.snapshot.rTokenPriceMicros, clientOrderId });
      if (!result.orderId) throw new Error("BITGET_DEMO_RESPONSE_UNCERTAIN");
      return this.recordFinal(decision, { ...submitting, status: "SUBMITTED", providerOrderId: result.orderId,
        message: "Autonomous order submitted to Bitget Demo with paper-trading mode enforced.", updatedAt: new Date().toISOString() });
    } catch {
      const pending: PaperOrderReceiptV1 = { ...submitting, status: "RECONCILING",
        message: "Bitget Demo response was uncertain; no retry will occur until client-ID reconciliation completes.", updatedAt: new Date().toISOString() };
      await this.repository.updateOrder(pending);
      const afterError = await this.bitget.reconcile(stored.credentials, token.symbol, clientOrderId);
      if (afterError) return this.recordFinal(decision, this.providerReceipt(pending, afterError.orderId, afterError.status,
        "Uncertain Demo response reconciled without a blind retry."));
      throw new Error("BITGET_DEMO_ORDER_RECONCILIATION_PENDING");
    }
  }

  async reconcilePendingOrders(filters: { userId?: string; symbol?: ProductionSymbol; decisionId?: string; now?: Date; limit?: number } = {}) {
    const now = filters.now ?? new Date();
    let resolved = 0;
    for (const receipt of await this.repository.listReconciliationOrders(filters.limit ?? 100)) {
      if (filters.userId && receipt.userId !== filters.userId) continue;
      if (filters.decisionId && receipt.decisionId !== filters.decisionId) continue;
      const decision = await this.repository.getDecision(receipt.decisionId, receipt.userId);
      if (!decision || (filters.symbol && decision.symbol !== filters.symbol)) continue;
      const release = await this.coordinator.acquireLock(`order-reconcile:${receipt.id}`, 30_000);
      if (!release) continue;
      try {
        if (receipt.executionMode === "LOCAL_REPLAY") {
          await this.recordFinal(decision, { ...receipt, status: "SIMULATED", providerOrderId: `local_${decision.id.slice(0, 8)}`,
            message: "Recovered local replay simulation; nothing was sent to Bitget.", updatedAt: now.toISOString() });
          resolved += 1;
          continue;
        }
        if (receipt.status === "RESERVED") {
          if (now.getTime() - new Date(receipt.updatedAt).getTime() >= 120_000) {
            await this.recordFinal(decision, { ...receipt, status: "REJECTED",
              message: "The pre-submission reservation expired safely; a fresh permission is required.", updatedAt: now.toISOString() });
            resolved += 1;
          }
          continue;
        }
        const stored = await this.credentialVault.read(receipt.userId);
        if (!stored) continue;
        try {
          const provider = await this.bitget.reconcile(stored.credentials, decision.symbol, receipt.clientOrderId);
          if (provider) {
            const updated = this.providerReceipt(receipt, provider.orderId, provider.status,
              receipt.status === "SUBMITTED" ? "Bitget Demo receipt lifecycle synchronized by deterministic client order ID."
                : "Pending Bitget Demo submission reconciled by deterministic client order ID.");
            if (updated.status !== receipt.status || updated.providerOrderId !== receipt.providerOrderId) {
              await this.recordFinal(decision, updated);
              resolved += 1;
            } else {
              await this.repository.updateOrder({ ...receipt, updatedAt: now.toISOString() });
            }
          } else if (receipt.status === "SUBMITTED") {
            await this.repository.updateOrder({ ...receipt, updatedAt: now.toISOString() });
          } else if (now.getTime() - new Date(receipt.submittedAt).getTime() >= 10 * 60_000) {
            await this.notifications.emit(receipt.userId, { kind: "ORDER", severity: "CRITICAL", title: "Demo order needs review",
              body: `${decision.snapshot.displaySymbol}: an uncertain Demo response is still unresolved. New orders for this symbol remain blocked.` },
            `order-unresolved:${receipt.id}`);
          }
        } catch {
          if (receipt.status !== "SUBMITTED" && now.getTime() - new Date(receipt.submittedAt).getTime() >= 10 * 60_000) {
            await this.notifications.emit(receipt.userId, { kind: "ORDER", severity: "CRITICAL", title: "Demo reconciliation provider unavailable",
              body: `${decision.snapshot.displaySymbol}: SessionGuard cannot verify an uncertain Demo order. New orders remain blocked.` },
            `order-provider-unavailable:${receipt.id}`);
          }
        }
      } finally { await release(); }
    }
    return resolved;
  }

  async refreshConnectedPortfolios() {
    for (const userId of await this.repository.listConnectedUsers()) {
      const release = await this.coordinator.acquireLock(`portfolio:${userId}`, 4 * 60_000);
      if (!release) continue;
      try { await this.portfolio(userId, "LIVE_BITGET"); }
      catch {
        await this.notifications.emit(userId, { kind: "CREDENTIAL", severity: "WARNING", title: "Portfolio refresh failed",
          body: "SessionGuard could not refresh the Bitget Demo portfolio. Trading remains fail-closed." }, `portfolio-refresh:${Math.floor(Date.now() / 300_000)}`);
      } finally { await release(); }
    }
  }


  private async disableAgentExecution(userId: string, reason: string) {
    if (!this.agentRepository) return;
    const now = new Date();
    const [revoked, settings] = await Promise.all([
      this.agentRepository.revokeCurrentGrant(userId, reason, now),
      this.agentRepository.getSettings(userId),
    ]);
    if (settings?.mode === "PAPER_AUTO") {
      const demoted = AgentSettingsV1Schema.parse({ ...settings, mode: "ALERT_ONLY",
        settingsVersion: productionHash({ prior: settings.settingsVersion, mode: "ALERT_ONLY", reason, at: now.toISOString() }).slice(0, 24),
        updatedAt: now.toISOString() });
      await this.agentRepository.saveSettings(demoted);
    }
    if (revoked || settings?.mode === "PAPER_AUTO") await this.repository.saveAudit(userId, "AGENT_EXECUTION_DISABLED", revoked?.id ?? null, { reason });
  }

  private async agentGuardInput(input: { userId: string; runId: string; context: AgentContextV1; assessment: AgentAssessmentV1;
    settings: AgentSettingsV1; event: OfficialEventV1 | null }, now: Date) {
    if (!this.agentRepository) throw new Error("AGENT_REPOSITORY_UNAVAILABLE");
    const dataMode = input.context.trigger.sourceMode === "LOCAL_REPLAY" ? "REPLAY" as const : "LIVE_BITGET" as const;
    const [market, portfolio, policy, platformUsage, automaticUsage, grant, recent, pending, kills] = await Promise.all([
      this.market.snapshot(input.assessment.symbol, { mode: dataMode, replayId: input.context.trigger.replayId ?? undefined, now, fresh: dataMode === "LIVE_BITGET" }),
      this.portfolio(input.userId, dataMode, input.context.trigger.replayId ?? undefined, now, dataMode === "LIVE_BITGET"), this.getPolicy(input.userId),
      this.repository.getDailyOrderUsage(input.userId, startOfUtcDay(now)),
      this.agentRepository.getAutomaticUsage(input.userId, startOfUtcDay(now)), this.agentRepository.getCurrentGrant(input.userId),
      this.agentRepository.listRecentRuns(input.userId, input.assessment.symbol, new Date(now.getTime() - 365 * 86_400_000).toISOString(), 500),
      this.hasPendingOrder(input.userId, input.assessment.symbol), this.agentKillSwitches(input.userId, input.assessment.symbol),
    ]);
    const baseline = await this.agentRepository.getOrCreateDailyEquityBaseline(input.userId, now.toISOString().slice(0, 10),
      portfolio.accountEquityCents, portfolio.capturedAt);
    const eligible = await agentEligibility(this.agentRepository, input.settings, now);
    const executed = recent.filter((run) => run.id !== input.runId && run.receipt?.executionMode === "BITGET_DEMO" && run.receipt.status !== "REJECTED");
    return { userId: input.userId, assessment: input.assessment, context: input.context, settings: input.settings, grant,
      event: input.event, market, portfolio, userPolicy: policy.policy, userPolicyVersion: policy.version,
      platformUsage, automaticUsage, dailyBaselineEquityCents: baseline, outstandingSameSymbolOrder: pending,
      eventAlreadyActioned: Boolean(input.event && executed.some((run) => run.eventId === input.event!.id)),
      symbolCooldownActive: executed.some((run) => now.getTime() - new Date(run.createdAt).getTime() < agentPolicy.symbolCooldownMs),
      eligibleForPaperAuto: eligible.eligible, killSwitches: kills, now };
  }

  private async agentKillSwitches(userId: string, symbol: ProductionSymbol) {
    const values = await Promise.all([this.coordinator.cacheGet<boolean>("kill:global"),
      this.coordinator.cacheGet<boolean>(`kill:user:${userId}`), this.coordinator.cacheGet<boolean>(`kill:symbol:${symbol}`),
      this.coordinator.cacheGet<boolean>("kill:agent-runtime"), this.coordinator.cacheGet<boolean>("kill:agent-model"),
      this.coordinator.cacheGet<boolean>("kill:agent-provider")]);
    return { global: Boolean(values[0]), user: Boolean(values[1]), symbol: Boolean(values[2]), runtime: Boolean(values[3]),
      model: Boolean(values[4]), provider: Boolean(values[5]) };
  }

  private async agentKillSwitchActive(userId: string, symbol: ProductionSymbol) {
    return Object.values(await this.agentKillSwitches(userId, symbol)).some(Boolean);
  }

  private assertBindings(decision: GuardDecision, token: { inputHash: string; marketHash: string; portfolioHash: string; policyVersion: string; allowedNotionalCents: number; symbol: ProductionSymbol; side: "buy" | "sell"; dataMode: "LIVE_BITGET" | "REPLAY" }) {
    if (decision.inputHash !== token.inputHash || decision.marketHash !== token.marketHash ||
      decision.portfolioHash !== token.portfolioHash || decision.policyVersion !== token.policyVersion ||
      decision.allowedNotionalCents !== token.allowedNotionalCents || decision.symbol !== token.symbol || decision.side !== token.side ||
      decision.dataMode !== token.dataMode) throw new Error("DECISION_TOKEN_BINDING_MISMATCH");
  }

  private async hasPendingOrder(userId: string, symbol: ProductionSymbol) {
    for (const receipt of await this.repository.listReconciliationOrders(500)) {
      if (receipt.userId !== userId) continue;
      const decision = await this.repository.getDecision(receipt.decisionId, userId);
      if (decision?.symbol === symbol) return true;
    }
    return false;
  }

  private providerReceipt(receipt: PaperOrderReceiptV1, orderId: string, providerStatus: string, message: string): PaperOrderReceiptV1 {
    const normalized = providerStatus.toLowerCase();
    const status: PaperOrderReceiptV1["status"] = normalized.includes("fill") ? "FILLED"
      : /cancel|reject|fail|expire/.test(normalized) ? "REJECTED" : "SUBMITTED";
    return { ...receipt, status, providerOrderId: orderId, message, updatedAt: new Date().toISOString() };
  }

  private async recordFinal(decision: GuardDecision, receipt: PaperOrderReceiptV1) {
    await this.repository.updateOrder(receipt);
    await this.repository.saveAudit(receipt.userId, "PAPER_ORDER_RECORDED", receipt.id,
      { executionMode: receipt.executionMode, status: receipt.status, clientOrderId: receipt.clientOrderId });
    await this.notifications.emit(receipt.userId, { kind: "ORDER", severity: receipt.status === "REJECTED" ? "WARNING" : "INFO",
      title: receipt.executionMode === "LOCAL_REPLAY" ? "Replay simulated" : receipt.status === "REJECTED" ? "Demo order safely rejected" : "Demo order reconciled",
      body: `${decision.snapshot.displaySymbol}: ${receipt.message}` }, `order:${receipt.id}:${receipt.status}`);
    return receipt;
  }

  private async killSwitchActive(userId: string, symbol: ProductionSymbol) {
    const values = await Promise.all([
      this.coordinator.cacheGet<boolean>("kill:global"),
      this.coordinator.cacheGet<boolean>(`kill:user:${userId}`),
      this.coordinator.cacheGet<boolean>(`kill:symbol:${symbol}`),
    ]);
    return values.some(Boolean);
  }
}
