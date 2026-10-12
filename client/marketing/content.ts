export type ProductKey =
  | "sourcing"
  | "application-review"
  | "screening"
  | "interview-notes"
  | "reports"
  | "outreach"
  | "job-posts"
  | "fillmore";

export const products: Record<
  ProductKey,
  {
    name: string;
    eyebrow: string;
    title: string;
    description: string;
    short: string;
    features: [string, string][];
  }
> = {
  sourcing: {
    name: "Sourcing",
    eyebrow: "Find your next great hire",
    title: "Your next great hire.\nCloser than you think.",
    description:
      "Turn a hiring brief into a focused search. Keep candidate profiles, your criteria, and team feedback together from the first idea to the shortlist.",
    short: "Find candidates who fit your brief.",
    features: [
      [
        "Start with the role",
        "Describe who you need in your own words, then refine a clear ideal candidate profile.",
      ],
      [
        "Bring your context",
        "Keep your job description, role requirements, and preferences close to your search.",
      ],
      [
        "Calibrate together",
        "Review profiles, record your feedback, and build a shortlist your hiring team can work with.",
      ],
    ],
  },
  "application-review": {
    name: "Application Review",
    eyebrow: "Make room for the right conversations",
    title: "A clearer view of\nevery application.",
    description:
      "Bring applications and role requirements into one workspace. Review the evidence, capture your assessment, and move promising candidates forward.",
    short: "Give every application a closer look.",
    features: [
      [
        "Set your criteria",
        "Define what the role needs before reviewing your candidate pool.",
      ],
      [
        "See the whole pipeline",
        "View candidate information and fit assessments together, with the reasoning close at hand.",
      ],
      [
        "Keep people in control",
        "Record your own decision to progress or reject a candidate. Your team makes the final call.",
      ],
    ],
  },
  screening: {
    name: "Screening",
    eyebrow: "Go beyond the résumé",
    title: "Better questions.\nBetter conversations.",
    description:
      "Build a consistent screening plan around the role. Create questions, define your rubric, and review the evidence behind each candidate’s answers.",
    short: "Build a consistent first conversation.",
    features: [
      [
        "Build your interview",
        "Arrange questions and role-specific scoring guidance into a reusable screening plan.",
      ],
      [
        "Prepare the experience",
        "Review the candidate instructions, interview context, and questions before publishing.",
      ],
      [
        "Make an informed decision",
        "Keep responses and assessment criteria together so a person can make the next decision.",
      ],
    ],
  },
  "interview-notes": {
    name: "Notes",
    eyebrow: "Built for hiring conversations",
    title: "Be in the conversation.\nWe’ll help with the notes.",
    description:
      "Turn interview transcripts into organized notes. Bring your team the context they need, without losing the details that make each candidate different.",
    short: "Turn conversations into useful context.",
    features: [
      [
        "Your notes, your way",
        "Use a template to organize the conversation, then edit the details and make the notes your own.",
      ],
      [
        "Keep the evidence close",
        "Read the transcript alongside your notes and find the moments behind an answer.",
      ],
      [
        "Share the full picture",
        "Organize related conversations in collections and share the context with your team.",
      ],
    ],
  },
  reports: {
    name: "Reports",
    eyebrow: "See what your hiring data is telling you",
    title: "Your conversations.\nA bigger picture.",
    description:
      "Explore interview activity, organize the conversations that matter, and build a shared view of your hiring process.",
    short: "Make sense of your hiring conversations.",
    features: [
      [
        "Find the relevant calls",
        "Filter your conversations to focus on a role, interviewer, or period of time.",
      ],
      [
        "Build a useful view",
        "Choose the details that matter and keep your analysis grounded in the source conversations.",
      ],
      [
        "Take the data with you",
        "Export your report for a team discussion or further analysis.",
      ],
    ],
  },
  outreach: {
    name: "Outreach",
    eyebrow: "Start a worthwhile conversation",
    title: "Thoughtful outreach.\nFrom the first hello.",
    description:
      "Plan candidate outreach in the same place as your shortlist. Build a sequence, personalize the message, and keep track of the next step.",
    short: "Keep candidate conversations moving.",
    features: [
      [
        "Write with context",
        "Use the role and candidate’s background to make the opening message relevant.",
      ],
      [
        "Plan the follow-up",
        "Create reusable sequences with a clear purpose for each step.",
      ],
      [
        "Stay coordinated",
        "Keep sequence activity and candidate status visible to your recruiting team.",
      ],
    ],
  },
  "job-posts": {
    name: "Job Posts",
    eyebrow: "A good hire starts with a good brief",
    title: "Job posts with\na clear point of view.",
    description:
      "Create, organize, and refine job descriptions that explain the work, the expectations, and what makes the opportunity worth a conversation.",
    short: "Make your role clear from the start.",
    features: [
      [
        "Get the essentials right",
        "Give candidates a clear picture of the responsibilities, requirements, and hiring process.",
      ],
      [
        "Build from a template",
        "Start with a consistent structure, then adapt it to the role and your company.",
      ],
      [
        "Keep your team aligned",
        "Save the latest draft in your workspace so everyone works from the same brief.",
      ],
    ],
  },
  fillmore: {
    name: "AI coworker",
    eyebrow: "Your recruiting workspace, connected",
    title: "Make more room\nfor the human part.",
    description:
      "Bring your briefs, conversations, and candidate decisions together. ArkOffer gives your team a shared place to work through the hiring process.",
    short: "Connect the context across your workflow.",
    features: [
      [
        "Start with shared context",
        "Give every role a home for its requirements and hiring conversations.",
      ],
      [
        "Move the work forward",
        "Keep track of candidates, notes, and the next steps your team has chosen.",
      ],
      [
        "Learn as a team",
        "Use feedback and interview evidence to keep refining what you are looking for.",
      ],
    ],
  },
};

