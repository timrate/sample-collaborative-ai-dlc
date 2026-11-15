// Re-attach import of a native AI-DLC workspace (the inverse of native-export).
//
// The workspace arrives either as one S3 object uploaded through a presigned
// POST (the export ZIP itself, after the CLI advanced it, or a JSON file
// bundle), or as a workspace repository branch the handler reads through the
// project source-control service (readWorkspaceBranch).
// Only the files the importer reads are kept (`export-manifest.json`,
// `aidlc/**`, `aidlc-docs/**`); harness and code-repository entries are
// skipped without being decompressed.
//
// The plan itself comes from lambda/shared/native-workspace-importer.js. This
// module owns the transport (upload, bundle parsing), the preview/confirm
// token, and the record writes the intents handler performs after it has
// retired the parked run.

import { createHash, randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import yauzl from 'yauzl';
import { createBundleBudget, isImportedPath } from '../shared/native-workspace-source.js';
import { bodyToBuffer } from './native-export.js';

const IMPORT_MAX_BYTES = 100 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 15 * 60;
const IMPORT_EDIT_ORIGIN = 'cli-import';
const UPLOAD_CONTENT_TYPES = { zip: 'application/zip', json: 'application/json' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const importError = (code, message) =>
  Object.assign(new Error(`native-import: ${message}`), { code });

const sha256 = (body) => createHash('sha256').update(body).digest('hex');

const importUploadKey = (intentId, uploadId) => `workflow-imports/${intentId}/${uploadId}`;

const readZipBundle = (buffer) =>
  new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true },
      (openError, zip) => {
        if (openError) {
          reject(
            importError('import_bundle_invalid', `the ZIP cannot be read: ${openError.message}`),
          );
          return;
        }
        const files = new Map();
        const charge = createBundleBudget();
        const fail = (error) => {
          zip.close();
          reject(
            error.code
              ? error
              : importError('import_bundle_invalid', `the ZIP cannot be read: ${error.message}`),
          );
        };
        zip.on('error', fail);
        zip.on('end', () => resolve(files));
        zip.on('entry', (entry) => {
          const path = entry.fileName;
          if (path.endsWith('/') || !isImportedPath(path)) {
            zip.readEntry();
            return;
          }
          try {
            charge(path, entry.uncompressedSize);
          } catch (error) {
            fail(error);
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) {
              fail(streamError);
              return;
            }
            const chunks = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('error', fail);
            stream.on('end', () => {
              files.set(path, Buffer.concat(chunks).toString('utf8'));
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });

// `{ "schemaVersion": 1, "files": [{ "path": "...", "content": "..." }] }`
const readJsonBundle = (buffer) => {
  let bundle;
  try {
    bundle = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw importError('import_bundle_invalid', 'the file bundle is not valid JSON');
  }
  if (bundle?.schemaVersion !== 1 || !Array.isArray(bundle.files)) {
    throw importError('import_bundle_invalid', 'the file bundle is not a supported format');
  }
  const files = new Map();
  const charge = createBundleBudget();
  for (const entry of bundle.files) {
    if (typeof entry?.path !== 'string' || typeof entry.content !== 'string') {
      throw importError('import_bundle_invalid', 'every bundle entry needs a path and content');
    }
    if (!isImportedPath(entry.path)) continue;
    if (files.has(entry.path)) {
      throw importError('import_bundle_invalid', `the bundle lists ${entry.path} twice`);
    }
    charge(entry.path, Buffer.byteLength(entry.content));
    files.set(entry.path, entry.content);
  }
  return files;
};

const readImportBundle = async (buffer) => {
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) return readZipBundle(buffer);
  if (buffer.toString('utf8', 0, Math.min(buffer.length, 64)).trimStart().startsWith('{')) {
    return readJsonBundle(buffer);
  }
  throw importError('import_bundle_invalid', 'the upload is neither a ZIP nor a file bundle');
};

const createImportUpload = async ({
  s3,
  bucket,
  intentId,
  format,
  size,
  presign = createPresignedPost,
}) => {
  const contentType = UPLOAD_CONTENT_TYPES[format];
  if (!contentType) throw importError('import_upload_invalid', 'format must be zip or json');
  if (!Number.isInteger(size) || size < 1 || size > IMPORT_MAX_BYTES) {
    throw importError('import_upload_invalid', 'size must be between 1 byte and 100 MB');
  }
  const uploadId = randomUUID();
  const post = await presign(s3, {
    Bucket: bucket,
    Key: importUploadKey(intentId, uploadId),
    Expires: UPLOAD_TTL_SECONDS,
    Fields: { 'Content-Type': contentType },
    Conditions: [
      ['eq', '$Content-Type', contentType],
      ['content-length-range', size, size],
    ],
  });
  return { uploadId, ...post, expiresIn: UPLOAD_TTL_SECONDS };
};

const loadImportUpload = async ({ s3, bucket, intentId, uploadId }) => {
  if (typeof uploadId !== 'string' || !UUID_RE.test(uploadId)) {
    throw importError('import_upload_invalid', 'uploadId is not a valid upload');
  }
  let result;
  try {
    result = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: importUploadKey(intentId, uploadId) }),
    );
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
      throw importError('import_upload_missing', 'the upload was not found or has expired');
    }
    throw error;
  }
  if (Number(result.ContentLength) > IMPORT_MAX_BYTES) {
    throw importError('import_bundle_too_large', 'the upload exceeds the 100 MB limit');
  }
  // The upload time is the plan's clock (for completions the workspace does
  // not timestamp), so a preview and its confirm plan identically.
  const uploadedAt = result.LastModified ? new Date(result.LastModified).toISOString() : null;
  return { files: await readImportBundle(await bodyToBuffer(result.Body)), uploadedAt };
};

