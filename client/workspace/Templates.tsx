import { useState } from "react";
import {
  ArrowDownAZ,
  Copy,
  FileText,
  Layers,
  Plus,
  Trash2,
} from "lucide-react";
import {
  api,
  json,
  useItems,
  Button,
  Field,
  Modal,
  Empty,
  Loading,
  ErrorBanner,
  SearchBox,
  useToast,
  type Item,
} from "../ui";
export default function Templates() {
  const { items, loading, error, refresh } = useItems("templates");
  const [search, setSearch] = useState(""),
    [selected, setSelected] = useState<Item | null>(null),
    [creating, setCreating] = useState(false),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [sort, setSort] = useState("alphabetical");
  const toast = useToast();
  const filtered = items
    .filter((t) =>
      `${t.name} ${t.description || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "alphabetical"
        ? String(a.name || a.title).localeCompare(b.name || b.title)
        : String(b.updatedAt).localeCompare(String(a.updatedAt)),
    );
  async function save(item: Item) {
    setBusy(true);
    try {
      const r = await api(`templates/${item.id}`, json("PATCH", item));
      setSelected(r.item);
      await refresh();
      setEditing(false);
      toast("Template saved");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset
      className="template-workspace"
      disabled={busy}
      aria-busy={busy}
      aria-label="Templates"
    >
      <div className="notes-actions">
        <Button onClick={() => setCreating(true)}>
          <Plus size={17} />
          New template
        </Button>
      </div>
      <div className="templates-layout">
        <aside className="template-library">
          <div className="collection-heading">
            <p className="eyebrow">TEMPLATES</p>
            <select
              aria-label="Sort templates"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="alphabetical">Alphabetical</option>
              <option value="recent">Recently edited</option>
            </select>
          </div>
          <SearchBox value={search} onChange={setSearch} />
          <ErrorBanner error={error} />
          {loading ? (
            <Loading />
          ) : filtered.length ? (
            ["Personal", "Made by ArkOffer"].map((group) => (
              <div key={group} className="template-group">
                <h3>{group}</h3>
                {filtered
                  .filter((t) =>
                    t.builtIn || t.isDefault
                      ? group === "Made by ArkOffer"
                      : group === "Personal",
                  )
                  .map((t) => (
                    <button
                      key={t.id}
                      className={`template-list-item ${selected?.id === t.id ? "selected" : ""}`}
                      onClick={() => {
                        setSelected({ ...t });
                        setEditing(false);
                      }}
                    >
                      <FileText size={16} />
                      {t.name || t.title}
                    </button>
                  ))}
              </div>
            ))
          ) : (
            <Empty title="No matching templates">
              Create a template for your interview workflow.
            </Empty>
          )}
        </aside>
        <main className="template-editor">
          {selected ? (
            <>
              <div className="section-heading">
                <h1>
                  {editing ? (
                    <input
                      aria-label="Template name"
                      value={selected.name || selected.title}
                      onChange={(e) =>
                        setSelected({ ...selected, name: e.target.value })
                      }
                    />
                  ) : (
                    selected.name || selected.title
                  )}
                </h1>
                <div className="toolbar">
                  {editing ? (
                    <Button
                      variant="primary"
                      busy={busy}
                      onClick={() => void save(selected)}
                    >
                      Save template
                    </Button>
                  ) : (
                    <Button onClick={() => setEditing(true)}>Customize</Button>
                  )}
                  <button
                    className="icon-btn"
                    aria-label="Duplicate template"
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const { id, createdAt, updatedAt, ...payload } =
                          selected;
                        const r = await api(
                          "templates",
                          json("POST", {
                            ...payload,
                            name: `${selected.name || selected.title} (copy)`,
                            builtIn: false,
                            isDefault: false,
                          }),
                        );
                        await refresh();
                        setSelected(r.item);
                        setEditing(true);
                        toast("Template duplicated");
                      } catch (e) {
                        toast((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <Copy size={17} />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label="Delete template"
                    onClick={async () => {
                      if (
                        !confirm(
                          "Delete this template? Existing notes will be kept.",
                        )
                      )
                        return;
                      setBusy(true);
                      try {
                        await api(`templates/${selected.id}`, {
                          method: "DELETE",
                        });
                        setSelected(null);
                        await refresh();
                      } catch (e) {
                        toast((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
              {editing ? (
                <Field label="Description">
                  <textarea
                    rows={2}
                    value={selected.description || ""}
                    onChange={(e) =>
                      setSelected({ ...selected, description: e.target.value })
                    }
                  />
                </Field>
              ) : (
                <p className="template-description">{selected.description}</p>
              )}
              {(selected.sections || []).map((s: any, i: number) => (
                <section className="template-prompt" key={s.id || i}>
                  {editing ? (
                    <>
                      <Field label="Section title">
                        <input
                          value={s.title}
                          onChange={(e) =>
                            setSelected({
                              ...selected,
                              sections: selected.sections.map(
                                (v: any, j: number) =>
                                  i === j ? { ...v, title: e.target.value } : v,
                              ),
                            })
                          }
                        />
                      </Field>
                      <Field label="Instructions">
                        <textarea
                          rows={4}
                          value={s.prompt || s.content || ""}
                          onChange={(e) =>
                            setSelected({
                              ...selected,
                              sections: selected.sections.map(
                                (v: any, j: number) =>
                                  i === j
                                    ? { ...v, prompt: e.target.value }
                                    : v,
                              ),
                            })
                          }
                        />
                      </Field>
                      <button
                        className="text-btn danger"
                        onClick={() =>
                          setSelected({
                            ...selected,
                            sections: selected.sections.filter(
                              (_: any, j: number) => j !== i,
                            ),
                          })
                        }
                      >
                        <Trash2 size={13} />
                        Remove section
                      </button>
                    </>
                  ) : (
                    <>
                      <h2>{s.title}</h2>
                      <p>{s.prompt || s.content}</p>
                    </>
                  )}
                </section>
              ))}
              {editing && (
                <Button
                  onClick={() =>
                    setSelected({
                      ...selected,
                      sections: [
                        ...(selected.sections || []),
                        {
                          id: crypto.randomUUID(),
                          title: "New section",
                          prompt: "",
                        },
                      ],
                    })
                  }
                >
                  <Plus size={16} />
                  Add section
                </Button>
              )}
            </>
          ) : (
            <Empty
              title="Create a template or edit an existing one"
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus size={16} />
                  New template
                </Button>
              }
            >
              Start creating a new template, or select one from the list on the
              left.
            </Empty>
          )}
        </main>
      </div>
      {creating && (
        <Modal title="New template" onClose={() => setCreating(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const f = new FormData(e.currentTarget);
              try {
                const r = await api(
                  "templates",
                  json("POST", {
                    name: f.get("name"),
                    description: f.get("description"),
                    sections: [
                      {
                        id: crypto.randomUUID(),
                        title: "Summary",
                        prompt:
                          "Summarize the key points explicitly stated in the transcript. Include source context and do not infer missing information.",
                      },
                    ],
                  }),
                );
                await refresh();
                setSelected(r.item);
                setEditing(true);
                setCreating(false);
              } catch (e) {
                toast((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Template name">
              <input
                name="name"
                required
                autoFocus
                placeholder="e.g. Product design interview"
                maxLength={120}
              />
            </Field>
            <Field label="Description">
              <textarea name="description" rows={3} />
            </Field>
            <div className="form-actions">
              <Button variant="primary" type="submit" busy={busy}>
                Create template
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </fieldset>
  );
}
