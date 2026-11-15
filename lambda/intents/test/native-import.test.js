import archiver from 'archiver';
import { describe, expect, it, vi } from 'vitest';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { buildZip } from '../native-export.js';
import {
  IMPORT_EDIT_ORIGIN,
  createImportUpload,
  importPlanToken,
  importPreview,
  importUploadKey,
  loadImportUpload,
  readImportBundle,
  writeImportedRecords,
} from '../native-import.js';

const UPLOAD_ID = '6f1c1d4e-9a7b-4c1a-8f3e-2b5d7c9e0a12';

const zipOf = (entries) =>
  buildZip(new Map(Object.entries(entries).map(([path, body]) => [path, Buffer.from(body)])));

const jsonBundle = (files) =>
  Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      files: Object.entries(files).map(([path, content]) => ({ path, content })),
    }),
  );

const expectCode = async (promise, code) => {
  await expect(promise).rejects.toMatchObject({ code });
};

const plan = () => ({
  intentId: 'intent-1',
  continuationStageId: 'workflow-planning',
  workflowComplete: false,
  stageCompletions: [
    {
      stageId: 'requirements-analysis',
      stageInstanceId: 'si-requirements',
      phase: 'inception',
      startedAt: '2026-08-11T10:21:00.000Z',
      completedAt: '2026-08-12T08:00:00.000Z',
    },
    {
      stageId: 'user-stories',
      stageInstanceId: 'si-stories',
      phase: 'inception',
      startedAt: '2026-08-12T08:00:00.001Z',
      completedAt: '2026-08-12T08:30:00.000Z',
    },
  ],
  artifactWrites: [
    {
      path: 'aidlc/spaces/default/intents/x/inception/requirements-analysis/requirements.md',
      artifactType: 'requirements',
      stageId: 'requirements-analysis',
      phase: 'inception',
      stageInstanceId: 'si-requirements',
      unitSlug: null,
      repository: null,
      previousArtifactId: 'artifact-requirements',
      content: '# Requirements\n',
    },
    {
      path: 'aidlc/spaces/default/intents/x/inception/user-stories/stories.md',
      artifactType: 'stories',
      stageId: 'user-stories',
      phase: 'inception',
      stageInstanceId: 'si-stories',
      unitSlug: null,
      repository: null,
      previousArtifactId: null,
      content: '# Stories\n',
    },
  ],
  answers: [
    {
      humanTaskId: 'q-requirements',
      stageId: 'requirements-analysis',
      answer: { answers: [{ selectedOptions: [0], freeText: '' }] },
    },
  ],
  gateResolutions: [
    { humanTaskId: 'approval-1', kind: 'approval', stageId: 'requirements-analysis' },
  ],
  ignoredFiles: [{ path: 'aidlc/spaces/default/memory/team.md', reason: 'not imported' }],
  warnings: [],
});

describe('readImportBundle', () => {
  it('keeps only the workspace record entries of an export ZIP', async () => {
    const files = await readImportBundle(
      await zipOf({
        'export-manifest.json': '{}',
        'aidlc/spaces/default/intents/x/aidlc-state.md': '# State\n',
        'aidlc-docs/aidlc-state.md': '# Flat\n',
        '.claude/tools/data/stage-graph.json': '[]',
        'checkout-api/src/index.js': 'code',
      }),
    );
    expect([...files.keys()].toSorted()).toEqual([
      'aidlc-docs/aidlc-state.md',
      'aidlc/spaces/default/intents/x/aidlc-state.md',
      'export-manifest.json',
    ]);
    expect(files.get('aidlc/spaces/default/intents/x/aidlc-state.md')).toBe('# State\n');
  });

  it('reads a JSON file bundle assembled from a branch', async () => {
    const files = await readImportBundle(
      jsonBundle({ 'export-manifest.json': '{}', 'aidlc/a.md': 'A', 'repos.json': '{}' }),
    );
    expect(Object.fromEntries(files)).toEqual({ 'export-manifest.json': '{}', 'aidlc/a.md': 'A' });
  });

  it('rejects a ZIP entry that escapes the workspace', async () => {
    // buildZip refuses such names, so write the hostile archive directly.
    const archive = archiver('zip');
    const chunks = [];
    archive.on('data', (chunk) => chunks.push(chunk));
    const ended = new Promise((resolve) => archive.on('end', resolve));
    archive.append(Buffer.from('ok'), { name: 'aidlc/ok.md' });
    archive.append(Buffer.from('x'), { name: 'aidlc/../../evil.md' });
    await archive.finalize();
    await ended;
    await expectCode(readImportBundle(Buffer.concat(chunks)), 'import_bundle_invalid');
  });

  it('rejects a workspace record file over the per-file limit', async () => {
    const zip = await zipOf({ 'aidlc/big.md': 'x'.repeat(5 * 1024 * 1024 + 1) });
    await expectCode(readImportBundle(zip), 'import_bundle_too_large');
  });

  it('rejects uploads that are neither ZIP nor bundle', async () => {
    await expectCode(readImportBundle(Buffer.from('hello')), 'import_bundle_invalid');
    await expectCode(readImportBundle(Buffer.from('{"schemaVersion":2}')), 'import_bundle_invalid');
    await expectCode(
      readImportBundle(Buffer.from('{"schemaVersion":1,"files":[{"path":"aidlc/a.md"}]}')),
      'import_bundle_invalid',
    );
  });
});

