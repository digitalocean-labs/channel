import { afterEach, describe, expect, inject, test, vi } from "vitest";
import { z } from "zod";
import { ChannelDefinition, type ChannelEventMap, type ResolverMap } from "./channel.js";
import { Port } from "./port.js";
import { workerDefinition } from "./test-utils/worker-events.js";

const events = {
  ping: {
    requestSchema: z.object({ message: z.string() }),
    responseSchema: z.object({ reply: z.string() }),
  },
  noRequest: {
    responseSchema: z.object({ success: z.boolean() }),
  },
  noResponse: {
    requestSchema: z.object({ message: z.string() }),
  },
  transformed: {
    requestSchema: z.object({
      yes: z.boolean().transform((value) => (value ? "yes" : "no")),
    }),
    responseSchema: z.object({
      count: z.string().transform((value) => value.length),
    }),
  },
} satisfies ChannelEventMap;

type Inbox = {
  /** Messages that arrived but that `next()` has not consumed. */
  messages: unknown[];
  next(): Promise<any>;
};

/**
 * Starts the port and records each message that arrives. Thus the test
 * loses no messages before the test awaits them.
 */
function createInbox(port: Port<any>): Inbox {
  const messages: unknown[] = [];
  const waiters: ((message: unknown) => void)[] = [];

  port.addListener((message) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message.data);
    } else {
      messages.push(message.data);
    }
  });
  port.start();

  return {
    messages,
    next() {
      if (messages.length > 0) {
        return Promise.resolve(messages.shift());
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/**
 * A Channel around one end of a memory port pair. The harness exposes the
 * peer port. Thus tests can examine outbound messages and can inject
 * arbitrary inbound messages.
 */
function createHarness<T extends ChannelEventMap>(
  channelEvents: T,
  options: {
    resolvers?: ResolverMap<T>;
    strategy?: "throw" | "warn" | "ignore";
    maxMapSize?: number;
    signal?: AbortSignal;
    responseTimeoutMs?: number;
  } = {},
) {
  const { port1, port2 } = Port.memory();
  const definition = new ChannelDefinition(channelEvents);
  const channel = definition.connect({ port: port1, ...options });
  const inbox = createInbox(port2);
  return { channel, peer: port2, inbox };
}

/**
 * One side of a memory port pair, with a tap on its listener registry.
 * Thus tests can call the listener of the channel directly and can catch
 * its synchronous throws. A real MessagePort dispatches asynchronously,
 * so its throws show as uncaught errors and do not reach the test.
 */
function createTappedPort() {
  const { port1 } = Port.memory();
  const listeners = new Set<(message: { data: unknown }) => void>();

  const addListener = port1.addListener;
  const removeListener = port1.removeListener;

  vi.spyOn(port1, "addListener").mockImplementation((listener) => {
    listeners.add(listener);
    addListener(listener);
  });
  vi.spyOn(port1, "removeListener").mockImplementation((listener) => {
    listeners.delete(listener);
    removeListener(listener);
  });

  return {
    port: port1,
    listeners,
    dispatch(message: unknown): void {
      const [listener] = listeners;
      if (!listener) {
        throw new Error("no listener registered");
      }
      listener({ data: message });
    },
  };
}

function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectPending(promise: Promise<unknown>, ms = 30) {
  const sentinel = Symbol("pending");
  const result = await Promise.race([promise, settle(ms).then(() => sentinel)]);
  expect(result).toBe(sentinel);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("lifecycle", () => {
  test("send() after disconnect() throws", () => {
    const { channel } = createHarness(events);
    channel.disconnect();
    expect(() => channel.send("ping", { message: "hi" })).toThrow("Channel is disconnected");
  });

  test("disconnect() is idempotent: the port is stopped once", () => {
    const { port1 } = Port.memory();
    const stop = vi.spyOn(port1, "stop");
    const channel = new ChannelDefinition(events).connect({ port: port1 });

    channel.disconnect();
    channel.disconnect();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("a definition can connect again with a fresh port after disconnect()", async () => {
    const definition = new ChannelDefinition(events);

    const stale = definition.connect({ port: Port.memory().port1 });
    stale.disconnect();

    const { port1, port2 } = Port.memory();
    const channel = definition.connect({ port: port1 });
    definition.connect({
      port: port2,
      resolvers: {
        ping: (payload, respond) => respond({ reply: `saw ${payload.message}` }),
      },
    });

    await expect(channel.send("ping", { message: "again" })).resolves.toEqual({
      reply: "saw again",
    });
  });

  test("connect() with an already-aborted signal throws", () => {
    const definition = new ChannelDefinition(events);
    const controller = new AbortController();
    controller.abort();

    expect(() =>
      definition.connect({
        port: Port.memory().port1,
        signal: controller.signal,
      }),
    ).toThrow();
  });

  test("aborting the signal disconnects the channel", () => {
    const { port1 } = Port.memory();
    const stop = vi.spyOn(port1, "stop");
    const controller = new AbortController();
    const channel = new ChannelDefinition(events).connect({
      port: port1,
      signal: controller.signal,
    });

    controller.abort();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(() => channel.send("ping", { message: "hi" })).toThrow("Channel is disconnected");
  });

  test("messages from the peer after disconnect() are never dispatched", async () => {
    const resolver = vi.fn();
    const { channel, peer } = createHarness(events, {
      resolvers: { ping: resolver },
    });
    channel.disconnect();

    peer.postMessage({ data: { id: "req-1", type: "ping", payload: { message: "hi" } } });
    await settle();

    expect(resolver).not.toHaveBeenCalled();
  });

  test("a late response after disconnect() does not resolve the pending send()", async () => {
    const { channel, peer, inbox } = createHarness(events);

    const promise = channel.send("ping", { message: "hi" });
    const sent = await inbox.next();

    channel.disconnect();
    peer.postMessage({ data: { id: sent.id, type: "ping", payload: { reply: "late" } } });

    await expectPending(promise);
  });
});

describe("send()", () => {
  test("posts { id, type, payload } with distinct string ids", async () => {
    const { channel, inbox } = createHarness(events);

    void channel.send("ping", { message: "one" });
    void channel.send("ping", { message: "two" });

    const first = await inbox.next();
    const second = await inbox.next();

    expect(first).toEqual({
      id: expect.any(String),
      type: "ping",
      payload: { message: "one" },
    });
    expect(second.payload).toEqual({ message: "two" });
    expect(second.id).not.toBe(first.id);
  });

  test("invalid request payload throws and posts nothing", async () => {
    const { channel, inbox } = createHarness(events);

    expect(() => channel.send("ping", { message: 3 as unknown as string })).toThrow(/Invalid input/);

    await settle();
    expect(inbox.messages).toHaveLength(0);
  });

  test("request transform is applied to the posted payload", async () => {
    const { channel, inbox } = createHarness(events);

    void channel.send("transformed", { yes: true });

    const sent = await inbox.next();
    expect(sent.payload).toEqual({ yes: "yes" });
  });

  test("event with no request schema posts payload: undefined", async () => {
    const { channel, inbox } = createHarness(events);

    void channel.send("noRequest");

    const sent = await inbox.next();
    expect(sent.type).toBe("noRequest");
    expect(sent.payload).toBeUndefined();
  });

  test("unknown event type throws", () => {
    const { channel } = createHarness({});

    expect(() => (channel as any).send("missing")).toThrow("Handler for type missing not found");
  });

  test("an event with no response schema returns void and posts the payload", async () => {
    const { channel, inbox } = createHarness(events, { responseTimeoutMs: 20 });

    const result = channel.send("noResponse", { message: "hi" });
    expect(result).toBeUndefined();

    const sent = await inbox.next();
    expect(sent.payload).toEqual({ message: "hi" });

    /*
     * Wait until after the connection timeout. The channel set no timer,
     * so nothing rejects. An unhandled rejection causes the run to fail.
     */
    await settle(50);
  });

  test("an event with no response schema stores no pending entry: an echo is a new request", async () => {
    const resolver = vi.fn();
    const { channel, peer, inbox } = createHarness(events, {
      resolvers: { noResponse: resolver },
    });

    channel.send("noResponse", { message: "hi" });
    const sent = await inbox.next();

    /*
     * The channel dispatches a message that returns the id as an inbound
     * request. The channel does not match the message to the send above.
     */
    peer.postMessage({ data: { id: sent.id, type: "noResponse", payload: { message: "echo" } } });
    await settle();

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0]![0]).toEqual({ message: "echo" });
  });

  test("a response resolves the promise once; the same id is then treated as a request", async () => {
    const resolver = vi.fn();
    const { channel, peer, inbox } = createHarness(events, {
      resolvers: { ping: resolver },
    });

    const promise = channel.send("ping", { message: "hi" });
    const sent = await inbox.next();

    peer.postMessage({ data: { id: sent.id, type: "ping", payload: { reply: "pong" } } });
    await expect(promise).resolves.toEqual({ reply: "pong" });

    /*
     * The channel deleted the pending entry. Thus a second message with
     * the same id resolves nothing and goes to the resolver.
     */
    peer.postMessage({ data: { id: sent.id, type: "ping", payload: { reply: "pong" } } });
    await settle();

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0]![0]).toEqual({ reply: "pong" });
  });
});

describe("responseTimeoutMs", () => {
  test("the default timeout is 60 seconds", () => {
    expect(ChannelDefinition.DEFAULT_RESPONSE_TIMEOUT_MS).toBe(60_000);
  });

  test("send() rejects after the connection-level timeout when nothing replies", async () => {
    const { channel } = createHarness(events, { responseTimeoutMs: 20 });

    await expect(channel.send("ping", { message: "hi" })).rejects.toThrow(
      'Timed out waiting for a response to "ping" after 20ms',
    );
  });

  test("a per-send responseTimeoutMs overrides the connection value", async () => {
    const { channel } = createHarness(events, { responseTimeoutMs: 10_000 });

    await expect(channel.send("ping", { message: "hi" }, { responseTimeoutMs: 20 })).rejects.toThrow(
      'Timed out waiting for a response to "ping" after 20ms',
    );
  });

  test("a per-send responseTimeoutMs can outlive a short connection value", async () => {
    const { channel } = createHarness(events, { responseTimeoutMs: 20 });

    const promise = channel.send("ping", { message: "hi" }, { responseTimeoutMs: 10_000 });

    await expectPending(promise, 60);
  });

  test("a response that arrives in time resolves and cancels the timer", async () => {
    const { channel, peer, inbox } = createHarness(events, { responseTimeoutMs: 30 });

    const promise = channel.send("ping", { message: "hi" });
    const sent = await inbox.next();
    peer.postMessage({ data: { id: sent.id, type: "ping", payload: { reply: "pong" } } });

    await expect(promise).resolves.toEqual({ reply: "pong" });

    /*
     * Wait until after the timeout. If a stale timer stays, the timer
     * rejects the settled promise. The unhandled rejection then causes
     * the run to fail.
     */
    await settle(50);
  });

  test("for events with no request schema, options are the first argument and are not posted", async () => {
    const { channel, inbox } = createHarness(events);

    const promise = channel.send("noRequest", { responseTimeoutMs: 20 });

    const sent = await inbox.next();
    expect(sent.payload).toBeUndefined();

    await expect(promise).rejects.toThrow('Timed out waiting for a response to "noRequest" after 20ms');
  });
});

describe("inbound dispatch and respond()", () => {
  test("an inbound request invokes the matching resolver with the parsed payload", async () => {
    const resolver = vi.fn();
    const { peer } = createHarness(events, {
      resolvers: { ping: resolver },
    });

    peer.postMessage({ data: { id: "req-1", type: "ping", payload: { message: "hi" } } });
    await settle();

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0]![0]).toEqual({ message: "hi" });
  });

  test("a valid request with no registered resolver is silently dropped", async () => {
    const { peer, inbox } = createHarness(events);

    peer.postMessage({ data: { id: "req-1", type: "ping", payload: { message: "hi" } } });
    await settle();

    expect(inbox.messages).toHaveLength(0);
  });

  test("respond() throws for events with no response schema", () => {
    const tapped = createTappedPort();
    let caught: unknown = null;

    new ChannelDefinition(events).connect({
      port: tapped.port,
      resolvers: {
        /*
         * The cast goes around the types, which already omit `respond`
         * for events without a responseSchema. This tests the runtime
         * guard.
         */
        noResponse: ((_payload: unknown, respond: (input: unknown) => void) => {
          try {
            respond(undefined);
          } catch (error) {
            caught = error;
          }
        }) as never,
      },
    });

    tapped.dispatch({ id: "req-1", type: "noResponse", payload: { message: "hi" } });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('Event "noResponse" has no responseSchema');
  });

  test("respond() posts the response with the request id and applies transforms", async () => {
    const resolver = vi.fn((payload: { yes: "yes" | "no" }, respond) => {
      expect(payload).toEqual({ yes: "yes" });
      respond({ count: "abc" });
    });
    const { peer, inbox } = createHarness(events, {
      resolvers: { transformed: resolver },
    });

    peer.postMessage({
      data: { id: "req-42", type: "transformed", payload: { yes: true } },
    });

    const response = await inbox.next();
    expect(response).toEqual({
      id: "req-42",
      type: "transformed",
      payload: { count: 3 },
    });
  });

  test("respond() with an invalid payload throws and posts nothing", async () => {
    let caught: unknown;
    const { peer, inbox } = createHarness(events, {
      resolvers: {
        ping: (_payload, respond) => {
          try {
            respond({ reply: 99 as unknown as string });
          } catch (error) {
            caught = error;
          }
        },
      },
    });

    peer.postMessage({ data: { id: "req-1", type: "ping", payload: { message: "hi" } } });
    await settle();

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Invalid input/);
    expect(inbox.messages).toHaveLength(0);
  });

  test("a message whose type has no handler throws (empty events, z.any schema)", () => {
    const tapped = createTappedPort();
    new ChannelDefinition({}).connect({ port: tapped.port });

    expect(() => tapped.dispatch({ id: "req-1", type: "missing", payload: null })).toThrow(
      "Handler for type missing not found",
    );
  });
});

