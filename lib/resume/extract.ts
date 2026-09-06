import "server-only";

export type SourceKind = "pdf" | "docx";

export interface ExtractedResume {
  text: string;
  kind: SourceKind;
}

/** Anything larger is not a resume; it is a document that will cost tokens. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
/** Enough for a long CV, short enough to keep one analysis affordable. */
const MAX_CHARS = 24_000;

export class ResumeExtractionError extends Error {}

export function detectKind(file: File): SourceKind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
  if (
    name.endsWith(".docx") ||
    file.type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  return null;
}

/**
 * Pulls text out of an upload, in memory. Nothing is written to disk and the
 * caller is expected to drop the text once the analysis comes back.
 */
export async function extractResume(file: File): Promise<ExtractedResume> {
  if (file.size === 0) throw new ResumeExtractionError("That file is empty.");
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ResumeExtractionError("That file is larger than 4MB.");
  }

  const kind = detectKind(file);
  if (!kind) {
    throw new ResumeExtractionError("Upload a PDF or a DOCX.");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const raw = kind === "pdf" ? await readPdf(buffer) : await readDocx(buffer);

  const text = normalise(raw);
  if (text.length < 120) {
    throw new ResumeExtractionError(
      kind === "pdf"
        ? "No text came out of that PDF. If it is a scan, export a text PDF instead."
        : "No text came out of that file.",
    );
  }

  return { text: text.slice(0, MAX_CHARS), kind };
}

async function readDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function readPdf(buffer: Buffer): Promise<string> {
  // The legacy build runs in Node without a worker; the main build assumes a
  // browser and fails to resolve its worker here.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    // No network and no system font lookups: this parses a stranger's upload,
    // so it gets nothing but the bytes it was handed. (`isEvalSupported` was
    // removed in pdfjs-dist v6 — it no longer evaluates font programs.)
    useWorkerFetch: false,
    useSystemFonts: false,
  }).promise;

  let out = "";
  for (let page = 1; page <= doc.numPages; page += 1) {
    const content = await (await doc.getPage(page)).getTextContent();
    for (const item of content.items) {
      if (!("str" in item)) continue;
      out += item.str;
      // Items already carry their own trailing spaces. Joining them with a
      // space instead produces "P R I Y A   R A M A N", which then reads as a
      // formatting problem in the resume rather than one we introduced.
      if (item.hasEOL) out += "\n";
    }
    out += "\n";
  }
  return out;
}

function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
