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
  type IntentCliSync,
  type NativeImportConflict,
  type NativeImportPreview,
  type NativeImportRequest,
  type NativeImportResult,
} from '@/services/intents';
import { sourceControlService } from '@/services/sourceControl';
import { postPresignedUpload } from '@/services/presignedUpload';
import type { GitProvider } from '@/services/gitProvider';
import { humanizeStageId } from './documentHelpers';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

interface RepositoryOption {
  provider: GitProvider;
  repo: string;
}

interface NativeImportDialogProps {
  open: boolean;
  projectId: string;
  intentId: string;
  // Set while the intent syncs from a branch: imports come only from it.
  cliSync?: IntentCliSync | null;
  onClose: () => void;
  onImported: (result: NativeImportResult) => void;
}

type Source = 'zip' | 'branch';

type PreviewState =
  | { request: NativeImportRequest; unchanged: true }
  | { request: NativeImportRequest; unchanged: false; result: NativeImportPreview };

const conflictLabel = (conflict: NativeImportConflict) => {
  if (conflict.kind === 'artifact') return `${conflict.path} changed in both the CLI and the UI`;
  const stage = conflict.stageId ? humanizeStageId(conflict.stageId) : 'A stage';
  return conflict.reason === 'ui_in_progress'
    ? `${stage} was completed in the CLI while it runs in the UI`
    : `${stage} was completed in both the CLI and the UI`;
};