describe("invalid-message strategies", () => {
  const malformed = { id: "req-1", type: "nonsense", payload: {} };

  test('"throw" (default): the handler throws the pretty error with a cause', () => {
    const tapped = createTappedPort();
    new ChannelDefinition(events).connect({ port: tapped.port });

    let error: unknown = null;
    try {
      tapped.dispatch(malformed);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Invalid discriminator value/);
    expect((error as Error).cause).toBeInstanceOf(z.ZodError);
  });

  test('"warn": console.warn is called once and nothing is dispatched', async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolver = vi.fn();
    const { peer } = createHarness(events, {
      strategy: "warn",
      resolvers: { ping: resolver },
    });

    peer.postMessage({ data: malformed });
    await settle();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(resolver).not.toHaveBeenCalled();
  });

  test('"ignore": no warning and nothing is dispatched', async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolver = vi.fn();
    const { peer } = createHarness(events, {
      strategy: "ignore",
      resolvers: { ping: resolver },
    });

    peer.postMessage({ data: malformed });
    await settle();

    expect(warn).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });

  test("disconnect() removes the exact listener that connect() added", () => {
    const tapped = createTappedPort();
    const channel = new ChannelDefinition(events).connect({
      port: tapped.port,
    });

    expect(tapped.listeners.size).toBe(1);

    channel.disconnect();
    expect(tapped.listeners.size).toBe(0);
  });
});

