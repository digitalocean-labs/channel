import { z } from "zod";
import { ChannelDefinition } from "../channel.js";

export const workerDefinition = new ChannelDefinition({
  greet: {
    requestSchema: z.object({ name: z.string() }),
    responseSchema: z.object({ greeting: z.string() }),
  },
  report: {
    requestSchema: z.object({ from: z.string() }),
    responseSchema: z.object({ received: z.boolean() }),
  },
});
