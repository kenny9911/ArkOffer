import { createHash } from "node:crypto";
import { test as base } from "@playwright/test";
export { expect } from "@playwright/test";
/** The test server trusts only its local test proxy. Give independent test clients
 * distinct loopback IPs so one scenario cannot exhaust another's auth budget. */
export const test = base.extend({
  context: async ({ context }, use, testInfo) => {
    const bytes = createHash("sha256").update(testInfo.testId).digest();
    await context.setExtraHTTPHeaders({
      "X-Forwarded-For": `127.${bytes[0]}.${bytes[1]}.${bytes[2]}`,
    });
    await use(context);
  },
});
