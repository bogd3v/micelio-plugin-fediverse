# Agent team (micelio-plugin-fediverse)

The main session acts as **tech lead**: it reads the issue, does the work or hands a well-bounded piece to a subagent, integrates the result and owns the final quality. When the work runs through the Micelio factory ([`docs/factory.md`](https://github.com/bogd3v/micelio-engineering/blob/main/docs/factory.md) in `micelio-engineering`), the roles below take its stages and the main session follows the role it was started as.

## Roster

| Agent      | Use it for                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `planner`  | With the maintainer: scope, the ADR of gate 0, the epic and its issues, the retro                                      |
| `master`   | One per milestone, run as the main session: gate 1, one worker per ready issue, the reviewer and the verifier after it |
| `worker`   | One per issue, in its own worktree: the change, its evidence and the pull request draft                                |
| `reviewer` | Gate 3: a new agent that reviews the diff with no context from the worker                                              |
| `verifier` | Gate 4: a new agent that re-creates the repository's Docker and reruns every reported command                          |

## Workflow

1. **Understand** — read `AGENTS.md`, the issue and its Progress section, and the ADRs of the area. Ambiguous scope that is expensive to redo goes to the user.
2. **Implement** — the smallest change that satisfies the issue; tests with it.
3. **Verify** — `npm run check`, plus the suites the issue names. Record the real numbers.
4. **Ship** — the main session prepares the branch, the commit message and the pull request following section 11 of the standard, and asks the user before pushing. It never runs `git commit -s`: the user does (see the sign-off below).
5. **Close** — a summary for the user: what changed, what was tested, what was not verified, decisions pending.

## Delegation rules

- Subagents start with no context: every delegation gives the goal, the issue number, the relevant paths, the constraints and the definition of done.
- Do not delegate trivia: a one-line edit or a question one file read answers.

## Hard limits (every agent)

- Never push, merge, tag, release, deploy or run anything against production or staging. The agent prepares; the user approves.
- Never read or print `.env`, tokens or anything under `~/.claude/secrets/`. Use `.env.example` to learn variable names.
- **The sign-off.** The rule is written once, in `.claude/agents/master.md` ("Delivery"); no other role, and no main session that is not the master, runs `git commit -s`.
- Code, identifiers, commits, PR titles and descriptions in English (see `AGENTS.md`).
