import { BorderStyle, Document, ImageRun, Packer, Paragraph, TextRun } from "docx";

const INK = "17222D";
const MUTED = "56636F";
const RULE = "C9D2DB";
const FONT = "Archivo";
const CONTACT = "0400 580 193  |  glenn.c.luck@gmail.com  |  Preston, Melbourne VIC  |  glennluck.netlify.app";

const A4 = { page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } } };

function run(text, opts = {}) {
  return new TextRun({
    text, font: FONT, size: opts.size ?? 20, bold: opts.bold,
    color: opts.color ?? INK, allCaps: opts.caps, characterSpacing: opts.tracking,
  });
}

function sectionHeading(text) {
  return new Paragraph({
    spacing: { before: 260, after: 90 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 4 } },
    children: [run(text, { size: 17, bold: true, color: MUTED, caps: true, tracking: 30 })],
  });
}

function bullet(children, level = 0) {
  return new Paragraph({ bullet: { level }, spacing: { after: 60 }, children });
}

function labelled(label, text) {
  return bullet([run(`${label}: `, { bold: true }), run(text)]);
}

function nameBlock(headline, imageBytes) {
  if (imageBytes) {
    return [new Paragraph({
      spacing: { after: 160 },
      children: [new ImageRun({ data: imageBytes, transformation: { width: 604, height: 150 } })],
    })];
  }
  return [
    new Paragraph({ spacing: { after: 20 }, children: [run("GLENN LUCK", { size: 44, bold: true, caps: true })] }),
    new Paragraph({ spacing: { after: 20 }, children: [run(headline ?? "MARKETING · BRAND · CAMPAIGNS · CONTENT", { size: 18, bold: true, caps: true, tracking: 60 })] }),
    new Paragraph({
      spacing: { after: 220 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 6 } },
      children: [run(CONTACT, { size: 16, color: MUTED })],
    }),
  ];
}

export function buildCv(content, headerImage) {
  const children = [...nameBlock(content.headline, content.template === "designed" ? headerImage : null)];

  if (content.summary) children.push(new Paragraph({ spacing: { after: 120 }, children: [run(content.summary)] }));

  if (content.capabilities?.length) {
    children.push(sectionHeading("Key capabilities"));
    content.capabilities.forEach((c) => children.push(labelled(c.label, c.text)));
  }
  if (content.tools?.length) {
    children.push(sectionHeading("Tools"));
    content.tools.forEach((t) => children.push(labelled(t.label, t.text)));
  }

  if (content.roles?.length) {
    children.push(sectionHeading("Professional experience"));
    content.roles.forEach((r) => {
      children.push(new Paragraph({
        spacing: { before: 160, after: 60 },
        children: [
          run(r.title, { bold: true, size: 21 }),
          run("  |  ", { color: RULE }),
          run(`${r.employer}  ${r.dates ?? ""}`, { color: MUTED }),
        ],
      }));
      (r.bullets ?? []).forEach((b) => children.push(bullet([run(b)])));
    });
  }

  if (content.education?.length) {
    children.push(sectionHeading("Education and professional development"));
    content.education.forEach((e) => children.push(new Paragraph({ spacing: { after: 40 }, children: [run(e)] })));
  }
  if (content.referees?.length) {
    children.push(sectionHeading("Referees"));
    content.referees.forEach((r) => children.push(new Paragraph({ spacing: { after: 40 }, children: [run(r)] })));
  }

  return new Document({ sections: [{ properties: A4, children }] });
}

export function buildCoverLetter(content) {
  const today = new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
  const children = [
    new Paragraph({ spacing: { after: 20 }, children: [run("GLENN LUCK", { size: 30, bold: true, caps: true })] }),
    new Paragraph({ spacing: { after: 260 }, children: [run(CONTACT, { size: 16, color: MUTED })] }),
    new Paragraph({ spacing: { after: 200 }, children: [run(today)] }),
  ];
  if (content.recipient) children.push(new Paragraph({ spacing: { after: 20 }, children: [run(content.recipient)] }));
  if (content.employer) children.push(new Paragraph({ spacing: { after: 20 }, children: [run(content.employer)] }));
  if (content.subject) children.push(new Paragraph({ spacing: { after: 220 }, children: [run(content.subject, { bold: true })] }));

  (content.paragraphs ?? []).forEach((p) =>
    children.push(new Paragraph({ spacing: { after: 160 }, children: [run(p)] })));

  children.push(new Paragraph({ spacing: { before: 160, after: 20 }, children: [run(content.sign_off ?? "Kind regards")] }));
  children.push(new Paragraph({ children: [run("Glenn Luck")] }));
  children.push(new Paragraph({ spacing: { before: 160 }, children: [run("portfolio: glennluck.netlify.app", { size: 16, color: MUTED })] }));

  return new Document({ sections: [{ properties: A4, children }] });
}

export function buildKsc(content, job) {
  const children = [
    new Paragraph({ spacing: { after: 20 }, children: [run("GLENN LUCK", { size: 30, bold: true, caps: true })] }),
    new Paragraph({ spacing: { after: 240 }, children: [run(CONTACT, { size: 16, color: MUTED })] }),
    new Paragraph({ spacing: { after: 240 }, children: [run(`Response to key selection criteria — ${job ?? ""}`, { bold: true, size: 24 })] }),
  ];
  (content.responses ?? []).forEach((r, i) => {
    children.push(new Paragraph({ spacing: { before: 240, after: 80 }, children: [run(`${i + 1}. ${r.criterion}`, { bold: true })] }));
    children.push(new Paragraph({ spacing: { after: 120 }, children: [run(r.response)] }));
  });
  return new Document({ sections: [{ properties: A4, children }] });
}

export async function downloadDocx(doc, filename) {
  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".docx") ? filename : `${filename}.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeName(parts) {
  return parts.filter(Boolean).join(" - ").replace(/[^\w\s.-]+/g, "").replace(/\s+/g, " ").trim();
}
