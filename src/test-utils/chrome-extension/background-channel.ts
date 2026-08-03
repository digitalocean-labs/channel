import type { Channel } from "../../channel.js";
import { definition } from "./events.js";
import { handshake } from "./handshake.js";

type HubChannel = Channel.infer<typeof definition>;

/**
 * Background hub: host bridges and extension pages connect here. The
 * resolvers answer locally or `forward` to the other role.
 *
 * background.ts loads this file with importScripts after background.ts
 * registers onConnect.
 */
export const onConnect = handshake.onConnect<HubChannel, HubChannel>({
  fromHostBridge(port, forward) {
    return definition.connect({
      port,
      resolvers: {
        ping: (payload, respond) => {
          if (payload.to) {
            const page = payload.to;

            forward(page)
              .then((channel) => channel.send("ping", { message: payload.message }))
              .then((reply) => respond(reply))
              .catch((error: unknown) => {
                console.error("[background] host → extension page ping failed", error);
                respond({
                  reply: `hub error: ${error instanceof Error ? error.message : String(error)}`,
                });
              });
            return;
          }

          respond({ reply: `background saw ${payload.message}` });
        },
      },
    });
  },
  fromExtensionPage(port, _page, forward) {
    return definition.connect({
      port,
      resolvers: {
        ping: (payload, respond) => {
          void forward(payload.tabId)
            .then((tabChannel) => tabChannel.send("ping", { message: payload.message }))
            .then((reply) => respond(reply))
            .catch((error: unknown) => {
              console.error("[background] extension page → host ping failed", error);
              respond({
                reply: `hub error: ${error instanceof Error ? error.message : String(error)}`,
              });
            });
        },
      },
    });
  },
});
