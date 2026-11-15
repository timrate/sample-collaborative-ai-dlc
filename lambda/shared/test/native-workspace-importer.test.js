import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectNativeWorkspace } from '../native-workspace-projector.js';
import {
  applyReattachPlan,
  createSyncBaseline,
  planReattach,
  planSync,
} from '../native-workspace-importer.js';

const EXPORTED_AT = '2026-08-11T12:00:00.000Z';
const IMPORTED_AT = '2026-08-12T09:00:00.000Z';
const ROOT = 'aidlc/spaces/default/intents/260811-payment-service';

// The intent as the UI holds it at export time: Intent Capture done,
// Requirements Analysis parked on an unanswered question.
const current = () => ({
  intent: {
    projectId: 'project-1',
    intentId: 'intent-1',
    title: 'Payment service',
    prompt: 'Add payments',
    scope: 'feature',
    branch: 'aidlc/intent-1',
    workflowId: 'aidlc-v2',
    workflowVersion: 4,
    createdAt: '2026-08-11T10:00:00.000Z',
  },
  upstreamRef: 'abc123',
  harness: 'claude',
  workspaceLayout: 'spaces',
  stages: [
    {
      stageId: 'intent-capture',
      stageInstanceId: 'si-intent',
      phase: 'ideation',
      number: '1.1',
      leadAgent: 'aidlc-product-agent',
      produces: ['intent'],
    },
    {
      stageId: 'requirements-analysis',
      stageInstanceId: 'si-requirements',
      phase: 'inception',
      number: '2.2',
      leadAgent: 'aidlc-product-agent',
      produces: ['requirements'],
    },
    {
      stageId: 'workflow-planning',
      stageInstanceId: 'si-planning',
      phase: 'inception',
      number: '2.3',
      leadAgent: 'aidlc-architect-agent',
      produces: ['execution-plan'],
    },
    {
      stageId: 'code-generation',
      stageInstanceId: 'si-codegen',
      phase: 'construction',
      number: '3.5',
      leadAgent: 'aidlc-developer-agent',
      produces: ['code-summary'],
      forEach: 'unit-of-work',
      parallelSection: 0,
    },
  ],
  stageRows: [
    {
      stageInstanceId: 'si-intent',
      stageId: 'intent-capture',
      phase: 'ideation',
      state: 'SUCCEEDED',
      startedAt: '2026-08-11T10:01:00.000Z',
      completedAt: '2026-08-11T10:20:00.000Z',
    },
    {
      stageInstanceId: 'si-requirements',
      stageId: 'requirements-analysis',
      phase: 'inception',
      state: 'WAITING_FOR_HUMAN',
      startedAt: '2026-08-11T10:21:00.000Z',
    },
  ],
  artifacts: [
    {
      id: 'artifact-intent',
      artifactType: 'intent',
      stageId: 'intent-capture',
      phase: 'ideation',
      createdByStageInstanceId: 'si-intent',
      content: '# Intent\n\nAccept card payments.\n',
    },
    {
      id: 'artifact-requirements',
      artifactType: 'requirements',
      stageId: 'requirements-analysis',
      phase: 'inception',
      createdByStageInstanceId: 'si-requirements',
      content: '# Requirements\n\nDraft.\n',
    },
  ],
  humanTasks: [
    {
      humanTaskId: 'q-requirements',
      stageInstanceId: 'si-requirements',
      kind: 'question',
      status: 'pending',
      createdAt: '2026-08-11T10:30:00.000Z',
      questions: JSON.stringify([
        {
          text: 'Which interfaces are required?',
          type: 'single',
          options: [{ label: 'REST', description: 'Public HTTP API' }, { label: 'Events' }],
        },
      ]),
    },
  ],
});

// What the CLI did after the export: answered the question, finished
// Requirements Analysis, and is now on Workflow Planning. Expressed as UI
// records so the projector can render the workspace the CLI would hold.
const advanced = () => {
  const value = current();
  value.stageRows[1] = {
    ...value.stageRows[1],
    state: 'SUCCEEDED',
    completedAt: '2026-08-12T08:00:00.000Z',
  };
  value.artifacts[1] = { ...value.artifacts[1], content: '# Requirements\n\nREST only.\n' };
  value.humanTasks[0] = {
    ...value.humanTasks[0],
    status: 'answered',
    answer: { answers: [{ selectedOptions: [0], freeText: 'v1 only' }] },
  };
  return value;
};

