# Routines — how the team runs with the laptop shut

Decided 2026-10-11. Replaces the board (`tools/board.mjs`) and the runner
(`tools/runner.mjs`) as the way work moves. Those stay on `feat/agent-runner`
for reference and are not deleted; nothing new is built on them.

## Why

The runner was a loop too — it polled a board and spawned headless sessions —
but the board lived in a directory on one laptop, the worktrees lived beside
it, and the process died when the lid closed. Three weeks produced 19
incidents, most of them "two agents could not see the same state" (I-2, I-3,
I-4, I-6) or "it only works on this machine" (I-18, I-20). GitHub already
holds shared state (Issues, PRs, CI), and a server-side scheduled task already
runs on a timer in a fresh checkout. So the state moves to GitHub and the
scheduler moves to the server; the agent prompts, `CLAUDE.md` rules, the
Definition of green and the auditors carry over unchanged.

## The pieces

| Piece | Was | Now |
|---|---|---|
| Ticket | `T-###.md` on the laptop board | a GitHub Issue |
| Status | `- status:` line in the file | one status label on the Issue |
| Owner / difficulty | `- owner:` / `- difficulty:` lines | `owner:*` / `difficulty:*` labels |
| depends-on | `- depends-on:` line | `Depends-on: #12, #13` line in the Issue body |
| Worktree | `../inbound-platform-wt/<branch>` | the routine's own fresh clone — isolation for free |
| Dispatcher | `tools/runner.mjs` on the laptop | two scheduled tasks on the server |
| Worker | `claude -p` with `.claude/agents/<owner>.md` | **ticket-worker** routine; loads the same agent file by `owner:*` label |
| Tester | `claude -p` with `.claude/agents/tester.md` | **tester** routine; loads the same file |
| Dashboard | `board-dashboard.html` | the Issues page filtered by label |
| Human gate | `human-review` status | PR to `main` — never automated |

## Labels

Exactly one **status** label on an open Issue at any time:

| Label | Who holds it | Meaning |
|---|---|---|
| `ready` | nobody | may be picked up; `Depends-on` must all be at `staging` or closed |
| `claimed` | ticket-worker | a run has it; the claim comment carries the UTC time. A claim older than **3 h** with no PR is stale and may be re-claimed |
| `pr-open` | tester | worker pushed `ticket/<n>-<slug>` and opened a PR to `staging` |
| `staging` | the human | merged to `staging`; waiting on a live test on the staging URL |
| `blocked` | the human | a routine stopped and said exactly why in a comment |
| `needs-human` | the human | review found something it could not clear, or a merge condition failed — the old `human-review`, now meaning what it says |

Shipped-to-`main` closes the Issue (`Fixes #n` in the promotion PR).

Routing labels, set when the Issue is written:

- `owner:backend` `owner:frontend` `owner:devops` `owner:docs` — picks the agent file.
- `difficulty:easy` `difficulty:normal` `difficulty:hard` — picks the model (haiku / default / opus). The tester is never downgraded.
- `security-review` — touches auth, Lambda handlers, AppSync rules, KMS or client data. Set it on the Issue when writing it; the worker also adds it if it finds itself in those files. The tester runs the `arsenal-security` checklist before merging.
- `needs-aws-check` — touches a GSI, index grant or null-key path. Hard rule 5: tsc, tests and synth all pass on these mistakes; only a real stack proves them. The tester does **not** merge these; it labels `needs-human` with what to prove on a sandbox.

## The two routines

Both run server-side on a schedule, each in a fresh clone of `staging`. Each
run does **one** ticket and exits. Prompts live in `.claude/routines/`.

**ticket-worker** (hourly at :07) — `.claude/routines/ticket-worker.md`

1. List open Issues labeled `ready`, oldest first. Skip any whose
   `Depends-on` Issues are not at `staging` or closed, and any that already has
   an open PR. Take the first.
2. Claim it: swap `ready` → `claimed`, comment the UTC time.
3. Branch `ticket/<n>-<slug>` off `staging`. Read `CLAUDE.md`, the agent file
   for its `owner:*` label, and the area doc from `DOCS_INDEX.md`.
4. Implement, with tests. Run the Definition of green; keep every raw exit
   code.
5. Commit `#<n>: <what changed>` with `git commit --only -- <paths>`, push,
   open a PR to `staging`. The PR body says what changed, what was run, each
   exit code, and anything it could not verify. Swap `claimed` → `pr-open`.
