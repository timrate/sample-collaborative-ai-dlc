import { describe, expect, it, vi } from 'vitest';
import { syncBranch } from '../commands/sync-branch.js';

const args = {
  projectId: 'p1',
  intentId: 'i1',
  executionId: 'i1',
  repos: ['acme/api'],
  branch: 'aidlc/i1',
  gitProvider: 'github',
  workspaceDir: '/mnt/workspace',
  requestedByName: 'Sam',
};

const storeSpy = () => {
  const events = [];
  return {
    events,
    getExecution: async () => ({ title: 'Checkout flow' }),
    appendEvent: async (event) => {
      events.push(event);
    },
  };
};

const deps = (overrides = {}) => ({
  store: storeSpy(),
  broadcast: vi.fn(async () => {}),
  ensureWorkspaceSource: async () => ({ restored: false, repos: [], failed: [] }),
  syncAllBranches: async () => ({ ok: true, changed: false, conflicted: false, results: [] }),
  pushBranch: vi.fn(async () => ({ pushed: true, sha: 'f'.repeat(40) })),
  ...overrides,
});

describe('sync-branch', () => {
  it('refuses while a job holds the session, without touching git', async () => {
    const syncAllBranches = vi.fn();
    const res = await syncBranch(args, deps({ isBusy: () => true, syncAllBranches }));
    expect(res).toEqual({ ok: false, reason: 'session_busy' });
    expect(syncAllBranches).not.toHaveBeenCalled();
  });

  it('fast-forward: records v2.git.synced and pushes nothing', async () => {
    const d = deps({
      syncAllBranches: async (input) => {
        expect(input).toMatchObject({ repos: ['acme/api'], branch: 'aidlc/i1' });
        expect(input.message).toContain('merge changes pushed to the branch');
        return {
          ok: true,
          changed: true,
          conflicted: false,
          results: [{ repo: 'acme/api', synced: 'fast_forward', sha: 'a'.repeat(40) }],
        };
      },
    });
    const res = await syncBranch(args, d);
    expect(res).toMatchObject({ ok: true, changed: true, conflicted: false });
    expect(res.summary).toBe('Sam synced aidlc/i1: acme/api@aaaaaaaa (fast-forward)');
    expect(d.pushBranch).not.toHaveBeenCalled();
    expect(d.store.events.map((e) => e.type)).toEqual(['v2.git.synced']);
    expect(d.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent.note', noteType: 'v2.git.synced', intentId: 'i1' }),
    );
  });

  it('merge: pushes the merge so the remote stays the durable state', async () => {
    const d = deps({
      syncAllBranches: async () => ({
        ok: true,
        changed: true,
        conflicted: false,
        results: [{ repo: 'acme/api', synced: 'merged', sha: 'b'.repeat(40) }],
      }),
    });
    const res = await syncBranch(args, d);
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(d.pushBranch).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'acme/api', branch: 'aidlc/i1', gitProvider: 'github' }),
    );
  });

  it('a failed push of the merge is reported as sync_failed', async () => {
    const d = deps({
      syncAllBranches: async () => ({
        ok: true,
        changed: true,
        conflicted: false,
        results: [{ repo: 'acme/api', synced: 'merged', sha: 'b'.repeat(40) }],
      }),
      pushBranch: vi.fn(async () => ({ pushed: false, reason: 'push_failed', detail: 'rejected' })),
    });
    const res = await syncBranch(args, d);
    expect(res).toMatchObject({ ok: false, reason: 'sync_failed' });
    expect(d.store.events.map((e) => e.type)).toEqual(['v2.git.sync_failed']);
  });

  it('conflict: reports the paths and the conflict branch', async () => {
    const d = deps({
      syncAllBranches: async () => ({
        ok: false,
        changed: false,
        conflicted: true,
        results: [
          {
            repo: 'acme/api',
            synced: false,
            reason: 'branch_sync_conflict',
            conflicts: ['src/app.ts'],
            conflictBranch: 'aidlc/i1--sync-conflict',
          },
        ],
      }),
    });
    const res = await syncBranch(args, d);
    expect(res).toMatchObject({ ok: false, conflicted: true, reason: 'branch_sync_conflict' });
    expect(res.results).toEqual([
      expect.objectContaining({
        repo: 'acme/api',
        conflicts: ['src/app.ts'],
        conflictBranch: 'aidlc/i1--sync-conflict',
      }),
    ]);
    expect(res.summary).toContain('aidlc/i1--sync-conflict');
    expect(d.store.events.map((e) => e.type)).toEqual(['v2.git.sync_conflict']);
  });

  it('fails as a value when the checkout cannot be restored', async () => {
    const res = await syncBranch(
      args,
      deps({ ensureWorkspaceSource: async () => ({ failed: ['acme/api'] }) }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'workspace_restore_failed' });
  });
});
