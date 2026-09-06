# MockPrep — build progress

AI mock interview platform. Next.js 16 (App Router, Turbopack) + Tailwind v4 +
Supabase. Free-tier LLMs only.

**Read this file first.** Last updated 2026-09-06.

---

## Done

### Design system and tokens

`app/globals.css` is the whole token layer and, in Tailwind v4, also the config
— there is no `tailwind.config.js`. Three layers: `@theme` (generates
utilities), `:root` (the source tokens verbatim, for hand-written CSS), and the
system's rules as component classes.

The `@theme` block **deletes** default namespaces so off-system values cannot be
typed: `--color-*` (no `text-zinc-500` to reach for), `--text-*` (no
`text-sm`/`text-3xl`, so the UI scale's cliff holds), `--radius-*` (only
`rounded-surface` 4px and `rounded-pill`), and every shadow namespace.
`--font-serif`/`--font-mono` are cleared to bar a third typeface.

Fonts are self-hosted via `next/font/local` (`app/fonts.ts`), Google Fonts
`@import` removed. Archivo ships as the single wdth 62 / wght 600 static
instance — **13KB instead of 640KB**, with no axis available to drift
off-system. Switzer is the variable face, 100–900, 43KB.

*Verified* by asserting against the rendered DOM on every screen, not by eye:
radii found `320px`/`4px` only; border widths `1px`/`2px` only; **0 elements
with a box-shadow; 0 grey-text offenders**; every rendered font-size a token
value; tabular figures actually equal-width (`111111`/`000000`/`444444` all
51.84px) with score columns aligning across 1-, 2- and 3-digit values; all
uppercase coming from `text-transform` with sentence case in the DOM.

### Primitives — `components/ui/`

`Button` (filled 48px / outline 68px / `size="compact"` 40px), `Input`,
`PillTag`, `RuledRow` + `RuledRowList` (`scale`, `meta`, `progress`), `Table`,
`Heatmap`. Specimen sheet at `/test`.

`RuledRow`'s `progress` draws the existing 2px `.link-bar` along the row's own
1px rule — the rule *is* the meter track. No new element type, no third border
weight. Reused for the mic level meter, so the one moving thing on the voice
screen still reads as the system.

### Screens

| Route | State |
|---|---|
| `/sign-in` | Magic link + password + guest |
| `/dashboard` | Real data, empty states, 12-month heatmap |
| `/session/[id]` | Live round, text and voice |
| `/report/[id]` | Score, meters, transcript with flags |
| `/sessions` | Every round, 9-column table, track filter |
| `/reports` | Scored rounds, ruled index, links to `/report/[id]` |
| `/questions` | Question bank — the landing-page ruled index |
| `/settings` | Account, sign-out, read-only caps |
| `/resume` | Upload + past checks |
| `/resume/[id]` | ATS score, sub-score meters, findings |
| `/test` | Primitive specimen sheet |

`/sessions` is where the `Table` primitive earns its place: nine columns of
which five are numeric. Ruled rows would push the sub-scores onto a second
line and lose the column alignment that makes them comparable. `/reports` and
`/questions` stay on `RuledRow` — one item per row, nothing to align.

Track filters are links, not client state, so the track lives in the URL and a
filtered list can be shared and reloaded. Only tracks the user actually has
rounds in are offered, so there are no dead filters.

The question bank is derived from `rounds` rather than a table of its own:
those rows **are** the questions this user has faced, and a separate table
would immediately disagree with them.

*Verified signed in against real data*: 8 sessions / 1 report / 24 questions,
counts matching the sidebar; `?track=engineering` correctly empty; settings
showing 3/60 rounds and 1/30 voice minutes with "57 rounds left" and "29 voice
minutes left" reconciling against their caps.

The signed-in shell (sidebar) is `app/(app)/layout.tsx`; each page owns its own
72px header because the title and primary action are page-specific. Session and
report sit **outside** that group deliberately — the round flow has no
navigation out of it.

### Schema, RLS and quotas — `supabase/migrations/`

