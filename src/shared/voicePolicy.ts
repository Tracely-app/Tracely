/**
 * Tracer Voice numbers the server decides and the desktop only estimates
 * with: what one call may last, what a day allows, and the least any call
 * costs. The server (server/lib/voice.js) is the authority; these copies feed
 * the desktop's fallbacks (a start answer missing its cap, the preview's mock
 * answer, Settings' "minutes left today" estimate). voicePolicy.test.ts reads
 * the server's source and fails when the two disagree.
 */

/** OpenAI bills a WebRTC session's set-up as 15 s, so every call costs at least this. */
export const VOICE_MIN_BILLED_SECONDS = 15
/** One call's cap when the server is not configured otherwise (TRACELY_VOICE_MAX_SECONDS). */
export const VOICE_DEFAULT_MAX_SECONDS = 900
/** A day's allowance when the server is not configured otherwise (TRACELY_VOICE_DAILY_SECONDS). */
export const VOICE_DEFAULT_DAILY_SECONDS = 1800
/**
 * A month's allowance when the server is not configured otherwise
 * (TRACELY_VOICE_MONTHLY_SECONDS; 0 there means no monthly cap). Feeds the
 * preview's mock answer only. Not pinned by voicePolicy.test.ts yet: the
 * server constant lands with the server half of this round.
 */
export const VOICE_DEFAULT_MONTHLY_SECONDS = 7200
