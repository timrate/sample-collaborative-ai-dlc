@AGENTS.md

# Fork context: CLI ⇄ UI round-tripping

This is a fork of `aws-samples/sample-collaborative-ai-dlc` (the "UI"). It adds features so teams can author AI-DLC baselines (skills, `team.md`, standards) in the CLI (`awslabs/aidlc-workflows`) and move projects in both directions between the CLI and the UI.

Read these before starting any phase:
- `docs/fork-plan/initial-analysis.md`: how the UI consumes the CLI, what's already possible, and the gaps.
- `docs/fork-plan/cli-to-ui-import-design.md`: the import design, the file mapping, risks, and the phased plan (Phase 0–3).

`AGENTS.md` (imported above) is the authoritative repo guidance: project map, contracts, validation and PR standards. If it conflicts with this file, follow `AGENTS.md`.

## Working rules for this fork
- **One phase per session, one PR per phase.** Don't mix phases.
- **Write upstream-quality changes.** We intend to offer them back to `aws-samples` as PRs. Follow `AGENTS.md` "PR review standard" and `.github/pull_request_template.md`. Keep diffs focused, and don't refactor unrelated code.
- **Test first where possible.** For the importer, the round-trip golden test (export → import → export, byte-stable) comes before implementation.
- **Report verification honestly.** Say what ran, what passed, and what couldn't be checked. Deployed-stack validation (Neptune, AgentCore, orchestrator) is done by a human in a dev AWS deployment.

## Validation quick reference
- Setup: Node 22 or 24. Run `npm ci` and `npm --prefix frontend ci`.
- Offline release/compatibility suite (no Docker, AWS or network needed): `npm run test:aidlc-compatibility`.
- Backend project tests: `npx vitest run --project=<name>`, e.g. `shared`, `intents`, `agentcore`. These need a running Docker daemon (Gremlin and DynamoDB Local via Testcontainers).
- Always: `npm run lint`, `npm run format:check`, `npm run secretlint`. For backend module changes, also `npm run dep:check`.
- Frontend: `npm --prefix frontend test` and `npm --prefix frontend run build`.
- Docs: `uv sync --group docs && uv run zensical build`.

## Current task: Phase 0, support AI-DLC 2.11.4
Upstream `awslabs/aidlc-workflows` tag `v2.11.4` is at commit `61fdb122428d86b56b7e8d598787095f2c97d3e1` (2026-11-13). The newest profile here is `v2.11.3` at `63fd2901947ece8c5ad0cd831cdf5934a9666d47`.

Use upstream commit `d6c737e` ("feat(releases): support AI-DLC 2.11.3…") as the pattern. Only follow its release-support parts; it also bundled unrelated UI work.

1. Add a `v2.11.4` entry to `lambda/shared/aidlc-compatibility-profiles.js`: `releaseId: 'aidlc:61fdb122428d86b56b7e8d598787095f2c97d3e1'`, `frontmatterDialect: 'invoke-template-v1'`, `trustTier: 'T1'`, `compatibilityStatus: 'candidate'`, `upstreamChannel: 'stable'`. Write a comment explaining the differences from 2.11.3, the way the other entries do.
2. Generate the fixture with `npm run aidlc:compatibility:snapshot`. It fetches the pinned SHAs from GitHub, so it needs network. That writes `lambda/shared/test/fixtures/aidlc-compatibility/v2.11.4.json`. Set `fixtureDigest` from the output.
3. Run `npm run test:aidlc-compatibility` and fix or regenerate goldens. Expect the `infra` scope plan to change from 13 to 15 stages, because it adds Code Generation and Build and Test.
4. Check the importer for YAML quirks in the new sources. 2.11.3 needed a quoting fix, under "importer revision 4". If the mapper changes, bump the importer revision per `docs/concepts/aidlc-release-compatibility.md`.
5. Confirm that no new `{{INVOKE}} engine …` commands reach prompts. A pre-check found none and no new frontmatter keys. Confirm that the promotion guard reports no new gaps.
6. Investigate the Kiro harness rename. In CLI 2.11.4, `--harness kiro` means Kiro IDE plus Kiro CLI v3, and `kiro-v2` means Kiro CLI on the V2 engine. The `harness/` folder names are unchanged. Check `lambda/intents/native-export.js` (`HARNESS_DATA_DIRS`, `HARNESS_SESSION_COMMANDS`) and the AgentCore Kiro invocation. Document the decision in the PR; fix it only if it's clearly broken.
7. Add an "AI-DLC 2.11.4" section to `docs/concepts/aidlc-release-compatibility.md`, update the supported-version lists wherever they appear, and add a CHANGELOG entry.
8. Open a PR to this fork. The PR should list the verification done and what needs a human in a dev deployment: import, promote to selectable, and one smoke intent per scope family.

Other 2.11.4 changes worth noting in the docs:
- Team work reads the integration branch only from a `- **Integration branch**: <name>` line under `## Way of Working`.
- There's a new `core/skills/aidlc-issue-report` skill.
- 2.11.3 and 2.11.4 interoperate for team-owned Units.

## Later phases (don't start without being asked)
1. CLI → UI round-trip MVP: re-attach an exported intent, sequential stages only.
2. Fresh CLI workspaces as new intents, parallel units, and space memory sync (team.md, project.md and phases from `aidlc/spaces/<space>/memory/`).
3. Traceability edges, continuous sync, and UI learnings written back as a PR.

See the design doc for details.
