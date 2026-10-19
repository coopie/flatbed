// A stand-in for node:fs/promises in the browser, where nothing calls the file stores. See vite.config.ts.
const unavailable = async (): Promise<never> => {
  throw new Error('There is no file system in the browser.');
};
export const readFile = unavailable;
export const writeFile = unavailable;
export const appendFile = unavailable;
export const mkdir = unavailable;
export const readdir = unavailable;