const project = (value, now = EXPORTED_AT) => projectNativeWorkspace({ ...value, now });

// The exported ZIP / branch content: projector files plus the export manifest.
const exportedFiles = (value = current()) => new Map(project(value).files);

// A CLI workspace that progressed from an export: every projector-owned file
// is what the projector renders for the advanced records; the export
// manifest is the original one (the CLI never rewrites it).
const cliWorkspace = () => {
  const files = exportedFiles();
  for (const [path, body] of project(advanced()).files) {
    if (path !== 'export-manifest.json') files.set(path, body);
  }
  return files;
};

const reexport = (plan, base = current()) => {
  const applied = applyReattachPlan(base, plan);
  return project(applied).files;
};

const expectCode = (fn, code) => {
  let error;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error, `expected ${code}`).toBeInstanceOf(Error);
  expect(error.code).toBe(code);
  expect(error.message).toMatch(/^native-import: /);
};

describe('planReattach round trip', () => {
  it('re-imports an unchanged export as a no-op that re-exports byte-for-byte', () => {
    const files = exportedFiles();
    const plan = planReattach({ files, current: current(), now: IMPORTED_AT });

    expect(plan.stageCompletions).toEqual([]);
    expect(plan.artifactWrites).toEqual([]);
    expect(plan.answers).toEqual([]);
    expect(plan.gateResolutions).toEqual([]);
    expect(plan.continuationStageId).toBe('requirements-analysis');

    const again = reexport(plan);
    for (const [path, body] of again) expect(files.get(path), path).toBe(body);
    expect([...again.keys()].toSorted()).toEqual([...files.keys()].toSorted());
  });

  it('imports CLI progress so the re-export reproduces the CLI workspace byte-for-byte', () => {
    const files = cliWorkspace();
    const plan = planReattach({ files, current: current(), now: IMPORTED_AT });

    expect(plan.continuationStageId).toBe('workflow-planning');
    expect(plan.workflowComplete).toBe(false);
    expect(plan.stageCompletions).toEqual([
      {
        stageId: 'requirements-analysis',
        stageInstanceId: 'si-requirements',
        phase: 'inception',
        startedAt: '2026-08-11T10:21:00.000Z',
        completedAt: '2026-08-12T08:00:00.000Z',
      },
    ]);
    expect(plan.artifactWrites).toEqual([
      expect.objectContaining({
        path: `${ROOT}/inception/requirements-analysis/requirements.md`,
        artifactType: 'requirements',
        stageId: 'requirements-analysis',
        stageInstanceId: 'si-requirements',
        previousArtifactId: 'artifact-requirements',
        content: '# Requirements\n\nREST only.\n',
      }),
    ]);
    expect(plan.answers).toEqual([
      {
        humanTaskId: 'q-requirements',
        stageId: 'requirements-analysis',
        answer: { answers: [{ selectedOptions: [0], freeText: 'v1 only' }] },
      },
    ]);

    const again = reexport(plan);
    for (const [path, body] of again) {
      if (path === 'export-manifest.json') continue;
      expect(body, path).toBe(files.get(path));
    }
  });

  it('is idempotent: importing the re-export of an import changes nothing', () => {
    const plan = planReattach({ files: cliWorkspace(), current: current(), now: IMPORTED_AT });
    const applied = applyReattachPlan(current(), plan);
    const second = planReattach({
      files: new Map(project(applied).files),
      current: applied,
      now: IMPORTED_AT,
    });
    expect(second.stageCompletions).toEqual([]);
    expect(second.artifactWrites).toEqual([]);
    expect(second.answers).toEqual([]);
  });
});

