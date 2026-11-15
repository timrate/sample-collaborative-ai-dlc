// Native AI-DLC workspace importer: the inverse of native-workspace-projector.
//
// Phase 1 supports re-attaching a workspace that the UI exported, after the
// CLI advanced it through sequential stages. The importer never rebuilds UI
// records from the files alone. It computes a delta against the intent's
// current records:
//
//  1. The export manifest names the source intent, release, harness and
//     layout, and records a sha256 for every exported file.
//  2. Re-projecting the current records with those settings must reproduce
//     the manifest checksums. Otherwise the UI moved on since the export and
//     re-attach is refused.
//  3. Stages the CLI marked complete ([x]) become stage completions. Their
//     changed outputs become artifact writes, and their pending gates are
//     answered (questions) or resolved (other gates).
//
// The functions here are pure: the intents handler loads the records,
// validates the request and writes the stores.

import { createHash } from 'node:crypto';
import {
  artifactPath,
  projectNativeWorkspace,
  renderQuestionFile,
  slugify,
} from './native-workspace-projector.js';

const IMPORT_ERROR_PREFIX = 'native-import: ';
const DONE_MARKERS = new Set(['x', 'S']);
const STAGE_MARKERS = new Set([' ', 'x', '-', '?', 'R', 'S']);
const ROOT_RECORD_FILES = new Set(['aidlc-state.md', 'runtime-graph.json']);

const sha256 = (body) => createHash('sha256').update(body).digest('hex');

const importError = (code, message) =>
  Object.assign(new Error(`${IMPORT_ERROR_PREFIX}${message}`), { code });

const toText = (body) =>
  typeof body === 'string' ? body : Buffer.from(body ?? '').toString('utf8');

const normalizeLineEndings = (text) => text.replace(/\r\n/g, '\n');

const safeWorkspacePath = (value) => {
  const path = String(value ?? '').replaceAll('\\', '/');
  if (
    !path ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw importError('import_unsafe_path', `unsafe workspace path ${JSON.stringify(value)}`);
  }
  return path;
};

const normalizeFiles = (files) => {
  const entries = files instanceof Map ? [...files] : Object.entries(files ?? {});
  const normalized = new Map();
  for (const [path, body] of entries) {
    const safe = safeWorkspacePath(path);
    if (normalized.has(safe)) throw importError('import_unsafe_path', `duplicate path ${safe}`);
    normalized.set(safe, toText(body));
  }
  return normalized;
};

const parseJson = (text, path) => {
  try {
    return JSON.parse(text);
  } catch {
    throw importError('import_manifest_invalid', `${path} is not valid JSON`);
  }
};

const parseManifest = (files) => {
  const body = files.get('export-manifest.json');
  if (body == null) {
    throw importError(
      'import_manifest_invalid',
      'export-manifest.json is missing; only workspaces exported from this platform can be re-attached',
    );
  }
  const manifest = parseJson(body, 'export-manifest.json');
  const valid =
    manifest?.schemaVersion === 1 &&
    manifest.mode === 'workflow-continuation' &&
    typeof manifest.exportedAt === 'string' &&
    typeof manifest.source?.intentId === 'string' &&
    typeof manifest.native?.upstreamRef === 'string' &&
    typeof manifest.native?.harness === 'string' &&
    ['spaces', 'flat'].includes(manifest.native?.workspaceLayout) &&
    Array.isArray(manifest.files);
  if (!valid) {
    throw importError('import_manifest_invalid', 'export-manifest.json is not a supported export');
  }
  return manifest;
};

// `## Stage Progress` lines: `- [<marker>] <stage-id> — EXECUTE|SKIP`.
const parseStageMarkers = (stateText) => {
  const markers = new Map();
  let inProgress = false;
  for (const line of normalizeLineEndings(stateText).split('\n')) {
    if (line.startsWith('## ')) {
      inProgress = line.trim() === '## Stage Progress';
      continue;
    }
    if (!inProgress) continue;
    const match = line.match(/^- \[(.)\] ([A-Za-z0-9._-]+)(?:\s|$)/);
    if (!match) continue;
    const [, marker, stageId] = match;
    if (!STAGE_MARKERS.has(marker)) {
      throw importError('import_state_invalid', `stage ${stageId} has unknown marker [${marker}]`);
    }
    if (markers.has(stageId)) {
      throw importError('import_state_invalid', `stage ${stageId} appears twice in the state file`);
    }
    markers.set(stageId, marker);
  }
  return markers;
};

