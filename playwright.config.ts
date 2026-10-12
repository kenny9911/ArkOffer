import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
const localChrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Worker processes reload this file; keep their fixture DB path tied to this run.
const e2eDataDir =
  process.env.ARKOFFER_E2E_DATA_DIR ||
  (process.env.ARKOFFER_E2E_DATA_DIR = `/tmp/arkoffer-e2e-${process.pid}`);
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 40000,
  expect: { timeout: 8000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3412",
    trace: "retain-on-failure",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    launchOptions: existsSync(localChrome)
      ? { executablePath: localChrome }
      : {},
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
  webServer: {
    command: "npm run build && npx tsx server/index.ts",
    url: "http://127.0.0.1:3412/api/health",
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: "3412",
      HOST: "127.0.0.1",
      DATA_DIR: e2eDataDir,
      APP_ORIGIN: "http://127.0.0.1:3412",
      NODE_ENV: "test",
      TRUST_PROXY: "1",
      MAIL_MODE: "outbox",
      LIVEKIT_API_KEY: "",
      LIVEKIT_API_SECRET: "",
      LIVEKIT_AGENT_CALLBACK_SECRET: "",
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      LLM_PROVIDER: "openai",
      PDL_API_KEY: "",
      SLACK_CLIENT_ID: "",
      SLACK_CLIENT_SECRET: "",
      SLACK_SIGNING_SECRET: "",
      SLACK_ENCRYPTION_KEY: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      GREENHOUSE_CLIENT_ID: "",
      GREENHOUSE_CLIENT_SECRET: "",
      RECALL_API_KEY: "",
      GOOGLE_CALENDAR_CLIENT_ID: "",
      MICROSOFT_CALENDAR_CLIENT_ID: "",
    },
  },
});
