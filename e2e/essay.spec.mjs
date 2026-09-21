import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

/**
 * One real essay, through the real app, end to end.
 *
 * The argument score was rebuilt against this draft after it came back 20/100
 * from the shipped app, and every check since has been a unit test over a
 * hand-split copy of it. That is how the 20 got its wrong diagnosis in the
 * first place: a probe that split the essay itself left the TITLE out, so the
 * thesis rule (which keys on paragraph position) never saw the thesis, and the
 * probe cheerfully reported a number the app could not produce.
 *
 * So this types the draft — title included — into the real editor and asks the
 * real main-process service, over the real IPC bridge, with the real
 * `splitParagraphs` deriving the paragraphs from `innerText`. Nothing here
 * re-implements a step the app performs.
 *
 * WHAT IT DOES NOT COVER: claim detection is a relay call, and `test:e2e`
 * builds with the relay blanked on purpose (see electron.vite.e2e.config.mts —
 * a test that can reach `callServer` can spend money). So this is the
 * zero-claims reading: role labelling falls back entirely to the sentence-shape
 * heuristics, which is the harder case and the one worth pinning. With claims
 * the labels can only become MORE confident, never less.
 */

const REPO = resolve(import.meta.dirname, '..')

/** The draft as the app receives it: a title line, then four paragraphs. */
const PARAGRAPHS = [
  'More Than a Pretty Face: Audrey Hepburn',
  '"I was born with an enormous need for affection and a terrible need to give it" ("Actress"). Audrey Hepburn was born to an English father and a Dutch mother in Brussels, Belgium, on May 4th, 1929. For a portion of her childhood, she was satisfied, happy, and healthy, until WWII. Hepburn was greatly affected by the prejudice against Jewish people, or antisemitism, that surrounded her. Audrey Hepburn\'s dreams were ruined by several traumatic and lasting events due to the effects of the cataclysm of the early-mid 20th century, which would later have a large impact on her future life events and career. Raised by Nazi sympathizers, Audrey strongly opposed the views of her parents and went against them by aiding the Dutch resistance in various ways, so even in her early life, she was morally inclined to help others in their own struggles. After WWII impacted her physical health, her dreams of becoming a professional dancer were shattered, so she started playing small roles until she found herself becoming increasingly popular on screen. Her career in film was a coincidental stroke of serendipity that caused her influence and name to be more widespread. Rather than use her popularity for personal good, Hepburn used her name as a tool to bring awareness towards people in need by working with UNICEF. Whilst helping others is typically a moral obligation, Audrey Hepburn\'s early struggles sparked a passion to help others in dire situations which set her apart from celebrities in her time.',
  'Audrey Hepburn was always naturally inclined to help others. Although her concern for the well-being of humanity was greatly motivated by her sympathy towards those in troublesome situations, her good deeds sprouted from the natural kindness she was born with. Hepburn had started working against the Nazi party shortly after an event in 1942 where "her uncle, Otto van Limburger Stirim, was executed in retaliation for an act of sabotage by the resistance movement, [and] while he had not been involved in the act, he was targeted due to his family\'s prominence in Dutch society" ("Audrey" Wikipedia). Following the death of her uncle, Hepburn raised money for the Dutch Resistance via silent dance performances. She had largely contributed to the resistance by participating in "underground" activities such as delivering newspapers and "taking messages and food to downed Allied flyers". She also volunteered in a hospital that was involved with resistance activity. Knowing and experiencing the pain that others had to suffer through, she did what she could to help bring others relief in uneasy times. This period was tough for everyone, but Hepburn gave what she could and put others before herself which underlines her genuine concern for other people.',
  'Audrey Hepburn was a prominent individual in an industry of prominent people, but she stood out not only because of her talent and compassion in her work but because of her compassion for people. Shortly after D-Day, living conditions in Arnhem became extreme, and people in the Netherlands struggled to survive, Hepburn, being one of them. This was caused by the Nazis who wanted to kill the population by starving them to death. She devolved anemia, respiratory difficulties, and oedema because of her consequential malnutrition, which prevented her from becoming a full-time dancer. Surviving on boiled grass and tulip bulbs, the people of Arnhem who were inches from death received medical help from UNICEF, hence her "long-lasting gratitude for what UNICEF does" ("Audrey" UNICEF). Rather than be swallowed by pride and self-worth, Hepburn remembered where she came from. By remembering the days where she herself was struggling to survive, she was down to earth and kept humble even throughout her career. A catapult crafted from her fame, fortune, and beauty, Hepburn\'s comforts and advantages at the peak of her life were used to help others and "devoted much of her time to UNICEF, to which she had contributed since 1954" ("Audrey" Wikipedia). Her selfless acts of dedication distinguished her from not her work in film, but her work in humanitarianism displayed a different side of her portraying a normal human being with good natures rather than some on-screen phenomenon.',
  '"As you grow older, you will discover that you have two hands, one for helping yourself, the other for helping others". Iconic in Hollywood, but overlooked in philanthropy, Audrey Hepburn was set apart from celebrities because of her sincere love for people and their well-being. The legacy she left behind tends to reside in the film industry, but she was more than just a pretty face. In her final years, she spent her time working towards bringing basic necessities, education, comfort, and love to underprivileged people. Audrey Hepburn\'s life came to an end on January 20th, 1993, her name still lives on with the Audrey Hepburn Memorial Fund at UNICEF to continue her humanitarian work.'
]

