---
description: Turn one line (a bug, an improvement, a feature) into a GitHub Issue the routines will build — asks nothing, assumes and flags
argument-hint: <what you want, one line>
allowed-tools: Read, Glob, Grep, Bash(gh api:*), Bash(git log:*), Bash(git grep:*)
---

Request: $ARGUMENTS

Today: !`date +%Y-%m-%d`
Open Issues: !`gh api 'repos/Judewakim/inbound-platform/issues?state=open&per_page=50' --jq '.[]|select(.pull_request==null)|"#\(.number) [\([.labels[].name]|join(","))] \(.title)"' 2>/dev/null`

Read `ROUTINES.md` first. Then write one or more GitHub Issues (REST,
`gh api -X POST repos/Judewakim/inbound-platform/issues --input -`) that
the `ticket-worker` routine can build without asking anyone:

- **One Issue per independently shippable unit.** If the request is a
  feature that needs a backend part and a frontend part, that is two Issues
  with `Depends-on:` between them — one agent lane per Issue, because the
  worker stays in its lane (`.claude/agents/<owner>.md`).
- **First line of the body, always:** `**In plain words:** <two sentences a
  non-engineer would understand — what is wrong or wanted, and what will be
  different when it ships. No file names, no code.>` Then a blank line.
- **Title:** short, imperative. **Body:** what and why in three lines; the
  doc from `DOCS_INDEX.md` the worker must read; the files you believe are
  involved (grep first — name real paths); **acceptance that a tester can
  run** — the test, the exit code, the thing a user would see; anything you
  are ASSUMING, marked so the human can correct it; `Depends-on: #n` if any.
- **Labels:** exactly one `owner:*` (backend | frontend | devops | docs), one
  `difficulty:*` (easy | normal | hard — hard for schema, auth, anything
  under `amplify/`, anything needing design judgement), `security-review` if
  it touches auth, Lambda handlers, AppSync rules, KMS, client data or
  payments, `needs-aws-check` if it touches a GSI, index grant or null key,
  and `ready`.
- If the request is a bug and you cannot locate the code path, still write
  the Issue, label it `triage` instead of `ready`, and say what you looked
  for. A `ready` Issue with a guessed acceptance wastes a run.

Do not ask questions. Where the request is ambiguous, pick the reading that
is cheapest to reverse and flag it in the body. Do not write code. End with
the Issue numbers and, for each, one line on what will happen next (which
routine, roughly when — worker hourly at :07, tester at :37).
