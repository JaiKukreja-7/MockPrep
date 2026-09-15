#!/usr/bin/env python3
"""Regenerates every fixture in this directory. No dependencies.

    python3 tests/fixtures/generate.py

The PDFs are written by hand — objects, xref, trailer — because the point of
resume-tracked-header.pdf is a specific low-level shape: one text item per
glyph in the name, which pdfjs produces when consecutive glyphs differ in
font size. A 0.001pt step is invisible on the page and is the kind of
floating-point per-glyph output design tools emit. Standard Helvetica, no
embedding, so the files stay around 1KB.
"""
import io
import zipfile
from xml.sax.saxutils import escape

HELVETICA = {"P": 667, "R": 722, "I": 278, "Y": 667, "A": 667, "M": 833, "N": 722, " ": 278}


def pdf(pages, out):
    objs = []

    def add(s):
        objs.append(s)
        return len(objs)

    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    pages_id = add(b"")
    ids = []
    for content in pages:
        stream = content.encode("latin-1")
        c = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        ids.append(add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 595 842] "
            b"/Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>" % (pages_id, font, c)
        ))
    objs[pages_id - 1] = (
        b"<< /Type /Pages /Kids [" + b" ".join(b"%d 0 R" % i for i in ids) + b"] /Count %d >>" % len(ids)
    )
    catalog = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)

    buf = io.BytesIO()
    buf.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, obj in enumerate(objs, 1):
        offsets.append(buf.tell())
        buf.write(b"%d 0 obj\n" % i + obj + b"\nendobj\n")
    xref = buf.tell()
    buf.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for off in offsets:
        buf.write(b"%010d 00000 n \n" % off)
    buf.write(b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, catalog, xref))
    open(out, "wb").write(buf.getvalue())


def esc(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def docx(out, paragraphs):
    body = "".join(
        '<w:p><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % escape(t) for t in paragraphs
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>" + body + "</w:body></w:document>"
    )
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>",
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            "</Relationships>",
        )
        z.writestr("word/document.xml", document)


BODY = [
    "Product Manager, Marketplace",
    "Melbourne, Australia",
    "",
    "EXPERIENCE",
    "Senior Product Manager, Freight Exchange, 2021-2024",
    "Led the two-sided marketplace team through a cold-start relaunch, growing supply-side",
    "liquidity 3x in nine months and cutting time-to-first-match from 4 days to 6 hours.",
    "Product Manager, Cartly, 2018-2021",
    "Owned checkout and payments. Increased conversion 25% and cut refund rate by $340,000 a year.",
    "",
    "EDUCATION",
    "Bachelor of Commerce, University of Melbourne, WAM 84.5, 2014-2017",
]

# --- resume-tracked-header.pdf: the name, one text item per glyph ----------
x = 72.0
header = "BT\n"
n = 0
for ch in "PRIYA RAMAN":
    if ch != " ":
        size = 28 + (0.001 if n % 2 else 0)
        header += "/F1 %.3f Tf 1 0 0 1 %.2f 770 Tm (%s) Tj\n" % (size, x, esc(ch))
        n += 1
    x += HELVETICA[ch] * 28 / 1000 + 1.0  # glyph advance plus 1pt of tracking
header += "ET\n"
body = "BT /F1 11 Tf 72 730 Td 14 TL\n" + "".join("(%s) Tj T*\n" % esc(l) for l in BODY) + "ET\n"
pdf([header + body], "tests/fixtures/resume-tracked-header.pdf")

# --- scan-no-text.pdf: a filled rectangle, no text ---------------------------
pdf(["0 0 1 rg 100 100 200 300 re f\n"], "tests/fixtures/scan-no-text.pdf")

# --- resume.docx / too-short.docx --------------------------------------------
docx("tests/fixtures/resume.docx", [
    "Priya Raman",
    "Product Manager, Marketplace — Melbourne, Australia",
    "Experience",
    "Senior Product Manager, Freight Exchange, 2021–2024. Led the two-sided marketplace team through a cold-start relaunch, growing supply-side liquidity 3x in nine months.",
    "Product Manager, Cartly, 2018–2021. Owned checkout and payments; increased conversion 25%.",
    "Education",
    "Bachelor of Commerce, University of Melbourne, WAM 84.5",
])
docx("tests/fixtures/too-short.docx", ["Priya Raman", "Product Manager"])
print("fixtures written")
