# Design sketch: CLI → UI import for Collaborative AI-DLC (2026-11-14)

Goal: make a project round-trip, UI → CLI (exists today) → UI (new). Also pull CLI `team.md` / `project.md` into a space.

License: MIT No Attribution. We can fork, modify and redistribute freely. It's worth offering the result upstream as a PR so we aren't stuck maintaining a fork.

## What already exists to build on
| Piece | Where | Why it matters |
|---|---|---|
| Exporter (UI → CLI) | `lambda/shared/native-workspace-projector.js` (projection), `lambda/intents/native-export.js` (ZIP and S3), `lambda/intents/index.js` ~L2080–2200 (loads the data) | It defines the exact file mapping. The importer is its inverse, and the projector's tests become round-trip fixtures. |
| Data the exporter reads | execution META, stage rows, human tasks (Q&A and gates), unit plan and unit rows (DynamoDB, via `store.getExecutionRecords`); artifacts (Neptune `fetchArtifacts`); custom rules (S3) | These are the same stores the importer must write to. |
| Rewind / relaunch | `POST /projects/{p}/intents/{i}/rewind` (`intents/index.js` ~L5017); orchestrator guard `rewind_upstream_incomplete` (`v2-orchestrator/index.js` ~L930) | Rewind already resumes at any stage, as long as every earlier stage row is `SUCCEEDED` or `SKIPPED` (per unit for parallel sections). The importer seeds those rows and then relaunches through this path, with no new orchestrator logic. |
| Graph writer with provenance | `lambda/shared/mcp/graph-writer.js` | It writes typed, provenance-stamped artifacts and learning rules (`team-learnings` / `project-learnings`). |
| CLI state is in git | CLI `docs/guide/03-spaces-and-intents.md`: `aidlc/` is committed (only cursors and sessions are gitignored) | The UI can read a CLI run straight from the space's repo branch, with no ZIP upload. |

## CLI workspace → UI mapping (the inverse of the projector)
| CLI file | UI target |
|---|---|
| `aidlc/spaces/<s>/intents/intents.json` (uuid, scope, repos, status) | intent META. A uuid that matches an existing intent means re-attach. |
| `<record>/aidlc-state.md` (scope, phase, stage checkboxes, project type, next unit) | stage rows `SUCCEEDED` / `SKIPPED` / pending; continuation stage |
| `<record>/<phase>/<stage>/*.md`, `construction/<unit>/...` | Neptune artifacts, with provenance `imported-from-cli@<commit>` |
| question files (`[Answer]:` blocks) | human tasks, answered |
| unit DAG block | unit plan and unit rows (completed units = merged) |
| audit shards, runtime graph | timeline events. Optionally, traceability edges. |
| `aidlc/spaces/<s>/memory/team.md`, `project.md`, `phases/*.md` | space-scoped rule blocks or learning rules (fixes the earlier gap) |
| methodology version (CLI tag / commit) | a release pin. It must match a registered, runnable release or promoted fork. |

## Import flow
1. **Source.** Pick a space repo and branch, which reads `aidlc/` via the existing GitHub/GitLab/Bitbucket integration. An uploaded ZIP is the fallback.
2. **Parse and validate** (dry run, nothing written):
   - The release resolves to a runnable pin.
   - The scope and stages exist in that release's plan.
   - Every stage is at a boundary, with no half-finished stage.
   - Completed units are merged into the intent branch.
   - Show a preview: N stages done, continuing at X, warnings.
3. **Choose mode.**
   - **Re-attach.** `export-manifest.json` / intents.json uuid matches an intent that hasn't advanced since export (compare the export snapshot token). Append the CLI progress to that intent.
   - **New intent.** This is the default for fresh CLI work, or when the original moved on.
4. **Write.** Do it in one guarded transaction-ish sequence (a CAS on META, the same discipline as /start and /rewind):
   - artifacts to Neptune
   - stage, human-task and unit rows to DynamoDB
   - an `IMPORTED` timeline event
   - memory to space rules
5. **Park or relaunch.** The intent lands parked at the continuation stage. A member clicks Continue, which calls the rewind/relaunch path.

## Hard parts and risks
- **Version skew.** The CLI moves fast. Today the UI supports official releases 2.3.3, 2.6.18, 2.7.0, 2.8.2, 2.9.0, 2.11.0, 2.11.1 and 2.11.3. The CLI is on 2.11.4. A CLI run on an unregistered version needs a matching release first, or gets refused. See Phase 0.
- **Edited blocks and custom scopes.** The CLI may author scopes or stages that the UI workflow lacks. Map to the release closure, or synthesize an intent-level custom scope the way export registers one in reverse.
- **Parallel construction.** Unit lanes, unit branches and merge state must line up exactly, or the orchestrator raises `unit_not_found` / `rewind_upstream_incomplete`. Phase 1 should restrict imports to boundaries outside an unfinished parallel section.
- **Trust.** Imported artifacts and Q&A were not produced or approved under UI governance. Stamp the provenance, show it in the UI, and optionally require a human "accept import" gate.
- **Traceability fidelity.** The CLI runtime graph to Neptune edges is lossy at first. Accept artifact-level provenance in phase 1.
- **Conflicts on re-attach.** If both sides moved, refuse and offer "import as new intent".

