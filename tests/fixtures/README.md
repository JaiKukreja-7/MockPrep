# Fixtures

Generated, not collected — nobody's real resume is in this repository.

- `resume-tracked-header.pdf` — a one-page CV whose name is set one text
  item per glyph (a 0.001pt font-size step between glyphs, invisible on the
  page, which is the per-glyph output some design tools emit). pdfjs returns
  `P`,`R`,`I`,`Y`,`A`,` `,`R`,`A`,`M`,`A`,`N` with no `hasEOL`; the extractor
  must read that as `PRIYA RAMAN`, not `P R I Y A   R A M A N`.
- `scan-no-text.pdf` — a page with a filled rectangle and no text: a scan,
  as far as extraction is concerned.
- `resume.docx` — the same CV as minimal OOXML.
- `too-short.docx` — a name and a title only; parses, but is not a resume.

All four come from `generate.py` in this directory — no dependencies, no
font embedding, so they render with the viewer's Helvetica.
