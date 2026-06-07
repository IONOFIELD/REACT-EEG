import { defineConfig } from "vitest/config";

// Test config is intentionally separate from vite.config.js so the production build
// (`npm run build` / `npm run build:single`) is completely unaffected by the test runner.
// Tests target the pure DSP kernel + version stamping — no DOM, so the node environment
// is enough (fast, no jsdom dependency).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.js"],
    watch: false,
  },
});
