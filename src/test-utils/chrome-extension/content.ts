import { definition } from "./events.js";
import { handshake } from "./handshake.js";

/**
 * Bridges the MessagePort of the host page onto chrome.runtime.connect
 * (host-bridge). Tries again until the background acknowledges. This
 * covers the MV3 race in which connect wakes the worker before the worker
 * registers onConnect.
 */
void (async () => {
  try {
    const { host, background } = await handshake.contentBackgroundBridge();
    definition.relay(host, background);
  } catch (error) {
    console.error("[content] failed to bridge to background", error);
  }
})();
