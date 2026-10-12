import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  isValidElement,
  cloneElement,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { X, LoaderCircle, Inbox, Search } from "lucide-react";
export type Item = {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: any;
};
export type User = {
  id: string;
  name: string;
  email: string;
  workspaceId: string;
  workspaceName: string;
  role: string;
};
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(
    path.startsWith("/api/") ? path : `/api/${path}`,
    {
      credentials: "include",
      ...options,
      headers: {
        ...(options.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        ...options.headers,
      },
    },
  );
  const data = await response
    .json()
    .catch(() => ({ error: response.statusText }));
  if (!response.ok)
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : data.error?.message ||
            data.message ||
            "The request could not be completed.",
    );
  return data;
}
export const json = (method: string, data: unknown): RequestInit => ({
  method,
  body: JSON.stringify(data),
});
export function useItems(resource: string) {
  const [items, setItems] = useState<Item[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setError("");
      const r = await api<{ items: Item[] }>(resource);
      setItems(r.items);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [resource]);
  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);
  return { items, setItems, loading, error, refresh };
}
export const AuthContext = createContext<{
  user: User | null;
  reload: () => Promise<void>;
}>({ user: null, reload: async () => {} });
export const useAuth = () => useContext(AuthContext);
const ToastContext = createContext<(message: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, set] = useState("");
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => set(""), 5000);
      return () => clearTimeout(timer);
    }
  }, [message]);
  return (
    <ToastContext.Provider value={set}>
      {children}
      {message && (
        <div className="toast" role="status">
          {message}
          <button aria-label="Dismiss notification" onClick={() => set("")}>
            <X size={15} />
          </button>
        </div>
      )}
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);
export function Button({
  children,
  variant = "",
  busy,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: string;
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || busy}
      className={`btn ${variant} ${props.className || ""}`}
    >
      {busy ? <LoaderCircle size={16} className="spin" /> : null}
      {children}
    </button>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  const control = isValidElement<Record<string, unknown>>(children)
    ? cloneElement(children, {
        id,
        "aria-describedby": hint ? `${id}-hint` : undefined,
      })
    : children;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {control}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Inbox size={36} strokeWidth={1.3} />
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={22} /> Loading your workspace…
    </div>
  );
}
export function ErrorBanner({ error }: { error: string }) {
  return error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;
}
export function SearchBox({
  value,
  onChange,
  placeholder = "Search",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="search">
      <Search size={18} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
export function Modal({
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
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button
          className="icon-btn"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export function Avatar({ name, color = "" }: { name: string; color?: string }) {
  return (
    <span className={`avatar ${color}`}>
      {name
        .split(/\s+/)
        .slice(0, 2)
        .map((s) => s[0])
        .join("")
        .toUpperCase() || "A"}
    </span>
  );
}
export function downloadText(name: string, text: string, type = "text/plain") {
  const u = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  URL.revokeObjectURL(u);
}
export const niceDate = (value: string) => {
  const d = new Date(value);
  return Number.isNaN(d.valueOf())
    ? "No date"
    : d.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
};
