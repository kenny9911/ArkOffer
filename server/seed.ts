import { randomUUID } from "node:crypto";
import type { Store, Resource } from "./db.js";

type TemplateDefinition = {
  name: string;
  description: string;
  category: string;
  sections: Array<[string, string]>;
};

export const DEFAULT_TEMPLATES: TemplateDefinition[] = [
  {
    name: "Question and Answer",
    description:
      "Keep each interview question beside the evidence in the answer.",
    category: "Interview",
    sections: [
      [
        "Questions & answers",
        "List the questions asked and summarize each answer directly beneath its question. Preserve concrete examples and indicate unanswered questions.",
      ],
      [
        "Follow-up questions",
        "List questions that participants explicitly left open or agreed to revisit.",
      ],
      [
        "Agreed next steps",
        "Capture stated actions, owners, and timing. Do not invent commitments.",
      ],
    ],
  },
  {
    name: "Topic Highlights",
    description: "Organize the conversation around its main topics.",
    category: "Interview",
    sections: [
      [
        "Topics discussed",
        "Group the conversation into its main topics. Summarize only statements supported by the transcript.",
      ],
      [
        "Examples & outcomes",
        "Capture specific examples and reported results, including numbers only when stated.",
      ],
      [
        "Open points",
        "List unresolved questions, disagreements, and explicitly agreed follow-ups.",
      ],
    ],
  },
  {
    name: "Recruiter Screen",
    description:
      "Capture experience, motivation, and practical details from an introductory call.",
    category: "Screening",
    sections: [
      [
        "Background & experience",
        "Summarize relevant roles, responsibilities, and examples the candidate described.",
      ],
      [
        "Motivation & interests",
        "Capture what the candidate said they want from their next role and why this opportunity interests them.",
      ],
      [
        "Practical details",
        "Record availability, location preferences, and compensation expectations only if explicitly discussed.",
      ],
      [
        "Next steps",
        "List the next steps and open questions agreed during the call.",
      ],
    ],
  },
  {
    name: "Generic Debrief",
    description: "Keep interview feedback grounded in the examples discussed.",
    category: "Debrief",
    sections: [
      [
        "Interview evidence",
        "Summarize the examples and observations discussed. Attribute opinions to their speakers.",
      ],
      [
        "Strengths discussed",
        "Capture strengths participants identified and the supporting evidence they cited.",
      ],
      [
        "Questions & concerns",
        "Capture concerns and missing evidence as stated, without introducing new judgments.",
      ],
      [
        "Decisions & follow-ups",
        "Record explicit decisions and agreed follow-ups. Do not independently recommend a hiring decision.",
      ],
    ],
  },
  {
    name: "Team-Specific Debrief",
    description:
      "Connect interview evidence to the team requirements that were discussed.",
    category: "Debrief",
    sections: [
      [
        "Team needs",
        "List the team responsibilities and success criteria participants explicitly discussed.",
      ],
      [
        "Relevant evidence",
        "Connect stated candidate examples to those requirements without inventing a fit score.",
      ],
      [
        "Outstanding questions",
        "Identify requirements for which participants said more evidence is needed.",
      ],
      [
        "Agreed follow-ups",
        "Capture stated owners, actions, and decisions from the debrief.",
      ],
    ],
  },
  {
    name: "Technical Debrief",
    description:
      "Document technical observations and the reasoning behind feedback.",
    category: "Debrief",
    sections: [
      [
        "Technical topics",
        "Summarize the technical problems, systems, and skills discussed in the debrief.",
      ],
      [
        "Evidence & observations",
        "Capture concrete solution choices and observations, attributing feedback to the speaker.",
      ],
      [
        "Trade-offs & gaps",
        "List trade-offs and unanswered technical questions participants identified.",
      ],
      [
        "Next steps",
        "Record explicit decisions and follow-up work without creating a hiring recommendation.",
      ],
    ],
  },
  {
    name: "Intake | Role Scope",
    description: "Turn a role intake discussion into a clear hiring brief.",
    category: "Planning",
    sections: [
      [
        "Role purpose & scope",
        "Summarize the role purpose, responsibilities, reporting line, and boundaries stated in the conversation.",
      ],
      [
        "Requirements & success",
        "Separate explicitly required skills from preferences. Capture the success measures participants named.",
      ],
      [
        "Process & practical details",
        "Capture the discussed interview process, location, compensation range, and timeline when stated.",
      ],
      [
        "Open decisions",
        "List unresolved requirements and agreed actions with their stated owners.",
      ],
    ],
  },
  {
    name: "Candidate Pack",
    description: "Prepare a factual candidate overview from the conversation.",
    category: "Interview",
    sections: [
      [
        "Candidate overview",
        "Summarize the candidate’s stated experience and career direction using only transcript evidence.",
      ],
      [
        "Relevant work",
        "Capture projects, responsibilities, and outcomes the candidate described.",
      ],
      [
        "Interests & practical details",
        "Record stated role interests, availability, and working preferences. Do not infer personal attributes.",
      ],
      [
        "Questions for the next conversation",
        "List unanswered questions and follow-ups raised in the transcript.",
      ],
    ],
  },
  {
    name: "Coding Interview",
    description:
      "Capture the problem-solving process and evidence from a coding conversation.",
    category: "Technical",
    sections: [
      [
        "Problem & assumptions",
        "Describe the coding problem, constraints, and assumptions explicitly discussed.",
      ],
      [
        "Approach & implementation",
        "Summarize the candidate’s approach, implementation choices, and explanations.",
      ],
      [
        "Testing & trade-offs",
        "Capture tests, edge cases, complexity analysis, and trade-offs mentioned in the conversation.",
      ],
      [
        "Hints & open questions",
        "Record assistance given and unresolved points without inferring a performance rating.",
      ],
    ],
  },
  {
    name: "System Design Interview",
    description:
      "Record requirements, design decisions, and technical trade-offs.",
    category: "Technical",
    sections: [
      [
        "Requirements & constraints",
        "List functional requirements, scale assumptions, and constraints stated in the discussion.",
      ],
      [
        "Proposed architecture",
        "Describe the components and data flows the candidate proposed, without filling in missing design details.",
      ],
      [
        "Trade-offs & failure cases",
        "Capture alternatives, bottlenecks, reliability concerns, and mitigations actually discussed.",
      ],
      [
        "Unresolved points",
        "List unanswered design questions and feedback explicitly provided.",
      ],
    ],
  },
  {
    name: "Role Alignment",
    description:
      "Compare stated role expectations with the candidate’s expressed interests.",
    category: "Planning",
    sections: [
      [
        "Role expectations",
        "Summarize responsibilities and success expectations stated by the hiring team.",
      ],
      [
        "Candidate priorities",
        "Capture the candidate’s stated goals, preferred responsibilities, and working preferences.",
      ],
      [
        "Points to clarify",
        "Identify explicit agreements, differences, and questions raised about the role. Do not calculate a fit score.",
      ],
      [
        "Agreed actions",
        "List concrete next steps and who agreed to take them.",
      ],
    ],
  },
  {
    name: "Client Call",
    description:
      "Keep client priorities, commitments, and follow-ups together.",
    category: "Client",
    sections: [
      [
        "Client priorities",
        "Summarize the client’s stated needs, goals, and constraints.",
      ],
      [
        "Topics & decisions",
        "Capture the main discussion points and decisions explicitly made.",
      ],
      [
        "Actions & owners",
        "List agreed actions, named owners, and deadlines when provided.",
      ],
      [
        "Open questions",
        "Record unresolved issues and information participants agreed to provide.",
      ],
    ],
  },
];

