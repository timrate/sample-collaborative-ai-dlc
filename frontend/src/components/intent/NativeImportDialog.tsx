import { useEffect, useState } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  intentsService,
  type NativeImportFormat,
  type NativeImportPreview,
  type NativeImportResult,
} from '@/services/intents';
import { sourceControlService } from '@/services/sourceControl';
import { postPresignedUpload } from '@/services/presignedUpload';
import type { GitProvider } from '@/services/gitProvider';
import { humanizeStageId } from './documentHelpers';
import { HelpTip } from '@/components/help/HelpTip';

// Files the importer reads. Everything else in a workspace (harness, code
// repositories) is skipped, so a branch import only fetches these.
const isWorkspaceRecordPath = (path: string) =>
  path === 'export-manifest.json' || path.startsWith('aidlc/') || path.startsWith('aidlc-docs/');

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

interface RepositoryOption {
  provider: GitProvider;
  repo: string;
}

// Read the workspace record from a branch through the project source-control
// API (membership- and binding-checked) and bundle it for upload.
const bundleFromBranch = async (
  projectId: string,
  { provider, repo }: RepositoryOption,
  branch: string,
) => {
  const { tree } = await sourceControlService.getTree(projectId, provider, repo, branch);
  const paths = tree.map((file) => file.path).filter(isWorkspaceRecordPath);
  if (!paths.includes('export-manifest.json')) {
    throw new Error(
      'This branch has no export-manifest.json at its root. Commit the exported workspace, including its manifest, and try again.',
    );
  }
  const files = await Promise.all(
    paths.map(async (path) => {
      const file = await sourceControlService.getFileContents(
        projectId,
        provider,
        repo,
        path,
        branch,
      );
      return { path, content: file.content };
    }),
  );
  return new Blob([JSON.stringify({ schemaVersion: 1, files })], { type: 'application/json' });
};

interface NativeImportDialogProps {
  open: boolean;
  projectId: string;
  intentId: string;
  onClose: () => void;
  onImported: (result: NativeImportResult) => void;
}

type Source = 'zip' | 'branch';

