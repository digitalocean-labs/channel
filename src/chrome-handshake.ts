import type { Channel } from "./channel.js";
import { Port } from "./port.js";

type ContentBackgroundConnectInfo = Omit<chrome.runtime.ConnectInfo, "name">;

type ExtensionPageConnectInfo<ExtensionPage extends string> = ContentBackgroundConnectInfo & {
  page: ExtensionPage;
};

export type ChromeHandshakeOptions = {
  /**
   * The namespace for handshake messages and `chrome.runtime` connect
   * names. The handshake derives these names from the namespace:
   * `${namespace}/host-ready`, `${namespace}/extension-port`,
   * `${namespace}/background-ready`, `${namespace}/host-bridge`,
   * `${namespace}/extension-page/<page>`. The host, the content script,
   * the background, and the extension pages must use the same namespace.
   */
  namespace: string;
  /**
   * The maximum wait time for the host and for the content script.
   *
   * @default 60_000
   */
  timeoutMs?: number;
  /**
   * The interval between host pulses while the host waits for the
   * extension port.
   *
   * @default 20
   */
  pulseMs?: number;
  /**
   * The delay before the handshake tries chrome.runtime.connect again.
   *
   * @default 200
   */
  retryMs?: number;
  /**
   * The maximum number of chrome.runtime.connect attempts before the
   * promise rejects.
   *
   * @default 300
   */
  maxAttempts?: number;
};

export type ContentBridge = {
  host: Port<MessagePort>;
  background: Port<chrome.runtime.Port>;
};

/**
 * Background `chrome.runtime.onConnect` handlers for
 * {@link ChromeHandshake.onConnect}. Each key gives the *source* of the
 * connect.
 */
export type ChromeHandshakeOnConnectHandlers<
  ExtensionPage extends string,
  HostChannel extends Channel<any>,
  PageChannel extends Channel<any>,
> = {
  fromHostBridge?: (
    port: Port<chrome.runtime.Port>,
    forward: (page: ExtensionPage) => Promise<PageChannel>,
  ) => HostChannel;
  fromExtensionPage?: (
    port: Port<chrome.runtime.Port>,
    page: ExtensionPage,
    forward: (tabId?: number) => Promise<HostChannel>,
  ) => PageChannel;
};

