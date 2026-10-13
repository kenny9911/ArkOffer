import { z } from "zod";
import {
  metadataFields,
  operatorsFor,
  type AnalysisChart,
  type AnalysisCondition,
  type AnalysisMetadata,
  type AnalysisResult,
  type ReportAnalysis,
} from "../shared/report-analysis.js";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const field = z.string().min(1).max(64);
export const analysisSchema = z
  .object({
    filters: z
      .object({
        logic: z.enum(["all", "any"]),
        conditions: z
          .array(
            z
              .object({
                id,
                field,
                operator: z.enum([
                  "equals",
                  "not_equals",
                  "contains",
                  "not_contains",
                  "gt",
                  "gte",
                  "lt",
                  "lte",
                  "is_missing",
                  "is_present",
                ]),
                value: z
                  .union([
                    z.string().max(2000),
                    z.number().finite(),
                    z.boolean(),
                  ])
                  .optional(),
                currency: z
                  .string()
                  .regex(/^[A-Z]{3}$/)
                  .optional(),
              })
              .strict(),
          )
          .max(12),
      })
      .strict(),
    charts: z
      .array(
        z
          .object({
            id,
            name: z.string().trim().min(1).max(100),
            mode: z.enum(["bar", "line", "stacked"]),
            groupBy: field.nullable(),
            bucket: z.enum(["day", "week", "month"]),
            splitBy: field.nullable(),
            operation: z.enum(["count", "sum", "average"]),
            metric: field.nullable(),
          })
          .strict(),
      )
      .max(6),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.filters.conditions.map((c) => c.id)).size ===
        value.filters.conditions.length &&
      new Set(value.charts.map((c) => c.id)).size === value.charts.length,
    "Condition and chart identities must be unique.",
  );

type Column = { id: string; name: string; type: string };
type Cell = { columnId: string; status: string; value: unknown };
type Row = {
  id: string;
  unavailable?: boolean;
  metadata?: AnalysisMetadata | null;
  cells: Cell[];
};
type Run = { columns: Column[]; rows: Row[] };
type Value = {
  state: "complete" | "missing" | "pending" | "failed" | "unknown";
  value?: string | number | boolean | { amount: number; currency: string };
};
const info = (columns: Column[], field: string) =>
  metadataFields.find((entry) => entry.id === field) ||
  columns.find((entry) => entry.id === field);
