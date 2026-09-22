// Where Playwright and the browser come from, for the dev scripts in this
// folder. No machine paths are committed (the repo is public):
//   TRACELY_PLAYWRIGHT  module specifier or absolute path of playwright's
//                       index.mjs (default: "playwright" from node_modules)
//   TRACELY_CHROME      browser executable (default: Playwright's own build)
const spec = process.env.TRACELY_PLAYWRIGHT || "playwright";
const mod = await import(spec);
export const chromium = mod.chromium ?? mod.default?.chromium;
export const EXE = process.env.TRACELY_CHROME || undefined;