export function NativeImportDialog({
  open,
  projectId,
  intentId,
  onClose,
  onImported,
}: NativeImportDialogProps) {
  const [source, setSource] = useState<Source>('zip');
  const [file, setFile] = useState<File | null>(null);
  const [repositories, setRepositories] = useState<RepositoryOption[]>([]);
  const [repository, setRepository] = useState<string>('');
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState<'preview' | 'confirm' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<(NativeImportPreview & { uploadId: string }) | null>(null);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setError(null);
    let cancelled = false;
    sourceControlService
      .getStatus(projectId)
      .then((status) => {
        if (cancelled) return;
        const active = status.repositories
          .filter((entry) => entry.status === 'active')
          .map((entry) => ({ provider: entry.provider, repo: entry.repo }));
        setRepositories(active);
        // Most projects attach one workspace repository; preselect it.
        setRepository(
          (current) => current || (active[0] ? `${active[0].provider}:${active[0].repo}` : ''),
        );
      })
      .catch(() => !cancelled && setRepositories([]));
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const selectedRepository = repositories.find(
    (entry) => `${entry.provider}:${entry.repo}` === repository,
  );
  const canPreview =
    busy === null &&
    (source === 'zip' ? Boolean(file) : Boolean(selectedRepository && branch.trim()));

  const handlePreview = async () => {
    setBusy('preview');
    setError(null);
    setPreview(null);
    try {
      let body: Blob;
      let format: NativeImportFormat;
      let label: string;
      if (source === 'zip') {
        if (!file) return;
        body = file;
        format = 'zip';
        label = file.name;
      } else {
        if (!selectedRepository) return;
        body = await bundleFromBranch(projectId, selectedRepository, branch.trim());
        format = 'json';
        label = `${selectedRepository.repo}@${branch.trim()}`;
      }
      if (body.size > MAX_UPLOAD_BYTES) throw new Error('The workspace is larger than 100 MB.');
      const upload = await intentsService.createImportUpload(projectId, intentId, {
        format,
        size: body.size,
      });
      await postPresignedUpload(upload, body, { label });
      const result = await intentsService.previewImport(projectId, intentId, upload.uploadId);
      setPreview({ ...result, uploadId: upload.uploadId });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The workspace could not be previewed');
    } finally {
      setBusy(null);
    }
  };

  const handleConfirm = async () => {
    if (!preview) return;
    setBusy('confirm');
    setError(null);
    try {
      const result = await intentsService.confirmImport(
        projectId,
        intentId,
        preview.uploadId,
        preview.planToken,
      );
      onImported(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The import failed');
    } finally {
      setBusy(null);
    }
  };

  const nothingToImport =
    preview &&
    preview.stageCompletions.length === 0 &&
    preview.artifactWrites.length === 0 &&
    preview.answeredGates.length === 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && busy === null && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-1.5">
            <DialogTitle>Import CLI progress</DialogTitle>
            <HelpTip topic="intent.importCli" side="right" />
          </div>
          <DialogDescription>
            Bring back work done in the AI-DLC CLI on a workspace exported from this intent. Stages
            the CLI completed are recorded here, their outputs are marked as imported, and the
            intent waits for you to continue it.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={source} onValueChange={(value) => setSource(value as Source)}>
          <TabsList>
            <TabsTrigger value="zip" disabled={busy !== null}>
              Workspace ZIP
            </TabsTrigger>
            <TabsTrigger value="branch" disabled={busy !== null}>
              Repository branch
            </TabsTrigger>
          </TabsList>
          <TabsContent value="zip" className="space-y-2 pt-2">
            <Label htmlFor="native-import-zip">ZIP file</Label>
            <Input
              id="native-import-zip"
              type="file"
              accept=".zip,application/zip"
              disabled={busy !== null}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <p className="text-[12px] text-muted-foreground">
              Zip the workspace folder (it holds export-manifest.json and aidlc/).
            </p>
          </TabsContent>
          <TabsContent value="branch" className="space-y-3 pt-2">
            {repositories.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                No repository with an active source-control binding is attached to this project.
                Attach the workspace repository in the project settings first.
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="native-import-repository">Workspace repository</Label>
                  <Select value={repository} onValueChange={setRepository} disabled={busy !== null}>
                    <SelectTrigger id="native-import-repository" aria-label="Workspace repository">
                      <SelectValue placeholder="Choose a repository" />
                    </SelectTrigger>
                    <SelectContent>
                      {repositories.map((entry) => (
                        <SelectItem
                          key={`${entry.provider}:${entry.repo}`}
                          value={`${entry.provider}:${entry.repo}`}
                        >
                          {entry.repo}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="native-import-branch">Branch</Label>
                  <Input
                    id="native-import-branch"
                    value={branch}
                    placeholder="main"
                    disabled={busy !== null}
                    onChange={(event) => setBranch(event.target.value)}
                  />
                </div>
                <p className="text-[12px] text-muted-foreground">
                  The repository the CLI workspace folder was pushed to, with export-manifest.json
                  and aidlc/ at its root.
                </p>
              </>
            )}
          </TabsContent>
        </Tabs>

        {preview && (
          <div
            className="space-y-2 rounded border border-border/60 p-3 text-sm"
            data-testid="import-preview"
          >
            {nothingToImport ? (
              <p>The CLI workspace has no new progress for this intent.</p>
            ) : (
              <>
                <p className="font-medium">
                  {preview.stageCompletions.length} stage(s) completed in the CLI
                  {preview.continuationStageId
                    ? `, continue at ${humanizeStageId(preview.continuationStageId)}`
                    : ''}
                </p>
                <ul className="list-disc pl-5 text-[12px]">
                  {preview.stageCompletions.map((stage) => (
                    <li key={stage.stageId}>{humanizeStageId(stage.stageId)}</li>
                  ))}
                </ul>
                <p className="text-[12px] text-muted-foreground">
                  {preview.artifactWrites.filter((write) => write.change === 'update').length}{' '}
                  artifact(s) updated,{' '}
                  {preview.artifactWrites.filter((write) => write.change === 'create').length}{' '}
                  created, {preview.answeredGates.length} question gate(s) answered.
                </p>
              </>
            )}
            {preview.ignoredFiles.length > 0 && (
              <details className="text-[12px]">
                <summary>{preview.ignoredFiles.length} file(s) not imported</summary>
                <ul className="mt-1 space-y-0.5 pl-3">
                  {preview.ignoredFiles.map((ignored) => (
                    <li key={ignored.path} className="break-all">
                      {ignored.path} — {ignored.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {preview.warnings.map((warning) => (
              <p key={warning} className="flex gap-1.5 text-[12px] text-agent-waiting">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                {warning}
              </p>
            ))}
          </div>
        )}

        {error && (
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy !== null} onClick={onClose}>
            Cancel
          </Button>
          {preview && !nothingToImport ? (
            <Button type="button" disabled={busy !== null} onClick={() => void handleConfirm()}>
              {busy === 'confirm' && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Import progress
            </Button>
          ) : (
            <Button type="button" disabled={!canPreview} onClick={() => void handlePreview()}>
              {busy === 'preview' && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Preview import
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