/** Invalid dates and timezone-less times are unknown, never guessed in server local time. */
export function normalizeAnalysisDate(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      value,
    )
  )
    return null;
  const day = value.slice(0, 10),
    midnight = new Date(`${day}T00:00:00.000Z`);
  if (
    !Number.isFinite(midnight.getTime()) ||
    midnight.toISOString().slice(0, 10) !== day
  )
    return null;
  const date = value.length === 10 ? midnight : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function snapshotAnalysisMetadata(
  item: Record<string, unknown>,
): AnalysisMetadata {
  const text = (value: unknown) =>
    typeof value === "string" && value.trim()
      ? value.trim().slice(0, 200)
      : null;
  return {
    version: 1,
    createdAt: normalizeAnalysisDate(item.createdAt),
    conversationDate: normalizeAnalysisDate(item.date),
    candidate: text(item.candidate),
    interviewer: text(item.interviewer),
    status: text(item.status),
    duration:
      typeof item.duration === "number" &&
      Number.isFinite(item.duration) &&
      item.duration >= 0 &&
      item.duration <= 10080
        ? item.duration
        : null,
  };
}
function conditionIssue(condition: AnalysisCondition, columns: Column[]) {
  const column = info(columns, condition.field);
  if (!column)
    return "A filter field is absent from this run. Choose a compatible result filter.";
  if (!operatorsFor(column.type).includes(condition.operator))
    return `The operator is not supported for ${column.name}.`;
  if (["is_missing", "is_present"].includes(condition.operator)) {
    if (condition.value !== undefined || condition.currency !== undefined)
      return "Presence filters do not take a value or currency.";
    return null;
  }
  if (column.type === "currency") {
    if (
      typeof condition.value !== "number" ||
      !Number.isFinite(condition.value) ||
      !condition.currency
    )
      return "Currency comparisons need a finite amount and an explicit three-letter currency.";
  } else {
    if (condition.currency !== undefined)
      return "Only currency comparisons take a currency.";
    if (column.type === "date" && !normalizeAnalysisDate(condition.value))
      return "Date comparisons need a valid ISO date.";
    if (
      column.type === "number" &&
      (typeof condition.value !== "number" || !Number.isFinite(condition.value))
    )
      return "Numeric comparisons need a finite number.";
    if (column.type === "boolean" && typeof condition.value !== "boolean")
      return "Boolean comparisons need true or false.";
    if (column.type === "text" && typeof condition.value !== "string")
      return "Text comparisons need a text value.";
  }
  return null;
}
function chartIssue(chart: AnalysisChart, columns: Column[]) {
  if (chart.groupBy && !info(columns, chart.groupBy))
    return "The grouping field is absent from this run.";
  if (
    chart.splitBy &&
    !["text", "boolean"].includes(info(columns, chart.splitBy)?.type || "")
  )
    return "Split by needs a text or boolean field from this run.";
  if (chart.operation === "count" && chart.metric !== null)
    return "Conversation counts do not use a value field.";
  if (
    chart.operation !== "count" &&
    !["number", "currency"].includes(
      info(columns, chart.metric || "")?.type || "",
    )
  )
    return "Sum and average need a number or currency field from this run.";
  if (
    chart.mode === "stacked" &&
    (!chart.splitBy || chart.operation === "average")
  )
    return "Stacked charts need a split field and an additive count or sum.";
  return null;
}
export function analysisIssue(analysis: ReportAnalysis, columns: Column[]) {
  for (const condition of analysis.filters.conditions) {
    const issue = conditionIssue(condition, columns);
    if (issue) return issue;
  }
  for (const chart of analysis.charts) {
    const issue = chartIssue(chart, columns);
    if (issue) return issue;
  }
  return null;
}
function read(row: Row, field: string, columns: Column[]): Value {
  const type = info(columns, field)?.type;
  let value: unknown;
  if (field.startsWith("$")) {
    if (!row.metadata || row.metadata.version !== 1)
      return { state: "unknown" };
    value = row.metadata[field.slice(1) as keyof AnalysisMetadata];
    if (value === null || value === undefined) return { state: "missing" };
  } else {
    const cell = row.cells.find((entry) => entry.columnId === field);
    if (!cell || ["queued", "processing"].includes(cell.status))
      return { state: "pending" };
    if (cell.status === "not_documented") return { state: "missing" };
    if (cell.status !== "complete") return { state: "failed" };
    value = cell.value;
    if (value === null || value === undefined) return { state: "missing" };
  }
  if (type === "date") {
    const date = normalizeAnalysisDate(value);
    return date ? { state: "complete", value: date } : { state: "unknown" };
  }
  if (
    (type === "number" &&
      typeof value === "number" &&
      Number.isFinite(value)) ||
    (type === "text" && typeof value === "string") ||
    (type === "boolean" && typeof value === "boolean")
  )
    return { state: "complete", value: value as string | number | boolean };
  if (type === "currency" && value && typeof value === "object") {
    const money = value as { amount?: unknown; currency?: unknown };
    if (
      typeof money.amount === "number" &&
      Number.isFinite(money.amount) &&
      typeof money.currency === "string" &&
      /^[A-Z]{3}$/.test(money.currency)
    )
      return {
        state: "complete",
        value: { amount: money.amount, currency: money.currency },
      };
  }
  return { state: "failed" };
}
function predicate(
  row: Row,
  condition: AnalysisCondition,
  columns: Column[],
): boolean | null {
  const result = read(row, condition.field, columns);
  if (!["complete", "missing"].includes(result.state)) return null;
  if (condition.operator === "is_missing") return result.state === "missing";
  if (condition.operator === "is_present") return result.state === "complete";
  if (result.state !== "complete") return null;
  let actual = result.value!,
    expected = condition.value!;
  const type = info(columns, condition.field)!.type;
  if (type === "currency") {
    const money = actual as { amount: number; currency: string };
    // A comparison in USD never interprets an EUR amount as USD, including negative predicates.
    if (money.currency !== condition.currency) return null;
    actual = money.amount;
  }
  if (type === "date") {
    actual = String(actual).slice(0, 10);
    expected = normalizeAnalysisDate(expected)!.slice(0, 10);
  }
  if (type === "text") {
    actual = String(actual).toLocaleLowerCase("en-US");
    expected = String(expected).toLocaleLowerCase("en-US");
  }
  const ordering =
    typeof actual === "number" && typeof expected === "number"
      ? actual - expected
      : String(actual).localeCompare(String(expected));
  switch (condition.operator) {
    case "equals":
      return actual === expected;
    case "not_equals":
      return actual !== expected;
    case "contains":
      return String(actual).includes(String(expected));
    case "not_contains":
      return !String(actual).includes(String(expected));
    case "gt":
      return ordering > 0;
    case "gte":
      return ordering >= 0;
    case "lt":
      return ordering < 0;
    case "lte":
      return ordering <= 0;
  }
}
function bucketDate(value: string, bucket: AnalysisChart["bucket"]) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  if (bucket === "month") date.setUTCDate(1);
  if (bucket === "week")
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}
const label = (value: Value["value"]) =>
  typeof value === "boolean"
    ? value
      ? "Yes"
      : "No"
    : typeof value === "object" && value
      ? `${value.currency} ${value.amount}`
      : String(value);