describe("maxMapSize / resolver eviction", () => {
  test("maxMapSize <= 0 throws at connect()", () => {
    const definition = new ChannelDefinition(events);

    expect(() => definition.connect({ port: Port.memory().port1, maxMapSize: 0 })).toThrow(
      "maxSize must be greater than 0",
    );
    expect(() => definition.connect({ port: Port.memory().port1, maxMapSize: -5 })).toThrow(
      "maxSize must be greater than 0",
    );
  });

  test("oldest pending resolver is evicted when maxMapSize is exceeded", async () => {
    const resolver = vi.fn();
    const { channel, peer, inbox } = createHarness(events, {
      maxMapSize: 1,
      resolvers: { ping: resolver },
    });

    const first = channel.send("ping", { message: "one" });
    const second = channel.send("ping", { message: "two" });

    const firstSent = await inbox.next();
    const secondSent = await inbox.next();

    peer.postMessage({
      data: { id: firstSent.id, type: "ping", payload: { reply: "first" } },
    });
    peer.postMessage({
      data: { id: secondSent.id, type: "ping", payload: { reply: "second" } },
    });

    /*
     * The map still holds the second send, and the second send resolves normally.
     */
    await expect(second).resolves.toEqual({ reply: "second" });

    /*
     * The map removed the first pending entry. Its promise stays pending,
     * and the channel sent the response to the resolver as a request.
     */
    await expectPending(first);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0]![0]).toEqual({ reply: "first" });
  });
});

