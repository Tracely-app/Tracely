/* The error type every AI path throws.
 *
 * Lives in its own module so the provider layer (lib/llm.js) can throw it
 * without importing factcheck.js, which imports the provider — a cycle.
 * factcheck.js re-exports it, so every existing importer is unaffected.
 * The constructor shape is unchanged from where it used to live. */
export class CheckError extends Error {
  constructor(kind, message, { status = 400, retryAfter } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
