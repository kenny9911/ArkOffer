import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { isWorkspaceAdmin, sessionUser, type User } from "./auth.js";
import type { Resource, Store } from "./db.js";

type Options = {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
};
const fields = [
  "name",
  "role",
  "company",
  "skills",
  "profile",
  "workEmail",
  "workHistory",
] as const;
type Field = (typeof fields)[number];
type Identifier = "profile" | "workEmail" | "nameCompany";
type Proposal = Partial<Record<Field, unknown>>;
type Run = {
  id: string;
  workspace_id: string;
  candidate_id: string;
  user_id: string;
  request_key: string;
  request_hash: string;
  identifier: Identifier;
  fingerprint: string;
  candidate_version: string;
  snapshot: string;
  status: string;
  proposal: string;
  provenance: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  applied_at: string | null;
  applied_fields: string;
};
class EnrichmentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new EnrichmentError(status, message);
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, max = 300) =>
  typeof value === "string" && value.trim().length <= max
    ? value.trim().replace(/[\u0000-\u001f\u007f]/g, " ")
    : "";
const freeEmail = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "mail.com",
]);
function professionalEmail(value: unknown) {
  const email = text(value, 254).toLowerCase();
  return z.email().safeParse(email).success &&
    !freeEmail.has(email.split("@")[1])
    ? email
    : "";
}
function professionalProfile(value: unknown) {
  const raw = text(value, 1000);
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("https://") ? raw : `https://${raw}`);
    return url.protocol === "https:" &&
      ["linkedin.com", "www.linkedin.com"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      /^\/in\/[a-zA-Z0-9%_-]{1,200}\/?$/.test(url.pathname)
      ? `https://www.linkedin.com${url.pathname.replace(/\/$/, "")}`
      : "";
  } catch {
    return "";
  }
}
function inputs(candidate: Resource, identifier: Identifier) {
  if (identifier === "profile") {
    const profile = professionalProfile(candidate.profile);
    if (!profile)
      fail(
        400,
        "Add a public HTTPS LinkedIn /in/ profile to this candidate first.",
      );
    return { profile };
  }
  if (identifier === "workEmail") {
    const email = professionalEmail(candidate.workEmail || candidate.email);
    if (!email)
      fail(
        400,
        "Add a valid professional work email to this candidate first. Personal email providers are not supported.",
      );
    return { email };
  }
  const name = text(candidate.name, 120),
    company = text(candidate.company, 200);
  if (!name || !/\S+\s+\S+/.test(name) || !company)
    fail(400, "Add a full name and company to this candidate first.");
  return { name, company };
}
function snapshot(candidate: Resource) {
  return Object.fromEntries(
    fields.map((field) => [field, candidate[field] ?? null]),
  );
}
/** Explicit allowlist: never persist a provider's raw person record or private contact data. */
export function mapProfessionalEnrichment(value: unknown) {
  const body = record(value),
    data = record(body.data);
  if (
    body.status !== 200 ||
    !Number.isInteger(body.likelihood) ||
    Number(body.likelihood) < 6 ||
    Number(body.likelihood) > 10 ||
    !text(data.id, 150) ||
    !text(data.full_name, 120)
  )
    fail(
      502,
      "The provider returned an invalid or insufficient-confidence match. No candidate fields were changed.",
    );
  const proposal: Proposal = {};
  const mapped: Proposal = {
    name: text(data.full_name, 120),
    role: text(data.job_title),
    company: text(data.job_company_name, 200),
    profile: professionalProfile(data.linkedin_url),
    workEmail: professionalEmail(data.work_email),
  };
  for (const field of fields)
    if (mapped[field]) proposal[field] = mapped[field];
  if (Array.isArray(data.skills)) {
    const skills = [
      ...new Set(
        data.skills
          .slice(0, 50)
          .map((value) => text(value, 80))
          .filter(Boolean),
      ),
    ];
    if (skills.length) proposal.skills = skills.join(", ");
  }
  if (Array.isArray(data.experience)) {
    const date = (value: unknown) =>
      typeof value === "string" && /^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/.test(value)
        ? value
        : null;
    const history = data.experience
      .slice(0, 30)
      .map((value) => {
        const item = record(value);
        return {
          company: text(record(item.company).name, 200),
          role: text(record(item.title).name),
          startDate: date(item.start_date),
          endDate: date(item.end_date),
        };
      })
      .filter((item) => item.company && item.role);
    if (history.length) proposal.workHistory = history;
  }
  const matched = Array.isArray(body.matched)
    ? [
        ...new Set(
          body.matched.filter(
            (value): value is string =>
              typeof value === "string" &&
              ["profile", "email", "name", "company"].includes(value),
          ),
        ),
      ]
    : [];
  if (!matched.length)
    fail(
      502,
      "The provider did not identify any matched inputs. No candidate fields were changed.",
    );
  return {
    proposal,
    provenance: {
      provider: "pdl",
      providerName: "People Data Labs",
      externalId: text(data.id, 150),
      likelihood: Number(body.likelihood),
      matched,
      identity: {
        name: proposal.name,
        company: proposal.company || "",
        role: proposal.role || "",
        profile: proposal.profile || "",
      },
      independentlyVerified: false,
    },
  };
}

