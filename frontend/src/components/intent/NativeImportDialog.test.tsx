import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IntentCliSync, NativeImportResult } from '@/services/intents';

const createImportUpload = vi.fn();
const previewImport = vi.fn();
const confirmImport = vi.fn();
const getStatus = vi.fn();
const postPresignedUpload = vi.fn();

vi.mock('@/services/intents', () => ({
  intentsService: {
    createImportUpload: (...a: unknown[]) => createImportUpload(...a),
    previewImport: (...a: unknown[]) => previewImport(...a),
    confirmImport: (...a: unknown[]) => confirmImport(...a),
  },
}));
vi.mock('@/services/sourceControl', () => ({
  sourceControlService: {
    getStatus: (...a: unknown[]) => getStatus(...a),
  },
}));
vi.mock('@/services/presignedUpload', () => ({
  postPresignedUpload: (...a: unknown[]) => postPresignedUpload(...a),
}));

import { NativeImportDialog } from './NativeImportDialog';

const preview = {
  dryRun: true,
  planToken: 'token-1',
  continuationStageId: 'workflow-planning',
  workflowComplete: false,
  stageCompletions: [
    { stageId: 'requirements-analysis', phase: 'inception', completedAt: '2026-08-15T09:00:00Z' },
  ],
  artifactWrites: [
    {
      path: 'aidlc/x/requirements.md',
      artifactType: 'requirements',
      stageId: 'requirements-analysis',
      change: 'update',
      bytes: 10,
    },
  ],
  answeredGates: [{ humanTaskId: 'q1', stageId: 'requirements-analysis' }],
  resolvedGates: [],
  ignoredFiles: [{ path: 'aidlc/spaces/default/memory/team.md', reason: 'not imported' }],
  warnings: [],
};

const BRANCH = { provider: 'github', repo: 'acme/workspace', branch: 'cli-work' };
const LINK: IntentCliSync = {
  ...BRANCH,
  linkedBy: 'u1',
  linkedAt: '2026-08-15T09:00:00Z',
  lastSyncedSha: 'a'.repeat(40),
  lastSyncedAt: '2026-08-15T09:00:00Z',
};

const renderDialog = ({
  onImported = vi.fn<(result: NativeImportResult) => void>(),
  cliSync = null,
}: {
  onImported?: (result: NativeImportResult) => void;
  cliSync?: IntentCliSync | null;
} = {}) => {
  render(
    <NativeImportDialog
      open
      projectId="p1"
      intentId="i1"
      cliSync={cliSync}
      onClose={vi.fn()}
      onImported={onImported}
    />,
  );
  return onImported;
};

const chooseBranch = async (name: string) => {
  await userEvent.click(screen.getByRole('tab', { name: 'Repository branch' }));
  // Only the active binding is offered, and it is preselected.
  expect(await screen.findByRole('combobox', { name: 'Workspace repository' })).toHaveTextContent(
    'acme/workspace',
  );
  await userEvent.type(screen.getByLabelText('Branch'), name);
};

beforeEach(() => {
  for (const mock of [
    createImportUpload,
    previewImport,
    confirmImport,
    getStatus,
    postPresignedUpload,
  ]) {
    mock.mockReset();
  }
  getStatus.mockResolvedValue({
    ready: true,
    repositories: [
      { provider: 'github', repo: 'acme/workspace', status: 'active' },
      { provider: 'github', repo: 'acme/broken', status: 'invalid' },
    ],
  });
  createImportUpload.mockResolvedValue({
    uploadId: 'up-1',
    url: 'https://s3',
    fields: {},
    expiresIn: 900,
  });
  postPresignedUpload.mockResolvedValue(undefined);
  previewImport.mockResolvedValue(preview);
  confirmImport.mockResolvedValue({ ...preview, importId: 'import-1', intent: {} });
});