/** See undo.spec.mjs for why the userData is throwaway and the arg is the repo. */
function launchIsolated() {
  const userData = mkdtempSync(join(tmpdir(), 'tracely-e2e-'))
  return {
    userData,
    app: electron.launch({ args: [REPO, `--user-data-dir=${userData}`], cwd: REPO })
  }
}

async function teardown(app, userData) {
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {})
  await app.close().catch(() => {})
  rmSync(userData, { recursive: true, force: true })
}

async function mainWindow(app, timeoutMs = 30_000) {
  const isMain = (w) => w.url().endsWith('/index.html')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = app.windows().find(isMain)
    if (found) return found
    if (Date.now() > deadline) {
      throw new Error(`no index.html window after ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('the Hepburn essay scores in the real app, with the title excluded from the body', async (t) => {
  const { userData, app: launching } = launchIsolated()
  const app = await launching
  t.after(async () => {
    await teardown(app, userData)
  })

  const page = await mainWindow(app)
  await page.waitForLoadState('domcontentloaded')

  const gated = await page.locator('text=PASSWORD').first().isVisible().catch(() => false)
  assert.equal(gated, false, 'the auth gate is showing — run via `npm run test:e2e`')

  // Home → Documents → a new untitled one. "New Session" and its naming field
  // are gone; the Documents page (Figma 58:172) is the way in now.
  await page.getByRole('button', { name: /View all documents/i }).click()
  await page.getByRole('button', { name: /New document/i }).click()
  const body = page.locator('.docedit-body')
  await body.waitFor({ state: 'visible' })

  // Typed with real Enters, so the paragraph boundaries are the <div>-per-line
  // structure contentEditable actually produces — which is exactly why
  // splitParagraphs treats ANY newline run as a boundary rather than requiring
  // a blank line. Pasting a \n\n-joined string would test a document shape the
  // editor never creates.
  await body.click()
  for (const [i, paragraph] of PARAGRAPHS.entries()) {
    if (i > 0) await page.keyboard.press('Enter')
    await page.keyboard.insertText(paragraph)
  }
  await page.waitForTimeout(300)

  const text = await body.innerText()
  assert.ok(text.includes('More Than a Pretty Face'), 'the title did not reach the editor')

  // Straight at the real bridge. The toolbar button would detect claims first,
  // and detection is the relay call this build has no URL for — so driving the
  // button here would measure the blanked relay rather than the scorer.
  const outline = await page.evaluate(async (draft) => {
    const res = await window.tracely.structure.analyze({ documentId: null, text: draft, analysisId: null })
    return res.outline
  }, text)

  const roles = outline.paragraphs.map((p) => p.role)
  console.log('  paragraphs:', outline.paragraphs.length)
  console.log('  roles     :', roles.join(', '))
  console.log('  title?    :', outline.titleParagraph)
  console.log('  complete  :', outline.complete)
  console.log('  SCORE     :', outline.score)
  console.log('  components:', JSON.stringify(outline.components ?? outline.scoreComponents ?? null))

  assert.equal(outline.paragraphs.length, 5, 'the draft did not split into title + four paragraphs')

  // The bug that produced 20/100: the title occupied paragraph 1, so the thesis
  // rule — which keys on position — was reading the title's own line.
  assert.equal(outline.titleParagraph, true, 'the title line was not recognised as a title')
  assert.equal(roles[0], 'unknown', 'the title was given a rhetorical role')
  assert.equal(roles[1], 'thesis', 'the introduction was not labelled thesis')
  assert.equal(roles[roles.length - 1], 'conclusion', 'the last paragraph was not labelled conclusion')

  // The number the whole rebuild was aimed at. Asserted as a floor rather than
  // an equality: this run has no claims (see the header), and claims can only
  // raise the governing-claims component.
  assert.ok(
    outline.score >= 70,
    `the essay scored ${outline.score} in the real app, not the high-70s the rebuild targeted`
  )
})
