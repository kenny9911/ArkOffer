import { useState, type ComponentType } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  Check,
  ChevronDown,
  FileText,
  Mail,
  MessageSquare,
  Mic,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import { products, type ProductKey } from "./content";
import { moveMarketingTab } from "./tabNavigation";

type Preview = ComponentType<{ product: ProductKey; large?: boolean }>;
type Landing = {
  title: [string, string];
  description: string;
  section: string;
  steps: [string, string][];
  faq: [string, string][];
};
const pages: Record<ProductKey, Landing> = {
  sourcing: {
    title: ["AI sourcing, calibrated", "to your hiring brief."],
    description:
      "Describe the experience you need. Build a search with your role context, review candidate profiles, and refine it with feedback from your team.",
    section: "Your hiring needs, in your own words.",
    steps: [
      [
        "Describe the role",
        "Start with a natural-language brief. Capture the skills, experience and location that matter for your search.",
      ],
      [
        "Bring your context",
        "Add a role description and example profiles to keep the search grounded in the opportunity.",
      ],
      [
        "Calibrate together",
        "Inspect candidate evidence, record feedback and keep your shortlist aligned with your hiring team.",
      ],
    ],
    faq: [
      [
        "Where do the candidate profiles come from?",
        "Your workspace records and the sourcing providers enabled for your workspace. Source links and provider availability are shown in the app; AI does not invent candidate profiles.",
      ],
      [
        "Can I refine a search?",
        "Yes. Keep the conversation going with role requirements and explicit feedback on the results.",
      ],
      [
        "Can I contact candidates from my shortlist?",
        "Add selected candidates to a sequence, review the messages and configure a sending account before sending.",
      ],
    ],
  },
  "application-review": {
    title: [
      "A clearer view of every application.",
      "More room for human judgment.",
    ],
    description:
      "Agree on the role criteria, inspect the evidence and focus your team's review. AI assistance brings relevant details together while your team makes every hiring decision.",
    section: "An AI coworker that helps you evaluate.",
    steps: [
      [
        "Align on the ideal candidate profile.",
        "Review and approve job-specific criteria before generating an assessment. Separate essential requirements from preferences.",
      ],
      [
        "Find the evidence.",
        "Compare professional profile details and selected interview transcripts with approved criteria. Inspect the source quotations behind each finding.",
      ],
      [
        "People always decide.",
        "Add private review notes, acknowledge the evidence and make your own decision. AI assistance does not progress or reject candidates.",
      ],
    ],
    faq: [
      [
        "Does AI make the hiring decision?",
        "No. ArkOffer supplies evidence for review. Decisions and application status changes remain with your team.",
      ],
      [
        "Can I customize review criteria?",
        "Yes. Define or draft criteria for the role, then review and approve them before running assistance.",
      ],
      [
        "Who can read an AI review?",
        "AI review history and annotations are private to the person who generated them. Shared application records follow workspace access rules.",
      ],
    ],
  },
  screening: {
    title: ["A first conversation.", "On the candidate’s schedule."],
    description:
      "Build a role-specific screening experience, share a candidate link and review the responses with the same questions and criteria close at hand.",
    section: "Screening that goes beyond a résumé.",
    steps: [
      [
        "Build it.",
        "Write the questions, instructions and role context. Preview the candidate experience before publishing.",
      ],
      [
        "Share it.",
        "Give candidates a published screening link so they can respond without scheduling a live call.",
      ],
      [
        "Review it.",
        "Read responses with the screening rubric, add your assessment and choose the next step yourself.",
      ],
    ],
    faq: [
      [
        "Can I preview a screening?",
        "Yes. Review the questions and candidate instructions before you publish and share a link.",
      ],
      [
        "Is voice screening available?",
        "Voice responses require the audio provider to be configured for your workspace. Text screening remains available when it is not.",
      ],
      [
        "Does it work on mobile?",
        "The candidate screening pages adapt to mobile and desktop browsers. Microphone capture also requires browser permission.",
      ],
    ],
  },
  "interview-notes": {
    title: ["AI notetaking made for interviews", "and hiring teams."],
    description:
      "Give your team structured interview notes, faster follow-through and a clear path back to the original conversation.",
    section: "Notes that lead to better hiring conversations.",
    steps: [
      [
        "Capture the conversation.",
        "Upload a transcript, add a recording or connect a supported meeting recorder. Keep the source beside the summary.",
      ],
      [
        "Your structure. Your context.",
        "Use configurable templates, edit individual sections and review suggested changes before applying them.",
      ],
      [
        "Share the full picture.",
        "Collect related conversations, create summaries and share the context with the people who need it.",
      ],
    ],
    faq: [
      [
        "Can I control how notes are structured?",
        "Yes. Create a reusable template, choose sections and edit the resulting notes. Targeted AI edits are previewed before applying.",
      ],
      [
        "Can I bring an existing transcript?",
        "Yes. Upload or paste a transcript into the Notes workspace and use it as the source for your notes.",
      ],
      [
        "How is access controlled?",
        "Conversation access is checked when notes and source evidence are read. Sharing and retention controls are available in the workspace.",
      ],
    ],
  },
  reports: {
    title: ["Your hiring conversations.", "A clearer picture."],
    description:
      "Filter conversations, build custom views and extract the details you need. Keep every AI-generated insight connected to its source evidence.",
    section: "Uncover useful insights from hiring conversations.",
    steps: [
      [
        "Focus on the conversations that matter.",
        "Choose source conversations and use date and title filters to define a saved report view.",
      ],
      [
        "Ask for the detail you need.",
        "Define text, number, yes/no or currency columns. AI extracts values with exact source quotations, making uncertain or missing information visible.",
      ],
      [
        "Review, annotate and export.",
        "Track progress, inspect evidence, add private annotations and download a CSV for further analysis.",
      ],
    ],
    faq: [
      [
        "Can I create custom report columns?",
        "Yes. Define each column's question and choose text, number, boolean or currency output.",
      ],
      [
        "Can I check an answer against the interview?",
        "Yes. Each supported answer includes a source quotation. Evidence is hidden if you lose access to the source conversation.",
      ],
      [
        "Are report runs shared or scheduled?",
        "AI report views are currently private to their author. CSV export is available; scheduled report subscriptions are not yet supported.",
      ],
    ],
  },
  outreach: {
    title: ["Outreach sequences built into", "your sourcing flow."],
    description:
      "Bring your shortlist and candidate messages together. Personalize the introduction, plan the follow-up and review every step before reaching out.",
    section: "Find, connect and keep the conversation moving.",
    steps: [
      [
        "Start from your shortlist.",
        "Choose the candidates you want to contact and keep their role context with the sequence.",
      ],
      [
        "Make every message relevant.",
        "Build email steps with candidate variables, sender details and a clear reason to reply.",
      ],
      [
        "Plan the next step.",
        "Set timing, preview the message and monitor recipient progress. Sending requires a configured provider and explicit activation.",
      ],
    ],
    faq: [
      [
        "Does creating a sequence send messages?",
        "No. Save and preview your sequence first. Sending requires a configured account and an explicit activation step.",
      ],
      [
        "Can I personalize messages?",
        "Yes. Use candidate and role details in the sequence editor and review the rendered message before activating outreach.",
      ],
      [
        "Can I review delivery activity?",
        "Yes. Sequence recipients and the outreach activity log show progress and provider-reported outcomes.",
      ],
    ],
  },
  "job-posts": {
    title: ["Purpose-built AI for", "clearer job posts."],
    description:
      "Turn a role brief into a useful first draft. Review suggestions, check the details and keep the final description in your team's voice.",
    section: "An AI writing partner for your job posts.",
    steps: [
      [
        "Start with what the role needs.",
        "Add responsibilities, requirements and company context. The draft uses the facts you provide.",
      ],
      [
        "Review practical suggestions.",
        "See the proposed description, editorial suggestions and missing information together. Edit the wording before applying it.",
      ],
      [
        "Keep control of the final post.",
        "Apply the reviewed draft to the job record. Salary, status and other role details stay under your control; no external posting occurs automatically.",
      ],
    ],
    faq: [
      [
        "Will a draft publish to a job board?",
        "No. Applying a draft updates your job record in ArkOffer. It does not publish the post to external boards.",
      ],
      [
        "Can I improve an existing description?",
        "Yes. Open a job and choose Improve with AI. Review or edit the proposed changes before applying them.",
      ],
      [
        "Does AI guarantee compliance?",
        "No. Suggestions are editorial assistance. Your team must verify the description and any applicable requirements before publishing.",
      ],
    ],
  },
  fillmore: {
    title: ["your recruiting work.", "connected from the start."],
    description:
      "An AI coworker workspace for role briefs, candidates and the next steps your team approves. Keep the work moving with clear context and visible activity.",
    section: "your workflow, with room for human judgment.",
    steps: [
      [
        "01 — brief",
        "Start with the role, your requirements and the context your team needs to share.",
      ],
      [
        "02 — review",
        "Review candidate information and proposed outreach before deciding what happens next.",
      ],
      [
        "03 — follow through",
        "Keep the workflow visible through activity, tasks and configured Slack notifications.",
      ],
    ],
    faq: [
      [
        "Does the coworker send outreach on its own?",
        "ArkOffer requires configured providers and explicit approval for outbound actions. It does not silently contact candidates.",
      ],
      [
        "Can I connect Slack?",
        "A dedicated Slack app can connect a workspace when the administrator has configured it. Setup and approval are handled in Settings.",
      ],
      [
        "Can I see what happened?",
        "Yes. Review workflow runs and their recorded activity in your workspace.",
      ],
    ],
  },
};

