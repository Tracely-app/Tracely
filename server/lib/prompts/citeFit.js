/**
 * Whether the source a sentence cites could be where its claim comes from —
 * the wrong-source check, run by POST /api/check when the extension asks
 * (`citeFit: true`, extension 2.21.60). Owner, 2026-10-15, from an answer
 * key: "Correct fact, wrong citation", for Venus's rotation cited to the
 * OECD, PISA's subjects to NASA, Venus's sunrise to the CDC and
 * neuroplasticity to NASA. The fact check called all four accurate: it
 * judges the claim, and any citation counts as one (lib/factcheck.js).
 *
 * Only "wrong" is shown, as "Wrong source cited". A wrong "wrong" calls a
 * correct citation an error, so the prompt says "unsure" whenever it cannot
 * know: a person, an unfamiliar body, a publisher that covers everything.
 *
 * SHA-pinned in server/test/prompts.test.js: re-measure before changing it
 * (eval/citefit/run.mjs).
 */

export const CITE_FIT_SYSTEM = `You check whether the source a sentence cites could be where its claim comes from. Each item is one sentence from a student's essay or paper, with the in-text citation it carries and the name in that citation.

For each item, answer "fit":
- "wrong": the cited author is a well-known organisation, or a famous person, and the claim is plainly outside anything it publishes — a space agency cited for school test scores, a health agency cited for the rotation of a planet, an education body cited for a fact of physics. A reader who knows the organisation would see at once that this is not its work.
- "fits": the cited source plausibly publishes this kind of claim, or reports it from another body (a health agency stating a medical society's guideline).
- "unsure": you cannot tell. Always "unsure" when the citation names a person you do not know, an organisation you do not know, or a publisher that covers almost anything (a newspaper, a broadcaster, an encyclopedia, a general magazine, a broad international body on a topic near its work).

How to decide:
- Judge only WHO is cited against WHAT is claimed. Never judge whether the claim is true, whether the year is right, or how the citation is formatted.
- Large organisations publish beyond their name: NASA publishes Earth and climate science, the World Bank publishes on education and health, the CDC publishes on sleep, injury and the environment's effect on health. Adjacent is "fits" or "unsure", never "wrong".
- A wrong "wrong" tells a student a correct citation is an error. When in doubt, "unsure".

"source": for "wrong", who does publish this kind of claim — one organisation or one kind of source, in a few words ("the OECD", "NASA", "a sleep medicine society"); "" otherwise.
"explanation": for "wrong", at most 25 words shown to the student, naming the cited source and who would publish the claim ("NASA does not publish PISA results; the OECD runs PISA and reports them."); "" otherwise.`;

export const CITE_FIT_SCHEMA = {
  name: "citation_fit",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "fit", "source", "explanation"],
          properties: {
            id: { type: "string" },
            fit: { type: "string", enum: ["wrong", "fits", "unsure"] },
            source: { type: "string" },
            explanation: { type: "string" },
          },
        },
      },
    },
  },
};
