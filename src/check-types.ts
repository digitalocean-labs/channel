/**
 * Compile-time assertions about the public types. Nothing here runs. The
 * build does not include this file (tsconfig.build.json). The file exists
 * only so `npm run typecheck` fails if inference regresses.
 * `check<T>(value)` asserts that `value` is assignable to `T`.
 * `@ts-expect-error` asserts that the line after it does NOT compile.
 */

import { z } from "zod";
import { ChannelDefinition, Port } from "./main.js";

const c = new MessageChannel();

/**
 * One event for each schema combination of interest: with and without a
 * request, with and without a response, and transforms on each side.
 * Transforms make `z.input` and `z.output` different, and that is where
 * inference is most likely to break.
 */
const definition = new ChannelDefinition({
  withResponse: {
    requestSchema: z.object({ message: z.string() }),
    responseSchema: z.object({ success: z.boolean() }),
  },

  withNoRequest: {
    responseSchema: z.object({ success: z.boolean() }),
  },

  withNoResponse: {
    requestSchema: z.object({ cool: z.literal(true) }),
  },
  withResponseTransform: {
    requestSchema: z.object({ message: z.string() }),
    responseSchema: z.object({
      message: z.string().transform((val) => val.length),
    }),
  },
  withRequestTransform: {
    requestSchema: z.object({
      message: z.string().transform((val) => val.length),
    }),
    responseSchema: z.object({ message: z.string() }),
  },
  withAllTransforms: {
    requestSchema: z.object({
      yes: z.boolean().transform((val) => (val ? "yes" : "no")),
    }),
    responseSchema: z.object({
      report: z.string().transform((val) => [val]),
    }),
  },
});

function check<T>(_v: T): void {}

const channel = definition.connect({
  port: Port.fromMessagePort(c.port1),
  resolvers: {
    withAllTransforms: (payload, respond) => {
      /*
       * Resolvers see the *output* of the request transform. respond()
       * takes the *input* of the response transform.
       */
      check<"yes" | "no">(payload.yes);
      check<(payload: { report: string }) => void>(respond);
    },
    withNoRequest: (payload, respond) => {
      /*
       * No request schema: the payload must be `unknown`, not `any`.
       */
      check<unknown>(payload);
      // @ts-expect-error `payload` is `unknown`
      check<{ a: 12 }>(payload);
      check<(payload: { success: boolean }) => void>(respond);
    },
    /*
     * No response schema: the resolver does not receive a `respond` argument.
     */
    withNoResponse: (payload) => {
      check<{ cool: true }>(payload);
    },
  },
});

channel
  .send("withResponse", {
    message: "Hello, world!",
  })
  .then(check<{ success: boolean }>);

/*
 * send() takes the input of the request transform. The promise resolves
 * to the output of the response transform.
 */
channel
  .send("withAllTransforms", {
    yes: true,
  })
  .then(check<{ report: string[] }>);

// @ts-expect-error `message` is a string
channel.send("withResponse", { message: 3 });

/*
 * Without a response schema, send has no response. send returns void, not
 * a promise. send takes no options, because no timeout is possible.
 */
check<void>(channel.send("withNoResponse", { cool: true }));

// @ts-expect-error void has no .then
channel.send("withNoResponse", { cool: true }).then;

// @ts-expect-error no responseSchema: send options are not accepted
channel.send("withNoResponse", { cool: true }, { responseTimeoutMs: 1000 });

definition.connect({
  port: Port.fromMessagePort(c.port1),
  resolvers: {
    // @ts-expect-error no responseSchema: resolvers get no respond argument
    withNoResponse: (_payload: { cool: true }, _respond: (payload: unknown) => void) => {},
  },
});

// @ts-expect-error `withNoRequest` does not have a payload
channel.send("withNoRequest", { unrelated: true }).then(check<{ success: boolean }>);

channel.send("withNoRequest").then(check<{ success: boolean }>);

// @ts-expect-error payload is required when a request schema is defined
channel.send("withResponse");

/*
 * With a request schema, send options come after the payload. Without a
 * request schema, the options are the only argument.
 */
channel.send("withResponse", { message: "hi" }, { responseTimeoutMs: 1000 }).then(check<{ success: boolean }>);
channel.send("withNoRequest", { responseTimeoutMs: 1000 }).then(check<{ success: boolean }>);

// @ts-expect-error options must follow the payload when a request schema is defined
channel.send("withResponse", { responseTimeoutMs: 1000 });
