---
name: worktree
description: >-
  Git worktrees for this repo — one checked-out directory per branch so several
  agents, or you and an agent, work in parallel without switching the checkout
  out from under each other. Use when starting work on any branch, when two
  pieces of work need to run at once, when an agent must confirm it is on the
  right branch before editing, and when cleaning up after a branch merges.
  Covers tools/worktree.mjs, the amplify_outputs.json trap, and the cleanup rule.
---

# Worktrees

## The idea

One repository, one `.git`, **several working directories at once**. Instead of
`git switch` moving one folder between branches, each branch gets its own
folder. Commits are instantly visible across all of them because history is
shared; working files never collide because the directories are separate.

This is what makes parallel agents safe. Without it, two agents editing two
branches in one checkout will silently write each other's work onto the wrong
branch.

## Layout

    C:\dev\inbound-platform                  ← main checkout, the repo itself
    C:\dev\inbound-platform-wt\
        feat-callback-scheduler              ← one folder per branch
        fix-reminder-timezone

Worktrees are siblings of the repo, **never inside it** — a worktree inside the
repo would be picked up by the frontend's file globs and by `amplify.yml`.

## Starting work

```bash
node tools/worktree.mjs new feat/callback-scheduler
```

That command, and not a bare `git worktree add`, because it also:

1. **Branches off `staging`** (or `main` if staging does not exist yet).
2. **Copies `amplify_outputs.json` in.** This is the important part. That file
   is gitignored, so a fresh worktree does not have one, and without it the app
   cannot boot and every GraphQL call fails with `FieldUndefined`. That failure
   looks exactly like a code bug and is not one.
3. Runs `npm ci`.

Then, **before editing a single file**:

```bash
git rev-parse --abbrev-ref HEAD      # must equal the ticket's branch:
```

Record the worktree path on the ticket's `worktree:` field.

## While working

- Stay in your own tree. Never `cd` into another agent's worktree to "just
  check something" — read the file from the main checkout instead, or use
  `git show <branch>:<path>`.
- `node tools/worktree.mjs list` shows every tree, its branch, and whether it
  has uncommitted changes.
- One branch has exactly one driver. If `list` shows a tree already open on
  your branch, someone else has it. Pick different work or ask the human.

## Finishing

After the human has approved and the branch is merged:

```bash
node tools/worktree.mjs done feat/callback-scheduler --delete-branch
```

It **refuses to remove a tree with uncommitted changes** and prints them, and
it deletes the branch with `-d` rather than `-D`, so an unmerged branch
survives. Both refusals are deliberate: cleanup must never be the step that
loses work.

Leaving dead worktrees around is not harmless — each one is a full `node_modules`
and a stale `amplify_outputs.json` that may point at a backend that no longer
exists. Clean up when the branch is done.

## Which environment a worktree talks to

Whatever `amplify_outputs.json` in that tree points at, which is copied from
the main checkout at creation time. If you repoint the main checkout at a
different backend, **existing worktrees keep the old one** until you copy the
new file in. See [STAGING_SETUP.md](../../../STAGING_SETUP.md).

## For agents specifically

The Agent tool accepts `isolation: "worktree"`, which gives a subagent its own
worktree automatically. Use that for exploratory or throwaway work. Use
`tools/worktree.mjs` when the branch is real, named on a ticket, and its work
will be reviewed and merged — because that is the case where the missing
`amplify_outputs.json` and the cleanup rule matter.
