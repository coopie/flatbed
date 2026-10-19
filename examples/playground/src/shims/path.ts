// A stand-in for node:path in the browser, where nothing calls the file stores. See vite.config.ts.
export const join = (...parts: string[]) => parts.join('/');
export const dirname = (path: string) => path.split('/').slice(0, -1).join('/');
