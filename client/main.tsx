import React, { useEffect, useState, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Link,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  ArrowRight,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  UserRoundSearch,
  Mails,
  ListFilter,
  ScanFace,
  FileText,
  Table2,
  FilePenLine,
  Settings,
  LayoutTemplate,
  MessageSquare,
  ChevronDown,
  LogOut,
  Menu,
} from "lucide-react";
import {
  api,
  json,
  AuthContext,
  useAuth,
  ToastProvider,
  Button,
  Field,
  ErrorBanner,
  Loading,
  Avatar,
  type User,
} from "./ui";
const Marketing = lazy(() => import("./marketing/Marketing"));
const Notes = lazy(() => import("./workspace/Notes"));
const Templates = lazy(() => import("./workspace/Templates"));
const SettingsPage = lazy(() => import("./workspace/Settings"));
const WorkspaceAssistant = lazy(() => import("./workspace/WorkspaceAssistant"));
const Business = lazy(() => import("./workspace/Business"));
const Shared = lazy(() => import("./workspace/Shared"));
const ScreeningInterview = lazy(() => import("./workspace/ScreeningInterview"));
const ResetPassword = lazy(() => import("./ResetPassword"));
const AcceptInvite = lazy(() => import("./workspace/AcceptInvite"));
import "./styles.css";
function Auth() {
  const location = useLocation(),
    signup = location.pathname === "/signup",
    navigate = useNavigate(),
    { reload } = useAuth();
  const requestedReturn =
    new URLSearchParams(location.search).get("returnTo") || "";
  const returnTo =
    /^(?:\/invitations\/[a-f0-9]{64}|\/verify-email\?token=[a-f0-9]{64})$/.test(
      requestedReturn,
    )
      ? requestedReturn
      : "/notes";
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <main className="auth-page">
      <Link to="/" className="wordmark">
        <Layers />
        ArkOffer
      </Link>
      <div className="auth-card">
        <p className="eyebrow">YOUR RECRUITING WORKSPACE</p>
        <h1>{signup ? "Make room for better hiring." : "Welcome back."}</h1>
        <p>
          {signup
            ? "Bring your conversations and recruiting work together."
            : "Your conversations, context, and next steps are here."}
        </p>
        <form
          key={location.pathname}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const f = new FormData(e.currentTarget);
            try {
              await api(
                `auth/${signup ? "signup" : "login"}`,
                json("POST", {
                  name: f.get("name"),
                  email: f.get("email"),
                  password: f.get("password"),
                  workspaceName: f.get("workspaceName"),
                  seedDemo: f.get("seedDemo") === "on",
                }),
              );
              await reload();
              navigate(returnTo);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {signup && (
            <>
              <Field label="Your name">
                <input
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={100}
                />
              </Field>
              <Field label="Workspace name">
                <input
                  name="workspaceName"
                  placeholder="Your company"
                  required
                  maxLength={100}
                />
              </Field>
            </>
          )}
          <Field label="Work email">
            <input name="email" type="email" autoComplete="email" required />
          </Field>
          <Field label="Password" hint={signup ? "At least 8 characters." : ""}>
            <input
              name="password"
              type="password"
              minLength={8}
              maxLength={128}
              autoComplete={signup ? "new-password" : "current-password"}
              required
            />
          </Field>
          {signup && (
            <label className="check-row">
              <input name="seedDemo" type="checkbox" defaultChecked /> Include
              fictional examples to explore the workspace
            </label>
          )}
          <ErrorBanner error={error} />
          <Button type="submit" variant="primary" busy={busy}>
            {signup ? "Create workspace" : "Sign in"}
            <ArrowRight size={17} />
          </Button>
        </form>
        {!signup && (
          <p>
            <Link to="/reset-password">Forgot password?</Link>
          </p>
        )}
        <p className="auth-switch">
          {signup ? "Already have an account?" : "New to ArkOffer?"}{" "}
          <Link
            to={`${signup ? "/login" : "/signup"}${returnTo !== "/notes" ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`}
          >
            {signup ? "Sign in" : "Create a workspace"}
          </Link>
        </p>
        <small>Your workspace uses its own ArkOffer account.</small>
      </div>
      <div className="auth-caption">
        Good conversations.
        <br />
        Better decisions.
      </div>
    </main>
  );
}
const nav = [
  ["Sourcing", "/app/sourcing", UserRoundSearch],
  ["Sequences", "/app/sequences", Mails],
  ["Application Review", "/app/applications", ListFilter],
  ["Screening", "/app/screening", ScanFace],
  ["Notes", "/notes", FileText],
  ["Reports", "/app/reports", Table2],
  ["Job Posts", "/app/job-posts", FilePenLine],
  ["Workspace assistant", "/app/fillmore", MessageSquare],
] as const;
function Workspace() {
  const { user, reload } = useAuth(),
    location = useLocation(),
    navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false),
    [mobile, setMobile] = useState(false),
    [account, setAccount] = useState(false);
  useEffect(() => {
    setMobile(false);
    setAccount(false);
  }, [location.pathname]);
  if (!user) return <Navigate to="/login" replace />;
  const title = location.pathname.includes("templates")
    ? "Templates"
    : location.pathname.includes("settings")
      ? "Settings"
      : nav.find((x) => location.pathname.startsWith(x[1]))?.[0] || "Notes";
  return (
    <div
      className={`workspace ${collapsed ? "collapsed" : ""} ${mobile ? "mobile-open" : ""}`}
    >
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Link className="wordmark" to="/notes">
            <Layers size={25} />
            <span>ArkOffer</span>
          </Link>
          <button
            className="icon-btn"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? (
              <PanelLeftOpen size={18} />
            ) : (
              <PanelLeftClose size={18} />
            )}
          </button>
        </div>
        <nav aria-label="Main navigation">
          {nav.map(([name, to, Icon]) => (
            <React.Fragment key={to}>
              <Link
                title={collapsed ? name : undefined}
                onClick={() => setMobile(false)}
                className={`nav-item ${location.pathname.startsWith(to) ? "active" : ""}`}
                to={to}
              >
                <Icon size={19} />
                <span>{name}</span>
                {name === "Notes" && (
                  <ChevronDown size={14} className="nav-chevron" />
                )}
                {name === "Workspace assistant" && (
                  <span className="new-label">New</span>
                )}
              </Link>
              {name === "Notes" && !collapsed && (
                <div className="subnav">
                  <Link
                    className={
                      location.pathname.startsWith("/notes") &&
                      !location.pathname.includes("templates")
                        ? "active"
                        : ""
                    }
                    to="/notes"
                  >
                    <MessageSquare size={17} />
                    Conversations
                  </Link>
                  <Link
                    className={
                      location.pathname.includes("templates") ? "active" : ""
                    }
                    to="/notes/templates"
                  >
                    <LayoutTemplate size={17} />
                    Templates
                  </Link>
                </div>
              )}
            </React.Fragment>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Link
            className={`nav-item ${title === "Settings" ? "active" : ""}`}
            to="/app/settings"
          >
            <Settings size={19} />
            <span>Settings</span>
          </Link>
          <button
            className="account"
            aria-label="Account menu"
            aria-expanded={account}
            onClick={() => setAccount(!account)}
          >
            <Avatar name={user.name} />
            <span>
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </span>
          </button>
          {account && (
            <div className="account-menu">
              <strong>{user.workspaceName}</strong>
              <span>{user.role}</span>
              <Link to="/app/settings">Manage workspace</Link>
              <Link to="/">View website</Link>
              <button
                onClick={async () => {
                  await api("auth/logout", json("POST", {}));
                  await reload();
                  navigate("/login");
                }}
              >
                <LogOut size={16} />
                Sign out
              </button>
            </div>
          )}
        </div>
      </aside>
      <section className="workspace-main">
        <header className="topbar">
          <button
            className="icon-btn mobile-menu"
            aria-label="Toggle navigation"
            onClick={() => setMobile(!mobile)}
          >
            <Menu size={20} />
          </button>
          <span className="page-heading">
            <FileText size={20} />
            {title}
          </span>
          <span className="workspace-label">{user.workspaceName}</span>
        </header>
        {location.pathname.startsWith("/notes/templates") ? (
          <Templates />
        ) : location.pathname.startsWith("/notes") ? (
          <Notes />
        ) : location.pathname.startsWith("/app/settings") ? (
          <SettingsPage />
        ) : location.pathname === "/app/fillmore" ? (
          <WorkspaceAssistant />
        ) : nav.some((entry) => entry[1] === location.pathname) ? (
          <Business
            key={location.pathname}
            section={location.pathname.split("/")[2]}
          />
        ) : (
          <Navigate to="/notes" replace />
        )}
      </section>
    </div>
  );
}
function App() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true);
  async function reload() {
    try {
      const r = await api<{ user: User }>("auth/me");
      setUser(r.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, []);
  return (
    <AuthContext.Provider value={{ user, reload }}>
      <ToastProvider>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/login" element={<Auth />} />
            <Route path="/signup" element={<Auth />} />
            <Route
              path="/reset-password"
              element={loading ? <Loading /> : <ResetPassword />}
            />
            <Route
              path="/verify-email"
              element={loading ? <Loading /> : <ResetPassword />}
            />
            <Route path="/shared/:token" element={<Shared />} />
            <Route
              path="/invitations/:token"
              element={loading ? <Loading /> : <AcceptInvite />}
            />
            <Route path="/interviews/:token" element={<ScreeningInterview />} />
            <Route
              path="/notes/*"
              element={loading ? <Loading /> : <Workspace />}
            />
            <Route
              path="/app/*"
              element={loading ? <Loading /> : <Workspace />}
            />
            <Route path="*" element={<Marketing />} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </AuthContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
