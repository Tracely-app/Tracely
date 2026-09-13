// Realistic stand-in data for the preview harness. Deliberately plausible
// rather than lorem ipsum: the whole point of previewing is to catch things
// like "this venue name wraps to three lines" or "an et-al author list
// overflows the card", and placeholder text hides exactly those.
import type {
  ProfileInfo,
  ResolvedCitedWork,
  ScreenWatchClaimSummary,
  ScreenWatchOverlayUpdateEvent,
  ScreenWatchStructure,
  ScreenWatchStatus,
} from '@shared/ipc-contract'
import type {
  Analysis,
  AppSettings,
  AuthUser,
  Citation,
  Claim,
  DocumentListItem,
  DocumentOutline,
  DocumentRecord,
  EvidenceItem,
  LibraryItem,
  Source,
  TracerConversation,
  TracerMessage
} from '@shared/types'

// Fixed rather than Date.now() so a screenshot taken today and one taken
// next week are byte-identical — a preview that changes on its own is
// useless for spotting a change you actually made.
export const T0 = '2026-03-14T16:20:00.000Z'

// The anonymous session the app creates for itself, which is the only
// identity there is — no sign-in, so no email, no name, no username. Kept as
// a fixture rather than inlined because `configured`/`getUser` still answer
// with it and the harness logs those calls.
export const user: AuthUser = {
  id: 'u_preview',
  email: null,
  firstName: null,
  username: null
}

// Local display profile. It is where a name actually lives now — `user` above
// is the anonymous Supabase identity and carries none.
export const profile: ProfileInfo = {
  firstName: 'Merrick',
  lastName: 'Han',
  bio: 'High-school senior building tools for people who have to cite things.',
  avatarUrl: null
}

export const settings: AppSettings = {
  defaultCitationStyle: 'APA',
  hotkeyAccelerator: 'Control+Shift+T',
  enableStrengthSummaries: true,
  theme: 'light',
  accentColor: 'orange',
  density: 'comfortable',
  fontSize: 'medium',
  claimSensitivity: 0.5,
  screenWatchHotkeyAccelerator: 'Control+Shift+W',
  screenWatchAllowedApps: 'WINWORD.EXE\nchrome.exe',
  // Off, so the harness shows the Save changes dialog rather than skipping it.
  suppressSaveConfirm: false,
  gradingLevel: 12,
  autoCritiqueCited: true,
  // The stored request, not what runs: the harness's default scenario is a free
  // account, so Preferences resolves this to Fast with the other two locked.
  modelTier: 'thorough'
}

export const sources: Source[] = [
  {
    id: 's1',
    doi: '10.1016/j.chb.2023.107891',
    title: 'Adolescent screen time and depressive symptoms: a three-year longitudinal cohort',
    authors: [
      { given: 'Amelia', family: 'Okonkwo' },
      { given: 'Rui', family: 'Zhang' },
      { given: 'Petra', family: 'Lindqvist' },
      { given: 'Daniel', family: 'Ferreira' }
    ],
    year: 2023,
    venue: 'Computers in Human Behavior',
    venueType: 'journal',
    url: 'https://doi.org/10.1016/j.chb.2023.107891',
    pdfUrl: null,
    abstract:
      'Using a three-year longitudinal design (n = 4,218), we find that baseline depressive symptoms predict later screen time more strongly than the reverse, complicating unidirectional causal accounts.',
    provider: 'openalex',
    providerId: 'W4312',
    citationCount: 184,
    oaStatus: 'green',
    createdAt: T0
  },
  {
    id: 's2',
    doi: '10.1073/pnas.2210918120',
    title: 'Reassessing the association between digital media use and adolescent well-being',
    authors: [{ given: 'Sofia', family: 'Marchetti' }, { family: 'Bell' }],
    year: 2022,
    venue: 'Proceedings of the National Academy of Sciences',
    venueType: 'journal',
    url: 'https://doi.org/10.1073/pnas.2210918120',
    pdfUrl: 'https://example.org/pnas.pdf',
    abstract:
      'Specification-curve analysis across three large datasets shows effect sizes small enough to be comparable to the association between well-being and eating potatoes.',
    provider: 'crossref',
    providerId: 'C9931',
    citationCount: 902,
    oaStatus: 'gold',
    createdAt: T0
  },
  {
    id: 's3',
    doi: null,
    title: 'Screen exposure in early adolescence: a preregistered replication',
    authors: [{ given: 'Tomás', family: 'Iglesias-Muñoz' }],
    year: 2024,
    venue: 'PsyArXiv',
    venueType: 'preprint',
    url: 'https://psyarxiv.com/example',
    pdfUrl: null,
    abstract: null,
    provider: 'semanticscholar',
    providerId: 'S771',
    citationCount: 12,
    oaStatus: null,
    createdAt: T0
  },
  /**
   * A real work with NO author, which is the state the in-text marker used to
   * render as "(Unknown Author, 2025)".
   *
   * Reported by the owner, 2026-08-19, from a live picker. The reference entry
   * correctly led with the title while the marker above it named a person who
   * appears nowhere in the list — and there was no fixture in this state, so
   * the preview could not show it.
   *
   * The title is deliberately long: the marker has to shorten it to sit inside
   * a sentence, and a four-word cut is only visibly right on something that
   * needs cutting.
   */
  {
    id: 's4',
    doi: '10.13051/ee:doc/smitadou0010411a1c',
    title: 'Robert Hepburn and Adam Smith to [unknown], Thursday, 6 August 1789',
    authors: [],
    year: 2025,
    venue: 'Electronic Enlightenment Scholarly Edition of Correspondence',
    venueType: 'reference',
    url: null,
    pdfUrl: null,
    abstract: null,
    provider: 'crossref',
    providerId: 'C904',
    citationCount: null,
    oaStatus: null,
    createdAt: T0
  },
  /**
   * The reported case, as two sources rather than a description of it.
   *
   * Owner, 2026-08-21, on what a web search returned for one sentence: TIME
   * beside Historydraft, offered as equals. A marker accepts the first without
   * argument and takes marks off for the second, and nothing on the card said
   * which was which. These two are here so the harness can show the difference
   * — the academic fixtures above only ever exercise the scholarly tier.
   */
  {
    id: 's5',
    doi: null,
    title: 'How a Young Audrey Hepburn Helped the Dutch Resistance During World War II',
    authors: [{ given: 'Robert', family: 'Matzen' }],
    year: 2019,
    venue: 'TIME',
    venueType: 'other',
    url: 'https://time.com/5622911/audrey-hepburn-dutch-resistance/',
    pdfUrl: null,
    abstract: null,
    provider: 'web',
    providerId: 'https://time.com/5622911/audrey-hepburn-dutch-resistance/',
    citationCount: null,
    oaStatus: null,
    createdAt: T0
  },
  {
    id: 's6',
    doi: null,
    title: 'Audrey Hepburn timeline',
    authors: [],
    year: null,
    venue: 'Historydraft',
    venueType: 'other',
    url: 'https://historydraft.com/story/audrey-hepburn/timeline/1',
    pdfUrl: null,
    abstract: null,
    provider: 'web',
    providerId: 'https://historydraft.com/story/audrey-hepburn/timeline/1',
    citationCount: null,
    oaStatus: null,
    createdAt: T0
  }
]