## Phased plan
- **Phase 0, onboard AI-DLC 2.11.4 (separate, small PR; do first).** See the section below.
- **Phase 1, round-trip MVP.** Re-attach for intents that were exported from the UI. Sequential stages only. Source: repo branch or ZIP. Uses the projector's fixtures as golden tests (export → import → export again should be byte-stable).
- **Phase 2.** Fresh CLI workspaces as new intents. Parallel sections with completed units. Space memory sync for team.md / project.md / phases.
- **Phase 3.** Traceability edges from the runtime graph. Optional continuous sync, so the UI watches the branch and offers an import when `aidlc/` changes. UI learnings written back as a PR to `memory/*.md`.

## Phase 0: onboarding AI-DLC 2.11.4
Upstream tag v2.11.4 is at commit `61fdb122428d86b56b7e8d598787095f2c97d3e1` (released 2026-11-13). The UI's newest profile is v2.11.3, at `63fd2901947ece8c5ad0cd831cdf5934a9666d47`.

Diff of the prompt-facing `core/` (stages, protocols, scopes, memory, agents, sensors, knowledge, skills) between the two:
- **No new `{{INVOKE}} engine …` commands** in prompt bodies, so the annex and the promotion guard need no new rows.
- **No new frontmatter keys** in stages, scopes, agents or sensors. It keeps the `invoke-template-v1` dialect.
- About 79 prompt-facing files changed: 20 stage bodies, 11 protocols, the composer and delivery agents, shared knowledge, and the traceability sensor. Most of the 190 changed `core/` files are CLI engine tooling that the UI doesn't run.
- **Scope plan change:** `infra` goes from 13 to 15 stages (it adds Code Generation and Build and Test). New plan digest goldens are needed.
- **Memory semantics:** team work reads the integration branch only from a `- **Integration branch**: <name>` line under `## Way of Working`. This matters for the team.md baselines we plan to author. `org.md`, `team.md` and `project.md` changed slightly.
- **New skill:** `core/skills/aidlc-issue-report` maps to a SKILL block.
- **Kiro harness rename (CLI 2.11.4):** `--harness kiro` now means Kiro IDE plus Kiro CLI v3, and `kiro-v2` means Kiro CLI on its V2 engine. The `harness/` folder names are unchanged. To verify: the UI's export option "Kiro CLI" (`kiro`) and the AgentCore Kiro CLI invocation still match the 2.11.4 meaning.
- Team-owned Units: 2.11.3 and 2.11.4 interoperate. 2.11.2 and earlier can't merge their Units.

Work items, following the pattern of upstream commit d6c737e "support AI-DLC 2.11.3":
1. Add a `v2.11.4` entry to `lambda/shared/aidlc-compatibility-profiles.js` (releaseId `aidlc:61fdb12…`, dialect `invoke-template-v1`, T1, candidate).
2. Add a compatibility fixture `lambda/shared/test/fixtures/aidlc-compatibility/v2.11.4.json` plus the fixture digest (generate it with `npm run aidlc:compatibility:snapshot`). Run `npm run test:aidlc-compatibility`. Update the plan-digest and catalog goldens (infra scope).
3. Check the importer for YAML quirks (2.11.3 needed a quoting fix for Requirements Analysis), and bump the importer revision if the mapper changes.
4. Make the Kiro harness mapping decision for export and runtime.
5. Add a "2.11.4" section in `docs/concepts/aidlc-release-compatibility.md` and update the CHANGELOG.
6. Do an admin import, then promote to `selectable` in a dev deployment, then do a smoke intent per scope family.

Effort estimate: small to medium (days, not weeks), mostly fixtures, goldens and verification. Consider asking upstream first, since the UI ships often (v2.3.0 and v2.3.1 on 2026-11-13), and a 2.11.4 profile may already be in progress.

## Rough component list for the fork
- `lambda/shared/native-workspace-importer.js`: a pure parser and mapper, the mirror of the projector, unit-testable.
- `lambda/intents/native-import.js`: the handler. It fetches the source, validates, writes the stores, and returns a preview or the result.
- API routes: `POST /projects/{p}/intents/import` (`?dryRun=true`) and `POST /projects/{p}/intents/{i}/import` (re-attach).
- Frontend: an "Import from CLI" dialog (pick repo/branch/record, preview, confirm), next to the existing export control.
- Tests: round-trip goldens, plus the compatibility fixtures in `lambda/shared/test/fixtures/aidlc-compatibility/`.
