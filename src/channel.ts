import { z } from "zod";
import { BoundedMap } from "./bounded-map.js";
import { Port, type PortMessage } from "./port.js";

type MessageId = string;

/**
 * The shape that users give to {@link ChannelDefinition}: a map of event
 * names to optional request and response schemas. If you do not give a
 * schema, that direction has no payload. The type then becomes `unknown`
 * (see {@link RequestSchema}), and `send` does not accept an argument for
 * that event.
 *
 * `z.ZodSchema<any, any>` uses `any` on purpose, although strict mode is
 * on. With `unknown` here, TypeScript rejects concrete schemas such as
 * `z.object({ ... })`, because the type parameters of Zod are not
 * covariant. Inference of the exact payload types for each event also
 * breaks. The `any` does not show to callers. Payloads always get their
 * types from `z.input` and `z.output` of the applicable schema.
 */
export type ChannelEventMap = Record<
  string,
  {
    requestSchema?: z.ZodSchema<any, any>;
    responseSchema?: z.ZodSchema<any, any>;
  }
>;

/**
 * Gives the request schema of an event. If the event declares no schema,
 * the type becomes `z.ZodSchema<unknown>`. Payloads then have the type
 * `unknown` and not `any`.
 */
type RequestSchema<K extends keyof T, T extends ChannelEventMap> =
  T[K]["requestSchema"] extends z.ZodSchema<any, any> ? T[K]["requestSchema"] : z.ZodSchema<unknown>;

type ResponseSchema<K extends keyof T, T extends ChannelEventMap> =
  T[K]["responseSchema"] extends z.ZodSchema<any, any> ? T[K]["responseSchema"] : z.ZodSchema<unknown>;

type ResponseFn<T extends ChannelEventMap> = (message: z.output<ResponseSchema<keyof T, T>>) => void;

/*
 * Requests and responses have the same wire shape: `{ id, type, payload }`.
 * The wire does not show the direction. A receiver identifies a response
 * when the message id matches a request that the receiver sent (see
 * Channel#handleEvent). The receiver processes all other messages as
 * requests.
 */

type ChannelRequestMessage<
  K extends keyof T,
  T extends ChannelEventMap,
  I extends RequestSchema<K, T> = RequestSchema<K, T>,
> = {
  id: MessageId;
  type: K;
  payload: z.output<I>;
};

type ChannelResponseMessage<
  K extends keyof T,
  T extends ChannelEventMap,
  O extends ResponseSchema<K, T> = ResponseSchema<K, T>,
> = {
  id: MessageId;
  type: K;
  payload: z.output<O>;
};

type ChannelMessage<K extends keyof T, T extends ChannelEventMap> =
  | ChannelRequestMessage<K, T>
  | ChannelResponseMessage<K, T>;

type ChannelMessageSchema<K extends keyof T, T extends ChannelEventMap> = z.ZodSchema<ChannelMessage<K, T>>;

/**
 * A handler that the user supplies for inbound requests. The `payload`
 * argument is the parsed request, after transforms. The `respond` argument
 * accepts the *input* type of the response schema, because the channel
 * parses and transforms the response before the channel posts it. Events
 * without a `responseSchema` have no response. Their resolvers do not
 * receive a `respond` argument.
 */
type Resolver<
  K extends keyof T,
  T extends ChannelEventMap,
  I extends RequestSchema<K, T> = RequestSchema<K, T>,
  O extends ResponseSchema<K, T> = ResponseSchema<K, T>,
> = T[K]["responseSchema"] extends z.ZodSchema<any, any>
  ? (payload: z.output<I>, respond: (payload: z.input<O>) => void) => void
  : (payload: z.output<I>) => void;

export type ResolverMap<T extends ChannelEventMap> = {
  [K in keyof T]?: Resolver<K, T>;
};

type EventHandlerEntry<K extends keyof T, T extends ChannelEventMap> = {
  requestSchema: RequestSchema<K, T>;
  responseSchema: ResponseSchema<K, T>;
  /**
   * Shows if the user declared a `requestSchema`. The runtime needs this
   * flag because an omitted schema defaults to `z.unknown()`, and that
   * default hides the difference. `send` uses this flag to know if its
   * first argument is a payload or a {@link SendOptions} object.
   */
  hasRequestSchema: boolean;
  /**
   * Shows if the user declared a `responseSchema`. Without one, the event
   * has no response: `send` returns void and stores no pending response,
   * and the resolvers do not receive `respond`.
   */
  hasResponseSchema: boolean;
};

