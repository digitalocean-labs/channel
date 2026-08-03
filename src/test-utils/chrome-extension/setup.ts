import * as esbuild from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    /** The absolute path of the built unpacked extension (load it with --load-extension). */
    chromeExtensionPath: string;
    /** The origin and path of the host page into which Chrome injects the content script. */
    chromeExtensionHostUrl: string;
  }
}

const root = path.dirname(fileURLToPath(import.meta.url));
const extensionDist = path.join(root, "dist/extension");
const hostDist = path.join(root, "dist/host");

async function bundleExtension() {
  await mkdir(extensionDist, { recursive: true });
  await mkdir(hostDist, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(root, "background.ts")],
    outfile: path.join(extensionDist, "background.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    /*
     * Keep the importScripts call and the backgroundChannel name readable
     * for the service-worker entry.
     */
    minify: false,
  });

  await esbuild.build({
    entryPoints: [path.join(root, "background-channel.ts")],
    outfile: path.join(extensionDist, "background-channel.js"),
    bundle: true,
    format: "iife",
    globalName: "backgroundChannel",
    platform: "browser",
    target: "chrome120",
    minify: true,
  });

  await esbuild.build({
    entryPoints: [path.join(root, "content.ts")],
    outfile: path.join(extensionDist, "content.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    minify: true,
  });

  await esbuild.build({
    entryPoints: [path.join(root, "host-page.ts")],
    outfile: path.join(hostDist, "host-page.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    minify: true,
  });

  await esbuild.build({
    entryPoints: [path.join(root, "popup.ts")],
    outfile: path.join(extensionDist, "popup.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    minify: true,
  });

  await esbuild.build({
    entryPoints: [path.join(root, "sidepanel.ts")],
    outfile: path.join(extensionDist, "sidepanel.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    minify: true,
  });

  await copyFile(path.join(root, "manifest.json"), path.join(extensionDist, "manifest.json"));
  await copyFile(path.join(root, "popup.html"), path.join(extensionDist, "popup.html"));
  await copyFile(path.join(root, "sidepanel.html"), path.join(extensionDist, "sidepanel.html"));
  await copyFile(path.join(root, "host-page.html"), path.join(hostDist, "index.html"));
}

function startHostServer() {
  const server = createServer(async (request, response) => {
    const url = request.url === "/" || request.url === "/index.html" ? "/index.html" : (request.url ?? "/");
    const filePath = path.join(hostDist, url === "/index.html" ? "index.html" : path.basename(url));

    try {
      const body = await readFile(filePath);
      const contentType = filePath.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
      response.writeHead(200, { "content-type": contentType });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });

  return new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error(`Expected a TCP address, got ${String(address)}`));
        return;
      }

      resolve({
        port: address.port,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
    server.once("error", reject);
  });
}

/**
 * Vitest global setup for the chrome-extension project. Bundles the
 * unpacked extension and the host page, serves the host page over
 * loopback, and injects the two paths into the test with provide/inject.
 */
export default async function setup(project: TestProject) {
  await bundleExtension();
  const host = await startHostServer();

  project.provide("chromeExtensionPath", extensionDist);
  project.provide("chromeExtensionHostUrl", `http://127.0.0.1:${host.port}/`);

  return () => host.close();
}
