/**
 * Links from the application into the published documentation site.
 *
 * DOCS_BASE_URL mirrors `site_url` in `zensical.toml`; a test keeps the two in
 * sync. Pages use directory URLs, so `using-the-platform/projects.md#members`
 * is served at `<base>using-the-platform/projects/#members`.
 */
export const DOCS_BASE_URL = 'https://aws-samples.github.io/sample-collaborative-ai-dlc/';

/** A docs source path relative to `docs/`, with an optional `#anchor`. */
export type DocPath = `${string}.md` | `${string}.md#${string}`;

export function docsUrl(path: DocPath): string {
  const [file, anchor] = path.split('#', 2);
  const page = file.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '/');
  return `${DOCS_BASE_URL}${page}${anchor ? `#${anchor}` : ''}`;
}
