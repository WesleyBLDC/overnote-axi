---
name: ship-change
description: Take an overnote-axi change from a branch to a merged pull request with its docs updated. Use when a feature or fix is ready to land, when merging a PR, or when a branch has fallen behind main.
---

# Ship a change

1. Branch: start from a fresh `origin/main` (`git fetch origin && git switch -c <area>/<topic> origin/main`).
   In a git worktree, a branch already checked out in another worktree cannot be checked out again; work on a detached `origin/<branch>` and publish with `git push origin HEAD:<branch>`.
2. Catch up: `git fetch origin && git merge origin/main` on the branch.
   Never rebase a pushed branch, because the repo rules forbid rewriting pushed history.
   When a conflict comes only from formatting, keep the branch's side and run `npx prettier --write <file>`.
3. Docs in the same change, pruning what is stale (see "Keeping docs and rules current" in `AGENTS.md`):
   - `README.md` when commands, flags, install steps, or the development scripts change.
   - `docs/DESIGN.md` for the command surface, output, error codes, paths, testing strategy, or module map.
   - `docs/architecture/system-design.md` when where the CLI sits in the Overnote system changes; the Overnote repository holds the source of truth.
   - `AGENTS.md` when a rule changes or stops matching the code.
   - Never hand edit `skills/overnote-axi/SKILL.md`: change `src/integrations/skill.ts` or `src/guidance.ts` and run `npm run build:skill`.
4. `npm run check` must end with `SKILL.md is up to date`.
   It builds against the Overnote checkout behind `.overnote`; set `OVERNOTE_DIR` to a clean checkout when the sibling `overnote` has local changes.
   Treat flaky or failing tests as defects.
5. Commit as `WesleyBLDC <WesleyBLDC@users.noreply.github.com>`, with no co-author trailer.
6. Publish the branch, then open the PR in a separate command: `gh-axi pr create -R WesleyBLDC/overnote-axi --title "Area: summary" --body-file <file>`.
   Doing both in one command, or passing a base flag, trips the lead guard.
   The guard also matches words in heredoc text, so write file contents with the editor tools rather than shell heredocs when they mention branch rules.
7. Merge: `gh-axi pr merge <n> -R WesleyBLDC/overnote-axi --squash --delete-branch --subject "<PR title> (#<n>)" --body "<one paragraph summary>"`.
   Always pass `--subject` and `--body`: GitHub's generated squash message appends a `Co-authored-by` trailer, which the maintainer's rules forbid.
   "Base branch was modified" means another PR just merged; wait a few seconds and run it again.
   When several PRs are ready, merge them in order, and merge `origin/main` into each later branch and run `npm run check` again before merging it.
8. Record any lesson from this run as a rule, a skill step, or a check (see "Learning" in `AGENTS.md`).
