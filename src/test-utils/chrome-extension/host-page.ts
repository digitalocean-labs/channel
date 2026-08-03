import { definition } from "./events.js";
import { handshake } from "./handshake.js";

declare global {
  interface Window {
    __channel?: ReturnType<typeof definition.connect>;
    __channelReady?: boolean;
  }
}

/**
 * Signals the content script, receives a transferred MessagePort, and
 * exposes a connected channel. The Playwright test controls the channel
 * with page.evaluate. Resolves ping, so the background hub can forward
 * popup traffic to this page.
 */
async function main() {
  const port = await handshake.hostPort();

  const channel = definition.connect({
    port,
    resolvers: {
      ping: (payload, respond) => {
        respond({ reply: `host saw ${payload.message}` });
      },
    },
  });

  window.__channel = channel;
  window.__channelReady = true;
}

void main();