const parseRuntimeGraph = (text) => {
  if (text == null) return new Map();
  let graph;
  try {
    graph = JSON.parse(text);
  } catch {
    return new Map();
  }
  return new Map(
    (Array.isArray(graph?.stages) ? graph.stages : [])
      .filter((stage) => typeof stage?.stage_slug === 'string')
      .map((stage) => [stage.stage_slug, stage]),
  );
};

// Question files: `## Q<n>. <text>` sections, each with one `[Answer]:` line.
const parseQuestionAnswers = (text) => {
  const sections = [];
  for (const line of normalizeLineEndings(text).split('\n')) {
    if (/^## Q\d+\./.test(line)) {
      sections.push({ answer: null });
      continue;
    }
    const answer = line.match(/^\[Answer\]:(.*)$/);
    if (answer && sections.length > 0 && sections.at(-1).answer === null) {
      sections.at(-1).answer = answer[1].trim();
    }
  }
  return sections.map((section) => section.answer ?? '');
};

const optionLetter = (index) => String.fromCharCode(65 + index);
const flatten = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

// Inverse of the projector's answer rendering: `A. Label, B. Label; free
// text`, `X. free text`, or the bare letters CLI users often type (`B`,
// `A, C`). Anything else is kept as free text.
const parseAnswer = (text, question) => {
  const value = String(text ?? '').trim();
  if (!value) return null;
  if (/^X\.\s/.test(value)) return { selectedOptions: [], freeText: value.slice(2).trim() };
  const options = Array.isArray(question?.options) ? question.options : [];
  const tokens = options
    .flatMap((option, index) => {
      const letter = optionLetter(index);
      const label = flatten(option?.label);
      return [label ? { index, token: `${letter}. ${label}` } : null, { index, token: letter }];
    })
    .filter(Boolean)
    .toSorted((left, right) => right.token.length - left.token.length);
  const selectedOptions = [];
  let rest = value;
  while (rest) {
    const match = tokens.find(
      ({ token }) => rest.startsWith(token) && ['', ',', ';'].includes(rest.charAt(token.length)),
    );
    if (!match) return { selectedOptions: [], freeText: value };
    selectedOptions.push(match.index);
    rest = rest.slice(match.token.length);
    if (rest.startsWith(';')) {
      return { selectedOptions, freeText: rest.slice(1).trim() };
    }
    if (rest.startsWith(',')) rest = rest.slice(1).trimStart();
  }
  return { selectedOptions, freeText: '' };
};

