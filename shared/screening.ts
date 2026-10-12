import type { z } from "zod";
import type {
  screeningConfigSchema,
  screeningQuestionSchema,
} from "./screening-schema.js";

export type ScreeningConfig = z.infer<typeof screeningConfigSchema>;
export type ScreeningQuestion = z.infer<typeof screeningQuestionSchema>;
export type ScreeningItem = {
  id: string;
  name: string;
  title: string;
  description: string;
  jobId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  screeningConfig: ScreeningConfig;
  questions: Array<ScreeningQuestion & { sectionTitle: string }>;
  [key: string]: unknown;
};

export function newScreeningConfig(): ScreeningConfig {
  return {
    version: 1,
    setup: {
      welcomeMessage:
        "Welcome to your screening for {{screening_title}} with {{company_name}}. Share your experience in your own words.",
      completionMessage:
        "Thank you for sharing your experience. Our team will review your responses.",
      language: "en-US",
      voice: "",
      interviewMode: "questionnaire",
      cameraPolicy: "optional",
    },
    context: { role: "", company: "" },
    outreach: { deadlineDays: 7 },
    sections: [
      {
        id: crypto.randomUUID(),
        title: "Experience and motivation",
        goal: "Understand relevant professional experience.",
        questions: [],
      },
    ],
  };
}

export function screeningMessage(
  message: string,
  title: string,
  company: string,
) {
  return message
    .replaceAll("{{screening_title}}", title)
    .replaceAll("{{company_name}}", company);
}