type ExtensionPageEntry<PageChannel> = {
  channel: PageChannel;
  /** The host tab that holds this instance, after a claim through the host `forward`. The bond does not change. */
  tabId?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PULSE_MS = 20;
const DEFAULT_RETRY_MS = 200;
const DEFAULT_MAX_ATTEMPTS = 300;

/**
 * Makes the transports below a chrome-extension channel:
 * host page ↔ content script (a MessagePort through window.postMessage),
 * and content script / extension pages ↔ background (a chrome.runtime.Port
 * with an acknowledgement that is safe for MV3).
 *
 * Returns {@link Port}s that are ready for {@link ChannelDefinition.connect}
 * and {@link ChannelDefinition.relay}. Each call is independent: each
 * public method starts a new attempt. Method names have a role prefix:
 * `host*`, `content*`, `background*`, `extensionPage*`.
 *
 * @typeParam ExtensionPage - Optional string-literal union of extension
 *   page ids (`"popup" | "sidepanel"`, etc.). The default is `string`.
 */
export class ChromeHandshake<ExtensionPage extends string = string> {
  readonly #hostReadySource: string;
  readonly #extensionPortSource: string;
  readonly #backgroundReadyType: string;
  readonly #hostBridgeName: string;
  readonly #extensionPageName: string;
  readonly #timeoutMs: number;
  readonly #pulseMs: number;
  readonly #retryMs: number;
  readonly #maxAttempts: number;

  constructor(options: ChromeHandshakeOptions) {
    const {
      namespace,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      pulseMs = DEFAULT_PULSE_MS,
      retryMs = DEFAULT_RETRY_MS,
      maxAttempts = DEFAULT_MAX_ATTEMPTS,
    } = options;

    this.#hostReadySource = `${namespace}/host-ready`;
    this.#extensionPortSource = `${namespace}/extension-port`;
    this.#backgroundReadyType = `${namespace}/background-ready`;
    this.#hostBridgeName = `${namespace}/host-bridge`;
    this.#extensionPageName = `${namespace}/extension-page`;
    this.#timeoutMs = timeoutMs;
    this.#pulseMs = pulseMs;
    this.#retryMs = retryMs;
    this.#maxAttempts = maxAttempts;
  }

  /** Host page: sends pulses until the content script transfers a MessagePort. */
  async hostPort(): Promise<Port<MessagePort>> {
    const messagePort = await this.#waitForContentPort();
    return Port.fromMessagePort(messagePort);
  }

  /**
   * Content script: connects to the host and to the background in
   * parallel. Returns Ports that are ready for a relay. Uses the connect
   * name `${namespace}/host-bridge`. Tries chrome.runtime.connect again
   * until the background sends the ready acknowledgement. This procedure
   * covers the MV3 race in which connect wakes the worker before the
   * worker registers onConnect.
   */
  async contentBackgroundBridge(connectInfo?: ContentBackgroundConnectInfo): Promise<ContentBridge> {
    const [hostPort, chromePort] = await Promise.all([
      this.#connectToHost(),
      this.#connectToBackground({
        includeTlsChannelId: true,
        ...connectInfo,
        name: this.#hostBridgeName,
      }),
    ]);

    return {
      host: Port.fromMessagePort(hostPort),
      background: Port.fromChromeRuntimePort(chromePort),
    };
  }

  /**
   * Extension page (popup, side panel, options, etc.): connects to the
   * background hub with chrome.runtime.connect, and tries again until the
   * ready acknowledgement arrives. Uses the connect name
   * `${namespace}/extension-page/${page}`.
   */
  async extensionPagePort(connectInfo: ExtensionPageConnectInfo<ExtensionPage>): Promise<Port<chrome.runtime.Port>> {
    const { page, ...rest } = connectInfo;

    const chromePort = await this.#connectToBackground({
      includeTlsChannelId: true,
      ...rest,
      name: `${this.#extensionPageName}/${page}`,
    });
    return Port.fromChromeRuntimePort(chromePort);
  }

  /**
   * Background: posts the ready acknowledgement on an accepted
   * chrome.runtime.Port and returns a wrapped {@link Port}. Call this
   * method from the onConnect handler, after the classic service-worker
   * entry has registered the listener.
   */
  backgroundAccept(chromePort: chrome.runtime.Port): Port<chrome.runtime.Port> {
    chromePort.postMessage({ type: this.#backgroundReadyType });
    return Port.fromChromeRuntimePort(chromePort);
  }

  /** Gives true when `port.name` is the content↔background bridge of this handshake. */
  isHostBridgePort(port: chrome.runtime.Port): boolean {
    return port.name === this.#hostBridgeName;
  }

  /** Gives true when `port.name` is an extension-page connect for this handshake. */
  isExtensionPagePort(port: chrome.runtime.Port): boolean {
    return port.name === this.#extensionPageName || port.name.startsWith(`${this.#extensionPageName}/`);
  }

  /**
   * Makes a `chrome.runtime.onConnect` listener that identifies ports,
   * posts the ready acknowledgement, and dispatches to the role handlers.
   * The listener keeps the returned channels in a cache and removes them
   * on disconnect. The handlers receive `forward` helpers, which connect
   * the hub in the router style.
   *
   * - `fromHostBridge` runs only when `sender.tab.id` is present.
   * - `fromExtensionPage` runs only when the connect name includes a page id.
   * - The listener ignores unknown ports and unmatched ports (no ready
   *   acknowledgement).
   */
  onConnect<HostChannel extends Channel<any>, PageChannel extends Channel<any>>(
    handlers: ChromeHandshakeOnConnectHandlers<ExtensionPage, HostChannel, PageChannel>,
  ): (chromePort: chrome.runtime.Port) => void {
    const tabs = new Map<number, HostChannel>();
    const extensionPages = new Map<ExtensionPage, ExtensionPageEntry<PageChannel>[]>();

    const forwardToPage = async (fromTabId: number, page: ExtensionPage): Promise<PageChannel> => {
      const entries = extensionPages.get(page);

      if (!entries?.length) {
        throw new Error(`no extension page "${page}"`);
      }

      const sticky = entries.find((entry) => entry.tabId === fromTabId);

      if (sticky) {
        return sticky.channel;
      }

      const hostTabIds = [...tabs.keys()].sort((a, b) => a - b);

      const index = hostTabIds.indexOf(fromTabId);

      if (index >= 0 && index < entries.length && entries[index]!.tabId == null) {
        entries[index]!.tabId = fromTabId;
        return entries[index]!.channel;
      }

      const unbound = entries.find((entry) => entry.tabId == null);
      if (unbound) {
        unbound.tabId = fromTabId;
        return unbound.channel;
      }

      if (entries.length === 1) {
        return entries[0]!.channel;
      }

      throw new Error(`could not resolve extension page "${page}" (instances=${entries.length}, fromTab=${fromTabId})`);
    };

    const forwardToTab = async (tabId?: number): Promise<HostChannel> => {
      if (tabId != null) {
        const channel = tabs.get(tabId);

        if (!channel) {
          throw new Error(`no host bridge for tab ${tabId}`);
        }

        return channel;
      }

      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (active?.id != null) {
        const channel = tabs.get(active.id);

        if (channel) {
          return channel;
        }
      }

      throw new Error(`could not resolve host bridge (tabs=${tabs.size}, active=${active?.id ?? "none"})`);
    };

    const forgetExtensionPage = (page: ExtensionPage, channel: PageChannel) => {
      const entries = extensionPages.get(page);
      if (!entries) {
        return;
      }

      const next = entries.filter((entry) => entry.channel !== channel);

      if (next.length === 0) {
        extensionPages.delete(page);
      } else {
        extensionPages.set(page, next);
      }
    };

    return (chromePort: chrome.runtime.Port) => {
      if (this.isHostBridgePort(chromePort)) {
        const tabId = chromePort.sender?.tab?.id;
        if (tabId == null || handlers.fromHostBridge == null) {
          return;
        }

        const port = this.backgroundAccept(chromePort);

        const channel = handlers.fromHostBridge(port, (page) => forwardToPage(tabId, page));

        tabs.set(tabId, channel);

        port.onClose(() => {
          tabs.delete(tabId);
        });

        return;
      }

      if (this.isExtensionPagePort(chromePort)) {
        const page = this.#extensionPage(chromePort);
        if (page == null || handlers.fromExtensionPage == null) {
          return;
        }

        const port = this.backgroundAccept(chromePort);

        const channel = handlers.fromExtensionPage(port, page, forwardToTab);

        const entries = extensionPages.get(page) ?? [];

        entries.push({ channel });
        extensionPages.set(page, entries);

        port.onClose(() => {
          forgetExtensionPage(page, channel);
        });
      }
    };
  }

  /**
   * Gives the `page` segment from an extension-page connect name. Gives
   * `undefined` if this port is not an extension-page connect, or if the
   * name has no page suffix.
   */
  #extensionPage(port: chrome.runtime.Port): ExtensionPage | undefined {
    const prefix = `${this.#extensionPageName}/`;
    if (!port.name.startsWith(prefix)) {
      return undefined;
    }
    return port.name.slice(prefix.length) as ExtensionPage;
  }

  #waitForContentPort(): Promise<MessagePort> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for extension MessagePort"));
      }, this.#timeoutMs);

      const onMessage = (event: MessageEvent<{ source?: string }>) => {
        if (event.source !== window || event.data?.source !== this.#extensionPortSource) {
          return;
        }

        const transferred = event.ports[0];

        if (!transferred) {
          return;
        }

        cleanup();
        resolve(transferred);
      };

      const pulse = setInterval(() => {
        window.postMessage({ source: this.#hostReadySource }, "*");
      }, this.#pulseMs);

      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(pulse);
        window.removeEventListener("message", onMessage);
      };

      window.addEventListener("message", onMessage);
      window.postMessage({ source: this.#hostReadySource }, "*");
    });
  }

  async #connectToHost(): Promise<MessagePort> {
    await this.#waitForHostReady();

    const { port1, port2 } = new MessageChannel();

    window.postMessage({ source: this.#extensionPortSource }, "*", [port1]);

    return port2;
  }

  #connectToBackground(connectInfo: chrome.runtime.ConnectInfo): Promise<chrome.runtime.Port> {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      let settled = false;

      const tryConnect = () => {
        attempts += 1;
        if (attempts > this.#maxAttempts) {
          settled = true;
          reject(new Error("Timed out waiting for background onConnect"));
          return;
        }

        const chromePort = chrome.runtime.connect(connectInfo);

        const timer = setTimeout(() => {
          chromePort.disconnect();
          tryConnect();
        }, this.#retryMs);

        chromePort.onMessage.addListener((message: { type?: string }) => {
          if (settled || message?.type !== this.#backgroundReadyType) {
            return;
          }

          settled = true;
          clearTimeout(timer);
          resolve(chromePort);
        });
      };

      tryConnect();
    });
  }

  #waitForHostReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for host ready"));
      }, this.#timeoutMs);

      const onMessage = (event: MessageEvent<{ source?: string }>) => {
        if (event.source !== window || event.data?.source !== this.#hostReadySource) {
          return;
        }

        cleanup();
        resolve();
      };

      const cleanup = () => {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
      };

      window.addEventListener("message", onMessage);
    });
  }
}
