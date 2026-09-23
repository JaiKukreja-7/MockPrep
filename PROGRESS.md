# MockPrep — build progress

AI mock interview platform. Next.js 16 (App Router, Turbopack) + Tailwind v4 +
Supabase. Free-tier LLMs only.

**Read this file first.** Last updated 2026-09-16.

---

## Done

### Design system and tokens

`app/globals.css` is the whole token layer and, in Tailwind v4, also the config
— there is no `tailwind.config.js`. Three layers: `@theme` (generates
utilities), `:root` (the source tokens verbatim, for hand-written CSS), and the
system's rules as component classes.

The `@theme` block **deletes** default namespaces so off-system values cannot be
typed: `--color-*` (no `text-zinc-500` to reach for), `--text-*` (no
`text-sm`/`text-3xl`, so the UI scale's cliff holds — `--u-display` is fluid
below ~580px, see Mobile), `--radius-*` (only
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
`Heatmap`, `Speaker`. Specimen sheet at `/test`.

`RuledRow`'s `progress` draws the existing 2px `.link-bar` along the row's own
1px rule — the rule *is* the meter track. No new element type, no third border
weight. Reused for the mic level meter, so the one moving thing on the voice
screen still reads as the system.

### Screens

| Route | State |
|---|---|
| `/` | Landing page from the frames; signed-in users go to `/dashboard` |
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

### Questions by type, level, follow-ups, rubric scoring (step 15, 2026-09-21)

The engineering track was producing generic behavioural questions. Now:

- **A plan per track** (`ROUND_PLAN` in `generate-questions.ts`): engineering
  is `dsa, dsa, cs_fundamentals, system_design` — four questions; the other
  tracks keep three with a behavioural one last. DSA topics are drawn from a
  bucket that widens with level (intern: arrays/strings/hashing; 1–3 years:
  two pointers/trees/graphs/DP), two distinct per round; CS from
  OS/DBMS/networks/OOP. The prompt asks DSA the way a phone screen does —
  state the problem with a tiny example, then approach, complexity, what
  breaks it, no code — and pitches everything at the level's brief. The
  plan's type wins over whatever the model labelled a slot.
- **Experience on the start form** — intern / fresher / 1–3 years (`junior`
  in the column), stored on the session.
- **Question type and topic stored on each round**; shown in the session
  eyebrow, on the report per question, and averaged by type on the
  dashboard.
- **One adaptive follow-up per question.** After the first answer,
  `follow_up` task decides whether to probe (weak, vague, no complexity, no
  edge case, no trade-off — the gap list is per type) and returns one
  question or null; the probe is stored on the round, so the cap of one is a
  fact of the row. The session screen shows the probe as the question with
  the original above it; the voice route returns it as `nextQuestion` with
  `followUp: true` and no bridge line, so it is read aloud as the question
  now is. `submitAnswer` refuses a submit whose `question` is not what the
  round is currently asking, which is what stops a stale retry of the first
  answer landing as the follow-up answer. A brain failure skips the probe
  and never loses the round.
- **Scoring per round under a rubric** (`scoreRounds`): the session's three
  delivery meters stay; each round also gets a content score as the mean of
  three type-specific axes — DSA: approach, complexity, edge cases; system
  design: requirements, trade-offs, scalability; CS: accuracy, depth,
  clarity; behavioural: situation, action, result; case: structure,
  numbers, recommendation; product: user, metric, reasoning. One model call
  for the whole session. Missing axes are zeros, invented axes are dropped,
  hallucinated ordinals ignored. Written to `rounds.score` /
  `rounds.score_detail`; the report lists "By question" with the axes; the
  dashboard lists "By question type" with meters.

*Tested* (46 new): the plan and the level buckets; the prompt's structure
(slots in order with types and topics, the phone-screen phrasing, the level
briefs, the JSON shape); parsing (plan type wins, bare strings tolerated,
nothing usable throws); the follow-up prompt's per-type gaps and examples;
`sanitiseProbe` (twelve cases); **the cap in both loops** — first weak answer
stores the probe and does not answer the round, the probe's answer never
asks again and does answer it, a stale retry writes nothing, a brain
failure answers as if no probe; the scoring prompt's rubrics and shape, and
`scoreRounds`' derivations. 193 unit tests in all.

*Accepted live* (2026-09-21, migration applied, dev server, real providers):
an engineering round as a fresher came back as DSA · two pointers, DSA ·
arrays, CS fundamentals · OOP, system design · URL shortener — each DSA
question stated with an example and ending "walk me through your approach,
then its time and space complexity". A vague "I would loop through it"
drew **"What is the time complexity of your approach?"** as a follow-up
with the original kept in view; a vague answer to that moved to question 2
— no second probe. The report scored that first answer approach 10 ·
complexity 20 · edge cases 5 → 12. Unverified: the probe rate on genuinely
solid answers — every canned answer in the run was weak or off-question,
so every question drew one, which is the right call for those answers and
says nothing about good ones yet.

*Follow-up rate measured, both sides* (2026-09-21). Two instruments:
`tests/integration/follow-up-rate.test.ts` runs the real task against a
fixed corpus — ten questions across DSA, CS fundamentals, system design
and behavioural, each with a strong answer (correct approach, stated
complexity, named edge cases, or the type's equivalent) and a weak one —
opt-in via `npm run measure:follow-up`, with thresholds as the contract
(≤10% of strong probed, ≥90% of weak probed). Result over three repeats:
**strong 0/30 probed, weak 30/30 probed.** Then a live engineering round as
a fresher with strong answers written for the four questions it actually
asked (longest subarray with sum ≤ k on *integers* — the answer had to
notice negatives break the sliding window; deepest-leaves sum; blocking
I/O in the scheduler; a read-through catalog cache): **0 of 4 probed**,
straight to the report, scored 85 / 84 / … under the rubrics. The earlier
run with weak answers had probed 4 of 4. No tightening was needed; the
"a solid answer gets no follow-up" rule holds at both ends. **Borderline
answers are untested** — a right approach with the complexity unstated, an
obvious edge case missed, or the data structure left vague. A first pass at
adding them (2026-09-21) measured 6/12 probed on the shipped prompt; a
checklist-style rewrite caught 12/12 but pushed strong answers to 11/30
then 6/30 probed, and was dropped unmeasured in its final form. The shipped
prompt is the one measured at 0/30 strong, 30/30 weak.

Note for the machine, not the product: `~/Desktop/nutriscan`'s `next dev`
holds port 3000 whenever it is free; MockPrep's dev server runs on 3010
here until that is closed.

### Model answers on the report (step 18, 2026-09-23)

Every scored question now carries what a strong answer would have sounded
like, written against *that candidate's* answer rather than as an ideal.

- **Folded into the scoring call, measured not assumed.**
  `tests/integration/model-answer-route.test.ts` (`npm run
  measure:model-answers`) runs both routes on a fixed four-question round
  and counts clean runs: every round answered, under the length cap, no
  preamble, no markdown — and, for the folded route, the scores alongside
  still complete, which is the failure it exists to catch. Two measurement
  runs of three repeats: **folded 6/6, separate 6/6**. Folded is one fewer
  provider call per round, so it wins the tie. `lib/llm/tasks/
  model-answers.ts` stays as the standalone fallback and shares the
  instruction text with the folded prompt so the two cannot drift; the
  test asserts folded ≥ separate, so a model change that flips it fails.
- **The instruction** (`modelAnswerInstruction`) names only the rubric axes
  of the types this round actually asked, each type once; pitches the
  answer at the session's level; tells the model to keep what was right and
  make the missing part the part that stands out; and, where the question
  is about the candidate's own experience, to use the specifics they gave
  rather than inventing a project — which is what makes a tailored round's
  resume question come back about their project. Capped at
  `MAX_MODEL_ANSWER_CHARS` 900, enforced by `sanitiseModelAnswer` after the
  model, cutting at the last sentence that fits.
- **Stored once, with the score,** in the same `rounds` update
  (`model_answer`, migration `20260923000000_model_answers.sql`), so a
  report never shows a score without its lesson or the reverse. Null on
  rounds scored before this existed and on any round the model gave nothing
  usable for; the report omits the row.
- **On the report**, a native `<details>` in a new `footer` slot on
  `RuledRow` — full width, inside the row, above its rule. Collapsed by
  default: the score stays the headline at `--u-lg`, the answer is
  `--u-body` behind one click. The summary reuses `.eyebrow` + `.link`, so
  it gets step 17's bar and focus ring for free; `.disclosure` is one CSS
  rule removing the marker.
- Inputs are exactly what scoring already sees — the stored question
  (contact-redacted at write time on a tailored round) and the candidate's
  own answer. No resume text reaches this, so it stays on the
  non-sensitive `answer_scoring` route and nothing new is exposed.
- Verified on a real scored guest round: four questions, four model answers,
  each addressing the actual gap (a hash-map answer to a shortest-path
  question came back with Dijkstra, a min-heap, O((V+E) log V), and
  unreachable nodes).

*Noticed, not fixed:* the rubric axes in a report row's meta line render in
jsonb key order (`depth · clarity · accuracy`), not the canonical rubric
order, because Postgres reorders jsonb keys by length. Pre-existing from
step 15. Fix is to map `RUBRIC[type]` over the stored object at render.

### Subtle motion (step 17, 2026-09-22)

Tokens first: `--motion-fast` 150ms, `--motion-slow` 400ms, one curve
`--motion-ease` (`cubic-bezier(0.2, 0, 0, 1)`), in both the `:root` block
and `@theme` (as `--ease-standard`; the stock easing scale is deleted so
`ease-in-out` cannot be typed). Every transition in `globals.css`
references them; there are no literal durations left outside the speaker.

- **Hover and focus.** Buttons and pills transition background, colour and
  border only; a pill inside a link (the track filters) takes the button's
  flat swap. A ruled row that contains a link darkens its 1px rule to the
  text colour (`.row:has(a):hover`). Text links carry `.link`: a 2px bar
  grows in from the left under the pointer or keyboard focus, drawn 2px
  under the line box so tap-target padding does not push it down. Focus is
  the same accent ring as before, but it is always present (transparent,
  flush) and settles to accent + 2px offset in `--motion-fast`.
- **Scroll reveal, landing only.** Sections marked `data-reveal=""` render
  visible; `app/reveal.tsx` marks only those below the viewport "pending"
  once mounted, an IntersectionObserver marks each "in" as it enters and
  unobserves it, so nothing replays. Items marked `data-reveal-item`
  stagger within their section in three tiers (0 / 40 / 80ms) — the last
  lands 480ms after the first starts. No JS: nothing hidden. Reduced
  motion: the observer marks nothing.
- **Reduced motion, globally.** `transition-duration: 0s` and
  `animation-duration: 0s` on everything, `!important`; reveals pinned
  visible. Hover states still land on the same end state, instantly.
- **Audit.** `design-audit.test.ts` reads `--motion-slow` from the sheet
  and fails any transition or animation longer than it, any transition
  whose duration plus delay passes 500ms, and any looping animation —
  on elements and their pseudo-elements. The self-test plants one of each.
  Two more cases on `/`: no-JS shows everything and a below-fold section
  reveals once and never replays; under `reducedMotion: "reduce"` every
  duration is 0s, every reveal is at opacity 1, and the observer has
  marked nothing, at all three widths.

Exempt from the loop and length rules, by class: the speaker's four state
animations (`.speaker-*`, 1.1–1.4s) and the `animate-pulse` dot on pending
states. Both are status indicators, not decoration, and both already stop
under reduced motion — kept, by decision.

*Follow-up:* `Button` takes `href` and renders a `Link` carrying the
button's classes, and every `<Link><Button>` nesting (eight, across the
landing page, error, unavailable, report and session screens) is gone.
That nesting was invalid HTML — interactive content inside an anchor —
and the reason the focus ring drew a rectangle around a pill; the ring now
follows the pill. `tests/unit/button.test.tsx` asserts both renders.

### Tailored rounds (step 16, 2026-09-22)

The start form has an optional "Tailor this round" section: a resume
(PDF/DOCX) and/or job details (title, company, pasted description). The
experience level select above serves both — one setting, not two.

- **Slots are replaced, not added**, so a round stays its length (six
  questions plus follow-ups can outrun the voice cap). A resume probe takes
  the second slot — engineering keeps one DSA problem — and a job or gap
  question takes the last, which is system design on engineering and which
  the job description steers anyway. With both inputs the last slot is the
  *gap*: a JD requirement the resume does not evidence. `planTailoredRound`
  and `tailoredSources` in `lib/llm/tasks/generate-questions.ts`.
- **A new sensitive task**, `tailored_question_generation`, Groq only.
  `question_generation` leads with Gemini and was not reused; the boot-time
  guard covers the new task and `tests/unit/routing.test.ts` asserts both
  resume-seeing tasks are sensitive.
- **The resume is parsed in memory and dropped.** `startRound` extracts it
  before charging quota, hands the text to the task, and writes only the
  questions — each passed through `redactContactDetails` first, in case the
  model quoted an email or URL off the page. `sessions.tailored_from_resume`
  is the only trace. Job details are stored on the session (`job_title`,
  `company`, `job_description`); `rounds.source` records resume / job / gap
  and the live screen and report show it next to the type.
- **Guests cannot upload a resume**: the form disables the input, the action
  refuses it, and `sessions_resume_requires_account` (restrictive RLS,
  migration `20260922000000_tailored_rounds.sql`) refuses the flag on insert
  and update — `tests/integration/supabase.test.ts` proves both.
- Verified end to end on localhost with a real resume and a frontend
  internship JD: the resume question named a project actually on the
  resume, the gap question targeted a JD requirement the resume did not
  show, and the stored session and rounds carried nothing from the contact
  line.

### Vercel (2026-09-21)

Target moved from Cloud Run to Vercel. `maxDuration` on every route that
reaches an LLM or Whisper — on the *pages* that host the server actions,
since an action runs under its page's segment config: `/dashboard`,
`/session/[id]`, `/report/[id]`, `/resume` at 120 s; `/api/voice/turn` at
300 s (the Fluid-compute ceiling). Scoring has been seen at 30 s.

Found while confirming pdfjs: the `/resume` function's output file trace did
not include `pdf.worker.mjs`, which pdfjs loads in Node with a runtime
`import()` the tracer cannot see. On Vercel every resume upload would have
failed with "Setting up fake worker failed" — and the Docker standalone had
the same gap, untested because an upload needs an account. Fixed with
`outputFileTracingIncludes` for `/resume`; verified in the `.nft.json` and
by parsing a fixture from the standalone bundle's `node_modules` alone.
`verify-deploy.sh` accepts Vercel's 308 for HTTP→HTTPS. `DEPLOY.md`
rewritten for Vercel, with the Cloud Run path kept as a footnote.

First Vercel build failed after `onBuildComplete` with ENOENT on
`.next/next-server.js.nft.json`. Confirmed in Next's source
(`build/index.js`): the adapter hook runs, then `output: "standalone"`'s
`writeStandaloneDirectory → copyTracedFiles` opens that file, which the
adapter path never writes — and a comment there anticipates the conflict.
`output` is now `"standalone"` only when `VERCEL` is unset. Verified: a
`VERCEL=1` build writes no standalone directory and the `/resume` trace
still carries `pdf.worker.mjs` (the adapter's `loadNFT` reads those
per-route traces); a plain build still produces the standalone tree with
the worker in it for Docker. The ENOENT itself cannot be reproduced
locally: it needs the adapter that `vercel build` injects.

### Error-state audit and fixes (step 14, 2026-09-16)

Eight failure paths, exercised rather than reasoned about — the server ones
with providers mocked, the browser ones in Chrome against a production build
(two of those against an env-free build; see the inlining note in
DEPLOY.md). What each showed, and what it shows now:

| Failure | Was | Now |
|---|---|---|
| Every provider 429 at start | six-line attempt log under the form; quota charged | one sentence: "…you have not been charged a round"; `refund_llm_quota` |
| Every provider 429 at scoring | attempt log; **dead end** on reload ("That is the last question.", no controls); a second Submit **inserted the transcript again** | `submitAnswer` idempotent on an answered round; one sentence; the page revalidates into the **Score this round** affordance |
| Cap hit at the last answer | same dead end | same affordance; the sentence names the cap |
| Whisper empty | good | unchanged |
| Whisper down | Groq's JSON blob on screen; recording gone | one sentence, blob in the log; **recording kept**, "Send that recording again" |
| Scan-only resume | fine, but quota charged first | extraction before the charge |
| Analysis fails | attempt log | one sentence; refunded |
| Network loss, text submit | Next's "This page couldn't load"; **answer lost** | sentence in the form; answer kept (controlled field, wrapped action) |
| Network loss, voice submit | "Failed to fetch"; recording gone | sentence; recording kept and resendable |
| Session expired, submit | "This page couldn't load"; answer lost | sentence, sign-in link (new tab), answer kept |
| Supabase unreachable | private routes **silently bounced to sign-in**, signed-in or not; "fetch failed" on sign-in; nothing logged | proxy tells "could not check" from "no session": `/unavailable` page with a way back, JSON 503 on the API, actions answer with the sentence, server log line, `x-mockprep-outage` header; sign-in says the sentence |
| Any unhandled error | Next default page, bare Reload | `app/error.tsx` in the empty-state idiom: back into the round / try again, back to the dashboard, digest shown |

New pieces: `lib/supabase/outage.ts` (`isSupabaseOutage`, `OUTAGE_MESSAGE`),
`lib/supabase/user.ts` (`currentUser` → `{user, outage}`),
`lib/llm/user-message.ts` (`describeLlmFailure`: one sentence up, the
attempt log to `console.error`), `lib/client-errors.ts`
(`describeSubmitFailure`: browser wording for network loss, Next's wording
for a proxied action, the 401 — each promising the work is still there),
`app/rounds/actions.ts` `scoreRound`, `app/session/[id]/score-retry.tsx`
(used on the session screen and the unscored report), `app/error.tsx`,
`app/unavailable/page.tsx`, `VoiceTurnResult.scoringFailed` (the transport
returns instead of throwing, so the turn is not re-sent).

**Two migrations to apply**, both loud in the integration suite until then:
`20260916000000_delete_own_guest.sql` (step 13) and
`20260916010000_refund_llm_quota.sql` (this step — floors at zero, same
row as the charge).

*Tested*: 53 new unit tests (`error-paths`, `proxy`, `client-errors`,
`voice-transport`, `error-screens` — the last renders `error.tsx`, the
all-answered session, the unscored and abandoned reports and `/unavailable`
to markup) and two e2e tests that start a real round as a guest and prove
the answer survives a dropped connection and an expired session in Chrome.
The design audit now covers `/unavailable`. Not assertable without a
microphone: the kept-recording flow's click path (the mapping and the
transport are unit-tested; the button is code).

