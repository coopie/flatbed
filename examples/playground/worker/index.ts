// The Worker's entry. Workers allow only handlers among a module's exports, so the guards and
// their limits, which the tests import, live in api.ts.
export { default } from './api.ts';
