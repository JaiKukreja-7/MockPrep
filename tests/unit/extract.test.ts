import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  detectKind,
  extractResume,
  MAX_UPLOAD_BYTES,
  ResumeExtractionError,
} from "@/lib/resume/extract";

/**
 * Real parsers on real files. The fixtures are generated (tests/fixtures,
 * see the commit that added them) and tiny, but they go through pdfjs and
 * mammoth exactly as an upload would.
 *
 * resume-tracked-header.pdf sets the name as one text item per glyph —
 * "P","R","I","Y","A"," ","R","A","M","A","N", none with hasEOL — which is
 * what a tracked-out header from a design tool looks like to pdfjs. Joined
 * with spaces it reads "P R I Y A   R A M A N", and the analyser then reports
 * a formatting fault the resume does not have. Joined as pdfjs intends, on
 * hasEOL only, it reads "PRIYA RAMAN".
 */

const fixture = (name: string) => readFileSync(`tests/fixtures/${name}`);
const asFile = (name: string, type: string, bytes = fixture(name)) => new File([bytes], name, { type });

describe("detectKind", () => {
  it("recognises PDF and DOCX by extension or by MIME type, and nothing else", () => {
    expect(detectKind(new File([], "cv.PDF"))).toBe("pdf");
    expect(detectKind(new File([], "cv", { type: "application/pdf" }))).toBe("pdf");
    expect(detectKind(new File([], "cv.docx"))).toBe("docx");
    expect(
      detectKind(
        new File([], "cv", {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      ),
    ).toBe("docx");
    expect(detectKind(new File([], "cv.doc"))).toBeNull();
    expect(detectKind(new File([], "cv.txt", { type: "text/plain" }))).toBeNull();
  });
});

describe("extractResume — PDF", () => {
  it("joins per-glyph items without inventing spaces: the P R I Y A case", async () => {
    const { text, kind } = await extractResume(asFile("resume-tracked-header.pdf", "application/pdf"));
    expect(kind).toBe("pdf");
    expect(text.startsWith("PRIYA RAMAN\n")).toBe(true);
    expect(text).not.toContain("P R I Y A");
  });

  it("the control: those items really do arrive one glyph at a time", async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(fixture("resume-tracked-header.pdf")),
      useWorkerFetch: false,
      useSystemFonts: false,
    }).promise;
    const items = (await (await doc.getPage(1)).getTextContent()).items
      .filter((i): i is { str: string; hasEOL: boolean } & typeof i => "str" in i)
      .slice(0, 11);
    expect(items.map((i) => i.str)).toEqual(["P", "R", "I", "Y", "A", " ", "R", "A", "M", "A", "N"]);
    expect(items.every((i) => !i.hasEOL)).toBe(true);
    // What the old space-join produced from exactly these items.
    expect(items.map((i) => i.str).join(" ")).toBe("P R I Y A   R A M A N");
  });

  it("keeps line breaks where pdfjs marks them and collapses runs of blank lines", async () => {
    const { text } = await extractResume(asFile("resume-tracked-header.pdf", "application/pdf"));
    const lines = text.split("\n");
    expect(lines.slice(0, 3)).toEqual(["PRIYA RAMAN", "Product Manager, Marketplace", "Melbourne, Australia"]);
    expect(text).toContain("\nEXPERIENCE\nSenior Product Manager, Freight Exchange, 2021-2024\n");
    expect(text).toContain("WAM 84.5, 2014-2017");
    expect(text).not.toMatch(/\n{3,}/);
  });

  it("refuses a PDF with no text as a scan, with a message that says what to do", async () => {
    await expect(extractResume(asFile("scan-no-text.pdf", "application/pdf"))).rejects.toThrow(
      /No text came out of that PDF\. If it is a scan, export a text PDF instead\./,
    );
  });
});

describe("extractResume — DOCX", () => {
  it("extracts paragraphs as lines", async () => {
    const { text, kind } = await extractResume(
      asFile("resume.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    );
    expect(kind).toBe("docx");
    expect(text.split("\n").filter(Boolean).slice(0, 2)).toEqual([
      "Priya Raman",
      "Product Manager, Marketplace — Melbourne, Australia",
    ]);
    expect(text).toContain("WAM 84.5");
  });
});

describe("extractResume — guards", () => {
  it("rejects an empty file before parsing", async () => {
    await expect(extractResume(new File([], "cv.pdf"))).rejects.toThrow("That file is empty.");
  });

  it("rejects anything over 4MB before parsing", async () => {
    const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "cv.pdf", { type: "application/pdf" });
    await expect(extractResume(big)).rejects.toThrow("That file is larger than 4MB.");
  });

  it("rejects unknown types with a ResumeExtractionError", async () => {
    const err = await extractResume(new File(["hello"], "cv.txt", { type: "text/plain" })).catch((e) => e);
    expect(err).toBeInstanceOf(ResumeExtractionError);
    expect(err.message).toBe("Upload a PDF or a DOCX.");
  });

  it("rejects a document with too little text to be a resume", async () => {
    // Parses fine — two paragraphs — and is still refused: under 120 chars
    // is a name and a title, not a resume.
    await expect(
      extractResume(asFile("too-short.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
    ).rejects.toThrow("No text came out of that file.");
  });
});
