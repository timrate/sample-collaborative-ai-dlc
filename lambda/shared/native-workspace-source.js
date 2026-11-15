// Where an imported native AI-DLC workspace comes from, and how much of it is
// read. The importer (native-workspace-importer.js) needs only the export
// manifest and the workspace record, so every source keeps the same paths and
// applies the same limits:
//
//  - an upload (export ZIP or file bundle), parsed by the intents Lambda;
//  - a repository branch, read here through the shared git providers.

const IMPORT_MAX_FILES = 5000;
const IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const IMPORT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const BRANCH_READ_CONCURRENCY = 8;

const importError = (code, message) =>
  Object.assign(new Error(`native-import: ${message}`), { code });

const isImportedPath = (path) =>
  path === 'export-manifest.json' || path.startsWith('aidlc/') || path.startsWith('aidlc-docs/');

// Size limits apply to the kept entries only; a ZIP's harness and code-repo
// entries are skipped by name before anything is inflated, and a branch's are
// never fetched.
const createBundleBudget = () => {
  let files = 0;
  let bytes = 0;
  return (path, size) => {
    files += 1;
    bytes += size;
    if (size > IMPORT_MAX_FILE_BYTES) {
      throw importError('import_bundle_too_large', `${path} exceeds the 5 MB per-file limit`);
    }
    if (files > IMPORT_MAX_FILES || bytes > IMPORT_MAX_TOTAL_BYTES) {
      throw importError(
        'import_bundle_too_large',
        'the workspace record exceeds the import limits (5000 files, 50 MB)',
      );
    }
  };
};

const mapConcurrently = async (items, limit, task) => {
  const results = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

// Read the workspace record from a repository branch.
//
// `provider` is a shared git provider (lambda/shared/git-providers.js) and
// `ctx` its credential context; the caller resolves both, so this module never
// touches credentials. When the branch head still equals `knownHeadSha`
// nothing else is read. The head is read again after the files: a push in
// between would mix two commits, so that read is refused and can be retried.
const readWorkspaceBranch = async ({ provider, ctx, repoId, branch, knownHeadSha = null }) => {
  const headSha = await provider.getBranchHead(ctx, repoId, branch);
  if (!headSha) {
    throw importError('import_source_missing', `branch ${branch} was not found in ${repoId}`);
  }
  if (knownHeadSha && headSha === knownHeadSha) return { headSha, unchanged: true, files: null };

  const tree = (await provider.getTree(ctx, repoId, branch)).filter((entry) =>
    isImportedPath(entry.path),
  );
  // Refuse an oversized record from the tree listing, before any file is
  // fetched. Providers that list no sizes are charged on the content below.
  const listed = createBundleBudget();
  for (const entry of tree) listed(entry.path, Number.isFinite(entry.size) ? entry.size : 0);

  const charge = createBundleBudget();
  const contents = await mapConcurrently(tree, BRANCH_READ_CONCURRENCY, async (entry) => {
    const file = await provider.getFileContents(ctx, repoId, entry.path, branch);
    const content = String(file?.content ?? '');
    charge(entry.path, Buffer.byteLength(content));
    return [entry.path, content];
  });

  if ((await provider.getBranchHead(ctx, repoId, branch)) !== headSha) {
    throw importError(
      'import_source_changed',
      `branch ${branch} received a push while it was being read; try again`,
    );
  }
  return { headSha, unchanged: false, files: new Map(contents) };
};

export {
  IMPORT_MAX_FILES,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_TOTAL_BYTES,
  createBundleBudget,
  isImportedPath,
  readWorkspaceBranch,
};