// Deliberately one of each stance, so the preview exercises every badge state
// rather than only the common one: 'supports' and 'contradicts' render a chip,
// null renders nothing. Null is not "neutral" — it means the question was never
// asked, because the source did not clear the relevance bar or the model was
// unavailable.
const STANCES: Array<Pick<EvidenceItem, 'stance' | 'stanceConfidence'>> = [
  { stance: 'supports', stanceConfidence: 0.82 },
  { stance: 'contradicts', stanceConfidence: 0.88 },
  { stance: null, stanceConfidence: null },
  { stance: null, stanceConfidence: null },
  { stance: 'supports', stanceConfidence: 0.7 },
  { stance: null, stanceConfidence: null }
]

// Indexed by position rather than spread over `sources`, so adding a source
// without giving it a score is a visible `undefined` in the picker instead of a
// silent NaN%. One per source, and the table is the length check.
const RELEVANCE = [0.91, 0.78, 0.54, 0.47, 0.62, 0.71]

export const evidence: EvidenceItem[] = sources.map((source, i) => ({
  source,
  relevanceScore: RELEVANCE[i],
  rank: i + 1,
  ...STANCES[i]
}))

export const analysis: Analysis = {
  id: 'a1',
  sourceText:
    'Screen time causes depression in teenagers. Studies show that 70% of adolescents who use social media for more than three hours a day report symptoms of anxiety. Studies prove that later school start times always improve student outcomes (Wahlstrom 2014). This is the clearest public-health crisis of our generation.',
  origin: 'main',
  createdAt: T0
}