describe('createImportUpload', () => {
  it('presigns an exact-size upload under the intent import prefix', async () => {
    const presign = vi.fn(async () => ({ url: 'https://bucket', fields: { key: 'k' } }));
    const upload = await createImportUpload({
      s3: {},
      bucket: 'artifacts',
      intentId: 'intent-1',
      format: 'zip',
      size: 1234,
      presign,
    });
    expect(upload).toMatchObject({ url: 'https://bucket', expiresIn: 900 });
    expect(upload.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(presign).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        Bucket: 'artifacts',
        Key: `workflow-imports/intent-1/${upload.uploadId}`,
        Conditions: [
          ['eq', '$Content-Type', 'application/zip'],
          ['content-length-range', 1234, 1234],
        ],
      }),
    );
  });

  it('rejects unknown formats and out-of-range sizes', async () => {
    const args = { s3: {}, bucket: 'b', intentId: 'i', presign: vi.fn() };
    await expectCode(
      createImportUpload({ ...args, format: 'tar', size: 1 }),
      'import_upload_invalid',
    );
    await expectCode(
      createImportUpload({ ...args, format: 'zip', size: 0 }),
      'import_upload_invalid',
    );
    await expectCode(
      createImportUpload({ ...args, format: 'zip', size: 100 * 1024 * 1024 + 1 }),
      'import_upload_invalid',
    );
  });
});

describe('loadImportUpload', () => {
  it('reads the uploaded object for this intent only', async () => {
    const send = vi.fn(async () => ({
      ContentLength: 10,
      LastModified: new Date('2026-08-12T09:00:00.000Z'),
      Body: jsonBundle({ 'aidlc/a.md': 'A' }),
    }));
    const { files, uploadedAt } = await loadImportUpload({
      s3: { send },
      bucket: 'artifacts',
      intentId: 'intent-1',
      uploadId: UPLOAD_ID,
    });
    expect(files.get('aidlc/a.md')).toBe('A');
    expect(uploadedAt).toBe('2026-08-12T09:00:00.000Z');
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'artifacts',
      Key: importUploadKey('intent-1', UPLOAD_ID),
    });
  });

  it('refuses upload ids that are not UUIDs (no key injection)', async () => {
    await expectCode(
      loadImportUpload({ s3: {}, bucket: 'b', intentId: 'i', uploadId: '../intent-2/x' }),
      'import_upload_invalid',
    );
  });

  it('reports a missing or expired upload', async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    });
    await expectCode(
      loadImportUpload({ s3: { send }, bucket: 'b', intentId: 'i', uploadId: UPLOAD_ID }),
      'import_upload_missing',
    );
  });
});

describe('importPlanToken and importPreview', () => {
  it('is stable for the same plan and changes with any artifact content', () => {
    const first = importPlanToken(plan());
    expect(importPlanToken(plan())).toBe(first);
    const edited = plan();
    edited.artifactWrites[1].content = '# Stories, edited\n';
    expect(importPlanToken(edited)).not.toBe(first);
  });

  it('summarizes the plan without artifact bodies', () => {
    const preview = importPreview(plan());
    expect(preview.planToken).toBe(importPlanToken(plan()));
    expect(preview.artifactWrites).toEqual([
      expect.objectContaining({ change: 'update', bytes: 15, stageId: 'requirements-analysis' }),
      expect.objectContaining({ change: 'create', bytes: 10, stageId: 'user-stories' }),
    ]);
    expect(JSON.stringify(preview)).not.toContain('# Stories');
  });
});

