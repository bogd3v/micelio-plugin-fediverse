---
name: ship-pr
description: Gate 5 of the Micelio factory - after the maintainer's approval, commit with sign-off (or push the commit the maintainer made), open the pull request and watch CI. Used by the master when a change has passed the blind review and the verification, or when asked to open, update or rebase a pull request.
---

# Ship a PR

This is gate 5 of the factory (`docs/factory.md` of `micelio-engineering`). The standard still rules: sections 11 and 13.

## Branch

- Always from the latest `main`: `git fetch origin && git switch -c <type>/<short-topic> origin/main`. Never commit on `main`, and never stack on another open branch unless the change depends on it.
- One concern per pull request. Security fixes, refactors, docs and dependency updates travel separately.

## Before the maintainer

Gate 5 starts only after gates 2, 3 and 4 passed. Nothing is committed before it.

1. Run the check command (the `check:` line in the first `## Commands` block of `AGENTS.md`; else the manifest's `check` script): it is green, and the pull request draft has, for every command, its summary lines (exit code and numbers) and the name of its log in the packet's `logs/`.
2. The correction log is complete. List the `Gate 3` and `Gate 4` comments and the `factory-log |` lines of the issue (`gh issue view <n> --json comments --jq '.comments[] | select(.body | test("^\\*\\*Gate [34]|(^|\\n)factory-log \\|")) | .body'`, never the full list). If any of them names a Blocking, an Important or a mismatch and the issue has no comment with a `factory-log |` line, stop: say which correction (which gate comment) has no line, and let the master post it. `ship-pr` never writes the line itself: it is the master's job at the moment of the correction (`docs/factory.md`, "The learning loop").
3. Canary. A pull request that changes a file of `.github/standard-sync.json`, `herdr/master.md`, `.claude/TEAM.md` (models) or the sections of the standard a role reads is opened only with a green canary run on the branch (`fixtures/factory/RUN.md`, "Canary" of `micelio-engineering`), cited in the draft's Tests section with its three results: the reviewer's Blocking found, the verifier's mismatch found, the escalation on round 3. Without it, stop and say so; the master runs the canary.
4. Tell the maintainer the change is ready and what only they can see on Docker (below). Then wait.
5. The commit message is a file outside the worktree, written by the worker. The worker never commits or pushes; the master runs this skill.
6. The sign-off is the maintainer's certification of the DCO (standard, section 13), given after they read the diff. The rule is written once, in `.claude/agents/master.md` ("Delivery"): only the master runs `git commit -s`, and only on the maintainer's exact phrase.

## Docker by risk

- The worker proved the acceptance criteria on the repository's Docker (or the run `AGENTS.md` names instead), and the verifier re-created it from scratch. Cite both runs in the pull request.
- The maintainer tests on Docker only what an operator or an editor sees: the admin UI, variables, migrations, Compose. Give the steps (image from the branch, the Compose to run it against, what to look at) for those and for nothing else.
- A change nobody sees that way (tooling, documents, a library) needs no maintainer Docker run.

## Commit

- Message: English, conventional prefix with an optional scope (`feat`, `fix`, `docs`, `refactor`, `style`, `test`, `ci`, `perf`, `chore`; `chore(deps)` for dependencies, scope `security` for security fixes). The subject is imperative, about 72 characters; the body gives the problem, then what changed, then what the reviewer must know. End with `Co-Authored-By: <the tool> <noreply@anthropic.com>` as the session gives it.
- Stage explicit paths (`git add <paths>`); never `git add -A` blindly (scratch files, `.playwright-mcp/`, a local `.env`).
- The maintainer reads the whole diff (standard, section 11). Then, after the phrase (step 6), the master runs only the commit prepared from the message file; if the maintainer runs it instead, it is the same command:

  ```bash
  git add <paths>
  git commit -s -F <message file>
  ```

  A commit that lacks its `Signed-off-by` is fixed by the maintainer, never by an agent. Never amend or force-push a commit that was signed off.

## Push and open the pull request

Only after the commit exists: made by the master after the phrase, or by the maintainer, who says so.

1. Check conflicts first:

   ```bash
   git fetch origin
   git merge-tree --write-tree origin/main HEAD >/dev/null && echo ok
   ```

2. Push: `git push -u origin <branch>`. If the branch was rebased, `git push --force-with-lease=<branch>:<sha> origin <branch>` with the sha you last saw on the remote, never a bare `--force`. If the dependency manifest or the lockfile conflict, take both from `main`, re-add your dependency with the package manager so it regenerates the lock, and never hand-edit the lockfile.
3. Open the pull request with `gh pr create` (or the REST API when the account cannot use it). The title has the same conventional prefix and sets the release label (`pr-labels.yml`); the body follows `.github/pull_request_template.md`: Problem, What changes, For review, Tests with the draft's Tests section as it is (the full logs stay in the packet) and the Docker used, and "Instructions that were wrong or missing". It references its issue: `Refs #N`, or `Closes #N` in the last one. End with the attribution line the session gives.
4. Update the issue's **Progress** section in the same step: the pull request, what changed with numbers, what remains. `gh issue view <n> --json body -q .body` and `gh issue edit <n> --body-file <file>`.
5. Watch CI: `gh run list --branch <branch> --limit 1`, then `gh run watch`. A red check goes back to you; never merge around it.

## The approval

The maintainer's approval carries a line `time: <minutes>m diff|report` (`diff` when they started from the diff, `report` when they started from the reviewer's and verifier's reports; `docs/factory.md`, review levels). The approval text you prepare carries it already filled in with the order read: `report` when the pull request is level 2 ("The maintainer's review levels" of `docs/factory.md`), `diff` when it is level 1; only the minutes are left to the maintainer. When the maintainer's own account opened the pull request, GitHub does not allow it to approve, so the line goes in a review comment instead:

```bash
gh pr review <n> --comment -b "time: 10m diff"
```

## Never

Run `git commit -s` without the maintainer's own `approved, sign off #N` for this issue, or as any role but the master, or with a committer identity that is not the maintainer's; add a `Signed-off-by` by hand or with `--amend`; push before the commit exists; or merge, tag, release or deploy without the maintainer's confirmation. Only the maintainer releases (standard, section 13); prepare a release, never run it unasked.