function chartResult(
  rows: Row[],
  columns: Column[],
  chart: AnalysisChart,
): AnalysisResult["charts"][number] {
  const issue = chartIssue(chart, columns);
  const result: AnalysisResult["charts"][number] = {
    chart,
    compatible: !issue,
    issue,
    missing: 0,
    pending: 0,
    failed: 0,
    groups: [],
  };
  if (issue) return result;
  type Group = AnalysisResult["charts"][number]["groups"][number] & {
    sum: number;
    sort: string | number;
  };
  const groups = new Map<string, Group>();
  const countMissing = (state: Value["state"]) => {
    result[
      state === "pending"
        ? "pending"
        : state === "failed"
          ? "failed"
          : "missing"
    ]++;
  };
  for (const row of rows) {
    const group = chart.groupBy
      ? read(row, chart.groupBy, columns)
      : { state: "complete" as const, value: "All conversations" };
    const split = chart.splitBy
      ? read(row, chart.splitBy, columns)
      : { state: "complete" as const, value: undefined };
    if (group.state !== "complete" || split.state !== "complete") {
      countMissing(group.state !== "complete" ? group.state : split.state);
      continue;
    }
    const metric =
      chart.operation === "count"
        ? { state: "complete" as const, value: 1 }
        : read(row, chart.metric!, columns);
    const money = info(columns, chart.metric || "")?.type === "currency";
    const unit =
      money && metric.state === "complete"
        ? (metric.value as { currency: string }).currency
        : null;
    const groupValue =
      chart.groupBy && info(columns, chart.groupBy)?.type === "date"
        ? bucketDate(String(group.value), chart.bucket)
        : group.value;
    const key = JSON.stringify([groupValue, split.value ?? null, unit]);
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        key,
        label: label(groupValue),
        series: chart.splitBy ? label(split.value) : null,
        unit,
        rows: 0,
        values: 0,
        value: null,
        sum: 0,
        sort: typeof groupValue === "number" ? groupValue : label(groupValue),
      };
      groups.set(key, entry);
    }
    entry.rows++;
    if (metric.state !== "complete") {
      countMissing(metric.state);
      continue;
    }
    const value = money
      ? (metric.value as { amount: number }).amount
      : Number(metric.value);
    entry.values++;
    entry.sum += value;
    const total =
      chart.operation === "average" ? entry.sum / entry.values : entry.sum;
    entry.value = Number.isFinite(total) ? total : null;
    if (!Number.isFinite(total)) result.failed++;
  }
  result.groups = [...groups.values()]
    .sort((a, b) => {
      const group =
        typeof a.sort === "number" && typeof b.sort === "number"
          ? a.sort - b.sort
          : String(a.sort).localeCompare(String(b.sort));
      return (
        group ||
        (a.series || "").localeCompare(b.series || "") ||
        (a.unit || "").localeCompare(b.unit || "")
      );
    })
    .map(({ sum: _sum, sort: _sort, ...entry }) => entry);
  return result;
}
export function analyzeRun(run: Run, analysis: ReportAnalysis): AnalysisResult {
  const issue =
    analysis.filters.conditions
      .map((condition) => conditionIssue(condition, run.columns))
      .find(Boolean) || null;
  const counts = {
    available: 0,
    unavailable: 0,
    matched: 0,
    excluded: 0,
    unknown: 0,
  };
  const matched: Row[] = [];
  for (const row of run.rows) {
    if (row.unavailable) {
      counts.unavailable++;
      continue;
    }
    counts.available++;
    if (issue) {
      counts.unknown++;
      continue;
    }
    const values = analysis.filters.conditions.map((condition) =>
      predicate(row, condition, run.columns),
    );
    const matches = !values.length
      ? true
      : analysis.filters.logic === "all"
        ? values.includes(false)
          ? false
          : values.includes(null)
            ? null
            : true
        : values.includes(true)
          ? true
          : values.includes(null)
            ? null
            : false;
    if (matches === true) {
      counts.matched++;
      matched.push(row);
    } else if (matches === false) counts.excluded++;
    else counts.unknown++;
  }
  return {
    compatible: !issue,
    issue,
    counts,
    matchingRowIds: matched.map((row) => row.id),
    charts: analysis.charts.map((chart) =>
      chartResult(matched, run.columns, chart),
    ),
  };
}
