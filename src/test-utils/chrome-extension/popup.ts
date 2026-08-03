import { definition } from "./events.js";
import { handshake } from "./handshake.js";
import { hostTabId } from "./host-tab.js";

declare global {
  interface Window {
    __popupChannel?: ReturnType<typeof definition.connect>;
    __popupReady?: boolean;
    __popupLastReply?: { reply: string };
  }
}

/**
 * Connects to the background hub and sends a ping that the hub forwards
 * to the host page. Also resolves ping, so host tabs can reach this
 * popup.
 */
async function main() {
  const port = await handshake.extensionPagePort({ page: "popup" });
  const channel = definition.connect({
    port,
    resolvers: {
      ping: (payload, respond) => {
        respond({ reply: `popup saw ${payload.message}` });
      },
    },
  });

  window.__popupChannel = channel;
  window.__popupReady = true;

  const reply = await channel.send("ping", {
    message: "from popup",
    tabId: await hostTabId(),
  });
  window.__popupLastReply = reply;

  const status = document.querySelector("#status");
  if (status) {
    status.textContent = reply.reply;
  }
}

void main().catch((error: unknown) => {
  console.error("[popup] failed", error);
  const status = document.querySelector("#status");
  if (status) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
});
