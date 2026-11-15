import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS_BASE_URL, docsUrl, type DocPath } from './docs';
import { HELP_MENU_LINKS, HELP_TOPICS } from './help-topics';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const docsRoot = resolve(repoRoot, 'docs');

// Python-Markdown's default `toc` slugify, which the docs site uses for heading ids.
function slugify(heading: string): string {
  return heading
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '-');
}

function headingIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = !inFence && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) ids.add(slugify(match[1]));
  }
  return ids;
}

const docPaths: DocPath[] = [
  ...Object.values(HELP_TOPICS).flatMap((topic) => ('doc' in topic ? [topic.doc] : [])),
  ...HELP_MENU_LINKS.map((link) => link.doc),
];

describe('help topic documentation links', () => {
  it.each([...new Set(docPaths)])('%s points at an existing page and heading', (docPath) => {
    const [file, anchor] = docPath.split('#', 2);
    const filePath = resolve(docsRoot, file);
    expect(existsSync(filePath), `docs/${file} does not exist`).toBe(true);
    if (anchor) {
      expect([...headingIds(readFileSync(filePath, 'utf8'))]).toContain(anchor);
    }
  });

  it('every topic has a title and a short body', () => {
    for (const [id, topic] of Object.entries(HELP_TOPICS)) {
      expect(topic.title, id).not.toBe('');
      expect(topic.body.length, id).toBeGreaterThan(0);
      expect(topic.body.length, `${id} is too long for a popover`).toBeLessThanOrEqual(320);
    }
  });
});

describe('docsUrl', () => {
  it('matches site_url in zensical.toml', () => {
    const config = readFileSync(resolve(repoRoot, 'zensical.toml'), 'utf8');
    expect(config).toContain(`site_url = "${DOCS_BASE_URL}"`);
  });

  it('maps source paths to directory URLs', () => {
    expect(docsUrl('using-the-platform/projects.md')).toBe(
      `${DOCS_BASE_URL}using-the-platform/projects/`,
    );
    expect(docsUrl('using-the-platform/creating-intents.md#scope')).toBe(
      `${DOCS_BASE_URL}using-the-platform/creating-intents/#scope`,
    );
    expect(docsUrl('concepts/index.md')).toBe(`${DOCS_BASE_URL}concepts/`);
    expect(docsUrl('index.md')).toBe(DOCS_BASE_URL);
  });
});
