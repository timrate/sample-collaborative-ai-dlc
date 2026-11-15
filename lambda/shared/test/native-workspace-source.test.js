import { describe, expect, it } from 'vitest';
import {
  IMPORT_MAX_FILES,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_TOTAL_BYTES,
  readWorkspaceBranch,
} from '../native-workspace-source.js';

const CTX = { token: 'ctx-token' };
const STATE = 'aidlc/spaces/default/intents/260811-payment-service/aidlc-state.md';

// A git provider over an in-memory branch. `heads` is consumed one entry per
// getBranchHead call, so a test can move the branch during the read.
const fakeProvider = ({ files, heads = ['sha-1'], sizes = true }) => {
  const calls = { head: 0, tree: 0, contents: [] };
  const remaining = [...heads];
  return {
    calls,
    getBranchHead: async (ctx, repoId, branch) => {
      expect([ctx, repoId, branch]).toEqual([CTX, 'acme/workspace', 'cli-work']);
      calls.head += 1;
      return remaining.length > 1 ? remaining.shift() : remaining[0];
    },
    getTree: async () => {
      calls.tree += 1;
      return Object.entries(files).map(([path, content]) => ({
        path,
        sha: `blob-${path}`,
        ...(sizes ? { size: Buffer.byteLength(content) } : {}),
      }));
    },
    getFileContents: async (ctx, repoId, path, branch) => {
      expect(branch).toBe('cli-work');
      calls.contents.push(path);
      return { path, content: files[path] };
    },
  };
};

const read = (provider, extra = {}) =>
  readWorkspaceBranch({
    provider,
    ctx: CTX,
    repoId: 'acme/workspace',
    branch: 'cli-work',
    ...extra,
  });

const expectCode = async (promise, code) => {
  const error = await promise.then(
    () => null,
    (caught) => caught,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(Error);
  expect(error.code).toBe(code);
  expect(error.message).toMatch(/^native-import: /);
};

describe('readWorkspaceBranch', () => {
  it('keeps the manifest and the workspace record, and never fetches anything else', async () => {
    const provider = fakeProvider({
      files: {
        'export-manifest.json': '{}',
        [STATE]: '# State\n',
        'aidlc-docs/inception/requirements.md': '# Requirements\n',
        '.claude/skills/aidlc/SKILL.md': '# Skill\n',
        'src/index.js': 'export {};\n',
        'aidlc.md': 'not the record\n',
      },
    });
    const result = await read(provider);

    expect(result.headSha).toBe('sha-1');
    expect(result.unchanged).toBe(false);
    expect([...result.files.keys()].toSorted()).toEqual([
      'aidlc-docs/inception/requirements.md',
      STATE,
      'export-manifest.json',
    ]);
    expect(result.files.get(STATE)).toBe('# State\n');
    expect(provider.calls.contents.toSorted()).toEqual([...result.files.keys()].toSorted());
  });

  it('stops at the branch head when it equals the last synced commit', async () => {
    const provider = fakeProvider({ files: { [STATE]: '# State\n' } });
    const result = await read(provider, { knownHeadSha: 'sha-1' });

    expect(result).toEqual({ headSha: 'sha-1', unchanged: true, files: null });
    expect(provider.calls).toEqual({ head: 1, tree: 0, contents: [] });
  });

  it('reads the branch when the head moved past the last synced commit', async () => {
    const provider = fakeProvider({ files: { [STATE]: '# State\n' }, heads: ['sha-2'] });
    const result = await read(provider, { knownHeadSha: 'sha-1' });

    expect(result.headSha).toBe('sha-2');
    expect(result.files.size).toBe(1);
  });

  it('refuses a branch that does not exist', async () => {
    const provider = fakeProvider({ files: {}, heads: [null] });
    await expectCode(read(provider), 'import_source_missing');
    expect(provider.calls.tree).toBe(0);
  });

  it('refuses a read that a push interrupted', async () => {
    const provider = fakeProvider({ files: { [STATE]: '# State\n' }, heads: ['sha-1', 'sha-2'] });
    await expectCode(read(provider), 'import_source_changed');
  });

  it('refuses a file over the per-file limit before fetching anything', async () => {
    const provider = fakeProvider({
      files: { [STATE]: 'x'.repeat(IMPORT_MAX_FILE_BYTES + 1) },
    });
    await expectCode(read(provider), 'import_bundle_too_large');
    expect(provider.calls.contents).toEqual([]);
  });

  it('refuses more files than the limit before fetching anything', async () => {
    const files = Object.fromEntries(
      Array.from({ length: IMPORT_MAX_FILES + 1 }, (_, index) => [`aidlc/f${index}.md`, 'x']),
    );
    const provider = fakeProvider({ files });
    await expectCode(read(provider), 'import_bundle_too_large');
    expect(provider.calls.contents).toEqual([]);
  });

  it('refuses a record over the total limit', async () => {
    const chunk = 'x'.repeat(IMPORT_MAX_FILE_BYTES);
    const count = Math.floor(IMPORT_MAX_TOTAL_BYTES / IMPORT_MAX_FILE_BYTES) + 1;
    const files = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`aidlc/f${index}.md`, chunk]),
    );
    await expectCode(read(fakeProvider({ files })), 'import_bundle_too_large');
  });

  it('applies the limits to the content when the provider lists no sizes', async () => {
    const provider = fakeProvider({
      files: { [STATE]: 'x'.repeat(IMPORT_MAX_FILE_BYTES + 1) },
      sizes: false,
    });
    await expectCode(read(provider), 'import_bundle_too_large');
    expect(provider.calls.contents).toEqual([STATE]);
  });

  it('ignores files outside the record when counting towards the limits', async () => {
    const provider = fakeProvider({
      files: {
        [STATE]: '# State\n',
        'build/bundle.js': 'x'.repeat(IMPORT_MAX_FILE_BYTES + 1),
      },
    });
    const result = await read(provider);
    expect([...result.files.keys()]).toEqual([STATE]);
  });
});