// The token binds a confirm to exactly the preview the member saw: any change
// to the workspace or to the intent between preview and confirm changes it.
// planReattach builds plans with a fixed key order and sorted file lists, so
// plain JSON serialization is stable for equal plans.
// `binding` carries what else the confirm must repeat: the branch commit and
// whether the member asked to keep syncing.
const importPlanToken = (plan, binding = {}) =>
  sha256(
    JSON.stringify({
      ...plan,
      artifactWrites: plan.artifactWrites.map(({ content, ...write }) => ({
        ...write,
        contentSha256: sha256(content),
      })),
      ...(Object.keys(binding).length > 0 ? { binding } : {}),
    }),
  );

const hasRecordChanges = (plan) =>
  plan.stageCompletions.length > 0 ||
  plan.artifactWrites.length > 0 ||
  plan.answers.length > 0 ||
  plan.gateResolutions.length > 0;

const importPreview = (plan, binding = {}) => ({
  planToken: importPlanToken(plan, binding),
  // Sync plans only: conflicts block the import, UI-owned files are kept.
  ...(plan.conflicts ? { conflicts: plan.conflicts, uiOwnedFiles: plan.uiOwnedFiles } : {}),
  continuationStageId: plan.continuationStageId,
  workflowComplete: plan.workflowComplete,
  stageCompletions: plan.stageCompletions.map(({ stageId, phase, completedAt }) => ({
    stageId,
    phase,
    completedAt,
  })),
  artifactWrites: plan.artifactWrites.map((write) => ({
    path: write.path,
    artifactType: write.artifactType,
    stageId: write.stageId,
    change: write.previousArtifactId ? 'update' : 'create',
    bytes: Buffer.byteLength(write.content),
  })),
  answeredGates: plan.answers.map(({ humanTaskId, stageId }) => ({ humanTaskId, stageId })),
  resolvedGates: plan.gateResolutions,
  ignoredFiles: plan.ignoredFiles,
  warnings: plan.warnings,
});

// --- Branch source and continuous sync -------------------------------------
// docs/fork-plan/cli-progress-sync-design.md. The intents Lambda reads a
// workspace branch through the project source-control service, which checks
// the repository is attached to the project and resolves the binding's own
// read credential. No credential reaches this Lambda.

const BRANCH_NAME_MAX = 255;

const validateBranchSource = (source) => {
  const provider = typeof source?.provider === 'string' ? source.provider : '';
  const repo = typeof source?.repo === 'string' ? source.repo.trim() : '';
  const branch = typeof source?.branch === 'string' ? source.branch.trim() : '';
  if (
    !['github', 'gitlab', 'bitbucket', 'codecommit'].includes(provider) ||
    !repo ||
    !branch ||
    branch.length > BRANCH_NAME_MAX ||
    branch.startsWith('-') ||
    branch.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw importError('import_source_invalid', 'source needs a provider, repository and branch');
  }
  return { provider, repo, branch };
};

// A shared-git-provider shape over the source-control service, for
// readWorkspaceBranch. Service failures arrive with an allowlisted code only.
const sourceControlGitProvider = ({ operate, projectId, provider, repo }) => {
  const call = async (operation, args) => {
    try {
      return await operate({ projectId, provider, repo, operation, args });
    } catch (error) {
      throw importError(
        'import_source_unavailable',
        `the branch could not be read (${error?.code || 'SOURCE_CONTROL_OPERATION_FAILED'})`,
      );
    }
  };
  return {
    getBranchHead: (_ctx, _repo, branch) => call('branch-head', { branch }),
    getTree: async (_ctx, _repo, branch) => {
      const tree = await call('tree', { branch });
      return Array.isArray(tree) ? tree : (tree?.tree ?? []);
    },
    getFileContents: (_ctx, _repo, path, branch) => call('contents', { path, branch }),
  };
};

// A branch read carries no upload time, so the preview fixes the plan's clock
// and the confirm repeats it; the plan token binds the two. A confirm may not
// move the clock outside the preview window.
const resolvePlanClock = ({ dryRun, plannedAt, now = Date.now() }) => {
  if (dryRun) return new Date(now).toISOString();
  const at = typeof plannedAt === 'string' ? Date.parse(plannedAt) : Number.NaN;
  if (!Number.isFinite(at) || at > now + 60_000 || now - at > UPLOAD_TTL_SECONDS * 1000) {
    throw importError(
      'import_plan_changed',
      'the preview has expired or is missing its plan time; review the import again',
    );
  }
  return new Date(at).toISOString();
};

