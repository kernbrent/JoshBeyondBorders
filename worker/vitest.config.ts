import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { GITHUB_TOKEN: "test-github-token" },
      },
    }),
  ],
  test: {
    restoreMocks: true,
  },
});
