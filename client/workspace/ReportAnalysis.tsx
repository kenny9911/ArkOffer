import { useEffect, useRef, useState } from "react";
import { BarChart3, Plus, X } from "lucide-react";
import {
  metadataFields,
  operatorsFor,
  type AnalysisChart,
  type AnalysisCondition,
  type AnalysisOperator,
  type AnalysisResult,
  type ReportAnalysis as AnalysisDefinition,
} from "../../shared/report-analysis";
import "./report-analysis.css";

type Column = { id: string; name: string; type: string };
type ChartResult = AnalysisResult["charts"][number];
const operatorLabels: Record<AnalysisOperator, string> = {
  equals: "Equals",
  not_equals: "Does not equal",
  contains: "Contains",
  not_contains: "Does not contain",
  gt: "Greater than / after",
  gte: "At least / on or after",
  lt: "Less than / before",
  lte: "At most / on or before",
  is_missing: "Is not documented",
  is_present: "Is documented",
};
const colors = [
  "#725aab",
  "#347d83",
  "#bb7246",
  "#4474a6",
  "#ac5c84",
  "#768443",
];
const numberText = (value: number | null) =>
  value === null
    ? "Not documented"
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const fieldOptions = (columns: Column[]) => [...columns, ...metadataFields];
const defaultValue = (type: string): string | number | boolean =>
  type === "boolean" ? true : type === "number" || type === "currency" ? 0 : "";