describe('planReattach parsing of CLI-authored files', () => {
  it('reads stage markers from a state file the CLI rewrote with its own fields', () => {
    const files = cliWorkspace();
    const statePath = `${ROOT}/aidlc-state.md`;
    files.set(
      statePath,
      files
        .get(statePath)
        .replace('- **Languages**:', '- **Languages**: TypeScript')
        .replace(/- \*\*Last Updated\*\*: .*/, '- **Last Updated**: 2026-08-12T08:05:00Z')
        .replaceAll('\n', '\r\n'),
    );
    const plan = planReattach({ files, current: current(), now: IMPORTED_AT });
    expect(plan.continuationStageId).toBe('workflow-planning');
    expect(plan.stageCompletions.map((stage) => stage.stageId)).toEqual(['requirements-analysis']);
  });

  it('accepts bare option letters and keeps the CLI text as the question artifact', () => {
    const files = cliWorkspace();
    const path = `${ROOT}/inception/requirements-analysis/requirements-analysis-questions.md`;
    files.set(path, files.get(path).replace('[Answer]: A. REST; v1 only', '[Answer]: A'));
    const plan = planReattach({ files, current: current(), now: IMPORTED_AT });

    expect(plan.answers[0].answer).toEqual({
      answers: [{ selectedOptions: [0], freeText: '' }],
    });
    // "A" re-renders as "A. REST", so the exact CLI file is kept as the
    // authoritative question artifact and the round trip stays byte-stable.
    expect(plan.artifactWrites).toContainEqual(
      expect.objectContaining({
        path,
        artifactType: 'requirements-analysis-questions',
        content: files.get(path),
      }),
    );
    expect(reexport(plan).get(path)).toBe(files.get(path));
  });

  it('records an unparseable answer as free text', () => {
    const files = cliWorkspace();
    const path = `${ROOT}/inception/requirements-analysis/requirements-analysis-questions.md`;
    files.set(
      path,
      files.get(path).replace('[Answer]: A. REST; v1 only', '[Answer]: GraphQL, eventually'),
    );
    const plan = planReattach({ files, current: current(), now: IMPORTED_AT });
    expect(plan.answers[0].answer).toEqual({
      answers: [{ selectedOptions: [], freeText: 'GraphQL, eventually' }],
    });
  });

  it('lists CLI-only and incomplete-stage files as ignored instead of importing them', () => {
    const files = cliWorkspace();
    files.set(`${ROOT}/inception/requirements-analysis/memory.md`, '# Memory\n');
    files.set(`${ROOT}/inception/workflow-planning/execution-plan.md`, '# Half a plan\n');
    files.set('aidlc/spaces/default/memory/team.md', '# Team\n');
    const plan = planReattach({ files, current: current(), now: IMPORTED_AT });

    expect(plan.artifactWrites.map((write) => write.path)).toEqual([
      `${ROOT}/inception/requirements-analysis/requirements.md`,
    ]);
    expect(plan.ignoredFiles).toEqual(
      expect.arrayContaining([
        {
          path: `${ROOT}/inception/requirements-analysis/memory.md`,
          reason: expect.stringMatching(/not a declared output/),
        },
        {
          path: `${ROOT}/inception/workflow-planning/execution-plan.md`,
          reason: expect.stringMatching(/not complete/),
        },
        {
          path: 'aidlc/spaces/default/memory/team.md',
          reason: expect.stringMatching(/not imported/),
        },
      ]),
    );
  });

  it('accepts a branch checkout without the gitignored cursors and runtime graph', () => {
    const files = cliWorkspace();
    files.delete('aidlc/active-space');
    files.delete('aidlc/spaces/default/intents/active-intent');
    files.delete(`${ROOT}/runtime-graph.json`);
    const plan = planReattach({ files, current: current(), now: IMPORTED_AT });

    expect(plan.warnings).toEqual([]);
    expect(plan.stageCompletions).toEqual([
      expect.objectContaining({
        stageId: 'requirements-analysis',
        startedAt: '2026-08-11T10:21:00.000Z',
        completedAt: IMPORTED_AT,
      }),
    ]);
  });

  it('warns when the CLI workspace removed an exported artifact', () => {
    const files = cliWorkspace();
    files.delete(`${ROOT}/ideation/intent-capture/intent.md`);
    const plan = planReattach({ files, current: current(), now: IMPORTED_AT });
    expect(plan.warnings).toEqual([
      `${ROOT}/ideation/intent-capture/intent.md was removed in the CLI workspace; removals are not imported.`,
    ]);
  });

  it('resolves a pending non-question gate on a stage the CLI completed', () => {
    const base = current();
    base.humanTasks.push({
      humanTaskId: 'approval-requirements',
      stageInstanceId: 'si-requirements',
      kind: 'approval',
      status: 'pending',
      createdAt: '2026-08-11T10:40:00.000Z',
    });
    const files = exportedFiles(base);
    const cli = advanced();
    cli.humanTasks.push({ ...base.humanTasks[1], status: 'approved' });
    for (const [path, body] of project(cli).files) {
      if (path !== 'export-manifest.json') files.set(path, body);
    }
    const plan = planReattach({ files, current: base, now: IMPORTED_AT });
    expect(plan.gateResolutions).toEqual([
      { humanTaskId: 'approval-requirements', kind: 'approval', stageId: 'requirements-analysis' },
    ]);
  });

  it('reports the whole workflow as complete when the CLI finished every stage', () => {
    const base = current();
    base.stages = base.stages.slice(0, 2);
    const files = exportedFiles(base);
    const cli = advanced();
    cli.stages = cli.stages.slice(0, 2);
    for (const [path, body] of project(cli).files) {
      if (path !== 'export-manifest.json') files.set(path, body);
    }
    const plan = planReattach({ files, current: base, now: IMPORTED_AT });
    expect(plan.continuationStageId).toBeNull();
    expect(plan.workflowComplete).toBe(true);
  });
});

