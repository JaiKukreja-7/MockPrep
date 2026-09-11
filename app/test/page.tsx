import {
  Button,
  Input,
  PillTag,
  RuledRow,
  RuledRowList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui";
import { SpeakerDemo } from "./speaker-demo";

export const metadata = {
  title: "Primitives — MockPrep",
};

/**
 * Specimen sheet for the primitives. Every section runs once on white
 * and once inside .surface-dark, since the primitives are built to invert
 * off currentColor rather than off a light/dark variant.
 */

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-8 py-20 border-t border-t-rule">
      <header className="flex flex-col gap-2">
        <p className="eyebrow">{eyebrow}</p>
        <h2 className="display text-d-mid">{title}</h2>
      </header>
      {children}
    </section>
  );
}

/* Sentence case in the markup. The uppercase is CSS, everywhere. */
const sessions = [
  {
    role: "Senior frontend engineer",
    company: "Figma",
    date: "2 Sep 2026",
    minutes: 42,
    questions: 8,
    score: 84,
  },
  {
    role: "Product manager",
    company: "Canva",
    date: "29 Aug 2026",
    minutes: 35,
    questions: 6,
    score: 71,
  },
  {
    role: "Data scientist",
    company: "Atlassian",
    date: "21 Aug 2026",
    minutes: 58,
    questions: 11,
    score: 108,
  },
  {
    role: "Engineering manager",
    company: "Linear",
    date: "14 Aug 2026",
    minutes: 47,
    questions: 9,
    score: 9,
  },
];

const projects = [
  { title: "Behavioural interview drill", tag: "Behavioural" },
  { title: "System design walkthrough", tag: "Technical" },
  { title: "Take-home debrief", tag: "Technical" },
  { title: "Salary negotiation practice", tag: "Career" },
];

export default function TestPage() {
  return (
    <main className="w-full max-w-page mx-auto px-8 py-20">
      <header className="flex flex-col gap-4 pb-20">
        <p className="eyebrow">MockPrep design system</p>
        <h1 className="display text-d-hero">Primitives</h1>
        <p className="text-u-lg max-w-2xl">
          Six of the seven primitives on the IGNITE-derived token set — the
          heatmap lives on the dashboard. Two radii, two border weights, no
          shadows, no grey text.
        </p>
      </header>

      {/* ---------------------------------------------------- Buttons */}
      <Section eyebrow="Primitive 01" title="Button">
        <div className="flex flex-wrap items-center gap-6">
          <Button>Start a mock interview</Button>
          <Button variant="outline">See all sessions</Button>
          <Button disabled>Start a mock interview</Button>
          <Button variant="outline" disabled>
            See all sessions
          </Button>
        </div>

        {/* The in-row size, for actions that sit inside a ruled row. */}
        <div className="flex flex-wrap items-center gap-6">
          <Button size="compact">Drill it</Button>
          <Button variant="outline" size="compact">
            Drill it
          </Button>
        </div>

        <div className="surface-dark rounded-surface p-12 flex flex-wrap items-center gap-6">
          <Button>Start a mock interview</Button>
          <Button variant="outline">See all sessions</Button>
        </div>
      </Section>

      {/* ----------------------------------------------------- Inputs */}
      <Section eyebrow="Primitive 02" title="Input">
        <div className="grid gap-8 md:grid-cols-2 max-w-3xl">
          <Input label="Target role" placeholder="Senior frontend engineer" />
          <Input label="Company" defaultValue="Figma" />
          <Input
            label="Interview length"
            defaultValue="Ninety"
            error="Enter a length in minutes."
          />
          <Input label="Interviewer persona" defaultValue="Hiring manager" disabled />
        </div>

        <div className="surface-dark rounded-surface p-12 max-w-3xl">
          <Input label="Target role" placeholder="Senior frontend engineer" />
        </div>
      </Section>

      {/* -------------------------------------------------- Pill tags */}
      <Section eyebrow="Primitive 03" title="Pill tag">
        <div className="flex flex-wrap items-center gap-4">
          <PillTag>Behavioural</PillTag>
          <PillTag>Technical</PillTag>
          <PillTag>System design</PillTag>
          <PillTag>Career</PillTag>
        </div>

        <div className="surface-dark rounded-surface p-12 flex flex-wrap items-center gap-4">
          <PillTag>Behavioural</PillTag>
          <PillTag>Technical</PillTag>
          <PillTag>System design</PillTag>
        </div>
      </Section>

      {/* -------------------------------------------------- Ruled rows */}
      <Section eyebrow="Primitive 04" title="Ruled row">
        <RuledRowList>
          {projects.map((project) => (
            <RuledRow
              key={project.title}
              title={project.title}
              trailing={<PillTag>{project.tag}</PillTag>}
            />
          ))}
        </RuledRowList>

        {/* The UI scale, with a meta line — the dashboard row. */}
        <RuledRowList>
          <RuledRow
            scale="ui"
            title="Behavioural round 3"
            meta="12 Mar · 18:42"
            trailing={<PillTag>Consulting</PillTag>}
          />
        </RuledRowList>

        {/* progress turns the row's own 1px rule into a meter track. */}
        <ul className="max-w-md">
          <RuledRow
            className="py-4"
            progress={81}
            title={<span className="eyebrow">Structure</span>}
            trailing={
              <span className="numeric text-u-body font-medium">81</span>
            }
          />
        </ul>
      </Section>

      {/* ------------------------------------------------------ Table */}
      <Section eyebrow="Primitive 05" title="Table">
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Role</TableHeaderCell>
              <TableHeaderCell>Company</TableHeaderCell>
              <TableHeaderCell>Date</TableHeaderCell>
              <TableHeaderCell numeric>Questions</TableHeaderCell>
              <TableHeaderCell numeric>Minutes</TableHeaderCell>
              <TableHeaderCell numeric>Score</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sessions.map((session) => (
              <TableRow key={session.role}>
                <TableCell>{session.role}</TableCell>
                <TableCell>{session.company}</TableCell>
                <TableCell meta>{session.date}</TableCell>
                <TableCell numeric>{session.questions}</TableCell>
                <TableCell numeric>{session.minutes}</TableCell>
                <TableCell numeric>{session.score}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="text-u-eyebrow max-w-2xl">
          Scores are uncoloured on purpose — rank and size carry the meaning.
          The digits are tabular, so 9, 84 and 108 stay in one column.
        </p>
      </Section>

      {/* ---------------------------------------------------- Speaker */}
      <Section eyebrow="Primitive 06" title="Speaker">
        <p className="text-u-body max-w-2xl">
          The interviewer, seen. Solid is the interviewer, hollow is you —
          a split that holds under reduced motion, where the breathing and the
          rings stop but the shapes do not. Rings are capped at three and
          spaced at least 320ms apart, so a natural word rate reads as
          discrete marks rather than a pulse.
        </p>
        <SpeakerDemo />
      </Section>
    </main>
  );
}
