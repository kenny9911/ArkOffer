import { z } from "zod";

export const screeningQuestionSchema = z
  .object({
    id: z.uuid(),
    prompt: z.string().trim().max(2000),
    type: z.enum(["text", "yes-no", "multiple-choice"]),
    options: z.array(z.string().trim().max(200)).max(20),
    required: z.boolean(),
    rubric: z.string().max(2000).default(""),
    followUp: z.boolean().default(true),
  })
  .strict();

export const screeningConfigSchema = z
  .object({
    version: z.literal(1),
    setup: z
      .object({
        welcomeMessage: z.string().max(5000),
        completionMessage: z.string().max(5000),
        language: z.enum([
          "en-US",
          "en-GB",
          "es-ES",
          "fr-FR",
          "de-DE",
          "pt-BR",
          "zh-CN",
          "ja-JP",
        ]),
        voice: z.string().max(150),
      })
      .strict(),
    context: z
      .object({ role: z.string().max(12000), company: z.string().max(12000) })
      .strict(),
    outreach: z
      .object({ deadlineDays: z.number().int().min(1).max(30) })
      .strict(),
    sections: z
      .array(
        z
          .object({
            id: z.uuid(),
            title: z.string().trim().min(1).max(120),
            goal: z.string().max(2000),
            questions: z.array(screeningQuestionSchema).max(50),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .superRefine((config, ctx) => {
    const questions = config.sections.flatMap((section) => section.questions);
    if (questions.length > 50)
      ctx.addIssue({
        code: "custom",
        message: "A screening can contain at most 50 questions.",
      });
    const ids = [
      ...config.sections.map((section) => section.id),
      ...questions.map((question) => question.id),
    ];
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        message: "Sections and questions must have unique identities.",
      });
  });