describe('planReattach refusals', () => {
  it('refuses a workspace exported from a different intent', () => {
    const base = current();
    base.intent.intentId = 'intent-2';
    expectCode(
      () => planReattach({ files: cliWorkspace(), current: base, now: IMPORTED_AT }),
      'import_intent_mismatch',
    );
  });

  it('refuses a workspace without an export manifest', () => {
    const files = cliWorkspace();
    files.delete('export-manifest.json');
    expectCode(
      () => planReattach({ files, current: current(), now: IMPORTED_AT }),
      'import_manifest_invalid',
    );
  });

  it('refuses a workspace pinned to another AI-DLC release', () => {
    const base = current();
    base.upstreamRef = 'def456';
    expectCode(
      () => planReattach({ files: cliWorkspace(), current: base, now: IMPORTED_AT }),
      'import_release_mismatch',
    );
  });

  it('refuses when the UI intent moved on after the export', () => {
    const moved = current();
    moved.artifacts[1].content = '# Requirements\n\nEdited in the UI.\n';
    expectCode(
      () => planReattach({ files: cliWorkspace(), current: moved, now: IMPORTED_AT }),
      'import_reattach_conflict',
    );
  });

  it('refuses a stage the CLI moved backwards', () => {
    const files = cliWorkspace();
    const statePath = `${ROOT}/aidlc-state.md`;
    files.set(
      statePath,
      files.get(statePath).replace('- [x] intent-capture', '- [ ] intent-capture'),
    );
    expectCode(
      () => planReattach({ files, current: current(), now: IMPORTED_AT }),
      'import_stage_regressed',
    );
  });

  it('refuses a stage skipped or unskipped in the CLI', () => {
    const files = cliWorkspace();
    const statePath = `${ROOT}/aidlc-state.md`;
    files.set(
      statePath,
      files.get(statePath).replace('- [-] workflow-planning', '- [S] workflow-planning'),
    );
    expectCode(
      () => planReattach({ files, current: current(), now: IMPORTED_AT }),
      'import_scope_changed',
    );
  });

  it('refuses a completed stage after an unfinished one', () => {
    const files = exportedFiles();
    const statePath = `${ROOT}/aidlc-state.md`;
    files.set(
      statePath,
      files.get(statePath).replace('- [ ] workflow-planning', '- [x] workflow-planning'),
    );
    expectCode(
      () => planReattach({ files, current: current(), now: IMPORTED_AT }),
      'import_stage_gap',
    );
  });

  it('refuses per-unit Construction progress in this phase', () => {
    const files = cliWorkspace();
    const statePath = `${ROOT}/aidlc-state.md`;
    files.set(
      statePath,
      files
        .get(statePath)
        .replace('- [-] workflow-planning', '- [x] workflow-planning')
        .replace('- [ ] code-generation', '- [x] code-generation'),
    );
    expectCode(
      () => planReattach({ files, current: current(), now: IMPORTED_AT }),
      'import_parallel_unsupported',
    );
  });

  it('refuses edits to an artifact of a stage the UI had already completed', () => {
    const files = cliWorkspace();
    files.set(`${ROOT}/ideation/intent-capture/intent.md`, '# Intent\n\nRewritten in CLI.\n');
    expectCode(
      () => planReattach({ files, current: current(), now: IMPORTED_AT }),
      'import_completed_stage_changed',
    );
  });

  it('refuses a state file that drops or adds stages', () => {
    const files = cliWorkspace();
    const statePath = `${ROOT}/aidlc-state.md`;
    files.set(
      statePath,
      files.get(statePath).replace(/- \[ \] code-generation — EXECUTE\r?\n/, ''),
    );
    expectCode(
      () => planReattach({ files, current: current(), now: IMPORTED_AT }),
      'import_state_invalid',
    );
  });

  it('refuses unsafe archive paths', () => {
    const files = cliWorkspace();
    files.set(`${ROOT}/../../escape.md`, 'x');
    expectCode(
      () => planReattach({ files, current: current(), now: IMPORTED_AT }),
      'import_unsafe_path',
    );
  });

  it('refuses a question file whose question count no longer matches the gates', () => {
    const files = cliWorkspace();
    const path = `${ROOT}/inception/requirements-analysis/requirements-analysis-questions.md`;
    files.set(path, `${files.get(path)}\n## Q2. An extra question?\n\n[Answer]: yes\n`);
    expectCode(
      () => planReattach({ files, current: current(), now: IMPORTED_AT }),
      'import_questions_mismatch',
    );
  });
});