function LandingFAQ({ items }: { items: [string, string][] }) {
  const [open, setOpen] = useState(0);
  return (
    <section className="mk-detail-faq">
      <h2>FAQ</h2>
      <div>
        {items.map(([question, answer], i) => (
          <div className="mk-detail-question" key={question}>
            <button
              aria-expanded={open === i}
              aria-controls={`product-answer-${i}`}
              onClick={() => setOpen(open === i ? -1 : i)}
            >
              {question}
              <ChevronDown size={20} />
            </button>
            {open === i && <p id={`product-answer-${i}`}>{answer}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}

function SourcingInputs() {
  const [active, setActive] = useState(0);
  const modes = [
    {
      name: "Describe it",
      icon: MessageSquare,
      text: "A solutions architect in London with AWS experience and a background in enterprise software.",
    },
    {
      name: "Bring the role",
      icon: FileText,
      text: "Role brief\nSolutions Architect\nCloud architecture · Enterprise customers · AWS",
    },
    {
      name: "Use examples",
      icon: Users,
      text: "Example profile\nExperience building cloud platforms and working directly with enterprise engineering teams.",
    },
  ];
  return (
    <div className="mk-input-explorer">
      <div role="tablist" aria-label="Ways to describe a search">
        {modes.map(({ name, icon: Icon }, i) => (
          <button
            key={name}
            role="tab"
            id={`input-mode-${i}`}
            aria-controls="input-mode-panel"
            aria-selected={active === i}
            tabIndex={active === i ? 0 : -1}
            onKeyDown={(event) =>
              moveMarketingTab(event, i, modes.length, setActive)
            }
            onClick={() => setActive(i)}
          >
            <Icon size={22} />
            {name}
          </button>
        ))}
      </div>
      <div
        className="mk-input-example"
        role="tabpanel"
        id="input-mode-panel"
        aria-labelledby={`input-mode-${active}`}
      >
        <span>Example input</span>
        <p>{modes[active].text}</p>
        <Link to="/signup">
          Start a search <ArrowUpRight size={19} />
        </Link>
      </div>
    </div>
  );
}

function CoworkerFlow() {
  const [step, setStep] = useState(0);
  const examples = [
    {
      title: "you brief your coworker",
      person: "You",
      text: "We’re hiring a senior backend engineer. Here’s the role brief and the experience we need.",
    },
    {
      title: "review the plan",
      person: "ArkOffer",
      text: "The brief is ready. Review the search criteria and decide which candidate sources to use.",
    },
    {
      title: "approve the next step",
      person: "You",
      text: "Let’s review the shortlisted profiles and prepare the first outreach message.",
    },
    {
      title: "keep the context",
      person: "ArkOffer",
      text: "Your feedback and activity stay with the workflow, ready for the next review.",
    },
  ];
  return (
    <div className="mk-coworker-flow">
      <div role="tablist" aria-label="Coworker workflow">
        {examples.map((e, i) => (
          <button
            key={e.title}
            role="tab"
            aria-selected={step === i}
            tabIndex={step === i ? 0 : -1}
            onKeyDown={(event) =>
              moveMarketingTab(event, i, examples.length, setStep)
            }
            aria-controls="coworker-example"
            id={`coworker-step-${i}`}
            onClick={() => setStep(i)}
          >
            {e.title}
          </button>
        ))}
      </div>
      <div
        id="coworker-example"
        role="tabpanel"
        aria-labelledby={`coworker-step-${step}`}
      >
        <small>Illustrative workflow · # hiring-backend</small>
        <div className="mk-chat-message">
          <span>{examples[step].person.slice(0, 1)}</span>
          <p>
            <strong>{examples[step].person}</strong>
            {examples[step].text}
          </p>
        </div>
        <Link to="/signup">
          Open your workspace <ArrowRight size={18} />
        </Link>
      </div>
    </div>
  );
}

export function ProductLanding({
  product,
  Preview,
}: {
  product: ProductKey;
  Preview: Preview;
}) {
  const data = pages[product];
  const split = ["reports", "outreach", "job-posts"].includes(product);
  const dark = [
    "sourcing",
    "screening",
    "interview-notes",
    "outreach",
  ].includes(product);
  return (
    <div className={`mk-detail mk-detail-${product}`}>
      <section className={`mk-detail-hero ${split ? "mk-detail-split" : ""}`}>
        <div className="mk-detail-hero-copy">
          {product === "fillmore" && (
            <p className="mk-coworker-sign">arkoffer coworker</p>
          )}
          {product === "interview-notes" && (
            <Link
              className="mk-notes-callout"
              to="/interview-notes#product-workflow"
            >
              Your conversations, connected to your hiring workflow{" "}
              <ArrowRight size={15} />
            </Link>
          )}
          <h1>
            {data.title[0]}
            <br />
            <span>{data.title[1]}</span>
          </h1>
          <p>{data.description}</p>
          <div className="mk-buttons">
            <Link
              className={`mk-button ${dark ? "mk-light" : "mk-dark"}`}
              to={product === "sourcing" ? "/signup" : "/demo"}
            >
              {product === "sourcing" ? "Get started" : "Book a demo"}
            </Link>
            {product !== "sourcing" && (
              <Link className="mk-button" to="/signup">
                Start for free
              </Link>
            )}
          </div>
        </div>
        {split && (
          <div className="mk-detail-hero-preview">
            <Preview product={product} />
          </div>
        )}
        {product === "sourcing" && (
          <div className="mk-sourcing-horizon" aria-hidden="true">
            <i />
            <i />
            <i />
            <span>
              <Search size={26} />
            </span>
          </div>
        )}
        {product === "interview-notes" && (
          <div className="mk-note-signals" aria-hidden="true">
            <span>Role requirements</span>
            <span>Interview evidence</span>
            <span>Shared templates</span>
            <span>Hiring context</span>
          </div>
        )}
        {(product === "screening" || product === "interview-notes") && (
          <div className="mk-detail-benefits">
            {(product === "screening"
              ? [
                  [Mic, "Questions built for the role"],
                  [AudioLines, "Text and supported voice responses"],
                  [ShieldCheck, "A person makes the decision"],
                ]
              : [
                  [FileText, "Notes in your structure"],
                  [Users, "Context for your hiring team"],
                  [Search, "Evidence you can revisit"],
                ]
            ).map(([Icon, label]) => {
              const I = Icon as typeof Mic;
              return (
                <div key={String(label)}>
                  <I size={22} />
                  <span>{String(label)}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <section className="mk-detail-workflow" id="product-workflow">
        <div className="mk-detail-section-heading">
          <p>How it works</p>
          <h2>{data.section}</h2>
        </div>
        {product === "sourcing" ? (
          <SourcingInputs />
        ) : product === "fillmore" ? (
          <CoworkerFlow />
        ) : (
          <div className="mk-detail-main-preview">
            <Preview product={product} large />
          </div>
        )}
        <div className="mk-detail-steps">
          {data.steps.map(([title, body], i) => (
            <article key={title}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>
      {product === "sourcing" && (
        <section className="mk-market-section">
          <div>
            <p>Explore your talent market</p>
            <h2>
              A clear brief.
              <br />A more focused search.
            </h2>
            <p>
              Keep the market, the role and your team's feedback in the same
              conversation.
            </p>
          </div>
          <div className="mk-search-examples">
            {[
              "Find cloud architects with enterprise software experience",
              "Explore teams building developer tools",
              "Find profiles similar to an example candidate",
              "Map skills across your shortlisted candidates",
            ].map((t, i) => (
              <Link to="/signup" key={t}>
                <span>
                  {[<Search />, <Users />, <FileText />, <MessageSquare />][i]}
                </span>
                {t}
                <ArrowUpRight size={18} />
              </Link>
            ))}
          </div>
        </section>
      )}
      {product === "screening" && (
        <section className="mk-screening-topics">
          <div>
            <p>More than a résumé</p>
            <h2>
              Make room for
              <br />
              the candidate’s story.
            </h2>
          </div>
          <div>
            {[
              "Communication and motivation",
              "Role-specific scenarios",
              "Technical reasoning",
              "Essential requirements",
              "Experience beyond the résumé",
            ].map((t) => (
              <p key={t}>
                <Check size={19} />
                {t}
              </p>
            ))}
          </div>
        </section>
      )}
      {product === "interview-notes" && (
        <section className="mk-notes-detail">
          <h2>
            Notetaking specifically
            <br />
            for recruiting.
          </h2>
          <div>
            {[
              [
                "Configurable templates",
                "Choose a repeatable structure for screens, panels and intake conversations.",
              ],
              [
                "Targeted note edits",
                "Shorten a section, change its structure or correct an exact term with a preview before applying.",
              ],
              [
                "Source-linked context",
                "Move from a summary to the original interview evidence when a detail matters.",
              ],
              [
                "Connected reporting",
                "Use accessible conversations as sources for private AI report views.",
              ],
            ].map(([t, b]) => (
              <article key={t}>
                <FileText size={25} />
                <h3>{t}</h3>
                <p>{b}</p>
              </article>
            ))}
          </div>
        </section>
      )}
      <section className="mk-detail-connected">
        <div>
          <p>One connected workspace</p>
          <h2>
            {product === "sourcing"
              ? "Sourcing is only the start."
              : "Keep the context.\nMove the work forward."}
          </h2>
        </div>
        <div>
          {(
            [
              "sourcing",
              "application-review",
              "screening",
              "interview-notes",
              "reports",
              "outreach",
            ] as ProductKey[]
          )
            .filter((k) => k !== product)
            .slice(0, 4)
            .map((k) => (
              <Link to={`/${k}`} key={k}>
                <span>{products[k].name}</span>
                <p>{products[k].short}</p>
                <ArrowUpRight size={20} />
              </Link>
            ))}
        </div>
      </section>
      <section className="mk-detail-cta">
        <h2>
          {product === "fillmore"
            ? "make your next hire.\nwith the context to get it right."
            : "Your next great hire\nstarts with a conversation."}
        </h2>
        <p>Bring your team and your hiring workflow together.</p>
        <div className="mk-buttons">
          <Link className="mk-button mk-dark" to="/demo">
            Book a demo
          </Link>
          <Link className="mk-button" to="/signup">
            Start for free
          </Link>
        </div>
      </section>
      <LandingFAQ key={product} items={data.faq} />
    </div>
  );
}