const parseQuestions = (value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const recordRootFor = (manifest) => {
  if (manifest.native.workspaceLayout === 'flat') return { space: null, path: 'aidlc-docs' };
  const { space, recordDir } = manifest.native;
  if (!space || !recordDir) {
    throw importError('import_manifest_invalid', 'the export manifest has no space record');
  }
  return {
    space: safeWorkspacePath(space),
    path: `aidlc/spaces/${safeWorkspacePath(space)}/intents/${safeWorkspacePath(recordDir)}`,
  };
};

// Locate a new file (one no current artifact projects to) in the native
// layout: `<root>/<phase>/<stage>/<name>.md`, `<root>/construction/<unit>/
// <stage>/<name>.md`, or `aidlc/spaces/<space>/codekb/<repo>/<name>.md`.
const locateFile = ({ path, recordRoot, stageById, repositories }) => {
  if (!path.endsWith('.md')) return null;
  if (recordRoot.space) {
    const codekb = `aidlc/spaces/${recordRoot.space}/codekb/`;
    if (path.startsWith(codekb)) {
      const parts = path.slice(codekb.length).split('/');
      const repository = repositories.find((repo) => repo.directory === parts[0]);
      if (parts.length !== 2 || !repository || !stageById.has('reverse-engineering')) return null;
      return {
        stageId: 'reverse-engineering',
        name: parts[1].slice(0, -3),
        unitSlug: null,
        repository: repository.id,
      };
    }
  }
  if (!path.startsWith(`${recordRoot.path}/`)) return null;
  const parts = path.slice(recordRoot.path.length + 1).split('/');
  if (parts.length === 3 && stageById.get(parts[1])?.phase === parts[0]) {
    return { stageId: parts[1], name: parts[2].slice(0, -3), unitSlug: null, repository: null };
  }
  if (parts.length === 4 && parts[0] === 'construction' && stageById.has(parts[2])) {
    return { stageId: parts[2], name: parts[3].slice(0, -3), unitSlug: parts[1], repository: null };
  }
  return null;
};

const stageRowFor = (stageRows, stageId) =>
  stageRows.find((row) => row?.stageId === stageId && !row.unitSlug) ?? null;

const isPerUnitStage = (stage) =>
  stage.forEach === 'unit-of-work' || (stage.parallelSection ?? null) !== null;

// Re-project the current records the way the export did, so the importer
// can tell UI-owned changes (conflict) from CLI-owned changes (import).
const projectBaseline = ({ current, manifest }) =>
  projectNativeWorkspace({
    ...current,
    now: manifest.exportedAt,
    upstreamRef: manifest.native.upstreamRef,
    harness: manifest.native.harness,
    workspaceLayout: manifest.native.workspaceLayout,
    space: manifest.native.space ?? 'default',
  });

const assertUnchangedSinceExport = ({ baseline, manifest }) => {
  const exported = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  const moved = [...baseline.files]
    .filter(([path]) => path !== 'export-manifest.json')
    .filter(([path, body]) => exported.get(path) !== sha256(body))
    .map(([path]) => path);
  if (moved.length > 0) {
    throw importError(
      'import_reattach_conflict',
      `the intent changed in the UI after this workspace was exported (${moved.length} file(s) differ, e.g. ${moved[0]}); import it as a new intent instead`,
    );
  }
};

const assertStagesMatchPlan = ({ stages, incoming }) => {
  const planned = new Set(stages.map((stage) => stage.stageId));
  const unknown = [...incoming.keys()].filter((stageId) => !planned.has(stageId));
  const missing = [...planned].filter((stageId) => !incoming.has(stageId));
  if (unknown.length > 0 || missing.length > 0) {
    throw importError(
      'import_state_invalid',
      `the state file's stages differ from the intent's plan (missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'})`,
    );
  }
};

const compareStageMarkers = ({ stages, baselineStages, incoming }) => {
  const baselineMarker = new Map(baselineStages.map((stage) => [stage.stageId, stage.marker]));
  assertStagesMatchPlan({ stages, incoming });
  const newlyCompleted = [];
  let firstUnfinished = null;
  for (const stage of stages) {
    const before = baselineMarker.get(stage.stageId);
    const after = incoming.get(stage.stageId);
    if (before === 'x' && after !== 'x') {
      throw importError(
        'import_stage_regressed',
        `stage ${stage.stageId} was complete at export but is [${after}] in the CLI workspace; rewinds are not imported`,
      );
    }
    if ((before === 'S') !== (after === 'S')) {
      throw importError(
        'import_scope_changed',
        `stage ${stage.stageId} changed between EXECUTE and SKIP in the CLI workspace`,
      );
    }
    if (after === 'x' && before !== 'x') {
      if (firstUnfinished) {
        throw importError(
          'import_stage_gap',
          `stage ${stage.stageId} is complete but the earlier stage ${firstUnfinished.stageId} is not`,
        );
      }
      if (isPerUnitStage(stage)) {
        throw importError(
          'import_parallel_unsupported',
          `stage ${stage.stageId} runs per unit of work; importing Construction unit progress is not supported yet`,
        );
      }
      newlyCompleted.push(stage);
    }
    if (!firstUnfinished && !DONE_MARKERS.has(after)) firstUnfinished = stage;
  }
  return { baselineMarker, newlyCompleted, continuation: firstUnfinished };
};

const questionTasksByStage = ({ humanTasks, stageRows }) => {
  const stageIdByInstance = new Map(
    stageRows
      .filter((row) => row?.stageInstanceId)
      .map((row) => [row.stageInstanceId, row.stageId]),
  );
  const groups = new Map();
  for (const task of humanTasks) {
    if (task?.status === 'superseded') continue;
    const stageId = task.stageId ?? stageIdByInstance.get(task.stageInstanceId);
    if (!stageId) continue;
    const list = groups.get(stageId) ?? [];
    list.push(task);
    groups.set(stageId, list);
  }
  for (const list of groups.values()) {
    list.sort(
      (left, right) =>
        String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')) ||
        String(left.humanTaskId ?? '').localeCompare(String(right.humanTaskId ?? '')),
    );
  }
  return groups;
};

const planQuestionAnswers = ({ stageId, tasks, text, path }) => {
  const questionTasks = tasks.filter((task) => task.kind === 'question');
  const answers = parseQuestionAnswers(text);
  const questionsPerTask = questionTasks.map((task) => {
    const questions = parseQuestions(task.questions);
    return Array.isArray(questions) ? questions : [];
  });
  const total = questionsPerTask.reduce((sum, questions) => sum + questions.length, 0);
  if (answers.length !== total) {
    throw importError(
      'import_questions_mismatch',
      `${path} has ${answers.length} question(s) but the intent's gates for ${stageId} have ${total}`,
    );
  }
  const writes = [];
  const rendered = [];
  let offset = 0;
  questionTasks.forEach((task, taskIndex) => {
    const questions = questionsPerTask[taskIndex];
    const parsed = questions.map((question, index) =>
      parseAnswer(answers[offset + index], question),
    );
    offset += questions.length;
    if (task.status !== 'pending') {
      rendered.push(task);
      return;
    }
    if (parsed.every((entry) => entry === null)) {
      rendered.push(task);
      return;
    }
    const answer = {
      answers: parsed.map((entry) => entry ?? { selectedOptions: [], freeText: '' }),
    };
    writes.push({ humanTaskId: task.humanTaskId, stageId, answer });
    rendered.push({ ...task, status: 'answered', answer });
  });
  const exact =
    normalizeLineEndings(renderQuestionFile({ stageId, tasks: rendered })) ===
    normalizeLineEndings(text);
  return { writes, exact };
};

// The part of a plan both entry points share: which changed CLI files become
// artifact writes and gate answers for the stages being imported. The callers
// decide which files changed (against the export, or against the sync
// baseline) and hand them to `importFile`.
const createImportPlanner = ({
  files,
  current,
  manifest,
  projected,
  recordRoot,
  baseMarker,
  newlyCompleted,
  conflictedStageIds = new Set(),
  completedWhen,
  now,
}) => {
  const stages = current.stages;
  const stageById = new Map(stages.map((stage) => [stage.stageId, stage]));
  const newlyCompletedIds = new Set(newlyCompleted.map((stage) => stage.stageId));
  const stageRows = current.stageRows ?? [];
  const humanTasks = current.humanTasks ?? [];
  const repositories = projected.manifest.repositories;
  const runtimeStages = parseRuntimeGraph(files.get(`${recordRoot.path}/runtime-graph.json`));

  const stageCompletions = newlyCompleted.map((stage) => {
    const row = stageRowFor(stageRows, stage.stageId);
    const runtime = runtimeStages.get(stage.stageId);
    return {
      stageId: stage.stageId,
      stageInstanceId: row?.stageInstanceId ?? stage.stageInstanceId ?? null,
      phase: stage.phase,
      startedAt: runtime?.started_at ?? row?.startedAt ?? now,
      completedAt: runtime?.completed_at ?? now,
    };
  });

  // Where each current artifact lands in the workspace, using the projector's
  // own path rule so the two directions cannot drift.
  const projectedStageById = new Map(projected.stages.map((stage) => [stage.stageId, stage]));
  const artifactByPath = new Map();
  for (const artifact of current.artifacts ?? []) {
    const path = artifactPath({
      artifact,
      recordRoot,
      stageById: projectedStageById,
      repositories,
      workspaceLayout: manifest.native.workspaceLayout,
    });
    artifactByPath.set(path, artifact);
  }

  const tasksByStage = questionTasksByStage({ humanTasks, stageRows });
  const artifactWrites = [];
  const answers = [];
  const ignoredFiles = [];
  const warnings = [];
  const ignore = (path, reason) => ignoredFiles.push({ path, reason });

  // The state file, the runtime graph and the audit log are derived from the
  // stage records; they are never imported as content.
  const isBookkeeping = (path) => {
    const recordFile = path.startsWith(`${recordRoot.path}/`)
      ? path.slice(recordRoot.path.length + 1)
      : null;
    return ROOT_RECORD_FILES.has(recordFile) || Boolean(recordFile?.startsWith('audit/'));
  };

  const locate = (path) => {
    const existing = artifactByPath.get(path) ?? null;
    const location = existing
      ? {
          stageId: existing.stageId,
          name: slugify(existing.artifactType || existing.type),
          unitSlug: existing.unitSlug ?? null,
          repository: existing.repository ?? null,
        }
      : locateFile({ path, recordRoot, stageById, repositories });
    return { existing, location };
  };

  const importFile = (path, text) => {
    const { existing, location } = locate(path);
    if (!location) {
      ignore(path, 'files outside the intent record are not imported');
      return;
    }
    const stage = stageById.get(location.stageId);
    if (baseMarker.get(stage.stageId) === 'x') {
      throw importError(
        'import_completed_stage_changed',
        `${path} changed, but stage ${stage.stageId} was already complete ${completedWhen}; edit it in the UI instead`,
      );
    }
    if (conflictedStageIds.has(stage.stageId)) {
      ignore(path, `stage ${stage.stageId} is in conflict`);
      return;
    }
    if (!newlyCompletedIds.has(stage.stageId)) {
      ignore(path, `stage ${stage.stageId} is not complete in the CLI workspace`);
      return;
    }
    if (location.unitSlug) {
      ignore(path, 'per-unit artifacts are not imported yet');
      return;
    }

    const questionName = `${stage.stageId}-questions`;
    if (!existing && location.name === questionName) {
      const { writes, exact } = planQuestionAnswers({
        stageId: stage.stageId,
        tasks: tasksByStage.get(stage.stageId) ?? [],
        text,
        path,
      });
      answers.push(...writes);
      if (exact) return;
      // The CLI answer text does not re-render identically (for example a
      // bare "B"). Keep the file itself as the authoritative question
      // artifact so the next export reproduces what the CLI user wrote.
    } else if (
      !existing &&
      !(stage.produces ?? []).some((type) => slugify(type) === location.name)
    ) {
      ignore(path, `not a declared output of stage ${stage.stageId}`);
      return;
    }

    artifactWrites.push({
      path,
      artifactType: existing?.artifactType ?? existing?.type ?? location.name,
      stageId: stage.stageId,
      phase: stage.phase,
      stageInstanceId:
        stageCompletions.find((completion) => completion.stageId === stage.stageId)
          ?.stageInstanceId ?? null,
      unitSlug: null,
      repository: location.repository,
      previousArtifactId: existing?.id ?? null,
      content: text,
    });
  };

  const finish = ({ continuation, isRemoval = () => true }) => {
    // Only artifacts count: cursors and runtime-graph.json are gitignored by
    // the CLI, so a branch checkout never has them.
    for (const path of artifactByPath.keys()) {
      if (!files.has(path) && isRemoval(path)) {
        warnings.push(`${path} was removed in the CLI workspace; removals are not imported.`);
      }
    }

    const answered = new Set(answers.map((answer) => answer.humanTaskId));
    const gateResolutions = [];
    for (const stage of newlyCompleted) {
      for (const task of tasksByStage.get(stage.stageId) ?? []) {
        if (task.status !== 'pending' || answered.has(task.humanTaskId)) continue;
        if (task.kind === 'question') {
          warnings.push(
            `Question gate ${task.humanTaskId} on ${stage.stageId} has no answer in the CLI workspace; it will be resolved without one.`,
          );
        }
        gateResolutions.push({
          humanTaskId: task.humanTaskId,
          kind: task.kind,
          stageId: stage.stageId,
        });
      }
    }

    return {
      intentId: current.intent.intentId,
      exportedAt: manifest.exportedAt,
      upstreamRef: manifest.native.upstreamRef,
      harness: manifest.native.harness,
      continuationStageId: continuation?.stageId ?? null,
      workflowComplete: continuation === null,
      stageCompletions,
      artifactWrites,
      answers,
      gateResolutions,
      ignoredFiles,
      warnings,
    };
  };

  return { ignore, isBookkeeping, locate, importFile, finish };
};

// The checks every import starts with: a valid manifest for this intent and
// release, and the intent's records projected with the manifest's settings.
const openWorkspace = ({ rawFiles, current }) => {
  const files = normalizeFiles(rawFiles);
  const manifest = parseManifest(files);
  const intentId = current?.intent?.intentId;
  if (manifest.source.intentId !== intentId) {
    throw importError(
      'import_intent_mismatch',
      `this workspace was exported from intent ${manifest.source.intentId}, not ${intentId}`,
    );
  }
  if (manifest.native.upstreamRef !== current.upstreamRef) {
    throw importError(
      'import_release_mismatch',
      `this workspace uses AI-DLC ${manifest.native.upstreamRef}, but the intent is pinned to ${current.upstreamRef}`,
    );
  }
  return { files, manifest, projected: projectBaseline({ current, manifest }) };
};

const readStateMarkers = ({ files, recordRoot }) => {
  const statePath = `${recordRoot.path}/aidlc-state.md`;
  const stateText = files.get(statePath);
  if (stateText == null) {
    throw importError('import_state_invalid', `${statePath} is missing`);
  }
  return parseStageMarkers(stateText);
};

const sortedFiles = (files) => [...files].toSorted(([left], [right]) => left.localeCompare(right));

const planReattach = ({ files: rawFiles, current, now = new Date().toISOString() }) => {
  const { files, manifest, projected: baseline } = openWorkspace({ rawFiles, current });
  assertUnchangedSinceExport({ baseline, manifest });

  const recordRoot = recordRootFor(manifest);
  const { baselineMarker, newlyCompleted, continuation } = compareStageMarkers({
    stages: current.stages,
    baselineStages: baseline.stages,
    incoming: readStateMarkers({ files, recordRoot }),
  });
  const planner = createImportPlanner({
    files,
    current,
    manifest,
    projected: baseline,
    recordRoot,
    baseMarker: baselineMarker,
    newlyCompleted,
    completedWhen: 'at export',
    now,
  });

  const exportedSha = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  for (const [path, text] of sortedFiles(files)) {
    if (path === 'export-manifest.json') continue;
    const baselineBody = baseline.files.get(path);
    const changed =
      baselineBody != null ? baselineBody !== text : exportedSha.get(path) !== sha256(text);
    if (!changed || planner.isBookkeeping(path)) continue;
    if (baselineBody == null && exportedSha.has(path)) {
      planner.ignore(path, 'methodology and harness files are not imported');
      continue;
    }
    planner.importFile(path, text);
  }

  return planner.finish({ continuation });
};

// Continuous sync (docs/fork-plan/cli-progress-sync-design.md). Once an intent
// is linked to a branch, both sides keep moving, so the strict comparison
// above no longer fits. A sync compares three versions of every intent-record
// file and stage marker: the baseline, the UI's projection today, and the
// branch.
//
// The baseline is the common ancestor: the last value both sides agreed on.
// It advances for a path or stage only when the UI and the branch hold the
// same value after the sync (an import, or the same change made twice). A
// change only one side made leaves the ancestor where it is, so the other
// side changing the same thing later is still seen as a conflict.
const SYNC_BASELINE_VERSION = 1;
const UI_ACTIVE_STATES = new Set(['RUNNING', 'WAITING_FOR_HUMAN']);

const rowSignature = (row) => (row ? `${row.state}@${row.startedAt ?? ''}` : null);

const inIntentRecord = (path, recordRoot) =>
  path.startsWith(`${recordRoot.path}/`) ||
  (recordRoot.space !== null && path.startsWith(`aidlc/spaces/${recordRoot.space}/codekb/`));

const assertSyncBaseline = ({ baseline, current }) => {
  const valid =
    baseline?.schemaVersion === SYNC_BASELINE_VERSION &&
    baseline.intentId === current?.intent?.intentId &&
    baseline.files !== null &&
    typeof baseline.files === 'object' &&
    baseline.stages !== null &&
    typeof baseline.stages === 'object' &&
    current.stages.every((stage) => typeof baseline.stages[stage.stageId]?.marker === 'string');
  if (!valid) {
    throw importError(
      'import_sync_baseline_invalid',
      'this intent has no usable sync baseline; unlink the branch and import again with Keep syncing',
    );
  }
};

const compareSyncMarkers = ({ stages, stageRows, projectedStages, baseline, incoming }) => {
  assertStagesMatchPlan({ stages, incoming });
  const uiMarker = new Map(projectedStages.map((stage) => [stage.stageId, stage.marker]));
  const baseMarker = new Map(stages.map((s) => [s.stageId, baseline.stages[s.stageId].marker]));
  const newlyCompleted = [];
  const conflicts = [];
  let firstUnfinished = null;
  for (const stage of stages) {
    const { stageId } = stage;
    const before = baseMarker.get(stageId);
    const cli = incoming.get(stageId);
    const ui = uiMarker.get(stageId);
    if (before === 'x' && cli !== 'x') {
      throw importError(
        'import_stage_regressed',
        `stage ${stageId} was complete at the last sync but is [${cli}] in the CLI workspace; rewinds are not imported`,
      );
    }
    if ((before === 'S') !== (cli === 'S')) {
      throw importError(
        'import_scope_changed',
        `stage ${stageId} changed between EXECUTE and SKIP in the CLI workspace`,
      );
    }
    if (cli === 'x' && before !== 'x') {
      const row = stageRowFor(stageRows, stageId);
      const uiStarted =
        UI_ACTIVE_STATES.has(row?.state) && rowSignature(row) !== baseline.stages[stageId].uiRow;
      if (ui === 'x') {
        conflicts.push({ kind: 'stage', stageId, reason: 'both_completed' });
      } else if (uiStarted) {
        conflicts.push({ kind: 'stage', stageId, reason: 'ui_in_progress' });
      } else {
        if (firstUnfinished) {
          throw importError(
            'import_stage_gap',
            `stage ${stageId} is complete but the earlier stage ${firstUnfinished.stageId} is not`,
          );
        }
        if (isPerUnitStage(stage)) {
          throw importError(
            'import_parallel_unsupported',
            `stage ${stageId} runs per unit of work; importing Construction unit progress is not supported yet`,
          );
        }
        newlyCompleted.push(stage);
      }
    }
    // A stage either side finished is finished: one the UI completed and the
    // CLI has not is the UI's progress, not a CLI rewind.
    if (!firstUnfinished && !DONE_MARKERS.has(cli) && !DONE_MARKERS.has(ui)) {
      firstUnfinished = stage;
    }
  }
  return { baseMarker, newlyCompleted, conflicts, continuation: firstUnfinished };
};

// The baseline after `plan` is applied: wherever the UI and the branch now
// agree, the agreed value; everywhere else the previous ancestor. A stage in
// conflict keeps its ancestor even though both sides completed it, so the
// conflict is still there on the next sync until someone resolves it.
const advanceSyncBaseline = ({
  previous,
  files,
  current,
  manifest,
  plan,
  conflictedStageIds = new Set(),
  headSha,
  now,
}) => {
  const after = applyReattachPlan(current, plan);
  const projected = projectBaseline({ current: after, manifest });
  const recordRoot = recordRootFor(manifest);
  const incoming = readStateMarkers({ files, recordRoot });
  const nextFiles = { ...previous.files };
  for (const [path, text] of files) {
    const body = projected.files.get(path);
    if (body != null && inIntentRecord(path, recordRoot) && sha256(body) === sha256(text)) {
      nextFiles[path] = sha256(text);
    }
  }
  const stageRows = after.stageRows ?? [];
  return {
    schemaVersion: SYNC_BASELINE_VERSION,
    intentId: current.intent.intentId,
    headSha: headSha ?? null,
    syncedAt: now,
    files: Object.fromEntries(
      Object.entries(nextFiles).toSorted(([left], [right]) => left.localeCompare(right)),
    ),
    stages: Object.fromEntries(
      projected.stages.map((stage) => [
        stage.stageId,
        {
          marker:
            incoming.get(stage.stageId) === stage.marker && !conflictedStageIds.has(stage.stageId)
              ? stage.marker
              : (previous.stages[stage.stageId]?.marker ?? stage.marker),
          // The UI's own stage row at this sync. A stage the UI starts later
          // has a different row, which is how a sync tells it was started.
          uiRow: rowSignature(stageRowFor(stageRows, stage.stageId)),
        },
      ]),
    ),
  };
};

// The first baseline, written when an intent is linked by a strict import
// (`plan` from planReattach, `current` as it was before that import). The
// strict import proved the UI still equals the export, so the export is the
// ancestor and the imported state is what both sides agree on.
const createSyncBaseline = ({ files: rawFiles, current, plan, headSha = null, now }) => {
  const { files, manifest, projected } = openWorkspace({ rawFiles, current });
  const recordRoot = recordRootFor(manifest);
  const previous = {
    files: Object.fromEntries(
      manifest.files
        .filter((entry) => inIntentRecord(entry.path, recordRoot))
        .map((entry) => [entry.path, entry.sha256]),
    ),
    stages: Object.fromEntries(
      projected.stages.map((stage) => [stage.stageId, { marker: stage.marker }]),
    ),
  };
  return advanceSyncBaseline({ previous, files, current, manifest, plan, headSha, now });
};

const planSync = ({
  files: rawFiles,
  current,
  baseline,
  headSha = null,
  now = new Date().toISOString(),
}) => {
  const { files, manifest, projected } = openWorkspace({ rawFiles, current });
  assertSyncBaseline({ baseline, current });

  const recordRoot = recordRootFor(manifest);
  const {
    baseMarker,
    newlyCompleted,
    conflicts: stageConflicts,
    continuation,
  } = compareSyncMarkers({
    stages: current.stages,
    stageRows: current.stageRows ?? [],
    projectedStages: projected.stages,
    baseline,
    incoming: readStateMarkers({ files, recordRoot }),
  });
  const conflictedStageIds = new Set(stageConflicts.map((conflict) => conflict.stageId));
  const planner = createImportPlanner({
    files,
    current,
    manifest,
    projected,
    recordRoot,
    baseMarker,
    newlyCompleted,
    conflictedStageIds,
    completedWhen: 'at the last sync',
    now,
  });

  const exportedSha = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  const artifactConflicts = [];
  const uiOwnedFiles = [];
  const paths = new Set([...files.keys(), ...projected.files.keys()]);
  for (const path of [...paths].toSorted((left, right) => left.localeCompare(right))) {
    if (path === 'export-manifest.json' || planner.isBookkeeping(path)) continue;
    const text = files.get(path);
    const cli = text == null ? null : sha256(text);
    if (!inIntentRecord(path, recordRoot)) {
      // Methodology, harness and space files: never imported, never compared.
      if (cli !== null && cli !== exportedSha.get(path)) {
        planner.ignore(
          path,
          exportedSha.has(path)
            ? 'methodology and harness files are not imported'
            : 'files outside the intent record are not imported',
        );
      }
      continue;
    }
    const base = baseline.files[path] ?? null;
    const body = projected.files.get(path);
    const ui = body == null ? null : sha256(body);
    // A file the branch does not have is not a CLI change: removals are not
    // imported, and the CLI never commits the gitignored cursors.
    const cliChanged = cli !== null && cli !== base;
    const uiChanged = ui !== base;
    if (!cliChanged) {
      if (uiChanged) uiOwnedFiles.push(path);
      continue;
    }
    if (!uiChanged) {
      planner.importFile(path, text);
      continue;
    }
    if (ui !== cli) {
      artifactConflicts.push({
        kind: 'artifact',
        path,
        stageId: planner.locate(path).location?.stageId ?? null,
      });
    }
  }

  const plan = planner.finish({
    continuation,
    isRemoval: (path) => baseline.files[path] != null,
  });
  return {
    ...plan,
    conflicts: [...stageConflicts, ...artifactConflicts],
    uiOwnedFiles,
    baseline: advanceSyncBaseline({
      previous: baseline,
      files,
      current,
      manifest,
      plan,
      conflictedStageIds,
      headSha,
      now,
    }),
  };
};

// Apply a plan to projector-shaped records. The handler performs the same
// changes against the stores; this pure version backs the round-trip tests
// and the import preview.
const applyReattachPlan = (current, plan) => {
  const stageRows = (current.stageRows ?? []).map((row) => ({ ...row }));
  for (const completion of plan.stageCompletions) {
    const row = stageRowFor(stageRows, completion.stageId);
    const next = {
      stageInstanceId: completion.stageInstanceId,
      stageId: completion.stageId,
      phase: completion.phase,
      state: 'SUCCEEDED',
      startedAt: completion.startedAt,
      completedAt: completion.completedAt,
    };
    if (row) Object.assign(row, next);
    else stageRows.push(next);
  }

  const artifacts = (current.artifacts ?? []).map((artifact) => ({ ...artifact }));
  for (const write of plan.artifactWrites) {
    const existing = write.previousArtifactId
      ? artifacts.find((artifact) => artifact.id === write.previousArtifactId)
      : null;
    if (existing) {
      existing.content = write.content;
      continue;
    }
    artifacts.push({
      id: `imported:${write.path}`,
      artifactType: write.artifactType,
      stageId: write.stageId,
      phase: write.phase,
      createdByStageInstanceId: write.stageInstanceId,
      unitSlug: write.unitSlug,
      repository: write.repository,
      content: write.content,
    });
  }

  const answerById = new Map(plan.answers.map((answer) => [answer.humanTaskId, answer.answer]));
  const resolvedIds = new Set(plan.gateResolutions.map((gate) => gate.humanTaskId));
  const humanTasks = (current.humanTasks ?? []).map((task) => {
    if (answerById.has(task.humanTaskId)) {
      return { ...task, status: 'answered', answer: answerById.get(task.humanTaskId) };
    }
    if (resolvedIds.has(task.humanTaskId)) return { ...task, status: 'superseded' };
    return task;
  });

  return { ...current, stageRows, artifacts, humanTasks };
};

// The validated export manifest of a workspace, for callers that need its
// release and harness before they can build the `current` records.
const readExportManifest = (files) => parseManifest(normalizeFiles(files));

export {
  applyReattachPlan,
  createSyncBaseline,
  parseAnswer,
  parseStageMarkers,
  planReattach,
  planSync,
  readExportManifest,
};

export default { planReattach, applyReattachPlan };
