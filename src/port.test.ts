import { describe, expect, inject, test, vi } from "vitest";
import { z } from "zod";
import { ChannelDefinition } from "./channel.js";
import { Port } from "./port.js";

const events = {
  ping: {
    requestSchema: z.object({ message: z.string() }),
    responseSchema: z.object({ reply: z.string() }),
  },
};

describe("transport lifecycle (stop)", () => {
  test("fromMessagePort: stop() closes the underlying MessagePort", () => {
    const { port1 } = new MessageChannel();
    const close = vi.spyOn(port1, "close");

    Port.fromMessagePort(port1).stop();

    expect(close).toHaveBeenCalledTimes(1);
  });

  test("fromBroadcastChannel: stop() closes the underlying channel", () => {
    const broadcastChannel = new BroadcastChannel(crypto.randomUUID());
    const close = vi.spyOn(broadcastChannel, "close");

    Port.fromBroadcastChannel(broadcastChannel).stop();

    expect(close).toHaveBeenCalledTimes(1);
  });

  test("fromChromeRuntimePort: stop() disconnects the chrome port", () => {
    const disconnect = vi.fn();
    const fakeChromePort = {
      postMessage: vi.fn(),
      disconnect,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
    } as unknown as chrome.runtime.Port;

    Port.fromChromeRuntimePort(fakeChromePort).stop();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  test("fromWebSocket: disconnecting the channel closes the socket", async () => {
    const socket = new WebSocket(`ws://localhost:${inject("wsServerPort")}/${crypto.randomUUID()}`);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true });
    });

    const channel = new ChannelDefinition(events).connect({
      port: Port.fromWebSocket(socket),
    });

    channel.disconnect();

    expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(socket.readyState);
    await new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
  });
});
