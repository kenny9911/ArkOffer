export type PublicReportValue =
  string | number | boolean | { amount: number; currency: string } | null;

/** The entire anonymous projection. Keep private IDs and evidence out of it. */
export type PublicReportPayload = {
  title: string;
  summary: string;
  columns: { name: string; type: string }[];
  rows: { label: string; values: PublicReportValue[] }[];
  completedAt: string;
  expiresAt: string;
  allowCsv: boolean;
};
