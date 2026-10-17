/**
 * What the desktop offers beyond checking facts, evidence and citations — off.
 *
 * Owner, 2026-10-13: "make tracely extension and app both not overpower stuff
 * … It shouldnt help with general writing tips either, so please remove
 * writing tips in general." Chosen the same day, of the desktop's writing
 * help: the grammar, style and off-topic marks, Tracer chat, and the writing
 * guides go; the essay grade (AI Insights) stays.
 *
 * Switches rather than deletions: Tracer is the base of an open PR (Tracer
 * Voice, #330), and the code behind each switch keeps its own tests. The
 * extension's twin is `FEATURES` in extension/content.js (essayFeedback,
 * resumeTips, offTopic).
 */
export const DESKTOP_FEATURES: Readonly<{
  /** Grammar and style underlines in the editor (shared/proseIssues.ts). */
  proseMarks: boolean
  /** The off-topic "tangent" marks (evidence.offTopic) and their "Ask Tracer". */
  offTopicMarks: boolean
  /** The Tracer writing chat: Home's launcher and the editor's toolbar button. */
  tracerChat: boolean
  /** Home's writing guides; "Finding Credible Sources" is about sources and stays. */
  writingGuides: boolean
}> = {
  proseMarks: false,
  offTopicMarks: false,
  tracerChat: false,
  writingGuides: false
}
