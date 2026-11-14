# Initial analysis: AIDLC CLI vs Collaborative UI (2026-11-14)

Repos inspected at HEAD: awslabs/aidlc-workflows (CLI, v2.11.4 / 2.11.5-preview) and aws-samples/sample-collaborative-ai-dlc (UI, v2.3.1).

## 1. Is the UI based on the CLI?
Yes. The UI imports the CLI's `core/` tree as data ("building blocks"). No methodology is hard-coded.
- Nine block types map 1:1 to CLI folders (`lambda/shared/block-mappers.js`): stages (`core/aidlc-common/stages`), agents, scopes, sensors, rules (`core/rules`), memory → rules (`core/memory/org|team|project.md`, `phases/*.md`), knowledge, skills (`core/skills/*/SKILL.md`), templates.
- SYSTEM baseline pinned by Terraform `aidlc_repo_ref`. Release pinning lets each intent pin an imported release. The supported official releases are 2.3.3, 2.6.18, 2.7.0, 2.8.2, 2.9.0, 2.11.0, 2.11.1 and 2.11.3 (`lambda/shared/aidlc-compatibility-profiles.js`). The CLI is at 2.11.4, one patch ahead.
- Agents run the real headless CLIs (Kiro, Claude Code, OpenCode, Codex) in AgentCore. Engine commands the UI can't run are handled, approximated, or refused (see `docs/concepts/aidlc-release-compatibility.md`).
- UI → CLI: you can export an intent as a native AI-DLC workspace ZIP. This is one-way.

## 2. Can CLI baselines (skills, team.md, standards) go into the UI natively?
Mostly yes, through the **custom fork release** feature:
1. Fork aidlc-workflows. Put your baselines into `core/`:
   - `core/memory/org.md` and `team.md` (org and team practices: Way of Working, Testing Posture, Code Style, Forbidden, Mandated…). From 2.11.4, team work needs a `- **Integration branch**: <name>` line under `## Way of Working`.
   - `core/rules/*.md` and `core/memory/phases/*.md` (standards)
   - `core/skills/<name>/SKILL.md`
   - `core/knowledge/<agent>/*.md` and `core/knowledge/aidlc-shared/*.md`
2. In the UI admin, register it as `owner/name` (GitHub, must be public) or `gitlab:group/project` (private allowed with a token secret), at a 40-hex SHA, naming a base dialect such as v2.11.3.
3. It imports as trust tier T0. A platform admin promotes it, and the fidelity guard refuses it if it authors behavior the runtime can't handle. It's then selectable for every space.
- Another route: fork single SYSTEM blocks in the UI block library (user copies shadow SYSTEM ids). This is manual and done by hand.

## 3. Gaps that may justify forking the UI
- Only `core/` is imported. CLI `plugins/` (e.g. test-pro) are ignored. 2.11.4 plugins can also carry house rules at the org, team or project level, and those are ignored too.
- A team's real CLI rules live in the *project repo* at `aidlc/spaces/<space>/memory/{team,project}.md`. The UI never reads those. You'd have to copy them into the fork's `core/memory`.
- A release has one org/team/project rule set, which applies to the whole deployment. I didn't find a per-space or per-team binding. Rule refs belong to the workflow.
- Private GitHub forks aren't supported (fetched from codeload without credentials).
- Learnings the UI captures (`team-learnings` / `project-learnings` via MCP) never flow back to CLI files, and export is one-way.

## 4. Round-tripping a project (UI ⇄ CLI)
Not supported today; it's a one-way trip.
- **UI → CLI:** supported. "Export workspace" produces a native AI-DLC ZIP for Claude, Codex, Kiro CLI, Kiro IDE or OpenCode. It includes state, the continuation point, artifacts, Q&A, the audit trail, the unit DAG, the pinned methodology and the custom scope. Source repos are cloned separately on the intent branches.
- **CLI → UI:** no import path. The only code that touches `aidlc/spaces/...` is the exporter (`lambda/shared/native-workspace-projector.js`). The docs say local decisions, approvals, artifacts and code are not synced back. Only code comes back, through normal git push and PRs, and the UI won't see it as AI-DLC progress.
- **Export blocked when:** the intent uses incompatible edited blocks, mixes methodology revisions, or (while running) has no completed checkpoint yet.
- **To make it two-way, a UI fork would need** a "native workspace importer" that is the reverse of the projector. See `cli-to-ui-import-design.md` in this folder.

## Candidate UI-fork features (if needed)
0. Onboard AI-DLC 2.11.4 as an official profile. This is small and a prerequisite for importing current CLI work. See the design doc, Phase 0.
1. Space-level import of `aidlc/spaces/*/memory/*.md` from the space's repo → per-space rule blocks.
2. Private GitHub fork source (GitHub App / token).
3. Import `plugins/` contributions, including plugin house rules.
4. Export UI learnings back as team.md / project.md patches (PR).
5. CLI → UI native workspace import (reverse of the export projector) for real round-tripping.
