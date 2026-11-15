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

const compareStageMarkers = ({ stages, baselineStages, incoming }) => {
  const baselineMarker = new Map(baselineStages.map((stage) => [stage.stageId, stage.marker]));
  const unknown = [...incoming.keys()].filter((stageId) => !baselineMarker.has(stageId));
  const missing = stages.map((stage) => stage.stageId).filter((stageId) => !incoming.has(stageId));
  if (unknown.length > 0 || missing.length > 0) {
    throw importError(
      'import_state_invalid',
      `the state file's stages differ from the intent's plan (missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'})`,
    );
  }
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

const planReattach = ({ files: rawFiles, current, now = new Date().toISOString() }) => {
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

  const baseline = projectBaseline({ current, manifest });
  assertUnchangedSinceExport({ baseline, manifest });

  const recordRoot = recordRootFor(manifest);
  const statePath = `${recordRoot.path}/aidlc-state.md`;
  const stateText = files.get(statePath);
  if (stateText == null) {
    throw importError('import_state_invalid', `${statePath} is missing`);
  }
  const stages = current.stages;
  const { baselineMarker, newlyCompleted, continuation } = compareStageMarkers({
    stages,
    baselineStages: baseline.stages,
    incoming: parseStageMarkers(stateText),
  });
  const stageById = new Map(stages.map((stage) => [stage.stageId, stage]));
  const newlyCompletedIds = new Set(newlyCompleted.map((stage) => stage.stageId));
  const stageRows = current.stageRows ?? [];
  const humanTasks = current.humanTasks ?? [];
  const repositories = baseline.manifest.repositories;
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
  const projectedStageById = new Map(baseline.stages.map((stage) => [stage.stageId, stage]));
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

  const exportedSha = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  const tasksByStage = questionTasksByStage({ humanTasks, stageRows });
  const artifactWrites = [];
  const answers = [];
  const ignoredFiles = [];
  const warnings = [];
  const ignore = (path, reason) => ignoredFiles.push({ path, reason });

  for (const [path, text] of [...files].toSorted(([left], [right]) => left.localeCompare(right))) {
    if (path === 'export-manifest.json') continue;
    const baselineBody = baseline.files.get(path);
    const changed =
      baselineBody != null ? baselineBody !== text : exportedSha.get(path) !== sha256(text);
    if (!changed) continue;
    const recordFile = path.startsWith(`${recordRoot.path}/`)
      ? path.slice(recordRoot.path.length + 1)
      : null;
    if (ROOT_RECORD_FILES.has(recordFile) || recordFile?.startsWith('audit/')) continue;
    if (baselineBody == null && exportedSha.has(path)) {
      ignore(path, 'methodology and harness files are not imported');
      continue;
    }

    const existing = artifactByPath.get(path) ?? null;
    const location = existing
      ? {
          stageId: existing.stageId,
          name: slugify(existing.artifactType || existing.type),
          unitSlug: existing.unitSlug ?? null,
          repository: existing.repository ?? null,
        }
      : locateFile({ path, recordRoot, stageById, repositories });
    if (!location) {
      ignore(path, 'files outside the intent record are not imported');
      continue;
    }
    const stage = stageById.get(location.stageId);
    if (baselineMarker.get(stage.stageId) === 'x') {
      throw importError(
        'import_completed_stage_changed',
        `${path} changed, but stage ${stage.stageId} was already complete at export; edit it in the UI instead`,
      );
    }
    if (!newlyCompletedIds.has(stage.stageId)) {
      ignore(path, `stage ${stage.stageId} is not complete in the CLI workspace`);
      continue;
    }
    if (location.unitSlug) {
      ignore(path, 'per-unit artifacts are not imported yet');
      continue;
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
      if (exact) continue;
      // The CLI answer text does not re-render identically (for example a
      // bare "B"). Keep the file itself as the authoritative question
      // artifact so the next export reproduces what the CLI user wrote.
    } else if (
      !existing &&
      !(stage.produces ?? []).some((type) => slugify(type) === location.name)
    ) {
      ignore(path, `not a declared output of stage ${stage.stageId}`);
      continue;
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
  }

  // Only artifacts count: cursors and runtime-graph.json are gitignored by
  // the CLI, so a branch checkout never has them.
  for (const path of artifactByPath.keys()) {
    if (!files.has(path)) {
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
    intentId,
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

export { applyReattachPlan, parseAnswer, parseStageMarkers, planReattach, readExportManifest };

export default { planReattach, applyReattachPlan };
