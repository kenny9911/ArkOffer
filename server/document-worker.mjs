import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { getDocumentProxy } from "unpdf";
import yauzl from "yauzl";
import { DOMParser } from "@xmldom/xmldom";

const MAX_TEXT_BYTES = 800_000;
const MAX_EXPANDED_BYTES = 20 * 1024 * 1024;
const MAX_XML_BYTES = 4 * 1024 * 1024;
const WORD_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
class ExtractionFailure extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

// Neither extractor needs network access. PDF fonts/character maps must be embedded;
// DOCX relationships, links, images, macros, and embedded packages are never followed.
globalThis.fetch = async () => {
  throw new ExtractionFailure("External document resources are not supported.");
};

function checkText(text) {
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES)
    throw new ExtractionFailure(
      "Extracted text exceeds 800 KB. Split the document into shorter sources.",
      413,
    );
}

async function pdfText(path) {
  const bytes = readFileSync(path);
  if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
    throw new ExtractionFailure("This file is not a valid PDF.");
  const pdf = await getDocumentProxy(new Uint8Array(bytes), {
    isEvalSupported: false,
    enableXfa: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    standardFontDataUrl: undefined,
    cMapUrl: undefined,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    maxImageSize: 1_048_576,
    stopAtErrors: true,
    verbosity: 0,
  });
  try {
    if (pdf.numPages > 200)
      throw new ExtractionFailure(
        "PDF extraction supports at most 200 pages. Split this document.",
        413,
      );
    const pages = [];
    let textBytes = 0;
    // Sequential pages avoid unbounded Promise.all work and stop at the text limit.
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        text += item.str + (item.hasEOL ? "\n" : " ");
        checkText(text);
      }
      text = text.trim();
      textBytes += Buffer.byteLength(text) + 2;
      if (textBytes > MAX_TEXT_BYTES)
        throw new ExtractionFailure(
          "Extracted text exceeds 800 KB. Split the document into shorter sources.",
          413,
        );
      pages.push(text);
      page.cleanup();
    }
    const text = pages.join("\n\n").trim();
    if (!text)
      throw new ExtractionFailure(
        "This PDF has no extractable text. Scanned documents require OCR; paste a transcript or upload a text-based PDF.",
      );
    return { text, type: "pdf", pages: pdf.numPages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

function decodeXml(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe)
    return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff)
    return Buffer.from(buffer.subarray(2)).swap16().toString("utf16le");
  return buffer.toString("utf8");
}

function wordText(buffer) {
  const xml = decodeXml(buffer);
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml))
    throw new ExtractionFailure(
      "DOCX documents containing external entity declarations are not supported.",
    );
  const parser = new DOMParser({
    onError: (level) => {
      if (level !== "warning")
        throw new ExtractionFailure("This DOCX contains invalid document XML.");
    },
  });
  const document = parser.parseFromString(xml, "application/xml");
  const pieces = [];
  let bytes = 0,
    nodes = 0;
  const append = (text) => {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_TEXT_BYTES)
      throw new ExtractionFailure(
        "Extracted text exceeds 800 KB. Split the document into shorter sources.",
        413,
      );
    pieces.push(text);
  };
  const visit = (node, depth = 0) => {
    if (++nodes > 100_000 || depth > 100)
      throw new ExtractionFailure(
        "This DOCX is too complex to extract safely. Simplify it or paste its text.",
        413,
      );
    const word = WORD_NAMESPACES.has(node.namespaceURI);
    if (
      word &&
      ["del", "instrText", "object", "drawing"].includes(node.localName)
    )
      return;
    if (word && node.localName === "t") {
      append(node.textContent || "");
      return;
    }
    if (word && node.localName === "tab") {
      append("\t");
      return;
    }
    if (word && ["br", "cr"].includes(node.localName)) {
      append("\n");
      return;
    }
    for (let child = node.firstChild; child; child = child.nextSibling)
      visit(child, depth + 1);
    if (word && node.localName === "p") append("\n\n");
  };
  visit(document);
  return pieces.join("").trim();
}

async function docxText(path) {
  const archive = await yauzl.openPromise(path, {
    lazyEntries: true,
    validateEntrySizes: true,
    strictFileNames: true,
  });
  let declaredTotal = 0,
    actualTotal = 0,
    entries = 0;
  const parts = new Map();
  const names = new Set();
  try {
    if (archive.entryCount > 1000)
      throw new ExtractionFailure(
        "This DOCX has too many archive entries.",
        413,
      );
    for await (const entry of archive.eachEntry()) {
      entries += 1;
      if (entries > 1000 || entry.isEncrypted())
        throw new ExtractionFailure(
          "Encrypted or oversized DOCX archives are not supported.",
        );
      if (names.has(entry.fileName))
        throw new ExtractionFailure(
          "This DOCX contains duplicate archive entries.",
        );
      names.add(entry.fileName);
      declaredTotal += entry.uncompressedSize;
      if (declaredTotal > MAX_EXPANDED_BYTES)
        throw new ExtractionFailure(
          "This DOCX expands beyond the 20 MB processing limit. Remove large embedded content or split it.",
          413,
        );
      const textPart =
        /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(
          entry.fileName,
        );
      if (!textPart) continue;
      if (entry.uncompressedSize > MAX_XML_BYTES)
        throw new ExtractionFailure(
          "A DOCX text part exceeds the 4 MB processing limit.",
          413,
        );
      const stream = await archive.openReadStreamPromise(entry);
      const chunks = [];
      let partBytes = 0;
      for await (const chunk of stream) {
        partBytes += chunk.length;
        actualTotal += chunk.length;
        if (partBytes > MAX_XML_BYTES || actualTotal > MAX_EXPANDED_BYTES) {
          stream.destroy();
          throw new ExtractionFailure(
            "This DOCX exceeds its expanded-data processing limit.",
            413,
          );
        }
        chunks.push(chunk);
      }
      parts.set(entry.fileName, wordText(Buffer.concat(chunks)));
    }
    if (!parts.has("word/document.xml"))
      throw new ExtractionFailure(
        "This archive is not a readable DOCX document.",
      );
    const ordered = [
      "word/document.xml",
      ...[...parts.keys()]
        .filter((name) => name !== "word/document.xml")
        .sort(),
    ];
    const text = ordered
      .map((name) => parts.get(name))
      .filter(Boolean)
      .join("\n\n")
      .trim();
    checkText(text);
    if (!text)
      throw new ExtractionFailure(
        "This DOCX has no extractable text. Paste the source text or upload a document containing text.",
      );
    return { text, type: "docx" };
  } finally {
    archive.close();
  }
}

try {
  const result =
    workerData.mimeType === "application/pdf"
      ? await pdfText(workerData.path)
      : await docxText(workerData.path);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    status: error instanceof ExtractionFailure ? error.status : 422,
    error:
      error instanceof ExtractionFailure
        ? error.message
        : "This document could not be read. It may be corrupt, encrypted, or unsupported. Upload a valid document or paste its text.",
  });
}
