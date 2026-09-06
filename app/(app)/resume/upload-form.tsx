"use client";

import { useActionState } from "react";
import { Button, Input } from "@/components/ui";
import { analyseResumeUpload, type AnalyseState } from "./actions";

/**
 * Extraction plus a full audit is a real round trip, so the pending state has
 * to say so rather than leaving a dead button.
 */
export function UploadForm() {
  const [state, formAction, pending] = useActionState<AnalyseState, FormData>(
    analyseResumeUpload,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-6">
        <div className="min-w-64 flex-1">
          <Input
            label="Role you are targeting"
            name="role"
            placeholder="Strategy analyst"
            disabled={pending}
          />
        </div>

        <label className="flex min-w-64 flex-1 flex-col gap-2">
          <span className="eyebrow">Resume — PDF or DOCX</span>
          <input
            type="file"
            name="resume"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            required
            disabled={pending}
            className="input h-auto rounded-surface py-4 text-u-body file:mr-4 file:rounded-pill file:border-0 file:bg-ink file:px-4 file:py-2 file:text-ink-inverse file:text-u-eyebrow"
          />
        </label>

        <Button type="submit" disabled={pending}>
          {pending ? "Reading your resume…" : "Analyse"}
        </Button>
      </div>

      {pending ? (
        <p className="flex items-center gap-3 text-u-body" aria-live="polite">
          <span aria-hidden className="size-2 animate-pulse rounded-pill bg-accent" />
          Extracting the text, then auditing it against the role…
        </p>
      ) : null}

      {state.error ? (
        <p className="text-u-eyebrow text-error" role="alert">
          {state.error}
        </p>
      ) : null}

      <p className="text-u-micro">
        The file is read in memory and discarded. Only the analysis is stored —
        never the resume text.
      </p>
    </form>
  );
}