6. If it cannot finish: no push, swap `claimed` → `blocked`, comment exactly
   why. Nobody is there to answer a question.

**tester** (hourly at :37) — `.claude/routines/tester.md`

1. List open PRs to `staging` whose Issue is `pr-open`, oldest first. Take the
   first whose CI run for the **head SHA** has finished.
2. CI red → comment the failing job, swap `pr-open` → `ready` so the worker
   re-picks it. Second red on the same Issue → `needs-human`.
3. CI green → check out the PR branch and verify adversarially per
   `.claude/agents/tester.md`: read the files, break the fix and watch it
   fail, write the missing tests, run the full green set. Push any tests it
   wrote to the PR branch (that re-runs CI; next run picks it up).
4. Pass, and **all four hold** — CI green on the exact head SHA; merges
   cleanly; `package.json` / `package-lock.json` untouched; the last CI run on
   `staging` itself is green — then merge the PR (`--no-ff`), swap
   `pr-open` → `staging`, comment the merge SHA. Push the SHA, never a ref.
5. Any condition fails, or `security-review` / `needs-aws-check` finds
   something → `needs-human` with the failing condition named. No merge.
6. Fail → comment the exact failing output and file, swap `pr-open` → `ready`.

Nothing in either routine targets `main`. A merge to `main` is a production
deploy and is the human's, by hand, from the staging URL test.

## What changed in the hard rules

Hard rule 1 said agents never commit. A cloud run that does not push loses its
work when the container is reclaimed, so the rule is now: **routines commit
and push only to `ticket/*` branches, and merge only to `staging` under the
four conditions above. `main` is never touched by anything automated.** The
approval gate moved one step later and got stricter — CI on the exact SHA is
now a witness the human-read-the-ticket regime never had (T-322).

**slack-intake** (hourly at :22) — `.claude/routines/slack-intake.md`
Reads `#the-arsenal-admin` back to 2026-10-01, turns each new bug report or
request into an Issue once (`Slack-ts:` line is the dedupe key). `ready`
only when it found the code path and wrote a testable acceptance; otherwise
`triage` for the owner. Posts one summary line to the channel when it opened
anything.

**ci-health** (hourly at :52) — `.claude/routines/ci-health.md`
Red `staging` CI → one `ci` Issue with the reproduced failure (blocks every
merge, so it says so). Claims older than 3 h with no PR → back to `ready`.
PRs with no CI run or no tester visit in 6 h → `needs-human`. Merged
`ticket/*` branches → deleted. Posts to Slack only when something is wrong.

Status label added for intake: `triage` — an Issue the owner must finish
specifying before it may be `ready`.

## Operating it

- **Write a ticket:** from any Claude Code session on this repo, `/ticket
  <one line>` writes the Issue with the right labels and acceptance (or
  `triage` if it could not find the code path). By hand: an Issue with the
  acceptance criteria, an `owner:*` label, a `difficulty:*` label, optional
  `Depends-on:` line, then `ready`. From Slack: a bug report in the app's
  feedback box lands in `#the-arsenal-admin` and `slack-intake` tickets it.
  `/idea` still turns a bigger request into a brief; ticket the brief with
  `/ticket` per item.
- **Every Issue opens with `**In plain words:**`** — two sentences a
  non-engineer can read. Routines and `/ticket` write it; a human-written
  Issue should too.
- **See the state:** Issues filtered by label. `staging` is your test queue;
  `needs-human` and `blocked` are your inbox.
- **Promote:** test on the staging URL, then open a PR `staging` → `main`
  yourself with `Fixes #n` lines.
- **Pause everything:** disable the two scheduled tasks. Nothing else is
  running anywhere.
- **Add a routine** only when the same class of defect reaches `staging`
  twice and the tester did not catch it.

## Known gaps on day one

- Hard rule 5 (real-stack proofs) is a human step via `needs-aws-check`.
- `tools/verify-browser.mjs` needs staging credentials in the routine's
  environment; until they are set, UI tickets land at `needs-human` with
  "not seen in a browser" rather than being passed unseen.
- The cloud permission classifier sometimes refuses a routine's commit or
  push as "unrequested" (2026-10-11, runs for #52 and #53). The task prompt
  now states the owner's pre-authorization; if it recurs, the worker labels
  `blocked` with the refusal text and ci-health re-queues nothing — a human
  looks.