describe("memory port integration", () => {
  test("full round trip in both directions", async () => {
    const { port1, port2 } = Port.memory();
    const definition = new ChannelDefinition(events);

    const a = definition.connect({
      port: port1,
      resolvers: {
        ping: (payload, respond) => respond({ reply: `a saw ${payload.message}` }),
      },
    });
    const b = definition.connect({
      port: port2,
      resolvers: {
        ping: (payload, respond) => respond({ reply: `b saw ${payload.message}` }),
      },
    });

    await expect(a.send("ping", { message: "from a" })).resolves.toEqual({
      reply: "b saw from a",
    });
    await expect(b.send("ping", { message: "from b" })).resolves.toEqual({
      reply: "a saw from b",
    });
  });

  test("messages sent before the peer connects are delivered once it does", async () => {
    const { port1, port2 } = Port.memory();
    const definition = new ChannelDefinition(events);

    const a = definition.connect({ port: port1 });
    const promise = a.send("ping", { message: "early" });

    /*
     * The MessagePort below holds the message in a queue until connect() calls start().
     */
    await settle();
    definition.connect({
      port: port2,
      resolvers: {
        ping: (_payload, respond) => respond({ reply: "late" }),
      },
    });

    await expect(promise).resolves.toEqual({ reply: "late" });
  });

  test("after one side disconnects, peer messages no longer reach it", async () => {
    const { port1, port2 } = Port.memory();
    const definition = new ChannelDefinition(events);

    const resolver = vi.fn();
    const a = definition.connect({
      port: port1,
      resolvers: { ping: resolver },
    });
    const b = definition.connect({ port: port2 });

    a.disconnect();
    void b.send("ping", { message: "into the void" });
    await settle();

    expect(resolver).not.toHaveBeenCalled();
  });

  /**
   * Characterization test. The sender posts the *transformed* request
   * payload, but the receiver parses the payload again against
   * requestSchema.or(responseSchema). For transforms that are not
   * idempotent (boolean -> "yes" | "no" here), the transformed output
   * does not satisfy one of the schemas. Thus the receiver decides that
   * the message is invalid, and the resolver never runs.
   */
  test("non-idempotent request transforms fail schema re-parsing on the receiving side", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { port1, port2 } = Port.memory();
    const definition = new ChannelDefinition(events);

    const resolver = vi.fn();
    const a = definition.connect({ port: port1 });
    definition.connect({
      port: port2,
      strategy: "warn",
      resolvers: { transformed: resolver },
    });

    void a.send("transformed", { yes: true });
    await settle();

    expect(resolver).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("real WebSocket transport", () => {
  /**
   * Connects to the relay server that the globalSetup in
   * src/test-utils/websocket-server.ts starts. The server connects
   * sockets that share a URL path to each other. Thus each test gets a
   * private full-duplex link.
   */
  function openSocket(room: string): Promise<WebSocket> {
    const socket = new WebSocket(`ws://localhost:${inject("wsServerPort")}/${room}`);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(socket), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true });
    });
  }

  test("full round trip in both directions over real sockets", async () => {
    const room = crypto.randomUUID();
    const [socketA, socketB] = await Promise.all([openSocket(room), openSocket(room)]);

    try {
      const definition = new ChannelDefinition(events);

      const a = definition.connect({
        port: Port.fromWebSocket(socketA),
        resolvers: {
          ping: (payload, respond) => respond({ reply: `a saw ${payload.message}` }),
        },
      });
      const b = definition.connect({
        port: Port.fromWebSocket(socketB),
        resolvers: {
          ping: (payload, respond) => respond({ reply: `b saw ${payload.message}` }),
        },
      });

      await expect(a.send("ping", { message: "from a" })).resolves.toEqual({
        reply: "b saw from a",
      });
      await expect(b.send("ping", { message: "from b" })).resolves.toEqual({
        reply: "a saw from b",
      });
    } finally {
      socketA.close();
      socketB.close();
    }
  });

  /**
   * This test uses a long path on purpose. The request goes from memory,
   * to MessagePort, to worker, to WebSocket, to the endpoint that
   * answers. This shows that relays connect across every transport that
   * this library supports.
   * a <-> b (memory) <-relay-> [MessagePort] <-> worker <-relay-> c <-> [ws server] <-> d.
   */
  test("a request from a memory port is relayed through a worker and real socket", async () => {
    const room = crypto.randomUUID();
    const socketD = await openSocket(room);
    const worker = new Worker(new URL("./test-utils/relay-worker.ts", import.meta.url), {
      type: "module",
    });

    try {
      const { port1: a, port2: b } = Port.memory();
      const { port1: toWorker, port2: workerPort } = new MessageChannel();
      const d = Port.fromWebSocket(socketD);

      const definition = new ChannelDefinition(events);
      definition.relay(b, Port.fromMessagePort(toWorker));

      worker.postMessage({ port: workerPort, url: `ws://localhost:${inject("wsServerPort")}/${room}` }, [workerPort]);

      const received = vi.fn((payload: { message: string }, respond: (input: { reply: string }) => void) =>
        respond({ reply: `d saw ${payload.message}` }),
      );

      const channelA = definition.connect({ port: a });
      definition.connect({ port: d, resolvers: { ping: received } });

      await expect(channelA.send("ping", { message: "from a" })).resolves.toEqual({
        reply: "d saw from a",
      });
      expect(received).toHaveBeenCalledTimes(1);
      expect(received.mock.calls[0]![0]).toEqual({ message: "from a" });
    } finally {
      socketD.close();
      worker.terminate();
    }
  });

  test("closing the socket disconnects the channel via onClose", async () => {
    const socket = await openSocket(crypto.randomUUID());
    const channel = new ChannelDefinition(events).connect({
      port: Port.fromWebSocket(socket),
    });

    socket.close();
    await new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));

    expect(() => channel.send("ping", { message: "hi" })).toThrow("Channel is disconnected");
  });
});