function conditionFor(field: Column): AnalysisCondition {
  return {
    id: crypto.randomUUID(),
    field: field.id,
    operator: "equals",
    value: defaultValue(field.type),
    ...(field.type === "currency" ? { currency: "USD" } : {}),
  };
}
function ConditionEditor({
  condition,
  index,
  fields,
  onChange,
  onRemove,
}: {
  condition: AnalysisCondition;
  index: number;
  fields: Column[];
  onChange: (value: AnalysisCondition) => void;
  onRemove: () => void;
}) {
  const type =
    fields.find((field) => field.id === condition.field)?.type || "text";
  const hasValue = !["is_missing", "is_present"].includes(condition.operator);
  const prefix = `Result filter ${index + 1}`;
  return (
    <div className="report-analysis-condition">
      <label>
        Field
        <select
          aria-label={`${prefix} field`}
          value={condition.field}
          onChange={(e) => {
            const field = fields.find((item) => item.id === e.target.value)!;
            onChange({ ...conditionFor(field), id: condition.id });
          }}
        >
          {!fields.some((field) => field.id === condition.field) && (
            <option value={condition.field}>Unavailable field</option>
          )}
          {fields.map((field) => (
            <option key={field.id} value={field.id}>
              {field.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Condition
        <select
          aria-label={`${prefix} condition`}
          value={condition.operator}
          onChange={(e) => {
            const operator = e.target.value as AnalysisOperator;
            const { value: _value, currency: _currency, ...rest } = condition;
            onChange({
              ...rest,
              operator,
              ...(["is_missing", "is_present"].includes(operator)
                ? {}
                : {
                    value: condition.value ?? defaultValue(type),
                    ...(type === "currency"
                      ? { currency: condition.currency || "USD" }
                      : {}),
                  }),
            });
          }}
        >
          {operatorsFor(type).map((operator) => (
            <option key={operator} value={operator}>
              {operatorLabels[operator]}
            </option>
          ))}
        </select>
      </label>
      {hasValue && (
        <label>
          Value
          {type === "boolean" ? (
            <select
              aria-label={`${prefix} value`}
              value={String(condition.value)}
              onChange={(e) =>
                onChange({ ...condition, value: e.target.value === "true" })
              }
            >
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          ) : (
            <input
              aria-label={`${prefix} value`}
              type={
                type === "date"
                  ? "date"
                  : ["number", "currency"].includes(type)
                    ? "number"
                    : "text"
              }
              step="any"
              required
              maxLength={500}
              value={String(condition.value ?? "")}
              onChange={(e) =>
                onChange({
                  ...condition,
                  value: ["number", "currency"].includes(type)
                    ? e.target.value === ""
                      ? ""
                      : Number(e.target.value)
                    : e.target.value,
                })
              }
            />
          )}
        </label>
      )}
      {hasValue && type === "currency" && (
        <label>
          Currency
          <input
            aria-label={`${prefix} currency`}
            required
            pattern="[A-Z]{3}"
            maxLength={3}
            value={condition.currency || ""}
            onChange={(e) =>
              onChange({ ...condition, currency: e.target.value.toUpperCase() })
            }
            placeholder="USD"
          />
        </label>
      )}
      <button
        type="button"
        className="report-analysis-remove"
        aria-label={`Remove result filter ${index + 1}`}
        onClick={onRemove}
      >
        <X size={15} />
      </button>
    </div>
  );
}
function ChartEditor({
  chart,
  index,
  fields,
  onChange,
  onRemove,
}: {
  chart: AnalysisChart;
  index: number;
  fields: Column[];
  onChange: (value: AnalysisChart) => void;
  onRemove: () => void;
}) {
  const numeric = fields.filter((field) =>
    ["number", "currency"].includes(field.type),
  );
  const categories = fields.filter((field) =>
    ["text", "boolean"].includes(field.type),
  );
  const prefix = `Chart ${index + 1}`;
  return (
    <fieldset className="report-analysis-chart-editor">
      <legend>{prefix}</legend>
      <label>
        Name
        <input
          aria-label={`${prefix} name`}
          required
          maxLength={100}
          value={chart.name}
          onChange={(e) => onChange({ ...chart, name: e.target.value })}
        />
      </label>
      <label>
        Chart type
        <select
          aria-label={`${prefix} type`}
          value={chart.mode}
          onChange={(e) => {
            const mode = e.target.value as AnalysisChart["mode"];
            onChange({
              ...chart,
              mode,
              ...(mode === "stacked"
                ? {
                    splitBy: chart.splitBy || categories[0]?.id || null,
                    operation:
                      chart.operation === "average" ? "count" : chart.operation,
                    metric: chart.operation === "average" ? null : chart.metric,
                  }
                : {}),
            });
          }}
        >
          <option value="bar">Bar chart</option>
          <option value="line">Line chart</option>
          <option value="stacked">Stacked bar chart</option>
        </select>
      </label>
      <label>
        Group by
        <select
          aria-label={`${prefix} group by`}
          value={chart.groupBy || ""}
          onChange={(e) =>
            onChange({ ...chart, groupBy: e.target.value || null })
          }
        >
          <option value="">All matching conversations</option>
          {chart.groupBy &&
            !fields.some((field) => field.id === chart.groupBy) && (
              <option value={chart.groupBy}>Unavailable field</option>
            )}
          {fields.map((field) => (
            <option key={field.id} value={field.id}>
              {field.name}
            </option>
          ))}
        </select>
      </label>
      {fields.find((field) => field.id === chart.groupBy)?.type === "date" && (
        <label>
          Date interval
          <select
            aria-label={`${prefix} date interval`}
            value={chart.bucket}
            onChange={(e) =>
              onChange({
                ...chart,
                bucket: e.target.value as AnalysisChart["bucket"],
              })
            }
          >
            <option value="day">Day (UTC)</option>
            <option value="week">Week (Monday, UTC)</option>
            <option value="month">Month (UTC)</option>
          </select>
        </label>
      )}
      <label>
        Split by
        <select
          aria-label={`${prefix} split by`}
          required={chart.mode === "stacked"}
          value={chart.splitBy || ""}
          onChange={(e) =>
            onChange({ ...chart, splitBy: e.target.value || null })
          }
        >
          <option value="" disabled={chart.mode === "stacked"}>
            No split
          </option>
          {chart.splitBy &&
            !categories.some((field) => field.id === chart.splitBy) && (
              <option value={chart.splitBy}>Unavailable field</option>
            )}
          {categories.map((field) => (
            <option key={field.id} value={field.id}>
              {field.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Calculation
        <select
          aria-label={`${prefix} calculation`}
          value={chart.operation}
          onChange={(e) => {
            const operation = e.target.value as AnalysisChart["operation"];
            onChange({
              ...chart,
              operation,
              metric:
                operation === "count"
                  ? null
                  : chart.metric || numeric[0]?.id || null,
            });
          }}
        >
          <option value="count">Count conversations</option>
          <option value="sum" disabled={!numeric.length}>
            Sum
          </option>
          <option
            value="average"
            disabled={!numeric.length || chart.mode === "stacked"}
          >
            Average
          </option>
        </select>
      </label>
      {chart.operation !== "count" && (
        <label>
          Value
          <select
            aria-label={`${prefix} value`}
            required
            value={chart.metric || ""}
            onChange={(e) =>
              onChange({ ...chart, metric: e.target.value || null })
            }
          >
            <option value="">Select a numeric value</option>
            {chart.metric &&
              !numeric.some((field) => field.id === chart.metric) && (
                <option value={chart.metric}>Unavailable field</option>
              )}
            {numeric.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove chart ${index + 1}`}
      >
        <X size={14} /> Remove chart
      </button>
    </fieldset>
  );
}
function ChartGraphic({
  result,
  groups,
  unit,
}: {
  result: ChartResult;
  groups: ChartResult["groups"];
  unit: string | null;
}) {
  const labels = [...new Set(groups.map((group) => group.label))];
  const series = [...new Set(groups.map((group) => group.series || ""))];
  const allSeries = [
    ...new Set(result.groups.map((group) => group.series || "")),
  ];
  const color = (item: string) =>
    colors[allSeries.indexOf(item) % colors.length];
  const groupMap = new Map(
    groups.map((group) => [
      JSON.stringify([group.label, group.series || ""]),
      group,
    ]),
  );
  const lookup = (label: string, item: string) =>
    groupMap.get(JSON.stringify([label, item]));
  const stacked = result.chart.mode === "stacked";
  const low = Math.min(
    0,
    ...labels.map((label) =>
      stacked
        ? series.reduce(
            (sum, item) => sum + Math.min(0, lookup(label, item)?.value || 0),
            0,
          )
        : Math.min(0, ...series.map((item) => lookup(label, item)?.value || 0)),
    ),
  );
  const high = Math.max(
    1,
    ...labels.map((label) =>
      stacked
        ? series.reduce(
            (sum, item) => sum + Math.max(0, lookup(label, item)?.value || 0),
            0,
          )
        : Math.max(0, ...series.map((item) => lookup(label, item)?.value || 0)),
    ),
  );
  const range = high - low;
  if (
    !Number.isFinite(low) ||
    !Number.isFinite(high) ||
    !Number.isFinite(range) ||
    range <= 0
  ) {
    return (
      <p className="ai-report-muted">
        Values exceed chart display range. Use the exact values in the table or
        CSV.
      </p>
    );
  }
  const y = (value: number) => 216 - ((value - low) / range) * 182;
  const dated = metadataFields.some(
    (field) => field.id === result.chart.groupBy && field.type === "date",
  );
  const timestamps = labels.map((label) =>
    Date.parse(`${label}T00:00:00.000Z`),
  );
  const first = Math.min(...timestamps),
    last = Math.max(...timestamps);
  const datedAxis = dated && timestamps.every(Number.isFinite);
  const x = (i: number) =>
    datedAxis && last > first
      ? 92 + ((timestamps[i] - first) * 496) / (last - first)
      : 66 + (548 * (i + 0.5)) / Math.max(1, labels.length);
  const slot =
    labels.length > 1
      ? Math.min(...labels.slice(1).map((_, index) => x(index + 1) - x(index)))
      : 548;
  const contiguous = (previous: number, current: number) => {
    if (!datedAxis) return true;
    const next = new Date(timestamps[previous]);
    if (result.chart.bucket === "month")
      next.setUTCMonth(next.getUTCMonth() + 1);
    else
      next.setUTCDate(
        next.getUTCDate() + (result.chart.bucket === "week" ? 7 : 1),
      );
    return next.getTime() === timestamps[current];
  };
  return (
    <div className="report-analysis-plot">
      {unit && <h4>{unit}</h4>}
      <svg
        viewBox="0 0 650 270"
        role="img"
        aria-label={`${result.chart.name}${unit ? ` in ${unit}` : ""}, ${result.chart.mode === "line" ? "line chart" : stacked ? "stacked bar chart" : "bar chart"}; exact values in the following table`}
      >
        {[low, (low + high) / 2, high].map((value, index) => (
          <g key={index}>
            <line
              x1="66"
              x2="614"
              y1={y(value)}
              y2={y(value)}
              stroke="#e4e2e8"
            />
            <text
              x="58"
              y={y(value) + 4}
              textAnchor="end"
              fontSize="10"
              fill="#68646f"
            >
              {numberText(value)}
            </text>
          </g>
        ))}
        <line x1="66" x2="614" y1={y(0)} y2={y(0)} stroke="#99929e" />
        {result.chart.mode === "line"
          ? series.map((item) => {
              // A missing group breaks the line instead of suggesting an observed zero.
              const segments: { index: number; value: number }[][] = [];
              let segment: { index: number; value: number }[] = [];
              labels.forEach((label, index) => {
                const value = lookup(label, item)?.value;
                if (value === null || value === undefined) {
                  if (segment.length) segments.push(segment);
                  segment = [];
                } else {
                  if (
                    segment.length &&
                    !contiguous(segment[segment.length - 1].index, index)
                  ) {
                    segments.push(segment);
                    segment = [];
                  }
                  segment.push({ index, value });
                }
              });
              if (segment.length) segments.push(segment);
              return (
                <g key={item}>
                  {segments.map((points, i) => (
                    <polyline
                      key={i}
                      points={points
                        .map((point) => `${x(point.index)},${y(point.value)}`)
                        .join(" ")}
                      fill="none"
                      stroke={color(item)}
                      strokeWidth="2"
                    />
                  ))}
                  {labels.map((label, i) => {
                    const value = lookup(label, item)?.value;
                    return value === null || value === undefined ? null : (
                      <circle
                        key={label}
                        cx={x(i)}
                        cy={y(value)}
                        r="3.5"
                        fill={color(item)}
                      >
                        <title>
                          {label}
                          {item ? ` · ${item}` : ""}: {numberText(value)} {unit}
                        </title>
                      </circle>
                    );
                  })}
                </g>
              );
            })
          : labels.map((label, i) => {
              let positive = 0,
                negative = 0;
              return (
                <g key={label}>
                  {series.map((item, si) => {
                    const value = lookup(label, item)?.value;
                    if (value === null || value === undefined) return null;
                    const bottom = stacked
                      ? value >= 0
                        ? positive
                        : negative
                      : 0;
                    if (stacked) {
                      if (value >= 0) positive += value;
                      else negative += value;
                    }
                    const width = Math.max(
                      0.5,
                      Math.min(52, slot * 0.72) / (stacked ? 1 : series.length),
                    );
                    return (
                      <rect
                        key={item}
                        x={
                          stacked
                            ? x(i) - width / 2
                            : x(i) - (width * series.length) / 2 + si * width
                        }
                        y={Math.min(y(bottom), y(bottom + value))}
                        width={width}
                        height={Math.max(
                          value === 0 ? 0 : 1,
                          Math.abs(y(bottom) - y(bottom + value)),
                        )}
                        fill={color(item)}
                      >
                        <title>
                          {label}
                          {item ? ` · ${item}` : ""}: {numberText(value)} {unit}
                        </title>
                      </rect>
                    );
                  })}
                </g>
              );
            })}
        {labels.map((label, i) => (
          <text
            key={label}
            x={x(i)}
            y="242"
            textAnchor="middle"
            fontSize="10"
            fill="#68646f"
          >
            {labels.length > 8
              ? i + 1
              : label.length > 15
                ? `${label.slice(0, 14)}…`
                : label}
          </text>
        ))}
      </svg>
      {series.some(Boolean) && (
        <div className="report-analysis-legend">
          {series.map((item) => (
            <span key={item}>
              <i style={{ background: color(item) }} />
              {item || "All conversations"}
            </span>
          ))}
        </div>
      )}
      {labels.length > 8 && (
        <p className="ai-report-muted">
          Horizontal positions follow the group order in the table below.
        </p>
      )}
    </div>
  );
}
function ChartOutput({ result, path }: { result: ChartResult; path: string }) {
  const units = [...new Set(result.groups.map((group) => group.unit))];
  return (
    <article
      className="report-analysis-chart-result"
      aria-label={result.chart.name}
    >
      <header>
        <div>
          <h3>{result.chart.name}</h3>
          <p>
            {result.chart.operation === "count"
              ? "Count conversations"
              : result.chart.operation === "sum"
                ? "Sum"
                : "Average"}{" "}
            ·{" "}
            {result.chart.mode === "line"
              ? "Line chart"
              : result.chart.mode === "stacked"
                ? "Stacked bar chart"
                : "Bar chart"}
          </p>
        </div>
        {result.compatible && (
          <a
            className="report-button"
            href={`${path}/charts/${result.chart.id}.csv`}
          >
            Export chart CSV
          </a>
        )}
      </header>
      {!result.compatible ? (
        <p role="alert">{result.issue}</p>
      ) : (
        <>
          <p className="ai-report-muted">
            Excluded chart values: {result.missing} not documented ·{" "}
            {result.pending} pending · {result.failed} failed. Missing values
            are never treated as zero. Currencies use separate scales.
          </p>
          {units.map((unit) => (
            <ChartGraphic
              key={unit || "values"}
              result={result}
              groups={result.groups.filter((group) => group.unit === unit)}
              unit={unit}
            />
          ))}
          {result.chart.mode === "line" && (
            <p className="ai-report-muted">
              Date groups use a UTC time axis; missing date intervals break the
              line. Category groups follow table order and do not imply a time
              trend.
            </p>
          )}
          <div className="ai-report-table-scroll">
            <table aria-label={`${result.chart.name} values`}>
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Series</th>
                  <th>Currency</th>
                  <th>
                    {result.chart.operation === "count"
                      ? "Conversations"
                      : result.chart.operation === "sum"
                        ? "Sum"
                        : "Average"}
                  </th>
                  <th>Documented values</th>
                  <th>Conversations in group</th>
                </tr>
              </thead>
              <tbody>
                {result.groups.length ? (
                  result.groups.map((group) => (
                    <tr key={group.key}>
                      <th scope="row">{group.label}</th>
                      <td>{group.series || "—"}</td>
                      <td>{group.unit || "—"}</td>
                      <td>{numberText(group.value)}</td>
                      <td>{group.values}</td>
                      <td>{group.rows}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6}>
                      No matching, documented values for this chart.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </article>
  );
}
export default function ReportAnalysis({
  viewId,
  revision,
  saved,
  columns,
  result,
  runId,
  readOnly,
  open,
  onOpenChange,
  onSaved,
}: {
  viewId: string;
  revision: number;
  saved: AnalysisDefinition;
  columns: Column[];
  result?: AnalysisResult;
  runId?: string;
  readOnly: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(saved),
    [baseline, setBaseline] = useState({ analysis: saved, revision }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const fields = fieldOptions(columns),
    changed = JSON.stringify(draft) !== JSON.stringify(baseline.analysis),
    remoteChange = revision > baseline.revision;
  useEffect(() => {
    // Refresh clean settings only. Dirty edits retain their original optimistic-lock revision.
    if (
      !changed &&
      revision >= baseline.revision &&
      (revision !== baseline.revision ||
        JSON.stringify(saved) !== JSON.stringify(baseline.analysis))
    ) {
      setDraft(saved);
      setBaseline({ analysis: saved, revision });
    }
  }, [saved, revision, changed, baseline]);
  const discard = () => {
    setDraft(saved);
    setBaseline({ analysis: saved, revision });
    setError("");
  };
  const updateCondition = (id: string, value: AnalysisCondition) =>
    setDraft((current) => ({
      ...current,
      filters: {
        ...current.filters,
        conditions: current.filters.conditions.map((condition) =>
          condition.id === id ? value : condition,
        ),
      },
    }));
  return (
    <section className="report-analysis" aria-label="Advanced report analysis">
      <header>
        <div>
          <h2>
            <BarChart3 size={17} /> Result filters and charts
          </h2>
          <p>Explore extracted answers without running AI again.</p>
        </div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          {open ? "Hide analysis settings" : "Configure analysis"}
          {changed ? " · Unsaved" : ""}
        </button>
      </header>
      {open && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (readOnly || busy) return;
            setBusy(true);
            setError("");
            request.current?.abort();
            const controller = new AbortController();
            request.current = controller;
            try {
              const response = await fetch(
                `/api/report-views/${viewId}/analysis`,
                {
                  method: "PATCH",
                  credentials: "same-origin",
                  headers: { "Content-Type": "application/json" },
                  signal: controller.signal,
                  body: JSON.stringify({
                    revision: baseline.revision,
                    ...(runId ? { runId } : {}),
                    analysis: draft,
                  }),
                },
              );
              const data = await response.json();
              if (!response.ok)
                throw new Error(
                  data.error || "Unable to save result filters and charts.",
                );
              if (!controller.signal.aborted) {
                setDraft(data.item.analysis);
                setBaseline({
                  analysis: data.item.analysis,
                  revision: data.item.analysisRevision,
                });
                await onSaved();
              }
            } catch (cause) {
              if (!controller.signal.aborted)
                setError((cause as Error).message);
            } finally {
              if (!controller.signal.aborted) setBusy(false);
            }
          }}
        >
          <fieldset
            className="report-analysis-controls"
            disabled={readOnly || busy}
          >
            <legend>Analysis settings</legend>
            <p>
              These filters use answers and conversation details saved with the
              selected run. Older runs may lack conversation details.
              Access-removed rows stay hidden. Save to apply changes to the
              table, charts and filtered exports.
            </p>
            <div className="report-analysis-filter-heading">
              <h3>Result filters</h3>
              <label>
                Match
                <select
                  aria-label="Result filter logic"
                  value={draft.filters.logic}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      filters: {
                        ...draft.filters,
                        logic: e.target.value as "all" | "any",
                      },
                    })
                  }
                >
                  <option value="all">All conditions (AND)</option>
                  <option value="any">Any condition (OR)</option>
                </select>
              </label>
            </div>
            {draft.filters.conditions.map((condition, index) => (
              <ConditionEditor
                key={condition.id}
                condition={condition}
                index={index}
                fields={fields}
                onChange={(value) => updateCondition(condition.id, value)}
                onRemove={() =>
                  setDraft({
                    ...draft,
                    filters: {
                      ...draft.filters,
                      conditions: draft.filters.conditions.filter(
                        (item) => item.id !== condition.id,
                      ),
                    },
                  })
                }
              />
            ))}
            {!draft.filters.conditions.length && (
              <p className="ai-report-muted">
                All available conversations are included.
              </p>
            )}
            <button
              type="button"
              disabled={draft.filters.conditions.length >= 12}
              onClick={() =>
                setDraft({
                  ...draft,
                  filters: {
                    ...draft.filters,
                    conditions: [
                      ...draft.filters.conditions,
                      conditionFor(fields[0]),
                    ],
                  },
                })
              }
            >
              <Plus size={14} /> Add result filter
            </button>
            <div className="report-analysis-filter-heading">
              <h3>Named charts</h3>
              <span>{draft.charts.length} of 6</span>
            </div>
            <p className="ai-report-muted">
              Every chart uses these saved result filters. Date buckets use UTC;
              weeks start on Monday.
            </p>
            <div className="report-analysis-editors">
              {draft.charts.map((chart, index) => (
                <ChartEditor
                  key={chart.id}
                  chart={chart}
                  index={index}
                  fields={fields}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      charts: draft.charts.map((item) =>
                        item.id === chart.id ? value : item,
                      ),
                    })
                  }
                  onRemove={() =>
                    setDraft({
                      ...draft,
                      charts: draft.charts.filter(
                        (item) => item.id !== chart.id,
                      ),
                    })
                  }
                />
              ))}
            </div>
            <button
              type="button"
              disabled={draft.charts.length >= 6}
              onClick={() =>
                setDraft({
                  ...draft,
                  charts: [
                    ...draft.charts,
                    {
                      id: crypto.randomUUID(),
                      name: `Chart ${draft.charts.length + 1}`,
                      mode: "bar",
                      groupBy: null,
                      bucket: "month",
                      splitBy: null,
                      operation: "count",
                      metric: null,
                    },
                  ],
                })
              }
            >
              <Plus size={14} /> Add chart
            </button>
            <div className="report-analysis-save">
              <button
                type="submit"
                className="primary"
                disabled={!changed || busy}
              >
                {busy ? "Saving analysis…" : "Save analysis"}
              </button>
              <button
                type="button"
                disabled={!changed || busy}
                onClick={discard}
              >
                Discard analysis changes
              </button>
            </div>
          </fieldset>
          {remoteChange && changed && (
            <div className="report-analysis-conflict" role="alert">
              <p>
                The saved analysis changed in another edit. Your draft is
                preserved; saving requires the latest revision.
              </p>
              <button type="button" onClick={discard}>
                Discard edits and load latest analysis
              </button>
            </div>
          )}
          {readOnly && (
            <p>
              You can view this report’s analysis. An editor can change its
              filters and charts.
            </p>
          )}
          {error && (
            <p role="alert" className="ai-report-error">
              {error} Your unsaved settings are preserved.
            </p>
          )}
        </form>
      )}
      {result && !result.compatible && (
        <p role="alert">
          {result.issue} Filtered evidence is unavailable. Select “Show all
          available results” to inspect the accessible evidence without result
          filters.
        </p>
      )}
      {result && result.compatible && !!result.charts.length && (
        <div className="report-analysis-chart-results">
          {result.charts.map((chart) => (
            <ChartOutput
              key={chart.chart.id}
              result={chart}
              path={`/api/report-views/${viewId}/runs/${runId}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