// Continuous sync (docs/fork-plan/cli-progress-sync-design.md). The link is
// made by a strict import with "Keep syncing"; every later import from the
// branch is a three-way comparison against the stored baseline.
const sha256 = (body) => createHash('sha256').update(body).digest('hex');
const SYNCED_AT = '2026-08-13T09:00:00.000Z';
const REQUIREMENTS_PATH = `${ROOT}/inception/requirements-analysis/requirements.md`;
const PLAN_PATH = `${ROOT}/inception/workflow-planning/execution-plan.md`;
const STATE_PATH = `${ROOT}/aidlc-state.md`;

// The branch as the CLI holds it for the given records.
const cliFrom = (value) => {
  const files = exportedFiles();
  for (const [path, body] of project(value).files) {
    if (path !== 'export-manifest.json') files.set(path, body);
  }
  return files;
};

const baselineFor = (files, plan) =>
  createSyncBaseline({ files, current: current(), plan, headSha: 'sha-1', now: IMPORTED_AT });

// The first import with "Keep syncing": Requirements Analysis is imported and
// the baseline is written from the imported state.
const linked = () => {
  const files = cliWorkspace();
  const plan = planReattach({ files, current: current(), now: IMPORTED_AT });
  return { ui: applyReattachPlan(current(), plan), baseline: baselineFor(files, plan) };
};

// Linked without progress: Requirements Analysis is waiting on its gate on
// both sides, exactly as at the export.
const linkedWithoutProgress = () => {
  const files = exportedFiles();
  const plan = planReattach({ files, current: current(), now: IMPORTED_AT });
  return { ui: current(), baseline: baselineFor(files, plan) };
};

const withPlanning = (value, content) => {
  value.stageRows.push({
    stageInstanceId: 'si-planning',
    stageId: 'workflow-planning',
    phase: 'inception',
    state: 'SUCCEEDED',
    startedAt: '2026-08-12T10:00:00.000Z',
    completedAt: '2026-08-12T11:00:00.000Z',
  });
  value.artifacts.push({
    id: 'artifact-plan',
    artifactType: 'execution-plan',
    stageId: 'workflow-planning',
    phase: 'inception',
    createdByStageInstanceId: 'si-planning',
    content,
  });
  return value;
};