describe("real BroadcastChannel transport", () => {
  test("full round trip in both directions over a shared channel name", async () => {
    const name = crypto.randomUUID();
    const broadcastA = new BroadcastChannel(name);
    const broadcastB = new BroadcastChannel(name);

    try {
      const definition = new ChannelDefinition(events);

      const a = definition.connect({
        port: Port.fromBroadcastChannel(broadcastA),
        resolvers: {
          ping: (payload, respond) => respond({ reply: `a saw ${payload.message}` }),
        },
      });
      const b = definition.connect({
        port: Port.fromBroadcastChannel(broadcastB),
        resolvers: {
          ping: (payload, respond) => respond({ reply: `b saw ${payload.message}` }),
        },
      });

      await expect(a.send("ping", { message: "from a" })).resolves.toEqual({
        reply: "b saw from a",
      });
      await expect(b.send("ping", { message: "from b" })).resolves.toEqual({
        reply: "a saw from b",
      });
    } finally {
      broadcastA.close();
      broadcastB.close();
    }
  });

  /**
   * A BroadcastChannel is a same-origin bus. Many instances can live in
   * one browsing context (no worker or iframe is necessary). Instances
   * with different names stay isolated. Thus several request/response
   * pairs can run at the same time.
   */
  test("many named pairs in the same context exchange concurrently without crosstalk", async () => {
    const definition = new ChannelDefinition(events);
    const pairCount = 8;

    const pairs = Array.from({ length: pairCount }, (_, index) => {
      const name = crypto.randomUUID();
      const left = new BroadcastChannel(name);
      const right = new BroadcastChannel(name);

      const sender = definition.connect({
        port: Port.fromBroadcastChannel(left),
      });
      const receiver = definition.connect({
        port: Port.fromBroadcastChannel(right),
        resolvers: {
          ping: (payload, respond) => respond({ reply: `pair-${index}:${payload.message}` }),
        },
      });

      return { index, left, right, sender, receiver };
    });

    try {
      const results = await Promise.all(
        pairs.map(({ index, sender }) => sender.send("ping", { message: `hello-${index}` })),
      );

      expect(results).toEqual(pairs.map(({ index }) => ({ reply: `pair-${index}:hello-${index}` })));
    } finally {
      for (const { sender, receiver } of pairs) {
        sender.disconnect();
        receiver.disconnect();
      }
    }
  });
});

