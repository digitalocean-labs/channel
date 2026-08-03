import { z } from "zod";
import { ChannelDefinition } from "../../main.js";

/** The host page, the content relay, the background hub, and the extension pages share this definition. */
export const definition = new ChannelDefinition({
  ping: {
    requestSchema: z.object({
      message: z.string(),
      /** When this field is set on a host→background ping, the hub forwards the ping to that extension page. */
      to: z.enum(["popup", "sidepanel"]).optional(),
      /** When this field is set on an extension-page→background ping, the hub forwards the ping to that host tab. */
      tabId: z.number().int().optional(),
    }),
    responseSchema: z.object({ reply: z.string() }),
  },
});