// The CLI went on after the link and finished Workflow Planning.
const cliPlanned = (content = '# Plan\n\nFrom the CLI.\n') =>
  cliFrom(withPlanning(advanced(), content));

const editState = (files, from, to) => {
  expect(files.get(STATE_PATH)).toContain(from);
  files.set(STATE_PATH, files.get(STATE_PATH).replace(from, to));
  return files;
};

const sync = (input) => planSync({ headSha: 'sha-2', now: SYNCED_AT, ...input });

describe('createSyncBaseline', () => {
  it('records the state both sides agree on after the linking import', () => {
    const { baseline } = linked();

    expect(baseline).toMatchObject({
      schemaVersion: 1,
      intentId: 'intent-1',
      headSha: 'sha-1',
      syncedAt: IMPORTED_AT,
    });
    expect(baseline.files[REQUIREMENTS_PATH]).toBe(sha256('# Requirements\n\nREST only.\n'));
    expect(baseline.stages['intent-capture'].marker).toBe('x');
    expect(baseline.stages['requirements-analysis'].marker).toBe('x');
    expect(baseline.stages['workflow-planning'].marker).not.toBe('x');
  });

  it('does not record CLI work that the linking import left out', () => {
    const files = cliWorkspace();
    files.set(PLAN_PATH, '# Half a plan\n');
    const plan = planReattach({ files, current: current(), now: IMPORTED_AT });

    expect(baselineFor(files, plan).files[PLAN_PATH]).toBeUndefined();
  });
});

describe('planSync file classification', () => {
  it('unchanged on both sides: nothing to do', () => {
    const { ui, baseline } = linked();
    const plan = sync({ files: cliWorkspace(), current: ui, baseline });

    expect(plan.stageCompletions).toEqual([]);
    expect(plan.artifactWrites).toEqual([]);
    expect(plan.answers).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.uiOwnedFiles).toEqual([]);
    expect(plan.baseline).toEqual({ ...baseline, headSha: 'sha-2', syncedAt: SYNCED_AT });
  });

  it('changed in the UI only: the UI owns it, and it is no longer an error', () => {
    const { ui, baseline } = linked();
    ui.artifacts[1].content = '# Requirements\n\nEdited in the UI.\n';

    expectCode(
      () => planReattach({ files: cliWorkspace(), current: ui, now: SYNCED_AT }),
      'import_reattach_conflict',
    );
    const plan = sync({ files: cliWorkspace(), current: ui, baseline });
    expect(plan.conflicts).toEqual([]);
    expect(plan.artifactWrites).toEqual([]);
    expect(plan.uiOwnedFiles).toEqual([REQUIREMENTS_PATH]);
    // The common ancestor stays, so a later CLI change to it is a conflict.
    expect(plan.baseline.files[REQUIREMENTS_PATH]).toBe(baseline.files[REQUIREMENTS_PATH]);
  });

  it('changed in the CLI only: imported when its stage is complete there', () => {
    const { ui, baseline } = linked();
    const plan = sync({ files: cliPlanned(), current: ui, baseline });

    expect(plan.conflicts).toEqual([]);
    expect(plan.stageCompletions.map((stage) => stage.stageId)).toEqual(['workflow-planning']);
    expect(plan.artifactWrites).toEqual([
      expect.objectContaining({
        path: PLAN_PATH,
        artifactType: 'execution-plan',
        stageId: 'workflow-planning',
        previousArtifactId: null,
        content: '# Plan\n\nFrom the CLI.\n',
      }),
    ]);
    expect(plan.continuationStageId).toBe('code-generation');
    expect(plan.baseline.files[PLAN_PATH]).toBe(sha256('# Plan\n\nFrom the CLI.\n'));
    expect(plan.baseline.stages['workflow-planning'].marker).toBe('x');
    expect(plan.baseline.headSha).toBe('sha-2');
  });

  it('changed in the CLI only: not imported while its stage is unfinished there', () => {
    const { ui, baseline } = linked();
    const files = cliWorkspace();
    files.set(PLAN_PATH, '# Half a plan\n');
    const plan = sync({ files, current: ui, baseline });

    expect(plan.artifactWrites).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.ignoredFiles).toEqual([
      { path: PLAN_PATH, reason: expect.stringMatching(/not complete/) },
    ]);
    expect(plan.baseline.files[PLAN_PATH]).toBeUndefined();
  });

  it('changed on both sides to the same content: nothing to do, the baseline advances', () => {
    const { ui, baseline } = linked();
    const same = '# Requirements\n\nREST and events.\n';
    ui.artifacts[1].content = same;
    const files = cliWorkspace();
    files.set(REQUIREMENTS_PATH, same);
    const plan = sync({ files, current: ui, baseline });

    expect(plan.conflicts).toEqual([]);
    expect(plan.artifactWrites).toEqual([]);
    expect(plan.uiOwnedFiles).toEqual([]);
    expect(plan.baseline.files[REQUIREMENTS_PATH]).toBe(sha256(same));
  });

  it('changed on both sides to different content: artifact conflict', () => {
    const { ui, baseline } = linked();
    ui.artifacts[1].content = '# Requirements\n\nEdited in the UI.\n';
    const files = cliWorkspace();
    files.set(REQUIREMENTS_PATH, '# Requirements\n\nEdited in the CLI.\n');
    const plan = sync({ files, current: ui, baseline });

    expect(plan.conflicts).toEqual([
      { kind: 'artifact', path: REQUIREMENTS_PATH, stageId: 'requirements-analysis' },
    ]);
    expect(plan.artifactWrites).toEqual([]);
    expect(plan.baseline.files[REQUIREMENTS_PATH]).toBe(baseline.files[REQUIREMENTS_PATH]);
  });
});