### Automated tests (step 13, 2026-09-16)

Vitest 5, three projects in `vitest.config.mts`, each with a different cost:

| Project | Needs | Runs where |
|---|---|---|
| `unit` — `tests/unit/` | nothing | `npm run build` (so the Cloud Run image build), CI |
| `integration` — `tests/integration/` | the two public Supabase variables | CI with secrets, locally from `.env.local` |
| `e2e` — `tests/e2e/` | the same two, a Chromium | CI (Playwright's), locally (the installed Chrome) |

`npm run build` is now `npm run test:unit && next build`; a failing invariant
fails the image. `.github/workflows/ci.yml` runs all three on push; the two
that need secrets **fail** without them rather than skip — a check that
silently skips has stopped checking. `server-only` is aliased to an empty
module under test so the server modules import.

**Unit (94 after the follow-ups below; 56 at first):**
- Route table: importing `routing.ts` with a registry whose Groq policy has
  become training-eligible throws naming `resume_analysis` and `groq`; the
  real table passes; non-sensitive tasks may route anywhere; `runTask`
  refuses a sensitive step even when the chain is assembled after import.
- Redaction: the full table (11 redacted forms including `(03) 9000 0000`,
  10 preserved forms — year ranges, WAM, dollar figures, GPA, percentages),
  the mixed sentence, no stray bracket.
- Redact-before-truncate through `analyseResume` itself: an email at
  position 150 of a 200-char excerpt comes out as `[email]` in ≤160 chars;
  the control shows truncate-first would have stored `jane.doe@e`.
- Providers with `fetch` stubbed: 429 retryable with Retry-After in ms, 5xx
  retryable, 400/401/404 not; an empty 200 with `finish_reason: length`
  (Groq/OpenRouter) or `MAX_TOKENS` (Gemini) retryable; whitespace content
  never reaches the parser; unconfigured provider never touches the network.
- Failover through the real `runTask → withBackoff` with a faked clock: five
  429s sleep exactly 1000+2000+4000+8000 ms then the chain moves on; a 401
  moves on after one attempt and 0 ms; Retry-After 5 s beats the 1 s step;
  an empty-200 retries the same provider once; unconfigured providers are
  logged and skipped; exhaustion throws `AllProvidersFailedError` listing
  every attempt.
- `parseJson`: think blocks (multi-line, mixed case), both fence forms,
  preamble, braces inside strings, first-object-only, arrays, the
  no-JSON error quoting the response.
- `extractFlags`: interviewer lines, hallucinated indexes, non-integers,
  unknown flag names and junk entries dropped; string indexes coerced.

**Integration (9)**, as a fresh anonymous user against the real project:
`consume_llm_quota` — 0 of 10 to start, 9 spent, an overshoot rejected with
`used` unchanged, **two simultaneous requests for the last unit with exactly
one allowed**, then everything rejected at 10. Column grants — `is_guest`,
`daily_request_cap`, `daily_voice_sec_cap` each `42501`; `display_name`
accepted and read back with the other two untouched. Each run leaves one
anonymous user; the cleanup SQL is in the test's header.

**Design audit (28 + 9 conditional)** — `tests/e2e/design-audit.test.ts`,
Playwright over the production build (`next start` on 3100 from
`global-setup.ts`), at 375 / 768 / 1440: grey text (alpha < 1 on any element
with its own text), radii ∈ {0, 4px, 320px}, drawn borders ∈ {1px, 2px},
no box-shadow, every text element's font-size equal to what some `--text-*`
token resolves to at that viewport (token list read from the stylesheet, so
new tokens count and off-token sizes fail), every numeric readout tabular.
Routes: `/`, `/sign-in`, `/test` signed out; `/dashboard`, `/sessions`,
`/reports`, `/questions`, `/settings`, `/resume` as a guest. With
`E2E_EMAIL`/`E2E_PASSWORD` set it also audits `/report/[id]`,
`/resume/[id]`, `/session/[id]` from that account's data; without them those
nine cases are skipped by name. **Self-test**: one planted violation of each
rule on `/test` must be reported and nothing else — an audit that never fails
is not evidence.

**Follow-ups (same day):**
- *Empty 200 decided.* `ProviderError.retryable` is now `boolean | "once"`.
  An empty answer with the budget spent (`finish_reason: length` /
  `MAX_TOKENS`) stays fully retryable; an otherwise-clean empty 200 is
  retried exactly once per `withBackoff` call, then the chain moves on — a
  hiccup gets one more try so a round is not lost to it, a second empty
  means the provider is empty today and 2/4/8s more would only delay the
  failover. `withBackoff` tracks the single "once" retry independently of
  the 429 ladder (tested: 429, 429, empty, 429, empty sleeps four steps and
  then fails over).
- *Integration tests clean up.* `supabase/migrations/20260916000000_delete_own_guest.sql`
  adds `delete_own_guest()`: SECURITY DEFINER, deletes the caller's own
  `auth.users` row only if it is anonymous, and everything cascades. The
  suite's `afterAll` calls it and fails loudly, naming the migration, if it
  is missing — **the integration project is red until that migration is
  applied.** Also a product affordance in waiting: a guest who wants
  nothing kept.
- *Coverage gaps filled* with a recording fake of the query builder
  (`tests/support/fake-supabase.ts`): `rounds/sweep.ts` (threshold, measured
  from the newest line not the start, status guard on the update, the
  one-query newest-line map), `rounds/score.ts` (cap stops before the read,
  Q/A exchange text, the four numbers, flag index → row id mapping, session
  close, model failure without a write), `llm/quota.ts` (arg passthrough,
  bare row and array, no row, PGRST202 throws in production and warns once
  in dev, other errors rethrown). `resume/extract.ts` against generated
  fixtures (`tests/fixtures/generate.py`, no dependencies): a PDF whose name
  is one text item per glyph — pdfjs returns `P`,`R`,`I`,`Y`,`A`,` `,… with
  no `hasEOL`, the extractor reads `PRIYA RAMAN`, and the control asserts a
  space-join of those exact items is `P R I Y A   R A M A N`; a no-text PDF
  refused as a scan; a DOCX; a too-short DOCX; the size, empty and type
  guards. Getting pdfjs to emit per-glyph items took three tries: it merges
  adjacent text objects and even alternate font resources of the same face,
  and only flushes on a font-name or font-size change or a vertical shift.

**Coverage** (`npm run test:coverage`, `lib/**` minus types and voice):
**52% of lines** (was 33%). 100% lines: `routing`, `json`, `extract-flags`,
`openai-compatible`, `analyse-resume`, `redact`, `index`, `quota`,
`rounds/score`, `rounds/sweep`, `resume/extract`. `queue` 94%, `gemini` 57%.
Still 0%, deliberately: `lib/data/*` (Supabase queries behind RLS, only
meaningful with seeded data), the four model-output wrappers
(`generate-questions`, `score-answer`, `interviewer-turn`, `transcribe` —
testing non-determinism), `registry.ts` and `supabase/*` (env reads and
client construction; `proxy.ts`'s fail-closed branch is the one cheap gap
left, and it is verified end-to-end in the deploy notes).

**Not testable without a human, and not faked:** the microphone and the
analyser (calibration, echo floor, barge-in firing, the control-case
indicator), speech synthesis and its boundary events, the Speaker rings,
iOS Safari behaviour, and the actual sound of a round. The debug panel
(step 12) is the instrument for those. Also not covered: LLM output quality
(scoring, question generation — network, quota, non-deterministic), Whisper
transcription, real PDF/DOCX extraction on the user's files.

### Barge-in debug panel (step 12, 2026-09-16)

Two console traces produced three wrong diagnoses because the numbers the
decision rests on were locals inside the analyser tick, read after the fact.
Now the tick reads its tunables from `lib/voice/barge-in-tuning.ts` every
frame and publishes a snapshot there every frame, and
`app/session/[id]/voice-debug-panel.tsx` is a fixed overlay over that data —
monospace, dark, inline styles, deliberately outside the design system.

On the voice session screen behind `?debug=1`, dev only:
- RMS as number and bar with the current threshold as a red marker; the
  idle floor p95 and the idle threshold; the echo floor (with its sample
  count) and the speaking threshold; calibration state with ms left.
- `synthSpeaking`, whether the frame is inside the guard window and how far
  into the chunk it is, and the rolling window's fill against the trigger.
- Counters from the `__voiceLog` buffer: fires, suppressions, chunks done,
  chunks cut. The last five non-noise events, newest first (`mic.level` and
  `chunk.boundary` are filtered; the console still has them).
- Sliders for the idle and echo multipliers, the guard, and the window
  ratio. Live: `getTuning()` is read in the tick, and the thresholds are
  derived per frame rather than once at calibration, so a slider moves the
  bar on the next frame while a question plays. The resulting thresholds
  show beside each slider. `defaults` resets.
- Two buttons: a ~40 s test utterance through the real `speak()` path, and
  reset calibration (the tick sees `takeRecalibrationRequest()` and drops its
  idle and echo samples).
- **The control case, large:** the top block lights lime with "SPEECH
  DETECTED — nothing playing" when sustained speech clears the idle bar
  while nothing is playing, and red with "BARGE-IN FIRED" on a fire. If you
  talk and it never lights, the detector is deaf.

`__voiceLog` is untouched apart from a subscribe hook; the panel is a faster
surface over the same buffer, and `MIN_THRESHOLD` / `SPEAKING_BOOST` moved
into the tuning module so the panel's preview and the tick's decision are
one formula (`thresholdsFor`).

*Guarded*: `voice-round.tsx` gates on `process.env.NODE_ENV !== "production"`
before the flag, and the panel's import is inside that branch via
`next/dynamic`. Verified on a production build: zero client or server chunks
contain the panel's code or strings (the test utterance text lives in the
panel module for that reason); the voice round and the tuning store are
present as they should be. *Verified* in a throwaway harness (scratch mirror,
not in the repo — a page feeding synthetic snapshots and log entries): every
section renders, sliders update the store and the computed thresholds match
the formula exactly (idle 0.06 × 3 = 0.180; speaking max(0.180 × 1.35,
0.09 × 2.5) = 0.243), the test button routes through `speakTest`, `defaults`
restores 1.8 / 1.8 / 700 / 0.6, and counters and events derive from the log.
The mic-live behaviour (calibration, echo floor, the indicator) needs a real
browser with a microphone.

