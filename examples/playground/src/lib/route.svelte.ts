/**
 * Hash routes, since the Worker serves static files and every page is drawn in the browser:
 * `#/` the picker, `#/<template>` a project, `#/<template>/example` its recorded example, then
 * `/doc/<name>` or `/session/<id>` under either.
 */
export type Route =
  | { page: 'picker' }
  | { page: 'project' | 'doc' | 'session'; template: string; example: boolean; name?: string };

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [template, ...rest] = parts;
  if (template === undefined) return { page: 'picker' };
  const example = rest[0] === 'example';
  if (example) rest.shift();
  const [page, ...name] = rest;
  if (page === 'doc' || page === 'session') return { page, template, example, name: name.join('/') };
  return { page: 'project', template, example };
}

export const href = (template: string, example: boolean, tail = '') => `#/${template}${example ? '/example' : ''}${tail}`;

export const route = $state({ current: parse(location.hash) });
addEventListener('hashchange', () => {
  route.current = parse(location.hash);
  scrollTo(0, 0);
});
