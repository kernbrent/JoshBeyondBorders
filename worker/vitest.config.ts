import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          GITHUB_TOKEN: "test-github-token",
          PAYPAL_CLIENT_ID: "test-paypal-client-id",
          PAYPAL_CLIENT_SECRET: "test-paypal-client-secret",
          CSM_DISTRIBUTION_SECRET: "test-csm-distribution-secret",
          TEST_MIGRATIONS: migrations,
        },
        serviceBindings: {
          CSM_STATUS: async () =>
            new Response(JSON.stringify({ success: true }), {
              headers: { "content-type": "application/json" },
            }),
        },
      },
    }),
  ],
  test: {
    restoreMocks: true,
  },
});