### Cloud Run deploy — prepared and verified locally, not yet live (step 11, 2026-09-11)

Neither `gcloud` nor Docker is on this machine and the Google account is the
author's, so the deploy itself is a hand-off; see `DEPLOY.md`, written for
the console (GitHub-connected build). The repo is public at
github.com/JaiKukreja-7/MockPrep since 2026-09-11; before the first push every
blob in history was searched for the four real key values from `.env.local`
and for key-shaped strings, JWTs, private keys, `service_role`, passwords,
emails, the project ref and LAN addresses — nothing, and the one screenshot
commit that had carried an email was already unreachable and was pruned. Everything up
to the hand-off is built and proven:

- `next.config.ts` → `output: "standalone"`. `Dockerfile` is three stages
  (`npm ci` → `next build` → node:24-alpine running `server.js` as the
  `node` user, `HOSTNAME=0.0.0.0`, `PORT=8080`). `.dockerignore` keeps every
  `.env*`, `.git`, `supabase/`, `scripts/` and `PROGRESS.md` out of the
  context — entries are anchored, because an unanchored `supabase` also
  removed `lib/supabase` from the rsync mirror used to test this.
- **Nothing is baked.** The browser Supabase client is never imported, so
  the `NEXT_PUBLIC_` pair is read only on the server, at request time. All
  five variables mount from Secret Manager (`scripts/gcp-setup.sh` creates
  them, prompting silently; `scripts/deploy.sh` mounts them with
  `--set-secrets`). The image built from a context with no env at all.
