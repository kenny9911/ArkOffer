import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  BarChart3,
  Check,
  CheckCheck,
  ChevronDown,
  FileText,
  Globe,
  Layers,
  Mail,
  Menu,
  Mic,
  MoreHorizontal,
  Plus,
  Search,
  Send,
  Sparkles,
  Target,
  ShieldCheck,
  History,
  Users,
  X,
} from "lucide-react";
import {
  articles,
  productKeys,
  products,
  resourceCategories,
  type ProductKey,
} from "./content";
import "./marketing.css";
import { ProductLanding } from "./ProductLanding";
import { moveMarketingTab } from "./tabNavigation";

const icons = {
  sourcing: Search,
  "application-review": CheckCheck,
  screening: Mic,
  "interview-notes": FileText,
  reports: BarChart3,
  outreach: Send,
  "job-posts": FileText,
  fillmore: Sparkles,
};

function Brand() {
  return (
    <Link className="mk-brand" to="/" aria-label="ArkOffer home">
      <span className="mk-brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>ArkOffer</span>
    </Link>
  );
}
function Buttons({ primary = "Book a demo" }: { primary?: string }) {
  return (
    <div className="mk-buttons">
      <Link className="mk-button mk-dark" to="/demo">
        {primary}
      </Link>
      <Link className="mk-button" to="/signup">
        Start for free
      </Link>
    </div>
  );
}
function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="mk-eyebrow">{children}</p>;
}

