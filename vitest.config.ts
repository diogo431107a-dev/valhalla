import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      // The API, against a temporary data folder. Nothing here calls the real Claude API.
      { test: { name: "server", environment: "node", include: ["server/**/*.test.ts"] } },
      // The parts the server and the page share: parsing a stream, counting words.
      { test: { name: "shared", environment: "node", include: ["shared/**/*.test.ts"] } },
    ],
  },
});