describe('planSync stage markers', () => {
  it('CLI completed, UI did not start: the stage is imported', () => {
    const { ui, baseline } = linked();
    const plan = sync({ files: cliPlanned(), current: ui, baseline });

    expect(plan.conflicts).toEqual([]);
    expect(plan.stageCompletions).toEqual([
      expect.objectContaining({ stageId: 'workflow-planning', stageInstanceId: 'si-planning' }),
    ]);
  });

  it('CLI completed a stage the UI parked on before the baseline: still imported', () => {
    const { ui, baseline } = linkedWithoutProgress();
    const plan = sync({ files: cliWorkspace(), current: ui, baseline });

    expect(plan.conflicts).toEqual([]);
    expect(plan.stageCompletions.map((stage) => stage.stageId)).toEqual(['requirements-analysis']);
    expect(plan.answers.map((answer) => answer.humanTaskId)).toEqual(['q-requirements']);
  });

  it('CLI completed a stage the UI started since the baseline: stage conflict', () => {
    const { ui, baseline } = linked();
    ui.stageRows.push({
      stageInstanceId: 'si-planning',
      stageId: 'workflow-planning',
      phase: 'inception',
      state: 'RUNNING',
      startedAt: '2026-08-12T10:00:00.000Z',
    });
    const plan = sync({ files: cliPlanned(), current: ui, baseline });

    expect(plan.conflicts).toContainEqual({
      kind: 'stage',
      stageId: 'workflow-planning',
      reason: 'ui_in_progress',
    });
    expect(plan.stageCompletions).toEqual([]);
    expect(plan.artifactWrites).toEqual([]);
  });

  it('UI completed, CLI did not: UI progress, not a CLI rewind', () => {
    const { ui, baseline } = linked();
    withPlanning(ui, '# Plan\n\nFrom the UI.\n');
    const plan = sync({ files: cliWorkspace(), current: ui, baseline });

    expect(plan.conflicts).toEqual([]);
    expect(plan.stageCompletions).toEqual([]);
    expect(plan.artifactWrites).toEqual([]);
    expect(plan.uiOwnedFiles).toContain(PLAN_PATH);
    expect(plan.continuationStageId).toBe('code-generation');
    // Not agreed by both sides, so the common ancestor does not move.
    expect(plan.baseline.stages['workflow-planning'].marker).not.toBe('x');
  });

  it('both completed since the baseline: stage conflict', () => {
    const { ui, baseline } = linked();
    withPlanning(ui, '# Plan\n\nFrom the UI.\n');
    const plan = sync({ files: cliPlanned(), current: ui, baseline });

    expect(plan.conflicts).toEqual([
      { kind: 'stage', stageId: 'workflow-planning', reason: 'both_completed' },
      { kind: 'artifact', path: PLAN_PATH, stageId: 'workflow-planning' },
    ]);
    expect(plan.stageCompletions).toEqual([]);
    expect(plan.artifactWrites).toEqual([]);
    expect(plan.baseline.stages['workflow-planning'].marker).not.toBe('x');
  });

  it('is idempotent: syncing the same branch again after an import changes nothing', () => {
    const { ui, baseline } = linked();
    const files = cliPlanned();
    const first = sync({ files, current: ui, baseline });
    const second = sync({
      files,
      current: applyReattachPlan(ui, first),
      baseline: first.baseline,
    });

    expect(second.stageCompletions).toEqual([]);
    expect(second.artifactWrites).toEqual([]);
    expect(second.answers).toEqual([]);
    expect(second.conflicts).toEqual([]);
    expect(second.baseline).toEqual(first.baseline);
  });
});

