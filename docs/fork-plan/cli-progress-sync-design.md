# Design: continuous CLI progress sync (2026-11-14)

Status: approved 2026-11-14. B1 is implemented with the changes recorded in [B1 as built](#b1-as-built). It builds on the CLI re-attach import in PR #1 ([cli-to-ui-import-design.md](cli-to-ui-import-design.md)). It is the "continuous sync" item of Phase 3, which was asked for explicitly.

## Goal

While an intent runs in the UI, pick up workflow progress that someone makes in the AI-DLC CLI and pushes to a workspace repository branch. Between sequential stages, the orchestrator imports stages the CLI completed and skips them in the walk. When the CLI and the UI both worked on the same stage or artifact, the run parks on a human gate instead of choosing a winner.

Code changes travel separately, through the intent branch (PR #3 syncs that branch before each stage). This design covers workflow records only: stage state, artifacts and question answers under `aidlc/`.

## Decisions already made

| Question                | Decision                                                                                                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which branch is watched | The branch a person imports from in PR #1's dialog, when they also check **Keep syncing from this branch**. The repository and branch are stored on the intent. **Unlink** stops syncing. An intent without a link behaves exactly as it does today. |
| What is a conflict      | Since the last sync, both sides completed the same stage, or both changed the same artifact. Every sync becomes the new baseline, which replaces the export manifest as the reference point.                                                         |
| Delivery                | This document, then two PRs. **B1** delivers the branch reader, a baseline-aware planner and the import runtime command, with no orchestrator change. **B2** delivers the orchestrator step, the human gate and the UI. B2 depends on B1.            |

## Current behavior (PR #1)

- `planReattach` re-projects the intent's current records with the export manifest's settings. It refuses the import (`import_reattach_conflict`) when any projected file differs from the manifest checksum, which means any UI change since the export.
- `compareStageMarkers` compares the CLI's `aidlc-state.md` with the projected baseline. A stage that is `[x]` in the UI but not in the CLI is refused as `import_stage_regressed`.
- The browser builds the branch bundle through the project source-control API. The backend never reads the branch itself.
- The confirm path in the intents Lambda writes the records and parks the intent as FAILED with `importedContinuation`. **Continue** is a rewind.

None of this survives both sides moving, so continuous sync needs a three-way comparison.

## Three-way comparison

For every file of the intent record (the projection's `aidlc/**` paths):

| Side     | Source                                                                                   |
| -------- | ---------------------------------------------------------------------------------------- |
| **Base** | The checksum recorded at the last sync. For the first sync, this is the export manifest. |
| **UI**   | The checksum of today's projection, made with the manifest's settings.                   |
| **CLI**  | The checksum of the file on the linked branch.                                           |

How each file is classified:

| Base → UI | Base → CLI                 | Result                                                |
| --------- | -------------------------- | ----------------------------------------------------- |
| unchanged | unchanged                  | Nothing to do.                                        |
| changed   | unchanged                  | The UI owns it. Not imported, and no longer an error. |
| unchanged | changed                    | Import it, if the stage rules below allow.            |
| changed   | changed, same content      | Nothing to do. The baseline advances.                 |
| changed   | changed, different content | **Artifact conflict.**                                |

Stage markers use the same three-way logic, on `aidlc-state.md` markers instead of checksums:

- **CLI completed, UI did not:** a stage the CLI marked `[x]` that is not `[x]` in the base, and that the UI has not started (no RUNNING, WAITING or SUCCEEDED row since the base), is imported.
- **UI completed, CLI did not:** a stage the UI completed but that is still `[ ]` in the CLI is the UI's progress, not a CLI rewind. This replaces `import_stage_regressed` in sync mode.
- **Both completed:** a stage completed on both sides since the base is a **stage conflict**.

These PR #1 rules still apply in sync mode, against the base instead of the export:

- `import_stage_gap`
- `import_parallel_unsupported`: per-unit stages are still out of scope.
- `import_scope_changed`
- the intent and release mismatch checks

The PR #1 one-shot import keeps its current strict behavior. Sync mode is a separate entry point, `planSync`, that shares the parsing and location code.

## Baseline storage

A baseline is a map from path to checksum, plus each stage's marker, the branch commit SHA it was read from, and the time. The baseline can exceed a DynamoDB item (5,000 files), so it lives in S3 at `workflow-imports/<intentId>/sync-baseline.json`:

- It is written after every successful sync, and after a conflict gate is resolved.
- It is under the intents Lambda's existing `workflow-imports/` grants.
- It is removed by intent deletion, which already purges `workflow-imports/`.
- The existing 1-day expiry rule on that prefix must exclude `sync-baseline.json`. Use a separate prefix, `workflow-sync/`, or a tag-filtered rule; decide in B1.

The intent META row carries only `cliSync`:

```
cliSync: { repo, provider, branch, linkedBy, linkedAt, lastSyncedSha, lastSyncedAt }
```

If the branch head equals `lastSyncedSha`, there is nothing to do, and the read stops there.

## B1: backend sync primitive (no orchestrator change)

1. **Branch reader** (`lambda/shared/native-workspace-source.js`). It reads the workspace record from a repository branch on the backend, using the shared git providers (`getBranchHead`, `getTree`, `getFileContents`). It keeps only `export-manifest.json`, `aidlc/**` and `aidlc-docs/**`, with the same limits as the upload path (5,000 files, 50 MB, 5 MB per file). The browser's bundle builder can then call the same intents endpoint instead of assembling the bundle itself. That's optional and not required for B1.
2. **Planner** (`planSync` in `native-workspace-importer.js`). It does the three-way comparison above and returns three things: the imports, the conflicts, and the new baseline. It is pure, like `planReattach`.
3. **Runtime command `sync-cli-progress`.** It runs in the intent session, because the orchestrator has no graph access. Its steps:
   1. Read the branch (step 1). The runtime reaches the provider API with broker credentials, as the git engine does.
   2. Load the current records and the S3 baseline.
   3. Run `planSync`.
   4. If there are no conflicts, write the imports with the PR #1 writer (`cli-import` provenance, artifact versions, gate answers) and store the new baseline.
   5. Return `{ imported: [stageId], conflicts: [...], continuation, headSha }`.
   6. It is idempotent per `headSha`. A replayed call with the same SHA and baseline writes nothing new.
4. **Credential broker: security-relevant change.** Today `executionIncludesRepository` allows only `META.repos`. B1 also allows **read** access to `META.cliSync.repo`, only while the binding is active and the execution is CREATED or RUNNING. Write access stays limited to `META.repos`. Tests cover denial for an unlinked repository and for write access.
5. **Link and unlink.** The PR #1 import endpoint accepts `keepSyncing: true` for a branch source. It records `cliSync` and writes the first baseline from the imported state. `DELETE .../cli-sync` unlinks it. Any project member can do either, the same as for import.

B1 is usable on its own: a person imports with **Keep syncing**, and the next import from the same branch uses the baseline. Nothing runs automatically until B2.

### B1 as built

Implementation found three things the plan above did not account for. These decisions were made during B1, on 2026-11-14 and 2026-11-15.

1. **The runtime command moved to its own PR, before B2.** `sync-cli-progress` cannot run in the runtime as planned, for three reasons:
   - The projection (`buildNativeProjection`, `loadNativeExportPlan`, distribution alignment) and the PR #1 writer live in `lambda/intents`, which `lambda/agentcore` may not import.
   - With `enable_engine_data`, the runtime has no allowlisted operations for artifact creation, gate answers, the S3 baseline or the distribution read.
   - The broker returns a git credential. For CodeCommit, that is not a provider API credential.

   B1 therefore runs sync in the intents import endpoint, which already has the graph, the S3 grants and the writer. The runtime-command PR moves the projection and the writer into `lambda/shared` and adds the engine-data operations, with its own design addendum.

2. **The branch is read through the source-control Lambda.** `readWorkspaceBranch` (`lambda/shared/native-workspace-source.js`) takes a shared-git-provider shape. The intents Lambda backs it with the source-control Lambda's `operate` action, which checks that the repository is attached to the project and resolves the binding's own read credential. B1 adds a read-only `branch-head` operation there. This works for every provider, and no credential reaches the intents Lambda. The browser no longer builds the branch bundle; the JSON bundle upload stays supported.
3. **The broker read rule is narrower than planned.** `resolveBindingCredential` narrows `read` only for GitHub App and CodeCommit role bindings. A delegated OAuth token is the same token for read and write. The broker therefore issues a linked-repository read credential only through those two binding types, and refuses the others with `OPERATION_NOT_ALLOWED`. B2's automatic sync through the broker is limited to GitHub App and CodeCommit until OAuth reads can be narrowed.

Other details fixed in B1:

- **Baseline storage:**
  - Each baseline is a new object at `workflow-sync/<intentId>/<baselineId>.json`, and `META.cliSync.baselineId` names the current one.
  - A sync writes the next object first and switches the id in the same META update that records the import. A failure before that switch leaves the previous baseline in effect. The previous object is then deleted best effort.
  - A separate prefix was chosen over a tag-filtered rule. A prefix lifecycle filter cannot exclude one key, and tagging would change the PR #1 presigned upload. The `workflow-sync/` rule expires only superseded versions (after one day) and expired delete markers.
- **The baseline is the common ancestor.** It advances for a path or a stage only where the UI and the branch agree after the sync. A change made on one side leaves it in place, so a later change on the other side is still a conflict. A stage in conflict keeps its ancestor marker.
- **"The UI started the stage since the base"** cannot be read from markers, because `-` is positional. The baseline records each stage row's `state@startedAt`. A RUNNING or WAITING_FOR_HUMAN row whose signature differs from the baseline counts as started.
- **The plan clock for a branch:** a branch has no upload time. The preview fixes `plannedAt`, the confirm repeats it within 15 minutes, and the plan token binds `plannedAt`, `headSha` and `keepSyncing`.
- **A link or sync that brings no records** stores the baseline and leaves the run alone. Only an import that writes records retires the run, as in PR #1.
- **Refusals in sync mode:**
  - `import_sync_linked` for any other source while linked.
  - `import_sync_invalid` for Keep syncing without a branch, or while already linked.
  - `import_sync_conflict` on a confirm that has conflicts.
  - `import_sync_baseline_invalid` when the baseline is missing.

## B2: orchestrator step, gate and UI

1. **When:** before each sequential (once-per-workflow) stage in the walk, when `META.cliSync` is set. It never runs inside a parallel section, and never for per-unit stages.
2. **Replay compatibility:**
   - The step is `cli-sync-<stageId><suffix>`, a durable `ctx.step` that invokes `sync-cli-progress`.
   - It runs only when the run's claim carries `cliSyncMode: 'v1'`, memoized at claim time, which is the same pattern as `initWsMode`.
   - Runs claimed before B2 deploys have no flag, so their step order is unchanged.
   - Linking while a run is in progress takes effect at the next claim (resume, rewind or retry). The banner says so.
3. **Imported stages:** the step's memoized result lists the imported stage IDs. The walk passes over them the way it passes over `dynamicSkipIds`, with a SUCCEEDED row written by the import (not SKIPPED) and a `v2.cli.synced` timeline event. If the next stage is one the import completed, the walk moves on without dispatching it.
4. **Conflict:**
   - The step opens an engine gate, a new kind `cli-sync-conflict`, that lists the conflicted stages and artifacts with both versions linked.
   - The gate has two answers:
     - **Keep the UI's work:** advance the baseline past the conflicted items without importing them, then continue.
     - **Stop the run:** cancel, so the person can reconcile by exporting and importing again.
   - "Take the CLI's version" is left out of v1. It would need a rewind of the conflicted UI stages, and that is a larger change; the doc tracks it as a follow-up.
   - The gate parks META WAITING, so PR #3's **Sync branch now** and the normal resume path apply.
5. **Failures:**
   - A read or credential failure records `v2.cli.sync_failed` and the walk continues. A sync outage must not block the run, which is the same policy as PR #3's fetch failure.
   - A write that fails part-way fails the stage with `cli_sync_failed`. As in PR #1, rewinding to the earliest imported stage recovers it.
6. **UI:**
   - The import dialog gets the **Keep syncing from this branch** checkbox.
   - The intent header shows a "Syncing CLI progress from `<repo>@<branch>`" badge, with **Unlink** in Intent actions.
   - The timeline shows the new events.
   - The conflict gate renders in the existing gate card.

## Risks and open items

- **Credential scope:** the broker change in B1-4 widens what a runtime session can read. It is read-only and limited to the one linked repository, which a project member chose. This needs an explicit security review in the PR.
- **Plan drift:** a CLI that changed scope (EXECUTE/SKIP) or the release still refuses, as in PR #1. Sync then reports `v2.cli.sync_failed` with the refusal code on every stage until someone unlinks or fixes the branch. B2 should emit this once per head SHA, not once per stage.
- **Cost:** a read per stage is one branch-head call when nothing changed, and a tree read plus file reads when the branch moved. Rate limits are not a concern at stage frequency.
- **Construction units:** still out of scope, as in PR #1. That is Phase 2 work ("parallel units").
- **Writing back to the CLI** (UI progress pushed to the workspace branch) is out of scope. That is Phase 3's "UI learnings written back as a PR".
- **Verification:**
  - B1: unit tests for `planSync` on every row of both tables above, broker allow and deny tests, and command idempotency on a replayed `headSha`.
  - B2: orchestrator replay tests showing that a run claimed without `cliSyncMode` keeps its exact step names, and a deployed-stack check with a real workspace repository.