- **Found and fixed while proving that:** with no env at build time `/`
  never touched `cookies()` and Next prerendered it as static HTML — deployed,
  signed-in users would have got the landing page forever. `/` is now
  `force-dynamic`; the route table shows `ƒ /`.
- **Fail-closed, measured on the standalone build in production mode:** no
  env → `500` on `/`, `/dashboard`, `/sign-in`, `/test` and `POST
  /api/voice/turn`, with the proxy's "Supabase environment variables are
  missing in production" message in the log. Env injected at runtime → `/`
  200 with the headline, private routes 307 to `/sign-in?next=…`, the API
  a JSON 401, `/_next/image` 200 (sharp is traced into standalone).
- **Quota caps** are `consume_llm_quota` in Postgres under `FOR UPDATE`, so
  they hold across instances by construction; `lib/llm/quota.ts` throws in
  production if the function is missing rather than running uncapped. The
  deployed-instance confirmation is a signed-in round then Settings — in
  `DEPLOY.md`, along with an optional real-service fail-closed check via a
  no-traffic revision with secrets cleared.
- `scripts/verify-deploy.sh <url>` — twelve black-box checks; passes 11/12
  against the local standalone, the twelfth being HTTP→HTTPS which only
  Cloud Run's front end provides.
- Sizing: 1 vCPU, 1 GiB (pdfjs holds a 4 MB PDF in memory), concurrency 20
  (the in-process LLM queue runs two calls at a time), 0–2 instances, 300 s.