function Navigation() {
  const [open, setOpen] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const location = useLocation();
  useEffect(() => {
    setOpen(null);
    setMobile(false);
  }, [location.pathname]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(null);
        setMobile(false);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  return (
    <>
      <div className="mk-announcement">
        <Link to="/resources/meet-the-arkoffer-workspace">
          Meet your new recruiting workspace. <ArrowRight size={20} />
        </Link>
      </div>
      <header className="mk-header">
        <Brand />
        <button
          className="mk-mobile-toggle"
          onClick={() => setMobile(!mobile)}
          aria-label={mobile ? "Close navigation" : "Open navigation"}
          aria-expanded={mobile}
        >
          {mobile ? <X /> : <Menu />}
        </button>
        <nav
          className={mobile ? "mk-nav mk-mobile-open" : "mk-nav"}
          aria-label="Main navigation"
        >
          <div className="mk-nav-links">
            {["Platform", "Resources"].map((item) => (
              <div className="mk-nav-group" key={item}>
                <button
                  className="mk-nav-trigger"
                  onClick={() => setOpen(open === item ? null : item)}
                  aria-expanded={open === item}
                >
                  {item}
                  <ChevronDown size={12} />
                </button>
                {open === item && (
                  <div className="mk-dropdown">
                    {item === "Platform" ? (
                      productKeys.map((key) => {
                        const Icon = icons[key];
                        return (
                          <Link key={key} to={`/${key}`}>
                            <Icon size={18} />
                            <span>
                              <strong>{products[key].name}</strong>
                              <small>{products[key].short}</small>
                            </span>
                            <ArrowUpRight size={15} />
                          </Link>
                        );
                      })
                    ) : (
                      <>
                        <Link to="/resources">
                          <Layers size={18} />
                          <span>
                            <strong>All resources</strong>
                            <small>
                              Ideas for a more thoughtful hiring process.
                            </small>
                          </span>
                        </Link>
                        <Link to="/resources/product-updates">
                          <Sparkles size={18} />
                          <span>
                            <strong>Product updates</strong>
                            <small>What’s new in your workspace.</small>
                          </span>
                        </Link>
                        <Link to="/resources/interview-questions">
                          <Mic size={18} />
                          <span>
                            <strong>Interviewing guides</strong>
                            <small>Prepare a better conversation.</small>
                          </span>
                        </Link>
                        <Link to="/about">
                          <Users size={18} />
                          <span>
                            <strong>About ArkOffer</strong>
                            <small>Get to know the workspace.</small>
                          </span>
                        </Link>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
            <Link to="/pricing">Pricing</Link>
            <Link to="/careers">Careers</Link>
          </div>
          <div className="mk-nav-actions">
            <Link to="/login">Sign in</Link>
            <Link className="mk-button mk-dark mk-small" to="/demo">
              Book a demo
            </Link>
            <Link className="mk-button mk-small mk-coworker" to="/fillmore">
              AI coworker <ArrowUpRight size={15} />
            </Link>
          </div>
        </nav>
      </header>
      {open && (
        <button
          aria-label="Close navigation menu"
          className="mk-menu-scrim"
          onClick={() => setOpen(null)}
        />
      )}
    </>
  );
}

function ProductPreview({
  product,
  large = false,
}: {
  product: ProductKey;
  large?: boolean;
}) {
  const [tab, setTab] = useState("Summary");
  const [reviewed, setReviewed] = useState(false);
  const [query, setQuery] = useState("");
  const [previewResult, setPreviewResult] = useState(false);
  useEffect(() => {
    setPreviewResult(false);
    setReviewed(false);
    setQuery("");
  }, [product]);
  return (
    <div className={`mk-product-preview ${large ? "mk-preview-large" : ""}`}>
      <div className="mk-preview-top">
        <span className="mk-tiny-mark">A</span>
        <span>ArkOffer</span>
        <span className="mk-preview-label">WORKSPACE PREVIEW</span>
        <MoreHorizontal size={18} />
      </div>
      {product === "sourcing" || product === "fillmore" ? (
        <div className="mk-sourcing-preview">
          <div className="mk-agent-orb">
            <Sparkles size={28} />
          </div>
          <h3>Who are you looking for?</h3>
          <p>Great searches start with a little context.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim()) setPreviewResult(true);
            }}
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="A product designer who thinks in systems…"
              aria-label="Try a sample sourcing brief"
            />
            <button aria-label="Preview candidate search">
              <ArrowUpRight size={22} />
            </button>
          </form>
          <div className="mk-preview-tags">
            <span>＋ Job description</span>
            <span>
              <Mic size={13} /> Voice input
            </span>
          </div>
          {previewResult ? (
            <div className="mk-preview-result">
              <Check size={16} />
              <span>
                Brief captured.{" "}
                <Link to="/signup">
                  Create a workspace to start your search.
                </Link>
              </span>
            </div>
          ) : (
            <div className="mk-candidate-pack">
              <div className="mk-avatar-stack">
                <span>JL</span>
                <span>AS</span>
                <span>MK</span>
              </div>
              <div>
                <strong>Your next shortlist starts here</strong>
                <small>One shared view for your hiring team</small>
              </div>
              <ArrowRight size={18} />
            </div>
          )}
        </div>
      ) : product === "job-posts" ? (
        <div className="mk-job-preview">
          <span className="mk-status">Sample job draft</span>
          <h3>Product Designer</h3>
          <p>
            Help a small product team make complex workflows clear. Work with
            engineering and research to take ideas from discovery to delivery.
          </p>
          <div className="mk-job-preview-note">
            <strong>Editorial suggestion</strong>Describe the first project and
            the outcomes the new designer will own.
          </div>
          <p>
            <strong>Missing details to confirm</strong>
            <br />
            Location and working pattern · Salary range · Hiring process
          </p>
          <Link className="mk-preview-link" to="/signup">
            Write your first draft <ArrowRight size={16} />
          </Link>
        </div>
      ) : product === "reports" ? (
        <div className="mk-report-preview">
          <div className="mk-preview-heading">
            <div>
              <small>CONVERSATION INSIGHTS</small>
              <h3>See the bigger picture.</h3>
            </div>
            <span className="mk-status">Sample report</span>
          </div>
          <div className="mk-chart">
            <div className="mk-chart-axis">
              <span>30</span>
              <span>20</span>
              <span>10</span>
              <span>0</span>
            </div>
            {[34, 53, 40, 76, 62, 89, 80].map((n, i) => (
              <div className="mk-chart-column" key={i}>
                <div style={{ height: `${n}%` }}>
                  <span>{Math.round(n / 3)}</span>
                </div>
                <small>{["M", "T", "W", "T", "F", "S", "S"][i]}</small>
              </div>
            ))}
          </div>
          <div className="mk-chart-legend">
            <i /> Interview activity <span>Illustrative data</span>
          </div>
        </div>
      ) : product === "application-review" ? (
        <div className="mk-review-preview">
          <div className="mk-preview-heading">
            <div>
              <small>APPLICATION REVIEW</small>
              <h3>Product Designer</h3>
            </div>
            <span className="mk-status">Sample review</span>
          </div>
          <div className="mk-candidate-row">
            <span className="mk-avatar">JL</span>
            <div>
              <strong>Jordan Lee</strong>
              <small>Product Designer · Singapore</small>
            </div>
            <span className="mk-fit">Review ready</span>
          </div>
          <div className="mk-criteria">
            <span>
              <Check size={16} /> Product design experience
            </span>
            <span>
              <Check size={16} /> Cross-functional collaboration
            </span>
            <span>
              <Check size={16} /> Portfolio attached
            </span>
          </div>
          <div className="mk-preview-actions">
            <span>
              {reviewed
                ? "Added to your sample shortlist"
                : "Your team makes the final call."}
            </span>
            <button onClick={() => setReviewed(!reviewed)}>
              {reviewed ? (
                <>
                  <Check size={15} /> Shortlisted
                </>
              ) : (
                <>
                  Shortlist <ArrowRight size={15} />
                </>
              )}
            </button>
          </div>
        </div>
      ) : product === "screening" ? (
        <div className="mk-screen-preview">
          <div className="mk-preview-heading">
            <div>
              <small>SCREENING BUILDER</small>
              <h3>A thoughtful first conversation.</h3>
            </div>
            <Mic size={25} />
          </div>
          {[
            "Tell me about a project you are proud of.",
            "What was your specific contribution?",
            "What would you do differently?",
          ].map((text, i) => (
            <div className="mk-question" key={text}>
              <span>0{i + 1}</span>
              <p>{text}</p>
              <MoreHorizontal size={15} />
            </div>
          ))}
          <Link to="/signup" className="mk-preview-link">
            Build your interview <ArrowRight size={16} />
          </Link>
        </div>
      ) : product === "outreach" ? (
        <div className="mk-outreach-preview">
          <div className="mk-preview-heading">
            <div>
              <small>YOUR NEXT CONVERSATION</small>
              <h3>A personal introduction.</h3>
            </div>
            <Mail size={25} />
          </div>
          <div className="mk-email-header">
            <span>To</span> Jordan Lee <span>·</span> Sample candidate
          </div>
          <h4>A design role with room to make an impact</h4>
          <p>Hi Jordan,</p>
          <p>
            Your work on making complex products feel simple caught my
            attention. We’re working on a similar challenge, and I’d love to
            tell you more.
          </p>
          <div className="mk-sequence-line">
            <span>
              <Mail size={14} /> Introduction
            </span>
            <i />
            <span>3 days</span>
            <i />
            <span>
              <Send size={14} /> Follow-up
            </span>
          </div>
        </div>
      ) : (
        <div className="mk-notes-preview">
          <div className="mk-preview-heading">
            <div>
              <small>INTERVIEW NOTES</small>
              <h3>Jordan Lee · Product Designer</h3>
            </div>
            <span className="mk-avatar">JL</span>
          </div>
          <div className="mk-preview-tabs">
            {["Summary", "Transcript", "Sources"].map((t) => (
              <button
                className={t === tab ? "active" : ""}
                onClick={() => setTab(t)}
                key={t}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="mk-note-body">
            {tab === "Summary" ? (
              <>
                <h4>Experience & background</h4>
                <p>
                  Jordan shared their approach to simplifying complex workflows,
                  from early research through to the final experience.
                </p>
                <h4>What matters in the next role</h4>
                <ul>
                  <li>Work closely with a collaborative product team.</li>
                  <li>Make decisions with real customer context.</li>
                  <li>Own meaningful work from start to finish.</li>
                </ul>
              </>
            ) : tab === "Transcript" ? (
              <>
                <small>00:42 · JORDAN</small>
                <p>
                  “I’m most interested in the space between understanding a
                  problem and making something that feels simple to use.”
                </p>
                <small>01:18 · INTERVIEWER</small>
                <p>“Can you walk me through an example?”</p>
              </>
            ) : (
              <>
                <div className="mk-source-file">
                  <AudioLines size={22} />
                  <span>
                    Sample interview transcript
                    <small>Illustrative content · 24 minutes</small>
                  </span>
                </div>
                <div className="mk-source-file">
                  <FileText size={22} />
                  <span>
                    Product Designer role brief<small>Additional context</small>
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ProductExplorer() {
  const [active, setActive] = useState<ProductKey>("sourcing");
  const current = products[active];
  const featuredProducts: ProductKey[] = [
    "sourcing",
    "application-review",
    "screening",
    "interview-notes",
    "reports",
    "fillmore",
  ];
  return (
    <section className="mk-section mk-explorer" id="platform">
      <Eyebrow>How it works</Eyebrow>
      <h2>
        AI assistance for every
        <br />
        step of recruiting.
      </h2>
      <p className="mk-section-intro">
        Bring the moving parts of your hiring process into one shared workspace,
        so your team can focus on the conversations that matter.
      </p>
      <div
        className="mk-product-tabs"
        role="tablist"
        aria-label="Explore the platform"
      >
        {featuredProducts.map((key) => {
          const Icon = icons[key];
          return (
            <button
              role="tab"
              aria-selected={active === key}
              tabIndex={active === key ? 0 : -1}
              id={`product-tab-${key}`}
              aria-controls="platform-preview"
              onKeyDown={(event) =>
                moveMarketingTab(
                  event,
                  featuredProducts.indexOf(key),
                  featuredProducts.length,
                  (index) => setActive(featuredProducts[index]),
                )
              }
              key={key}
              className={active === key ? "active" : ""}
              onClick={() => setActive(key)}
            >
              <Icon size={17} />
              {products[key].name}
            </button>
          );
        })}
      </div>
      <div
        id="platform-preview"
        role="tabpanel"
        aria-labelledby={`product-tab-${active}`}
        className={`mk-product-panel mk-panel-${active}`}
      >
        <div className="mk-product-panel-copy">
          <Eyebrow>{current.name}</Eyebrow>
          <h3>{current.short}</h3>
          <p>{current.description}</p>
          <Link to={`/${active}`} className="mk-text-link">
            Explore {current.name.toLowerCase()} <ArrowUpRight size={18} />
          </Link>
        </div>
        <ProductPreview product={active} />
      </div>
    </section>
  );
}

function Home() {
  const [why, setWhy] = useState(0);
  const whyItems = [
    [
      "One shared workspace",
      "Keep role briefs, candidate context, and interview notes together. Your team can pick up the conversation with the same information in front of them.",
    ],
    [
      "Your way of working",
      "Adapt templates, collections, and role criteria to the way your team hires. A clear structure leaves more room for a natural conversation.",
    ],
    [
      "Evidence behind the notes",
      "Move between notes and their source material. Check the details, add context, and bring your own judgment to every decision.",
    ],
    [
      "Context that stays connected",
      "Carry what you learn from the hiring brief into interviews and team discussions. Useful information should not disappear between steps.",
    ],
  ];
  return (
    <>
      <section className="mk-hero">
        <div className="mk-hero-copy">
          <h1>
            Get the right
            <br />
            butts in seats.
          </h1>
          <p>
            ArkOffer is your recruiting workspace for a more thoughtful hiring
            process. Source, engage, and hire with all the context your team
            needs.
          </p>
          <Buttons />
        </div>
        <div className="mk-hero-image">
          <img
            src="/marketing/hero.webp"
            alt="A person in a bright lime outfit taking a seat"
          />
          <a href="#platform" className="mk-hero-watch">
            explore the platform <ArrowUpRight size={23} />
          </a>
        </div>
      </section>
      <div className="mk-workflow-strip" aria-label="Your hiring workflow">
        <span>Built around the way you hire.</span>
        {["Plan", "Source", "Connect", "Interview", "Decide"].map((x, i) => (
          <div key={x}>
            <small>0{i + 1}</small>
            {x}
            {i < 4 && <ArrowRight size={19} />}
          </div>
        ))}
      </div>
      <ProductExplorer />
      <section className="mk-home-coworker">
        <div>
          <h2>Meet your recruiting coworker.</h2>
          <p>Keep the work moving with ArkOffer.</p>
          <Link to="/fillmore" className="mk-button mk-dark">
            Explore the coworker
          </Link>
        </div>
        <img
          src="/marketing/coworker.webp"
          alt="A person in a bright green suit working on a laptop"
          loading="lazy"
        />
      </section>
      <section className="mk-context-section">
        <Eyebrow>Your team, on the same page</Eyebrow>
        <h2>
          Your AI teammate, with the context
          <br />
          to support every step of hiring.
        </h2>
        <Link to="/signup" className="mk-button mk-dark">
          Try ArkOffer <ArrowUpRight size={17} />
        </Link>
        <div className="mk-context-visual">
          <span className="mk-context-node mk-node-one">
            <FileText /> Role brief
          </span>
          <span className="mk-context-node mk-node-two">
            <Users /> Candidate shortlist
          </span>
          <span className="mk-context-center">
            <span className="mk-brand-mark">
              <i />
              <i />
              <i />
            </span>
          </span>
          <span className="mk-context-node mk-node-three">
            <AudioLines /> Interview notes
          </span>
          <span className="mk-context-node mk-node-four">
            <BarChart3 /> Team insights
          </span>
          <div className="mk-orbit mk-orbit-one" />
          <div className="mk-orbit mk-orbit-two" />
        </div>
      </section>
      <section className="mk-section mk-home-impact">
        <div>
          <Eyebrow>From first search to final offer</Eyebrow>
          <h2>A connected view of your hiring process.</h2>
          <p className="mk-section-intro">
            Bring candidate context, conversations and team feedback together,
            so the work you do at one stage informs the next.
          </p>
          <ProductPreview product="reports" />
        </div>
        <div>
          {[
            [
              "More time for candidates",
              "Prepare interviews, organize notes and review draft outreach with the role context close at hand.",
            ],
            [
              "A clearer path through the funnel",
              "Build a shortlist, review applications and organize consistent screening experiences in one workspace.",
            ],
            [
              "Evidence behind the insights",
              "Turn accessible interview transcripts into custom report views with quotations you can inspect.",
            ],
          ].map(([title, body]) => (
            <article key={title}>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="mk-section mk-why">
        <div>
          <Eyebrow>Why ArkOffer</Eyebrow>
          <h2>
            A hiring process
            <br />
            with a clear view.
          </h2>
          <p className="mk-section-intro">
            The work is human. Give your team the space, structure, and shared
            context to do it well.
          </p>
          <img
            className="mk-why-image"
            src="/marketing/context.webp"
            alt="A geometric visualization of connected recruiting context"
            loading="lazy"
          />
        </div>
        <div className="mk-accordion">
          {whyItems.map(([title, body], i) => (
            <div
              className={
                why === i ? "mk-accordion-item active" : "mk-accordion-item"
              }
              key={title}
            >
              <button
                onClick={() => setWhy(why === i ? -1 : i)}
                aria-expanded={why === i}
              >
                <span>0{i + 1}</span>
                <h3>{title}</h3>
                <Plus size={21} />
              </button>
              {why === i && <p>{body}</p>}
            </div>
          ))}
        </div>
      </section>
      <section className="mk-security-section">
        <Eyebrow>AI assistance with human guardrails</Eyebrow>
        <h2>
          Shared context.
          <br />
          Clear access and control.
        </h2>
        <div className="mk-security-grid">
          <div>
            <ShieldCheck size={30} />
            <h3>Control access</h3>
            <p>
              Conversation permissions follow the source when it appears in
              notes, reviews and reports.
            </p>
          </div>
          <div>
            <CheckCheck size={30} />
            <h3>Review before applying</h3>
            <p>
              Inspect AI suggestions and choose which changes to apply to your
              records.
            </p>
          </div>
          <div>
            <History size={30} />
            <h3>Keep the evidence</h3>
            <p>
              Revisit source quotations, saved drafts and recorded workflow
              activity.
            </p>
          </div>
        </div>
      </section>
      <section className="mk-section mk-home-resources">
        <div className="mk-section-heading">
          <div>
            <Eyebrow>Ideas for thoughtful hiring</Eyebrow>
            <h2>
              Make your next
              <br />
              conversation count.
            </h2>
          </div>
          <Link className="mk-button" to="/resources">
            Explore resources <ArrowUpRight size={16} />
          </Link>
        </div>
        <div className="mk-article-grid">
          {articles.slice(0, 3).map((article) => (
            <ArticleCard article={article} key={article.slug} />
          ))}
        </div>
      </section>
      <FAQ />
      <CallToAction />
    </>
  );
}

function FAQ() {
  const [active, setActive] = useState<number | null>(null);
  const questions = [
    [
      "Who is ArkOffer for?",
      "ArkOffer is for recruiters, hiring managers, and teams who want to keep their hiring conversations, candidate context, and role requirements together.",
    ],
    [
      "Can I start with interview notes?",
      "Yes. Create an account and start with the Notes workspace. You can explore the other areas as your workflow grows.",
    ],
    [
      "Can I use my own templates?",
      "Yes. Templates let you choose the structure of your notes and reuse it across your hiring conversations.",
    ],
    [
      "How do integrations work?",
      "Connected features depend on which service providers are configured for your workspace. Check Settings for connection status and the available setup options.",
    ],
    [
      "Who makes the hiring decisions?",
      "Your team does. Notes and structured information support your review; a person remains responsible for candidate decisions.",
    ],
  ];
  return (
    <section className="mk-section mk-faq">
      <Eyebrow>A little more context</Eyebrow>
      <h2>Good questions.</h2>
      <div>
        {questions.map(([q, a], i) => (
          <div className="mk-faq-item" key={q}>
            <button
              onClick={() => setActive(active === i ? null : i)}
              aria-expanded={active === i}
            >
              {q}
              <Plus size={20} />
            </button>
            {active === i && <p>{a}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}
function CallToAction() {
  return (
    <section className="mk-cta">
      <Eyebrow>Welcome to your next chapter</Eyebrow>
      <h2>
        Great hiring starts
        <br />
        with a conversation.
      </h2>
      <p>Give your team a shared place to make it happen.</p>
      <Buttons />
    </section>
  );
}

function Pricing() {
  const location = useLocation();
  const starting =
    new URLSearchParams(location.search).get("product") || "sourcing";
  const [product, setProduct] = useState(starting);
  const [annual, setAnnual] = useState(false);
  const [volume, setVolume] = useState(500);
  useEffect(() => setProduct(starting), [starting]);
  const notes = product === "notes",
    review = product === "application-review",
    all = product === "all-agents";
  const monthlyPrice = notes ? 60 : review ? Math.round(volume * 0.3) : 100;
  const price = (amount: number) => Math.round(amount * (annual ? 0.8 : 1));
  return (
    <>
      <section className="mk-section mk-pricing">
        <Eyebrow>Pricing</Eyebrow>
        <h1>
          Pick what you need.
          <br />
          Make room for better hiring.
        </h1>
        <p className="mk-section-intro">
          Explore the workspace for free. Talk with us about the plan and
          connected services your team needs.
        </p>
        <div className="mk-pricing-controls">
          <div className="mk-pricing-tabs" aria-label="Product pricing">
            {[
              ["sourcing", "Sourcing"],
              ["application-review", "Application Review"],
              ["notes", "Notetaker"],
              ["all-agents", "All agents"],
            ].map(([key, label]) => (
              <Link
                to={`/pricing?product=${key}`}
                className={product === key ? "active" : ""}
                key={key}
              >
                {label}
              </Link>
            ))}
          </div>
          <div className="mk-billing-toggle">
            <button
              className={!annual ? "active" : ""}
              onClick={() => setAnnual(false)}
            >
              Monthly
            </button>
            <button
              className={annual ? "active" : ""}
              onClick={() => setAnnual(true)}
            >
              Yearly <small>−20%</small>
            </button>
          </div>
        </div>
        <p className="mk-pricing-note">
          Indicative plans for planning purposes. Paid service availability and
          billing are confirmed with your team.
        </p>
        {all ? (
          <div className="mk-all-plan">
            <Sparkles size={32} />
            <h2>
              One workspace.
              <br />
              Your whole hiring process.
            </h2>
            <p>
              Bring Notes, Sourcing, Application Review, and team workflows
              together with a plan tailored to your needs.
            </p>
            <Link className="mk-button mk-dark" to="/demo">
              Talk to us <ArrowUpRight size={17} />
            </Link>
          </div>
        ) : (
          <div
            className={`mk-pricing-grid ${review || notes ? "mk-three-plans" : ""}`}
          >
            <PricingCard
              eyebrow="Get started"
              name="Free"
              price="0"
              unit={review ? "monthly" : "per user / month"}
              description={`A place to explore ${notes ? "interview notes" : review ? "application review" : "candidate sourcing"}.`}
              features={
                notes
                  ? [
                      "25 calls per month",
                      "Notes and transcripts",
                      "Customizable templates",
                    ]
                  : review
                    ? [
                        "50 applications per month",
                        "Structured candidate review",
                        "Role criteria and context",
                      ]
                    : [
                        "First 100 profiles",
                        "Candidate shortlists",
                        "Your role requirements",
                      ]
              }
            />
            <PricingCard
              eyebrow="For your everyday work"
              name="Pro"
              price={String(price(monthlyPrice))}
              unit={review ? "per month" : "per user / month"}
              description={
                notes
                  ? "Keep the context from every conversation."
                  : review
                    ? "A clearer view of your candidate pipeline."
                    : "Build and refine your next shortlist."
              }
              features={
                notes
                  ? [
                      "Unlimited calls",
                      "Templates and collections",
                      "Interview context in one place",
                    ]
                  : review
                    ? [
                        `${volume.toLocaleString()} reviews per month`,
                        "Unlimited users",
                        "Candidate evaluation workspace",
                      ]
                    : [
                        "200 profiles per month",
                        "Concurrent searches",
                        "Team feedback and review",
                      ]
              }
              highlight
              annual={annual}
            >
              {review && (
                <label className="mk-volume">
                  {volume.toLocaleString()} reviews / month
                  <input
                    aria-label="Applications per month"
                    type="range"
                    min="500"
                    max="5000"
                    step="500"
                    value={volume}
                    onChange={(e) => setVolume(Number(e.target.value))}
                  />
                </label>
              )}
            </PricingCard>
            {!notes && !review && (
              <PricingCard
                eyebrow="For growing teams"
                name="Max"
                price={String(price(300))}
                unit="per user / month"
                description="More room for your sourcing workflow."
                features={[
                  "Unlimited sourced profiles",
                  "Concurrent searches",
                  "Scheduled search workflows",
                ]}
                annual={annual}
              />
            )}
            <PricingCard
              eyebrow="Built around your team"
              name="Enterprise"
              price="Let’s talk"
              unit="custom plan"
              description="A plan shaped around your organization."
              features={[
                "Custom usage requirements",
                "Team onboarding",
                "Integration planning",
              ]}
              enterprise
            />
          </div>
        )}
      </section>
      <FAQ />
      <CallToAction />
    </>
  );
}

function PricingCard({
  eyebrow,
  name,
  price,
  unit,
  description,
  features,
  highlight = false,
  enterprise = false,
  annual = false,
  children,
}: {
  eyebrow: string;
  name: string;
  price: string;
  unit: string;
  description: string;
  features: string[];
  highlight?: boolean;
  enterprise?: boolean;
  annual?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <article
      className={`mk-price-card ${highlight ? "mk-price-highlight" : ""}`}
    >
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2>{name}</h2>
      <div className={`mk-price ${enterprise ? "mk-price-custom" : ""}`}>
        {enterprise ? price : `$${price}`}
      </div>
      <p className="mk-price-unit">
        {unit}
        {annual && <span>billed yearly</span>}
      </p>
      {children}
      <Link
        to={price === "0" ? "/signup" : "/demo"}
        className={`mk-button ${highlight ? "mk-dark" : ""}`}
      >
        {price === "0"
          ? "Start for free"
          : enterprise
            ? "Book a demo"
            : "Discuss this plan"}
        <ArrowUpRight size={15} />
      </Link>
      <p>{description}</p>
      <ul>
        {features.map((feature) => (
          <li key={feature}>
            <Check size={17} />
            {feature}
          </li>
        ))}
      </ul>
    </article>
  );
}

type Article = (typeof articles)[number];
function ArticleCard({ article }: { article: Article }) {
  return (
    <Link className="mk-article-card" to={`/resources/${article.slug}`}>
      <div className={`mk-article-art mk-art-${article.tone}`}>
        <span>
          ArkOffer
          <br />
          {article.category}
        </span>
        {article.category === "Reporting" ? (
          <BarChart3 />
        ) : article.category === "Sourcing" ? (
          <Target />
        ) : article.category === "Interviewing" ? (
          <AudioLines />
        ) : (
          <Layers />
        )}
        <ArrowUpRight className="mk-article-arrow" size={23} />
      </div>
      <div className="mk-article-meta">
        {article.category}
        <span>{article.time}</span>
      </div>
      <h3>{article.title}</h3>
      <p>{article.description}</p>
    </Link>
  );
}

function Resources() {
  const location = useLocation();
  const tail = location.pathname.split("/")[2];
  const preset =
    tail === "product-updates"
      ? "Product Updates"
      : tail === "interview-questions"
        ? "Interviewing"
        : tail === "research-insights"
          ? "Reporting"
          : "All";
  const [category, setCategory] = useState(preset);
  const [query, setQuery] = useState("");
  useEffect(() => setCategory(preset), [preset]);
  const filtered = articles.filter(
    (a) =>
      (category === "All" || a.category === category) &&
      `${a.title} ${a.description} ${a.category}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <>
      <section className="mk-section mk-resources">
        <Eyebrow>The ArkOffer reading room</Eyebrow>
        <h1>
          Ideas for
          <br />
          thoughtful hiring.
        </h1>
        <p className="mk-section-intro">
          Practical guides, useful questions, and workspace updates. Written for
          the people behind the hiring process.
        </p>
        <div className="mk-resource-search">
          <Search size={20} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all resources…"
            aria-label="Search resources"
          />
          {query && (
            <button aria-label="Clear search" onClick={() => setQuery("")}>
              <X size={17} />
            </button>
          )}
        </div>
        <div className="mk-resource-filters">
          {resourceCategories.map((item) => (
            <button
              className={category === item ? "active" : ""}
              onClick={() => setCategory(item)}
              key={item}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="mk-article-grid">
          {filtered.map((article) => (
            <ArticleCard article={article} key={article.slug} />
          ))}
        </div>
        {filtered.length === 0 && (
          <div className="mk-empty">
            <Search size={32} />
            <h3>No articles found.</h3>
            <p>Try another search or explore all resources.</p>
            <button
              className="mk-button"
              onClick={() => {
                setQuery("");
                setCategory("All");
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </section>
      <Newsletter />
      <CallToAction />
    </>
  );
}

function ArticleDetail({ article }: { article: Article }) {
  return (
    <>
      <article className="mk-article-detail">
        <Link to="/resources" className="mk-back-link">
          ← All resources
        </Link>
        <Eyebrow>
          {article.category} · {article.time}
        </Eyebrow>
        <h1>{article.title}</h1>
        <p className="mk-article-deck">{article.description}</p>
        <div className="mk-byline">
          <span className="mk-tiny-mark">A</span>
          <span>
            ArkOffer editorial
            <br />
            <small>{article.date}</small>
          </span>
        </div>
        <div className={`mk-article-banner mk-art-${article.tone}`}>
          <Layers size={100} />
          <span>
            A little more
            <br />
            context.
          </span>
        </div>
        <div className="mk-article-prose">
          {article.sections.map(([title, body]) => (
            <section key={title}>
              <h2>{title}</h2>
              <p>{body}</p>
            </section>
          ))}
          <p className="mk-article-signoff">
            A guide from ArkOffer. Use these ideas as a starting point and adapt
            them to your team, role, and candidates.
          </p>
        </div>
      </article>
      <section className="mk-section">
        <Eyebrow>Keep exploring</Eyebrow>
        <h2>More food for thought.</h2>
        <div className="mk-article-grid">
          {articles
            .filter((a) => a.slug !== article.slug)
            .slice(0, 3)
            .map((a) => (
              <ArticleCard article={a} key={a.slug} />
            ))}
        </div>
      </section>
      <Newsletter />
    </>
  );
}

async function submitForm(url: string, payload: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : typeof data.message === "string"
          ? data.message
          : "We could not save your request. Please try again.",
    );
  }
}

function Newsletter() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setStatus("loading");
    try {
      await submitForm("/api/newsletter", { email });
      setStatus("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Please try again.");
      setStatus("error");
    }
  }
  return (
    <section className="mk-newsletter">
      <div>
        <Eyebrow>Stay in the conversation</Eyebrow>
        <h2>
          A little more context.
          <br />
          In your inbox.
        </h2>
        <p>Sign up for ArkOffer workspace updates and hiring guides.</p>
      </div>
      <form onSubmit={submit}>
        {status === "success" ? (
          <div className="mk-form-success" role="status">
            <Check size={22} />
            <span>You’re on the list. Thanks for joining us.</span>
          </div>
        ) : (
          <>
            <label htmlFor="mk-newsletter-email">Your work email</label>
            <div className="mk-newsletter-input">
              <input
                id="mk-newsletter-email"
                name="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
              />
              <button
                disabled={status === "loading"}
                aria-label="Subscribe to newsletter"
              >
                {status === "loading" ? "Saving…" : <ArrowRight size={23} />}
              </button>
            </div>
            <p className="mk-form-disclaimer">
              By subscribing, you agree to our{" "}
              <Link to="/privacy-policy">Privacy Policy</Link>.
            </p>
            {status === "error" && (
              <p role="alert" className="mk-form-error">
                {error}
              </p>
            )}
          </>
        )}
      </form>
    </section>
  );
}

function Demo() {
  const [status, setStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setStatus("loading");
    try {
      await submitForm(
        "/api/demo-requests",
        Object.fromEntries(form.entries()) as Record<string, string>,
      );
      setStatus("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Please try again.");
      setStatus("error");
    }
  }
  return (
    <section className="mk-section mk-demo">
      <div>
        <Eyebrow>Let’s talk hiring</Eyebrow>
        <h1>
          A better process
          <br />
          starts here.
        </h1>
        <p>
          Tell us a little about your team and what you want to improve. We’ll
          have the context to make the conversation useful.
        </p>
        <div className="mk-demo-points">
          {[
            "Explore your hiring workflow",
            "Bring your questions and use cases",
            "Discuss the right setup for your team",
          ].map((x) => (
            <div key={x}>
              <Check size={19} />
              {x}
            </div>
          ))}
        </div>
        <div className="mk-demo-art">
          <div className="mk-agent-orb">
            <Sparkles size={42} />
          </div>
          <span>
            People first.
            <br />
            Context always.
          </span>
        </div>
      </div>
      <div className="mk-demo-form">
        {status === "success" ? (
          <div className="mk-demo-success" role="status">
            <span className="mk-success-icon">
              <Check size={35} />
            </span>
            <h2>Your request is in.</h2>
            <p>
              We’ve saved your details. Thank you for your interest in ArkOffer.
            </p>
            <Link className="mk-button mk-dark" to="/signup">
              Explore the workspace <ArrowUpRight size={16} />
            </Link>
          </div>
        ) : (
          <form onSubmit={submit}>
            <h2>Meet ArkOffer.</h2>
            <p>Request a conversation with the team.</p>
            <label htmlFor="mk-demo-name">
              Full name
              <input
                id="mk-demo-name"
                name="name"
                placeholder="Your name"
                autoComplete="name"
                required
              />
            </label>
            <label htmlFor="mk-demo-email">
              Work email
              <input
                id="mk-demo-email"
                name="email"
                type="email"
                placeholder="you@company.com"
                autoComplete="email"
                required
              />
            </label>
            <label htmlFor="mk-demo-company">
              Company
              <input
                id="mk-demo-company"
                name="company"
                placeholder="Company name"
                autoComplete="organization"
                required
              />
            </label>
            <label htmlFor="mk-demo-size">
              Company size
              <select
                id="mk-demo-size"
                name="companySize"
                defaultValue=""
                required
              >
                <option value="" disabled>
                  Select company size
                </option>
                {["1–10", "11–50", "51–200", "201–1,000", "1,001+"].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label htmlFor="mk-demo-message">
              What would you like to explore?
              <textarea
                id="mk-demo-message"
                name="message"
                placeholder="Tell us about your hiring workflow…"
                rows={3}
              />
            </label>
            <button
              className="mk-button mk-dark"
              type="submit"
              disabled={status === "loading"}
            >
              {status === "loading" ? "Sending request…" : "Request a demo"}
              <ArrowRight size={17} />
            </button>
            <p className="mk-form-disclaimer">
              By submitting, you agree to our{" "}
              <Link to="/privacy-policy">Privacy Policy</Link>.
            </p>
            {status === "error" && (
              <p role="alert" className="mk-form-error">
                {error}
              </p>
            )}
          </form>
        )}
      </div>
    </section>
  );
}

function About({ careers = false }: { careers?: boolean }) {
  return (
    <>
      <section className="mk-section mk-about">
        <Eyebrow>{careers ? "Careers at ArkOffer" : "About ArkOffer"}</Eyebrow>
        <h1>
          {careers ? (
            <>
              Good work starts
              <br />
              with good people.
            </>
          ) : (
            <>
              For the people
              <br />
              behind every hire.
            </>
          )}
        </h1>
        <p className="mk-about-lead">
          {careers
            ? "We care about thoughtful tools, clear communication, and making complex work feel simpler."
            : "Hiring is a series of conversations. We believe the information that comes out of them should be easier to find, understand, and use."}
        </p>
        <div className="mk-about-grid">
          <div className="mk-about-statement">
            {careers ? (
              <>
                Bring your
                <br />
                point of view.
              </>
            ) : (
              <>
                People.
                <br />
                Context.
                <br />
                Possibility.
              </>
            )}
          </div>
          <div>
            <h2>
              {careers
                ? "Our next chapter"
                : "One place to see the whole picture."}
            </h2>
            <p>
              {careers
                ? "There are no open positions listed here at the moment. Check this page for future opportunities as the ArkOffer team grows."
                : "ArkOffer brings interview notes, role requirements, candidate workflows, and team context into a shared recruiting workspace."}
            </p>
            <p>
              {careers
                ? "In the meantime, explore the product and the ideas behind it."
                : "The goal is straightforward: help hiring teams spend less time piecing information together, and more time having useful conversations and making considered decisions."}
            </p>
            <Link
              to={careers ? "/about" : "/signup"}
              className="mk-button mk-dark"
            >
              {careers ? "Get to know ArkOffer" : "Explore the workspace"}
              <ArrowUpRight size={16} />
            </Link>
          </div>
        </div>
      </section>
      <CallToAction />
    </>
  );
}

function Legal({ kind }: { kind: string }) {
  const privacy = kind === "privacy-policy";
  const titles: Record<string, string> = {
    "privacy-policy": "Privacy Policy",
    "terms-of-service": "Terms of Service",
    "website-terms-of-use": "Website Terms of Use",
    eula: "End User License Agreement",
  };
  return (
    <section className="mk-section mk-legal">
      <Eyebrow>ArkOffer · Legal</Eyebrow>
      <h1>{titles[kind] || "Legal information"}</h1>
      <div className="mk-legal-notice">
        <FileText size={21} />
        <p>
          Draft policy for this ArkOffer implementation. Updated October 12,
          2026. The workspace operator must review and finalize these terms
          before a public production launch.
        </p>
      </div>
      {(privacy
        ? [
            [
              "Information you provide",
              "ArkOffer processes the information you submit to the workspace, including account details, conversation content, candidate information, and form submissions. Only submit information you are authorized to use.",
            ],
            [
              "How information is used",
              "Information is used to provide the features you request, organize your workspace, respond to submitted requests, and operate the service. Connected AI or integration services may process relevant content when those services are configured and you use the associated features.",
            ],
            [
              "Sharing and access",
              "Workspace permissions and the sharing options you select determine who can access your content. Check the audience before sharing a conversation or collection. External integrations are subject to their own terms.",
            ],
            [
              "Retention and your choices",
              "You can manage available records and sharing settings through the workspace. The deployment operator is responsible for publishing the applicable retention schedule and a contact for access, correction, or deletion requests before production use.",
            ],
            [
              "Cookies and local storage",
              "The application uses session and browser storage necessary for sign-in and workspace preferences. This implementation does not include the reference website’s advertising or tracking scripts.",
            ],
          ]
        : [
            [
              "Using ArkOffer",
              "Use the workspace only for lawful purposes and with appropriate authorization for the content you upload or share. You remain responsible for your account activity and the decisions you make with the information in the workspace.",
            ],
            [
              "Your content",
              "You retain rights to your content. You authorize the workspace to process it as necessary to provide the features you choose. Do not upload material that infringes others’ rights or that you are not permitted to disclose.",
            ],
            [
              "AI-assisted information",
              "Generated notes and other AI-assisted results can contain errors or omissions. Review the source material and verify relevant details before relying on an output. Hiring decisions remain the responsibility of your team.",
            ],
            [
              "Connected services",
              "Some features require separately configured third-party services. Availability depends on those connections and their providers. Displayed plan estimates do not create a paid subscription or a service-level commitment.",
            ],
            [
              "Service operation",
              "This implementation is provided for evaluation. The operator must publish final commercial terms, support details, governing law, and any applicable service commitments before production use.",
            ],
          ]
      ).map(([title, body]) => (
        <section key={title}>
          <h2>{title}</h2>
          <p>{body}</p>
        </section>
      ))}
    </section>
  );
}

function Integrations() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const entries = [
    ["Google Calendar", "Calendar"],
    ["Microsoft Outlook", "Calendar"],
    ["Google Meet", "Video"],
    ["Microsoft Teams", "Video"],
    ["Zoom", "Video"],
    ["Webex", "Video"],
    ["Greenhouse", "ATS"],
    ["Ashby", "ATS"],
    ["Lever", "ATS"],
    ["Workday", "ATS"],
    ["Slack", "Communication"],
    ["Zapier", "Automation"],
  ];
  const matches = entries.filter(
    ([name, cat]) =>
      (category === "All" || cat === category) &&
      name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <section className="mk-section mk-integrations">
        <Eyebrow>Your tools, with context</Eyebrow>
        <h1>
          A connected
          <br />
          hiring workspace.
        </h1>
        <p className="mk-section-intro">
          Explore the services in a recruiting stack. Connection availability
          depends on your workspace configuration; open Settings to see what is
          ready to connect.
        </p>
        <div className="mk-resource-search">
          <Search size={19} />
          <input
            aria-label="Search integrations"
            placeholder="Search integrations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="mk-resource-filters">
          {[
            "All",
            "Calendar",
            "Video",
            "ATS",
            "Communication",
            "Automation",
          ].map((x) => (
            <button
              key={x}
              onClick={() => setCategory(x)}
              className={x === category ? "active" : ""}
            >
              {x}
            </button>
          ))}
        </div>
        <div className="mk-integration-grid">
          {matches.map(([name, cat]) => (
            <Link to="/app/settings?tab=integrations" key={name}>
              <span>
                <Globe size={23} />
              </span>
              <h3>{name}</h3>
              <p>{cat}</p>
              <small>
                Check workspace availability <ArrowUpRight size={13} />
              </small>
            </Link>
          ))}
        </div>
        {matches.length === 0 && (
          <p className="mk-empty">No matching services. Try another search.</p>
        )}
      </section>
      <CallToAction />
    </>
  );
}

function Utility({ path }: { path: string }) {
  if (path === "/desktop")
    return (
      <section className="mk-section mk-utility">
        <Eyebrow>Take your conversations with you</Eyebrow>
        <h1>
          Your workspace.
          <br />
          In your browser.
        </h1>
        <p>
          ArkOffer is available on the web. A standalone desktop installer is
          not available in this implementation.
        </p>
        <Link className="mk-button mk-dark" to="/notes">
          Open ArkOffer <ArrowUpRight size={17} />
        </Link>
      </section>
    );
  if (path === "/referral")
    return (
      <section className="mk-section mk-utility">
        <Eyebrow>Better, together</Eyebrow>
        <h1>
          Bring your team
          <br />
          into the conversation.
        </h1>
        <p>
          Each account creates its own workspace. Share a read-only conversation
          link with colleagues when you want their context. Team invitations and
          referral rewards are not available in this version.
        </p>
        <Link className="mk-button mk-dark" to="/signup">
          Create a workspace <ArrowUpRight size={17} />
        </Link>
      </section>
    );
  return (
    <section className="mk-section mk-utility">
      <Eyebrow>Let’s find your way back</Eyebrow>
      <h1>This page isn’t here.</h1>
      <p>
        The link may have changed. Explore the platform or return to the
        homepage.
      </p>
      <Link className="mk-button mk-dark" to="/">
        Back to ArkOffer <ArrowRight size={17} />
      </Link>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mk-footer">
      <div className="mk-footer-top">
        <div className="mk-footer-brand">
          <Brand />
          <p>
            For the people
            <br />
            behind every hire.
          </p>
          <Link className="mk-text-link" to="/signup">
            Start your next chapter <ArrowUpRight size={18} />
          </Link>
        </div>
        <div>
          <h3>Platform</h3>
          {productKeys.map((key) => (
            <Link to={`/${key}`} key={key}>
              {products[key].name}
            </Link>
          ))}
        </div>
        <div>
          <h3>Resources</h3>
          <Link to="/resources">All resources</Link>
          <Link to="/resources/product-updates">Product updates</Link>
          <Link to="/resources/interview-questions">Interviewing guides</Link>
          <Link to="/integrations">Integrations</Link>
          <Link to="/desktop">Desktop</Link>
          <Link to="/referral">Invite your team</Link>
        </div>
        <div>
          <h3>Company</h3>
          <Link to="/about">About</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/careers">Careers</Link>
          <Link to="/demo">Book a demo</Link>
          <Link to="/login">Sign in</Link>
        </div>
      </div>
      <div className="mk-footer-bottom">
        <span>© {new Date().getFullYear()} ArkOffer</span>
        <div>
          <Link to="/privacy-policy">Privacy Policy</Link>
          <Link to="/terms-of-service">Terms of Service</Link>
          <Link to="/website-terms-of-use">Website terms</Link>
          <Link to="/eula">EULA</Link>
        </div>
        <span>Built for thoughtful hiring.</span>
      </div>
    </footer>
  );
}

export function Marketing() {
  const location = useLocation();
  const path = location.pathname.replace(/\/$/, "") || "/";
  const product = path.slice(1) as ProductKey;
  const article = articles.find(
    (a) =>
      path === `/resources/${a.slug}` || path === `/resources/blog/${a.slug}`,
  );
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    document.title =
      path === "/"
        ? "ArkOffer — Your recruiting workspace"
        : `${article?.title || products[product]?.name || (path === "/pricing" ? "Pricing" : path === "/demo" ? "Book a demo" : path.startsWith("/resources") ? "Resources" : "ArkOffer")} · ArkOffer`;
  }, [path, article, product]);
  let page: React.ReactNode;
  if (path === "/") page = <Home />;
  else if (products[product])
    page = (
      <ProductLanding
        key={product}
        product={product}
        Preview={ProductPreview}
      />
    );
  else if (path === "/pricing") page = <Pricing />;
  else if (article) page = <ArticleDetail article={article} />;
  else if (path.startsWith("/resources")) page = <Resources />;
  else if (path === "/demo") page = <Demo />;
  else if (path === "/about" || path === "/careers")
    page = <About careers={path === "/careers"} />;
  else if (
    [
      "privacy-policy",
      "terms-of-service",
      "website-terms-of-use",
      "eula",
    ].includes(product)
  )
    page = <Legal kind={product} />;
  else if (path === "/integrations") page = <Integrations />;
  else page = <Utility path={path} />;
  return (
    <div
      className={`marketing ${["sourcing", "screening", "interview-notes", "outreach"].includes(product) ? "mk-public-dark" : product === "application-review" ? "mk-public-mint" : ""}`}
    >
      <a className="mk-skip-link" href="#mk-main">
        Skip to content
      </a>
      <Navigation />
      <main id="mk-main">{page}</main>
      <Footer />
    </div>
  );
}

export default Marketing;
