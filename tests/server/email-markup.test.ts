import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEmailMarkup, safeEmailLink } from "../../shared/email-markup.js";

test("formatted emails support emphasis, lists and HTTPS links with a readable plain-text fallback", () => {
  const result = renderEmailMarkup(
    "Hello **{{firstName}}**, _welcome_.\n- Build ~~old~~ reliable systems\n- [Read the role](https://example.com/role?a=1&b=2)\n\n1. Meet the team\n2. Ask questions",
    (text) => text.replace("{{firstName}}", "Alex"),
  );
  assert.match(result.html, /<strong>Alex<\/strong>/);
  assert.match(result.html, /<em>welcome<\/em>/);
  assert.match(result.html, /<ul><li>Build <s>old<\/s> reliable systems<\/li>/);
  assert.match(result.html, /<ol><li>Meet the team<\/li>/);
  assert.match(result.html, /href="https:\/\/example.com\/role\?a=1&amp;b=2"/);
  assert.match(result.text, /Hello Alex, welcome./);
  assert.match(
    result.text,
    /Read the role \(https:\/\/example.com\/role\?a=1&b=2\)/,
  );
  assert.ok(!result.text.includes("**"));
});
test("raw HTML, credential URLs, executable URLs and personalization markup never become active content", () => {
  const result = renderEmailMarkup(
    '<img src=x onerror="alert(1)"> **{{name}}** [Run](javascript:alert) [Credentials](https://a:b@example.com/path) [Data](data:text/html,bad)',
    (text) =>
      text.replace(
        "{{name}}",
        "<script>alert(1)</script> **fake** [bad](https://other.example/)",
      ),
  );
  assert.ok(!result.html.includes("<img"));
  assert.ok(!result.html.includes("<script"));
  assert.ok(!result.html.includes("<a "));
  assert.match(result.html, /&lt;script&gt;/);
  assert.match(result.html, /\*\*fake\*\*/);
  for (const link of [
    "http://example.com",
    "https://a:b@example.com",
    "javascript:alert(1)",
    "data:text/html,bad",
    "https://example.com/\npath",
    "https://example.com/{{name}}",
    "//example.com",
  ])
    assert.equal(safeEmailLink(link), null);
  assert.equal(
    safeEmailLink("https://example.com/path"),
    "https://example.com/path",
  );
});
test("formatting escape sequences remain literal and nested depth stays bounded", () => {
  const result = renderEmailMarkup(
    "Literal \\*stars\\* and \\[label\\](https://example.com) **bold _italic_**",
  );
  assert.match(result.text, /Literal \*stars\* and \[label\]/);
  assert.ok(!result.html.includes("<a "));
  assert.match(result.html, /<strong>bold <em>italic<\/em><\/strong>/);
  const bounded = renderEmailMarkup("**_~~".repeat(500));
  assert.ok(bounded.html.length < 100000);
});
