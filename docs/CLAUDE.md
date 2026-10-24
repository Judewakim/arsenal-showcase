# Project rules

Rules every agent in this repo inherits. Read this before doing anything.

## What this is

The Arsenal — a platform for life insurance agents. AWS Amplify Gen 2 backend
(AppSync + DynamoDB + Lambda + Cognito + KMS, CDK under `amplify/`) and a
**vanilla-JS, no-build-step frontend** served from the repo root. There is no
bundler, no framework and no transpile step on the frontend: `index.html` loads
ES modules from `src/js/` directly. Do not introduce a build step.

Full documentation map: **[DOCS_INDEX.md](DOCS_INDEX.md)**. Read the doc for the
area you're touching before you touch it. Do not restate doc content here.

## Start here: the work goes through the team

**If the human has given you a goal, a feature or a bug, dispatch the
`orchestrator` agent before you write any code.**

You are not the orchestrator. It is a sub-agent and it runs only when something
dispatches it, so a session that opens and starts working directly has silently
bypassed the entire team. Nothing warns you. It just quietly does not happen.

This rule exists because that is precisely what kept happening. On 2026-09-23
the board held 31 tickets: 12 parked at `review`, 4 `done` — and all four came
from the single job that actually went through the team. Every other session
wrote its tickets, did the work itself, and never dispatched a tester. **Only
the tester may close a ticket.** So finished work piles up unfiled, the board
grows and never shrinks, and nobody can tell what is outstanding from what is
merely unclosed.

- **Anything that would become a ticket goes to the orchestrator.** It writes
  the tickets, gives each branch its own worktree, dispatches the specialists
  and the auditors, runs the tester, and stops for the human's approval.
- **You may work directly** on questions, reading, explaining, and on a live
  diagnose-fix-verify loop with the human watching. That is a real mode and not
  a failure — but the moment it becomes a unit of work another agent could pick
  up, it is a ticket, and it goes through the team.
- **Never leave a ticket at `tester-review` when you stop.** Dispatch the
  tester, or tell the human plainly that it is unverified and why. A ticket at
  `tester-review` looks finished and is not, and ten of them look like progress.

## The environment ladder

    local sandbox  →  staging  →  production
    (your own AWS   (branch:     (branch: main,
     sandbox stack)  staging)     app <amplify-app-id>, acct 111111111111)

- **Never develop against production.** `amplify_outputs.json` is gitignored and
  decides which backend your local app talks to. Check it FIRST on any
  `FieldUndefined` error. See [STAGING_SETUP.md](STAGING_SETUP.md).
- Feature work merges to `staging`, is tested by the human on the staging URL
  with a real login, and only then is promoted to `main`.
- **A merge to `main` IS a production deploy.** It is never a routine step.

## Task board protocol

- All work is tracked on the **shared task board**. Never do work that isn't a
  ticket.
- **The board is not in the repo.** It lives outside it so that no branch or
  worktree can fork it. Find it and read it with:

      node tools/board.mjs path
      node tools/board.mjs show

  The repo's [tasks/board.md](tasks/board.md) is a signpost, not the board. Do
  not write tickets into it.
- **Re-read the board immediately before you act on it.** Other sessions write
  to the same file while you work, so a status you read five minutes ago may be
  wrong now. Never report a ticket's state from memory.
- The human's own queue — tickets waiting on them to commit, merge, test, or
  resolve a blocker — appears at the top of `node tools/board.mjs status` and
  is printed in full detail with `node tools/board.mjs mine`.
- Closed tickets are archived into the repo with `node tools/board.mjs archive
  T-###`, which is what keeps their record in git once they leave the board.
