# Archive — superseded specifications

**Nothing in this directory is current.** These are kept as the record of what
was intended, and why, in August 2026 — before the decisions that changed it.

| file | what it is |
|---|---|
| `OpenWorld Asset System.pdf` | the data model, stages, roles and security rules |
| `OpenWorld Asset Repository & Development System.pdf` | the repository, versioning and game-build model |
| `OpenWorld Asset Library.pdf` | the library, the five stages, and the "publishing does not put it in the game" rule |

**They were archived on 2026-10-23 for one reason: they cannot be corrected.**
They are binary, the decisions that superseded them are in `website/TODO`, and a
document that cannot take a correction will keep being read as if it were
current.

## Where to look instead

- **`docs/SPEC.md`** — what is. The current truth, every section marked by its
  state, and §15 is a table of every place these PDFs no longer hold.
- **`website/TODO`** — why. The decisions, the alternatives rejected, and the
  mistakes.

## Still worth reading them for

They contain detail that has **not yet been migrated** into `SPEC.md` — the
build and branch tables, the security invariants, the full pipeline sketches.
Until that migration is finished, these files are the only record of it. They
are the source, not the authority.

**Do not quote them as current.** If a sentence here matters, check `SPEC.md`
first; if it is not there, it is either unbuilt or unrecorded, and the TODO will
say which.
