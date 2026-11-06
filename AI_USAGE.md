# AI usage

ETHGlobal asks projects to say where AI was used, by file or part.

## Summary

Claude Code (Opus 5.5) wrote almost all of the code in this repository, following a plan and design decisions made with the team.
A second Claude session reviewed the code independently.

## By part

| Part | AI use |
|---|---|
| `contracts/` | Written by AI |
| `packages/shared/`, `apps/verifier/`, `apps/api/`, `apps/agent/`, `apps/mcp/`, `apps/mock-world/` | Written by AI |
| `cre/attest/` | Written by AI |
| `apps/web/`, `apps/site/`, including copy | Written by AI |
| Tests | Written by AI |
| `README.md`, `FEEDBACK.md`, this file | Drafted by AI |
| `docs/WORLD_DEBRIEF.md` | Facts drafted by AI. The team must complete it from their own integration |

## At runtime

Verifiers can call model providers to explain a decision or veto it.
Fixed rules decide, and a model can never approve anything.

## What people did

<!-- Fill this in truthfully before submitting. List who made which decisions, what you reviewed and what you changed. -->
