/**
 * Hash routes, since the Worker serves static files and every page is drawn in the browser:
 * `#/` the visitor's project, `#/example` the recorded example, then `/how`, `/doc/<name>` or
 * `/session/<id>` under either.
 */
export type Route = { page: 'project' | 'how' | 'doc' | 'session'; example: boolean; name?: string };

export function parse(hash: string): Route {
  const rest = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const example = rest[0] === 'example';
  if (example) rest.shift();
  const [page, ...name] = rest;
  if (page === 'doc' || page === 'session') return { page, example, name: name.join('/') };
  if (page === 'how') return { page, example };
  return { page: 'project', example };
}

export const href = (example: boolean, tail = '') => `#/${example ? 'example' : ''}${tail}`.replace('#//', '#/');

export const route = $state({ current: parse(location.hash) });
addEventListener('hashchange', () => {
  route.current = parse(location.hash);
  scrollTo(0, 0);
});
