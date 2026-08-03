import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { afterEach, expect, inject, test } from "vitest";

/**
 * Launches Chromium and loads the unpacked test extension. The browser
 * provider of Vitest cannot load extensions, so this suite runs in the
 * Node project and controls Playwright directly.
 *
 * Use `channel: "chromium"` (the Chromium build of Playwright). Branded
 * Chrome removed `--load-extension` in version 137 and later.
 *
 * Do not call serviceWorker.evaluate(). The call hangs on these extension
 * workers. The extension agrees on readiness internally with a
 * chrome.runtime.Port acknowledgement.
 */
async function launchExtensionContext(): Promise<BrowserContext> {
  const extensionPath = inject("chromeExtensionPath");
  const userDataDir = await mkdtemp(path.join(tmpdir(), "browser-channel-ext-"));

  return chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
}

async function extensionIdFor(context: BrowserContext): Promise<string> {
  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
  return new URL(worker.url()).host;
}

async function openHostPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  await page.goto(inject("chromeExtensionHostUrl"));
  await page.waitForFunction(() => window.__channelReady === true, undefined, { timeout: 60_000 });
  return page;
}

let context: BrowserContext | undefined;

afterEach(async () => {
  await context?.close();
  context = undefined;
}, 30_000);

test(
  "host MessagePort relays through content script to background chrome.runtime.Port",
  async () => {
    context = await launchExtensionContext();

    /*
     * Make sure that the MV3 worker starts before the page connects.
     */
    if (context.serviceWorkers().length === 0) {
      await context.waitForEvent("serviceworker", { timeout: 15_000 });
    }

    const page = await openHostPage(context);

    const reply = await page.evaluate(async () => {
      const channel = window.__channel;
      if (!channel) {
        throw new Error("host channel was not installed");
      }
      return channel.send("ping", { message: "from host" });
    });

    expect(reply).toEqual({ reply: "background saw from host" });
  },
  90_000,
);

test(
  "multiple host tabs each communicate with the background hub",
  async () => {
    context = await launchExtensionContext();

    if (context.serviceWorkers().length === 0) {
      await context.waitForEvent("serviceworker", { timeout: 15_000 });
    }

    const pageA = await openHostPage(context);
    const pageB = await openHostPage(context);

    const [replyA, replyB] = await Promise.all([
      pageA.evaluate(async () => {
        const channel = window.__channel;
        if (!channel) {
          throw new Error("host channel was not installed");
        }
        return channel.send("ping", { message: "from tab A" });
      }),
      pageB.evaluate(async () => {
        const channel = window.__channel;
        if (!channel) {
          throw new Error("host channel was not installed");
        }
        return channel.send("ping", { message: "from tab B" });
      }),
    ]);

    expect(replyA).toEqual({ reply: "background saw from tab A" });
    expect(replyB).toEqual({ reply: "background saw from tab B" });

    const extensionId = await extensionIdFor(context);

    const popup = await context.newPage();
    popup.setDefaultTimeout(90_000);
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForFunction(() => window.__popupReady === true, undefined, { timeout: 60_000 });

    const sidePanel = await context.newPage();
    sidePanel.setDefaultTimeout(90_000);
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await sidePanel.waitForFunction(() => window.__sidePanelReady === true, undefined, { timeout: 60_000 });

    const [popupReply, sidePanelReply] = await Promise.all([
      pageA.evaluate(async () => {
        const channel = window.__channel;
        if (!channel) {
          throw new Error("host channel was not installed");
        }
        return channel.send("ping", { message: "hello popup", to: "popup" });
      }),
      pageB.evaluate(async () => {
        const channel = window.__channel;
        if (!channel) {
          throw new Error("host channel was not installed");
        }
        return channel.send("ping", { message: "hello sidepanel", to: "sidepanel" });
      }),
    ]);

    expect(popupReply).toEqual({ reply: "popup saw hello popup" });
    expect(sidePanelReply).toEqual({ reply: "sidepanel saw hello sidepanel" });
  },
  90_000,
);

test(
  "popup and side panel reach host through the background hub",
  async () => {
    context = await launchExtensionContext();
    const extensionId = await extensionIdFor(context);
    await openHostPage(context);

    const popup = await context.newPage();
    popup.setDefaultTimeout(90_000);
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForFunction(
      () => window.__popupReady === true && window.__popupLastReply != null,
      undefined,
      { timeout: 60_000 },
    );
    expect(await popup.evaluate(() => window.__popupLastReply)).toEqual({
      reply: "host saw from popup",
    });

    const sidePanel = await context.newPage();
    sidePanel.setDefaultTimeout(90_000);
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await sidePanel.waitForFunction(
      () => window.__sidePanelReady === true && window.__sidePanelLastReply != null,
      undefined,
      { timeout: 60_000 },
    );
    expect(await sidePanel.evaluate(() => window.__sidePanelLastReply)).toEqual({
      reply: "host saw from side panel",
    });
  },
  90_000,
);

test(
  "two side panels each receive only their own host message",
  async () => {
    context = await launchExtensionContext();
    const extensionId = await extensionIdFor(context);

    if (context.serviceWorkers().length === 0) {
      await context.waitForEvent("serviceworker", { timeout: 15_000 });
    }

    const pageA = await openHostPage(context);
    const pageB = await openHostPage(context);

    async function openSidePanel(): Promise<Page> {
      const sidePanel = await context!.newPage();
      sidePanel.setDefaultTimeout(90_000);
      await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await sidePanel.waitForFunction(() => window.__sidePanelReady === true, undefined, {
        timeout: 60_000,
      });
      return sidePanel;
    }

    /*
     * Connect A first, then B. The hub keeps the two channels and routes
     * by host tab.
     */
    const sidePanelA = await openSidePanel();
    const sidePanelB = await openSidePanel();

    const [replyA, replyB] = await Promise.all([
      pageA.evaluate(async () => {
        const channel = window.__channel;
        if (!channel) {
          throw new Error("host channel was not installed");
        }
        return channel.send("ping", { message: "from tab A", to: "sidepanel" });
      }),
      pageB.evaluate(async () => {
        const channel = window.__channel;
        if (!channel) {
          throw new Error("host channel was not installed");
        }
        return channel.send("ping", { message: "from tab B", to: "sidepanel" });
      }),
    ]);

    expect(replyA).toEqual({ reply: "sidepanel saw from tab A" });
    expect(replyB).toEqual({ reply: "sidepanel saw from tab B" });

    expect({
      receivedA: await sidePanelA.evaluate(() => window.__sidePanelReceived ?? []),
      receivedB: await sidePanelB.evaluate(() => window.__sidePanelReceived ?? []),
    }).toEqual({
      receivedA: ["from tab A"],
      receivedB: ["from tab B"],
    });
  },
  90_000,
);