/** Register after JSON and same-origin middleware. Registration never contacts PDL. */
export function registerEnrichment(
  app: Express,
  store: Store,
  options: Options = {},
) {
  const env = options.env || process.env,
    fetcher = options.fetch || fetch,
    now = options.now || Date.now;
  const stamp = () => new Date(now()).toISOString();
  store.db.exec(`CREATE TABLE IF NOT EXISTS candidate_enrichment_runs (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id),
    request_key TEXT NOT NULL, request_hash TEXT NOT NULL, identifier TEXT NOT NULL, fingerprint TEXT NOT NULL,
    candidate_version TEXT NOT NULL, snapshot TEXT NOT NULL, status TEXT NOT NULL,
    proposal TEXT NOT NULL DEFAULT '{}', provenance TEXT NOT NULL DEFAULT '{}', error TEXT,
    created_at TEXT NOT NULL, completed_at TEXT, applied_at TEXT, applied_fields TEXT NOT NULL DEFAULT '[]',
    UNIQUE(workspace_id,request_key));
    CREATE INDEX IF NOT EXISTS enrichment_candidate ON candidate_enrichment_runs(workspace_id,candidate_id,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS enrichment_running_candidate ON candidate_enrichment_runs(workspace_id,candidate_id) WHERE status='running';
  `);
  // Leave live calls alone across server processes; expired calls cannot be safely replayed.
  function expireInterruptedRuns() {
    store.db
      .prepare(
        "UPDATE candidate_enrichment_runs SET status='uncertain',error=?,completed_at=? WHERE status='running' AND created_at<?",
      )
      .run(
        "This lookup did not complete in time. The provider may have consumed a credit. Check provider usage before explicitly retrying.",
        stamp(),
        new Date(now() - 60_000).toISOString(),
      );
  }
  expireInterruptedRuns();
  const route =
    (handler: (req: Request, res: Response) => unknown) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve()
        .then(() => handler(req, res))
        .catch((error) => {
          if (error instanceof EnrichmentError)
            res.status(error.status).json({ error: error.message });
          else if (error instanceof z.ZodError)
            res.status(400).json({
              error: error.issues[0]?.message || "Invalid enrichment request.",
            });
          else next(error);
        });
    };
  function user(req: Request, admin = false) {
    const u =
      sessionUser(store, req) ||
      fail(401, "Sign in to review candidate enrichment.");
    if (admin && !isWorkspaceAdmin(u))
      fail(
        403,
        "Only workspace owners and admins can run or apply enrichment.",
      );
    return u;
  }
  function current(req: Request, original: User) {
    const latest = user(req, true);
    if (
      latest.id !== original.id ||
      latest.workspaceId !== original.workspaceId
    )
      fail(
        409,
        "The active workspace changed. Reopen this candidate in its original workspace.",
      );
    return latest;
  }
  function setup(u: User) {
    const allowed = (env.ENRICHMENT_WORKSPACE_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .includes(u.workspaceId);
    const missing = [
      ...(!env.PDL_API_KEY ? ["PDL_API_KEY"] : []),
      ...(!allowed
        ? ["ENRICHMENT_WORKSPACE_IDS (allow this workspace ID)"]
        : []),
    ];
    return {
      provider: "pdl",
      providerName: "People Data Labs",
      configured: missing.length === 0,
      allowed,
      canManage: isWorkspaceAdmin(u),
      missing,
      workspaceId: u.workspaceId,
    };
  }
  function candidate(u: User, id: string) {
    return (
      store.get(u.workspaceId, "candidates", id) ||
      fail(404, "Candidate not found.")
    );
  }
  function getRun(u: User, candidateId: string, id: string) {
    return store.db
      .prepare(
        "SELECT * FROM candidate_enrichment_runs WHERE id=? AND workspace_id=? AND candidate_id=?",
      )
      .get(id, u.workspaceId, candidateId) as Run | undefined;
  }
  function safeRun(run: Run, c: Resource) {
    const proposed = JSON.parse(run.proposal) as Proposal,
      original = JSON.parse(run.snapshot) as Proposal;
    let identityChanged = false;
    try {
      identityChanged = hash(inputs(c, run.identifier)) !== run.fingerprint;
    } catch {
      identityChanged = true;
    }
    return {
      id: run.id,
      status: run.status,
      identifier: run.identifier,
      createdAt: run.created_at,
      completedAt: run.completed_at,
      appliedAt: run.applied_at,
      appliedFields: JSON.parse(run.applied_fields),
      error: run.error,
      provenance: JSON.parse(run.provenance),
      candidateVersion: c.updatedAt,
      identityChanged,
      diff: fields
        .filter(
          (field) =>
            Object.hasOwn(proposed, field) &&
            JSON.stringify(c[field] ?? null) !==
              JSON.stringify(proposed[field]),
        )
        .map((field) => ({
          field,
          before: c[field] ?? null,
          proposed: proposed[field],
          conflict:
            JSON.stringify(c[field] ?? null) !==
            JSON.stringify(original[field] ?? null),
        })),
    };
  }
  function finish(
    id: string,
    status: string,
    error: string | null,
    result?: ReturnType<typeof mapProfessionalEnrichment>,
  ) {
    store.db
      .prepare(
        "UPDATE candidate_enrichment_runs SET status=?,error=?,proposal=?,provenance=?,completed_at=? WHERE id=?",
      )
      .run(
        status,
        error,
        JSON.stringify(result?.proposal || {}),
        JSON.stringify(result?.provenance || {}),
        stamp(),
        id,
      );
  }
  const path = "/api/candidates/:id/enrichment";
  app.get(
    path,
    route((req, res) => {
      expireInterruptedRuns();
      const u = user(req),
        c = candidate(u, String(req.params.id));
      const runs = store.db
        .prepare(
          "SELECT * FROM candidate_enrichment_runs WHERE workspace_id=? AND candidate_id=? ORDER BY rowid DESC LIMIT 30",
        )
        .all(u.workspaceId, c.id) as unknown as Run[];
      const identifiers = (
        ["profile", "workEmail", "nameCompany"] as Identifier[]
      ).map((identifier) => {
        try {
          return {
            id: identifier,
            available: true,
            inputs: inputs(c, identifier),
          };
        } catch {
          return { id: identifier, available: false, inputs: {} };
        }
      });
      res.json({
        setup: setup(u),
        candidateVersion: c.updatedAt,
        identifiers,
        items: runs.map((run) => safeRun(run, c)),
      });
    }),
  );
  app.post(
    path,
    route(async (req, res) => {
      expireInterruptedRuns();
      const u = user(req, true),
        c = candidate(u, String(req.params.id));
      const body = z
        .object({
          requestKey: z.uuid(),
          candidateVersion: z.string().min(1).max(100),
          consent: z.literal(true),
          identifier: z.enum(["profile", "workEmail", "nameCompany"]),
          retryOf: z.uuid().optional(),
          retryConfirmed: z.literal(true).optional(),
        })
        .strict()
        .parse(req.body);
      const requestHash = hash({
        candidate: c.id,
        ...body,
        requestKey: undefined,
      });
      const existing = store.db
        .prepare(
          "SELECT * FROM candidate_enrichment_runs WHERE workspace_id=? AND request_key=?",
        )
        .get(u.workspaceId, body.requestKey) as Run | undefined;
      if (existing) {
        if (
          existing.request_hash !== requestHash ||
          existing.candidate_id !== c.id
        )
          fail(
            409,
            "This request key belongs to a different lookup. Refresh before continuing.",
          );
        return res.json({ item: safeRun(existing, c), reused: true });
      }
      const config = setup(u);
      if (!config.allowed)
        fail(
          403,
          "This workspace is not enabled for paid enrichment. Ask the server administrator to allow its workspace ID.",
        );
      if (!config.configured)
        fail(503, "People Data Labs setup required: PDL_API_KEY.");
      if (c.updatedAt !== body.candidateVersion)
        fail(
          409,
          "The candidate changed. Refresh and review the lookup identifiers again.",
        );
      const query = inputs(c, body.identifier),
        fingerprint = hash(query);
      const latest = store.db
        .prepare(
          "SELECT * FROM candidate_enrichment_runs WHERE workspace_id=? AND candidate_id=? AND fingerprint=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(u.workspaceId, c.id, fingerprint) as Run | undefined;
      if (latest && !body.retryOf)
        return res.json({ item: safeRun(latest, c), reused: true });
      if (
        body.retryOf &&
        (!latest ||
          latest.id !== body.retryOf ||
          latest.status === "running" ||
          !body.retryConfirmed)
      )
        fail(
          409,
          "Review the latest lookup and explicitly confirm another paid attempt before retrying.",
        );
      const running = store.db
        .prepare(
          "SELECT id FROM candidate_enrichment_runs WHERE workspace_id=? AND candidate_id=? AND status='running'",
        )
        .get(u.workspaceId, c.id);
      if (running)
        fail(
          409,
          "An enrichment lookup is already running for this candidate.",
        );
      const recent = store.db
        .prepare(
          "SELECT count(*) AS count FROM candidate_enrichment_runs WHERE workspace_id=? AND created_at>=?",
        )
        .get(u.workspaceId, new Date(now() - 3600000).toISOString());
      if (Number(recent?.count) >= 30)
        fail(
          429,
          "This workspace has reached its limit of 30 enrichment attempts per hour.",
        );
      const id = randomUUID();
      store.db
        .prepare(
          "INSERT INTO candidate_enrichment_runs(id,workspace_id,candidate_id,user_id,request_key,request_hash,identifier,fingerprint,candidate_version,snapshot,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'running',?)",
        )
        .run(
          id,
          u.workspaceId,
          c.id,
          u.id,
          body.requestKey,
          requestHash,
          body.identifier,
          fingerprint,
          c.updatedAt,
          JSON.stringify(snapshot(c)),
          stamp(),
        );
      const url = new URL("https://api.peopledatalabs.com/v5/person/enrich");
      for (const [key, value] of Object.entries(query))
        if (value) url.searchParams.set(key, value);
      url.searchParams.set("min_likelihood", "6");
      url.searchParams.set("include_if_matched", "true");
      url.searchParams.set(
        "data_include",
        "id,full_name,job_title,job_company_name,linkedin_url,work_email,skills,experience.company.name,experience.title.name,experience.start_date,experience.end_date",
      );
      let result: ReturnType<typeof mapProfessionalEnrichment> | undefined;
      try {
        const response = await fetcher(url.href, {
          headers: { "X-Api-Key": env.PDL_API_KEY! },
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        });
        if (response.status === 404) {
          await response.body?.cancel();
          finish(
            id,
            "no_match",
            "No matching professional profile met the provider confidence threshold. No candidate fields were changed.",
          );
        } else if (!response.ok) {
          await response.body?.cancel();
          finish(
            id,
            response.status >= 500 ? "uncertain" : "failed",
            response.status === 429
              ? "The provider rate limit or credit allowance was reached. Check provider usage before retrying."
              : [401, 403].includes(response.status)
                ? "The provider rejected its configured credentials or permissions."
                : `The provider returned HTTP ${response.status}. Check provider usage before explicitly retrying.`,
          );
        } else {
          const reader = response.body?.getReader();
          if (!reader)
            fail(
              502,
              "The provider returned an empty response. Check usage before retrying.",
            );
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          while (true) {
            const part = await reader!.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 256_000) {
              await reader!.cancel();
              fail(
                502,
                "The provider response exceeded the size limit. Check usage before retrying.",
              );
            }
            chunks.push(part.value);
          }
          result = mapProfessionalEnrichment(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          );
          if (
            !result.provenance.matched.some((field) =>
              Object.hasOwn(query, field),
            )
          )
            fail(
              502,
              "The provider did not match any of the supplied identifiers. No candidate fields were changed.",
            );
          // Persist no profile when membership/session/workspace or the candidate changed in flight.
          current(req, u);
          const latestCandidate = candidate(u, c.id);
          if (latestCandidate.updatedAt !== c.updatedAt) {
            finish(
              id,
              "stale",
              "The candidate changed during the lookup. Its fields were preserved. Review the candidate before another paid attempt.",
            );
            result = undefined;
          } else finish(id, "proposed", null, result);
        }
      } catch (error) {
        finish(
          id,
          error instanceof EnrichmentError && error.status < 500
            ? "abandoned"
            : "uncertain",
          error instanceof EnrichmentError
            ? error.message
            : "The lookup could not be confirmed. The provider may have consumed a credit. Check provider usage before explicitly retrying.",
        );
        if (error instanceof EnrichmentError && error.status < 500) throw error;
      }
      current(req, u);
      const latestCandidate = candidate(u, c.id),
        run = getRun(u, c.id, id)!;
      return res
        .status(201)
        .json({ item: safeRun(run, latestCandidate), reused: false });
    }),
  );
  app.post(
    `${path}/:runId/apply`,
    route((req, res) => {
      const u = user(req, true);
      const body = z
        .object({
          candidateVersion: z.string().min(1).max(100),
          fields: z.array(z.enum(fields)).min(1).max(fields.length),
          confirm: z.literal(true),
        })
        .strict()
        .parse(req.body);
      const item = store.transaction(() => {
        const c = candidate(u, String(req.params.id)),
          run =
            getRun(u, c.id, String(req.params.runId)) ||
            fail(404, "Enrichment lookup not found.");
        if (run.status !== "proposed")
          fail(
            409,
            "Only an unapplied proposal can be applied. Refresh the lookup history.",
          );
        if (c.updatedAt !== body.candidateVersion)
          fail(
            409,
            "The candidate changed since this review. Refresh to see its current fields.",
          );
        const reviewed = safeRun(run, c);
        if (reviewed.identityChanged)
          fail(
            409,
            "The candidate lookup identity changed. Run a new lookup before applying this proposal.",
          );
        const selected = [...new Set(body.fields)],
          patch: Proposal = {};
        for (const field of selected) {
          const diff = reviewed.diff.find((item) => item.field === field);
          if (!diff || diff.conflict)
            fail(
              409,
              "A selected field changed after the lookup or is not proposed. Local edits were preserved; refresh and select other fields.",
            );
          patch[field] = diff!.proposed;
        }
        const appliedAt = stamp(),
          provenance = record(c.enrichmentProvenance);
        for (const field of selected)
          provenance[field] = {
            ...reviewed.provenance,
            runId: run.id,
            retrievedAt: run.completed_at,
            appliedAt,
            appliedBy: u.id,
          };
        const saved = store.update(u.workspaceId, "candidates", {
          ...c,
          ...patch,
          enrichmentProvenance: provenance,
          updatedAt: appliedAt,
        });
        store.db
          .prepare(
            "UPDATE candidate_enrichment_runs SET status='applied',applied_at=?,applied_fields=? WHERE id=?",
          )
          .run(appliedAt, JSON.stringify(selected), run.id);
        return saved;
      });
      res.json({ item });
    }),
  );
}