describe('planSync refusals carried over from the one-shot import', () => {
  it('refuses a completed stage after one that is unfinished on both sides', () => {
    const { ui, baseline } = linkedWithoutProgress();
    const files = editState(exportedFiles(), '- [ ] workflow-planning', '- [x] workflow-planning');
    expectCode(() => sync({ files, current: ui, baseline }), 'import_stage_gap');
  });

  it('refuses per-unit Construction progress', () => {
    const { ui, baseline } = linked();
    const files = editState(cliPlanned(), '- [-] code-generation', '- [x] code-generation');
    expectCode(() => sync({ files, current: ui, baseline }), 'import_parallel_unsupported');
  });

  it('refuses a stage skipped or unskipped in the CLI since the baseline', () => {
    const { ui, baseline } = linked();
    const files = editState(cliWorkspace(), '- [-] workflow-planning', '- [S] workflow-planning');
    expectCode(() => sync({ files, current: ui, baseline }), 'import_scope_changed');
  });

  it('refuses a stage the CLI moved backwards from the baseline', () => {
    const { ui, baseline } = linked();
    const files = editState(cliWorkspace(), '- [x] intent-capture', '- [ ] intent-capture');
    expectCode(() => sync({ files, current: ui, baseline }), 'import_stage_regressed');
  });

  it('refuses a CLI edit to an artifact of a stage complete at the baseline', () => {
    const { ui, baseline } = linked();
    const files = cliWorkspace();
    files.set(`${ROOT}/ideation/intent-capture/intent.md`, '# Intent\n\nRewritten in CLI.\n');
    expectCode(() => sync({ files, current: ui, baseline }), 'import_completed_stage_changed');
  });

  it('refuses a workspace exported from a different intent', () => {
    const { ui, baseline } = linked();
    ui.intent.intentId = 'intent-2';
    expectCode(
      () => sync({ files: cliWorkspace(), current: ui, baseline }),
      'import_intent_mismatch',
    );
  });

  it('refuses a workspace pinned to another AI-DLC release', () => {
    const { ui, baseline } = linked();
    ui.upstreamRef = 'def456';
    expectCode(
      () => sync({ files: cliWorkspace(), current: ui, baseline }),
      'import_release_mismatch',
    );
  });

  it('refuses to sync without a baseline, or with the baseline of another intent', () => {
    const { ui, baseline } = linked();
    expectCode(
      () => sync({ files: cliWorkspace(), current: ui, baseline: null }),
      'import_sync_baseline_invalid',
    );
    expectCode(
      () =>
        sync({
          files: cliWorkspace(),
          current: ui,
          baseline: { ...baseline, intentId: 'intent-2' },
        }),
      'import_sync_baseline_invalid',
    );
  });
});
