import { z } from "zod";

export const presentationSchema = z
  .object({
    mode: z.enum(["table", "bar"]),
    groupBy: z.string().max(64).nullable(),
    operation: z.enum(["count", "sum", "average"]),
    metric: z.string().max(64).nullable(),
  })
  .strict();
export type Presentation = z.infer<typeof presentationSchema>;
export const defaultPresentation: Presentation = {
  mode: "table",
  groupBy: null,
  operation: "count",
  metric: null,
};
type Column = { id: string; name: string; type: string };
type Cell = { columnId: string; status: string; value: unknown };
type PublicRun = {
  columns: Column[];
  rows: { unavailable?: boolean; cells: Cell[] }[];
};
export function presentationIssue(p: Presentation, columns: Column[]) {
  if (p.groupBy && !columns.some((c) => c.id === p.groupBy))
    return "The grouping column is absent from this run. Choose a compatible presentation.";
  if (p.operation === "count" && p.metric !== null)
    return "Conversation counts do not use a value column.";
  if (
    p.operation !== "count" &&
    !columns.some(
      (c) => c.id === p.metric && ["number", "currency"].includes(c.type),
    )
  )
    return "Sum and average need a number or currency column from this run.";
  return null;
}
const label = (value: unknown): string =>
  typeof value === "boolean"
    ? value
      ? "Yes"
      : "No"
    : typeof value === "object" && value !== null
      ? `${(value as { currency: string }).currency} ${(value as { amount: number }).amount}`
      : String(value);
function state(cell?: Cell) {
  if (!cell || ["queued", "processing"].includes(cell.status)) return "pending";
  if (
    cell.status === "not_documented" ||
    (cell.status === "complete" && cell.value === null)
  )
    return "notDocumented";
  return cell.status === "complete" ? "complete" : "failed";
}
/** Only accepts the already-authorized public run. Never read stored cells here. */
export function aggregateRun(run: PublicRun, presentation: Presentation) {
  const issue = presentationIssue(presentation, run.columns);
  const counts = {
    available: 0,
    unavailable: 0,
    grouped: 0,
    groupNotDocumented: 0,
    groupPending: 0,
    groupFailed: 0,
  };
  type Group = {
    key: string;
    label: string;
    unit: string | null;
    rows: number;
    values: number;
    notDocumented: number;
    pending: number;
    failed: number;
    value: number | null;
    sum: number;
  };
  const groups = new Map<string, Group>();
  if (issue)
    return {
      compatible: false,
      issue,
      counts,
      groups: [] as Omit<Group, "sum">[],
      presentation,
    };
  for (const row of run.rows) {
    if (row.unavailable) {
      counts.unavailable++;
      continue;
    }
    counts.available++;
    const groupCell = presentation.groupBy
      ? row.cells.find((c) => c.columnId === presentation.groupBy)
      : undefined;
    if (presentation.groupBy) {
      const status = state(groupCell);
      if (status !== "complete") {
        counts[
          status === "notDocumented"
            ? "groupNotDocumented"
            : status === "pending"
              ? "groupPending"
              : "groupFailed"
        ]++;
        continue;
      }
    }
    counts.grouped++;
    const metric =
      presentation.operation === "count"
        ? undefined
        : row.cells.find((c) => c.columnId === presentation.metric);
    const status =
      presentation.operation === "count" ? "complete" : state(metric);
    const currency =
      run.columns.find((c) => c.id === presentation.metric)?.type ===
      "currency";
    const value = metric?.value;
    const unit =
      currency && status === "complete"
        ? (value as { currency: string }).currency
        : null;
    // Unknown currency values form their own bucket; they are never silently attributed to USD or another currency.
    const groupLabel = presentation.groupBy
      ? label(groupCell!.value)
      : "All conversations";
    const key = JSON.stringify([
      presentation.groupBy ? groupCell!.value : null,
      unit,
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: groupLabel,
        unit,
        rows: 0,
        values: 0,
        notDocumented: 0,
        pending: 0,
        failed: 0,
        value: null,
        sum: 0,
      };
      groups.set(key, group);
    }
    group.rows++;
    if (status !== "complete") {
      group[status]++;
      continue;
    }
    const numeric =
      presentation.operation === "count"
        ? 1
        : currency
          ? (value as { amount: number }).amount
          : Number(value);
    if (!Number.isFinite(numeric)) {
      group.failed++;
      continue;
    }
    group.values++;
    group.sum += numeric;
    group.value =
      presentation.operation === "average"
        ? group.sum / group.values
        : group.sum;
    if (!Number.isFinite(group.value)) group.value = null;
  }
  return {
    compatible: true,
    issue: null,
    counts,
    presentation,
    groups: [...groups.values()].map(({ sum: _sum, ...group }) => group),
  };
}