`users` / `sessions` / `rounds` / `scores` / `transcripts`, RLS on all five,
child tables inheriting ownership through `sessions`, and a trigger creating
`public.users` on signup. A `flag_summary` view with `security_invoker = on`
does the group-by PostgREST can't express for "What to work on".

Quota caps: `users.daily_request_cap` (60 email / 10 guest) and an atomic
`consume_llm_quota` RPC that locks the row before comparing — without
`FOR UPDATE`, two concurrent rounds both pass the check.

*Verified* with a real guest JWT: cap 10, spend 4 → allowed (4), spend 4 →
allowed (8), spend 4 → **denied**, and `used` stayed at 8 rather than partially
spending.

### Privilege escalation — found and fixed

`users_update_own` gates *which row* you may update, but **RLS cannot gate which
columns**, and `authenticated` had a table-wide UPDATE grant. Confirmed
exploitable with nothing but the publishable key and a guest JWT:

```
before: [{"is_guest":true,  "daily_request_cap":10}]
after:  [{"is_guest":false, "daily_request_cap":9999}]
```

That defeated the spend caps and would have defeated "voice requires an
account" — the restrictive policy checks `is_guest = false`, which the attacker
had just set. Fixed with column grants (`revoke update … grant update
(display_name)`) in `20260905020000_voice.sql`.

*Verified after the fix*: `is_guest`/`daily_request_cap` → `42501 permission
denied for table users`; `daily_voice_sec_cap` → same; `display_name` →
**succeeded**, confirming the table isn't over-locked.

### Auth

Passwordless magic link, anonymous guest, and password sign-in. Session refresh
lives in `proxy.ts` at the repo root — **Next 16 renamed Middleware to Proxy**,
so the standard Supabase `middleware.ts` recipe does not apply as written. The
callback handles both `?code=` (PKCE) and `?token_hash=&type=` shapes, so the
link works whichever way the email template is configured.

Password sign-in is one form with two submit buttons via `formAction`, so the
email field is shared rather than duplicated.

*Verified*: guest sign-in, password sign-in, route gating (unauthenticated
`/dashboard` redirects, `/api/*` gets a 401 JSON rather than sign-in HTML).

### LLM layer — `lib/llm/`

One `LLMProvider` interface. Groq and OpenRouter share one OpenAI-compatible
implementation differing only by config; Gemini has its own (different endpoint,
auth header, system-prompt field, JSON mechanism). `routing.ts` is the only
place a task's provider or model is decided.

**Data policy is enforced structurally, not documented.** Each task carries a
`sensitive` flag and the route table is validated at import — a route sending
resume content to a training-eligible provider throws at boot, not mid-request.
Gemini and OpenRouter's free tier are both marked `trains-on-free-tier`, leaving
Groq the only provider eligible for resume analysis.

Queue holds concurrency at 2 process-wide, backs off 1/2/4/8s on 429 (honouring
`Retry-After` when longer), and only retries retryable failures — a 401 fails
over immediately instead of burning 15s.

Tasks: question generation, answer scoring, flag extraction, interviewer turn,
STT. Scoring is shared by text and voice (`lib/rounds/score.ts`) so the two
paths cannot drift.

### Rounds

**Text** — verified end to end repeatedly: start → 3 questions generated →
3 answers → scored → report. Dashboard then read it back (score, counts, flag
rollup, heatmap cell).

**Voice** — Groq Whisper STT → Gemini Flash brain → Web Speech TTS. Verified end
to end against live providers and the real database:

| | start_ms | end_ms | flag |
|---|---|---|---|
| interviewer | 20999 | 21000 | — |
| candidate | 21000 | 32573 | **filler** |
| interviewer | 39999 | 40000 | — |
| candidate | 40000 | 57083 | — |
| interviewer | 64999 | 65000 | — |
| candidate | 65000 | 75240 | — |

All rounds `mode=voice`, score written (55/55/60/50), session `scored`,
`duration_seconds: 75`, `voice_seconds: 39` metered. Flag extraction correctly
caught the "So, um, I guess" line on a *voice* transcript. `remainingSeconds`
counted 600 → 588 → 571 → 561, so the 10-minute ceiling tracks.