export const claims: Claim[] = [
  {
    id: 'c1',
    analysisId: 'a1',
    text: 'Screen time causes depression in teenagers.',
    claimType: 'causal',
    confidence: 0.93,
    searchQuery: 'screen time adolescent depression causal',
    strengthScore: 34,
    // Low support is what makes this a 34: one source agrees, one disagrees.
    //
    // sourceCount is a FRACTION, not a tally: min(relevant, 6) / 6 in
    // services/search/scoring.ts. Three of the six-source cap cleared the
    // relevance floor, so 3/6 = 0.5. It read `3` until 2026-08-16, which is a
    // value the formula cannot produce — and it was the reason the preview
    // could not show the bug that field caused, since an integer passed off as
    // a source count looks exactly like a source count.
    scoreBreakdown: { sourceCount: 0.5, quality: 0.8, recency: 0.9, relevance: 0.6, support: 0.1 },
    // Carries markdown on purpose. The relay's prompts neither request nor
    // forbid it and gpt-4.1 emits it freely, so this is what the surface
    // actually receives — keeping it here means the preview exercises
    // MarkdownText rather than a sanitised version of production output.
    critique:
      'The cited work is **cross-sectional**, so it cannot separate "screen time causes depression" from "depressed teenagers use their phones more."\n\nTwo ways forward:\n\n- State the *association* rather than the cause.\n- Find a longitudinal source that measures screen time first.',
    critiqueVerdict: 'weak',
    // Null on purpose, and not an oversight: the relay sets suggestedRevision
    // for overstatement and for nothing else — "softening a false claim into a
    // vague one is not a fix" — so a 'weak' verdict is the case where the fix
    // card has no replacement text to offer and falls back to the critique's
    // own points. That is the branch this claim exercises.
    suggestedRevision: null,
    citedWorkRead: null,
    retrievalGeneration: 2,
    citationFix: null,
    createdAt: T0
  },
  {
    id: 'c2',
    analysisId: 'a1',
    // No trailing full stop: the sentence now ends '…anxiety (Unknown Author,
    // 2025).', and a detected claim is a sub-span that stops before the
    // citation — which is exactly why sentenceAround exists.
    text: '70% of adolescents who use social media for more than three hours a day report symptoms of anxiety',
    claimType: 'statistic',
    confidence: 0.87,
    searchQuery: 'adolescents social media three hours anxiety prevalence',
    strengthScore: 61,
    // 2 of the 6-source cap on topic: 2/6 = 0.333…
    scoreBreakdown: { sourceCount: 1 / 3, quality: 0.7, recency: 0.8, relevance: 0.75, support: 0.33 },
    critique: null,
    critiqueVerdict: null,
    suggestedRevision: null,
    citedWorkRead: null,
    retrievalGeneration: 2,
    citationFix: null,
    createdAt: T0
  },
  // The editor's counterpart to the overlay's c4 — an 'overstated' verdict with
  // a narrowed sentence attached, which is the only state where the fix card
  // has something to APPLY. Mirrors the Screen Watch fixture deliberately: the
  // two surfaces draw the same card from the same claim state, and a difference
  // between them should be visible side by side in the harness.
  {
    id: 'c4',
    analysisId: 'a1',
    text: 'Studies prove that later school start times always improve student outcomes (Wahlstrom 2014).',
    claimType: 'causal',
    confidence: 0.81,
    searchQuery: 'later school start times student outcomes',
    strengthScore: 68,
    scoreBreakdown: { sourceCount: 0.9, quality: 0.81, recency: 0.6, relevance: 0.74, support: 0.66 },
    critique:
      '**Overstated, not wrong.** Evidence 2 and 4 report improved attendance and sleep duration, but neither supports "always" — both note effects varying by district and grade level.',
    critiqueVerdict: 'overstated',
    suggestedRevision:
      'Studies indicate that later school start times generally improve student outcomes (Wahlstrom 2014).',
    citationFix:
      'Wahlstrom, Kyla. "Later Start Time for Teens Improves Grades, Mood, and Safety." Phi Delta Kappan, 2014, p. 12.',
    citedWorkRead: true,
    retrievalGeneration: 2,
    createdAt: T0
  },
  // Searched, and nothing cleared the relevance floor — every factor 0 by
  // construction, because they are all computed over the sources that passed
  // it. Reported by the owner on 2026-08-19 over a correctly cited biographical
  // sentence: "How is the support 0%, relevance 0%, recency 0, and quality 0?
  // It just doesn't make sense."
  //
  // Here so the harness covers the branch where the card must NOT print a
  // score. Without a fixture in this state the unmeasured path is unreachable
  // in the preview, and it is the state the four scholarly indexes put a whole
  // category of true sentences into.
  {
    id: 'c5',
    analysisId: 'a1',
    text: 'She had largely contributed to the resistance by delivering underground newspapers and taking messages to downed Allied flyers (Walker, 2010).',
    claimType: 'factual',
    confidence: 0.88,
    searchQuery: 'Dutch resistance underground newspapers Allied airmen',
    strengthScore: 0,
    scoreBreakdown: { sourceCount: 0, quality: 0, recency: 0, relevance: 0, support: 0 },
    critique: null,
    critiqueVerdict: null,
    suggestedRevision: null,
    citedWorkRead: null,
    retrievalGeneration: 2,
    citationFix: null,
    createdAt: T0
  },
  /**
   * A citation the critique OPENED, and doubted.
   *
   * The one state that licenses 'cited-unverified' since 2026-08-19: a
   * parenthetical the reference lookup could resolve, a resolved work handed to
   * the critique in slot 1, and a doubting verdict reached with it in hand.
   * `hasRelevantSource` is deliberately FALSE here — the topical search found
   * nothing on Norwegian cohort data — because that is the branch the old
   * `!nothingFound` guard was wrongly suppressing, and it is the most valuable
   * finding the product has.
   *
   * Flip `citedWorkRead` to false to see the whole mark disappear, which is
   * what the owner asked for on 2026-08-19.
   */
  {
    id: 'c6',
    analysisId: 'a1',
    text: 'Longitudinal data from Norway tracked 2,000 students over four years',
    claimType: 'factual',
    confidence: 0.9,
    searchQuery: 'Norway longitudinal adolescent screen time cohort',
    strengthScore: 0,
    scoreBreakdown: { sourceCount: 0, quality: 0, recency: 0, relevance: 0, support: 0 },
    critique:
      'The cited work is a **methods paper** on survey weighting in Norwegian panel studies. It does not report a four-year adolescent cohort, and gives no figure resembling 2,000 students.',
    critiqueVerdict: 'weak',
    suggestedRevision: null,
    citedWorkRead: true,
    retrievalGeneration: 2,
    citationFix: null,
    createdAt: T0
  },
  {
    id: 'c3',
    analysisId: 'a1',
    text: 'This is the clearest public-health crisis of our generation.',
    claimType: 'opinion',
    confidence: 0.55,
    searchQuery: 'public health crisis generation screen time',
    strengthScore: null,
    scoreBreakdown: null,
    critique: null,
    critiqueVerdict: null,
    suggestedRevision: null,
    citedWorkRead: null,
    retrievalGeneration: 2,
    citationFix: null,
    createdAt: T0
  },
  {
    id: 'c7',
    analysisId: 'a1',
    text: 'Lamine Yamal is 22 years old',
    claimType: 'factual',
    confidence: 0.55,
    searchQuery: 'Lamine Yamal age',
    // Searched, and the academic indexes had nothing — which is what happens to
    // a tangent. The mark still has to be DRAWN for the off-topic finding to be
    // reachable at all: measureMarks refuses a claim with no evidence, so a
    // null score here would make this fixture invisible.
    strengthScore: 8,
    scoreBreakdown: { sourceCount: 0, quality: 0, recency: 0, relevance: 0, support: 0 },
    critique: null,
    critiqueVerdict: null,
    suggestedRevision: null,
    citedWorkRead: null,
    retrievalGeneration: 2,
    citationFix: null,
    createdAt: T0
  }
]

/**
 * The work a sentence cites, as `citation.resolveCited` resolves it.
 *
 * Two, because the comparison has two outcomes and only one of them is the
 * happy path. `citedFound` is a Crossref match dated a year off the citation —
 * routine, allowed by YEAR_TOLERANCE, and the case that would look like a wrong
 * work if the card printed one year silently over the other. `citedMissing` is
 * a real reference to something neither index holds, which the card must report
 * as an empty lookup and never as a verdict. See shared/citedComparison.ts.
 */
export const citedFound: ResolvedCitedWork = {
  raw: '(Halvorsen, 2021)',
  surnames: ['Halvorsen'],
  year: 2021,
  citedTitle: null,
  found: true,
  title: 'Survey weighting in Norwegian adolescent panel studies',
  matchedYear: 2022,
  doi: '10.1111/nord.12488',
  url: 'https://doi.org/10.1111/nord.12488',
  index: 'crossref'
}