// One object per baseline, never overwritten: META.cliSync.baselineId names
// the current one, so a sync writes the next baseline first and switches the
// id in the same META update that records the import. A failure before that
// switch leaves the previous baseline in effect. The prefix is outside
// workflow-imports/, whose objects expire after a day.
const syncBaselineKey = (intentId, baselineId) => `workflow-sync/${intentId}/${baselineId}.json`;

const storeSyncBaseline = async ({ s3, bucket, intentId, baseline }) => {
  const baselineId = randomUUID();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: syncBaselineKey(intentId, baselineId),
      Body: JSON.stringify(baseline),
      ContentType: 'application/json',
    }),
  );
  return baselineId;
};

const loadSyncBaseline = async ({ s3, bucket, intentId, baselineId }) => {
  const invalid = () =>
    importError(
      'import_sync_baseline_invalid',
      'the sync baseline for this intent is missing; unlink the branch and import again with Keep syncing',
    );
  if (typeof baselineId !== 'string' || !UUID_RE.test(baselineId)) throw invalid();
  let result;
  try {
    result = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: syncBaselineKey(intentId, baselineId) }),
    );
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) throw invalid();
    throw error;
  }
  try {
    return JSON.parse((await bodyToBuffer(result.Body)).toString('utf8'));
  } catch {
    throw invalid();
  }
};

// Best effort: a baseline left behind is unreferenced and is purged with the
// intent.
const deleteSyncBaseline = async ({ s3, bucket, intentId, baselineId }) => {
  if (typeof baselineId !== 'string' || !UUID_RE.test(baselineId)) return;
  try {
    await s3.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: syncBaselineKey(intentId, baselineId) }),
    );
  } catch {
    // Unreferenced; removed with the intent.
  }
};

const importedArtifactId = (write) =>
  `imported-${sha256(`${write.stageId}\0${write.artifactType}`).slice(0, 16)}`;

// Writes everything the plan changes except META and run retirement, which
// the handler owns. Order: artifacts (the slowest, Neptune) first, then gate
// answers, then stage rows, so a failure leaves stages unfinished rather than
// complete without their outputs.
const writeImportedRecords = async ({
  store,
  createWriter,
  applyArtifactEdit,
  intentId,
  projectId,
  aidlcRepoRef,
  plan,
  importId,
  actor,
  now,
}) => {
  const artifactIds = [];
  for (const write of plan.artifactWrites) {
    let artifactId = write.previousArtifactId;
    if (!artifactId) {
      const writer = createWriter({
        intentId,
        projectId,
        executionId: intentId,
        stageInstanceId: write.stageInstanceId,
        systemWriter: true,
      });
      const created = await writer.createArtifact({
        artifactType: write.artifactType,
        id: importedArtifactId(write),
        title: write.path.split('/').at(-1),
        content: write.content,
        props: write.repository ? { repository: write.repository } : {},
      });
      artifactId = created?.id ?? importedArtifactId(write);
    }
    await applyArtifactEdit({
      intentId,
      artifactId,
      content: write.content,
      editedBy: actor.sub,
      editedByName: actor.displayName ?? '',
      origin: IMPORT_EDIT_ORIGIN,
      editRef: importId,
      now,
    });
    artifactIds.push(artifactId);
  }

  const answered = [];
  for (const { humanTaskId, answer } of plan.answers) {
    const task = await store.answerHumanTask({
      executionId: intentId,
      humanTaskId,
      status: 'answered',
      answer,
      answeredBy: actor.sub,
      answeredByName: actor.displayName ?? '',
    });
    if (!task) {
      throw importError(
        'import_gate_changed',
        `gate ${humanTaskId} was answered or retired during the import`,
      );
    }
    answered.push(task);
  }

  for (const completion of plan.stageCompletions) {
    if (!completion.stageInstanceId) {
      throw importError(
        'import_stage_unresolved',
        `stage ${completion.stageId} has no stage instance in the pinned plan`,
      );
    }
    const existing = await store.getStage(intentId, completion.stageInstanceId, {
      consistentRead: true,
    });
    if (!existing) {
      await store.putStage({
        executionId: intentId,
        stageInstanceId: completion.stageInstanceId,
        stageId: completion.stageId,
        phase: completion.phase,
        state: 'SUCCEEDED',
        aidlcRepoRef,
      });
    }
    await store.updateStageState({
      executionId: intentId,
      stageInstanceId: completion.stageInstanceId,
      state: 'SUCCEEDED',
      completedAt: completion.completedAt,
      pendingHumanTaskId: null,
    });
  }

  return { artifactIds, answered };
};

export {
  IMPORT_EDIT_ORIGIN,
  IMPORT_MAX_BYTES,
  UPLOAD_TTL_SECONDS,
  createImportUpload,
  deleteSyncBaseline,
  hasRecordChanges,
  importPlanToken,
  importPreview,
  importUploadKey,
  loadImportUpload,
  loadSyncBaseline,
  readImportBundle,
  resolvePlanClock,
  sourceControlGitProvider,
  storeSyncBaseline,
  syncBaselineKey,
  validateBranchSource,
  writeImportedRecords,
};
