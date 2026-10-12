import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateRun } from "../../server/report-presentation.js";

test("grouped metrics separate currencies and preserve zero, missing, failed, pending and hidden counts", () => {
  const columns = [
    { id: "group", name: "Team", type: "text" },
    { id: "metric", name: "Salary", type: "currency" },
  ];
  const row = (status: string, value: unknown, groupStatus = "complete") => ({
    cells: [
      { columnId: "group", status: groupStatus, value: "Engineering" },
      { columnId: "metric", status, value },
    ],
  });
  const result = aggregateRun(
    {
      columns,
      rows: [
        row("complete", { amount: 0, currency: "USD" }),
        row("complete", { amount: 200, currency: "USD" }),
        row("complete", { amount: 300, currency: "EUR" }),
        row("not_documented", null),
        row("failed", null),
        row("queued", null),
        row("complete", { amount: 100, currency: "USD" }, "not_documented"),
        { unavailable: true, cells: [] },
      ],
    },
    { mode: "bar", groupBy: "group", operation: "average", metric: "metric" },
  );
  assert.equal(result.groups.find((g) => g.unit === "USD")?.value, 100);
  assert.equal(result.groups.find((g) => g.unit === "EUR")?.value, 300);
  const missing = result.groups.find((g) => g.unit === null)!;
  assert.equal(missing.value, null);
  assert.equal(missing.notDocumented, 1);
  assert.equal(missing.pending, 1);
  assert.equal(missing.failed, 1);
  assert.deepEqual(result.counts, {
    available: 7,
    unavailable: 1,
    grouped: 6,
    groupNotDocumented: 1,
    groupPending: 0,
    groupFailed: 0,
  });
});

test("group counts do not coerce false to missing or sum text, and pending group values stay excluded", () => {
  const columns = [{ id: "g", name: "Example", type: "boolean" }];
  const rows = [
    { cells: [{ columnId: "g", status: "complete", value: false }] },
    { cells: [{ columnId: "g", status: "processing", value: null }] },
    { cells: [{ columnId: "g", status: "failed", value: null }] },
  ];
  const result = aggregateRun(
    { columns, rows },
    { mode: "table", groupBy: "g", operation: "count", metric: null },
  );
  assert.equal(result.groups[0].label, "No");
  assert.equal(result.groups[0].value, 1);
  assert.equal(result.counts.groupPending, 1);
  assert.equal(result.counts.groupFailed, 1);
  assert.equal(
    aggregateRun(
      { columns, rows },
      { mode: "bar", groupBy: null, operation: "sum", metric: "g" },
    ).compatible,
    false,
  );
});