- Ticket format:

      ### T-### | <title>
      - owner: backend | frontend | tester | devops | docs
      - branch: <the git branch this ticket's work belongs on>
      - worktree: <path to the worktree, filled in by the agent>
      - feature: <optional free-text slug>
      - status: todo | in-progress | tester-review | human-review |
                staging | shipped | done | blocked
      - depends-on: T-### (optional)
      - acceptance: <what "done" means, testable>
      - notes: <agent appends progress here>

  **Feature grouping (optional `feature:` line):** A free-text slug naming a
  user-facing or internal feature that the ticket belongs to. The board groups
  tickets by feature for readability instead of showing 134 individual ones.
  Branch names are NOT features — `tools/board-features.mjs` maintains an alias
  table (FEATURE_ALIASES) that folds branch names like `sms-fire` and
  `sms-lifecycle-index-grants` into one canonical `sms-backend` feature. To add
  or re-map a feature, edit only the alias table in that module; never
  special-case a raw value elsewhere.

- **Every status names who is holding the ticket.** That is the whole point of
  them. Before you set one, ask who is expected to act next, and set the status
  that says so.

      todo → in-progress → tester-review → human-review → staging → shipped → done
                                                                          (+ blocked)

  - `in-progress` — you picked it up. Add your name.
  - `tester-review` — you finished; the work is uncommitted. Waiting on **a
    tester**. Write 2–4 lines in notes saying what you did and what you ran.
  - `human-review` — a tester passed it. Waiting on **the human** to commit and
    merge. No agent may move a ticket out of here, and dispatching a tester at
    one re-verifies work that is already verified.
  - `staging` — committed, merged and deployed. Waiting on **the human** to
    test it on the staging URL with a real login.
  - `shipped` — **merged to `main` and live in production**, but the worktree
    and branch are still there. This is the ONE late status an agent may clear
    on its own: the work is done and what remains is housekeeping. Run
    `node tools/worktree.mjs done <branch>`, then set `done`. Never remove a
    worktree holding uncommitted changes — stop and say what they are.
  - `done` — shipped **and** cleaned up. Nothing outstanding anywhere.
  - `blocked` — say exactly why. **Do not guess past a blocker.**
- Only the tester moves a ticket to `human-review`. Only the human's own
  approval moves it past that.
- **`review` is retired.** It was split on 2026-09-24 because it meant two
  different things — waiting on a tester and waiting on the human — so the
  human's queue was invisible inside a single count. That is what let twelve
  tickets pile up on 2026-09-23. `node tools/board.mjs status` names any ticket
  still carrying the old word; read it and set the one that is TRUE rather than
  guessing, because the two halves need different people.

## Worktree protocol

Every branch gets its own git worktree, so agents work in parallel without
stepping on each other. See the `worktree` skill in `.claude/skills/worktree/`.

- Worktrees live at `../inbound-platform-wt/<branch-name>`, **never inside the
  repo**.
- Create with `node tools/worktree.mjs new <branch> --ticket T-###`. This
  creates the tree, copies the gitignored `amplify_outputs.json` in (a fresh
  worktree has none, and the app cannot boot without it), installs
  dependencies, and stamps the ticket on the board: status set to `in-progress`,
  `worktree:` filled in with the path, and frontmatter `claimed_by` / `claimed_at`
  populated. Without `--ticket` the tree is still built, but the board will show
  no sign of it.
- **Before editing anything, confirm you are in the right tree:**
  `git rev-parse --abbrev-ref HEAD` must equal the ticket's `branch:`.
- Clean up after a branch merges: `node tools/worktree.mjs done <branch>`.
  Never remove a worktree with uncommitted changes.
- One branch has exactly one driver. If a worktree already exists and someone
  else is in it, pick different work.

## The guard, and how to install it

Three git hooks enforce the process. They are committed but not active until
each clone opts in:

    git config core.hooksPath .githooks

`node tools/board.mjs status` checks this every session and says loudly if it is
missing, because a guard that is present but not running is worse than no guard.

**`.githooks/pre-commit`** refuses a commit made directly on `staging` or
`main` — those are integration branches, not workspaces. It permits merges
(how work is supposed to arrive there). Override: `ALLOW_DIRECT_COMMIT=1`.

**`.githooks/commit-msg`** refuses a commit that declares no ticket id or names
one that does not exist on the board. Ticket ids must appear in the subject
line (`T-###: ...`) or in a `Tickets` paragraph listing them. A ticket's status
is not checked at commit time — a commit may reference a ticket at any stage of
its life. Override: `ALLOW_UNTICKETED_COMMIT=1` (excuses only "no id at all",
not a typo or non-existent id).

