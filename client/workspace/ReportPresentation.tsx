import { useState } from "react";
type Presentation = {
  mode: "table" | "bar";
  groupBy: string | null;
  operation: "count" | "sum" | "average";
  metric: string | null;
};
export type Aggregation = {
  compatible: boolean;
  issue: string | null;
  presentation: Presentation;
  counts: {
    available: number;
    unavailable: number;
    grouped: number;
    groupNotDocumented: number;
    groupPending: number;
    groupFailed: number;
  };
  groups: {
    key: string;
    label: string;
    unit: string | null;
    rows: number;
    values: number;
    notDocumented: number;
    pending: number;
    failed: number;
    value: number | null;
  }[];
};
export const initialPresentation: Presentation = {
  mode: "table",
  groupBy: null,
  operation: "count",
  metric: null,
};
export default function ReportPresentation({
  viewId,
  revision,
  saved,
  columns,
  aggregation,
  runId,
  onSaved,
  onError,
}: {
  viewId: string;
  revision: number;
  saved: Presentation;
  columns: { id: string; name: string; type: string }[];
  aggregation?: Aggregation;
  runId?: string;
  onSaved: () => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState(saved),
    [busy, setBusy] = useState(false);
  const numeric = columns.filter((c) =>
    ["number", "currency"].includes(c.type),
  );
  const maxByUnit = new Map<string, number>();
  for (const group of aggregation?.groups || [])
    maxByUnit.set(
      group.unit || "",
      Math.max(
        maxByUnit.get(group.unit || "") || 0,
        Math.abs(group.value || 0),
      ),
    );
  return (
    <section className="report-presentation" aria-label="Report presentation">
      <h4>Presentation</h4>
      <p>
        Group existing answers and compare values. Saving presentation does not
        extract again or interrupt an active run.
      </p>
      <div className="report-presentation-controls">
        <label>
          Display
          <select
            value={draft.mode}
            onChange={(e) =>
              setDraft({
                ...draft,
                mode: e.target.value as Presentation["mode"],
              })
            }
          >
            <option value="table">Table</option>
            <option value="bar">Bar chart</option>
          </select>
        </label>
        <label>
          Group by
          <select
            value={draft.groupBy || ""}
            onChange={(e) =>
              setDraft({ ...draft, groupBy: e.target.value || null })
            }
          >
            <option value="">All conversations</option>
            {columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Calculation
          <select
            value={draft.operation}
            onChange={(e) => {
              const operation = e.target.value as Presentation["operation"];
              setDraft({
                ...draft,
                operation,
                metric:
                  operation === "count"
                    ? null
                    : draft.metric || numeric[0]?.id || null,
              });
            }}
          >
            <option value="count">Count conversations</option>
            <option value="sum" disabled={!numeric.length}>
              Sum
            </option>
            <option value="average" disabled={!numeric.length}>
              Average
            </option>
          </select>
        </label>
        {draft.operation !== "count" && (
          <label>
            Value column
            <select
              value={draft.metric || ""}
              onChange={(e) =>
                setDraft({ ...draft, metric: e.target.value || null })
              }
            >
              <option value="">Select a numeric column</option>
              {numeric.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          disabled={
            busy ||
            JSON.stringify(draft) === JSON.stringify(saved) ||
            (draft.operation !== "count" && !draft.metric)
          }
          onClick={async () => {
            setBusy(true);
            try {
              const response = await fetch(
                `/api/report-views/${viewId}/presentation`,
                {
                  method: "PATCH",
                  credentials: "same-origin",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    revision,
                    ...(runId ? { runId } : {}),
                    presentation: draft,
                  }),
                },
              );
              const result = await response.json();
              if (!response.ok)
                throw new Error(result.error || "Unable to save presentation.");
              await onSaved();
            } catch (e) {
              onError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Save presentation"}
        </button>
      </div>
      {aggregation &&
        (!aggregation.compatible ? (
          <p role="alert">
            {aggregation.issue} Historical results remain available in the
            evidence table.
          </p>
        ) : (
          <>
            <p className="report-aggregation-counts">
              {aggregation.counts.available} available conversations ·{" "}
              {aggregation.counts.unavailable} unavailable ·{" "}
              {aggregation.counts.grouped} grouped. Group values missing:{" "}
              {aggregation.counts.groupNotDocumented} not documented,{" "}
              {aggregation.counts.groupPending} pending,{" "}
              {aggregation.counts.groupFailed} failed.
            </p>
            <p className="ai-report-muted">
              Nulls, pending extractions and failed extractions never count as
              zero. Currencies are separate; chart scales are independent for
              each currency. Values reflect the selected historical run.
            </p>
            {aggregation.presentation.mode === "bar" && (
              <div
                className="report-bar-chart"
                role="img"
                aria-label="Grouped report bar chart; exact values in the following table"
              >
                {aggregation.groups.map((group) => (
                  <div className="report-bar-row" key={group.key}>
                    <span>
                      {group.label}
                      {group.unit ? ` (${group.unit})` : ""}
                    </span>
                    <div className="report-bar-track">
                      <span
                        className={
                          group.value !== null && group.value < 0
                            ? "negative"
                            : ""
                        }
                        style={{
                          width: `${(100 * Math.abs(group.value || 0)) / (maxByUnit.get(group.unit || "") || 1)}%`,
                        }}
                      />
                    </div>
                    <strong>
                      {group.value === null
                        ? "—"
                        : group.value.toLocaleString(undefined, {
                            maximumFractionDigits: 2,
                          })}
                    </strong>
                  </div>
                ))}
              </div>
            )}
            <div className="ai-report-table-scroll">
              <table aria-label="Grouped report values">
                <thead>
                  <tr>
                    <th>Group</th>
                    <th>Currency</th>
                    <th>
                      {aggregation.presentation.operation === "count"
                        ? "Conversations"
                        : aggregation.presentation.operation === "sum"
                          ? "Sum"
                          : "Average"}
                    </th>
                    <th>
                      {aggregation.presentation.operation === "count"
                        ? "Conversations counted"
                        : "Documented values"}
                    </th>
                    <th>Not documented</th>
                    <th>Pending</th>
                    <th>Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {aggregation.groups.length ? (
                    aggregation.groups.map((group) => (
                      <tr key={group.key}>
                        <th scope="row">{group.label}</th>
                        <td>{group.unit || "—"}</td>
                        <td>
                          {group.value === null
                            ? "Not documented"
                            : group.value.toLocaleString(undefined, {
                                maximumFractionDigits: 2,
                              })}
                        </td>
                        <td>{group.values}</td>
                        <td>{group.notDocumented}</td>
                        <td>{group.pending}</td>
                        <td>{group.failed}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7}>
                        No available, documented grouping values yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {runId && (
              <a
                className="business-button"
                href={`/api/report-views/${viewId}/runs/${runId}/grouped.csv`}
              >
                Export grouped CSV
              </a>
            )}
          </>
        ))}
    </section>
  );
}
