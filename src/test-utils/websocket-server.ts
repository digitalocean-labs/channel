import { WebSocketServer, WebSocket } from "ws";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    /** The TCP port of the relay WebSocket server that the test run starts. */
    wsServerPort: number;
  }
}

/**
 * Vitest global setup (runs in Node, not in the browser). Starts a
 * WebSocket relay server on a random port. The server forwards each
 * message to every other client that connected with the same URL path.
 * Thus a pair of sockets in a test makes a private full-duplex pipe.
 */
export default async function setup(project: TestProject) {
  const server = new WebSocketServer({ port: 0 });
  const rooms = new Map<string, Set<WebSocket>>();

  server.on("connection", (socket, request) => {
    const roomName = request.url ?? "/";
    const room = rooms.get(roomName) ?? new Set();
    rooms.set(roomName, room);
    room.add(socket);

    socket.on("message", (data, isBinary) => {
      for (const peer of room) {
        if (peer !== socket && peer.readyState === WebSocket.OPEN) {
          peer.send(data, { binary: isBinary });
        }
      }
    });

    socket.on("close", () => {
      room.delete(socket);
      if (room.size === 0) {
        rooms.delete(roomName);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`Expected a TCP address, got ${String(address)}`);
  }

  project.provide("wsServerPort", address.port);

  return () => {
    for (const socket of server.clients) {
      socket.terminate();
    }
    return new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };
}
