# Importing CLI Progress

After you [export an intent](exporting-workspaces.md) and continue it in a native AI-DLC harness, you can bring the CLI's workflow progress back to the same intent. Stages the CLI completed are recorded on the intent, their artifacts and question answers are imported, and the intent waits for a project member to continue it.

Only code travels through Git. Workflow progress comes back through this import.

## What can be imported

Import works on an intent that this platform exported, while the CLI moved it forward through **sequential** stages:

- Stages the CLI marked complete (`[x]` in `aidlc-state.md`), in order, starting from where the export stopped.
- Changed or new outputs of those stages, when the file is a declared output of the stage.
- Answers in the stages' question files (`[Answer]:` lines).

The import is refused, with a reason, when:

- The workspace was exported from a different intent, or uses a different AI-DLC version than the intent is pinned to.
- The intent changed in the UI after the export (for example, an artifact was edited or a stage ran). Export again and continue from the new workspace instead.
- The CLI rewound, skipped or un-skipped a stage, or completed a stage after one that is still unfinished.
- The CLI completed stages that run per unit of work. Construction unit progress is not imported yet.
- The CLI edited an artifact of a stage that was already complete at export.
- The CLI finished every stage. There is no stage left to continue, so this case is not supported yet.

Files the import does not use are listed in the preview and left alone. These include the CLI's memory notes, files of stages that are not complete, space memory such as `team.md`, and the harness files.

## Import from a ZIP

1. Zip the workspace folder. It holds `export-manifest.json` and `aidlc/` at its root.
2. Open the intent, select **Intent actions** (**⋯**), then **Import CLI progress**.
3. Choose **Workspace ZIP**, select the file, and choose **Preview import**.

## Import from a repository branch

A team that pushes the workspace folder to its own repository can import from a branch instead. The [AI-DLC guide](https://github.com/awslabs/aidlc-workflows) calls this the workspace repository. The code repositories stay separate.

1. Commit everything `git status` lists in the workspace folder, including `export-manifest.json`, and push the branch.
2. Attach the workspace repository to the project and make sure its source-control binding is active. The import reads the branch through the project's source-control binding.
3. In **Import CLI progress**, choose **Repository branch**, pick the repository, enter the branch, and choose **Preview import**.

The AI-DLC CLI does not commit `runtime-graph.json`. The import uses the import time for completions it cannot find in the workspace.

## Review and confirm

The preview shows the stages that will be marked complete, the artifacts that will be updated or created, the question gates that will be answered, any files that will not be imported, and the stage the intent will continue at. Nothing is written until you choose **Import progress**.

If the workspace or the intent changes between the preview and the confirmation, the import is refused, and you must review it again.

When you confirm:

- The completed stages are recorded, and their pending gates are answered or closed.
- Imported artifacts are marked **imported from the AI-DLC CLI**, with your name and the time, in the artifact header. Earlier versions stay in the artifact history.
- Any parked run of the intent is stopped. The intent shows **CLI progress imported** with a **Continue at <stage>** action.

## Continue the intent

Review the imported work, then choose **Continue at <stage>**. This restarts the run at the first stage the CLI did not finish, the same way a [rewind](recovering-intents.md) does.

If an import fails part-way, the intent is marked failed and its timeline names the import. Rewind it to the earliest imported stage to recover.