type EventHandlerMap<K extends keyof T, T extends ChannelEventMap> = Map<K, EventHandlerEntry<K, T>>;

/**
 * The procedure for a message that fails schema validation.
 * - "throw": Throw an error.
 * - "warn": Show a warning and ignore the message.
 * - "ignore": Ignore the message.
 */
export type ChannelStrategy = "throw" | "warn" | "ignore";

type StopRelay = () => void;

/**
 * Ids must only be unique among the open requests of this endpoint (a set
 * that maxMapSize limits). Ids cross a transport that the two sides
 * already trust. Thus the ids are not a security boundary. A short random
 * string is sufficient. `crypto.randomUUID` is not necessary, and it is
 * not available in some target contexts, for example non-secure origins.
 */
function createId(): MessageId {
  return Math.random().toString(36).substring(2);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

/**
 * Applies the channel strategy to a message that failed schema validation:
 * throws an error, shows a warning, or does nothing.
 */
function reportInvalidMessage(strategy: ChannelStrategy, error: z.ZodError): void {
  const errorMessage = z.prettifyError(error);

  switch (strategy) {
    case "throw":
      throw new Error(errorMessage, { cause: error });
    case "warn":
      console.warn(errorMessage);
      return;
    case "ignore":
      return;
    default:
      return assertNever(strategy);
  }
}

/**
 * Options for one send. {@link Channel.send} accepts the options as its
 * last argument, or as its only argument for events without a
 * `requestSchema`. Only events with a `responseSchema` accept options,
 * because without a response no timeout is possible.
 */
export type SendOptions = {
  /**
   * The time to wait for a response before the returned promise rejects.
   * This value replaces the connection-level value from
   * {@link ConnectParams}.
   */
  responseTimeoutMs?: number;
};

/**
 * The rest-parameter conditional makes the payload argument required
 * exactly when the event declares a `requestSchema`. The conditional
 * forbids the payload argument when the event does not. A plain optional
 * parameter permits the two shapes everywhere, which is not correct.
 * {@link SendOptions} always comes last, and only exists for events with
 * a `responseSchema`.
 */
type SendArgs<K extends keyof T, T extends ChannelEventMap> = T[K]["requestSchema"] extends z.ZodSchema<any, any>
  ? T[K]["responseSchema"] extends z.ZodSchema<any, any>
    ? [input: z.input<RequestSchema<K, T>>, options?: SendOptions]
    : [input: z.input<RequestSchema<K, T>>]
  : T[K]["responseSchema"] extends z.ZodSchema<any, any>
    ? [options?: SendOptions]
    : [];

/**
 * `send` resolves with the response only when the event can have one.
 * Events without a `responseSchema` have no response, and `send` returns
 * void for them.
 */
type SendResult<
  K extends keyof T,
  T extends ChannelEventMap,
  O extends ResponseSchema<K, T> = ResponseSchema<K, T>,
> = T[K]["responseSchema"] extends z.ZodSchema<any, any> ? Promise<z.output<O>> : void;

type ChannelParams<T extends ChannelEventMap> = {
  port: Port<any>;
  definition: ChannelDefinition<T>;
  resolvers: ResolverMap<T>;
  strategy: ChannelStrategy;
  maxMapSize: number;
  responseTimeoutMs: number;
};

export namespace Channel {
  /**
   * Gives the Channel type that a ChannelDefinition produces.
   */
  export type infer<T extends ChannelDefinition<any>> = T extends ChannelDefinition<infer U> ? Channel<U> : never;
}

/**
 * A live connection over a port. {@link ChannelDefinition.connect} creates
 * channels, and each channel starts in the connected state. You cannot use
 * a channel again after the channel disconnects. Connect again to get a
 * new channel.
 */
export class Channel<T extends ChannelEventMap> {
  #status: "connected" | "disconnected" = "connected";

  #port: Port<any>;
  #strategy: ChannelStrategy;
  #resolvers: ResolverMap<T>;
  #definition: ChannelDefinition<T>;
  #responseTimeoutMs: number;

  /**
   * Resolve callbacks for requests that wait for a response, with the
   * message id as the key. The map has a size limit, so peers that never
   * respond cannot cause a memory leak. When the map goes above the limit,
   * the map removes the oldest entry. The `send` promise of that entry
   * rejects when its response timeout occurs.
   */
  #pendingResponses: BoundedMap<MessageId, ResponseFn<T>>;

  constructor(params: ChannelParams<T>) {
    const { port, definition, resolvers, strategy, maxMapSize, responseTimeoutMs } = params;

    this.#port = port;
    this.#strategy = strategy;
    this.#resolvers = resolvers;
    this.#definition = definition;
    this.#responseTimeoutMs = responseTimeoutMs;
    this.#pendingResponses = new BoundedMap<MessageId, ResponseFn<T>>(maxMapSize);

    /*
     * The sequence is important: register the listener before start(). On
     * MessagePort, start() releases the messages that went into the queue
     * while no listener was connected.
     */
    this.#port.addListener(this.#handleEvent);
    this.#port.onClose(() => this.disconnect());
    this.#port.start();
  }

  /**
   * See {@link SendArgs} and {@link SendResult} for how the signature
   * changes with the schemas that the event declares.
   */
  send<K extends keyof T, O extends ResponseSchema<K, T>>(type: K, ...args: SendArgs<K, T>): SendResult<K, T, O> {
    if (this.#status !== "connected") {
      throw new Error(`Channel is ${this.#status}`);
    }

    /*
     * The tuple type above makes sure of the shape. But the applicable
     * shape depends on the schemas that the event declared. That is a
     * runtime fact, which the definition recorded at construction (see
     * hasRequestSchema).
     */
    const [input, options] = (this.#definition.hasRequestSchema(type) ? args : [undefined, args[0]]) as [
      unknown,
      SendOptions | undefined,
    ];

    /*
     * The channel parses the payload before the post. Thus the sender
     * applies the schema transforms, and the *transformed* payload crosses
     * the wire. The cast is safe, because the parse validates the input at
     * runtime in all cases.
     */
    const payload = this.#definition.parseRequestInputOrThrow(type, input as z.input<RequestSchema<K, T>>);

    const id = createId();

    /*
     * No response schema: no response can arrive. Thus there is no promise
     * to return, no pending entry to store, and no timer to start.
     */
    if (!this.#definition.hasResponseSchema(type)) {
      this.#port.postMessage({ data: { id, type: String(type), payload } });
      return undefined as SendResult<K, T, O>;
    }

    const { resolve, reject, promise } = Promise.withResolvers<z.output<O>>();

    const responseTimeoutMs = options?.responseTimeoutMs ?? this.#responseTimeoutMs;

    const timer = setTimeout(() => {
      this.#pendingResponses.delete(id);
      reject(new Error(`Timed out waiting for a response to "${String(type)}" after ${responseTimeoutMs}ms`));
    }, responseTimeoutMs);

    /*
     * The channel stores the entry before the post. Thus a transport that
     * delivers the response synchronously still finds the pending entry.
     */
    this.#pendingResponses.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });

    this.#port.postMessage({ data: { id, type: String(type), payload } });

    return promise as SendResult<K, T, O>;
  }

  disconnect() {
    /*
     * disconnect() must be idempotent. More than one path can call it at
     * the same time: a user call, an abort signal, and the transport
     * onClose. The stop() call below can also cause a close event.
     */
    if (this.#status === "disconnected") {
      return;
    }

    this.#status = "disconnected";
    this.#port.removeListener(this.#handleEvent);
    this.#port.stop();
    /*
     * The clear() call drops the callbacks. Thus open send() promises
     * never resolve. Each one rejects when its response timeout occurs.
     */
    this.#pendingResponses.clear();
  }

  /**
   * An arrow-function property, not a method, so the same bound reference
   * goes to addListener and to removeListener. With the "throw" strategy,
   * invalid messages throw synchronously into the event dispatch of the
   * transport.
   */
  #handleEvent = <K extends keyof T, O extends ResponseSchema<K, T>>(message: { data: unknown }) => {
    /*
     * The transport can deliver messages that went into the queue before
     * disconnect() removed the listener.
     */
    if (this.#status !== "connected") {
      return;
    }

    const result = this.#definition.parseMessage(message.data);

    if (!result.success) {
      return reportInvalidMessage(this.#strategy, result.error);
    }

    const { id, type, payload } = result.data;

    /*
     * This call is only for its throw. When the definition has no events,
     * the message schema is `z.any()` (see ChannelDefinition). This check
     * then rejects unknown types.
     */
    this.#definition.getHandlerOrThrow(type);

    const pendingResponse = this.#pendingResponses.get(id);

    /**
     * The channel finds the direction here. send() makes the ids locally,
     * and the respond() of the peer sends the same id back. Thus a message
     * with an id that matches a pending entry is the response to that
     * request. The channel processes all other messages as inbound
     * requests.
     */
    if (pendingResponse) {
      /*
       * The schema validated the payload against
       * requestSchema.or(responseSchema), because the wire does not show
       * the direction. The direction is known here. Thus this cast narrows
       * the payload to the response side.
       */
      pendingResponse(payload as z.output<O>);
      this.#pendingResponses.delete(id);
      return;
    }

    const respond = (input: z.input<O>) => {
      /*
       * The types already hide `respond` from these resolvers. This guard
       * stops untyped callers. A response here is harmful: the sender
       * stored no pending entry, so the sender dispatches the returned
       * message to its resolvers as a new request.
       */
      if (!this.#definition.hasResponseSchema(type)) {
        throw new Error(`Event "${String(type)}" has no responseSchema; there is nothing to respond to`);
      }

      const payload = this.#definition.parseResponseInputOrThrow(type, input);
      /*
       * respond() uses the id of the request again. The peer uses that id
       * to match this response with its pending send().
       */
      this.#port.postMessage({ data: { id, type: String(type), payload } });
    };

    /*
     * The `any` casts are necessary. `type` is a runtime value, so
     * TypeScript cannot prove that the parameters of this resolver match
     * this payload. TypeScript also cannot prove that the resolver accepts
     * a `respond` argument. Extra arguments cause no damage. The
     * parameters do match, because the two sides come from the same schema
     * for `type`.
     */
    (this.#resolvers[type] as any)?.(payload, respond);
  };
}
export type ConnectParams<T extends ChannelEventMap> = {
  port: Port<any>;
  resolvers?: ResolverMap<T>;
  signal?: AbortSignal;
  strategy?: ChannelStrategy;
  maxMapSize?: number;
  /**
   * The time each `send` waits for a response before its promise rejects.
   * A per-message value from {@link SendOptions} replaces this value. The
   * default is {@link ChannelDefinition.DEFAULT_RESPONSE_TIMEOUT_MS}.
   */
  responseTimeoutMs?: number;
};

export type RelayParams = {
  signal?: AbortSignal;
  strategy?: ChannelStrategy;
};

/**
 * The shared, stateless description of a channel: its events and the
 * message schema that comes from them. Define the description one time in
 * a module that the two endpoints share. Then call {@link connect} on
 * each side with a transport.
 */
export class ChannelDefinition<T extends ChannelEventMap> {
  static DEFAULT_STRATEGY: ChannelStrategy = "throw";
  static DEFAULT_MAX_MAP_SIZE = 100;
  static DEFAULT_RESPONSE_TIMEOUT_MS = 60_000;

  readonly messageSchema: ChannelMessageSchema<keyof T, T>;
  readonly handlers: EventHandlerMap<keyof T, T>;

  constructor(events: T) {
    type K = keyof T;
    type Entry = [K, EventHandlerEntry<K, T>];

    const entries: Entry[] = [];
    const messageSchemas: ChannelMessageSchema<K, T>[] = [];

    for (const [type, schemas] of Object.entries(events)) {
      const hasRequestSchema = schemas.requestSchema !== undefined;
      const hasResponseSchema = schemas.responseSchema !== undefined;
      const { requestSchema = z.unknown(), responseSchema = z.unknown() } = schemas;

      const schema = z.object({
        id: z.string(),
        type: z.literal(type),
        /*
         * A receiver cannot know from the wire if a message is a request
         * or a response (see Channel#handleEvent). Thus the message schema
         * must accept the two payload types. The sending side does the
         * direction-specific validation.
         */
        payload: requestSchema.or(responseSchema),
      });

      messageSchemas.push(schema);
      entries.push([
        type,
        {
          requestSchema: requestSchema as RequestSchema<K, T>,
          responseSchema: responseSchema as ResponseSchema<K, T>,
          hasRequestSchema,
          hasResponseSchema,
        },
      ]);
    }

    this.handlers = new Map<K, EventHandlerEntry<K, T>>(entries);

    /*
     * A discriminated union on `type` gives precise errors for each event,
     * and Zod does not have to try every branch. Zod requires a non-empty
     * tuple of options, and thus the cast is necessary. A definition with
     * zero events falls back to `z.any()`. getHandlerOrThrow then rejects
     * unknown types.
     */
    this.messageSchema =
      messageSchemas.length > 0 ? z.discriminatedUnion("type", messageSchemas as [any, ...any[]]) : z.any();
  }

  hasRequestSchema(type: keyof T): boolean {
    return this.handlers.get(type)?.hasRequestSchema ?? false;
  }

  hasResponseSchema(type: keyof T): boolean {
    return this.handlers.get(type)?.hasResponseSchema ?? false;
  }

  /**
   * @internal
   */
  parseMessage(message: unknown): z.ZodSafeParseResult<ChannelMessage<keyof T, T>> {
    return this.messageSchema.safeParse(message);
  }

  /**
   * @internal
   */
  parseRequestInputOrThrow<K extends keyof T, I extends RequestSchema<K, T>>(type: K, input?: z.input<I>): z.output<I> {
    const handler = this.getHandlerOrThrow(type);
    const result = handler.requestSchema.safeParse(input);

    if (!result.success) {
      throw new Error(z.prettifyError(result.error), { cause: result.error });
    }

    return result.data;
  }

  /**
   * @internal
   */
  parseResponseInputOrThrow<K extends keyof T, O extends ResponseSchema<K, T>>(
    type: K,
    payload: z.input<O>,
  ): z.output<O> {
    const handler = this.getHandlerOrThrow(type);
    const result = handler.responseSchema.safeParse(payload);

    if (!result.success) {
      throw new Error(z.prettifyError(result.error), { cause: result.error });
    }

    return result.data;
  }

  connect(params: ConnectParams<T>): Channel<T> {
    const {
      port,
      signal,
      resolvers = {},
      strategy = ChannelDefinition.DEFAULT_STRATEGY,
      maxMapSize = ChannelDefinition.DEFAULT_MAX_MAP_SIZE,
      responseTimeoutMs = ChannelDefinition.DEFAULT_RESPONSE_TIMEOUT_MS,
    } = params;

    signal?.throwIfAborted();

    const channel = new Channel<T>({
      port,
      definition: this,
      resolvers,
      strategy,
      maxMapSize,
      responseTimeoutMs,
    });

    signal?.addEventListener("abort", () => channel.disconnect(), {
      once: true,
    });

    return channel;
  }

  /**
   * Relays messages between two ports in the two directions. The relay
   * validates each message against the schema of the definition before the
   * relay forwards the message. The relay is transparent: the relay
   * forwards messages without changes (ids stay the same, and transforms
   * do not apply). Thus the match of requests to responses between the
   * real endpoints operates through the relay without changes. Responses
   * flow back on the same path.
   *
   * Returns a `stopRelay` function that removes the listeners and stops
   * the two ports. The relay also stops itself when the signal aborts or
   * when one of the transports closes.
   */
  relay(port1: Port<any>, port2: Port<any>, params: RelayParams = {}): StopRelay {
    const { signal, strategy = ChannelDefinition.DEFAULT_STRATEGY } = params;

    signal?.throwIfAborted();

    const forward = (to: Port<any>) => (message: { data: unknown }) => {
      const result = this.parseMessage(message.data);

      if (!result.success) {
        return reportInvalidMessage(strategy, result.error);
      }

      /**
       * The relay forwards the original data, not the parse result. Thus
       * only the endpoint that receives the message applies the schema
       * transforms. The listener input already has the envelope shape that
       * ports post.
       */
      to.postMessage(message as PortMessage);
    };

    const listener1 = forward(port2);
    const listener2 = forward(port1);

    let active = true;

    const stopRelay = () => {
      /*
       * stopRelay must be idempotent, for the same reason as
       * Channel.disconnect(). The returned function, the abort signal, and
       * the onClose callbacks of the two ports can all start the stop
       * procedure.
       */
      if (!active) {
        return;
      }

      active = false;
      port1.removeListener(listener1);
      port2.removeListener(listener2);
      port1.stop();
      port2.stop();
    };

    port1.addListener(listener1);
    port2.addListener(listener2);
    port1.onClose(stopRelay);
    port2.onClose(stopRelay);
    port1.start();
    port2.start();

    signal?.addEventListener("abort", stopRelay, { once: true });

    return stopRelay;
  }

  /**
   * @internal
   */
  getHandlerOrThrow(type: keyof T) {
    const handler = this.handlers.get(type);

    if (!handler) {
      throw new Error(`Handler for type ${String(type)} not found`);
    }

    return handler;
  }
}
