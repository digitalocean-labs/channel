import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "browser",
          include: ["src/**/*.test.ts"],
          exclude: ["src/chrome-runtime.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            screenshotFailures: false,
            instances: [{ browser: "chromium" }],
          },
          globalSetup: ["src/test-utils/websocket-server.ts"],
        },
      },
      {
        test: {
          name: "chrome-extension",
          include: ["src/chrome-runtime.test.ts"],
          environment: "node",
          globalSetup: ["src/test-utils/chrome-extension/setup.ts"],
        },
      },
    ],
  },
});