export function seedTemplates(store: Store, workspaceId: string) {
  const timestamp = new Date().toISOString();
  for (const definition of DEFAULT_TEMPLATES) {
    store.insert(workspaceId, "templates", {
      ...definition,
      id: randomUUID(),
      builtIn: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      sections: definition.sections.map(([title, prompt]) => ({
        id: randomUUID(),
        title,
        prompt,
      })),
    });
  }
}

export function seedWorkspace(
  store: Store,
  workspaceId: string,
  userName: string,
) {
  const now = new Date().toISOString();
  const add = (kind: string, data: Record<string, unknown>) =>
    store.insert(workspaceId, kind, {
      ...data,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    } as Resource);
  const collection = add("collections", {
    name: "Product & engineering",
    description: "Sample hiring conversations",
    color: "#7c6cf0",
  });
  const candidates = [
    {
      name: "Alex Morgan",
      email: "alex.morgan@example.com",
      role: "Senior Product Designer",
      stage: "Interview",
      location: "San Francisco",
      company: "Northstar",
      tags: ["Product design", "B2B SaaS"],
    },
    {
      name: "Jordan Lee",
      email: "jordan.lee@example.com",
      role: "Senior Software Engineer",
      stage: "Screening",
      location: "London",
      company: "Orbit",
      tags: ["TypeScript", "Platform"],
    },
    {
      name: "Sam Rivera",
      email: "sam.rivera@example.com",
      role: "Product Manager",
      stage: "New",
      location: "Remote",
      company: "Fern",
      tags: ["Product strategy"],
    },
  ];
  candidates.forEach((candidate) => add("candidates", candidate));
  add("jobs", {
    title: "Senior Product Designer",
    department: "Design",
    location: "San Francisco · Hybrid",
    status: "Open",
    description: "Help us build thoughtful tools for ambitious hiring teams.",
  });
  const transcript = `Interviewer: Thanks for joining, Alex. Can you tell me about your recent work?\nAlex: I have spent the last four years designing collaboration tools at Northstar. I led a redesign of our onboarding journey with a product manager and six engineers.\nInterviewer: How did you approach the project?\nAlex: We interviewed twelve customers, mapped where people got stuck, and tested two prototypes. The new flow reduced the time to first project from eighteen minutes to seven.\nInterviewer: What are you looking for in your next role?\nAlex: I want to work closely with customers and own a product area from research through launch. I enjoy complex B2B workflows and making them feel simple.\nInterviewer: How do you collaborate with engineering?\nAlex: I bring engineers into early discovery and document edge cases before handoff. We review working builds together every week.\nInterviewer: What would your availability look like?\nAlex: I can start in six weeks and prefer a hybrid team in San Francisco.\nInterviewer: Great. Our next step is a portfolio conversation with the design lead. We will send details this week.`;
  add("conversations", {
    title: "Alex Morgan — Product Designer",
    candidate: "Alex Morgan",
    interviewer: userName,
    date: now,
    duration: 32,
    status: "ready",
    archived: false,
    collectionIds: [collection.id],
    shared: false,
    isDemo: true,
    transcript,
    tldr: "Alex has four years of B2B product design experience, led an onboarding redesign, and is looking for end-to-end product ownership. Available in six weeks.",
    sections: [
      {
        id: randomUUID(),
        title: "Background & experience",
        content:
          "Four years designing collaboration tools at Northstar. Led an onboarding redesign alongside a product manager and six engineers.",
      },
      {
        id: randomUUID(),
        title: "Skills & strengths",
        content:
          "Customer research, prototyping, and close engineering collaboration. Reduced onboarding time from eighteen to seven minutes.",
      },
      {
        id: randomUUID(),
        title: "Next steps",
        content:
          "Arrange a portfolio conversation with the design lead. Candidate can start in six weeks and prefers a hybrid San Francisco team.",
      },
    ],
  });
  add("conversations", {
    title: "Jordan Lee — Software Engineer",
    candidate: "Jordan Lee",
    interviewer: userName,
    date: now,
    duration: 25,
    status: "ready",
    archived: false,
    collectionIds: [],
    shared: false,
    isDemo: true,
    transcript:
      "Interviewer: Tell me about your platform work.\nJordan: I built internal TypeScript services and reduced our deployment time by improving CI pipelines. I enjoy mentoring engineers and designing reliable APIs.\nInterviewer: What are you looking for next?\nJordan: A team with strong product ownership and room to develop technical leadership.\nInterviewer: The next step is a technical conversation with our engineering lead.",
    tldr: "Jordan builds TypeScript services and developer tools, with an interest in technical leadership.",
    sections: [
      {
        id: randomUUID(),
        title: "Experience",
        content:
          "Built internal TypeScript services and improved deployment pipelines.",
      },
      {
        id: randomUUID(),
        title: "Next steps",
        content: "Schedule a technical conversation with the engineering lead.",
      },
    ],
  });
}