### Landing page (2026-09-11)

`/` was the step-1 placeholder until now — a phone opening the app saw
"MOCKPREP" and nothing else. Built from `01-hero` … `06-footer-supercharged`
in order: top bar (wordmark, sign-in, CTA pill — no nav, no counts), hero
(intro at `--d-body-lg`, `--d-hero` headline with the last sentence in the
accent), a static strip, three feature sections (centred eyebrow, `--d-hero`
headline, one paragraph, one screenshot in a 1px rule at the surface radius),
the ruled index (`--d-mid` rows with pills, outline pill beneath), the black
statement (`--d-hero` and a paragraph beside four ruled facts), then the
two-panel footer: black (mark, "How it runs", small print) and accent
(`--d-setpiece` OUT / LOUD with "Where to next?").

Anyone with a session — email or guest — is redirected to `/dashboard`; the
page is for people without one. Guarded by `hasSupabaseEnv()` so it still
renders in a checkout with no env.

Decisions made on the way, none of them token changes:
- **The strip carries the four tracks, not logos.** There are no client
  logos, and employer marks would be a claim the product cannot make. The
  track names in the display face do the same job.
- **The set-piece is OUT / LOUD, one word a line.** At 27vw, Archivo at wdth
  62 is wider than the frame's cut: "OUT LOUD" on one line is 1104px+ at
  1440. Two words on two lines is the frame's own composition (SUPERCHARGED /
  DIGITAL), so nothing was lost.
