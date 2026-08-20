# Spec: Repository Health Audit

**Authored by:** Claude (Cowork), 20 August 2026
**Type:** audit — observation and remediation plan, no code changed

This folder was created by Claude, not Kiro, and follows the conventions in
`.kiro/steering/claude-collaboration.md`.

| File | Contents |
|---|---|
| `evidence-report.md` | What was observed, and how. Command results, root-cause analysis for every failure, dependency advisories, configuration gaps, and the strengths worth preserving. |
| `tasks.md` | The remediation plan. Tasks 1–3 are the agreed first three items. |

**No code has been changed.** Oscar is supplying a spec; this folder holds the findings until then.

There is deliberately no `.config.kiro` and no `tasks.meta.json` here — those carry Kiro's own
`specId` and session state, and Claude does not write them. Kiro is free to adopt this folder and
generate its own.

## The one open question

`tasks.md` Task 2 carries a decision that belongs to Oscar rather than to either tool: commit
`37b5441` granted Quote Center access to commercial agents, and that grant also makes
`editSharedDraft('commercial')` return `true`. If shared-draft editing was not intended, the fix
belongs in the permission function and not in the failing test.
