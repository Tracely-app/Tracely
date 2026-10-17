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

/* A failure AFTER the vendor answered: the answer was billed, so the error
 * carries its cost in the same non-enumerable `llm` tag lib/llm.js tagFailure
 * writes, and the central handler charges it to the pool that paid
 * (server.js). Never serialised: the wire body is kind/message/retryAfter. */
export function billedFailure(err, model, usage) {
  if (err && typeof err === "object" && !err.llm && usage) {
    Object.defineProperty(err, "llm", { value: { model: model ?? null, effort: null, usage }, enumerable: false, configurable: true });
  }
  return err;
}