### Resume analyser (2026-09-06)

PDF and DOCX uploaded, text extracted server-side in memory, audited for ATS
compatibility on four axes — parseability, keyword coverage against a target
role, formatting, and bullet strength — then stored as a verdict.

**Nothing stores the resume text.** The upload is parsed in memory, sent to
the analyser, and dropped. Findings may carry a short excerpt, because a
finding that cannot point at the line it is about is useless, but excerpts are
truncated to 160 chars and findings capped at 8, so a row cannot accumulate
into a copy of the document. `source_chars` records the length only. The
migration says so at the top: adding a text column there is a change of
policy, not a schema tweak.

*Verified end to end*, including a real upload through the form:

| | PDF | DOCX |
|---|---|---|
| extracted | 712 chars | 727 chars |
| ATS | 67 | 70 |
| provider | `groq/openai/gpt-oss-120b` | `groq/openai/gpt-oss-120b` |
| findings | 5 | 5 |

On a deliberately weak test resume it caught the right things: *"Replace vague
verbs with strong action verbs"* quoting `"Helped with a project that improved
things for the client."`, missing quantification, and sensible keyword gaps
for the target role.

A real upload through the form produced ATS 68 (parseability 90, keywords 55,
formatting 70, bullets 55), 8 findings, 20 keywords. The stored row was
inspected directly: **no column holds the resume text** (longest string under
300 chars), `source_chars: 712` records length only, and the six excerpts came
to 293 chars against 712 extracted. Guests are barred — an insert with a guest
JWT fails `42501 ... violates row-level security policy
"analyses_require_account"`, and reads return empty.

**Contact details are redacted from excerpts** (2026-09-06). The first run
stored `0400 000 000`, because a finding *about* the contact line quoted the
contact line. Two changes, belt and braces:

1. The analyser is told never to quote a phone number, email or URL, and to
   describe the pattern instead where the problem is in those characters.
2. `lib/resume/redact.ts` replaces anything that slips through with
   `[phone]`, `[email]`, `[url]` — **at write time**, before the row is built.
   Redacting on display would leave the real value in the table, which is the
   thing being avoided.

Redaction runs *before* truncation: cutting to 160 chars first can slice an
email in half, leaving a fragment the pattern no longer matches. It errs
toward over-redaction, and the length rule (9+ digits, or 8+ with a `+`, `0`
or bracket prefix) is what keeps `2023-2026`, `WAM 78` and `340,000` intact —
16 cases checked.

*Verified*: the pre-existing row was backfilled (`0400 000 000` → `[phone]`),
and a fresh upload scanned clean — **zero phone-like runs, emails or URLs
across every stored row**. The prompt change did the work on its own that
time: the parseability finding came back as *"Phone number runs digits
together"* with no excerpt at all, so the redactor never had to fire.

**The data-policy guard was confirmed by breaking it on purpose.** Adding
Gemini to the `resume_analysis` chain made the route table refuse to load:
*"Routing table is unsafe: task \"resume_analysis\" is marked sensitive but
routes to \"gemini\", whose data policy is \"trains-on-free-tier\"."* Restored,
it loads cleanly with Groq as the only leg.

`serverExternalPackages: ["pdfjs-dist", "mammoth"]` is load-bearing: bundled
by Turbopack, pdfjs falls back to a fake worker whose `pdf.worker.mjs` import
cannot resolve, and every PDF fails with "Setting up fake worker failed".

### TTS — three causes fixed (2026-09-06)

Web Speech was wired but silent in Chrome. All three were real:

1. **`getVoices()` empty on first call.** Chrome populates asynchronously and
   fires `voiceschanged`; utterances queued before that are dropped with no
   error. Every `speak()` now awaits a cached voices promise, with a 2s escape
   hatch for builds that never fire the event.
2. **Autoplay policy.** `speak()` before a gesture fails *silently* — no
   exception, no `onerror`, `speaking` stays `false`. That's why it looked
   wired-but-dead. `speak()` now reports whether audio actually started
   (`onstart` raced against a 900ms timer) and `primeSpeech()` burns a muted
   utterance inside a real click handler to unlock the document.