export function NativeImportDialog({
  open,
  projectId,
  intentId,
  cliSync = null,
  onClose,
  onImported,
}: NativeImportDialogProps) {
  const [source, setSource] = useState<Source>(cliSync ? 'branch' : 'zip');
  const [file, setFile] = useState<File | null>(null);
  const [repositories, setRepositories] = useState<RepositoryOption[]>([]);
  const [repository, setRepository] = useState<string>('');
  const [branch, setBranch] = useState('');
  const [keepSyncing, setKeepSyncing] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'confirm' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setError(null);
    if (cliSync) {
      setSource('branch');
      return;
    }
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
  }, [open, projectId, cliSync]);

  const selectedRepository = repositories.find(
    (entry) => `${entry.provider}:${entry.repo}` === repository,
  );
  const canPreview =
    busy === null &&
    (source === 'zip' ? Boolean(file) : Boolean(cliSync || (selectedRepository && branch.trim())));

  const buildRequest = async (): Promise<NativeImportRequest | null> => {
    if (source === 'branch') {
      if (cliSync) {
        return {
          source: { provider: cliSync.provider, repo: cliSync.repo, branch: cliSync.branch },
        };
      }
      if (!selectedRepository) return null;
      return {
        source: { ...selectedRepository, branch: branch.trim() },
        ...(keepSyncing ? { keepSyncing: true } : {}),
      };
    }
    if (!file) return null;
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('The workspace is larger than 100 MB.');
    const upload = await intentsService.createImportUpload(projectId, intentId, {
      format: 'zip',
      size: file.size,
    });
    await postPresignedUpload(upload, file, { label: file.name });
    return { uploadId: upload.uploadId };
  };

  const handlePreview = async () => {
    setBusy('preview');
    setError(null);
    setPreview(null);
    try {
      const request = await buildRequest();
      if (!request) return;
      const result = await intentsService.previewImport(projectId, intentId, request);
      setPreview(
        'unchanged' in result && result.unchanged
          ? { request, unchanged: true }
          : { request, unchanged: false, result: result as NativeImportPreview },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The workspace could not be previewed');
    } finally {
      setBusy(null);
    }
  };

  const handleConfirm = async () => {
    if (!preview || preview.unchanged) return;
    setBusy('confirm');
    setError(null);
    try {
      const result = await intentsService.confirmImport(
        projectId,
        intentId,
        preview.request,
        preview.result,
      );
      onImported(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The import failed');
    } finally {
      setBusy(null);
    }
  };

  const plan = preview && !preview.unchanged ? preview.result : null;
  const conflicts = plan?.conflicts ?? [];
  const nothingToImport =
    plan &&
    plan.stageCompletions.length === 0 &&
    plan.artifactWrites.length === 0 &&
    plan.answeredGates.length === 0;
  const canConfirm = Boolean(plan && conflicts.length === 0 && (!nothingToImport || keepSyncing));

  return (
    <Dialog open={open} onOpenChange={(next) => !next && busy === null && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import CLI progress</DialogTitle>
          <DialogDescription>
            Bring back work done in the AI-DLC CLI on a workspace exported from this intent. Stages
            the CLI completed are recorded here, their outputs are marked as imported, and the
            intent waits for you to continue it.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={source} onValueChange={(value) => setSource(value as Source)}>
          <TabsList>
            <TabsTrigger value="zip" disabled={busy !== null || Boolean(cliSync)}>
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
            {cliSync ? (
              <p className="text-[12px] text-muted-foreground" data-testid="import-linked-branch">
                This intent syncs from {cliSync.repo}@{cliSync.branch}. The import compares the
                branch with the last sync: progress made here since then is kept, and anything
                changed on both sides stops the import. Unlink the branch to import from elsewhere.
              </p>
            ) : repositories.length === 0 ? (
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
                <label className="flex items-start gap-2 text-[12px]">
                  <input
                    type="checkbox"
                    checked={keepSyncing}
                    disabled={busy !== null || preview !== null}
                    onChange={(event) => setKeepSyncing(event.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    Keep syncing from this branch. Later imports from it compare against this one,
                    so work done here in the meantime is kept.
                  </span>
                </label>
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
            {preview.unchanged ? (
              <p>Nothing was pushed to the branch since the last sync.</p>
            ) : conflicts.length > 0 ? (
              <>
                <p className="font-medium text-destructive">
                  The CLI and this intent both changed the same work since the last sync. Nothing
                  can be imported until it is reconciled.
                </p>
                <ul className="list-disc pl-5 text-[12px]">
                  {conflicts.map((conflict) => (
                    <li key={`${conflict.kind}:${conflict.path ?? conflict.stageId}`}>
                      {conflictLabel(conflict)}
                    </li>
                  ))}
                </ul>
              </>
            ) : nothingToImport ? (
              <p>The CLI workspace has no new progress for this intent.</p>
            ) : (
              plan && (
                <>
                  <p className="font-medium">
                    {plan.stageCompletions.length} stage(s) completed in the CLI
                    {plan.continuationStageId
                      ? `, continue at ${humanizeStageId(plan.continuationStageId)}`
                      : ''}
                  </p>
                  <ul className="list-disc pl-5 text-[12px]">
                    {plan.stageCompletions.map((stage) => (
                      <li key={stage.stageId}>{humanizeStageId(stage.stageId)}</li>
                    ))}
                  </ul>
                  <p className="text-[12px] text-muted-foreground">
                    {plan.artifactWrites.filter((write) => write.change === 'update').length}{' '}
                    artifact(s) updated,{' '}
                    {plan.artifactWrites.filter((write) => write.change === 'create').length}{' '}
                    created, {plan.answeredGates.length} question gate(s) answered.
                  </p>
                </>
              )
            )}
            {plan && (plan.uiOwnedFiles?.length ?? 0) > 0 && (
              <p className="text-[12px] text-muted-foreground">
                {plan.uiOwnedFiles?.length} file(s) changed here since the last sync are kept.
              </p>
            )}
            {plan && plan.ignoredFiles.length > 0 && (
              <details className="text-[12px]">
                <summary>{plan.ignoredFiles.length} file(s) not imported</summary>
                <ul className="mt-1 space-y-0.5 pl-3">
                  {plan.ignoredFiles.map((ignored) => (
                    <li key={ignored.path} className="break-all">
                      {ignored.path} — {ignored.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {plan?.warnings.map((warning) => (
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
          {canConfirm ? (
            <Button type="button" disabled={busy !== null} onClick={() => void handleConfirm()}>
              {busy === 'confirm' && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {nothingToImport ? 'Link branch' : 'Import progress'}
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