**`.githooks/pre-push`** refuses pushing a feature branch when its unpushed
commits name a ticket still `todo` or `in-progress` — the hook blocks work from
reaching a shared remote before a tester has seen it. Integration branches
(`staging` and `main`) are exempt: they are not units of work. Override:
`ALLOW_UNVERIFIED_PUSH=1`.

Each override is an explicit decision to bypass the check, visible in the
output, not a silent habit.

**The three overrides, all together:**

| Hook | Blocks | Override |
|------|--------|----------|
| pre-commit | commits directly on staging/main | `ALLOW_DIRECT_COMMIT=1 git commit --only -- <paths>` |
| commit-msg | commits with no ticket id or non-existent id | `ALLOW_UNTICKETED_COMMIT=1 git commit ...` |
| pre-push | pushes with todo/in-progress tickets | `ALLOW_UNVERIFIED_PUSH=1 git push ...` |

## What the guards do, and do not do

**Hooks enforce process, not governance.** No hook dispatches the orchestrator
and none can; no hook closes a ticket or moves it to `human-review`. The hooks
make bypassing a decision (visible in the output) and make untracked work hard
to commit, but they do not replace the person or session choosing whether a goal
gets routed through the team. That routing remains a choice — the machinery just
makes the wrong choice loud and the right one durable.

## Hard rules

These are not style preferences. Each one is here because ignoring it has
already broken production at least once.

1. **Never commit, push, merge, open a PR, or deploy unless the human asked for
   that specific action.** Staging changes is fine. Committing is not.
2. **Other sessions leave files staged.** Never run a bare `git commit`. Use
   `git commit --only -- <paths>` and check `git show --stat` afterwards.
3. **Typecheck with the repo config:** `npx tsc -p amplify/tsconfig.json`.
   Never ad-hoc flags — a loose pass put `main` red before.
4. **After ANY change to `amplify/data/resource.ts` or `amplify/backend.ts`,
   run a CDK synth and `node tools/check-stack-cycles.mjs`.** A model named
   `Subscription` typechecks, passes tests, and can never deploy. A topic and
   its subscriber in different nested stacks blocks every deploy and is
   invisible to tsc, tests AND synth.
5. **tsc, tests and synth all pass on DynamoDB index-grant and null-key
   mistakes.** Anything touching GSIs or index access needs a real stack to
   prove it, not a green local run.
6. **A green Amplify job proves only that the listed artifacts published.**
   `amplify.yml` enumerates every publishable file with non-recursive globs, so
   a NEW directory needs a NEW line or it 404s in production. Walk the module
   graph against the live URL before calling a deploy good.
7. **A FAILED Amplify job does not mean nothing deployed.** The 30-minute
   timeout kills the build mid-CDK while CloudFormation finishes anyway, so the
   backend ships without the frontend. Check `describe-stacks`.
8. **Never commit secrets.** Secrets are set with `npx ampx sandbox secret set`
   locally and in the Amplify console per branch.
9. **AppSync has a ceiling of roughly 83 custom operations** (6 CloudFormation
   resources each against a hard limit of 500). Before adding operations, check
   `test/folded-ops.cases.mjs` and prefer folding into an existing one.
10. **Check which AWS account you are in before anything.** Production is
    `111111111111`. `222222222222` is an older account with other projects.
11. **On Windows, force UTF-8 on AWS CLI calls and check exit codes.** A failed
    command whose stderr is swallowed reads exactly like a finding.

## Definition of green

Before any ticket may be moved to `tester-review`, all of these must pass in
the ticket's worktree:

    npm test
    npx tsc -p amplify/tsconfig.json
    node tools/check-stack-cycles.mjs      # if amplify/ was touched
    node tools/check-orphan-imports.mjs

"The tests pass" alone is not green. Report what you actually ran and its exit
code. If you skipped one, say so.

