import type { DocPath } from '@/lib/docs';

/**
 * Contextual help shown by <HelpTip>. Each entry is a short summary of the
 * linked guide section; the guide stays the authoritative description, so keep
 * the text brief and update both together. `help-topics.test.ts` checks that
 * every `doc` path and anchor exists under `docs/`.
 */
export interface HelpTopic {
  title: string;
  body: string;
  doc?: DocPath;
}

const CREATING_INTENTS = 'using-the-platform/creating-intents.md';

export const HELP_TOPICS = {
  'spaces.overview': {
    title: 'Spaces',
    body: 'A space groups the repositories, members, trackers, environment and runtime settings that its intents run with. Spaces were called projects in earlier releases.',
    doc: 'using-the-platform/projects.md',
  },
  'space.intents': {
    title: 'Intents',
    body: 'An intent is one unit of agent work: a title and a prompt, run through the space’s workflow. Drafts open on the Compose page. A waiting intent is parked on a human gate and needs an answer to continue.',
    doc: `${CREATING_INTENTS}#intent-lifecycle`,
  },
  'space.runtime': {
    title: 'Runtime settings',
    body: 'These settings are copied onto each intent when it is created. Changing them affects the next intent, never one that already exists.',
    doc: 'using-the-platform/projects.md#settings-snapshots',
  },
  'intent.title': {
    title: 'Title',
    body: 'A short name for the intent. It also names the intent’s Git branch, for example "Add user authentication" works on aidlc/add-user-authentication.',
    doc: `${CREATING_INTENTS}#title`,
  },
  'intent.prompt': {
    title: 'Prompt',
    body: 'The brief every stage receives. Say what to build, who it is for, the constraints, and what is in and out of scope. You can keep refining it with teammates on the Compose page.',
    doc: `${CREATING_INTENTS}#prompt`,
  },
  'intent.tracker': {
    title: 'Import from tracker',
    body: 'Pick an issue to seed the intent. Its title becomes the intent title, its body and comments become the prompt, and supported attachments are imported after the draft opens.',
    doc: `${CREATING_INTENTS}#import-from-tracker`,
  },
  'intent.release': {
    title: 'AI-DLC version',
    body: 'The AI-DLC methodology release this intent runs. The intent stays on the chosen version and is never migrated automatically.',
    doc: `${CREATING_INTENTS}#ai-dlc-version`,
  },
  'intent.baseBranch': {
    title: 'Base branch',
    body: 'The branch each repository’s intent branch starts from, and where its pull request opens. Repositories you leave unset use their own default branch.',
    doc: `${CREATING_INTENTS}#base-branch`,
  },
  'compose.attachments': {
    title: 'Attachments',
    body: 'Reference files the agents can read, read-only, in their workspace: up to 50 files, 5 MB each, 25 MB in total. Agents decide when to read them.',
    doc: `${CREATING_INTENTS}#attachments`,
  },
  'compose.agentCli': {
    title: 'Agent CLI',
    body: 'The coding agent that runs every stage of this intent. Only CLIs you have credentials for are available. The space’s recommendation is labeled but not selected for you.',
    doc: `${CREATING_INTENTS}#agent-cli`,
  },
  'compose.scope': {
    title: 'Scope',
    body: 'Decides which workflow stages run, for example bugfix, poc or feature. Pick the smallest scope that honestly covers the work. Existing code is detected automatically; there is no separate brownfield scope.',
    doc: `${CREATING_INTENTS}#scope`,
  },
  'compose.stages': {
    title: 'Stages',
    body: 'The stages the selected scope runs. Deselect the ones you do not need; required stages always run. "reset to scope" restores the scope’s original selection.',
    doc: `${CREATING_INTENTS}#stages`,
  },
  'compose.ai': {
    title: 'Compose with AI',
    body: 'Proposes a scope or a custom stage selection from the prompt. Review the proposal before you start the intent.',
    doc: 'getting-started/methodology-map.md',
  },
  'intent.importCli': {
    title: 'Import CLI progress',
    body: 'Brings stages you completed in a local AI-DLC harness back to this intent, from the workspace ZIP or a workspace repository branch. Nothing is written until you confirm the preview.',
    doc: 'using-the-platform/importing-cli-progress.md',
  },
  'workflows.list': {
    title: 'Workflows',
    body: 'A workflow arranges stage blocks into phases and decides, per scope, which stages run. Every save is a new immutable version; intents keep the version they started with.',
    doc: 'using-the-platform/workflows.md#the-workflow-list',
  },
  'workflows.blocks': {
    title: 'Block library',
    body: 'The building blocks of the methodology: stages, agents, scopes, rules, sensors and more. SYSTEM blocks are read-only; a fork shadows the SYSTEM block with the same id in every workflow.',
    doc: 'using-the-platform/workflows.md#the-block-library',
  },
  'workflows.scopes': {
    title: 'Scope wiring',
    body: 'For each scope, every stage placement either executes or is skipped. A placement that executes in no scope never runs and is flagged.',
    doc: 'using-the-platform/workflows.md#scope-wiring',
  },
} as const satisfies Record<string, HelpTopic>;

export type HelpTopicId = keyof typeof HELP_TOPICS;

/** Guides listed in the header's Help menu. */
export const HELP_MENU_LINKS: ReadonlyArray<{ label: string; doc: DocPath }> = [
  { label: 'Your first intent', doc: 'getting-started/first-intent.md' },
  { label: 'AI-DLC terms in this platform', doc: 'getting-started/methodology-map.md' },
  { label: 'Creating intents', doc: CREATING_INTENTS },
  { label: 'Observing intents', doc: 'using-the-platform/intent-observability.md' },
  { label: 'Recovering intents', doc: 'using-the-platform/recovering-intents.md' },
  { label: 'Spaces and settings', doc: 'using-the-platform/projects.md' },
  { label: 'Managing workflows', doc: 'using-the-platform/workflows.md' },
];