export const citedMissing: ResolvedCitedWork = {
  raw: '(Unknown Author, 2025)',
  surnames: ['Unknown'],
  year: 2025,
  citedTitle: null,
  found: false,
  title: null,
  matchedYear: null,
  doi: null,
  url: null,
  index: null
}

export const citations: Citation[] = [
  {
    id: 'cite1',
    sourceId: 's1',
    style: 'APA',
    formattedText:
      'Okonkwo, A., Zhang, R., Lindqvist, P., et al. (2023). Adolescent screen time and depressive symptoms: a three-year longitudinal cohort. Computers in Human Behavior.',
    createdAt: T0
  },
  // One per source, so the picker's "WILL BE INSERTED" block can show a marker
  // and an entry that BELONG TOGETHER. With only s1 here the mock fell back to
  // it for every selection, and the block showed s3's in-text marker beside
  // s1's works-cited entry — which reads exactly like a real formatting bug and
  // would equally have hidden one.
  {
    id: 'cite2',
    sourceId: 's2',
    style: 'APA',
    formattedText:
      'Marchetti, S., & Bell. (2022). Reassessing the association between digital media use and adolescent well-being. Proceedings of the National Academy of Sciences. https://doi.org/10.1073/pnas.2022114119',
    createdAt: T0
  },
  {
    // A preprint, so the locator is its DOI — see shared/citationLocator.ts,
    // where 'preprint' is one of the venue types that keeps one.
    id: 'cite3',
    sourceId: 's3',
    style: 'APA',
    formattedText:
      'Iglesias-Muñoz, T. (2024). Screen exposure in early adolescence: a preregistered replication. PsyArXiv. https://doi.org/10.31234/osf.io/preg2024',
    createdAt: T0
  },
  {
    // The no-author entry, written exactly as formatters/apa.ts writes one: the
    // TITLE takes the author position. It is here so the picker's "WILL BE
    // INSERTED" block shows a marker and an entry that AGREE — a short form of
    // the title above the full title below, which is the whole point of an
    // in-text marker and the thing "(Unknown Author, 2025)" broke.
    //
    // No locator, and that is `citationLocator` working rather than an
    // omission: venueType 'reference' never carries a DOI, and this source has
    // no URL.
    id: 'cite4',
    sourceId: 's4',
    style: 'APA',
    formattedText:
      'Robert Hepburn and Adam Smith to [unknown], Thursday, 6 August 1789. (2025). Electronic Enlightenment Scholarly Edition of Correspondence.',
    createdAt: T0
  }
]

export const libraryItems: LibraryItem[] = [
  {
    id: 'l1',
    sourceId: 's1',
    claimId: 'c1',
    notes: 'Best longitudinal counter-example to the causal framing.',
    tags: ['screen-time', 'longitudinal'],
    savedAt: T0,
    source: sources[0]
  },
  {
    id: 'l2',
    sourceId: 's2',
    claimId: null,
    notes: null,
    tags: [],
    savedAt: T0,
    source: sources[1]
  }
]

// One saved document, so the editor's reopen-where-you-left-off path has
// something to reopen in the preview.
// Six paragraphs rather than two, because the Structure panel renders one row
// per paragraph and a two-paragraph document exercises none of what makes that
// list hard: an unlabelled paragraph, a warrant gap, and enough rows to scroll.
// Typed DocumentListItem, so the Documents page (58:172) has a grid to draw.
// The grades are the point of the extra entries: the card's chip changes colour
// across bands, and one document is deliberately UNGRADED — the state a draft
// is in before anything has read it, which is what a new user sees on every
// card and so the one worth being able to look at.
export const documents: DocumentListItem[] = [
  {
    id: 'doc-1',
    title: 'Screen time essay — draft 2',
    bodyHtml:
      '<div>Screen time causes depression in teenagers.</div><div><br></div>' +
            // Carries a DEFECTIVE citation, so the harness can reach the
      // 'citation-defect' card and its Replace button. A placeholder author
      // and a year that has not happened are both decidable from the shape
      // alone — see shared/citationShape.ts — so this needs no search, no
      // critique and no relay to light up.
      '<div>Studies show that <b>70%</b> of adolescents who use social media for more than three hours a day report symptoms of anxiety (Unknown Author, 2025).</div><div><br></div>' +
      // Carries a WELL-FORMED citation whose work the critique actually read
      // and doubted (claim c6, citedWorkRead: true). The only state in which
      // 'cited-unverified' may be raised — and the harness had no fixture in
      // it, so the card's copy was unreachable in the preview.
      '<div>Longitudinal data from Norway tracked 2,000 students over four years (Halvorsen, 2021). The effect persisted after controlling for baseline mental health, which basically suggests the relationship is not merely correlational.</div><div><br></div>' +
      // A SECOND copy of the same defective citation. Owner, 2026-08-20:
      // *"this keeps appearing."* replaceCitationText required the text to be
      // unique in the whole document, so two sentences sharing one bad
      // reference made BOTH unfixable — and one bad reference pasted after
      // several sentences is the ordinary way this happens. Without a second
      // copy here the harness cannot reach that failure at all.
      '<div>Schools in three districts have already moved to ban phones during instructional hours (Unknown Author, 2025).</div><div><br></div>' +
      '<div>This matters because policy is being written now, before the evidence has settled.</div><div><br></div>' +
      // A TANGENT — true, unrelated, and the only way to reach the 'off-topic'
      // underline in the harness. Owner, 2026-08-22: a random sentence pasted
      // onto the end of an essay should be flagged both for being false and for
      // being irrelevant, and the second half had no fixture at all. Sits
      // before the conclusion so it reads as a paragraph of the draft rather
      // than as a stray line after it.
      '<div>Lamine Yamal is 22 years old.</div><div><br></div>' +
      '<div>In conclusion, the link is real but weaker than the debate assumes.</div>',
    createdAt: T0,
    updatedAt: T0,
    // Hand-traced below with the outline: 20 + 10 + 0 + 0 + 15 + 10 = 55, which
    // gradeFor bands as a C. Written as a literal so a change to scoreDraft
    // shows up as a disagreement with that trace rather than following it.
    score: 55,
    gradedAt: T0
  },
  {
    id: 'doc-2',
    title: 'The Cold War Redefined',
    bodyHtml: '<div>A second saved draft, listed but not opened in the preview.</div>',
    createdAt: T0,
    updatedAt: T0,
    // 82 is the score the Figma grade card is drawn around, and gradeFor bands
    // it B+ — so this entry is also the check that the chip and the grade panel
    // agree on one number.
    score: 82,
    gradedAt: T0
  },
  {
    id: 'doc-3',
    title: 'Macbeth Character Analysis',
    bodyHtml: '<div>A third saved draft.</div>',
    createdAt: T0,
    updatedAt: T0,
    score: 91,
    gradedAt: T0
  },
  {
    id: 'doc-4',
    title: 'Untitled document',
    bodyHtml: '<div>Written but never analysed.</div>',
    createdAt: T0,
    updatedAt: T0,
    // The ungraded state, and not an error: no chip, and the card says so
    // rather than showing a letter nothing computed.
    score: null,
    gradedAt: null
  }
]