- **The wordmark stays at `--u-body`** on the landing page, as on every other
  screen, rather than the frame's ~48px. One mark, one size. Flagged, not
  hidden — the frame is bigger.
- **A 1px rule seams the black statement into the black footer panel.** Two
  black blocks back to back had no boundary.
- **Hero sentences are block spans** so a phone breaks between sentences
  ("Say it / out loud." with a no-wrap on the phrase), never inside one.

*Verified at 375, 768 and 1440* from a signed-out headless Chrome, by
measurement: zero page overflow, zero elements whose text exceeds their box,
zero tap targets under 40px, zero grey text, zero shadows, radii 4px/320px
only, borders 1px/2px only, every font-size a token (plus `<sup>` at 0.75em).
Hero: 4 lines / 26% of the viewport at 375, 3 lines at 768 and 1440.

Product screenshots are real captures from `scripts/capture-landing.mjs`:
a visible Chrome, a sign-in typed there, the dev badge and account line
stripped before each capture, the voice round captured mid-question after a
trusted (CDP) click on the audio unlock.

### Stale live rounds are swept (2026-09-11)

A live session left open resumed with its true wall-clock elapsed — 6425:39.
`lib/rounds/sweep.ts` marks a live round **abandoned after one hour with no
activity**, measured from the latest of `started_at` and the newest
transcript line, so someone thinking on question two is not swept. One hour
because a round is three questions capped at ten minutes of speech: an hour
of nothing is a closed laptop, not a pause.

