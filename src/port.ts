type PortMessageData = {
  id: string;
  type: string;
  payload: unknown;
};

/**
 * The envelope that each port transports. The envelope has the same
 * `{ data }` shape that a `MessageEvent` delivers, so outbound messages
 * and listener input look the same. Incoming data has no type until the
 * channel validates the data against the schema of the definition.
 */
export type PortMessage = {
  data: PortMessageData;
};

type PortListener = (message: { data: unknown }) => void;

export type PortParams<T> = {
  postMessage(message: PortMessage): void;
  addListener(listener: PortListener): void;
  removeListener(listener: PortListener): void;
  /** The channel calls this function when the channel connects (e.g. MessagePort.start). */
  start?(): void;
  /**
   * The channel calls this function when the channel disconnects. This
   * function must close the transport below (e.g. MessagePort.close). The
   * channel owns the lifecycle of the transport after the channel
   * connects.
   */
  stop?(): void;
  /** Registers a callback. The port calls the callback when the transport below closes. */
  onClose?(callback: () => void): void;

  /** Gives the transport below as a value of type T. */
  deref(): T;
};

export type Codec<U> = {
  encode(message: PortMessageData): U;
  decode(data: U): unknown;
};

function jsonCodec(): Codec<string> {
  return {
    encode(message) {
      return JSON.stringify(message);
    },
    decode(data) {
      return JSON.parse(data);
    },
  };
}

/**
 * A transport for wire messages. Ports know nothing about events or
 * schemas. Ports move opaque messages between two endpoints. Use the
 * static factories for the built-in transports, or construct a Port
 * directly for a custom transport.
 */
export class Port<T> {
  static fromMessagePort(messagePort: MessagePort): Port<MessagePort> {
    return new Port({
      postMessage(message) {
        messagePort.postMessage(message.data);
      },
      addListener(listener) {
        messagePort.addEventListener("message", listener);
      },
      removeListener(listener) {
        messagePort.removeEventListener("message", listener);
      },
      /**
       * A MessagePort with a listener from `addEventListener` (not from
       * `onmessage`, which starts the port implicitly) holds messages in
       * a queue until `start()` runs. The channel calls `start` after the
       * channel registers its listener. Thus the port delivers, and does
       * not drop, the messages that a peer sent before the connection.
       */
      start() {
        messagePort.start();
      },
      stop() {
        messagePort.close();
      },
      deref() {
        return messagePort;
      },
    });
  }

  static fromBroadcastChannel(broadcastChannel: BroadcastChannel): Port<BroadcastChannel> {
    return new Port({
      postMessage(message) {
        broadcastChannel.postMessage(message.data);
      },
      addListener(listener) {
        broadcastChannel.addEventListener("message", listener);
      },
      removeListener(listener) {
        broadcastChannel.removeEventListener("message", listener);
      },
      /*
       * No `start`: a BroadcastChannel, unlike a MessagePort, delivers
       * messages immediately after you attach a listener. Note that a
       * BroadcastChannel also never sends messages back to the context
       * that posted them. Thus a channel cannot speak to itself over a
       * BroadcastChannel.
       */
      stop() {
        broadcastChannel.close();
      },
      deref() {
        return broadcastChannel;
      },
    });
  }

  static fromChromeRuntimePort(chromePort: chrome.runtime.Port): Port<chrome.runtime.Port> {
    return new Port({
      postMessage(message) {
        /**
         * Chrome runtime listeners receive the posted object without
         * changes (no MessageEvent wrapper). Thus this call posts the full
         * envelope to match the `{ data }` shape that listeners expect.
         * The copy into a plain object is necessary: relays can forward a
         * real MessageEvent, and a structured clone of a MessageEvent onto
         * a chrome.runtime.Port is not possible.
         */
        chromePort.postMessage({ data: message.data });
      },
      addListener(listener) {
        chromePort.onMessage.addListener(listener);
      },
      removeListener(listener) {
        chromePort.onMessage.removeListener(listener);
      },
      stop() {
        /*
         * disconnect() causes onDisconnect on the *other* end only. Thus
         * the local onClose callback of the channel does not run again
         * when the channel starts the stop.
         */
        chromePort.disconnect();
      },
      onClose(callback) {
        chromePort.onDisconnect.addListener(callback);
      },
      deref() {
        return chromePort;
      },
    });
  }

  static fromWebSocket<U extends string | Blob | BufferSource = string>(
    websocket: WebSocket,
    options: { codec?: Codec<U> } = {},
  ): Port<WebSocket> {
    /**
     * WebSockets carry strings or binary frames, not structured clones.
     * Thus messages go through a codec. The default JSON codec makes
     * strings, which agrees with the default type parameter (`U =
     * string`). The cast is necessary because TypeScript cannot connect
     * "no codec was given" to "U is thus string".
     */
    const { codec = jsonCodec() as unknown as Codec<U> } = options;

    /**
     * `removeEventListener` requires the exact function reference from
     * `addEventListener`. Each listener gets a wrapper that decodes frames
     * first. This map keeps the wrapper for each listener, so removal is
     * possible.
     */
    const listeners = new Map<PortListener, (event: MessageEvent) => void>();

    return new Port({
      postMessage(message) {
        websocket.send(codec.encode(message.data));
      },
      addListener(listener) {
        const wrapped = (event: MessageEvent) => listener({ data: codec.decode(event.data) });
        listeners.set(listener, wrapped);
        websocket.addEventListener("message", wrapped);
      },
      removeListener(listener) {
        const wrapped = listeners.get(listener);
        if (wrapped) {
          websocket.removeEventListener("message", wrapped);
          listeners.delete(listener);
        }
      },
      stop() {
        /*
         * close() is safe in every readyState. A close on a socket that is
         * already closed is a no-op. A close on a socket that still
         * connects is a clean abort. The "close" event that follows starts
         * channel.disconnect() again through onClose, and disconnect() is
         * idempotent.
         */
        websocket.close();
      },
      onClose(callback) {
        websocket.addEventListener("close", callback, { once: true });
      },
      deref() {
        return websocket;
      },
    });
  }

  /**
   * An in-process pair of connected ports, built on a real
   * MessageChannel. Thus the pair behaves exactly like production
   * MessagePort usage (structured clone, message queue until start). The
   * pair is useful for tests and for connections in the same context.
   */
  static memory(): { port1: Port<MessagePort>; port2: Port<MessagePort> } {
    const channel = new MessageChannel();

    return {
      port1: Port.fromMessagePort(channel.port1),
      port2: Port.fromMessagePort(channel.port2),
    };
  }

  readonly postMessage: (message: PortMessage) => void;
  readonly addListener: (listener: PortListener) => void;
  readonly removeListener: (listener: PortListener) => void;
  readonly start: () => void;
  readonly stop: () => void;
  readonly onClose: (callback: () => void) => void;
  readonly deref: () => T;

  constructor(params: PortParams<T>) {
    this.postMessage = params.postMessage;
    this.addListener = params.addListener;
    this.removeListener = params.removeListener;
    this.deref = params.deref;
    /*
     * Lifecycle hooks are optional for each transport. The no-op defaults
     * let the channel call the hooks in all cases.
     */
    this.start = params.start ?? (() => {});
    this.stop = params.stop ?? (() => {});
    this.onClose = params.onClose ?? (() => {});
  }
}
