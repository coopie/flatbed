/**
 * A template as docs/kickoffs/_template-format.md describes it, parsed from its files. The page
 * gets the files from Vite and the recording script from the disk, so parsing takes a plain map
 * from each file's path inside the template folder to its text.
 */
import type { Seed } from '@flatbed/docs';
import { parseSpec, type Spec } from '@flatbed/supervisor';

export type Mode = 'read' | 'write' | 'reviewed' | 'sealed';
export type Folder = { path: string; mode: Mode; about: string; spec?: string };

export type Template = {
  id: string;
  name: string;
  pitch: string;
  folders: Folder[];
  opening: string;
  prompts: string[];
  ask: { label: string; placeholder: string } | null;
  tools: string[];
  role: string;
  seeds: Seed[];
  /** The spec for each reviewed folder, by folder path. */
  specs: Record<string, Spec>;
  /** look.css, scoped to `[data-template="<id>"]`. */
  look: string;
  /** Google Fonts families named on look.css's first line. */
  fonts: string[];
};

const MODES = new Set(['read', 'write', 'reviewed', 'sealed']);

/** The folder a document name sits in, or undefined when it is outside every folder. */
export function folderOf(folders: Folder[], name: string): Folder | undefined {
  return folders.find((folder) => name === folder.path || name.startsWith(`${folder.path}/`));
}

/**
 * A seed document: `# <title>` on the first line, `_<summary>_` on the second, then the body. The
 * title line stays in the body, so the agent sees it. Seeds are pinned, since a template's seed is
 * small and is the agent's working set, except in a sealed folder, which stays out of the context.
 */
export function parseSeed(path: string, text: string, folders: Folder[]): Seed {
  const name = path.replace(/^seed\//, '').replace(/\.md$/, '');
  const [title = '', summaryLine = '', ...rest] = text.replace(/\r\n/g, '\n').split('\n');
  const summary = summaryLine.trim().replace(/^_(.*)_$/, '$1');
  const body = [title, ...rest].join('\n').trim();
  return { name, summary, body, pinned: folderOf(folders, name)?.mode !== 'sealed' };
}

/**
 * look.css with `:root` turned into the template's own scope, so that several cards can sit on one
 * page, each in its own look. `[data-theme="dark"]` and the `:root:not(...)` guard stay on the root.
 */
export function scopeLook(css: string, id: string): string {
  const scope = `[data-template="${id}"]`;
  const scopeOne = (selector: string) => {
    const s = selector.trim();
    if (s === ':root') return scope;
    if (s.startsWith(':root')) return `${s} ${scope}`;
    if (s.startsWith('[data-theme')) return `:root${s} ${scope}`;
    return `${scope} ${s}`;
  };
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/([^{};]+)\{/g, (match, selectors: string) =>
      selectors.trim().startsWith('@') ? match : `\n${selectors.split(',').map(scopeOne).join(', ')} {`);
}

/** The families named on look.css's first line, such as `/* Google Fonts: Newsreader (display), Public Sans (body) *\/`. */
export function lookFonts(css: string): string[] {
  const line = css.split('\n')[0] ?? '';
  const named = line.match(/Google Fonts?:\s*([^*]+)\*\//i)?.[1];
  if (named === undefined) return [];
  return named.split(',').map((font) => font.replace(/\(.*?\)/g, '').trim()).filter((font) => font !== '');
}

export function parseTemplate(files: Record<string, string>): Template {
  const config = JSON.parse(files['template.json'] ?? 'null') as Omit<Template, 'role' | 'seeds' | 'specs' | 'look' | 'fonts'> | null;
  if (config === null) throw new Error('A template needs a template.json.');
  for (const folder of config.folders) {
    if (!MODES.has(folder.mode)) throw new Error(`${config.id}: folder ${folder.path} has an unknown mode ${folder.mode}.`);
  }
  const specs: Record<string, Spec> = {};
  for (const folder of config.folders.filter((f) => f.mode === 'reviewed')) {
    const text = folder.spec === undefined ? undefined : files[folder.spec];
    if (text === undefined) throw new Error(`${config.id}: the reviewed folder ${folder.path} has no spec file.`);
    specs[folder.path] = parseSpec(JSON.parse(text));
  }
  const seeds = Object.keys(files)
    .filter((path) => path.startsWith('seed/') && path.endsWith('.md'))
    .sort()
    .map((path) => parseSeed(path, files[path]!, config.folders));
  const css = files['look.css'] ?? '';
  return {
    ...config,
    ask: config.ask ?? null,
    tools: config.tools ?? [],
    role: (files['role.md'] ?? '').trim(),
    seeds,
    specs,
    look: scopeLook(css, config.id),
    fonts: lookFonts(css),
  };
}