3. **Chrome's ~15s cutoff.** Synthesis stops part-way through a long
   utterance. A 10s `resume()` pulse did **not** hold it — questions 2 and 3
   still died midway in real Chrome, because they carry an acknowledgement in
   front of them and run longer than question 1. Replaced with chunking:
   `chunkForSpeech()` splits at sentence boundaries into segments under 180
   chars, and each segment's `onend` starts the next through a single queue.
   Short utterances never reach the cutoff, so the bug stops existing rather
   than being papered over.

Also found: **barge-in could never have worked** — the analyser lived inside
`MediaRecorder`, so the mic only listened *while recording*, never while the
interviewer spoke, which is the only time barge-in matters. `useMicrophone` now
separates `arm()` from `startRecording()`.

And a consistency bug: the brain was composing its own copy of the next
question, putting three different strings on screen (model paraphrase in the
caption, verbatim question in the heading, previous question in the transcript).
`interviewerTurn` now returns only a bridge sentence; `nextQuestion` travels
separately, verbatim from the database.

A cancel bumps a generation counter that stale chunk callbacks check, so
barge-in kills the **whole remaining queue** rather than pausing and resuming
with the next chunk. `speak()` resolves `"spoke" | "blocked" | "cancelled"`
rather than a boolean — conflating "cancelled" with "did not start" popped a
"tap to hear" prompt every time barge-in fired. `speechSynthesis.cancel()` also
runs on round teardown and on `pagehide`, so a queue never survives into the
next round.

*Verified at runtime* (synthesis events fire in the pane even without audio
out): chunking is lossless across five samples including a 400-char
comma-only sentence and text with no punctuation at all, longest chunk 179;
chunks are fed one at a time rather than dumped; and cancelling after chunk 2
of 9 left the other **7 suppressed** four seconds later, resolving
`"cancelled"`.

*Verified on a live turn*: acknowledgement contained no question mark;
`nextQuestion` matched round 2's row exactly; logged interviewer line matched
round 1's row exactly; after refresh the heading showed round 2 while the
transcript held round 1.

---

## Blocked

### 1. Gemini native audio Live — ephemeral tokens rejected

The intended primary for voice was speech-to-speech via
`gemini-2.5-flash-native-audio-preview-12-2025`. **The model works** —
`setupComplete` and ~27KB of PCM audio over `v1beta` with an API key.

What fails is the auth that would let a browser hold that socket safely.
Ephemeral tokens mint (`200 {"name":"auth_tokens/…"}`) but every connection is
rejected across **12 combinations**: v1alpha/v1beta × `access_token`/`key` ×
full/stripped token name × with/without model constraint. `?access_token=` →
`1008 "unregistered callers"`; `?key=` → `1007 "API key not valid"`. Most
likely ephemeral tokens need a paid tier or per-project enablement.

Putting the real key in the browser is not an option — it is extractable and it
is the same key every other task uses.

**Plan:** a small Node relay on Cloud Run holding `GEMINI_API_KEY`, with the
browser connecting to it instead of to Google. A **separate service, not a
custom server for this app** — Next stays serverless. `RelayVoiceTransport` in
`lib/voice/transport.ts` is the seam it plugs into: give it the relay URL and
implement `connect()`; nothing in the session UI changes, because the mic, level
meter and barge-in all talk to `VoiceSessionHandle`. The full reasoning and the
exact failing calls are recorded at the top of that file.

### 2. Voice audio never actually heard

The Browser pane blocks `getUserMedia` (`NotAllowedError`) and has no audio out,
so mic capture, the level meter under real input, barge-in, and TTS playback are
**code-verified but not heard**. Voice turns were driven by posting real WAV
audio to `/api/voice/turn` from inside the authenticated page — the same request
the transport makes, minus `MediaRecorder`. Needs a pass in real Chrome.

### 3. One escalated row left in the database

The guest row used to prove the escalation still has `is_guest: false,
daily_request_cap: 9999`. Throwaway anonymous user, hole now closed, but it can
no longer be corrected through the API — needs a SQL console.