describe('writeImportedRecords', () => {
  const deps = () => {
    const calls = [];
    const store = {
      answerHumanTask: vi.fn(async (input) => {
        calls.push(['answer', input.humanTaskId]);
        return { humanTaskId: input.humanTaskId, status: 'answered' };
      }),
      getStage: vi.fn(async (_id, stageInstanceId) => {
        calls.push(['getStage', stageInstanceId]);
        return stageInstanceId === 'si-requirements' ? { stageInstanceId } : null;
      }),
      putStage: vi.fn(async (input) => calls.push(['putStage', input.stageInstanceId])),
      updateStageState: vi.fn(async (input) => calls.push(['stage', input.stageInstanceId])),
    };
    const createArtifact = vi.fn(async ({ id }) => {
      calls.push(['create', id]);
      return { id };
    });
    const createWriter = vi.fn(() => ({ createArtifact }));
    const applyArtifactEdit = vi.fn(async ({ artifactId }) => calls.push(['edit', artifactId]));
    return { calls, store, createWriter, createArtifact, applyArtifactEdit };
  };

  const run = (d, value = plan()) =>
    writeImportedRecords({
      store: d.store,
      createWriter: d.createWriter,
      applyArtifactEdit: d.applyArtifactEdit,
      intentId: 'intent-1',
      projectId: 'project-1',
      aidlcRepoRef: 'abc123',
      plan: value,
      importId: 'import-1',
      actor: { sub: 'user-1', displayName: 'Dana' },
      now: '2026-08-12T09:00:00.000Z',
    });

  it('writes artifacts, then answers, then stage rows', async () => {
    const d = deps();
    await run(d);
    const kinds = d.calls.map(([kind]) => kind);
    expect(kinds.lastIndexOf('edit')).toBeLessThan(kinds.indexOf('answer'));
    expect(kinds.indexOf('answer')).toBeLessThan(kinds.indexOf('stage'));
  });

  it('creates new artifacts in the producing stage scope and stamps cli-import provenance on all', async () => {
    const d = deps();
    const { artifactIds } = await run(d);
    expect(d.createWriter).toHaveBeenCalledTimes(1);
    expect(d.createWriter).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: 'intent-1',
        executionId: 'intent-1',
        stageInstanceId: 'si-stories',
        systemWriter: true,
      }),
    );
    expect(artifactIds[0]).toBe('artifact-requirements');
    expect(d.applyArtifactEdit).toHaveBeenCalledTimes(2);
    for (const [input] of d.applyArtifactEdit.mock.calls) {
      expect(input).toMatchObject({ origin: IMPORT_EDIT_ORIGIN, editRef: 'import-1' });
    }
  });

  it('completes existing rows and creates missing rows pinned to the intent release', async () => {
    const d = deps();
    await run(d);
    expect(d.store.putStage).toHaveBeenCalledTimes(1);
    expect(d.store.putStage).toHaveBeenCalledWith(
      expect.objectContaining({
        stageInstanceId: 'si-stories',
        state: 'SUCCEEDED',
        aidlcRepoRef: 'abc123',
      }),
    );
    expect(d.store.updateStageState).toHaveBeenCalledWith(
      expect.objectContaining({
        stageInstanceId: 'si-requirements',
        state: 'SUCCEEDED',
        completedAt: '2026-08-12T08:00:00.000Z',
        pendingHumanTaskId: null,
      }),
    );
  });

  it('stops before stage rows when a gate was answered concurrently', async () => {
    const d = deps();
    d.store.answerHumanTask.mockResolvedValueOnce(null);
    await expectCode(run(d), 'import_gate_changed');
    expect(d.store.updateStageState).not.toHaveBeenCalled();
  });

  it('refuses a completion without a stage instance', async () => {
    const d = deps();
    const value = plan();
    value.artifactWrites = [];
    value.answers = [];
    value.stageCompletions[0].stageInstanceId = null;
    await expectCode(run(d, value), 'import_stage_unresolved');
  });
});
