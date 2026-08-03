# @digitalocean/channel

`@digitalocean/channel` gives you a nice, typed interface for requests and responses over message channels.

Define each event once with Zod schemas. Then, connect each endpoint through a `Port`. Each endpoint can send a request or respond to a request.

## Install

Install the package and Zod:

```bash
pnpm add @digitalocean/channel zod
```

```bash
npm install @digitalocean/channel zod
```

```bash
yarn add @digitalocean/channel zod
```

Zod is a peer dependency. Install Zod 4.

For Chrome extension handshakes, use the `@digitalocean/channel/chrome` import path.

## Define events

Put the shared `ChannelDefinition` in a module. Both endpoints must import this module.

```ts
import { z } from "zod";
import { ChannelDefinition } from "@digitalocean/channel";

export const definition = new ChannelDefinition({
  ping: {
    requestSchema: z.object({ message: z.string() }),
    responseSchema: z.object({ reply: z.string() }),
  },
});
```

Each event can have a `requestSchema`, a `responseSchema`, or both schemas.

If you do not give a `requestSchema`, the request has no payload. If you do not give a `responseSchema`, the event has no response: `send` returns `void` instead of a promise, and resolvers for the event do not get a `respond` function.

## Connect and send

The example that follows connects a page to a web worker through a `MessageChannel`.

1. Create a `MessageChannel`.
2. Use `Port.fromMessagePort` to convert each `MessagePort` to a `Port`.
3. Use `postMessage` to transfer one port to the worker.
4. Call `definition.connect` at each endpoint.
5. Give the resolvers to the worker.
6. Call `channel.send` on the page.

**Page:**

```ts
import { Port } from "@digitalocean/channel";
import { definition } from "./events.js";

const worker = new Worker(new URL("./worker.js", import.meta.url), {
  type: "module",
});

const { port1, port2 } = new MessageChannel();

const channel = definition.connect({
  port: Port.fromMessagePort(port1),
});

worker.postMessage(undefined, [port2]);

const result = await channel.send("ping", { message: "hello" });
// result = { reply: "saw hello" }
```

**Worker (`worker.js`):**

```ts
import { Port } from "@digitalocean/channel";
import { definition } from "./events.js";

addEventListener("message", (event: MessageEvent) => {
  definition.connect({
    port: Port.fromMessagePort(event.ports[0]!),
    resolvers: {
      ping: async (payload, respond) => {
        await doSomeWork();

        respond({ reply: `saw ${payload.message}` });
      },
    },
  });
});
```

`connect` sets the channel state to connected.

To stop the channel, do one of these steps:

- Call `channel.disconnect()`.
- Abort the `AbortSignal` that you gave to `connect`.

Do not use the channel after you disconnect it. Call `connect` again with a new port.

### Resolvers

A resolver responds to a request. To add resolvers, give the `resolvers` option to `connect`. Map each event name to a function.

Each resolver gets two arguments:

- `payload`: the request payload. The channel parses the payload with `requestSchema` before it calls the resolver.
- `respond`: a function. Call `respond` one time to send the response. The channel parses the response with `responseSchema`.

If the event has no `responseSchema`, the resolver only gets `payload`. There is no response to send.

The example that follows uses `Port.memory()` to connect two endpoints in one context:

```ts
import { z } from "zod";
import { ChannelDefinition, Port } from "@digitalocean/channel";

const definition = new ChannelDefinition({
  getUser: {
    requestSchema: z.object({ id: z.string() }),
    responseSchema: z.object({ name: z.string() }),
  },
  ping: {
    responseSchema: z.object({ reply: z.string() }),
  },
});

const { port1, port2 } = Port.memory();

definition.connect({
  port: port1,
  resolvers: {
    // `payload` has the type `{ id: string }`.
    getUser: async (payload, respond) => {
      const user = await loadUser(payload.id);

      // The argument must obey `responseSchema`.
      respond({ name: user.name });
    },
    // There is no resolver for "ping". This endpoint does not respond
    // to "ping" requests.
  },
});

const channel = definition.connect({ port: port2 });

const user = await channel.send("getUser", { id: "17" });
// user = { name: "Ada" }

// "ping" has no `requestSchema`, so `send` takes no payload.
// No resolver responds, so this promise rejects when the response
// timeout elapses.
void channel.send("ping");
```

A resolver can be an asynchronous function. Call `respond` when the result is ready.

You do not have to give a resolver for each event. If an endpoint has no resolver for an event, the endpoint does not send a response. The `send` promise at the other endpoint rejects when the response timeout elapses.

