/*
 * Ported from the desktop app's src/shared/worksCited.ts — only the part that
 * FINDS a reference list, which is all withoutWorksCited needs.
 *
 * The server strips the list for the same reason the desktop does: the
 * graded read runs on `argumentParagraphs` = splitParagraphs(withoutWorksCited
 * (draft)), and a bibliography is not an argument. Left in, every entry would
 * be numbered as a paragraph, labelled `unknown`, and could be picked as the
 * conclusion because it is last.
 *
 * Not ported: planWorksCited and the dedupe/ordering helpers behind it. They
 * plan an edit to the writer's document through the desktop editor's
 * contentEditable; nothing on the server writes into a draft, so a copy here
 * would be a second implementation with no caller. WORKS_CITED_HEADINGS is
 * ported although only the tests read it, because the heading test runs over
 * it and "the three headings a style writes are all recognised" is the rule
 * findWorksCitedSection exists to keep.
 *
 * test/mirror.test.js runs this copy and the desktop's on a shared corpus
 * whenever the desktop tree is present. The desktop's formatting is kept on
 * purpose, so a diff against the original shows only the TypeScript that had
 * to go; the comments on what is ported follow unedited.
 */

/**
 * What each style calls the list. Recognising all three matters more than
 * writing the right one: a draft that already carries "References" must not
 * grow a second list headed "Works Cited" underneath it because the writer's
 * default style setting says MLA.
 */
export const WORKS_CITED_HEADINGS = {
  MLA: 'Works Cited',
  APA: 'References',
  Chicago: 'Bibliography'
}

/**
 * Any heading that means "the reference list starts here", including forms no
 * style of ours writes — the writer may have typed their own before Tracely
 * inserted anything, and appending a second list below theirs is the failure
 * this exists to prevent.
 *
 * Deliberately narrower than bibliography.ts's HEADING: that one is reading
 * someone else's document and can afford to be generous, this one decides
 * where to WRITE.
 */
const HEADING_LINE =
  /^\s*(works\s+cited|references|reference\s+list|bibliography|literature\s+cited)\s*:?\s*$/i

/**
 * @typedef {object} WorksCitedSection
 * @property {number} start  Offset of the first character of the heading line.
 * @property {number} end  Offset just past the last entry — never past the
 *   trailing blank lines, so replacing [start, end) cannot eat whitespace the
 *   writer left below it.
 * @property {string} heading  The heading as the writer typed it, so a rewrite
 *   preserves their wording.
 * @property {string[]} entries  The non-empty lines under the heading, trimmed,
 *   in document order.
 */

/** @typedef {{ text: string, start: number, end: number }} Line */

/**
 * @param {string} text
 * @returns {Line[]}
 */
function splitLines(text) {
  const lines = []
  let start = 0
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      lines.push({ text: text.slice(start, i), start, end: i })
      start = i + 1
    }
  }
  return lines
}

/**
 * The reference list, or null.
 *
 * Searched from the END of the document, for the reason bibliography.ts
 * searches from the end: an introduction that mentions "references" is prose,
 * and the list is the last thing in an essay. Everything from the heading to
 * the last non-empty line is the section — the same rule that lets the rewrite
 * replace it wholesale, and the reason a writer who keeps drafting *below*
 * their reference list would have that text rewritten. That is a shape no draft
 * has rather than one this refuses: the list is where the document ends.
 *
 * @param {string} text
 * @returns {WorksCitedSection | null}
 */
export function findWorksCitedSection(text) {
  const lines = splitLines(text)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!HEADING_LINE.test(lines[i].text)) continue
    const entries = []
    let end = lines[i].end
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j].text.trim()
      if (body.length === 0) continue
      entries.push(body)
      end = lines[j].end
    }
    return { start: lines[i].start, end, heading: lines[i].text.trim(), entries }
  }
  return null
}

/**
 * The document with any trailing reference list removed.
 *
 * The structure analysis runs on the editor's `innerText`, and a reference list
 * is not an argument. Without this, adding a works-cited section would have
 * quietly broken the argument score: `heuristicRoles` labels those lines
 * `unknown`, which sets `complete: false`, which makes `findWeaknesses`
 * withhold every whole-draft finding — and the conclusion is found as the LAST
 * paragraph, which after this feature is a citation.
 *
 * A suffix trim, deliberately, so every offset before it is unchanged and claim
 * spans computed against the full text still line up with the paragraphs.
 *
 * @param {string} text
 * @returns {string}
 */
export function withoutWorksCited(text) {
  const section = findWorksCitedSection(text)
  return section ? text.slice(0, section.start) : text
}