// What the LOCAL heuristics actually produce for the document above — not an
// idealised outline. The heuristics can only emit thesis / claim /
// counterargument / significance / conclusion / unknown, so paragraphs 3 and 4
// come back unlabelled, `complete` is false, and the panel must show
// "provisional". Faking a fully-labelled outline here would hide the exact
// state most users see before the classifier ships.
//
// Score traces by hand: thesis 20 + governing claims 10 (1 of 2 expected in a
// 4-paragraph body) + warrant 0 (the one paragraph owing a warrant has none)
// + counterargument 0 + significance 15 + conclusion 10 = 55.
export const documentOutline: DocumentOutline = {
  documentId: 'doc-1',
  analysisId: 'a1',
  sourceHash: 'preview-hash-draft-2',
  schemaVersion: 1,
  paragraphs: [
    { index: 1, role: 'thesis', hasWarrant: false, claimIds: ['c1'] },
    { index: 2, role: 'claim', hasWarrant: false, claimIds: ['c2'] },
    { index: 3, role: 'unknown', hasWarrant: true, claimIds: [] },
    { index: 4, role: 'unknown', hasWarrant: false, claimIds: [] },
    { index: 5, role: 'significance', hasWarrant: false, claimIds: [] },
    { index: 6, role: 'conclusion', hasWarrant: false, claimIds: [] }
  ],
  score: 55,
  components: {
    thesis: 20,
    governingClaims: 10,
    warrant: 0,
    counterargument: 0,
    significance: 15,
    conclusion: 10
  },
  complete: false,
  applicable: true,
  rolesFrom: 'heuristic',
  // Six paragraphs, so five boundaries, one of which is flagged. A real value
  // rather than the `null` the type also allows: null is what a row written
  // before cohesion existed restores as, and a fixture standing in for that
  // would leave the harness with no way to look at the feature at all.
  cohesion: {
    score: 72,
    boundaries: 5,
    findings: [
      {
        kind: 'no-transition',
        fromIndex: 2,
        toIndex: 3,
        message: 'Nothing bridges these paragraphs; the next one starts cold.'
      }
    ]
  },
  // Matches the `claims` fixture: c1 and c2 searched and sourced, c3 never
  // searched. Kept consistent deliberately — an outline claiming 2 detected
  // beside a list of 3 is the kind of quiet mismatch the preview exists to
  // surface, not to contain.
  // `outsideIndexes: 0` — none of these three claims trips retrievalScopeFor,
  // so the report's sub-line reads exactly as it did before that field existed
  // and this fixture covers the unchanged path.
  coverage: {
    detected: 3,
    withRelevantSource: 2,
    withOwnCitation: 1,
    meanStrength: 48,
    unchecked: 1,
    outsideIndexes: 0
  },
  weaknesses: [
    {
      kind: 'warrant-gap',
      paragraphIndex: 2,
      claimId: 'c2',
      message:
        'Paragraph 1 presents a claim without explaining how it supports the argument.',
      tracerPrompt:
        'In Paragraph 1, how do I explain what my evidence actually shows without just restating it?'
    },
    // A finding read off the PROSE rather than the role vector — the only kind
    // that carries `quote`. Here so the preview covers the branch where a
    // weakness has no claim behind it and the card falls back to the writer's
    // own words: without one, `argscore-problem-quote` renders for every
    // fixture weakness through the claim path and never through this one.
    {
      kind: 'overreaching-claim',
      paragraphIndex: 3,
      claimId: null,
      message:
        'Paragraph 2 states something absolutely — "always", "everyone", "proves". A claim with no exceptions is one a single counter-example defeats.',
      tracerPrompt:
        'I have used absolute words like "always" and "everyone" in my draft. How do I narrow those without sounding like I am hedging everything?',
      quote: 'Everyone who worked with her noticed the difference.'
    },
    // Points at c5, whose search cleared nothing, so the card must NOT print
    // "· 0/100 evidence" beside the title.
    //
    // `claimsWithoutEvidence` no longer PRODUCES this for a cited claim — that
    // is the fix — but every outline stored before 2026-08-19 still carries
    // one, and those render until the document is re-analysed. So this is not
    // a stale fixture: it is the state a returning user's report is in, and the
    // renderer has to be honest about it without a re-run.
    {
      kind: 'unsupported-claim',
      paragraphIndex: 3,
      claimId: 'c5',
      message: 'The claim in Paragraph 2 has no supporting source yet.',
      tracerPrompt:
        'Tracely could not find evidence for one of my claims. How should I go about checking it?'
    }
  ],
  analyzedAt: T0
}

