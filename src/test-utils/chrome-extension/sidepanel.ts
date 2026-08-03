import { definition } from "./events.js";
import { handshake } from "./handshake.js";
import { hostTabId } from "./host-tab.js";

declare global {
  interface Window {
    __sidePanelChannel?: ReturnType<typeof definition.connect>;
    __sidePanelReady?: boolean;
    __sidePanelLastReply?: { reply: string };
    /** Host→sidepanel pings that this instance received (for multi-instance tests). */
    __sidePanelReceived?: string[];
  }
}

/**
 * Side panel extension page: uses the same hub path as the popup, through
 * extensionPagePort. Resolves ping, so host tabs can reach this side
 * panel.
 */
async function main() {
  const received: string[] = [];
  window.__sidePanelReceived = received;

  const port = await handshake.extensionPagePort({ page: "sidepanel" });
  const channel = definition.connect({
    port,
    resolvers: {
      ping: (payload, respond) => {
        received.push(payload.message);
        respond({ reply: `sidepanel saw ${payload.message}` });
      },
    },
  });

  window.__sidePanelChannel = channel;
  window.__sidePanelReady = true;

  const reply = await channel.send("ping", {
    message: "from side panel",
    tabId: await hostTabId(),
  });
  window.__sidePanelLastReply = reply;

  const status = document.querySelector("#status");
  if (status) {
    status.textContent = reply.reply;
  }
}

void main().catch((error: unknown) => {
  console.error("[sidepanel] failed", error);
  const status = document.querySelector("#status");
  if (status) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
});
