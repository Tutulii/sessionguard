import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { Wallet } from "ethers";

// A fresh wallet makes each run tenant-isolated even when a developer reuses the local E2E database.
const wallet = Wallet.createRandom();
const walletButtonName = new RegExp(`${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`, "i");

async function installTestWallet(page: Page) {
  await page.exposeFunction("__sessionGuardSign", (message: string) => wallet.signMessage(message));
  await page.addInitScript(({ address }) => {
    const sign = (globalThis as typeof globalThis & { __sessionGuardSign: (message: string) => Promise<string> }).__sessionGuardSign;
    (window as typeof window & { ethereum: unknown }).ethereum = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_requestAccounts") return [address];
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        if (method === "personal_sign") {
          const values = params ?? [];
          const message = String(values.find((value) => typeof value === "string" && value !== address) ?? values[0] ?? "");
          return sign(message);
        }
        throw new Error(`Unsupported test-wallet method: ${method}`);
      },
    };
  }, { address: wallet.address });
}

async function signIn(page: Page) {
  await page.getByRole("button", { name: "Sign wallet", exact: true }).click();
  await expect(page.getByRole("button", { name: walletButtonName })).toBeVisible();
  await expect(page.getByText(/verified on Arbitrum/i)).toBeVisible();
}

test.describe("production user journeys", () => {
  test.beforeEach(async ({ page }) => { await installTestWallet(page); });

  test("explains the problem, authenticates ownership, and blocks Sunday exposure", async ({ page }, testInfo) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("The market sleeps");
    await expect(page.getByText("Two clocks.")).toBeVisible();
    await expect(page.getByText("Bitget-only data")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("landing.png"), fullPage: true });

    await page.getByRole("link", { name: /run the sunday replay/i }).click();
    await expect(page).toHaveURL(/\/app\?replay=sunday-oracle/);
    await expect(page.locator(".session-badge").getByText("WEEKEND", { exact: true })).toBeVisible();
    await expect(page.getByText(/BITGET CASH SESSION ANCHOR/i)).toBeVisible();
    await page.getByRole("button", { name: "Jump to decision point" }).click();
    await signIn(page);
    await expect(page.locator(".prod-positions")).toContainText("COLLATERAL");
    await page.getByRole("button", { name: /run deterministic guard/i }).click();
    const gate = page.locator(".permission-panel");
    await expect(gate.getByText("BLOCK", { exact: true }).first()).toBeVisible();
    await expect(gate).toContainText("ALLOWED$0");
    await expect(page.getByText("Exposure intercepted and logged.")).toBeVisible();
    await expect(page.locator(".receipt-row").first()).toContainText("CASH_MARKET_DARK");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("weekend-block.png"), fullPage: true });
  });

  test("allows cash-open permission and keeps replay execution entirely local", async ({ page }) => {
    await page.goto("/app?replay=cash-nvidia");
    await expect(page.locator(".session-badge").getByText("CASH OPEN", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Jump to decision point" }).click();
    await signIn(page);
    await page.getByLabel("Paper order notional").fill("150");
    await page.getByRole("button", { name: /run deterministic guard/i }).click();
    const gate = page.locator(".permission-panel");
    await expect(gate.getByText("TRADE", { exact: true }).first()).toBeVisible();
    await expect(gate).toContainText("ALLOWED$150");
    await page.getByRole("button", { name: /simulate allowed order/i }).click();
    await expect(page.getByText(/nothing was sent to Bitget/i)).toBeVisible();
    await expect(page.locator(".receipt-row").first()).toContainText("LOCAL REPLAY SIMULATION");
    await expect(page.locator(".receipt-row").first()).toContainText("SIMULATED");
  });

  test("discloses persistent credential protection and explicit Live failure fallback", async ({ page }) => {
    await page.goto("/app");
    await signIn(page);
    const connect = page.getByRole("button", { name: /connect demo/i });
    await connect.click();
    const dialog = page.getByRole("dialog", { name: "Connect Bitget Demo" });
    await expect(dialog).toContainText("envelope-encrypted with a managed key");
    await expect(dialog).toContainText("No live-money API path exists");
    await expect(dialog.getByLabel("Demo API key")).toHaveAttribute("type", "password");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(connect).toBeFocused();

    await page.route("**/api/v1/market/snapshots/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("mode") === "LIVE_BITGET") {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "BITGET_TEST_OUTAGE", fallback: "REPLAY" }) });
      } else await route.continue();
    });
    await page.getByRole("button", { name: /live bitget/i }).click();
    await expect(page.getByText(/BITGET_TEST_OUTAGE.*not relabelled as replay/i)).toBeVisible();
    await page.getByRole("button", { name: /open disclosed replay/i }).click();
    await expect(page.locator(".market-source-status").filter({ hasText: "STATIC REPLAY DATA" })).toBeVisible();
  });

  test("plays recorded ticks, pauses cleanly, and unlocks only at the decision point", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "Replay motion is covered once; mobile layout has a separate journey");
    await page.goto("/app?replay=extended-tesla");
    await expect(page.getByText("STATIC REPLAY DATA", { exact: true })).toBeVisible();
    const timeline = page.getByRole("slider", { name: "Replay timeline" });
    await expect(timeline).toHaveValue("0");
    await expect(page.getByRole("button", { name: "Reach decision point to run guard" })).toBeDisabled();
    await page.getByRole("button", { name: "Play replay" }).click();
    await expect(page.getByRole("button", { name: "Pause replay" })).toBeVisible();
    await expect.poll(async () => Number(await timeline.inputValue())).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Pause replay" }).click();
    const pausedFrame = await timeline.inputValue();
    await page.waitForTimeout(1_000);
    await expect(timeline).toHaveValue(pausedFrame);
    await page.screenshot({ path: testInfo.outputPath("replay-player.png"), fullPage: false });
    await page.getByRole("button", { name: "Jump to decision point" }).click();
    await expect(timeline).toHaveValue("5");
    await expect(page.getByText("DECISION POINT READY", { exact: true })).toBeVisible();
    await expect(page.locator(".market-price-line > div > strong")).toHaveText("$416.18");
    await expect(page.getByRole("button", { name: "Sign wallet to run guard" })).toBeEnabled();
  });

  test("provides keyboard tabs and a focus-contained, Escape-safe dialog", async ({ page }) => {
    await page.goto("/app?replay=sunday-oracle");
    const oracleTab = page.getByRole("tab", { name: /rORCL/i });
    await oracleTab.focus();
    await page.keyboard.press("ArrowRight");
    const nvidiaTab = page.getByRole("tab", { name: /rNVDA/i });
    await expect(nvidiaTab).toHaveAttribute("aria-selected", "true");
    await expect(nvidiaTab).toBeFocused();

    await signIn(page);
    const connect = page.getByRole("button", { name: /connect demo/i });
    await connect.click();
    const dialog = page.getByRole("dialog", { name: "Connect Bitget Demo" });
    await expect(dialog.getByLabel("Demo API key")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: /close connect bitget demo/i })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: /verify and encrypt/i })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(connect).toBeFocused();
  });

  test("exports production CSV receipts", async ({ page }) => {
    await page.goto("/app?replay=sunday-oracle");
    await page.getByRole("button", { name: "Jump to decision point" }).click();
    await signIn(page);
    await page.getByRole("button", { name: /run deterministic guard/i }).click();
    await expect(page.getByText("Exposure intercepted and logged.")).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: /export csv/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("sessionguard-production-decisions.csv");
  });

  test("saves tighter controls and exercises verified in-app alert history", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "Full settings workflow runs once");
    await page.goto("/app?replay=sunday-oracle");
    await signIn(page);
    await page.locator("#policy input[type=range]").nth(1).fill("10");
    await page.getByRole("button", { name: /save stricter policy/i }).click();
    await expect(page.getByText("Stricter policy saved.")).toBeVisible();
    await page.getByRole("button", { name: "Notifications" }).click();
    const dialog = page.getByRole("dialog", { name: "Risk alerts" });
    await expect(dialog).toContainText("In-app inbox");
    await dialog.getByRole("button", { name: /send test/i }).click();
    await expect(dialog).toContainText("Your verified alert pipeline is ready.");
  });

  test("loads paginated immutable receipts", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "Pagination load runs once");
    await page.goto("/app?replay=sunday-oracle");
    await signIn(page);
    const statuses = await page.evaluate(async () => {
      const results: number[] = [];
      for (let index = 0; index < 26; index += 1) {
        const response = await fetch("/api/v1/guard/evaluate", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-sessionguard-request": "1" },
          body: JSON.stringify({ symbol: "RORCLUSDT", side: "buy", notionalCents: 1_000 + index,
            maxSlippageBps: 50, dataMode: "REPLAY", replayId: "sunday-oracle", earningsWindow: false }),
        });
        results.push(response.status);
      }
      return results;
    });
    expect(statuses).toEqual(Array.from({ length: 26 }, () => 200));
    await page.reload();
    await expect(page.locator(".receipt-row")).toHaveCount(25);
    await page.getByRole("button", { name: /load older receipts/i }).click();
    await expect.poll(() => page.locator(".receipt-row").count()).toBeGreaterThan(25);
  });

  test("renders the disclosed agent control room", async ({ page }) => {
    await page.goto("/agent");
    await expect(page.getByRole("heading", { name: /when not to trade/i })).toBeVisible();
    await expect(page.getByText("Bitget Demo only", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("LIVE MONEY = IMPOSSIBLE", { exact: true })).toBeVisible();
  });

  test("has no serious automated accessibility violations", async ({ page }) => {
    for (const route of ["/", "/app?replay=sunday-oracle", "/agent"]) {
      await page.goto(route);
      const root = page.locator(route === "/" ? ".landing-page" : route === "/agent" ? ".agent-page" : ".dashboard-page");
      await expect(root).toHaveCSS("opacity", "1");
      await expect(page.locator(".scene-verdict").first()).toHaveCSS("opacity", "1");
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
      expect(serious, `Accessibility violations on ${route}: ${serious.map((item) => item.id).join(", ")}`).toEqual([]);
    }
  });
});

test.describe("responsive production composition", () => {
  test("keeps the 390px control room usable without horizontal overflow", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-chromium", "Mobile-specific visual acceptance");
    await page.goto("/app?replay=sunday-oracle");
    await expect(page.locator(".mobile-bottom-nav")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Permission desk" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const targets = page.locator(".mobile-bottom-nav a, .mobile-bottom-nav button");
    for (let index = 0; index < await targets.count(); index += 1) {
      const box = await targets.nth(index).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: testInfo.outputPath("mobile-control-room.png"), fullPage: true });
  });

  test("honors the user's reduced-motion preference", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto("/app");
    await expect(page.locator(".paper-grain")).toHaveCSS("display", "none");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
    const character = page.locator(".guardian-character");
    const before = await character.getAttribute("style");
    await page.waitForTimeout(120);
    expect(await character.getAttribute("style")).toBe(before);
    await context.close();
  });
});
