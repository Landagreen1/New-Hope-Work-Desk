# Kiro Execution Prompt

Implement `.kiro/specs/policy-follow-up-assignment-workflow`.

Treat this as an incremental integration/hardening pass over the existing Renewals and Cancellations modules. Do not rebuild either module and do not rebuild the desktop carrier collectors inside Work Desk.

Before coding:
1. read `requirements.md`, `design.md`, and `tasks.md` in this spec;
2. read the current `.kiro` specs for cancellations hardening, renewals/cancellations, and renewal SMS;
3. inspect the current implementation and mark already-satisfied tasks instead of duplicating them;
4. run baseline typecheck/tests/lint/build and separate pre-existing failures from new failures.

Important product rules:
- raw Spanish collector values are audit data; agents work from normalized operational terms;
- assignment is stable at carrier + normalized policy level, not per CSV row;
- precedence is manager lock -> existing owner -> existing domain owner/bootstrap -> producer mapping -> weighted workload -> manager review;
- weighted balancing assigns only unowned work and never continuously rebalances existing work;
- same policy should normally have one owner across Renewal and Cancellation;
- uncertain customer/policy matches import but are review/communication blocked;
- `No renueva` means Carrier Non-Renewal / Requote Required, not Lost;
- cancellation absence from later files is never an outcome;
- agents need one obvious Next Action, not raw source fields;
- managers need full-population risk/workload visibility, not counters computed from only the rendered page window;
- preserve the current cancellation action/communication/payment/verification/suppression engines;
- fix the current renewal list-level empty contact-index behavior using a bulk contact summary read;
- do not change quote queue rotations, turn positions, attendance-driven queue state, or unrelated modules;
- do not commit real customer CSVs or PII;
- do not turn on automatic customer messaging as part of this work.

Implement migrations forward-only. Preserve production data and current manual assignments. Where existing renewal and cancellation owners conflict for the same policy during bootstrap, surface a manager conflict instead of guessing.

Finish with exact test/build results, files changed, migrations in order, deployment steps, and a manager acceptance checklist covering import -> assignment -> My Work -> follow-up -> reimport -> manager overview.
