---
inclusion: always
---

# Claude (Cowork) collaboration rules

Oscar works this repository from **multiple computers** and with **multiple AI tools** — Kiro and
Claude (Cowork) both make changes, sometimes on the same day. These rules exist so neither tool
builds on a stale tree and so each can always see what the other did.

Kiro should read this file to know what Claude will and will not do. Claude is bound by it.

## 1. Verify repo freshness before starting any work

Claude must not begin a feature or a change until it has confirmed the tree it is looking at is
current. Before the first edit of any work session:

1. `git fetch origin` and compare local `HEAD` against `origin/<branch>`.
2. Report the SHA it is working from, and say explicitly whether local is ahead, behind, or level.
3. List remote branches and note any that appeared or disappeared since the last recorded check.
4. Check for uncommitted local work before assuming the working tree is clean.
5. If local is behind, or a Kiro session is mid-flight on the same files, **stop and say so**
   rather than editing.

The last verified state is recorded at the bottom of this file. Claude updates that record each
time it checks.

## 2. Work on a separate branch

Kiro and Claude must not share a working branch. Claude branches from the current `origin/main`
(or from the branch Oscar names), and hands the branch over rather than merging it itself.
Claude does not push, merge, rebase, or delete branches unless Oscar asks in that session.

## 3. Document every change in this repository's existing structure

Claude does not invent new documentation conventions. It writes into the ones already here:

| What | Where |
|---|---|
| Standing rules and behavioural guidance | `.kiro/steering/<topic>.md`, frontmatter `inclusion: always` |
| A unit of work — requirements, design, tasks | `.kiro/specs/<kebab-case-name>/` |
| Requirements | `.kiro/specs/<name>/requirements.md` |
| Design and rationale | `.kiro/specs/<name>/design.md` |
| Task breakdown | `.kiro/specs/<name>/tasks.md` — `## Task N: … [done: false]`, `### Description`, `### Sub-tasks` with `- [ ]` |
| Defect analysis | `.kiro/specs/<name>/bugfix.md` |
| Captured proof — probes, diffs, query plans, live-vs-repo | `.kiro/specs/<name>/evidence-report.md` and `evidence/` |
| Database change | `supabase/migrations/vX.Y.Z-<slug>.sql`, with a post-condition block |
| Verification output for a migration | `supabase/verification/` |
| Release-level summary | `CHANGELOG.md`, newest at top, `# vX.Y.Z — Title` |

**`tasks.meta.json` and `.config.kiro` belong to Kiro.** Claude never writes or edits them — they
carry Kiro's own `specId`, `executionId`, and session state. Claude writes `tasks.md`; Kiro owns
the machine-readable mirror.

## 4. Attribute the work

Every file Claude creates under `.kiro/` carries a line naming Claude as the author and the date,
so a later reader can tell which tool produced it. Claude does not silently rewrite a document Kiro
authored — it appends a dated section, or writes a sibling file and links to it.

## 5. Ask before ratifying a behaviour change

When a test fails because the code deliberately changed, Claude confirms the change was intended
before updating the test. Updating an assertion is the same as approving the new behaviour, and
that approval is Oscar's to give.

---

## Last verified repository state

Claude updates this block on every freshness check.

| | |
|---|---|
| Checked | 20 August 2026, second check |
| Checked by | Claude (Cowork) |
| `origin/main` | `6460bfe4bc49aa6e88fc8ba397c61aa5b8a532f4` |
| Local `HEAD` | `main` @ `6460bfe` — level with origin |
| Remote branches | 33 |
| Previous check | `e01a030` — moved by 3 commits since |

### What moved, and why it mattered

Between the two checks `origin/main` advanced three commits, the last of which —
`6460bfe feat(specialty): open a quote in its own full-screen workspace, not a drawer` — replaced
`OpportunityDrawer.tsx` with the fifteen-file `src/features/specialty/workspace/` tree. A carrier
email feature designed against the earlier commit would have been designed against a drawer that no
longer exists. Rule 1 is not ceremony.

### Correction to the 20 August audit

The audit's closing line stated there was no uncommitted work in flight. **That was wrong.** The
comparison covered ten root configuration files only, and every one of them matched — but
`src/features/specialty/workspace/` already existed in the working tree while `e01a030` did not
contain it. Comparing root config files is not comparing the tree.

The freshness check must therefore compare `HEAD` and `ORIG_HEAD` against `origin`, and must not
infer a clean working tree from a sample of files. When in doubt, say what was actually checked
rather than characterising the tree as a whole.

*Authored by Claude (Cowork), 20 August 2026.*