It runs at read time — on the session page (before load) and the sessions
list — because reading is the only moment a stale round is a problem. The
session page renders an abandoned state with a way out instead of the live
UI. A scheduled sweep (pg_cron) would tidy rounds nobody returns to; it needs
setting up on the Supabase side.

*Verified*: the 6425:39 session now lands on the abandoned state.

### Mobile (step 10, 2026-09-11)

Every screen audited at **375 and 768** by measurement, not by eye: page
overflow (`scrollWidth − clientWidth`), every tap target under 40px, and for
the session screen the question's height as a share of the viewport.

**Fixed:**
- `.row` now wraps (`flex-wrap`, row-gap tighter than column-gap) and
  `RuledRow` gained `stackTrailing`: a wide trailing slot drops beneath the
  title on a phone instead of crushing it. Before: recent-sessions title
  **78px**, trailing 23px past the viewport. After: title 311px, trailing
  wrapped beneath. Used on dashboard, reports, resume, report transcript,
  analysis findings. Meter rows keep a lone number beside the label.
- Heatmap: 53 columns in 311px gave 3.9px cells. Cells are held at 6px
  minimum and the block scrolls inside its own container — wide content
  scrolls in place, never the page. A month label spanning four columns
  from column 51 was creating implicit columns and pushing the page 24px
  wide; the span is clamped.
- Nav links on the strip get `py-3` (22px → 46px tap target), `lg:py-0`
  hands the rhythm back to the column. Filter pills and row-title links get
  invisible vertical padding to clear 40px.

**Mobile Safari hardening (unverified on device — no iOS here):**
- `AudioContext` is created synchronously at the top of `arm()`, before the
  `getUserMedia` await, while the click still counts as activation. Created
  after an await it starts suspended on iOS: the analyser reads zeros, the
  meter dies, the noise floor calibrates at silence and barge-in goes deaf.
  `resume()` is called and the state logged as `audioContextState`.
- `MediaRecorder` asks for WebM/Opus, then WebM, then MP4 — iOS has no WebM.
  The upload is named from the blob's real MIME type and the server carries
  that name through to Whisper, which keys its decoder off the extension.
- Known and not fixed: iOS Safari does not reliably fire `onboundary`, so the
  Speaker's rings will not appear there. The breathing still runs; the state
  still reads. Faking word events from a timer was considered and rejected —
  the rings mean words.

*Verified at both widths*: sign-in, dashboard, sessions (table scrolls in its
container), reports, questions, settings, resume, resume/[id], report/[id],
landing, session text, session voice. Zero page overflow on every screen at
both widths — the session screen was the last holdout, closed by the
`--u-display` change below.

### `--u-display` is fluid (2026-09-11, decided by the brief's author)

The session question at a fixed 4rem failed at 375 on two counts, measured:
a 117-char question ran **707px, 87% of the viewport**, putting the textarea
at y=930; and the single word "MARKETPLACE?" at 64px condensed was 352px in a
311px column, pushing the whole page 10px wide. Structural, not a layout bug:
`--d-hero` also bottoms out at 4rem, so below ~530px neither scale had a
display size under 64px. The UI scale never got a phone step.

Chosen: `--u-display: clamp(2.5rem, 11vw, 4rem)` — 41px at 375, 64px from
~580px up. One token value changed, in both the `@theme` block and its
`:root` mirror; no screen touched. The rejected alternative was stepping only
the question down to `--d-mid` below `sm`, which would have used `--d-mid`
outside its documented role and left the question no longer the big number.

The note in the token file records why the ratio to `--u-lg` narrows to
**~2× on a phone from 3.2× at desktop**: the cliff is shallower there by
necessity, not abandoned. Nothing was added between the two steps.

*Re-verified at 375*, same method:

| | text round | voice round |
|---|---|---|
| question | 20 words | 22 words |
| at 41px | 351px, **43%**, 10 lines | 316px, **39%** |
| same question at 64px | 870px, 107% | 870px, 107% |
| longest word | "marketplace" 211px in 311 | "supply-side" 176px in 311 |
| in the first screen | textarea at y=574 | Speaker 511–607, record 631–679, meter |
| page overflow | 0 | 0 |

Dashboard and report scores at 375: **41.25px against a next-largest 20px**
— still the one big number on the screen, ratio 2.06. At 768 everything
computes to 64px exactly as before; the tablet measurements are unchanged.

### Visual speaker (step 9, 2026-09-11)

The interviewer, seen. Direction B of three proposed — the accent dot that
already marked state on the voice screen, promoted into a form. Abstract, no
assets, no dependencies: inline SVG driven by `speechSynthesis` `onboundary`
(rings) and mic RMS (fill). Accent on the grid, 1px hairlines, no gradient,
no glow, no shadow.

Four states, and the point is that they are distinct **by shape**, not motion:

| state | form | driver |
|---|---|---|
| idle | small solid dot | — |
| speaking | large solid dot, breathing; a hairline ring per word | `onboundary` |
| listening | hollow circle filling from the bottom | mic RMS |
| thinking | small dot with a 270° arc orbiting | — |

