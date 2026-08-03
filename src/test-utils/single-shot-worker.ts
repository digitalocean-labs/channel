import { Port } from "../main.js";
import { workerDefinition } from "./worker-events.js";

addEventListener("message", (event: MessageEvent) => {
  const channel = workerDefinition.connect({
    port: Port.fromMessagePort(event.ports[0]!),
    resolvers: {
      greet: (payload, respond) => respond({ greeting: `Hello, ${payload.name}!` }),
    },
  });

  void channel.send("report", { from: "worker" });
});
