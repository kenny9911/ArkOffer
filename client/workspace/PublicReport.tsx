import { useEffect, useState } from "react";
import { Download, FileBarChart2 } from "lucide-react";
import type {
  PublicReportPayload,
  PublicReportValue,
} from "../../shared/public-report";
import "./public-report.css";

const displayValue = (value: PublicReportValue) =>
  value === null
    ? "Not documented"
    : typeof value === "boolean"
      ? value
        ? "Yes"
        : "No"
      : typeof value === "object"
        ? `${value.currency} ${value.amount.toLocaleString()}`
        : String(value);

export function PublicReportContents({
  report,
}: {
  report: PublicReportPayload;
}) {
  return (
    <>
      <header className="public-report-title">
        <span>Shared report</span>
        <h1>{report.title}</h1>
        {report.summary && (
          <p className="public-report-summary">{report.summary}</p>
        )}
        <p className="public-report-meta">
          Results completed {new Date(report.completedAt).toLocaleString()} ·
          Link expires {new Date(report.expiresAt).toLocaleString()}
        </p>
      </header>
      <div
        className="public-report-table-wrap"
        tabIndex={0}
        role="region"
        aria-label="Shared report results"
      >
        <table>
          <caption>
            {report.rows.length} selected conversation
            {report.rows.length === 1 ? "" : "s"} · {report.columns.length}{" "}
            selected column{report.columns.length === 1 ? "" : "s"}
          </caption>
          <thead>
            <tr>
              <th scope="col">Conversation</th>
              {report.columns.map((column, index) => (
                <th key={index} scope="col">
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row, index) => (
              <tr key={index}>
                <th scope="row">{row.label}</th>
                {row.values.map((value, cellIndex) => (
                  <td key={cellIndex}>{displayValue(value)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="public-report-note">
        This is a selected snapshot of AI-assisted report results. Missing
        information is marked “Not documented.” Results should be reviewed by a
        person before making decisions.
      </p>
    </>
  );
}

export default function PublicReport({ token }: { token: string }) {
  const [report, setReport] = useState<PublicReportPayload | null>(null),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setReport(null);
    setError("");
    if (!/^[a-f0-9]{64}$/.test(token)) {
      setError("This shared report is unavailable or has expired.");
      return () => controller.abort();
    }
    void fetch(`/api/public-reports/${token}`, {
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            result.error || "This shared report is unavailable or has expired.",
          );
        if (
          !result.report ||
          !Array.isArray(result.report.rows) ||
          !Array.isArray(result.report.columns)
        )
          throw new Error(
            "The shared report could not be loaded. Please try again.",
          );
        if (!controller.signal.aborted) setReport(result.report);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [token, retry]);
  return (
    <main className="public-report-page">
      <div className="public-report-brand">
        <FileBarChart2 size={23} />
        <strong>ArkOffer</strong>
        <span>Reports</span>
      </div>
      {error ? (
        <section className="public-report-empty">
          <h1>Report unavailable</h1>
          <p role="alert">{error}</p>
          <p>
            Ask the report owner for a new link if it has expired or been
            revoked.
          </p>
          <button onClick={() => setRetry((value) => value + 1)}>
            Try again
          </button>
        </section>
      ) : report ? (
        <article className="public-report-document">
          <PublicReportContents report={report} />
          {report.allowCsv && (
            <a
              className="public-report-download"
              href={`/api/public-reports/${token}/export.csv`}
              referrerPolicy="no-referrer"
              download
            >
              <Download size={16} />
              Download selected results as CSV
            </a>
          )}
        </article>
      ) : (
        <p className="public-report-empty" role="status">
          Loading shared report…
        </p>
      )}
      <footer className="public-report-footer">
        Shared through ArkOffer · Read-only report
      </footer>
    </main>
  );
}
