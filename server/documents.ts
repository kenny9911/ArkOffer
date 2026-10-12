import { Worker } from "node:worker_threads";
import { statSync } from "node:fs";

export const DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
export type DocumentExtraction = {
  text: string;
  type: "pdf" | "docx";
  pages?: number;
};
export class DocumentExtractionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let activeWorkers = 0;

export async function extractDocument(
  path: string,
  mimeType: string,
): Promise<DocumentExtraction> {
  if (statSync(path).size > 10 * 1024 * 1024)
    throw new DocumentExtractionError(
      413,
      "PDF and DOCX extraction supports files up to 10 MB. Split this document or provide a text transcript.",
    );
  if (activeWorkers >= 2)
    throw new DocumentExtractionError(
      429,
      "Document extraction is busy. Please try again in a moment.",
    );
  activeWorkers += 1;
  try {
    return await new Promise<DocumentExtraction>((resolve, reject) => {
      const worker = new Worker(
        new URL("./document-worker.mjs", import.meta.url),
        {
          workerData: { path, mimeType },
          env: {},
          execArgv: [],
          stdout: true,
          stderr: true,
          resourceLimits: {
            maxOldGenerationSizeMb: 128,
            maxYoungGenerationSizeMb: 16,
            stackSizeMb: 4,
          },
        },
      );
      // Parser warnings can contain document content. Never send them to application logs.
      worker.stdout?.resume();
      worker.stderr?.resume();
      let settled = false;
      const finish = (
        error?: DocumentExtractionError,
        result?: DocumentExtraction,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Keep the concurrency slot until the worker has actually stopped.
        const conclude = () => {
          if (error) reject(error);
          else resolve(result!);
        };
        void worker.terminate().then(conclude, conclude);
      };
      const timer = setTimeout(
        () =>
          finish(
            new DocumentExtractionError(
              422,
              "Document extraction exceeded the 10-second limit. Split the document or provide its text.",
            ),
          ),
        10_000,
      );
      worker.once(
        "message",
        (message: {
          ok: boolean;
          result?: DocumentExtraction;
          error?: string;
          status?: number;
        }) => {
          if (!message.ok)
            return finish(
              new DocumentExtractionError(
                message.status === 413 ? 413 : 422,
                message.error ||
                  "This document could not be read. Upload a valid document or paste its text.",
              ),
            );
          if (
            !message.result ||
            typeof message.result.text !== "string" ||
            Buffer.byteLength(message.result.text) > 800_000
          )
            return finish(
              new DocumentExtractionError(
                413,
                "Extracted text is too long. Split the document into shorter sources.",
              ),
            );
          finish(undefined, message.result);
        },
      );
      worker.once("error", () =>
        finish(
          new DocumentExtractionError(
            422,
            "This document exceeded processing limits or could not be read. Split it or paste its text.",
          ),
        ),
      );
      worker.once("exit", () => {
        if (!settled)
          finish(
            new DocumentExtractionError(
              422,
              "Document extraction stopped before it could finish. Try a smaller document.",
            ),
          );
      });
    });
  } finally {
    activeWorkers -= 1;
  }
}