// The same document as the relay classifier would label it: every paragraph
// resolved, so the panel drops the "provisional" badge and whole-draft
// weaknesses become sayable. Selected by the "classified" preview scenario —
// without it the confident state is unreachable with no relay running.
export const documentOutlineClassified: DocumentOutline = {
  ...documentOutline,
  paragraphs: [
    { index: 1, role: 'thesis', hasWarrant: false, claimIds: ['c1'] },
    { index: 2, role: 'evidence', hasWarrant: false, claimIds: ['c2'] },
    { index: 3, role: 'evidence', hasWarrant: true, claimIds: [] },
    { index: 4, role: 'transition', hasWarrant: false, claimIds: [] },
    { index: 5, role: 'significance', hasWarrant: false, claimIds: [] },
    { index: 6, role: 'conclusion', hasWarrant: false, claimIds: [] }
  ],
  score: 60,
  components: {
    thesis: 20,
    governingClaims: 0,
    warrant: 10,
    counterargument: 0,
    significance: 15,
    conclusion: 10
  },
  complete: true,
  applicable: true,
  rolesFrom: 'model',
  weaknesses: [
    {
      kind: 'warrant-gap',
      paragraphIndex: 2,
      claimId: 'c2',
      message:
        'Paragraph 1 presents evidence without explaining how it supports the argument.',
      tracerPrompt:
        'In Paragraph 1, how do I explain what my evidence actually shows without just restating it?'
    },
    {
      kind: 'evidence-stacking',
      paragraphIndex: 3,
      claimId: null,
      message:
        'Paragraph 2 adds more evidence to Paragraph 1 without a claim between them. Stacked sources read as a literature review rather than an argument.',
      tracerPrompt: 'Paragraph 2 and Paragraph 1 are both evidence. What claim should be joining them?'
    },
    // `no-counterargument` was the whole-draft fixture here. It is gone with
    // the kind — see shared/rubric.ts — and `no-significance` replaces it so
    // the report's SUMMARY block (which renders only paragraphIndex === null
    // findings) still has something to draw.
    {
      kind: 'no-significance',
      paragraphIndex: null,
      claimId: null,
      message:
        'The draft never says why this matters. A reader finishes knowing what is true but not what follows from it.',
      tracerPrompt:
        'My essay proves its point but never says why it matters. How do I write that without overclaiming?'
    }
  ]
}

export const screenWatchClaims: ScreenWatchClaimSummary[] = [
  {
    id: 'c1',
    text: 'Screen time causes depression in teenagers.',
    claimType: 'causal',
    confidence: 0.93,
    hasInlineCitation: false,
    problemKinds: ['unsupported-by-evidence', 'partial-evidence'],
    evidence: {
      score: 34,
      count: 6,
      // Hand-traced against WEIGHTS_WITHOUT_STANCE in search/scoring.ts:
      // .3(.42) + .25(.5) + .3(.31) + .15(.2) = .126 + .125 + .093 + .03 = .374
      // -> 37, close enough to the fixture's 34 to read as the same claim.
      breakdown: { sourceCount: 0.5, quality: 0.31, recency: 0.2, relevance: 0.42, support: 0 },
      articles: [
        {
          title: 'Adolescent screen time and depressive symptoms: a three-year longitudinal cohort',
          venue: 'Computers in Human Behavior',
          year: 2023,
          provider: 'openalex',
          url: 'https://doi.org/10.1016/j.chb.2023.107891',
          faviconDataUrl: null
        },
        {
          title: 'Reassessing the association between digital media use and adolescent well-being',
          venue: 'PNAS',
          year: 2022,
          provider: 'crossref',
          url: 'https://doi.org/10.1073/pnas.2210918120',
          faviconDataUrl: null
        },
        {
          title: 'Displacement or distress? Two accounts of adolescent smartphone use',
          venue: 'Journal of Adolescence',
          year: 2021,
          provider: 'semanticscholar',
          url: 'https://doi.org/10.1016/j.adolescence.2021.04.006',
          faviconDataUrl: null
        }
      ]
    },
    // A verdict and its prose, together. This carried `problemKinds:
    // ['unsupported-by-evidence']` with a NULL critique — a pair main cannot produce
    // (problemKindsFor only reaches 'unsupported-by-evidence' from a critiqueVerdict, and
    // screenWatchService writes the two in one step), so the harness showed the
    // popover's no-critique fallback sentence and the fix card had nothing at
    // all to open onto. Same class of fixture bug as the one c3's comment
    // records. The markdown is deliberate: it is what the relay actually emits,
    // and it is what critiqueIssues splits into the card's rows.
    critique:
      'The cited work is **cross-sectional**, so it cannot separate "screen time causes depression" from "depressed teenagers use their phones more."\n\n- State the *association* rather than the cause.\n- Find a longitudinal source that measures screen time first.',
    critiqueVerdict: 'weak',
    // Null, as the relay leaves it for every verdict but 'overstated' — so this
    // claim is the fix card's no-revision branch, and c4 below is its other one.
    suggestedRevision: null,
    citationFix: null,
    citation: null
  },
  {
    id: 'c2',
    text: '70% of adolescents who use social media for more than three hours a day report symptoms of anxiety.',
    claimType: 'statistic',
    confidence: 0.87,
    hasInlineCitation: false,
    problemKinds: ['unverified-statistic'],
    evidence: {
      score: 61,
      count: 4,
      breakdown: { sourceCount: 0.83, quality: 0.72, recency: 0.55, relevance: 0.38, support: 0 },
      articles: []
    },
    critique: null,
    critiqueVerdict: null,
    suggestedRevision: null,
    citationFix: null,
    citation: null
  },
  // The only fixture with a critique already on it, and the only one that
  // exercises CritiqueFixRow. Both fix fields are populated together because
  // the two blocks stack, and stacked is the layout most likely to overflow the
  // fixed-height panel — the state worth being able to look at.
  //
  // A deliberately mild overstatement: "100%" is the textbook case and would
  // make the feature look easier than it is. The interesting claim is one where
  // the substance is right and a single quantifier is doing the damage.
  {
    id: 'c4',
    text: 'Studies prove that later school start times always improve student outcomes (Wahlstrom 2014).',
    claimType: 'causal',
    confidence: 0.81,
    hasInlineCitation: true,
    problemKinds: ['overstated-claim'],
    evidence: {
      score: 68,
      count: 6,
      breakdown: { sourceCount: 0.9, quality: 0.81, recency: 0.6, relevance: 0.74, support: 0.66 },
      articles: []
    },
    critique:
      '**Overstated, not wrong.** Evidence 2 and 4 report improved attendance and sleep duration, but neither supports "always" — both note effects varying by district and grade level. **Citation format.** The reference is MLA author-page with the year in the page slot; in MLA it takes a page number, not 2014.',
    critiqueVerdict: 'overstated',
    suggestedRevision:
      'Studies indicate that later school start times generally improve student outcomes (Wahlstrom 2014).',
    citationFix: 'Wahlstrom, Kyla. "Later Start Time for Teens Improves Grades, Mood, and Safety." Phi Delta Kappan, 2014, p. 12.',
    citation: null
  },
  {
    id: 'c3',
    text: 'This is the clearest public-health crisis of our generation.',
    claimType: 'opinion',
    confidence: 0.55,
    hasInlineCitation: false,
    // 'searching', not 'missing-citation'. The pair below is what main
    // produces for an unresolved claim — problemKindsFor answers a null
    // `evidence` with exactly ['searching'] — and the two have to agree,
    // because every card downstream reads the KIND and trusts that a
    // non-'searching' one came with evidence attached. Named
    // 'missing-citation' beside a null evidence, this fixture pushed a payload
    // main cannot produce and crashed ProblemCard on `evidence.breakdown`,
    // which is the harness inventing a bug rather than finding one.
    problemKinds: ['searching'],
    // null evidence exercises the "search still running" state, which is
    // otherwise only visible for the second or two after detection.
    evidence: null,
    critique: null,
    critiqueVerdict: null,
    suggestedRevision: null,
    citationFix: null,
    citation: null
  }
]

