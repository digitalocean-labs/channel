import { z } from "zod";
import { ChannelDefinition, Port } from "../main.js";

/**
 * This definition is the same as the `ping` event in channel.test.ts.
 * Thus the worker-side relay validates the same wire shape while the
 * relay forwards across the MessagePort / WebSocket boundary.
 */
const definition = new ChannelDefinition({
  ping: {
    requestSchema: z.object({ message: z.string() }),
    responseSchema: z.object({ reply: z.string() }),
  },
});

addEventListener("message", (event: MessageEvent<{ port: MessagePort; url: string }>) => {
  const { port, url } = event.data;
  const socket = new WebSocket(url);

  const onOpen = () => {
    definition.relay(Port.fromMessagePort(port), Port.fromWebSocket(socket));
  };

  if (socket.readyState === WebSocket.OPEN) {
    onOpen();
  } else {
    socket.addEventListener("open", onOpen, { once: true });
  }
});