---

## Next

1. **Hear voice in real Chrome.** Expect a "Let the interviewer speak" button on
   the first question (autoplay), then automatic speech for questions 2 and 3,
   a pulsing dot with "The interviewer is speaking", and barge-in cutting
   playback with "You cut in — go ahead".
2. **Build the Cloud Run relay** and point `answer_scoring`-style config at
   `RelayVoiceTransport` for true speech-to-speech.
5. **Timezone.** Dates render in the server's timezone. Fine while server-only;
   needs a per-user timezone before any of it reaches a client.
6. **Regenerate `lib/supabase/types.ts`** from `supabase gen types` once the
   schema settles, and keep it in CI.
7. **Queue is per-instance.** `CONCURRENCY = 2` is process-local; a
   multi-instance deploy needs Redis or provider-side quota.

---

## Decisions

**Two models named in the brief are gone; substitutions are marked in
`routing.ts`.**
- `gemini-2.5-flash` → 404 *"no longer available to new users… use
  models/gemini-3.6-flash"*. Using the model Google's own error names.
- `deepseek/deepseek-r1:free` → 404 *"This model is unavailable for free."* Of
  19 free OpenRouter models the nearest reasoning model is `z-ai/glm-5.2:free`,
  which returns shared-pool 429s more often than not.

**Groq-first for scoring and flag extraction.** Leading with GLM-5.2 spent the
whole 1/2/4/8s ladder on every submit before failing over — 15s of latency for
nothing. OpenRouter stays as the second leg so the chain still has two.

**The question renders at `--u-display`, not `--d-hero`.** Tried `--d-hero`
(195px) first: a full question runs to six lines and pushes the control and the
entire transcript below the fold, on the one screen where all three must be
visible at once. `--u-display` with the display *treatment* (Archivo condensed,
uppercase, 0.85) keeps it commanding and everything above the fold.

**Sub-scores are fixed columns, not rows,** because the design fixes them at
three. A fourth should be a deliberate migration, not something a writer can do
by inserting a row.

**"What to work on" shows flag counts, not points.** The frame says "cost you 6
points"; attributing points to a habit needs the scoring model. It reads "6
flags across 3 rounds" rather than inventing a number.

**`overall` is computed from the three sub-scores, not asked of the model.** An
overall the model invents separately can contradict its own sub-scores, and the
design leans on rank, so the number has to follow from what is displayed.

**Row types in `lib/supabase/types.ts` are `type` aliases, not interfaces.**
Interfaces don't get TypeScript's implicit index signature, so `Row: UserRow`
failed postgrest-js's `Record<string, unknown>` constraint, the whole schema
failed `GenericSchema`, and **every query silently degraded to `any`** — a
probe querying `no_such_column` was accepted without complaint. They must stay
type aliases; the file says so.

**`rounds.ordinal`, not `position`.** `POSITION(x IN y)` is SQL grammar and a
bare `position` inside a `CHECK` is exactly where that ambiguity bites.

**Proxy degrades in dev, throws in production.** A missing Supabase key in prod
silently switches off route gating, which shouldn't be a warning. In dev it
passes through un-gated so the design routes keep working before anyone wires a
project.

**Text mode does not depend on the voice migration.** `mode` is only written for
voice rounds and the rounds select falls back to a mode-free query — writing it
unconditionally broke text rounds on a database without the column.

**The transcript flag column is reserved on every row, flagged or not.** Without
the empty slot, unflagged utterances wrap at full width and flagged ones wrap
176px short, so the transcript's right edge ratchets down the page.

**`--surface` / `--surface-contrast` and the heat ramp are documented tokens.**
The surface pair lets one component invert on white and on black with no
variant. The heat ramp (`--heat-0…4`) is marked DATA ONLY — area is fixed in a
heatmap so intensity is the only channel left, which brushes against
"hierarchy is size, never opacity"; bounded and explicit rather than smuggled in.

**Placeholders are the one sanctioned grey.** `--placeholder` /
`--placeholder-inverse`, because a placeholder is affordance rather than
content. Nothing else may use them.
