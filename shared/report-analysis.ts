/** Analysis works on already authorized result rows; it never starts extraction. */
export const metadataFields = [
  { id: "$createdAt", name: "Conversation created", type: "date" },
  { id: "$conversationDate", name: "Conversation date", type: "date" },
  { id: "$candidate", name: "Candidate", type: "text" },
  { id: "$interviewer", name: "Interviewer", type: "text" },
  { id: "$status", name: "Conversation status", type: "text" },
  { id: "$duration", name: "Duration (minutes)", type: "number" },
] as const;
export type AnalysisMetadata = {
  version: 1;
  createdAt: string | null;
  conversationDate: string | null;
  candidate: string | null;
  interviewer: string | null;
  status: string | null;
  duration: number | null;
};
export type AnalysisOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "is_missing"
  | "is_present";
export type AnalysisCondition = {
  id: string;
  field: string;
  operator: AnalysisOperator;
  value?: string | number | boolean;
  currency?: string;
};
export type AnalysisChart = {
  id: string;
  name: string;
  mode: "bar" | "line" | "stacked";
  groupBy: string | null;
  bucket: "day" | "week" | "month";
  splitBy: string | null;
  operation: "count" | "sum" | "average";
  metric: string | null;
};
export type ReportAnalysis = {
  filters: { logic: "all" | "any"; conditions: AnalysisCondition[] };
  charts: AnalysisChart[];
};
export const defaultAnalysis: ReportAnalysis = {
  filters: { logic: "all", conditions: [] },
  charts: [],
};
export type AnalysisResult = {
  compatible: boolean;
  issue: string | null;
  matchingRowIds: string[];
  counts: {
    available: number;
    unavailable: number;
    matched: number;
    excluded: number;
    unknown: number;
  };
  charts: {
    chart: AnalysisChart;
    compatible: boolean;
    issue: string | null;
    missing: number;
    pending: number;
    failed: number;
    groups: {
      key: string;
      label: string;
      series: string | null;
      unit: string | null;
      rows: number;
      values: number;
      value: number | null;
    }[];
  }[];
};
export function operatorsFor(type: string): AnalysisOperator[] {
  const common: AnalysisOperator[] = ["equals", "not_equals"];
  if (type === "text") common.push("contains", "not_contains");
  if (["number", "currency", "date"].includes(type))
    common.push("gt", "gte", "lt", "lte");
  return [...common, "is_missing", "is_present"];
}
