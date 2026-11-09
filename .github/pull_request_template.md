<!-- Title: conventional prefix and optional scope, in English. Example: fix(check): fail when the lockfile is missing -->

## Problem

<!-- What is wrong or missing, with evidence: an error, a measurement, an issue. -->

Refs #

## What changes

-

## For review

<!-- The changed lines, and the reason when they are above 400 (docs/engineering-standard.md, section 11). Risks, behaviour changes, contract changes (docs/engineering-standard.md, section 6), published package versions, manual steps after merging. Write "None" when there are none. -->

## Tests

<!-- For each command: the command, its real output with the numbers, and the Docker (or the run AGENTS.md names instead) it ran on. For each new guard, permission check or branch in code, or fix of code behaviour: the test that covers it and its failing output with the production lines reverted in a scratch copy (it fails without the change), with the command; for a change that is not code, `no test: not code`. Say what was not verified. -->

```
the check command
```

Docker used:

## Instructions that were wrong or missing

<!-- What in AGENTS.md, a skill or the issue failed you, one line for each, in the shape `<path or "standard" or "issue">: <what is wrong> - fixed in <path> | reported to the master`. A wrong `AGENTS.md` or skill of this repository ends `fixed in` and the file must be in `git diff --name-only`; the standard, the issue and, outside `micelio-engineering`, a synced file end `reported to the master`; in `micelio-engineering` a synced file is fixed under `template/` and ends `fixed in template/<path>` (the synced files are the list in `docs/standard-sync.md` of `micelio-engineering` (https://github.com/bogd3v/micelio-engineering/blob/main/docs/standard-sync.md)). "Nothing" is a valid answer; an absent section is not. -->

## Checklist

- [ ] One concern, and the commits are signed off (`git commit -s`)
- [ ] New behaviour has tests
- [ ] New and changed exports have their documentation comment
- [ ] The documents this change made false are updated (`docs/`, README, `AGENTS.md`)
- [ ] A contract change follows sections 6 and 7 of the standard (`!` in the title, a `BREAKING CHANGE:` paragraph above), and an expensive decision has an ADR
- [ ] A change to the standard raises its version and adds a line to the table of section 16
- [ ] The issue's Progress section is updated