describe('NativeImportDialog', () => {
  it('uploads a ZIP, shows the preview, and confirms with its plan token', async () => {
    const onImported = renderDialog();
    const zip = new File(['PK'], 'workspace.zip', { type: 'application/zip' });
    await userEvent.upload(screen.getByLabelText('ZIP file'), zip);
    await userEvent.click(screen.getByRole('button', { name: 'Preview import' }));

    expect(await screen.findByTestId('import-preview')).toHaveTextContent(
      '1 stage(s) completed in the CLI, continue at Workflow Planning',
    );
    expect(createImportUpload).toHaveBeenCalledWith('p1', 'i1', { format: 'zip', size: 2 });
    expect(postPresignedUpload).toHaveBeenCalledWith(expect.any(Object), zip, {
      label: 'workspace.zip',
    });
    expect(previewImport).toHaveBeenCalledWith('p1', 'i1', { uploadId: 'up-1' });
    expect(confirmImport).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Import progress' }));
    expect(confirmImport).toHaveBeenCalledWith(
      'p1',
      'i1',
      { uploadId: 'up-1' },
      expect.objectContaining({ planToken: 'token-1' }),
    );
    await waitFor(() => expect(onImported).toHaveBeenCalled());
  });

  it('previews a branch on the backend and confirms with the preview clock', async () => {
    previewImport.mockResolvedValue({
      ...preview,
      headSha: 'a'.repeat(40),
      plannedAt: '2026-08-15T09:00:00.000Z',
    });
    renderDialog();
    await chooseBranch('cli-work');
    await userEvent.click(screen.getByRole('button', { name: 'Preview import' }));

    await screen.findByTestId('import-preview');
    expect(previewImport).toHaveBeenCalledWith('p1', 'i1', { source: BRANCH });
    // Nothing is assembled or uploaded in the browser.
    expect(createImportUpload).not.toHaveBeenCalled();
    expect(postPresignedUpload).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Import progress' }));
    expect(confirmImport).toHaveBeenCalledWith(
      'p1',
      'i1',
      { source: BRANCH },
      expect.objectContaining({ planToken: 'token-1', plannedAt: '2026-08-15T09:00:00.000Z' }),
    );
  });

  it('asks to keep syncing, and offers to link a branch with no new progress', async () => {
    previewImport.mockResolvedValue({
      ...preview,
      stageCompletions: [],
      artifactWrites: [],
      answeredGates: [],
    });
    renderDialog();
    await chooseBranch('cli-work');
    await userEvent.click(screen.getByLabelText(/Keep syncing from this branch/));
    await userEvent.click(screen.getByRole('button', { name: 'Preview import' }));

    expect(await screen.findByTestId('import-preview')).toHaveTextContent('no new progress');
    expect(previewImport).toHaveBeenCalledWith('p1', 'i1', { source: BRANCH, keepSyncing: true });
    await userEvent.click(screen.getByRole('button', { name: 'Link branch' }));
    expect(confirmImport).toHaveBeenCalledWith(
      'p1',
      'i1',
      { source: BRANCH, keepSyncing: true },
      expect.objectContaining({ planToken: 'token-1' }),
    );
  });

  it('syncs only from the linked branch', async () => {
    renderDialog({ cliSync: LINK });

    expect(screen.getByRole('tab', { name: 'Workspace ZIP' })).toBeDisabled();
    expect(screen.getByTestId('import-linked-branch')).toHaveTextContent('acme/workspace@cli-work');
    expect(screen.queryByLabelText(/Keep syncing/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Preview import' }));
    expect(previewImport).toHaveBeenCalledWith('p1', 'i1', { source: BRANCH });
  });

  it('says so when nothing was pushed since the last sync', async () => {
    previewImport.mockResolvedValue({ dryRun: true, unchanged: true, headSha: 'a'.repeat(40) });
    renderDialog({ cliSync: LINK });
    await userEvent.click(screen.getByRole('button', { name: 'Preview import' }));

    expect(
      await screen.findByText('Nothing was pushed to the branch since the last sync.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import progress' })).not.toBeInTheDocument();
  });

  it('lists conflicts and offers no confirm', async () => {
    previewImport.mockResolvedValue({
      ...preview,
      sync: true,
      conflicts: [
        { kind: 'stage', stageId: 'workflow-planning', reason: 'both_completed' },
        { kind: 'artifact', stageId: 'requirements-analysis', path: 'aidlc/x/requirements.md' },
      ],
      uiOwnedFiles: [],
    });
    renderDialog({ cliSync: LINK });
    await userEvent.click(screen.getByRole('button', { name: 'Preview import' }));

    const panel = await screen.findByTestId('import-preview');
    expect(panel).toHaveTextContent('Workflow Planning was completed in both the CLI and the UI');
    expect(panel).toHaveTextContent('aidlc/x/requirements.md changed in both the CLI and the UI');
    expect(screen.queryByRole('button', { name: 'Import progress' })).not.toBeInTheDocument();
  });

  it('shows a refusal from the server and offers no confirm', async () => {
    previewImport.mockRejectedValue(
      new Error('the intent changed in the UI after this workspace was exported'),
    );
    renderDialog();
    await userEvent.upload(
      screen.getByLabelText('ZIP file'),
      new File(['PK'], 'w.zip', { type: 'application/zip' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Preview import' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('changed in the UI');
    expect(screen.queryByRole('button', { name: 'Import progress' })).not.toBeInTheDocument();
  });

  it('says so when the workspace has no new progress', async () => {
    previewImport.mockResolvedValue({
      ...preview,
      stageCompletions: [],
      artifactWrites: [],
      answeredGates: [],
    });
    renderDialog();
    await userEvent.upload(
      screen.getByLabelText('ZIP file'),
      new File(['PK'], 'w.zip', { type: 'application/zip' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Preview import' }));

    expect(
      await screen.findByText('The CLI workspace has no new progress for this intent.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import progress' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link branch' })).not.toBeInTheDocument();
  });
});
