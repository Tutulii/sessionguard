// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionConfig } from "framer-motion";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultUserPolicy, symbolMetadata, type ProductionMarketSnapshot } from "../../shared/production-types";
import { replayScenarios } from "../../shared/replays";
import { App } from "../App";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  address: "0x1111111111111111111111111111111111111111",
  chainId: 42161 as const,
  createdAt: "2026-09-09T00:00:00.000Z",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function snapshotFor(symbol: string, replayId?: string): ProductionMarketSnapshot {
  const scenario = replayScenarios.find((item) => item.id === replayId && item.snapshot.symbol === symbol)
    ?? replayScenarios.find((item) => item.snapshot.symbol === symbol)
    ?? replayScenarios[0];
  const source = scenario.snapshot;
  const metadata = symbolMetadata[source.symbol];
  return {
    symbol: source.symbol,
    ...metadata,
    dataMode: "REPLAY",
    sourceLabel: "REPLAY",
    source: "BITGET",
    session: source.session === "CASH_OPEN" ? "CASH_OPEN" : source.session === "EXTENDED" ? "EXTENDED" : "WEEKEND",
    rTokenPriceMicros: Math.round(source.rTokenPrice * 1_000_000),
    bidPriceMicros: Math.round(source.bid * 1_000_000),
    askPriceMicros: Math.round(source.ask * 1_000_000),
    spreadBps: source.spreadBps,
    referenceKind: "BITGET_CASH_SESSION_ANCHOR",
    referenceQuality: source.alignedReference === null ? "MISSING" : "OBSERVED",
    anchorPriceMicros: source.alignedReference === null ? null : Math.round(source.alignedReference * 1_000_000),
    offHoursMoveBps: source.basisBps,
    providerTimestamp: source.quoteTime,
    receivedTimestamp: "2026-09-09T00:00:00.000Z",
    quoteAgeMs: 0,
    referenceTimestamp: source.referenceTime,
    nextCashOpen: source.nextCashOpen,
    chart: source.chart.map((point) => ({ time: point.time, priceMicros: Math.round(point.price * 1_000_000) })),
  };
}

function renderRoute(route: string) {
  return render(
    <MotionConfig reducedMotion="always">
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </MotionConfig>,
  );
}

function mockProductionApi(authenticated = false) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    if (url.pathname === "/api/v1/replays") return json({
      scenarios: replayScenarios.map(({ id, name, kicker, description, snapshot }) => ({ id, name, kicker, description, symbol: snapshot.symbol })),
    });
    if (url.pathname === "/api/v1/auth/me") return authenticated ? json({ authenticated: true, user }) : json({ error: "AUTH_REQUIRED" }, 401);
    if (url.pathname.startsWith("/api/v1/market/snapshots/")) {
      const symbol = url.pathname.split("/").at(-1)!;
      return json({ snapshot: snapshotFor(symbol, url.searchParams.get("replayId") ?? undefined) });
    }
    if (url.pathname === "/api/v1/connections/bitget-demo") return json({ connected: false, executionEnabled: false, lastValidatedAt: null });
    if (url.pathname === "/api/v1/policies") return json({ policy: defaultUserPolicy, version: "default" });
    if (url.pathname === "/api/v1/portfolio") return json({ portfolio: {
      userId: user.id, accountEquityCents: 500_000, availableBalanceCents: 410_000, collateralBufferPct: 24,
      positions: [{ symbol: "RORCLUSDT", quantityMicros: 2_000_000, marketValueCents: 60_000, usedAsCollateral: true }],
      openOrderCount: 0, source: "REPLAY", capturedAt: new Date().toISOString(),
    } });
    if (url.pathname === "/api/v1/decisions") return json({ receipts: [], page: { nextOffset: null } });
    if (url.pathname === "/api/v1/notifications/channels") return json({ channels: [], vapidPublicKey: null });
    if (url.pathname === "/api/v1/notifications/inbox") return json({ notifications: [] });
    return json({ error: "NOT_FOUND" }, 404);
  });
}

class FakeEventSource {
  addEventListener() {}
  close() {}
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SessionGuard React experience", () => {
  it("renders the premium landing narrative and direct judge replay CTA", () => {
    renderRoute("/");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("The market sleeps.Your rules don’t.");
    expect(screen.getByRole("link", { name: /run the sunday replay/i })).toHaveAttribute("href", "/app?replay=sunday-oracle");
    expect(screen.getByText(/No caller can skip this box/i)).toBeInTheDocument();
  });

  it("renders the production control room with truthful Bitget-only replay labels", async () => {
    vi.stubGlobal("fetch", mockProductionApi());
    renderRoute("/app?replay=sunday-oracle");
    expect(screen.getByRole("heading", { name: "Permission desk" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("WEEKEND").length).toBeGreaterThan(0));
    expect(screen.getByText("STATIC REPLAY DATA", { selector: ".market-source-status" })).toBeInTheDocument();
    expect(screen.getByText(/BITGET CASH SESSION ANCHOR/i)).toBeInTheDocument();
    const timeline = screen.getByRole("slider", { name: "Replay timeline" }) as HTMLInputElement;
    expect(timeline.value).toBe("0");
    expect(screen.getByRole("button", { name: "Reach decision point to run guard" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Jump to decision point" }));
    await waitFor(() => expect(timeline.value).toBe(String(replayScenarios[0].snapshot.chart.length - 1)));
    expect(screen.getByText("DECISION POINT READY")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign wallet to run guard/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/rORCL Bitget rToken price chart/i)).toBeInTheDocument();
  });

  it("switches the complete replay context without mixing symbols", async () => {
    vi.stubGlobal("fetch", mockProductionApi());
    renderRoute("/app?replay=sunday-oracle");
    const select = await screen.findByRole("combobox", { name: "Replay scenario" });
    fireEvent.change(select, { target: { value: "cash-nvidia" } });
    await waitFor(() => expect(screen.getAllByText("CASH OPEN").length).toBeGreaterThan(0));
    expect(screen.getByRole("heading", { name: /rNVDA/i })).toBeInTheDocument();
  });

  it("explains persistent envelope encryption in the authenticated Demo dialog", async () => {
    vi.stubGlobal("fetch", mockProductionApi(true));
    vi.stubGlobal("EventSource", FakeEventSource);
    renderRoute("/app");
    await screen.findByRole("button", { name: /0x1111…1111/i });
    expect(await screen.findByText("COLLATERAL")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /connect demo/i }));
    expect(screen.getByRole("dialog", { name: "Connect Bitget Demo" })).toBeInTheDocument();
    expect(screen.getByLabelText("Demo API key")).toHaveAttribute("type", "password");
    expect(screen.getByText(/envelope-encrypted with a managed key/i)).toBeInTheDocument();
    expect(screen.getByText(/No live-money API path exists/i)).toBeInTheDocument();
    for (const control of ["Earnings-window size", "Cash-session spread", "Extended spread", "Required collateral buffer"]) {
      expect(screen.getByText(control)).toBeInTheDocument();
    }
    expect(screen.getAllByRole("link", { name: "Policy" }).some((link) => link.getAttribute("href") === "#policy")).toBe(true);
  });
});