Each endpoint can have resolvers. Thus each endpoint can send requests and can respond to requests.

### Response timeouts

Each `send` promise rejects if no response arrives in time, so an `await` does not hang forever. The timeout comes from the first of these values:

1. The `responseTimeoutMs` option of `channel.send`.
2. The `responseTimeoutMs` option of `connect`.
3. The default: 60 seconds (`ChannelDefinition.DEFAULT_RESPONSE_TIMEOUT_MS`).

Give the `send` options after the payload. If the event has no `requestSchema`, give the options as the only argument.

If the event has no `responseSchema`, `send` returns `void` and takes no options. There is no response, so there is no timeout.

```ts
const channel = definition.connect({
  port: port2,
  responseTimeoutMs: 10_000,
});

// This request uses the 10 second timeout from `connect`.
const user = await channel.send("getUser", { id: "17" });

// This request overrides the timeout for one message.
const report = await channel.send("getUser", { id: "18" }, { responseTimeoutMs: 30_000 });

// "ping" has no `requestSchema`, so the options come first.
await channel.send("ping", { responseTimeoutMs: 1_000 });
```

## Ports

A `Port` transmits messages between two endpoints. A `Port` does not contain information about events or schemas.

Use these factory methods:

- Use `Port.fromMessagePort(messagePort)` for a `MessagePort`. Workers, iframes, and `MessageChannel` are examples.
- Use `Port.fromBroadcastChannel(broadcastChannel)` for a `BroadcastChannel`.
- Use `Port.fromWebSocket(websocket)` for a `WebSocket` on the client or the server. This method uses a JSON codec by default.
- Use `Port.fromChromeRuntimePort(chromePort)` for a `chrome.runtime.Port`.
- Use `Port.memory()` to create two connected ports. Use these ports to test code in one context.

You can also create a `Port` with custom functions. Supply a `postMessage` function, a listener function, and lifecycle functions.

## Relay

`definition.relay(port1, port2)` forwards messages in both directions.

The relay makes sure that each message obeys the definition schema. The relay does not change message IDs. The two endpoints can match each response to its request.

You can connect more than one relay. The path that follows is not usual, but it is permitted:

`server` ↔ WebSocket ↔ `page` ↔ iframe ↔ `worker`

The page and the iframe are only relays. The server and the worker are the channel endpoints.

**Server** (convert the WebSocket that the server accepts):

```ts
definition.connect({
  port: Port.fromWebSocket(socket),
  resolvers: {
    ping: (payload, respond) => {
      respond({ reply: `saw ${payload.message}` });
    },
  },
});
```

**Page** (relay the socket into an iframe):

```ts
const socket = new WebSocket("wss://example.com/channel");
const { port1, port2 } = new MessageChannel();

socket.addEventListener("open", () => {
  definition.relay(Port.fromWebSocket(socket), Port.fromMessagePort(port1));
});

iframe.contentWindow!.postMessage({ type: "channel-port" }, "*", [port2]);
```

**Iframe** (relay the parent port into a worker):

```ts
addEventListener("message", (event: MessageEvent) => {
  if (event.data?.type !== "channel-port") {
    return;
  }

  const fromPage = event.ports[0]!;
  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
  });

  const { port1, port2 } = new MessageChannel();

  definition.relay(Port.fromMessagePort(fromPage), Port.fromMessagePort(port1));
  worker.postMessage(undefined, [port2]);
});
```

**Worker** (connect as the far endpoint):

```ts
addEventListener("message", (event: MessageEvent) => {
  const channel = definition.connect({
    port: Port.fromMessagePort(event.ports[0]!),
  });

  void channel.send("ping", { message: "hello from the worker" });
});
```

## Chrome extensions

`ChromeHandshake` prepares the transports for a Chrome extension channel:

- A `MessagePort` connects the host page to the content script through `window.postMessage`.
- A `chrome.runtime.Port` connects the content script or an extension page to the background.

Do these steps:

1. Create one `ChromeHandshake` with a shared `namespace`.
2. On the host, wait for `handshake.hostPort()`. Then, call `connect`.
3. In the content script, wait for `handshake.contentBackgroundBridge()`. Then, call `relay`.
4. In the background, use `handshake.onConnect(...)` or `handshake.backgroundAccept(...)`.
5. In an extension page, wait for `handshake.extensionPagePort({ page })`. Then, call `connect`.

For more information, refer to the test extension in [`src/test-utils/chrome-extension/`](src/test-utils/chrome-extension/).

## License

ISC
