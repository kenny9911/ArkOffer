import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  BriefcaseBusiness,
  Check,
  CircleHelp,
  Copy,
  FileText,
  Hash,
  Mail,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import "./business.css";
import CandidateEnrichment from "./CandidateEnrichment";
import SequenceDelivery from "./SequenceDelivery";

type Item = {
  id: string;
  name?: string;
  title?: string;
  [key: string]: unknown;
};
type Step = { subject: string; body: string; delayDays: number };
type Question = {
  prompt: string;
  type: string;
  options: string[];
  required: boolean;
};
const str = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;
const label = (item: Item) => item.name || item.title || "Untitled";
const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";

async function request<T = { item: Item }>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    credentials: "same-origin",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : data.error?.message || `Request failed (${response.status})`,
    );
  return data as T;
}

function useResource(resource: string) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    request<{ items: Item[] }>(resource)
      .then((data) => {
        if (active) {
          setItems(data.items);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [resource, revision]);
  const save = async (data: Record<string, unknown>, id?: string) => {
    const result = await request(
      `${resource}${id ? `/${encodeURIComponent(id)}` : ""}`,
      id ? "PATCH" : "POST",
      data,
    );
    setItems((current) =>
      id
        ? current.map((item) => (item.id === id ? result.item : item))
        : [result.item, ...current],
    );
    return result.item;
  };
  const remove = async (id: string) => {
    await request(`${resource}/${encodeURIComponent(id)}`, "DELETE");
    setItems((current) => current.filter((item) => item.id !== id));
  };
  return {
    items,
    loading,
    error,
    save,
    remove,
    reload: () => setRevision((v) => v + 1),
  };
}

function Btn({
  children,
  secondary = false,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return (
    <button
      {...props}
      className={`business-button ${secondary ? "secondary" : ""} ${className}`}
    >
      {children}
    </button>
  );
}
function IconButton({
  label: accessibleLabel,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...props}
      type="button"
      className="business-icon-button"
      aria-label={accessibleLabel}
      title={accessibleLabel}
    >
      {children}
    </button>
  );
}
function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const dialog = ref.current;
    return () => {
      dialog?.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`business-dialog ${wide ? "wide" : ""}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={title}
    >
      <div className="business-dialog-heading">
        <h2>{title}</h2>
        <IconButton label="Close dialog" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
      {children}
    </dialog>
  );
}
function FormField({
  label: fieldLabel,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const generatedId = useId();
  const isControl = isValidElement<{
    id?: string;
    "aria-describedby"?: string;
  }>(children);
  const id = (isControl && children.props.id) || generatedId;
  return (
    <div className="business-field">
      <label htmlFor={id}>{fieldLabel}</label>
      {isControl
        ? cloneElement(children, {
            id,
            "aria-describedby": hint ? `${id}-hint` : undefined,
          })
        : children}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
function Alert({ children }: { children: ReactNode }) {
  return (
    <div className="business-alert" role="alert">
      {children}
    </div>
  );
}
function Empty({
  icon = <Users size={25} />,
  title,
  description,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="business-empty">
      <div className="business-empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
function Loading() {
  return (
    <div className="business-loading" role="status">
      Loading your workspace…
    </div>
  );
}
function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="business-search">
      <Search size={16} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
        >
          <X size={14} />
        </button>
      )}
    </label>
  );
}
function Badge({ value }: { value: string }) {
  return (
    <span className={`business-badge ${value.replace(/[^a-z]/g, "-")}`}>
      {value.replaceAll("_", " ")}
    </span>
  );
}
function Confirm({
  title,
  description,
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="business-dialog-copy">{description}</p>
      {error && <Alert>{error}</Alert>}
      <div className="business-dialog-actions">
        <Btn secondary onClick={onClose}>
          Cancel
        </Btn>
        <Btn
          className="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Deleting…" : "Delete"}
        </Btn>
      </div>
    </Dialog>
  );
}
function downloadCsv(filename: string, headers: string[], rows: unknown[][]) {
  const escape = (value: unknown) => {
    let text = String(value ?? "");
    // Treat formula-like cell values as text when opened in spreadsheet software.
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const blob = new Blob(
    [
      "\uFEFF",
      [headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n"),
    ],
    { type: "text/csv;charset=utf-8;" },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (!quoted && cell.length) {
        throw new Error("A CSV quote must start at the beginning of a cell.");
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error("The CSV contains an unclosed quoted field.");
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

function Candidates() {
  const candidates = useResource("candidates");
  const searches = useResource("searches");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [edit, setEdit] = useState<Item | "new" | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const [savingSearch, setSavingSearch] = useState(false);
  const [importRows, setImportRows] = useState<Record<string, string>[] | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter(
      (token) =>
        token &&
        ![
          "a",
          "an",
          "the",
          "in",
          "at",
          "with",
          "and",
          "for",
          "find",
          "me",
          "candidates",
          "candidate",
          "who",
          "are",
        ].includes(token),
    );
  const filtered = candidates.items.filter(
    (item) =>
      (status === "all" || str(item.status, "unreviewed") === status) &&
      tokens.every((token) =>
        [
          item.name,
          item.role,
          item.company,
          item.location,
          item.skills,
          item.email,
        ].some((value) => str(value).toLowerCase().includes(token)),
      ),
  );
  const selected = candidates.items.find((item) => item.id === detail);
  const act = async (action: () => Promise<unknown>, message = "") => {
    setError("");
    try {
      await action();
      setNotice(message);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    setError("");
    setNotice("");
    try {
      if (file.size > 5_000_000)
        throw new Error("Choose a CSV smaller than 5 MB.");
      const rows = parseCsv(await file.text());
      const headers =
        rows.shift()?.map((v) => v.toLowerCase().trim().replaceAll(" ", "_")) ||
        [];
      if (!headers.includes("name") && !headers.includes("full_name"))
        throw new Error(
          "Include a name column in your CSV. Optional columns: email, role, company, location, skills, profile, notes.",
        );
      if (rows.length > 1000)
        throw new Error("Import up to 1,000 candidates at a time.");
      const aliases: Record<string, string> = {
        full_name: "name",
        job_title: "role",
        linkedin: "profile",
        linkedin_url: "profile",
      };
      const records = rows.map((row, index) => {
        const record: Record<string, string> = {};
        headers.forEach((header, i) => {
          const key = aliases[header] || header;
          if (
            [
              "name",
              "email",
              "role",
              "company",
              "location",
              "skills",
              "profile",
              "notes",
            ].includes(key)
          )
            record[key] = (row[i] || "").trim();
        });
        if (!record.name)
          throw new Error(`Row ${index + 2} is missing a name.`);
        return record;
      });
      if (!records.length) throw new Error("The CSV has no candidate rows.");
      setImportRows(records);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  return (
    <div className="business">
      <div className="business-intro">
        <div>
          <h2>Your next great hire starts here.</h2>
          <p>Search and organize the people in your candidate library.</p>
        </div>
        <div className="business-actions">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => void importFile(e.target.files?.[0])}
          />
          <Btn secondary onClick={() => fileInput.current?.click()}>
            <Upload size={15} />
            Import CSV
          </Btn>
          <Btn onClick={() => setEdit("new")}>
            <Plus size={16} />
            Add candidate
          </Btn>
        </div>
      </div>
      <div className="business-source-search">
        <Sparkles size={21} />
        <input
          aria-label="Search your candidate library"
          placeholder="e.g. Software engineer in Singapore"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Btn
          secondary
          disabled={!query.trim()}
          onClick={() => setSavingSearch(true)}
        >
          Save search
        </Btn>
      </div>
      <p className="business-search-caption">
        Matches names, roles, companies, locations and skills in your saved
        candidates.
      </p>
      {!!searches.items.length && (
        <div className="business-saved-searches">
          <span>Saved searches</span>
          {searches.items.map((item) => (
            <div key={item.id}>
              <button
                onClick={() => {
                  setQuery(str(item.query));
                  setStatus(str(item.statusFilter, "all"));
                }}
              >
                {label(item)}
              </button>
              <button
                aria-label={`Delete saved search ${label(item)}`}
                onClick={() => void act(() => searches.remove(item.id))}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {(error || candidates.error) && (
        <Alert>{error || candidates.error}</Alert>
      )}
      {notice && (
        <div className="business-notice" role="status">
          {notice}
        </div>
      )}
      <div className="business-panel">
        <div className="business-panel-toolbar">
          <div className="business-tabs">
            {[
              ["all", "All candidates"],
              ["yes", "Yes"],
              ["maybe", "Maybe"],
              ["no", "No"],
            ].map(([value, text]) => (
              <button
                key={value}
                className={status === value ? "active" : ""}
                onClick={() => setStatus(value)}
              >
                {text}
                {value === "all" && <span>{candidates.items.length}</span>}
              </button>
            ))}
          </div>
          <span className="business-muted">
            {filtered.length} {filtered.length === 1 ? "person" : "people"}
          </span>
        </div>
        {candidates.loading ? (
          <Loading />
        ) : !filtered.length ? (
          <Empty
            title={
              candidates.items.length
                ? "No candidates match this search"
                : "A home for your candidate pipeline"
            }
            description={
              candidates.items.length
                ? "Try a different role, skill or location, or clear your filters."
                : "Add your first candidate or import a CSV to start building your talent library."
            }
          >
            {candidates.items.length ? (
              <Btn
                secondary
                onClick={() => {
                  setQuery("");
                  setStatus("all");
                }}
              >
                Clear filters
              </Btn>
            ) : (
              <Btn onClick={() => setEdit("new")}>
                <Plus size={15} />
                Add candidate
              </Btn>
            )}
          </Empty>
        ) : (
          <div className="business-table-scroll">
            <table className="business-table">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Current role</th>
                  <th>Location</th>
                  <th>Review</th>
                  <th>
                    <span className="business-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <button
                        className="business-person"
                        onClick={() => setDetail(item.id)}
                      >
                        <span className="business-avatar">
                          {label(item).slice(0, 1).toUpperCase()}
                        </span>
                        <span>
                          <strong>{label(item)}</strong>
                          <small>{str(item.email, "No email added")}</small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <strong>{str(item.role, "—")}</strong>
                      <small>{str(item.company)}</small>
                    </td>
                    <td>{str(item.location, "—")}</td>
                    <td>
                      <select
                        aria-label={`Review status for ${label(item)}`}
                        className="business-inline-select"
                        value={str(item.status, "unreviewed")}
                        onChange={(e) =>
                          void act(() =>
                            candidates.save(
                              { status: e.target.value },
                              item.id,
                            ),
                          )
                        }
                      >
                        <option value="unreviewed">Unreviewed</option>
                        <option value="yes">Yes</option>
                        <option value="maybe">Maybe</option>
                        <option value="no">No</option>
                      </select>
                    </td>
                    <td>
                      <div className="business-row-actions">
                        <IconButton
                          label={`Edit ${label(item)}`}
                          onClick={() => setEdit(item)}
                        >
                          <Pencil size={15} />
                        </IconButton>
                        <IconButton
                          label={`Delete ${label(item)}`}
                          onClick={() => setDeleting(item)}
                        >
                          <Trash2 size={15} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {edit && (
        <CandidateForm
          item={edit === "new" ? undefined : edit}
          onClose={() => setEdit(null)}
          onSave={async (data) => {
            await candidates.save(data, edit === "new" ? undefined : edit.id);
            setEdit(null);
          }}
        />
      )}
      {selected && (
        <Dialog title={label(selected)} onClose={() => setDetail(null)}>
          <div className="business-person-summary">
            <span className="business-avatar large">{label(selected)[0]}</span>
            <div>
              <h3>{str(selected.role, "Candidate")}</h3>
              <p>
                {[selected.company, selected.location]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <Badge value={str(selected.status, "unreviewed")} />
          </div>
          <div className="business-detail-grid">
            <div>
              <small>Email</small>
              <p>{str(selected.email, "Not added")}</p>
            </div>
            <div>
              <small>Profile</small>
              <p>
                {/^https?:\/\//i.test(str(selected.profile)) ? (
                  <a
                    href={str(selected.profile)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View profile ↗
                  </a>
                ) : (
                  "Not added"
                )}
              </p>
            </div>
          </div>
          <h4>Skills</h4>
          <div className="business-tags">
            {str(selected.skills).trim() ? (
              str(selected.skills)
                .split(",")
                .filter(Boolean)
                .map((skill, i) => <span key={i}>{skill.trim()}</span>)
            ) : (
              <span>No skills added</span>
            )}
          </div>
          <CandidateEnrichment
            candidate={selected}
            onApplied={() => candidates.reload()}
          />
          <h4>Notes</h4>
          <p className="business-pre-wrap">
            {str(selected.notes, "No notes yet.")}
          </p>
          <div className="business-dialog-actions">
            <Btn
              secondary
              onClick={() => {
                setDetail(null);
                setEdit(selected);
              }}
            >
              <Pencil size={15} />
              Edit candidate
            </Btn>
          </div>
        </Dialog>
      )}
      {savingSearch && (
        <SimpleNameDialog
          title="Save this search"
          defaultName={query}
          onClose={() => setSavingSearch(false)}
          onSave={async (name) => {
            await searches.save({ name, query, statusFilter: status });
            setSavingSearch(false);
          }}
        />
      )}
      {deleting && (
        <Confirm
          title="Delete candidate?"
          description={`${label(deleting)} will be removed from your library. Existing application and sequence records are kept.`}
          onClose={() => setDeleting(null)}
          onConfirm={() => candidates.remove(deleting.id)}
        />
      )}
      {importRows && (
        <Dialog
          title={`Import ${importRows.length} candidates`}
          onClose={() => {
            if (!busy) setImportRows(null);
          }}
          wide
        >
          <p className="business-dialog-copy">
            Review the first rows below. Candidates with an existing email
            address will be skipped.
          </p>
          <div className="business-table-scroll">
            <table className="business-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Company</th>
                </tr>
              </thead>
              <tbody>
                {importRows.slice(0, 5).map((row, i) => (
                  <tr key={i}>
                    <td>{row.name}</td>
                    <td>{row.email || "—"}</td>
                    <td>{row.role || "—"}</td>
                    <td>{row.company || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && <Alert>{error}</Alert>}
          <div className="business-dialog-actions">
            <Btn secondary disabled={busy} onClick={() => setImportRows(null)}>
              Cancel
            </Btn>
            <Btn
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                const emails = new Set(
                  candidates.items
                    .map((item) => str(item.email).toLowerCase())
                    .filter(Boolean),
                );
                let added = 0;
                let skipped = 0;
                let processed = 0;
                try {
                  for (const row of importRows) {
                    if (row.email && emails.has(row.email.toLowerCase())) {
                      skipped++;
                      processed++;
                      continue;
                    }
                    await candidates.save({ ...row, status: "unreviewed" });
                    added++;
                    processed++;
                    if (row.email) emails.add(row.email.toLowerCase());
                  }
                  setImportRows(null);
                  setNotice(
                    `Imported ${added} candidates${skipped ? `; skipped ${skipped} existing email addresses` : ""}.`,
                  );
                } catch (e) {
                  setImportRows(importRows.slice(processed));
                  setError(
                    `${added} candidates imported before an error: ${errorMessage(e)}. Imported candidates are saved; retry will continue with the remaining rows.`,
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Importing…" : "Import candidates"}
            </Btn>
          </div>
        </Dialog>
      )}
      <button
        className="business-text-link"
        onClick={() =>
          downloadCsv(
            "candidate-import-template.csv",
            [
              "name",
              "email",
              "role",
              "company",
              "location",
              "skills",
              "profile",
              "notes",
            ],
            [],
          )
        }
      >
        <ArrowDownToLine size={13} />
        Download CSV template
      </button>
    </div>
  );
}

function CandidateForm({
  item,
  onClose,
  onSave,
}: {
  item?: Item;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={item ? "Edit candidate" : "Add a candidate"}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(e.currentTarget));
          setBusy(true);
          try {
            await onSave(data);
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="business-form-grid">
          {[
            ["name", "Full name", "text"],
            ["email", "Email", "email"],
            ["role", "Current role", "text"],
            ["company", "Company", "text"],
            ["location", "Location", "text"],
            ["profile", "Profile URL", "url"],
          ].map(([key, text, type]) => (
            <FormField key={key} label={text}>
              <input
                name={key}
                type={type}
                required={key === "name"}
                defaultValue={str(item?.[key])}
                maxLength={500}
              />
            </FormField>
          ))}
        </div>
        <FormField label="Skills" hint="Separate skills with commas.">
          <input
            name="skills"
            defaultValue={str(item?.skills)}
            placeholder="React, product design, recruiting"
          />
        </FormField>
        <FormField label="Notes">
          <textarea name="notes" rows={4} defaultValue={str(item?.notes)} />
        </FormField>
        {error && <Alert>{error}</Alert>}
        <div className="business-dialog-actions">
          <Btn secondary type="button" onClick={onClose}>
            Cancel
          </Btn>
          <Btn disabled={busy}>{busy ? "Saving…" : "Save candidate"}</Btn>
        </div>
      </form>
    </Dialog>
  );
}
function SimpleNameDialog({
  title,
  defaultName = "",
  onClose,
  onSave,
}: {
  title: string;
  defaultName?: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const name = str(new FormData(e.currentTarget).get("name")).trim();
          if (!name) return;
          setBusy(true);
          try {
            await onSave(name);
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <FormField label="Name">
          <input
            name="name"
            required
            defaultValue={defaultName}
            maxLength={200}
          />
        </FormField>
        {error && <Alert>{error}</Alert>}
        <div className="business-dialog-actions">
          <Btn secondary type="button" onClick={onClose}>
            Cancel
          </Btn>
          <Btn disabled={busy}>{busy ? "Saving…" : "Save"}</Btn>
        </div>
      </form>
    </Dialog>
  );
}

function Sequences() {
  const sequences = useResource("sequences");
  const candidates = useResource("candidates");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const [enrolling, setEnrolling] = useState<Item | null>(null);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const [delivery, setDelivery] = useState<string | null>(null);
  const shown = sequences.items.filter((item) =>
    label(item).toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="business">
      <div className="business-intro">
        <div>
          <h2>Thoughtful outreach, one step at a time.</h2>
          <p>
            Build reusable outreach drafts and organize your candidate
            enrollments.
          </p>
        </div>
        <Btn onClick={() => setEditing("new")}>
          <Plus size={16} />
          Create sequence
        </Btn>
      </div>
      <div className="business-provider-note">
        <Mail size={17} />
        <span>
          <strong>Draft workspace</strong> — Drafts and enrollments are saved;
          messages are not sent. Open Delivery to review recipients and
          explicitly launch a schedule. Local outbox is the default until a
          sender is configured.
        </span>
      </div>
      <div className="business-panel">
        <div className="business-panel-toolbar">
          <h3>
            All sequences <span>{sequences.items.length}</span>
          </h3>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search sequences"
          />
        </div>
        {sequences.error && <Alert>{sequences.error}</Alert>}
        {sequences.loading ? (
          <Loading />
        ) : !shown.length ? (
          <Empty
            icon={<Mail size={25} />}
            title={
              query ? "No matching sequences" : "Make your first introduction"
            }
            description={
              query
                ? "Try another sequence name."
                : "Create a sequence with a personal introduction and follow-up steps."
            }
          >
            <Btn onClick={() => setEditing("new")}>
              <Plus size={15} />
              Create sequence
            </Btn>
          </Empty>
        ) : (
          <div className="business-table-scroll">
            <table className="business-table">
              <thead>
                <tr>
                  <th>Sequence</th>
                  <th>Status</th>
                  <th>Steps</th>
                  <th>Enrolled</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <button
                        className="business-link"
                        onClick={() => setEditing(item)}
                      >
                        {label(item)}
                      </button>
                      <small>{str(item.description)}</small>
                    </td>
                    <td>
                      <Badge value="draft" />
                    </td>
                    <td>{Array.isArray(item.steps) ? item.steps.length : 0}</td>
                    <td>{stringList(item.enrolledCandidateIds).length}</td>
                    <td>
                      <div className="business-row-actions">
                        <Btn secondary onClick={() => setDelivery(item.id)}>
                          Delivery
                        </Btn>
                        <Btn secondary onClick={() => setEnrolling(item)}>
                          Enroll candidates
                        </Btn>
                        <IconButton
                          label={`Edit ${label(item)}`}
                          onClick={() => setEditing(item)}
                        >
                          <Pencil size={15} />
                        </IconButton>
                        <IconButton
                          label={`Delete ${label(item)}`}
                          onClick={() => setDeleting(item)}
                        >
                          <Trash2 size={15} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && (
        <SequenceForm
          item={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={async (data) => {
            await sequences.save(
              data,
              editing === "new" ? undefined : editing.id,
            );
            setEditing(null);
          }}
        />
      )}
      {enrolling && (
        <EnrollmentDialog
          item={enrolling}
          candidates={candidates.items}
          loading={candidates.loading}
          loadError={candidates.error}
          onClose={() => setEnrolling(null)}
          onSave={async (ids) => {
            await sequences.save({ enrolledCandidateIds: ids }, enrolling.id);
            setEnrolling(null);
          }}
        />
      )}
      {delivery && (
        <SequenceDelivery
          sequenceId={delivery}
          onClose={() => setDelivery(null)}
        />
      )}
      {deleting && (
        <Confirm
          title="Delete sequence?"
          description={`Delete ${label(deleting)} and its draft steps? Candidate records will remain in your library.`}
          onClose={() => setDeleting(null)}
          onConfirm={() => sequences.remove(deleting.id)}
        />
      )}
    </div>
  );
}
function SequenceForm({
  item,
  onClose,
  onSave,
}: {
  item?: Item;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [steps, setSteps] = useState<Step[]>(
    Array.isArray(item?.steps) && item.steps.length
      ? (item.steps as Step[])
      : [{ subject: "", body: "", delayDays: 0 }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (index: number, data: Partial<Step>) =>
    setSteps((current) =>
      current.map((step, i) => (i === index ? { ...step, ...data } : step)),
    );
  return (
    <Dialog
      title={item ? "Edit sequence" : "Create sequence"}
      onClose={onClose}
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(e.currentTarget));
          setBusy(true);
          try {
            await onSave({ ...data, steps, status: "draft" });
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="business-form-grid">
          <FormField label="Sequence name">
            <input
              name="name"
              required
              defaultValue={item?.name}
              placeholder="Engineering outreach"
            />
          </FormField>
          <FormField label="Description">
            <input
              name="description"
              defaultValue={str(item?.description)}
              placeholder="Who is this sequence for?"
            />
          </FormField>
        </div>
        <div className="business-step-list">
          {steps.map((step, i) => (
            <div className="business-step" key={i}>
              <div className="business-step-heading">
                <span className="business-step-number">{i + 1}</span>
                <h4>{i === 0 ? "Introduction" : "Follow-up"}</h4>
                {steps.length > 1 && (
                  <IconButton
                    label={`Remove step ${i + 1}`}
                    onClick={() =>
                      setSteps((current) =>
                        current.filter((_, index) => index !== i),
                      )
                    }
                  >
                    <Trash2 size={15} />
                  </IconButton>
                )}
              </div>
              {i > 0 && (
                <FormField label="Days after the previous step">
                  <input
                    type="number"
                    min="1"
                    max="365"
                    required
                    value={step.delayDays}
                    onChange={(e) =>
                      update(i, { delayDays: Number(e.target.value) })
                    }
                  />
                </FormField>
              )}
              <FormField label="Subject">
                <input
                  required
                  value={step.subject}
                  onChange={(e) => update(i, { subject: e.target.value })}
                  placeholder="A new opportunity"
                />
              </FormField>
              <FormField label="Message">
                <textarea
                  required
                  rows={5}
                  value={step.body}
                  onChange={(e) => update(i, { body: e.target.value })}
                  placeholder="Write your message…"
                />
              </FormField>
            </div>
          ))}
        </div>
        <Btn
          secondary
          type="button"
          onClick={() =>
            setSteps((current) => [
              ...current,
              { subject: "", body: "", delayDays: 3 },
            ])
          }
        >
          <Plus size={15} />
          Add step
        </Btn>
        <p className="business-help">
          These messages remain drafts. Mailbox connection and a delivery
          provider are required to send them.
        </p>
        {error && <Alert>{error}</Alert>}
        <div className="business-dialog-actions">
          <Btn secondary type="button" onClick={onClose}>
            Cancel
          </Btn>
          <Btn disabled={busy}>{busy ? "Saving…" : "Save draft"}</Btn>
        </div>
      </form>
    </Dialog>
  );
}
function EnrollmentDialog({
  item,
  candidates,
  loading,
  loadError,
  onClose,
  onSave,
}: {
  item: Item;
  candidates: Item[];
  loading: boolean;
  loadError: string;
  onClose: () => void;
  onSave: (ids: string[]) => Promise<void>;
}) {
  const [ids, setIds] = useState<string[]>(
    stringList(item.enrolledCandidateIds),
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = new Set(ids);
  const shown = candidates.filter((candidate) =>
    `${label(candidate)} ${str(candidate.email)}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <Dialog title={`Enroll in ${label(item)}`} onClose={onClose}>
      <p className="business-dialog-copy">
        Save candidates to this draft sequence. No messages will be sent.
      </p>
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder="Find candidates"
      />
      {loadError && <Alert>{loadError}</Alert>}
      {loading ? (
        <Loading />
      ) : !candidates.length ? (
        <p className="business-help">
          Add candidates in Sourcing before enrolling them.
        </p>
      ) : (
        <div className="business-check-list">
          {shown.map((candidate) => (
            <label key={candidate.id}>
              <input
                type="checkbox"
                checked={selected.has(candidate.id)}
                onChange={(e) =>
                  setIds((current) =>
                    e.target.checked
                      ? [...current, candidate.id]
                      : current.filter((id) => id !== candidate.id),
                  )
                }
              />
              <span>
                <strong>{label(candidate)}</strong>
                <small>{str(candidate.email, "No email added")}</small>
              </span>
            </label>
          ))}
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      <div className="business-dialog-actions">
        <span className="business-muted">{ids.length} enrolled</span>
        <Btn secondary onClick={onClose}>
          Cancel
        </Btn>
        <Btn
          disabled={busy || loading || !!loadError}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(ids);
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Save enrollment"}
        </Btn>
      </div>
    </Dialog>
  );
}

const applicationStatuses = [
  "applied",
  "in_review",
  "shortlisted",
  "rejected",
  "hired",
];
function Applications() {
  const applications = useResource("applications");
  const candidates = useResource("candidates");
  const jobs = useResource("jobs");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [jobId, setJobId] = useState("all");
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const shown = applications.items.filter(
    (item) =>
      (status === "all" || str(item.status, "applied") === status) &&
      (jobId === "all" || item.jobId === jobId) &&
      `${label(item)} ${str(item.email)} ${str(item.jobTitle)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="business">
      <div className="business-intro">
        <div>
          <h2>Give every application a considered review.</h2>
          <p>
            Keep hiring decisions and feedback together, with people in control.
          </p>
        </div>
        <Btn onClick={() => setEditing("new")}>
          <Plus size={16} />
          Add application
        </Btn>
      </div>
      <div className="business-panel">
        <div className="business-panel-toolbar">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search applications"
          />
          <div className="business-actions">
            <select
              aria-label="Filter by job"
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
            >
              <option value="all">All jobs</option>
              {jobs.items.map((job) => (
                <option key={job.id} value={job.id}>
                  {label(job)}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by application status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="all">All statuses</option>
              {applicationStatuses.map((value) => (
                <option key={value} value={value}>
                  {value.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </div>
        </div>
        {applications.error && <Alert>{applications.error}</Alert>}
        {applications.loading ? (
          <Loading />
        ) : !shown.length ? (
          <Empty
            icon={<FileText size={25} />}
            title={
              applications.items.length
                ? "No applications match these filters"
                : "Your applications, in one place"
            }
            description={
              applications.items.length
                ? "Change your filters to see more applications."
                : "Add an application to review a candidate and record your decision."
            }
          >
            <Btn onClick={() => setEditing("new")}>
              <Plus size={15} />
              Add application
            </Btn>
          </Empty>
        ) : (
          <div className="business-table-scroll">
            <table className="business-table">
              <thead>
                <tr>
                  <th>Applicant</th>
                  <th>Job</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <button
                        className="business-person"
                        onClick={() => setEditing(item)}
                      >
                        <span className="business-avatar">
                          {label(item)[0]}
                        </span>
                        <span>
                          <strong>{label(item)}</strong>
                          <small>{str(item.email, "No email added")}</small>
                        </span>
                      </button>
                    </td>
                    <td>
                      {jobs.items.find((job) => job.id === item.jobId)?.title ||
                        str(item.jobTitle, "Unassigned")}
                    </td>
                    <td>{str(item.source, "Manual")}</td>
                    <td>
                      <Badge value={str(item.status, "applied")} />
                    </td>
                    <td>
                      <div className="business-row-actions">
                        <Btn secondary onClick={() => setEditing(item)}>
                          Review
                          <ArrowRight size={14} />
                        </Btn>
                        <IconButton
                          label={`Delete application from ${label(item)}`}
                          onClick={() => setDeleting(item)}
                        >
                          <Trash2 size={15} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="business-help">
        All statuses are set by your team. ArkOffer does not automatically rank
        or reject applicants.
      </p>
      {editing && (
        <ApplicationForm
          item={editing === "new" ? undefined : editing}
          candidates={candidates.items}
          jobs={jobs.items}
          onClose={() => setEditing(null)}
          onSave={async (data) => {
            await applications.save(
              data,
              editing === "new" ? undefined : editing.id,
            );
            setEditing(null);
          }}
        />
      )}
      {deleting && (
        <Confirm
          title="Delete application?"
          description={`Remove ${label(deleting)}’s application and its review notes? The candidate record is kept.`}
          onClose={() => setDeleting(null)}
          onConfirm={() => applications.remove(deleting.id)}
        />
      )}
    </div>
  );
}
function ApplicationForm({
  item,
  candidates,
  jobs,
  onClose,
  onSave,
}: {
  item?: Item;
  candidates: Item[];
  jobs: Item[];
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(item?.name || "");
  const [email, setEmail] = useState(str(item?.email));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      title={item ? `Review ${label(item)}` : "Add application"}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(e.currentTarget));
          const job = jobs.find((job) => job.id === data.jobId);
          setBusy(true);
          try {
            await onSave({
              ...data,
              name,
              email,
              jobTitle: job ? label(job) : "",
              reviewedAt: new Date().toISOString(),
            });
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {!item && !!candidates.length && (
          <FormField label="Use an existing candidate">
            <select
              name="candidateId"
              defaultValue=""
              onChange={(e) => {
                const candidate = candidates.find(
                  (value) => value.id === e.target.value,
                );
                if (candidate) {
                  setName(label(candidate));
                  setEmail(str(candidate.email));
                }
              }}
            >
              <option value="">Enter details manually</option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {label(candidate)}
                </option>
              ))}
            </select>
          </FormField>
        )}
        <div className="business-form-grid">
          <FormField label="Applicant name">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </FormField>
          <FormField label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </FormField>
          <FormField label="Job">
            <select name="jobId" defaultValue={str(item?.jobId)}>
              <option value="">Unassigned</option>
              {jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {label(job)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Source">
            <input name="source" defaultValue={str(item?.source, "Manual")} />
          </FormField>
        </div>
        <FormField label="Your decision">
          <select name="status" defaultValue={str(item?.status, "applied")}>
            {applicationStatuses.map((status) => (
              <option key={status} value={status}>
                {status.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </FormField>
        <FormField
          label="Review notes"
          hint="Record role-related observations and your reasoning."
        >
          <textarea
            name="notes"
            rows={5}
            defaultValue={str(item?.notes)}
            placeholder="Add your feedback…"
          />
        </FormField>
        {error && <Alert>{error}</Alert>}
        <div className="business-dialog-actions">
          <Btn secondary type="button" onClick={onClose}>
            Cancel
          </Btn>
          <Btn disabled={busy}>{busy ? "Saving…" : "Save review"}</Btn>
        </div>
      </form>
    </Dialog>
  );
}

function Screening() {
  const screenings = useResource("screenings");
  const jobs = useResource("jobs");
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const [preview, setPreview] = useState<Item | null>(null);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const [publishing, setPublishing] = useState<Item | null>(null);
  const [responses, setResponses] = useState<Item | null>(null);
  return (
    <div className="business">
      <div className="business-intro">
        <div>
          <h2>A consistent start to every conversation.</h2>
          <p>
            Create role-specific questions, share a candidate link and review
            responses with your team.
          </p>
        </div>
        <Btn onClick={() => setEditing("new")}>
          <Plus size={16} />
          Create screening
        </Btn>
      </div>
      <div className="business-provider-note">
        <CircleHelp size={17} />
        <span>
          Publish a separate link for each candidate. Links expire after seven
          days and accept one response. Share the link directly; no email is
          sent.
        </span>
      </div>
      {screenings.error && <Alert>{screenings.error}</Alert>}
      {screenings.loading ? (
        <Loading />
      ) : !screenings.items.length ? (
        <div className="business-panel">
          <Empty
            icon={<FileText size={25} />}
            title="Get to know candidates, your way"
            description="Build a reusable set of questions. Your team reviews responses and makes the decisions."
          >
            <Btn onClick={() => setEditing("new")}>
              <Plus size={15} />
              Create screening
            </Btn>
          </Empty>
        </div>
      ) : (
        <div className="business-card-grid">
          {screenings.items.map((item) => (
            <div className="business-card" key={item.id}>
              <div className="business-card-top">
                <div className="business-card-icon">
                  <FileText size={20} />
                </div>
                <Badge value="questionnaire" />
              </div>
              <h3>{label(item)}</h3>
              <p>
                {str(
                  item.description,
                  "A screening questionnaire for your hiring process.",
                )}
              </p>
              <div className="business-card-meta">
                <span>
                  {Array.isArray(item.questions) ? item.questions.length : 0}{" "}
                  questions
                </span>
                <span>
                  {jobs.items.find((job) => job.id === item.jobId)?.title ||
                    "Any role"}
                </span>
              </div>
              <div className="business-card-actions">
                <Btn onClick={() => setPublishing(item)}>Publish</Btn>
                <Btn secondary onClick={() => setResponses(item)}>
                  Responses
                </Btn>
                <Btn secondary onClick={() => setPreview(item)}>
                  Preview
                </Btn>
                <Btn secondary onClick={() => setEditing(item)}>
                  Edit
                </Btn>
                <IconButton
                  label={`Delete ${label(item)}`}
                  onClick={() => setDeleting(item)}
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <ScreeningForm
          item={editing === "new" ? undefined : editing}
          jobs={jobs.items}
          onClose={() => setEditing(null)}
          onSave={async (data) => {
            await screenings.save(
              data,
              editing === "new" ? undefined : editing.id,
            );
            setEditing(null);
          }}
        />
      )}
      {preview && (
        <ScreeningPreview item={preview} onClose={() => setPreview(null)} />
      )}
      {publishing && (
        <ScreeningPublicationDialog
          item={publishing}
          onClose={() => setPublishing(null)}
        />
      )}
      {responses && (
        <ScreeningResponses
          item={responses}
          onClose={() => setResponses(null)}
        />
      )}
      {deleting && (
        <Confirm
          title="Delete screening?"
          description={`Delete ${label(deleting)}, all its candidate links and collected responses? This cannot be undone.`}
          onClose={() => setDeleting(null)}
          onConfirm={() => screenings.remove(deleting.id)}
        />
      )}
    </div>
  );
}
type Publication = {
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  submittedAt?: string;
  status: string;
};
type ScreeningResponse = {
  id: string;
  publicationId: string;
  candidateName: string;
  email: string;
  submittedAt: string;
  consentAt: string;
  answers: {
    questionId: string;
    prompt: string;
    type: string;
    value: string;
    voiceEvidence?: {
      originalTranscript: string;
      durationMs: number;
      transcribedAt: string;
      candidateEdited: boolean;
    };
  }[];
};
function ScreeningPublicationDialog({
  item,
  onClose,
}: {
  item: Item;
  onClose: () => void;
}) {
  const [published, setPublished] = useState<{
    id: string;
    url: string;
    expiresAt: string;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [copied, setCopied] = useState(false);
  const linkInput = useRef<HTMLInputElement>(null);
  const url = published
    ? new URL(published.url, window.location.origin).href
    : "";
  return (
    <Dialog title={`Publish ${label(item)}`} onClose={onClose}>
      {published ? (
        <>
          <div className="business-notice" role="status">
            Candidate link created. It accepts one response and expires on{" "}
            {new Date(published.expiresAt).toLocaleDateString()}.
          </div>
          <FormField
            label="Candidate link"
            hint="Copy this link now. It is only shown when created."
          >
            <input
              ref={linkInput}
              readOnly
              value={url}
              onFocus={(event) => event.target.select()}
            />
          </FormField>
          <p className="business-dialog-copy">
            Anyone who holds this link can view the questionnaire and submit a
            response. Share it only with its intended candidate. You can revoke
            the link in Responses.
          </p>
          <div className="business-actions">
            <Btn
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  setCopied(true);
                  setError("");
                } catch {
                  linkInput.current?.focus();
                  linkInput.current?.select();
                  setError(
                    "Copy is unavailable in this browser. Select and copy the link above.",
                  );
                }
              }}
            >
              <Copy size={14} />
              {copied ? "Copied" : "Copy candidate link"}
            </Btn>
            <a
              className="business-button secondary"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              Open candidate page
              <ArrowRight size={14} />
            </a>
          </div>
        </>
      ) : (
        <>
          <p className="business-dialog-copy">
            Create a link for one candidate to complete this questionnaire
            without signing in. Their name, email and answers will be collected
            only after they acknowledge sharing them with your hiring team.
          </p>
          <div className="business-publication-summary">
            <strong>{label(item)}</strong>
            <span>
              {Array.isArray(item.questions) ? item.questions.length : 0}{" "}
              questions · Available for 7 days · One response
            </span>
          </div>
          <p className="business-help">
            The link publishes a copy of these questions. Later edits do not
            change existing links. Create a new link for each candidate and
            share it yourself.
          </p>
        </>
      )}
      {error && <Alert>{error}</Alert>}
      <div className="business-dialog-actions">
        <Btn secondary onClick={onClose}>
          {published ? "Done" : "Cancel"}
        </Btn>
        {!published && (
          <Btn
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const result = await request<{
                  item: { id: string; url: string; expiresAt: string };
                }>(
                  `screenings/${encodeURIComponent(item.id)}/publish`,
                  "POST",
                  {},
                );
                setPublished(result.item);
              } catch (cause) {
                setError(errorMessage(cause));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Creating…" : "Create candidate link"}
          </Btn>
        )}
      </div>
    </Dialog>
  );
}
function ScreeningResponses({
  item,
  onClose,
}: {
  item: Item;
  onClose: () => void;
}) {
  const [responses, setResponses] = useState<ScreeningResponse[]>([]),
    [publications, setPublications] = useState<Publication[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [revoking, setRevoking] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    request<{ items: ScreeningResponse[]; publications: Publication[] }>(
      `screenings/${encodeURIComponent(item.id)}/responses`,
    )
      .then((data) => {
        if (active) {
          setResponses(data.items);
          setPublications(data.publications);
          setError("");
        }
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [item.id, revision]);
  return (
    <Dialog title={`Responses · ${label(item)}`} onClose={onClose} wide>
      <div className="business-response-heading">
        <p>Read candidates’ answers and manage access to published links.</p>
        <Btn
          secondary
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh
        </Btn>
      </div>
      {error && <Alert>{error}</Alert>}
      {loading ? (
        <Loading />
      ) : (
        <>
          <h3 className="business-response-section">
            Candidate responses <span>{responses.length}</span>
          </h3>
          {!responses.length ? (
            <p className="business-help">
              No responses yet. Publish a candidate link and share it to collect
              a response.
            </p>
          ) : (
            <div className="business-response-list">
              {responses.map((response) => (
                <details className="business-response" key={response.id}>
                  <summary>
                    <span>
                      <strong>{response.candidateName}</strong>
                      <small>{response.email}</small>
                    </span>
                    <time dateTime={response.submittedAt}>
                      {new Date(response.submittedAt).toLocaleString()}
                    </time>
                  </summary>
                  <div className="business-response-answers">
                    {response.answers.map((answer, index) => (
                      <div key={answer.questionId}>
                        <h4>
                          {index + 1}. {answer.prompt}
                        </h4>
                        <p>
                          {answer.value || "No answer provided (optional)."}
                        </p>
                        {answer.voiceEvidence && (
                          <details>
                            <summary>
                              Voice transcript ·{" "}
                              {Math.round(
                                answer.voiceEvidence.durationMs / 1000,
                              )}{" "}
                              seconds
                              {answer.voiceEvidence.candidateEdited
                                ? " · candidate corrected"
                                : ""}
                            </summary>
                            <p>{answer.voiceEvidence.originalTranscript}</p>
                            <small>
                              Transcribed{" "}
                              {new Date(
                                answer.voiceEvidence.transcribedAt,
                              ).toLocaleString()}
                              . The submitted answer above is the candidate’s
                              reviewed response.
                            </small>
                          </details>
                        )}
                      </div>
                    ))}
                    <p className="business-help">
                      Candidate acknowledged sharing these responses on{" "}
                      {new Date(response.consentAt).toLocaleString()}. Your team
                      makes the review decision.
                    </p>
                  </div>
                </details>
              ))}
            </div>
          )}
          <h3 className="business-response-section">
            Candidate links <span>{publications.length}</span>
          </h3>
          {!publications.length ? (
            <p className="business-help">
              No candidate links have been created.
            </p>
          ) : (
            <div className="business-publication-list">
              {publications.map((publication, index) => (
                <div key={publication.id}>
                  <div>
                    <strong>
                      Candidate link {publications.length - index}
                    </strong>
                    <small>
                      Created{" "}
                      {new Date(publication.createdAt).toLocaleDateString()} ·
                      Expires{" "}
                      {new Date(publication.expiresAt).toLocaleDateString()}
                    </small>
                  </div>
                  <Badge value={publication.status} />
                  {["active", "completed"].includes(publication.status) && (
                    <Btn secondary onClick={() => setRevoking(publication.id)}>
                      Revoke link
                    </Btn>
                  )}
                </div>
              ))}
            </div>
          )}
          {revoking && (
            <div className="business-revoke-confirm">
              <p>
                Revoke this candidate link? It will stop opening immediately.
                Existing responses remain available to your team.
              </p>
              <div className="business-actions">
                <Btn
                  secondary
                  disabled={busy}
                  onClick={() => setRevoking(null)}
                >
                  Cancel
                </Btn>
                <Btn
                  className="danger"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await request(
                        `screenings/${encodeURIComponent(item.id)}/publications/${encodeURIComponent(revoking)}`,
                        "DELETE",
                      );
                      setRevoking(null);
                      setRevision((value) => value + 1);
                    } catch (cause) {
                      setError(errorMessage(cause));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Revoking…" : "Confirm revoke"}
                </Btn>
              </div>
            </div>
          )}
        </>
      )}
      <div className="business-dialog-actions">
        <Btn secondary onClick={onClose}>
          Close
        </Btn>
      </div>
    </Dialog>
  );
}
function ScreeningForm({
  item,
  jobs,
  onClose,
  onSave,
}: {
  item?: Item;
  jobs: Item[];
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [questions, setQuestions] = useState<Question[]>(
    Array.isArray(item?.questions)
      ? (item.questions as Question[])
      : [{ prompt: "", type: "text", options: [], required: true }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (index: number, data: Partial<Question>) =>
    setQuestions((current) =>
      current.map((question, i) =>
        i === index ? { ...question, ...data } : question,
      ),
    );
  return (
    <Dialog
      title={item ? "Edit screening" : "Create screening"}
      onClose={onClose}
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!questions.length) {
            setError("Add at least one question.");
            return;
          }
          if (
            questions.some(
              (q) =>
                q.type === "multiple-choice" &&
                q.options.filter((v) => v.trim()).length < 2,
            )
          ) {
            setError("Multiple-choice questions need at least two options.");
            return;
          }
          const data = Object.fromEntries(new FormData(e.currentTarget));
          setBusy(true);
          try {
            await onSave({
              ...data,
              name: data.title,
              questions: questions.map((q) => ({
                ...q,
                options: q.options.map((o) => o.trim()).filter(Boolean),
              })),
              status: "draft",
            });
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="business-form-grid">
          <FormField label="Screening title">
            <input
              name="title"
              required
              defaultValue={item?.title || item?.name}
              placeholder="Introductory questions"
            />
          </FormField>
          <FormField label="Job">
            <select name="jobId" defaultValue={str(item?.jobId)}>
              <option value="">Any role</option>
              {jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {label(job)}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <FormField label="Introduction for candidates">
          <textarea
            name="description"
            rows={2}
            defaultValue={str(item?.description)}
            placeholder="Tell candidates what to expect."
          />
        </FormField>
        <div className="business-step-list">
          {questions.map((question, i) => (
            <div className="business-step" key={i}>
              <div className="business-step-heading">
                <span className="business-step-number">{i + 1}</span>
                <h4>Question</h4>
                <IconButton
                  label={`Remove question ${i + 1}`}
                  onClick={() =>
                    setQuestions((current) =>
                      current.filter((_, index) => i !== index),
                    )
                  }
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
              <FormField label="Question text">
                <textarea
                  required
                  rows={2}
                  value={question.prompt}
                  onChange={(e) => update(i, { prompt: e.target.value })}
                  placeholder="What interests you about this role?"
                />
              </FormField>
              <div className="business-form-grid">
                <FormField label="Answer type">
                  <select
                    value={question.type}
                    onChange={(e) => update(i, { type: e.target.value })}
                  >
                    <option value="text">Written answer</option>
                    <option value="yes-no">Yes / No</option>
                    <option value="multiple-choice">Multiple choice</option>
                  </select>
                </FormField>
                <label className="business-checkbox">
                  <input
                    type="checkbox"
                    checked={question.required}
                    onChange={(e) => update(i, { required: e.target.checked })}
                  />
                  Required question
                </label>
              </div>
              {question.type === "multiple-choice" && (
                <FormField
                  label="Answer options"
                  hint="Enter one option per line."
                >
                  <textarea
                    required
                    rows={3}
                    value={question.options.join("\n")}
                    onChange={(e) =>
                      update(i, { options: e.target.value.split("\n") })
                    }
                  />
                </FormField>
              )}
            </div>
          ))}
        </div>
        <Btn
          secondary
          type="button"
          onClick={() =>
            setQuestions((current) => [
              ...current,
              { prompt: "", type: "text", options: [], required: true },
            ])
          }
        >
          <Plus size={15} />
          Add question
        </Btn>
        {error && <Alert>{error}</Alert>}
        <div className="business-dialog-actions">
          <Btn secondary type="button" onClick={onClose}>
            Cancel
          </Btn>
          <Btn disabled={busy}>{busy ? "Saving…" : "Save draft"}</Btn>
        </div>
      </form>
    </Dialog>
  );
}
function ScreeningPreview({
  item,
  onClose,
}: {
  item: Item;
  onClose: () => void;
}) {
  const [complete, setComplete] = useState(false);
  const questions = Array.isArray(item.questions)
    ? (item.questions as Question[])
    : [];
  return (
    <Dialog title="Candidate preview" onClose={onClose}>
      <div className="business-preview-brand">
        ArkOffer<span>SCREENING PREVIEW</span>
      </div>
      <h2 className="business-preview-title">{label(item)}</h2>
      <p className="business-dialog-copy">{str(item.description)}</p>
      {complete ? (
        <div className="business-preview-complete">
          <Check size={26} />
          <h3>Preview complete</h3>
          <p>
            This was a preview. Your responses have not been collected or saved.
          </p>
          <Btn secondary onClick={() => setComplete(false)}>
            Try again
          </Btn>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setComplete(true);
          }}
        >
          {questions.map((question, i) => (
            <FormField
              key={i}
              label={`${i + 1}. ${question.prompt}${question.required ? " *" : ""}`}
            >
              {question.type === "text" ? (
                <textarea rows={4} required={question.required} />
              ) : (
                <select defaultValue="" required={question.required}>
                  <option value="" disabled>
                    Select an answer
                  </option>
                  {(question.type === "yes-no"
                    ? ["Yes", "No"]
                    : question.options
                  ).map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              )}
            </FormField>
          ))}
          <p className="business-help">Preview only · Answers are not saved.</p>
          <div className="business-dialog-actions">
            <Btn type="submit">
              Finish preview
              <ArrowRight size={14} />
            </Btn>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function Jobs() {
  const jobs = useResource("jobs");
  const applications = useResource("applications");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const [preview, setPreview] = useState<Item | null>(null);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const shown = jobs.items.filter(
    (job) =>
      (filter === "all" || str(job.status, "draft") === filter) &&
      `${label(job)} ${str(job.department)} ${str(job.location)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="business">
      <div className="business-intro">
        <div>
          <h2>Make the next opportunity a clear one.</h2>
          <p>Write job descriptions and keep your open roles organized.</p>
        </div>
        <Btn onClick={() => setEditing("new")}>
          <Plus size={16} />
          Create job post
        </Btn>
      </div>
      <div className="business-panel">
        <div className="business-panel-toolbar">
          <div className="business-tabs">
            {["all", "open", "draft", "closed"].map((value) => (
              <button
                key={value}
                className={filter === value ? "active" : ""}
                onClick={() => setFilter(value)}
              >
                {value === "all"
                  ? "All jobs"
                  : value[0].toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search jobs"
          />
        </div>
        {jobs.error && <Alert>{jobs.error}</Alert>}
        {jobs.loading ? (
          <Loading />
        ) : !shown.length ? (
          <Empty
            icon={<BriefcaseBusiness size={25} />}
            title={
              jobs.items.length
                ? "No jobs match these filters"
                : "Your next hire needs a great introduction"
            }
            description={
              jobs.items.length
                ? "Try another status or search term."
                : "Create a job post to capture the role, responsibilities and what success looks like."
            }
          >
            <Btn onClick={() => setEditing("new")}>
              <Plus size={15} />
              Create job post
            </Btn>
          </Empty>
        ) : (
          <div className="business-job-list">
            {shown.map((job) => (
              <div className="business-job-row" key={job.id}>
                <div className="business-card-icon">
                  <BriefcaseBusiness size={20} />
                </div>
                <div className="business-job-info">
                  <button
                    className="business-link"
                    onClick={() => setPreview(job)}
                  >
                    {label(job)}
                  </button>
                  <p>
                    {[job.department, job.location, job.employmentType]
                      .filter(Boolean)
                      .join(" · ") || "Details not added yet"}
                  </p>
                </div>
                <span className="business-muted">
                  {
                    applications.items.filter((item) => item.jobId === job.id)
                      .length
                  }{" "}
                  applications
                </span>
                <Badge value={str(job.status, "draft")} />
                <div className="business-row-actions">
                  <IconButton
                    label={`Edit ${label(job)}`}
                    onClick={() => setEditing(job)}
                  >
                    <Pencil size={15} />
                  </IconButton>
                  <IconButton
                    label={`Delete ${label(job)}`}
                    onClick={() => setDeleting(job)}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="business-help">
        Job posts are stored in this workspace. External job board publishing
        requires a configured integration.
      </p>
      {editing && (
        <JobForm
          item={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={async (data) => {
            await jobs.save(data, editing === "new" ? undefined : editing.id);
            setEditing(null);
          }}
        />
      )}
      {preview && (
        <Dialog title="Job post preview" onClose={() => setPreview(null)} wide>
          <div className="business-job-preview">
            <span className="business-eyebrow">ARKOFFER · CAREERS</span>
            <h2>{label(preview)}</h2>
            <p>
              {[preview.location, preview.employmentType, preview.department]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {!!preview.salary && <p>{str(preview.salary)}</p>}
            <hr />
            <div className="business-pre-wrap">
              {str(preview.description, "No job description added yet.")}
            </div>
          </div>
          <div className="business-dialog-actions">
            <Btn
              secondary
              onClick={() => {
                setEditing(preview);
                setPreview(null);
              }}
            >
              <Pencil size={15} />
              Edit job post
            </Btn>
          </div>
        </Dialog>
      )}
      {deleting && (
        <Confirm
          title="Delete job post?"
          description={`Delete ${label(deleting)}? Existing applications are retained with their saved job title.`}
          onClose={() => setDeleting(null)}
          onConfirm={() => jobs.remove(deleting.id)}
        />
      )}
    </div>
  );
}
function JobForm({
  item,
  onClose,
  onSave,
}: {
  item?: Item;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      title={item ? "Edit job post" : "Create job post"}
      onClose={onClose}
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(e.currentTarget));
          setBusy(true);
          try {
            await onSave(data);
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <FormField label="Job title">
          <input
            name="title"
            required
            defaultValue={item?.title || item?.name}
            placeholder="Senior Product Designer"
          />
        </FormField>
        <div className="business-form-grid">
          <FormField label="Department">
            <input
              name="department"
              defaultValue={str(item?.department)}
              placeholder="Design"
            />
          </FormField>
          <FormField label="Location">
            <input
              name="location"
              defaultValue={str(item?.location)}
              placeholder="Singapore · Hybrid"
            />
          </FormField>
          <FormField label="Employment type">
            <select
              name="employmentType"
              defaultValue={str(item?.employmentType, "Full-time")}
            >
              {[
                "Full-time",
                "Part-time",
                "Contract",
                "Internship",
                "Temporary",
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Status">
            <select name="status" defaultValue={str(item?.status, "draft")}>
              <option value="draft">Draft</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          </FormField>
        </div>
        <FormField
          label="Compensation"
          hint="Optional. Include the currency and pay period."
        >
          <input
            name="salary"
            defaultValue={str(item?.salary)}
            placeholder="SGD 80,000–110,000 per year"
          />
        </FormField>
        <FormField
          label="Job description"
          hint="Describe the role, responsibilities, requirements and your hiring process."
        >
          <textarea
            name="description"
            required
            rows={13}
            defaultValue={str(item?.description)}
            placeholder="About the role\n\nWhat you’ll do\n\nWhat you’ll bring\n\nWhat we offer"
          />
        </FormField>
        {error && <Alert>{error}</Alert>}
        <div className="business-dialog-actions">
          <Btn secondary type="button" onClick={onClose}>
            Cancel
          </Btn>
          <Btn disabled={busy}>{busy ? "Saving…" : "Save job post"}</Btn>
        </div>
      </form>
    </Dialog>
  );
}

function Reports() {
  const candidates = useResource("candidates");
  const conversations = useResource("conversations");
  const applications = useResource("applications");
  const jobs = useResource("jobs");
  const reports = useResource("reports");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [jobId, setJobId] = useState("all");
  const [saving, setSaving] = useState(false);
  const [dataset, setDataset] = useState("applications");
  const [error, setError] = useState("");
  const datesValid = !startDate || !endDate || startDate <= endDate;
  const inRange = (item: Item) => {
    if (!datesValid) return false;
    if (!startDate && !endDate) return true;
    const date = str(
      item.createdAt || item.created_at || item.date || item.startedAt,
    ).slice(0, 10);
    return (
      !!date &&
      (!startDate || date >= startDate) &&
      (!endDate || date <= endDate)
    );
  };
  const filteredApplications = applications.items.filter(
    (item) => inRange(item) && (jobId === "all" || item.jobId === jobId),
  );
  const candidateIds = new Set(
    filteredApplications.map((item) => item.candidateId),
  );
  const filteredCandidates = candidates.items.filter(
    (item) => inRange(item) && (jobId === "all" || candidateIds.has(item.id)),
  );
  const filteredConversations = conversations.items.filter(
    (item) => inRange(item) && (jobId === "all" || item.jobId === jobId),
  );
  const filteredJobs = jobs.items.filter(
    (item) => inRange(item) && (jobId === "all" || item.id === jobId),
  );
  const loading =
    candidates.loading ||
    conversations.loading ||
    applications.loading ||
    jobs.loading;
  const resourceError =
    candidates.error ||
    conversations.error ||
    applications.error ||
    jobs.error ||
    reports.error;
  const pipeline = applicationStatuses.map((value) => ({
    name: value.replaceAll("_", " "),
    count: filteredApplications.filter(
      (item) => str(item.status, "applied") === value,
    ).length,
  }));
  const candidateReview = ["unreviewed", "yes", "maybe", "no"].map((value) => ({
    name: value,
    count: filteredCandidates.filter(
      (item) => str(item.status, "unreviewed") === value,
    ).length,
  }));
  const total = filteredApplications.length;
  const hired = filteredApplications.filter(
    (item) => item.status === "hired",
  ).length;
  const exportReport = () => {
    if (dataset === "candidates")
      downloadCsv(
        "arkoffer-candidates.csv",
        ["Name", "Email", "Role", "Company", "Location", "Review status"],
        filteredCandidates.map((item) => [
          label(item),
          item.email,
          item.role,
          item.company,
          item.location,
          str(item.status, "unreviewed"),
        ]),
      );
    else if (dataset === "conversations")
      downloadCsv(
        "arkoffer-conversations.csv",
        ["Title", "Date", "Status", "Type"],
        filteredConversations.map((item) => [
          label(item),
          item.createdAt || item.created_at || item.date,
          item.status,
          item.type,
        ]),
      );
    else
      downloadCsv(
        "arkoffer-applications.csv",
        ["Applicant", "Email", "Job", "Status", "Source", "Review notes"],
        filteredApplications.map((item) => [
          label(item),
          item.email,
          jobs.items.find((job) => job.id === item.jobId)?.title ||
            item.jobTitle,
          str(item.status, "applied"),
          item.source,
          item.notes,
        ]),
      );
  };
  return (
    <div className="business">
      <div className="business-intro">
        <div>
          <h2>A clearer view of your hiring.</h2>
          <p>
            Explore the activity recorded in your workspace and save the views
            that matter.
          </p>
        </div>
        <Btn secondary disabled={!datesValid} onClick={() => setSaving(true)}>
          <Plus size={15} />
          Save report
        </Btn>
      </div>
      <div className="business-report-filters">
        <FormField label="From">
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </FormField>
        <FormField label="To">
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </FormField>
        <FormField label="Job">
          <select value={jobId} onChange={(e) => setJobId(e.target.value)}>
            <option value="all">All jobs</option>
            {jobs.items.map((job) => (
              <option key={job.id} value={job.id}>
                {label(job)}
              </option>
            ))}
          </select>
        </FormField>
        <Btn
          secondary
          onClick={() => {
            setStartDate("");
            setEndDate("");
            setJobId("all");
          }}
        >
          Reset
        </Btn>
      </div>
      {!datesValid && (
        <Alert>The end date must be on or after the start date.</Alert>
      )}
      {(error || resourceError) && <Alert>{error || resourceError}</Alert>}
      {!!reports.items.length && (
        <div className="business-saved-searches">
          <span>Saved reports</span>
          {reports.items.map((item) => (
            <div key={item.id}>
              <button
                onClick={() => {
                  setStartDate(str(item.startDate));
                  setEndDate(str(item.endDate));
                  setJobId(str(item.jobId, "all"));
                  setDataset(str(item.dataset, "applications"));
                }}
              >
                {label(item)}
              </button>
              <button
                aria-label={`Delete report ${label(item)}`}
                onClick={async () => {
                  try {
                    await reports.remove(item.id);
                  } catch (e) {
                    setError(errorMessage(e));
                  }
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {loading ? (
        <Loading />
      ) : (
        <>
          <div className="business-stat-grid">
            {[
              [
                "Candidates",
                filteredCandidates.length,
                "People in your library",
              ],
              [
                "Conversations",
                filteredConversations.length,
                "Recorded in this workspace",
              ],
              [
                "Open jobs",
                filteredJobs.filter((job) => job.status === "open").length,
                "Roles marked open",
              ],
              [
                "Hiring conversion",
                total ? `${Math.round((hired / total) * 100)}%` : "—",
                `${hired} hired from ${total} applications`,
              ],
            ].map(([name, value, caption]) => (
              <div className="business-stat" key={String(name)}>
                <span>{name}</span>
                <strong>{value}</strong>
                <small>{caption}</small>
              </div>
            ))}
          </div>
          <div className="business-report-grid">
            <BarChart
              title="Application pipeline"
              subtitle="Current status · manual team decisions"
              rows={pipeline}
            />
            <BarChart
              title="Candidate review"
              subtitle="Your team’s recorded assessments"
              rows={candidateReview}
            />
          </div>
          <div className="business-panel business-export">
            <div>
              <h3>Take the details with you</h3>
              <p>
                Export the records included in the current filters as a CSV.
              </p>
            </div>
            <div className="business-actions">
              <select
                aria-label="Data to export"
                value={dataset}
                onChange={(e) => setDataset(e.target.value)}
              >
                <option value="applications">Applications</option>
                <option value="candidates">Candidates</option>
                <option value="conversations">Conversations</option>
              </select>
              <Btn
                secondary
                disabled={!datesValid || !!resourceError}
                onClick={exportReport}
              >
                <ArrowDownToLine size={15} />
                Export CSV
              </Btn>
            </div>
          </div>
          <p className="business-help">
            Date filters use each record’s creation date. Selecting a job
            includes only records linked to that job. Missing integrations and
            unrecorded activity are not included.
          </p>
        </>
      )}
      {saving && (
        <SimpleNameDialog
          title="Save report"
          onClose={() => setSaving(false)}
          onSave={async (name) => {
            await reports.save({ name, startDate, endDate, jobId, dataset });
            setSaving(false);
          }}
        />
      )}
    </div>
  );
}
function BarChart({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle: string;
  rows: { name: string; count: number }[];
}) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  const sum = rows.reduce((total, row) => total + row.count, 0);
  return (
    <div className="business-panel business-chart">
      <h3>{title}</h3>
      <p>{subtitle}</p>
      {!sum ? (
        <div className="business-chart-empty">
          Your chart will appear as records are added.
        </div>
      ) : (
        <div
          className="business-bars"
          role="img"
          aria-label={`${title}: ${rows.map((row) => `${row.name}: ${row.count}`).join(", ")}`}
        >
          {rows.map((row) => (
            <div className="business-bar-row" key={row.name}>
              <span>{row.name}</span>
              <div>
                <i style={{ width: `${(row.count / max) * 100}%` }} />
              </div>
              <strong>{row.count}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Fillmore() {
  const [requirements, setRequirements] = useState(false);
  return (
    <div className="business">
      <div className="business-fillmore">
        <div className="business-fillmore-mark">
          <Sparkles size={31} />
        </div>
        <span className="business-eyebrow">
          YOUR HIRING KNOWLEDGE, CONNECTED
        </span>
        <h2>Meet your team’s hiring assistant.</h2>
        <p>
          Bring interview context and answers into the places your team already
          works. This workspace needs an AI provider and Slack integration
          before an assistant can answer questions.
        </p>
        <div className="business-integration-card">
          <div className="business-slack-icon">
            <Hash size={25} />
          </div>
          <div>
            <h3>Slack</h3>
            <p>Ask questions and share hiring context with your team.</p>
          </div>
          <Badge value="not configured" />
        </div>
        <Btn onClick={() => setRequirements(true)}>
          View setup requirements
          <ArrowRight size={16} />
        </Btn>
        <div className="business-fillmore-features">
          <div>
            <Search size={18} />
            <h4>Find relevant context</h4>
            <p>Requires access to your workspace’s indexed interview notes.</p>
          </div>
          <div>
            <Users size={18} />
            <h4>Respect team permissions</h4>
            <p>Requires workspace identity and approved Slack access.</p>
          </div>
          <div>
            <FileText size={18} />
            <h4>Answers with sources</h4>
            <p>Requires a configured AI provider and retrieval service.</p>
          </div>
        </div>
      </div>
      {requirements && (
        <Dialog
          title="Assistant setup requirements"
          onClose={() => setRequirements(false)}
        >
          <p className="business-dialog-copy">
            The Slack assistant is not connected in this installation. No
            messages are being read or sent.
          </p>
          <ol className="business-requirements">
            <li>
              <strong>AI provider</strong>
              <p>
                Configure an approved model provider on the server. Keep API
                keys out of client code.
              </p>
            </li>
            <li>
              <strong>Slack app and OAuth</strong>
              <p>
                Register the workspace integration, configure callback URLs and
                explicitly grant the required workspace permissions.
              </p>
            </li>
            <li>
              <strong>Permission-aware retrieval</strong>
              <p>
                Index interview notes and enforce the requesting team member’s
                access before generating an answer.
              </p>
            </li>
          </ol>
          <div className="business-dialog-actions">
            <Btn onClick={() => setRequirements(false)}>Got it</Btn>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export default function Business({ section }: { section: string }) {
  if (section === "sourcing" || section === "candidates") return <Candidates />;
  if (section === "sequences") return <Sequences />;
  if (section === "applications") return <Applications />;
  if (section === "screening" || section === "screenings") return <Screening />;
  if (section === "jobs" || section === "job-posts") return <Jobs />;
  if (section === "reports") return <Reports />;
  if (section === "fillmore") return <Fillmore />;
  return (
    <div className="business">
      <Empty
        title="Choose a workspace tool"
        description="Select a tool from the sidebar to get started."
      />
    </div>
  );
}