export const productKeys = Object.keys(products) as ProductKey[];

export const articles = [
  {
    slug: "write-a-better-hiring-brief",
    category: "Guides",
    title: "A better hiring process starts with a better brief.",
    description:
      "Five questions to align a hiring team before the first candidate conversation.",
    date: "October 12, 2026",
    time: "4 min read",
    tone: "green",
    sections: [
      [
        "Start with the work",
        "List the outcomes the person will need to achieve in their first six months. Describe actual projects and decisions, rather than a long list of personality traits.",
      ],
      [
        "Separate requirements from preferences",
        "Write down what someone genuinely needs to do the job, what they can learn, and where your team has flexibility. Revisit this distinction when reviewing a candidate with an unconventional background.",
      ],
      [
        "Agree on the evidence",
        "For each requirement, decide which interview question or work sample would help you understand it. Assign clear coverage across the interview panel so candidates do not answer the same questions repeatedly.",
      ],
      [
        "Keep the brief alive",
        "Capture what you learn from the first few conversations. If the role changes, update the shared brief and tell everyone involved in the process.",
      ],
    ],
  },
  {
    slug: "interview-notes-that-help",
    category: "Interviewing",
    title: "Write interview notes your future self can use.",
    description:
      "Keep the evidence, the uncertainty, and the next question in one place.",
    date: "October 10, 2026",
    time: "3 min read",
    tone: "purple",
    sections: [
      [
        "Capture examples",
        "Specific examples are more useful than broad impressions. Record the project, the candidate’s personal contribution, and the outcome they described. Keep your interpretation separate from what was said.",
      ],
      [
        "Use a repeatable structure",
        "A simple template can make notes easier to compare. Include the role’s key topics, room for evidence, and a place to mark questions that were not covered.",
      ],
      [
        "Check before sharing",
        "Read through your notes before sending them to the panel. Verify names and technical terms, remove irrelevant personal details, and make gaps visible.",
      ],
    ],
  },
  {
    slug: "thoughtful-candidate-outreach",
    category: "Sourcing",
    title: "The best outreach gives someone a reason to reply.",
    description:
      "An approach to candidate messages that respects the person on the other side.",
    date: "October 8, 2026",
    time: "4 min read",
    tone: "peach",
    sections: [
      [
        "Explain why this person",
        "Connect a concrete part of the candidate’s professional experience to the work your team needs help with. Avoid generic compliments that could apply to anyone.",
      ],
      [
        "Make the opportunity concrete",
        "Share enough about the role, team, location, and scope for someone to decide whether a conversation is useful. State what you know and be clear about what is still being defined.",
      ],
      [
        "Make the next step small",
        "A short, clear invitation is easier to respond to than a long list of requests. Keep follow-ups relevant and respect requests to stop receiving messages.",
      ],
    ],
  },
  {
    slug: "a-shared-interview-rubric",
    category: "Guides",
    title: "Build a rubric before you meet the candidates.",
    description:
      "Give interviewers a shared definition of the evidence they are looking for.",
    date: "October 5, 2026",
    time: "5 min read",
    tone: "yellow",
    sections: [
      [
        "Name the competency",
        "Choose a small number of capabilities directly related to the role. Define each one in terms of the work, not a vague label such as culture fit.",
      ],
      [
        "Describe the evidence",
        "Write examples of what a strong, partial, or inconclusive answer might contain. These examples should guide your judgment while leaving room for different backgrounds and approaches.",
      ],
      [
        "Calibrate with the team",
        "Have interviewers discuss the same example answer independently before the first interview. Differences in interpretation often reveal unclear criteria that are easier to fix early.",
      ],
    ],
  },
  {
    slug: "hiring-data-worth-tracking",
    category: "Reporting",
    title: "Start with a question, then build the report.",
    description:
      "A practical way to make recruiting reports useful for the next decision.",
    date: "October 2, 2026",
    time: "3 min read",
    tone: "blue",
    sections: [
      [
        "Choose the decision",
        "Decide what you will do differently based on the report. A question about interview coverage needs a different view from a question about scheduling delays.",
      ],
      [
        "Understand the source",
        "Check which conversations and candidates are included, which are missing, and what each column means. A number without this context is easy to misinterpret.",
      ],
      [
        "Pair trends with examples",
        "Look at the source conversations behind a pattern. Quantitative summaries are a starting point for investigation, and individual examples can help explain what is happening.",
      ],
    ],
  },
  {
    slug: "meet-the-arkoffer-workspace",
    category: "Product Updates",
    title: "One workspace for your hiring context.",
    description:
      "Meet the notes, collections, templates, and candidate workflows in ArkOffer.",
    date: "October 1, 2026",
    time: "2 min read",
    tone: "green",
    sections: [
      [
        "A home for conversations",
        "ArkOffer brings interview notes and transcripts into a shared workspace. Templates help organize the information, and collections keep related conversations together.",
      ],
      [
        "Keep the role in view",
        "Connect candidate work to a clear brief. Use the sourcing, application review, and job post areas to organize the information your team needs.",
      ],
      [
        "Explore with your team",
        "Create an account to try the workspace. Availability of connected services depends on the integrations configured for your workspace.",
      ],
    ],
  },
];

export const resourceCategories = [
  "All",
  "Product Updates",
  "Guides",
  "Interviewing",
  "Sourcing",
  "Reporting",
];