describe("relay()", () => {
  /**
   * The endpoints hold `port1` of each memory pair. The relay sits
   * between the two `port2` ends: A <-> [relay] <-> B.
   */
  function createRelayHarness(options: Parameters<ChannelDefinition<typeof events>["relay"]>[2] = {}) {
    const pairA = Port.memory();
    const pairB = Port.memory();
    const definition = new ChannelDefinition(events);
    const stopRelay = definition.relay(pairA.port2, pairB.port2, options);
    return { definition, endpointA: pairA.port1, endpointB: pairB.port1, stopRelay };
  }

  test("relays valid messages in both directions", async () => {
    const { endpointA, endpointB } = createRelayHarness();
    const inboxA = createInbox(endpointA);
    const inboxB = createInbox(endpointB);

    endpointA.postMessage({ data: { id: "req-1", type: "ping", payload: { message: "hi" } } });
    await expect(inboxB.next()).resolves.toEqual({
      id: "req-1",
      type: "ping",
      payload: { message: "hi" },
    });

    endpointB.postMessage({ data: { id: "req-1", type: "ping", payload: { reply: "pong" } } });
    await expect(inboxA.next()).resolves.toEqual({
      id: "req-1",
      type: "ping",
      payload: { reply: "pong" },
    });
  });

  test("channels on either side exchange requests and responses through the relay", async () => {
    const { definition, endpointA, endpointB } = createRelayHarness();

    const a = definition.connect({
      port: endpointA,
      resolvers: {
        ping: (payload, respond) => respond({ reply: `a saw ${payload.message}` }),
      },
    });
    const b = definition.connect({
      port: endpointB,
      resolvers: {
        ping: (payload, respond) => respond({ reply: `b saw ${payload.message}` }),
      },
    });

    await expect(a.send("ping", { message: "from a" })).resolves.toEqual({
      reply: "b saw from a",
    });
    await expect(b.send("ping", { message: "from b" })).resolves.toEqual({
      reply: "a saw from b",
    });
  });

  test("forwards the raw message without applying schema transforms", async () => {
    const { endpointA, endpointB } = createRelayHarness();
    const inboxB = createInbox(endpointB);

    endpointA.postMessage({ data: { id: "req-1", type: "transformed", payload: { yes: true } } });

    await expect(inboxB.next()).resolves.toEqual({
      id: "req-1",
      type: "transformed",
      payload: { yes: true },
    });
  });

  test('"throw" (default): the listener throws on an invalid message and forwards nothing', async () => {
    const tapped = createTappedPort();
    const { port1 } = Port.memory();
    const inbox = createInbox(port1);
    new ChannelDefinition(events).relay(tapped.port, port1);

    expect(() => tapped.dispatch({ id: "req-1", type: "nonsense", payload: {} })).toThrow(
      /Invalid discriminator value/,
    );

    await settle();
    expect(inbox.messages).toHaveLength(0);
  });

  test('"warn": console.warn is called once and nothing is forwarded', async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { endpointA, endpointB } = createRelayHarness({ strategy: "warn" });
    const inboxB = createInbox(endpointB);

    endpointA.postMessage({ data: { id: "req-1", type: "nonsense", payload: {} } });
    await settle();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(inboxB.messages).toHaveLength(0);
  });

  test('"ignore": no warning and nothing is forwarded', async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { endpointA, endpointB } = createRelayHarness({ strategy: "ignore" });
    const inboxB = createInbox(endpointB);

    endpointA.postMessage({ data: { id: "req-1", type: "nonsense", payload: {} } });
    await settle();

    expect(warn).not.toHaveBeenCalled();
    expect(inboxB.messages).toHaveLength(0);
  });

  test("stopRelay() removes both listeners, stops both ports, and is idempotent", () => {
    const tappedA = createTappedPort();
    const tappedB = createTappedPort();
    const stopA = vi.spyOn(tappedA.port, "stop");
    const stopB = vi.spyOn(tappedB.port, "stop");

    const stopRelay = new ChannelDefinition(events).relay(tappedA.port, tappedB.port);

    expect(tappedA.listeners.size).toBe(1);
    expect(tappedB.listeners.size).toBe(1);

    stopRelay();
    stopRelay();

    expect(tappedA.listeners.size).toBe(0);
    expect(tappedB.listeners.size).toBe(0);
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).toHaveBeenCalledTimes(1);
  });

  test("messages after stopRelay() are not relayed", async () => {
    const { endpointA, endpointB, stopRelay } = createRelayHarness();
    const inboxB = createInbox(endpointB);

    stopRelay();
    endpointA.postMessage({ data: { id: "req-1", type: "ping", payload: { message: "hi" } } });
    await settle();

    expect(inboxB.messages).toHaveLength(0);
  });

  test("relay() with an already-aborted signal throws", () => {
    const controller = new AbortController();
    controller.abort();

    expect(() =>
      new ChannelDefinition(events).relay(Port.memory().port1, Port.memory().port1, {
        signal: controller.signal,
      }),
    ).toThrow();
  });

  test("aborting the signal tears down the relay", () => {
    const { port1 } = Port.memory();
    const { port1: other } = Port.memory();
    const stop1 = vi.spyOn(port1, "stop");
    const stop2 = vi.spyOn(other, "stop");
    const controller = new AbortController();

    new ChannelDefinition(events).relay(port1, other, { signal: controller.signal });
    controller.abort();

    expect(stop1).toHaveBeenCalledTimes(1);
    expect(stop2).toHaveBeenCalledTimes(1);
  });

  test("either transport closing tears down the relay", () => {
    let closeCallback: (() => void) | undefined;
    const closable = new Port<undefined>({
      postMessage: () => {},
      addListener: () => {},
      removeListener: () => {},
      onClose: (callback) => {
        closeCallback = callback;
      },
      deref: () => undefined,
    });
    const { port1: other } = Port.memory();
    const stop = vi.spyOn(other, "stop");

    new ChannelDefinition(events).relay(closable, other);
    closeCallback?.();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("MessagePort transfer to another context", () => {
  test("channels communicate over a port transferred to a web worker", async () => {
    const worker = new Worker(new URL("./test-utils/single-shot-worker.ts", import.meta.url), {
      type: "module",
    });

    try {
      const { port1, port2 } = new MessageChannel();

      const report = Promise.withResolvers<{ from: string }>();
      const channel = workerDefinition.connect({
        port: Port.fromMessagePort(port1),
        resolvers: {
          report: (payload, respond) => {
            report.resolve(payload);
            respond({ received: true });
          },
        },
      });

      worker.postMessage({}, [port2]);

      /*
       * The main thread starts this request, and the worker-side channel answers it.
       */
      await expect(channel.send("greet", { name: "Gabe" })).resolves.toEqual({
        greeting: "Hello, Gabe!",
      });

      /*
       * The worker starts this request, and the main-thread resolver processes it.
       */
      await expect(report.promise).resolves.toEqual({ from: "worker" });
    } finally {
      worker.terminate();
    }
  });
});
