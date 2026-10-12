import { test } from "node:test";
import assert from "node:assert/strict";
import { createMailTransport, mailConfig } from "../../server/mail.js";

test("RoboApply mail settings are reused without implicitly enabling live delivery", () => {
  const keys = [
    "MAIL_FROM",
    "ROBOAPPLY_EMAIL_FROM",
    "PUBLIC_APP_URL",
    "APP_URL",
    "MAIL_MODE",
    "MAIL_WORKSPACE_IDS",
    "RESEND_API_KEY",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.ROBOAPPLY_EMAIL_FROM = "Hiring <hiring@example.test>";
    process.env.APP_URL = "https://app.example.test";
    process.env.RESEND_API_KEY = "synthetic-provider-key";
    let config = mailConfig();
    assert.equal(config.from, "Hiring <hiring@example.test>");
    assert.equal(config.publicUrl, "https://app.example.test");
    assert.equal(config.mode, "outbox");
    assert.deepEqual(config.workspaceIds, []);
    process.env.MAIL_FROM = "ArkOffer <arkoffer@example.test>";
    process.env.PUBLIC_APP_URL = "https://arkoffer.example.test";
    process.env.MAIL_MODE = "resend";
    config = mailConfig();
    assert.equal(config.from, "ArkOffer <arkoffer@example.test>");
    assert.equal(config.publicUrl, "https://arkoffer.example.test");
    assert.equal(createMailTransport(config).allowed("workspace-a"), false);
    process.env.MAIL_WORKSPACE_IDS = "workspace-a, workspace-b";
    assert.equal(
      createMailTransport(mailConfig()).allowed("workspace-a"),
      true,
    );
    assert.equal(
      createMailTransport(mailConfig()).allowed("workspace-c"),
      false,
    );
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
