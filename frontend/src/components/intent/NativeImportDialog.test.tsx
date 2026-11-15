import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const createImportUpload = vi.fn();
const previewImport = vi.fn();
const confirmImport = vi.fn();
const getStatus = vi.fn();
const getTree = vi.fn();
const getFileContents = vi.fn();
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
    getTree: (...a: unknown[]) => getTree(...a),
    getFileContents: (...a: unknown[]) => getFileContents(...a),
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

const renderDialog = (onImported = vi.fn()) => {
  render(
    <NativeImportDialog
      open
      projectId="p1"
      intentId="i1"
      onClose={vi.fn()}
      onImported={onImported}
    />,
  );
  return onImported;
};

beforeEach(() => {
  for (const mock of [
    createImportUpload,
    previewImport,
    confirmImport,
    getStatus,
    getTree,
    getFileContents,
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
    expect(confirmImport).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Import progress' }));
    expect(confirmImport).toHaveBeenCalledWith('p1', 'i1', 'up-1', 'token-1');
    await waitFor(() => expect(onImported).toHaveBeenCalled());
  });

  it('bundles only the workspace record from a branch of an active repository', async () => {
    getTree.mockResolvedValue({
      tree: [
        { path: 'export-manifest.json' },
        { path: 'aidlc/spaces/default/intents/x/aidlc-state.md' },
        { path: '.claude/tools/data/stage-graph.json' },
        { path: 'README.md' },
      ],
    });
    getFileContents.mockImplementation(async (_p, _provider, _repo, path) => ({
      path,
      content: `content of ${path}`,
    }));
    renderDialog();
    await userEvent.click(screen.getByRole('tab', { name: 'Repository branch' }));
    // Only the active binding is offered, and it is preselected.
    expect(await screen.findByRole('combobox', { name: 'Workspace repository' })).toHaveTextContent(
      'acme/workspace',
    );
    await userEvent.type(screen.getByLabelText('Branch'), 'cli-work');
    await userEvent.click(screen.getByRole('button', { name: 'Preview import' }));

    await screen.findByTestId('import-preview');
    expect(getTree).toHaveBeenCalledWith('p1', 'github', 'acme/workspace', 'cli-work');
    expect(getFileContents.mock.calls.map((call) => call[3]).toSorted()).toEqual([
      'aidlc/spaces/default/intents/x/aidlc-state.md',
      'export-manifest.json',
    ]);
    const [, body, options] = postPresignedUpload.mock.calls[0];
    expect(options).toEqual({ label: 'acme/workspace@cli-work' });
    const bundle = JSON.parse(await (body as Blob).text());
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.files).toContainEqual({
      path: 'export-manifest.json',
      content: 'content of export-manifest.json',
    });
    expect(createImportUpload).toHaveBeenCalledWith('p1', 'i1', {
      format: 'json',
      size: (body as Blob).size,
    });
  });

  it('explains a branch without an export manifest instead of uploading it', async () => {
    getTree.mockResolvedValue({ tree: [{ path: 'aidlc/a.md' }] });
    renderDialog();
    await userEvent.click(screen.getByRole('tab', { name: 'Repository branch' }));
    await screen.findByRole('combobox', { name: 'Workspace repository' });
    await userEvent.type(screen.getByLabelText('Branch'), 'main');
    await userEvent.click(screen.getByRole('button', { name: 'Preview import' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('no export-manifest.json');
    expect(createImportUpload).not.toHaveBeenCalled();
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
  });
});