**Solid is the interviewer; hollow is you.** That split is what lets a user
tell "the interviewer is speaking" from "you are being recorded" at a glance,
and it holds under `prefers-reduced-motion`, where the breathing, rings and
orbit all stop. The small status dot beside the label follows the same
solid/hollow convention at small scale, so the two indicators agree.

Rings are the disciplined part. A natural pace is 3–5 words/s, and one ring
per word at that rate stacks into a pulse that reads as glow. Two limits:
**at most 3 alive**, and **at least 320ms between emissions**. Words inside
the gap or over the cap are simply not drawn — the speech is not throttled,
only the ink. The ring keyframe animates radius alone (no opacity) and the
ring is removed at the end, because a fading ring is a glow. Under reduced
motion rings are never emitted at all, since a ring that cannot expand is
just a second circle.

*Verified*: pulsed at 4.5 words/s, 60 samples over 3s — never more than 3
rings, ~10px apart radially at any instant, reading as discrete marks. The
ring keyframe compiled with `r` as its only animated property. The
reduced-motion rule compiled inside `@layer components` with
`animation: none` on all three classes. On a live voice session: present at
160×96 beneath the question, question text intact, correct `aria-label`.

Motion keyframes live in `globals.css` as a numbered rule (7) beside the
others — the speaker is the one animated object in the system.

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

### Barge-in fired against the synthesiser's own voice (2026-09-06)

Chunking did **not** fix the cut-offs, and short utterances still truncated —
so the 15s cutoff was the wrong diagnosis. Instrumenting rather than guessing
again produced a captured trace: three `bargein.fire` events with
`synthSpeaking=true` while the room was silent, at RMS 0.071 / 0.070 / 0.094
against a threshold of 0.06, each followed within 20ms by
`chunk.error interrupted`.

Root cause was the threshold itself. **A real room's idle floor peaks
0.06–0.19**, so a fixed 0.06 sat *below* ambient noise. Three consecutive
frames at 60fps is ~50ms, short enough for the synthesiser's own onset to trip
it past echo cancellation. Two of three false fires landed within 400ms of a
chunk starting.

Rebuilt with nothing keyed to an absolute level:

- **Idle floor measured** over the 2s after `arm()`, from non-speaking frames
  only. Threshold is `p95 × 1.8`, floored at 0.08.
- **Echo floor measured** during each chunk's guard window, where any level is
  known to be our own output. The speaking threshold must clear that too.
- **Guard window**: no barge-in in the first 700ms of a chunk.
- **Rolling window**: 60% of a 600ms window over threshold, minimum 15 frames
  — not three consecutive.
- Barge-in cannot fire before calibration completes.

The multipliers were modelled against the captured numbers rather than picked:
2.2×/1.5× put the speaking bar at 0.63 RMS in a noisy room, above ordinary
talking, which would have swapped twitchy for deaf. 1.8×/1.35× keeps it
2.6–4.9× above the observed false fires. A `speech.detected` log line records
sustained speech while nothing is playing, so a trace can show whether the bar
is reachable by a real voice.

**PARKED (2026-09-11), to be revisited before deploy.** The adaptive detector
is committed but unconfirmed by a trace. Two outcomes are possible and the log
distinguishes them: questions play through and `speech.detected` appears when
the candidate talks (fixed); or questions play through but `speech.detected`
never appears (the bar is now too high — lower `IDLE_MULTIPLIER`). The
instrumentation stays in until this is closed.

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

### 2. Barge-in detector — parked until pre-deploy

Voice has been heard in real Chrome and two traces captured; the cut-offs were
barge-in firing on the synthesiser's own echo, not the 15s cutoff (see the
barge-in section under Done). The adaptive replacement is committed but not yet
confirmed by a trace. Return to this before deploy: run a voice round, speak
once while nothing is playing, and check for `speech.detected` in
`__voiceLog.dump()`.

The Browser pane used for automated checks blocks `getUserMedia` and has no
audio out, so this can only be closed from a real browser.

Step 12 (2026-09-16) built the instrument for closing this: the debug panel
above. What to watch is in that entry. Still parked until a real-browser run
shows the control case lighting and no fire while silent.

### 3. One escalated row left in the database

The guest row used to prove the escalation still has `is_guest: false,
daily_request_cap: 9999`. Throwaway anonymous user, hole now closed, but it can
no longer be corrected through the API — needs a SQL console.

---

## Next

1. **Go live on Vercel** is done; **watch the follow-up rate in real
   rounds** with `npm run measure:follow-up` if it ever feels off — the
   corpus and the thresholds are in `tests/integration/follow-up-rate.test.ts`.
2. **Go live on Vercel.** Follow `DEPLOY.md`: import `JaiKukreja-7/MockPrep`,
   set the five environment variables, deploy, pick the function region
   nearest Supabase, then add the domain to Supabase → Authentication → URL
   Configuration, run `scripts/verify-deploy.sh <url>`, and one signed-in
   round to see the cap count on Settings. (Cloud Run was the first target;
   its Dockerfile and scripts still work and stay in the repo.)
3. **Close the barge-in item before deploy** — see Blocked #2. Still open;
   the deploy above ships the parked detector as is.
4. **Build the Cloud Run relay** and point voice at `RelayVoiceTransport` for
   true speech-to-speech.
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

**`--u-display` is fluid, not stepped.** When the fixed 4rem failed at 375 the
choice was between making the token fluid and dropping the question alone to
`--d-mid` on phones. Fluid won: the name stays, the cliff stays, scores and
question shrink together, and no size is borrowed from a role it was not
documented for. The cost is a shallower cliff on a phone (~2× instead of
3.2×), which the token file says out loud.

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