**`check-orphan-imports.mjs` (T-182, 2026-09-24): now examines the working
tree by default**, not `HEAD`, and also flags relative imports missing a
required `.ts` extension (typechecks, but a plain `node` load — exactly how
`test/run.mjs` runs — cannot resolve it, so the file silently never executes).
It has three exit codes, and they are not interchangeable:

- `0` — examined at least one file, everything resolved.
- `1` — examined at least one file, found a problem. Output names it.
- `2` — examined **zero** files. This is not a pass. Do not cite it as green.

**A tester or worker citing this check must say how many files it examined**
(the tool prints this on every run). "exit 0" alone is not evidence; "exit 0,
408 files examined" is. Before this fix, the tool read `HEAD` only, so on
every uncommitted branch — which is every branch, since workers may not
commit — it examined nothing relevant and exited 0 anyway. Nearly every ticket
closed in one run cited that exit code as evidence; every one of those
citations was empty, not wrong. **Any ticket closed before 2026-09-24 that
cited `check-orphan-imports` exit 0 as evidence proved nothing with it** —
recorded here rather than reopened for that reason alone. `--committed`
restores the old HEAD-only behaviour for the one case it's legitimate: proving
a fully-committed branch is self-consistent from git's own perspective.

**Never read an exit code through a pipe, and never cite one alongside test
failures.** `test/run.mjs` ends with `process.exit(report())`, so on any
failure, the runner exits 1. But `npm test | tail`, `... | head`, `... > file`
and friends report the exit code of the LAST command, not the test runner. A
worker who writes "tests failed but exit code is 0" has read a pipe, not the
runner. **Such a note is REJECTED ON THAT ALONE** — no re-run needed and
without regard to how sound the accompanying diagnosis is. The right way: run
the command bare and read the raw output, or capture the code explicitly with
`npm test; echo $?` before piping anything. Three workers on feat/feature-layer
made this exact claim in a single run (T-274, T-275, T-276), which is why this
rule is here.

## Definition of done

`done` means **shipped to production AND cleaned up** — not merely verified.
A ticket may not be closed on work that exists in one place, and it may not be
closed on work nobody outside this machine can see.

`shipped` and `done` are split because they fail differently. Work that is live
but whose worktree still exists is not a problem for users — it is a problem for
the next agent, who finds a stale tree on a merged branch and cannot tell
whether it is abandoned or in flight. That has already happened here.

- A tester moves a verified ticket to `human-review`, never straight to `done`.
  Everything from there is the human's: the commit, the merge to `staging`, the
  test on the staging URL, and the promotion to `main`.
- **`done` is checkable, and it is checked.** `node tools/board-sweep.mjs`
  reports a closed ticket whose branch never reached `origin/main` as
  `CLOSED, NOT SHIPPED`, and one whose worktree still holds changes as
  `UNCOMMITTED`. Both are read out of git, because "it shipped" is a claim
  about the world and a status field forgets such claims into being wrong.
- Why: on 2026-09-23 fourteen tickets were marked `done` over code sitting
  uncommitted in five worktrees — one copy each, on one machine, no backup.
  Each tester had done its job correctly, because the acceptance criteria were
  all about the code and none of them said "and it is committed". `done` looked
  like safety and meant verified.
- `node tools/board-sweep.mjs` reports this as `UNCOMMITTED`. A finding there is
  a ticket that closed too early.

## Branching and commit protocol

- Every ticket carries a `branch:`. The human decides branch grouping; agents
  never invent it. Default when unsaid: one separate task = one separate branch.
- Branch off `staging`, not `main`, unless the human says otherwise.
- One ticket = one commit, prefixed with the ticket ID: `T-004: <what changed>`.
- **STOP BEFORE COMMITTING.** The orchestrator presents a per-branch summary and
  waits for the human.

## Channel awareness

- If `AGENT_CHANNEL=slack` is set, you are being driven from a Slack thread:
  keep messages under ~1,500 characters, use bullets, no code dumps, give file
  paths instead. There is no interactive approval UI — if you hit a tool you
  cannot run, say so and stop rather than retrying. The human's reply in the
  thread is your answer: "approve <branch>" means commit it, "push <branch>"
  means push it, anything else is a redirect.
- If unset, you are in the terminal. Behave normally.