export const screenWatchStatus: ScreenWatchStatus = {
  enabled: true,
  active: true,
  processName: 'WINWORD.EXE',
  supportsUnderlines: true,
  claimCount: screenWatchClaims.length,
  lastError: null,
  authRequired: false,
  blockedApp: null
}

/**
 * The structural read Screen Watch computes over the watched document.
 *
 * Score traced by hand against scoreDraft's rubric, so a change to the formula
 * shows up here as a disagreement rather than as a fixture quietly following it:
 *
 *   thesis            20/20  role 'thesis' at index 0
 *   governing claims  20/20  body = slice(1,-1) = 4 paragraphs, 2 carry role
 *                            'claim', expected = ceil(4 * 0.5) = 2, so 2/2
 *   warrant           13/20  owed by 'claim'|'evidence' = paragraphs 2, 3, 4;
 *                            2 of 3 have a connective -> 20 * 2/3
 *   counterargument   15/15  paragraph 5
 *   significance       0/15  no significance paragraph, no so-what in the
 *                            conclusion — which is why 'no-significance' is
 *                            in the weakness list below
 *   conclusion        10/10  role 'conclusion' in last position
 *                    ------
 *                    78/100
 *
 * `complete: true` (no 'unknown' role), so the whole-draft weaknesses are
 * allowed to fire. Set a role to 'unknown' to exercise the Provisional badge
 * and watch 'no-significance' correctly disappear.
 */
export const screenWatchStructure: ScreenWatchStructure = {
  score: 78,
  complete: true,
  components: {
    thesis: 20,
    governingClaims: 20,
    warrant: 13.333333333333332,
    counterargument: 15,
    significance: 0,
    conclusion: 10
  },
  // Matches screenWatchClaims: c1 (34) and c2 (61) found sources, c3 searched
  // and found nothing — which is what makes it an 'unsupported-claim' rather
  // than an unchecked one.
  // `outsideIndexes: 1` — c3 is the searched-and-empty claim, and it is the one
  // the academic indexes were never going to hold.
  //
  // The overlay renders ArgumentScoreModal in `compact` mode, which draws no
  // claim-count lines at all (370:135 is a ring, an eyebrow, a grade and one
  // line), so nothing here reads this field today. It is set anyway, and set
  // to the value that is TRUE of these three claims: a fixture that quietly
  // omits a field is a fixture that stops matching the payload, which is the
  // one thing it exists not to do. `searchableClaims(3, 1, 2)` = 2 is the
  // number the non-compact report would print, and it is unit-tested in
  // shared/coverageCounts.test.ts rather than asserted from a render.
  coverage: {
    detected: 3,
    withRelevantSource: 2,
    withOwnCitation: 1,
    meanStrength: 42,
    unchecked: 0,
    outsideIndexes: 1
  },
  // A believable school essay rather than round numbers: 1,240 words over 71
  // sentences is ~17.5 words per sentence and ~5 minutes to read, which is what
  // the stats row should show. Round figures here would hide an arithmetic
  // mistake in the panel by making every cell look plausible.
  stats: { words: 1240, sentences: 71, uniqueWords: 521 },
  weaknesses: [
    {
      kind: 'unsupported-claim',
      paragraphIndex: 6,
      claimId: 'c3',
      message: 'The claim in the conclusion has no supporting source yet.',
      tracerPrompt:
        'Tracely could not find evidence for one of my claims. How should I go about checking it?'
    },
    {
      kind: 'warrant-gap',
      paragraphIndex: 3,
      claimId: null,
      message:
        'Paragraph 2 presents evidence without explaining how it supports the argument.',
      tracerPrompt:
        'In Paragraph 2, how do I explain what my evidence actually shows without just restating it?'
    },
    {
      kind: 'new-claim-in-conclusion',
      paragraphIndex: 6,
      claimId: 'c3',
      message:
        'The conclusion introduces a new claim. Anything asserted here has no room left to be supported.',
      tracerPrompt: 'My conclusion makes a new claim. Where should that argument go instead?'
    },
    {
      // paragraphIndex null — the case the overlay must render as a plain
      // "Draft" chip rather than a jump target.
      kind: 'no-significance',
      paragraphIndex: null,
      claimId: null,
      message:
        'The draft never says why this matters. A reader finishes knowing what is true but not what follows from it.',
      tracerPrompt:
        'My essay proves its point but never says why it matters. How do I write that without overclaiming?'
    }
  ],
  paragraphs: [
    { index: 1, role: 'thesis', hasWarrant: false, claimIds: [] },
    { index: 2, role: 'claim', hasWarrant: true, claimIds: ['c1'] },
    // The one paragraph owed a warrant that has none — the warrant-gap above.
    { index: 3, role: 'evidence', hasWarrant: false, claimIds: [] },
    { index: 4, role: 'claim', hasWarrant: true, claimIds: ['c2'] },
    { index: 5, role: 'counterargument', hasWarrant: true, claimIds: [] },
    { index: 6, role: 'conclusion', hasWarrant: true, claimIds: ['c3'] }
  ],
  previews: [
    'Schools should delay their start times, because the sleep teenagers lose to an early bell…',
    'Screen time causes depression in teenagers. Adolescents who spend longer on their phones…',
    'Twenge and Campbell (2018) found a dose-response relationship. Orben and Przybylski (2019)…',
    '70% of adolescents who use social media for more than three hours a day report symptoms…',
    'Some researchers argue the effect sizes here are trivially small, and that is fair — the…',
    'In conclusion, schools must act. Districts that moved to a later bell saw graduation rates…'
  ]
}

