// sync-branch — pick up pushes made to the intent branch while the intent is
// parked, on a person's request ("Sync branch now"). Runs in the INTENT
// session. Stages already sync before the agent starts and before each push;
// this command lets a person see the result (or a conflict) without waiting
// for the next stage.
//
// Deterministic engine git only: fetch, fast-forward or merge with the engine
// identity, push a merge so the remote stays the durable state. A conflict
// leaves the tree as it was and publishes the session's work to the scratch
// conflict branch (see git-engine syncBranchWithRemote). Failures are VALUES.

import {
  describeSyncConflicts,
  pushBranch as defaultPushBranch,
  repoTargetDir,
  syncAllBranches as defaultSyncAllBranches,
} from '../git-engine.js';
import { ensureWorkspaceSource as defaultEnsureWorkspaceSource } from '../workspace.js';
import { repoUrl, repoProvider } from '../../shared/repo-provider.js';
import { createEngineCommitMessages } from '../commit-message.js';

export const syncBranch = async (
  {
    projectId,
    intentId,
    executionId,
    repos = [],
    branch,
    baseBranch,
    baseBranches,
    gitProvider,
    repoProviders = null,
    gitAuthor = null,
    requestedByName = null,
    workspaceDir,
  },
  deps = {},
) => {
  const {
    store,
    broadcast = async () => {},
    ensureWorkspaceSource = defaultEnsureWorkspaceSource,
    syncAllBranches = defaultSyncAllBranches,
    pushBranch = defaultPushBranch,
    urlsFor = null,
    isBusy = () => false,
  } = deps;
  if (!branch) return { ok: false, reason: 'no_branch' };
  if (repos.length === 0) return { ok: true, changed: false, conflicted: false, results: [] };
  // A stage job in this session owns the checkout; never merge under it.
  if (isBusy()) return { ok: false, reason: 'session_busy' };

  const heal = await ensureWorkspaceSource({
    repos,
    branch,
    baseBranch,
    baseBranches,
    gitProvider,
    repoProviders,
    projectId,
    executionId,
    workspaceDir,
  }).catch((error) => ({ error: error?.message ?? String(error) }));
  if (heal?.error || heal?.failed?.length) {
    return {
      ok: false,
      reason: 'workspace_restore_failed',
      detail: heal?.error ?? `could not re-clone: ${heal.failed.join(', ')}`,
    };
  }

  const sync = await syncAllBranches({
    repos,
    workspaceDir,
    branch,
    gitProvider,
    repoProviders,
    projectId,
    executionId,
    author: gitAuthor,
    message: await createEngineCommitMessages({ store, executionId })({ kind: 'sync' }),
    urlsFor,
  });

  // A merge exists only in this session until pushed. Publish it now so the
  // remote stays the intent branch's durable state.
  const multi = repos.length > 1;
  const results = [];
  for (const row of sync.results) {
    if (row.synced !== 'merged') {
      results.push(row);
      continue;
    }
    const source = repos.find((repo) => repoUrl(repo) === row.repo);
    const push = await pushBranch({
      dir: repoTargetDir({ url: row.repo, workspaceDir, multi }),
      repo: row.repo,
      branch,
      gitProvider: repoProvider(source, gitProvider, repoProviders),
      projectId,
      executionId,
      urls: urlsFor ? urlsFor(row.repo) : {},
    });
    results.push(
      push.pushed === true
        ? { ...row, pushed: true }
        : { ...row, pushed: false, reason: push.reason ?? 'push_failed', detail: push.detail },
    );
  }

  const who = requestedByName ? `${requestedByName} synced` : 'Synced';
  const moved = results.filter((r) => r.synced === 'fast_forward' || r.synced === 'merged');
  const failed = results.filter((r) => !r.synced || r.pushed === false);
  let type;
  let summary;
  if (sync.conflicted) {
    type = 'v2.git.sync_conflict';
    summary = `Changes pushed to ${branch} conflict with this session's work: ${describeSyncConflicts(results)}`;
  } else if (failed.length > 0) {
    type = 'v2.git.sync_failed';
    summary = `Could not sync ${branch} (${failed
      .map((r) => `${r.repo}: ${r.reason ?? 'unknown'}`)
      .join('; ')
      .slice(0, 300)})`;
  } else {
    type = 'v2.git.synced';
    summary = moved.length
      ? `${who} ${branch}: ${moved
          .map(
            (r) => `${r.repo}@${String(r.sha ?? '').slice(0, 8)} (${r.synced.replace('_', '-')})`,
          )
          .join(', ')}`
      : `${who} ${branch}: already up to date`;
  }
  await store?.appendEvent?.({ executionId, type, actor: 'agentcore', summary }).catch(() => {});
  await broadcast({
    action: 'agent.note',
    intentId,
    projectId,
    executionId,
    noteType: type,
    summary,
  }).catch(() => {});

  return {
    ok: !sync.conflicted && failed.length === 0,
    changed: moved.length > 0,
    conflicted: sync.conflicted,
    summary,
    ...(sync.conflicted ? { reason: 'branch_sync_conflict' } : {}),
    ...(!sync.conflicted && failed.length ? { reason: 'sync_failed' } : {}),
    results: results.map(({ repo, synced, sha, conflicts, conflictBranch, reason, detail }) => ({
      repo,
      synced,
      sha: sha ?? null,
      ...(conflicts ? { conflicts, conflictBranch: conflictBranch ?? null } : {}),
      ...(reason ? { reason } : {}),
      ...(detail ? { detail: String(detail).slice(0, 500) } : {}),
    })),
  };
};