// Underline rects are in overlay-window-local coordinates. The preview
// renders the overlay into a fixed-size frame, so these are chosen to land
// inside it rather than copied from a real screen capture.
/**
 * What "Refresh Evidence" lands: the same three sources plus one the previous
 * search missed, so the panel's "Updated just now" chip and its "New" row have
 * something real to mark. Deliberately a genuine superset — the card decides
 * which rows are new by diffing against the pre-refresh set, and a fixture that
 * simply replaced the list would light every row up.
 */
export const screenWatchEvidenceRefreshed: ScreenWatchClaimSummary['evidence'] = {
  score: 41,
  count: 9,
  breakdown: { sourceCount: 0.75, quality: 0.38, recency: 0.44, relevance: 0.42, support: 0 },
  articles: [
    {
      title: 'Longitudinal evidence on smartphone use and adolescent mood: a 2024 replication',
      venue: 'Nature Human Behaviour',
      year: 2024,
      provider: 'openalex',
      url: 'https://doi.org/10.1038/s41562-024-01822-x',
      faviconDataUrl: null
    },
    ...screenWatchClaims[0].evidence!.articles
  ]
}

/**
 * A critique in the shape the relay actually returns — one paragraph under 120
 * words, not a bulleted list. The panel's critique view has to read this back
 * into the design's issue rows, so the fixture must be the awkward case rather
 * than a tidy list that would make the parser look better than it is.
 */
export const screenWatchCritique =
  'The claim asserts causation from evidence that is largely cross-sectional. Evidence 2 measures screen time and mood at the same moment, so it cannot establish which came first — a withdrawn teenager may reach for a phone rather than the other way round.\n\nIt also generalises from adolescents in high-income countries to "teenagers" without qualification. Narrow the population, or soften "causes" to "is associated with", which evidence 1 does support.'

export const overlayUpdate: ScreenWatchOverlayUpdateEvent = {
  underlines: [
    { id: 'c1', rects: [{ x: 60, y: 90, width: 280, height: 18 }], claimType: 'causal', problemKinds: ['unsupported-by-evidence', 'partial-evidence'] },
    {
      id: 'c2',
      rects: [
        { x: 60, y: 120, width: 420, height: 18 },
        { x: 60, y: 142, width: 180, height: 18 }
      ],
      claimType: 'statistic',
      problemKinds: ['unverified-statistic']
    },
    { id: 'c3', rects: [{ x: 60, y: 174, width: 330, height: 18 }], claimType: 'opinion', problemKinds: ['missing-citation'] }
  ],
  widget: {
    rect: { x: 520, y: 300, width: 56, height: 56 },
    expanded: false,
    viewMode: 'single',
    claimCount: screenWatchClaims.length,
    claims: screenWatchClaims,
    totalInfoCount: screenWatchClaims.length + 10,
    // Hand-traced, not derived: the `underlines` array above carries three
    // entries (c1, c2, c3). Written as a literal so adding a fourth shows up
    // here as a disagreement instead of quietly following along — which is the
    // whole point of the badge counting marks rather than claims or sources.
    underlineCount: 3,
    structure: screenWatchStructure,
    // False alongside a non-null `structure`, because those are the only two
    // states main ever pushes together — see ScreenWatchWidget.analyzing. The
    // rail's Screen Watch scenario flips this (and drops the structure) to
    // reach the Analyzing card, which is otherwise only visible during the
    // second or two before a real draft's first reading lands.
    analyzing: false
  }
}

/**
 * Tracer's opening exchange, so the panel has something in it on first render.
 *
 * Written against `documents[0]` — a conversation that names a draft the
 * harness does not list would be a small lie that reviewers chase.
 */
export const tracerConversation: TracerConversation = {
  id: 'preview-conversation',
  title: 'Renewable Energy Argument',
  createdAt: T0,
  updatedAt: T0
}

export const tracerMessages: TracerMessage[] = [
  {
    id: 'preview-msg-1',
    conversationId: tracerConversation.id,
    role: 'tracer',
    content:
      'Hey! I can see your most recent draft. Ask me about a claim, a paragraph that is not landing, or what the grade is reacting to.',
    createdAt: T0
  }
]

/** The draft text Tracer says it can see, for the context line. */
export const documentText =
  'Fossil fuel companies are the root of all environmental degradation. Renewable energy is cheaper per kilowatt-hour than coal in most markets.'
