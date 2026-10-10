/* Tracely — universal writing checker.

   Three modes, chosen at load:
   • Docs mode (docs.google.com/document/*, /document/u/N/d/ included) —
     reads the doc as the signed-in account via the export endpoint every
     3s while it is changing (10s once idle; see nextReadGap), shows findings in the floating widget, and underlines flagged
     sentences over Docs' canvas (positions from Docs' SVG annotation layer,
     docs-hook.js's paint ledger as the fallback). "Fix in doc" and "Cite in
     doc" edit the document through docs-hook.js's in-page engine whenever
     Docs reports it editable (canEditDoc); "Copy fix" is the fallback.
   • Harness mode (window.__tracelyHarness) — the test page stands in for Docs.
   • Field mode (everywhere else) — Grammarly's actual core mechanism: track
     the focused textarea / contenteditable, check its sentences, and rewrite
     flagged ones IN PLACE. Automatic checking (as for Docs) is opt-in per site
     ("tracely.site.enabled" in the page's localStorage); on a non-enabled
     site nothing is sent anywhere until the user clicks.

   All API traffic goes through the extension's background service worker,
   which relays it to a Tracely server — the local one at localhost:4477 if a
   developer is running it, otherwise api.jointracely.com. Harness and plain
   test pages fetch the server directly.

   Field mode also draws Grammarly-style overlay underlines: flagged
   sentences get a 2px solid underline (3px hovered) in their verdict's
   colour from MARK_COLORS below (the app's red / orange / amber), every one
   solid; a faint solid grey while pending; clicking one
   opens the panel and flashes that verdict's card. */
/* FILE MAP — one file, no build step, two developers editing it at once.
   Sections, by the line their anchor sits on (regenerate the numbers with
   `grep -n` when you move things; the anchors themselves must not move):
        56  Verdicts, card copy, colours, FEATURES switches
       378  Settings and plan gate
       630  Shared helpers: hashing, bibliography, citation formatting
       987  Sentence boundaries (ported from server/shared/sentenceSplit.js)
      1311  Genre detection, evidence suggestions, local checks
      2311  Widget chrome, API transport, design tokens
      2769  Docs mode (Google Docs: export reads, marks, cards, in-doc edits)
      6589  Field mode (textareas and contenteditables on any site)
   Rules that keep two agents out of each other's way:
   • The lines marked "TEST ANCHOR" below, and every marker in
     server/test/helpers/anchors.js, are fixtures: server/test slices this
     file by them. Never rename or re-indent one; ext-anchors.test.js fails
     with its name if you do.
   • Add code INSIDE the section it belongs to, never at the top of the file,
     so two PRs touching different features rebase cleanly.
   • Bump manifest.json ONCE per PR, in the last commit, with
     server/scripts/bump-extension.mjs; say which section you touched in the
     PR's Handoff. */
"use strict";

(() => {
  const SERVER = "http://localhost:4477";
  const CHECK_INTERVAL_MS = 10_000;
  const MAX_SENTENCES_PER_CHECK = 40;
  const MAX_INPUT_CHARS = 30_000; // GUARDS.maxInputChars — clamp before anything reaches a model
  const MIN_FIELD_CHARS = 80;     // GUARDS.detect.minChars — fields shorter than this are ignored

  const harness = window.__tracelyHarness ?? null; // test harness page stands in for Docs
  const IS_DOCS = !harness && location.hostname === "docs.google.com" && location.pathname.startsWith("/document/");
  if (document.getElementById("tracely-host")) return;

  // TEST ANCHOR (server/test/ext-*) — do not rename or re-indent the next line.
  const ISSUE_VERDICTS = ["false", "questionable", "incoherent", "needs_citation"];
  /* What each kind of writing is checked for (detectGenre says which kind it
     is). Quiet: homework, a poem, a story, a script — nothing in them is a
     claim to check or a source to cite. The writer's own account: a resume,
     a letter, an email, a cover letter, a personal essay, notes, an annotated
     bibliography — a wrong public fact still shows, but nothing asks for a
     source or calls the writer's own life "worth checking". A DBQ cites its
     documents by number and its outside evidence needs no source (owner,
     2026-10-09: "if it is world history DBQ, no need for citations and
     worked cited"). */
  const GENRE_QUIET = new Set(["homework", "poem", "story", "script"]);
  const GENRE_OWN = new Set(["resume", "letter", "email", "coverletter", "personal", "notes", "annotated"]);
  const GENRE_NO_SOURCE = new Set(["dbq"]);
  /* Whether a finding is shown — underlined, carded, counted. "Citation
     suggestions" (needs_citation: accurate, but a reader would want a source)
     can be switched off in the widget; a tester's history essay had every
     sentence underlined amber and the pill read like an error count. Off hides
     only that verdict; a false or incoherent sentence always shows. */
  const flagShown = (f, settings, genre, text, covered = false) => Boolean(f) && !GENRE_QUIET.has(genre) && ISSUE_VERDICTS.includes(f.verdict)
    // A hidden switch must not keep acting on a value an earlier build saved.
    && (f.verdict !== "needs_citation" || !FEATURES.citeHintsToggle || settings?.citeHints !== false)
    // The author's own account needs no source: a resume's figures and awards
    // ("$10K+ in revenue"), a letter's ("2,000 students use my app"), and in
    // ANY document a sentence about what the author did ("we sold 500 boxes",
    // "We surveyed 1,200 students" — their own study). The server stops asking
    // (its genre clause); this holds the line against a server from before it.
    && !(f.verdict === "needs_citation" && (GENRE_OWN.has(genre) || GENRE_NO_SOURCE.has(genre) || authorsOwnAccount(text)))
    // A sentence that visibly carries a citation never reads "Missing
    // citation", whatever the model said: the check's own rule is that a
    // cited sentence is never needs_citation, and it broke it on "… modern
    // education (Cambridge International, 2018)." (owner, 2026-10-04).
    && !(f.verdict === "needs_citation" && hasCitationMark(text))
    // Only what a marker would ask a source for (citationWorthy) — and not
    // when a citation later in the same paragraph already carries it
    // (`covered`, coveredByLaterCitation): a generalization followed by its
    // cited evidence is how essays are written.
    && !(f.verdict === "needs_citation" && typeof text === "string" && (!citationWorthy(text) || covered))
    // "Worth checking" is for something specific that cannot be verified.
    && !(f.verdict === "questionable" && typeof text === "string" && isGeneralStatement(text))
    // On a resume or letter, "questionable" is the same mistake in a softer
    // word — an unverifiable claim about the author (seen on a contact line).
    // The server's genre clause: "never questionable". "false" still shows.
    && !(f.verdict === "questionable" && GENRE_OWN.has(genre))
    // A sentence excusing a missing citation detail ("The study does not need
    // a publication date because Harvard is a famous institution") is the
    // writer's note, not a claim: owner, 2026-10-08, "tracely is trying to
    // cite this instead of remove it". Its own note (kind "excuse") offers
    // Delete; a verdict here would offer to find it a source.
    && !(typeof text === "string" && EXCUSE_SENTENCE.test(text));
  // PRESTIGE_EXCUSE's pattern (citationHygieneTips), here because flagShown is
  // read without that section; ext-card-fixes.test.js keeps the two the same.
  const EXCUSE_SENTENCE = /\b(?:does not|doesn't|do not|don't|did not|didn't) need (?:a |an |the |any )?(?:publication |publishing )?(?:date|author|citation|page(?: number)?|year|source)\b/i;
  /* First person, but not the generic "we" of an argument ("we know", "we
     all", "we should"): that "we" is the reader and the world, and a figure
     in it still needs its source. "I" as a Roman numeral is not the author:
     World War I, Part I, Chapter I, and a ruler's name after King/Queen/Pope
     ("King Charles I"). A bare ruler ("Elizabeth I reigned…") still reads as
     first person — the cost is one missed citation request, not a wrong flag. */
  const ROMAN_I = /\b(?:War|Part|Chapter|Book|Act|Phase|Title|Section|Volume|Vol\.|Stage|Level|Grade|Class|Type|Article|Round|Season|(?:King|Queen|Pope|Emperor|Empress|Tsar|Czar|Prince|Princess)\s+[A-Z][a-z]+)\s+I\b/g;
  const OWN_ACCOUNT = /(?:^|[^\w'])I(?:'m|'ve|'d|'ll)?(?=$|[^\w'])|\b[Mm](?:y|e|ine)\b|\b(?:[Ww]e|[Oo]ur|[Uu]s)\b(?!\s+(?:all|can|cannot|could|know|see|must|should|need|often|tend|might|may|now)\b)/;
  /* A citation in the sentence itself: a parenthetical with a year, "n.d."
     or a quoted title — (Cambridge International, 2018), (Smith, n.d.),
     ("Youth Matters", 2025) — an MLA author-page (Shoup 45), a [3], or a
     footnote mark after the full stop. Prose like "according to experts" is
     not one: it names no source a reader could find. */
  const CITATION_MARK = /\([^()]*(?:\b(?:1[5-9]|20)\d\d[a-z]?\b|\bn\.\s?d\.|["“][^"”]{3,}["”])[^()]*\)|\([\p{Lu}][\p{L}'’-]+(?:\s+(?:and|&)\s+[\p{Lu}][\p{L}'’-]+|\s+et al\.)?\s+\d{1,4}(?:[-–]\d{1,4})?\)|\[\d+(?:[,–-]\s?\d+)*\]|[.!?]["”’]?[¹²³⁴⁵⁶⁷⁸⁹⁰]+|\(Doc(?:ument)?\.?\s*\d{1,2}\)|\bDoc(?:ument)?\.?\s*\d{1,2}\s+(?:explains|says|shows|states|describes|argues|reveals|suggests|notes|reports|depicts|illustrates)\b/u;
  const hasCitationMark = (text) => typeof text === "string" && CITATION_MARK.test(text);
  /* Does this sentence owe a source of its OWN? Owner, 2026-10-04: "sometimes
     it flags stuff just to flag stuff … basic abstractions and
     generalizations followed by a piece of evidence do not necessarily need a
     citation." Only a number, a direct quotation or a research finding does;
     a topic sentence, an abstraction or the writer's own argument is the
     essay talking. A copy of src/shared/citationWorthy.ts —
     server/test/citation-worthy-mirror.test.js keeps the two in step. */
  const WORTHY_QUANTITY = /\d|\b(?:percent|per cent|half|a third|a quarter|twice|double|triple|dozens?|hundreds?|thousands?|millions?|billions?|trillions?|majority|minority)\b/i;
  const WORTHY_QUOTATION = /["“][^"”]*\S+\s+\S+\s+\S+[^"”]*["”]/;
  const WORTHY_FINDING = /\b(?:stud(?:y|ies)|research(?:ers)?|survey(?:s|ed)?|experiments?|data|scientists|report(?:s|ed)?|according to)\b/i;
  const citationWorthy = (text) => WORTHY_QUANTITY.test(String(text ?? "")) || WORTHY_QUOTATION.test(String(text ?? "")) || WORTHY_FINDING.test(String(text ?? ""));
  // Names nothing specific either: "Worth checking" has nothing to check there.
  const isGeneralStatement = (text) => {
    const t = String(text ?? "").trim();
    if (citationWorthy(t)) return false;
    return !t.replace(/^["“(]+/, "").split(/\s+/).slice(1).some((w) => /^["“(]?[A-Z][a-z]/.test(w));
  };
  const authorsOwnAccount = (text) => typeof text === "string" && OWN_ACCOUNT.test(text.replace(ROMAN_I, " "));
  // TEST ANCHOR (server/test/ext-*) — do not rename or re-indent the next line.
  /* Card titles, in the app's voice: it names the problem in a short sentence
     (problemCopy.ts — "Missing citation", "Contradicted — check this fact")
     rather than tagging the sentence with a verdict. Same four verdicts. */
  const VERDICT_LABEL = { false: "Contradicted — check this fact", questionable: "Worth checking", incoherent: "Doesn't make sense", needs_citation: "Missing citation" };
  const AUTO_SOURCE_VERDICTS = ["false", "questionable", "needs_citation"];
  // The mark vocabulary is the desktop app's (PROBLEM_COLOR in
  // src/renderer/src/components/problemCopy.ts, COLORS in server/shared/marks.js;
  // CLAUDE.md "UI decisions"), read off the Figma "Inline Detection" frames:
  //   red #d93636    — wrong or makes no sense (false, incoherent)
  //   orange #ff5900 — thin evidence, an unverified figure (questionable)
  //   amber #ffb800  — add the attribution (needs_citation)
  // Four verdicts on three colours, so the card TITLE is what tells false
  // from incoherent; colour alone never has to. It used to be a fourth hue
  // per verdict (amber, violet, blue), which made the same finding a
  // different colour here than in the app.
  const MARK_COLORS = { false: "#d93636", questionable: "#ff5900", incoherent: "#d93636", needs_citation: "#ffb800", cite_tip: "#ffb800", note_tip: "#ff5900" };
  const VERDICT_WASH = { false: "#fdecec", questionable: "#ffeee5", incoherent: "#fdecec", needs_citation: "#fff4d6" };
  const VERDICT_TEXT = { false: "#d93636", questionable: "#c24400", incoherent: "#d93636", needs_citation: "#a67500" };
  const MARK_PENDING = "#9a9ba1"; // a faint solid grey line while a sentence's check is in flight

  /* The bare-bones build: fact-checking (underline, card, suggested fix) and
     citations (find a source, cite it), in Docs and in any text field.
     Everything else is switched off here rather than deleted, so bringing a
     feature back is one word. Owner, 2026-10-02: "only the basic bare bones
     features which is citations fact checking … dont add anything else."
     The switches are read OUTSIDE the regions server/test slices out of this
     file and runs in isolation, so those tests keep running the real code. */
  const FEATURES = {
    flow: false,          // "Flow issue" passage flags (/api/flow) and their margin bracket
    deepDive: true,       // "Explain in depth" (Pro) in the fix card and the widget cards — back on in 2.21.24 (off only for the 2026-10-02 bare-bones build)
    citeHintsToggle: false, // the "Citation suggestions" switch; off = missing-citation marks always shown
    autoSources: false,   // the "Auto-src" switch; off = sources are looked up only when asked
    evidenceHints: true,  // "Evidence you could add": suggested, searched only on a click (evidenceCandidates)
    resumeTips: true,     // on a resume: free format rules, plus /api/review's bullet and typo notes (detectGenre)
    quoteTips: true,      // on an essay or paper: a direct quote cited without its page (quoteCitationTips)
    offTopic: true,       // on an essay or paper: a line that shares no word with the rest of it (offTopicSentences)
    writingOnly: true,    // homework questions (detectGenre "homework"): nothing sent, nothing drawn
    essayFeedback: true,  // on an essay or paper: /api/review reads it against its rubric (a DBQ's, for one) — essayFeedbackTips
    citeMarks: true,      // underline the citation a note is about — the "(Fitzgerald)", the reference entry (citationMarks)
    refList: true,        // on an essay or paper: a reference listed twice, or one nothing in the text cites (referenceListIssues)
    typePreview: true,    // Docs: every in-doc edit is typed as a private preview first, sent only on Accept (the "Type preview" block, previewDocEdit)
  };

  /* How a flagged sentence is drawn and how it moves, carried across from the
     desktop app's src/shared/markMotion.ts rather than re-picked here — the
     same problem on the same sentence should not look like two products. The
     band is translucent because it sits over the words it is drawing attention
     to; 0.30 was measured on the app's overlay (0.16 vanished against white,
     past ~0.35 it fights the text). The line is 2px resting and 3px hovered,
     with a 1px radius — a 2px radius on a 2px bar rounds it into a capsule and
     washes the colour out. */
  const MARK_BAND_ALPHA = 0.3;
  const MARK_BAND_SCALE_RESTING = 0.72; // anchored at the bottom: a stroke swelling off the line
  const MARK_BAND_INSET_TOP = 2;
  const MARK_BAND_INSET_BOTTOM = 3;
  const MARK_BAND_RADIUS = 3;
  const MARK_LINE_HEIGHT = 2;
  const MARK_LINE_HEIGHT_HOVERED = 3;

  /* Never colour alone (CLAUDE.md "UI decisions"). Amber #ffb800 is 1.73:1 on
     white, under WCAG's 3:1 for graphics, and red and orange are close under
     tritanopia, so the colour cannot be the only thing that says which
     finding a sentence carries. Until 2.21.34 the LINE said it too — solid,
     dashed, double. Owner, 2026-10-09: "I don't like the dotted underline,
     find a different way to differentiate underlines but make them all solid
     and straight line." So every line is one solid line, and the kind is
     said by an ICON in the page's left margin beside the line (MARK_ICON,
     drawMarginIcons) — the same icons as the panel header's counts — and by
     the legend, which shows each line with its icon (legendHtml). */
  // TEST ANCHOR (server/test/ext-*) — do not rename or re-indent the next line.
  const MARK_PATTERN = { false: "solid", incoherent: "solid", questionable: "solid", needs_citation: "solid", cite_tip: "solid", note_tip: "solid" };
  // Which header kind (TALLY_ICON) each mark's icon is: wrong, worth checking, a citation, the writing.
  const MARK_ICON = { false: "wrong", incoherent: "wrong", questionable: "check", needs_citation: "cite", cite_tip: "cite", note_tip: "writing" };
  const MARK_ICON_RANK = { wrong: 4, check: 3, cite: 2, writing: 1 }; // one icon a line: the most serious
  // note_tip: a writing-feedback note on one sentence (essayFeedbackTips) —
  // "needs specific evidence", "explain this evidence". Orange: the
  // thin-evidence family ("Worth checking"), never red, which means wrong.
  // cite_tip is not a verdict: it is a note about the CITATION itself (a quote
  // with no page, a reference listed twice or never cited — citationMarks),
  // drawn under the parenthetical or the entry rather than the sentence, so a
  // sentence can carry a red fact mark and an amber citation mark at once.
  // Same family as needs_citation ("add or fix the attribution"), same colour.
  // CSS for a div-drawn line (field mode, and Docs' fallback bars): solid.
  const markFill = (color) => color;
  /* The panel's legend: each kind's icon (as in the page margin and the
     header) beside its solid line, in the cards' own words. */
  const LEGEND = [["false", "Contradicted or doesn't make sense"], ["questionable", "Worth checking"], ["needs_citation", "Missing or incomplete citation"], ["note_tip", "Writing note"]];
  function legendHtml() {
    const items = LEGEND.map(([v, label]) => `<span class="legend-item"><span class="legend-ico" aria-hidden="true" style="color:${MARK_COLORS[v]}">${TALLY_ICON[MARK_ICON[v]]}</span><span class="legend-line" aria-hidden="true" style="background: ${MARK_COLORS[v]}; height: ${MARK_LINE_HEIGHT}px"></span>${label}</span>`).join("");
    return `<div class="legend" role="note" aria-label="What the underlines and margin icons mean">${items}</div>`;
  }
  const markLineHeight = (pattern, hovered) => (hovered ? MARK_LINE_HEIGHT_HOVERED : MARK_LINE_HEIGHT);
  // The bars drawn INSIDE Docs' SVG layer: solid, like every line.
  const svgMarkFill = (color) => color;
  const MARK_LINE_RADIUS = 1;
  const MARK_BAND_TRANSITION = "opacity 110ms ease, transform 110ms cubic-bezier(0.22, 1, 0.36, 1), background 110ms ease";
  const MARK_LINE_TRANSITION = "height 110ms ease";
  const markReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  /* `#rrggbb` at the given alpha, for the band. */
  function withAlpha(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  // Read from the manifest so it can never disagree with the shipped version.
  const EXT_VERSION = (() => {
    try { return chrome.runtime.getManifest().version; } catch { return "dev"; }
  })();

  /* An ORPHANED content script — the extension was reloaded or updated while
     this page kept running — keeps executing, but every chrome.* call then
     throws "Extension context invalidated" SYNCHRONOUSLY. That is why a
     .catch() on a promise never caught it, and why the console filled with
     repeats rather than one error: every timer tick and every storage event
     tried again.

     chrome.runtime.id is the liveness test — it becomes undefined the instant
     the context dies. Latch it, because an orphaned script never recovers
     until the tab reloads, and stop calling out at all once it has.

     These wrappers take the SAME arguments as the calls they replace, so the
     call sites keep their shape.

     They must call the REAL chrome.* API inside extCall. The storage three
     once called themselves (`storageGet` -> `storageGet` -> ...): the first
     call overflowed the stack, extCall caught the RangeError as if the context
     had died, and latched extDead on a perfectly live page. In field mode
     that meant the per-site list never synced, sendMsg answered null forever,
     and the plan never refreshed after its first answer. */
  let extDead = false;
  function extAlive() {
    if (extDead) return false;
    try {
      if (chrome?.runtime?.id) return true;
    } catch { /* even reading it can throw */ }
    extDead = true;
    return false;
  }
  function extCall(fn, fallback) {
    if (!extAlive()) return fallback;
    try { return fn(); } catch { extDead = true; return fallback; }
  }
  const storageGet = (defaults, cb) => extCall(() => chrome.storage.local.get(defaults, cb));
  const storageSet = (obj) => extCall(() => chrome.storage.local.set(obj)?.catch?.(() => { /* context died mid-write */ }));
  const storageOnChanged = (cb) => extCall(() => chrome.storage.onChanged.addListener(cb));
  const sendMsg = (msg) => extCall(() => chrome.runtime.sendMessage(msg), Promise.resolve(null));

  /* Flow flags — passage-level coaching, drawn as a margin bracket rather
     than an underline (Figma "Overlay Mockup — Inline Flow Flag"). Colors
     sampled from that file: bracket/badge, then the chip + link accent. */
  const FLOW_COLOR = "#7344f1";
  const FLOW_ACCENT = "#7b44d4";

  /* The model. Since 2.20.0 there is no Faster↔Smarter slider: the SERVER
     picks the model and effort for every route (shared/plan.js
     modelForRoute) — the fast model at medium for every check, on every
     plan, because it was the most accurate fact-checker in the blind eval
     (eval/models/FINDINGS.md). Requests still name it, and send no effort.
     Pinned to lib/llm.js MODEL_TIERS.fast by test/models.test.js.

     Settings an earlier build saved in tracely.widget.settings — `model`
     and `effort`, a slider stop, possibly a retired id like gpt-5-nano —
     are ignored, and dropped the next time the widget saves (persistSettings).
     The options page's old default stop (chrome.storage `model`) is no
     longer read at all. */
  const CHECK_MODEL = "gpt-5.6-luna";
  const RETIRED_SETTINGS = ["model", "effort"];

  /* ── plan gate ───────────────────────────────────────────────────────────
     Whether this account is offered "Explain in depth" (Pro's Thorough
     allowance; a beta tester is served as Pro). The plan comes from the
     signed-in Supabase account, resolved by the SERVER (GET /api/entitlement)
     and relayed here by the background worker.

     THIS GATE IS COSMETIC. It exists so the button tells the truth about what
     the account will get. It prevents nothing: the server answers a deep
     check from any other plan with 403 plan_required, whatever this file says.

     One exception opens it, and it is not a loophole — the server has
     already decided there is no plan to apply: `unenforced`, meaning it
     reported `enforced: false` because it has no Supabase project configured
     and gates NOTHING. Locking the button there would show an upgrade prompt
     for a server that will answer — a lie in the one mode a plain
     `node server.js` runs in.

     There was a second, `byoKey`, for the bring-your-own-key standalone
     engine. That engine is gone; see the note in background.js. */
  /* The widget's upgrade link is the bare order page, never one carrying a
     uid. The widget draws into an OPEN shadow root on the host page, so a uid
     in that link would hand every site's scripts a stable, cross-site account
     id (it doubles as the Stripe client_reference_id). The worker does not
     send this script the id at all. A click asks the worker instead
     (tracely-open-order), which opens the order page WITH the id in a new tab,
     so the checkout still maps to the account; the plain page is the fallback
     when the worker cannot answer. */
  const ORDER_URL = "https://jointracely.com/order";
  function openOrderPage() {
    Promise.resolve(sendMsg({ type: "tracely-open-order" })).catch(() => null).then((r) => {
      if (!r?.ok) window.open(ORDER_URL, "_blank", "noopener,noreferrer");
    });
  }

  // `provisional`: the worker had no real answer (server unreachable or
  // erroring on the test build) — shown, never acted on as a downgrade.
  let tier = { plan: "free", byoKey: false, unenforced: false, beta: false, provisional: false };
  const tierListeners = []; // widget re-renders to run when the tier resolves
  function tierChanged() {
    forgetDeepLocks();
    for (const fn of tierListeners) { try { fn(); } catch { /* widget torn down */ } }
  }
  let tierResolved = false;

  /* A widget's settings (citation style, auto-sources) in the page's
     localStorage. Whatever an earlier build left there must not break a
     widget: anything but a plain object reads as no settings, and the
     retired slider keys are dropped on the next write. */
  function loadSettings(key) {
    const saved = jsonParse(lsGet(key) ?? "null", null);
    const obj = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    // MLA by default (owner, 2026-10-03: research papers and school essays
    // alike). A style the writer picked is saved and wins.
    const settings = { citationStyle: "mla", citeHints: true, ...obj };
    // Picked by the writer, it wins; otherwise each document's own style does
    // (docCitationStyle). A style other than the default was a pick.
    settings.styleChosen = obj.styleChosen ?? Boolean(obj.citationStyle && obj.citationStyle !== "mla");
    for (const k of RETIRED_SETTINGS) delete settings[k];
    return settings;
  }
  // Every write of a widget's settings goes through here.
  function persistSettings(settings, key) {
    const out = { ...settings };
    for (const k of RETIRED_SETTINGS) delete out[k];
    return lsSet(key, JSON.stringify(out));
  }
  let tierTimer = 0;
  function refreshTier() {
    if (!useRelay) return; // harness page: no background worker — stays free
    let pending;
    try {
      if (!extAlive()) throw new Error("orphaned");
      pending = chrome.runtime.sendMessage({ type: "tracely-entitlement" });
    } catch {
      /* The extension was reloaded or updated while this page kept running.
         chrome.runtime.sendMessage THROWS SYNCHRONOUSLY in that state rather
         than returning a rejected promise, so the .catch() below never sees
         it and the error escapes uncaught — once here, and then again on
         every interval tick forever. This content script is orphaned until
         the tab reloads, so stop asking. */
      if (tierTimer) { clearInterval(tierTimer); tierTimer = 0; }
      return;
    }
    pending.then((r) => {
      if (!r?.ok) return;
      const next = { plan: r.plan ?? "free", byoKey: Boolean(r.byoKey), unenforced: Boolean(r.unenforced), beta: r.beta === true, provisional: r.provisional === true };
      if (tierResolved && next.plan === tier.plan && next.byoKey === tier.byoKey && next.beta === tier.beta
          && next.unenforced === tier.unenforced && next.provisional === tier.provisional) return;
      tier = next;
      tierResolved = true;
      tierChanged(); // first resolve fires too: the widgets repaint the Explain in depth button
    }).catch(() => { /* worker asleep or extension reloaded — stays free */ });
  }
  // Called once `useRelay` is known (below) — refreshTier depends on it.
  function initTier() {
    try {
      refreshTier();
      // The background worker writes the entitlement cache
      // lives in the same area, so watching storage is how a sign-in on the
      // options page reaches an already-open tab without a reload.
      chrome.storage?.onChanged?.addListener((changes, area) => {
        try {
          if (area === "local" && changes.entitlement) refreshTier();
        } catch { /* orphaned content script — refreshTier already stood down */ }
      });
      tierTimer = setInterval(refreshTier, 5 * 60_000); // matches the worker's entitlement TTL
    } catch { /* harness page: no chrome.* — stays free tier */ }
  }

  /* ── "Explain in depth" (2.20.0) ─────────────────────────────────────────
     Pro's Thorough allowance, one flagged sentence at a time: /api/check with
     deep:true and exactly that sentence runs our largest model while this
     month's allowance lasts, and the standard model after it — the answer's
     `thorough.used` says which. Free and Student see the button locked; the
     server answers them 403 plan_required regardless of what this file shows.

     One answer per sentence per page session: results are cached by the
     sentence's hash, so re-hovering a card or re-rendering the panel never
     spends the allowance twice. A failure is not kept, so a retry can run. */
  const DEEP_PLANS = ["pro"]; // plans with a Thorough allowance (shared/plan.js THOROUGH_MONTHLY_USD)
  const THOROUGH_MODEL = "gpt-6-astra"; // lib/llm.js MODEL_TIERS.thorough
  const DEEP_COPY = {
    button: "Explain in depth",
    locked: "Thorough explanations come with Pro",
    seePlans: "See plans →",
    loading: "Writing a fuller explanation…",
    label: "In depth",
    differs: "Our largest model reads this differently:",
    fallback: "This month's Thorough allowance is used up — this explanation is from the standard model.",
    // The allowance is not spent, so saying it is would contradict the meter.
    paused: "Thorough explanations are paused while this account is over its fair-use limit — this explanation is from the standard model.",
    short: "Not enough of this month's Thorough allowance was left for this one — this explanation is from the standard model.",
    failed: "Couldn't get a deeper explanation — try again.",
  };
  const DEEP_VERDICT_LABEL = { ...VERDICT_LABEL, accurate: "Looks accurate", no_claim: "No claim to check" };
  // sentence hash → { state: "loading" | "done" | "locked" | "error", ... }
  const deepCache = new Map();

  function canDeep() {
    return tier.unenforced || tier.beta || DEEP_PLANS.includes(tier.plan);
  }
  // A lock shown after a click or a 403 belongs to the plan it was shown on.
  function forgetDeepLocks() {
    for (const [h, e] of deepCache) if (e.state === "locked") deepCache.delete(h);
  }

  /* What a card shows for one sentence, as data both renderers draw from:
     the widget's HTML cards (deepHtml) and the Docs hover card (DOM). */
  function deepView(hash, verdict) {
    const e = deepCache.get(hash);
    if (e?.state === "loading") return { kind: "loading", text: DEEP_COPY.loading };
    if (e?.state === "done") {
      const differs = e.verdict !== verdict;
      const note = e.fallback ?? "";
      /* A verdict that contradicts the card's own badge is only shown when
         the card can also say WHERE it came from: the largest model's
         reading (prefix), or the standard model's after a fallback (note).
         A server that reports neither — a local `node server.js`, or one
         older than the plan policy — used to leave Tracely flatly
         disagreeing with itself, with nothing to tell the two readings
         apart. There the fuller explanation stands on its own. */
      const introduced = differs && Boolean(e.fromLargest || note);
      return {
        kind: "result",
        label: DEEP_COPY.label,
        prefix: differs && e.fromLargest ? DEEP_COPY.differs : "",
        verdict: introduced ? e.verdict : "",
        verdictLabel: introduced ? DEEP_VERDICT_LABEL[e.verdict] ?? String(e.verdict) : "",
        text: e.explanation,
        note,
        // The fuller answer's own fact and fix (explainInDepth guards the fix).
        basis: e.basis && e.basis !== e.explanation ? e.basis : "",
        revision: e.revision ?? "",
      };
    }
    if (e?.state === "locked" || !canDeep()) {
      return { kind: "locked", label: DEEP_COPY.button, title: DEEP_COPY.locked, note: e?.state === "locked" ? DEEP_COPY.locked : "" };
    }
    return { kind: "button", label: DEEP_COPY.button, error: e?.state === "error" ? DEEP_COPY.failed : "" };
  }

  /* Why a deep answer came back on the standard model, or "" when it did not.
     Three different things make the server fall back, and only one of them is
     "you've spent the allowance": it is also OFF for a month while a paid
     account is over its fair-use limit (`suspended`, with most of the
     allowance still showing on the meter), and it declines a call whose worst
     case no longer fits in what is left. Reading `used === false` alone told
     all three the allowance was used up — flatly contradicting the meter and
     the fair-use promise that the plan is unchanged. A server too old to send
     `remainingPct` says nothing rather than guessing. */
  function fallbackNote(t) {
    if (!t || t.used !== false) return "";
    if (t.suspended === true) return DEEP_COPY.paused;
    if (typeof t.remainingPct !== "number") return "";
    return t.remainingPct <= 0 ? DEEP_COPY.fallback : DEEP_COPY.short;
  }

  // A click on the locked button: say why, and never call the server.
  function lockDeep(hash) { deepCache.set(hash, { state: "locked" }); }
  // The fuller answer's revision for a sentence, once it has one ("" otherwise).
  function deepRevision(hash) {
    const e = deepCache.get(hash);
    return e?.state === "done" ? e.revision || "" : "";
  }

  /* One deep check. `context` is the document or field text (the same
     context a normal check sends); `verdict` is the card's current verdict.
     `onChange` repaints whatever shows this sentence — it runs when the
     loading state starts and again when the answer (or failure) lands. */
  async function explainInDepth(hash, sentence, context, verdict, onChange) {
    const cur = deepCache.get(hash);
    if (cur && cur.state !== "error" && cur.state !== "locked") { onChange(); return; } // cached or in flight
    if (!canDeep()) { lockDeep(hash); onChange(); return; }
    deepCache.set(hash, { state: "loading" });
    onChange();
    let next;
    try {
      const data = await api("/api/check", {
        text: String(context ?? "").slice(0, MAX_INPUT_CHARS),
        sentences: [{ id: hash, text: sentence }],
        deep: true,
      });
      const f = (data?.findings ?? []).find((x) => x?.id === hash) ?? data?.findings?.[0];
      if (!f || typeof f.explanation !== "string" || !f.explanation) throw new Error("no explanation");
      // `thorough` is the hosted server's; a local one reports modelUsed only.
      const fromLargest = data.thorough
        ? data.thorough.used === true
        : String(data.modelUsed ?? THOROUGH_MODEL).startsWith(THOROUGH_MODEL);
      /* Its revision and its basis used to be dropped here, so a fuller
         answer could only be read — never acted on. The revision passes the
         same guard as a card's own (usableRevision: a bare negation is no
         fix), and one that only repeats the sentence is none either. */
      const raw = typeof f.revision === "string" ? f.revision.trim() : "";
      const revision = raw && raw !== String(sentence).trim() ? usableRevision(sentence, raw) : "";
      next = {
        state: "done",
        verdict: typeof f.verdict === "string" ? f.verdict : verdict,
        explanation: f.explanation,
        fromLargest,
        fallback: fallbackNote(data.thorough),
        basis: typeof f.basis === "string" ? f.basis.trim() : "",
        revision,
      };
    } catch (err) {
      next = err?.kind === "plan_required" ? { state: "locked" } : { state: "error" };
    }
    deepCache.set(hash, next);
    onChange();
  }

  // A verdict's dot-colour class suffix (the widget CSS's .d-*).
  function verdictKind(v) {
    return v === "false" ? "false" : v === "questionable" ? "quest" : v === "needs_citation" ? "cite" : v === "incoherent" ? "inco" : "ok";
  }

  /* The widget cards' block (docs panel and field mode), from deepView.
     `fixHtml(hash)`: the mode's button that puts the fuller answer's
     revision into the text (Fix in doc / Fix in field), "" where it cannot;
     Copy revision is always beside it. */
  function deepHtml(hash, verdict, fixHtml = null) {
    const v = deepView(hash, verdict);
    const h = esc(hash);
    if (v.kind === "loading") {
      return `<div class="deep deep-loading" data-deep-box="${h}"><span class="deep-spin"></span>${esc(v.text)}</div>`;
    }
    if (v.kind === "result") {
      const fix = v.revision && typeof fixHtml === "function" ? fixHtml(hash) : "";
      return `<div class="deep" data-deep-box="${h}">
        <div class="deep-label">${esc(v.label)}</div>
        ${v.prefix ? `<div class="deep-prefix">${esc(v.prefix)}</div>` : ""}
        ${v.verdictLabel ? `<span class="badge">${esc(v.verdictLabel)}</span>` : ""}
        <div class="deep-text">${esc(v.text)}</div>
        ${v.basis ? `<div class="deep-label deep-sub">What it rests on</div><div class="deep-text">${esc(v.basis)}</div>` : ""}
        ${v.revision ? `<div class="deep-label deep-sub">Suggested revision</div><div class="deep-text">${esc(v.revision)}</div>
        <div class="row">${fix}<button class="act${fix ? "" : " primary"}" data-deep-copy="${h}">Copy revision</button></div>` : ""}
        ${v.note ? `<div class="deep-note">${esc(v.note)}</div>` : ""}
      </div>`;
    }
    if (v.kind === "locked") {
      return `<div class="deep-row" data-deep-box="${h}">
        <button class="deep-btn locked" data-deep-locked="${h}" title="${esc(v.title)}" aria-disabled="true">${esc(v.label)}<span class="deep-pro">PRO</span></button>
        ${v.note ? `<div class="deep-note">${esc(v.note)}. <a href="${ORDER_URL}" target="_blank" rel="noopener noreferrer" data-deep-plans="1">${esc(DEEP_COPY.seePlans)}</a></div>` : ""}
      </div>`;
    }
    return `<div class="deep-row" data-deep-box="${h}">
      <button class="deep-btn" data-deep="${h}">${esc(v.label)}</button>
      ${v.error ? `<div class="deep-note err">${esc(v.error)}</div>` : ""}
    </div>`;
  }
  function wireDeep(scope, run, repaint) {
    for (const b of scope.querySelectorAll("[data-deep]")) b.addEventListener("click", () => run(b.dataset.deep));
    for (const b of scope.querySelectorAll("[data-deep-locked]")) b.addEventListener("click", () => { lockDeep(b.dataset.deepLocked); repaint(); });
    for (const a of scope.querySelectorAll("[data-deep-plans]")) a.addEventListener("click", (e) => { e.preventDefault(); openOrderPage(); });
    for (const b of scope.querySelectorAll("[data-deep-copy]")) {
      b.addEventListener("click", () => {
        const r = deepRevision(b.dataset.deepCopy);
        if (!r) return;
        try { navigator.clipboard?.writeText(r)?.catch?.(() => {}); } catch { /* denied */ }
        b.textContent = "Copied ✓";
      });
    }
  }

  /* ── shared helpers (the web app's copy: server/public/app/settings.js) ─────────────────────────────── */

  function hashText(s) {
    const norm = s.toLowerCase().replace(/\s+/g, " ").trim();
    let h = 5381;
    for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) >>> 0;
    return "s" + h.toString(36);
  }

  /* A Doc opened from a second signed-in Google account is served at
     /document/u/<n>/d/<id>/... — every student with a school and a personal
     account — or at /document/d/<id>/...?authuser=<n> (links out of Gmail
     and Drive). The export must go to that same account slot:
     /document/d/<id>/export answers as the DEFAULT account, which may not be
     able to read the doc at all. The committed navigation URL is asked first
     (it is what the page was served as, whatever Docs later does to the
     address bar), then location.href for when the Navigation Timing entry is
     unavailable. In each, the /u/<n>/ path wins over ?authuser=. Only a slot
     NUMBER is honoured; an ?authuser=<email> falls back to the default. */
  function docAccountPrefix(...urls) {
    for (const u of urls) {
      if (!u) continue;
      let url;
      try { url = new URL(u, "https://docs.google.com"); } catch { continue; }
      const m = url.pathname.match(/^\/document\/u\/(\d+)\/d\//);
      if (m) return `/u/${m[1]}`;
      const slot = url.pathname.startsWith("/document/d/") ? url.searchParams.get("authuser") : null;
      if (slot && /^\d{1,3}$/.test(slot)) return `/u/${slot}`;
    }
    return "";
  }
  function docExportUrl(docId, prefix) {
    return `https://docs.google.com/document${prefix}/d/${docId}/export?format=txt`;
  }

  // TEST ANCHOR (server/test/ext-*) — do not rename or re-indent the next line.
  // Bibliography block ("Sources:" + numbered entries) — the web app has the same in server/public/app/settings.js.
  function sourcesBlock(text) {
    const m = text.match(/(?:^|\n)Sources:\n/);
    if (!m) return null;
    const headStart = m.index + (m[0].startsWith("\n") ? 1 : 0);
    const bodyStart = m.index + m[0].length;
    const entryRe = /^(\d+)\.\s+(.*?)\s+—\s+(\S+)\s*$/;
    const entries = [];
    let pos = bodyStart;
    while (pos < text.length) {
      const nl = text.indexOf("\n", pos);
      const lineEnd = nl === -1 ? text.length : nl;
      const em = text.slice(pos, lineEnd).match(entryRe);
      if (!em) break;
      entries.push({ num: Number(em[1]), title: em[2], url: em[3] });
      pos = nl === -1 ? text.length : nl + 1;
    }
    return { headStart, end: pos, entries };
  }

  /* The writer's reference list: the LAST line that is only a reference-list
     heading — "Works Cited" (MLA), "References" (APA, Chicago author-date),
     "Bibliography" — and every non-empty line after it. Reference lists sit at
     the end, so the last heading is the list even when "References" appears
     as a word earlier. Entries are kept as whole lines: an MLA entry has no
     number to parse, and deduping only needs to know whether a source's
     address is already in one. */
  const REF_HEADINGS = { mla: "Works Cited", apa: "References", chicago: "References" };
  /* The order a reference list is kept in: by its first word, the way MLA,
     APA and Chicago all alphabetise — opening quotes and brackets ignored, and
     a leading "A", "An" or "The" skipped (a title-first entry files under its
     next word). Letter by letter on what is left, case-insensitively. */
  function refSortKey(entry) {
    return String(entry).toLowerCase()
      .replace(/^[\s"“”‘’'(\[]+/, "")
      .replace(/^(?:a|an|the)\s+/, "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 ]+/g, "");
  }
  // The entry the new one goes ABOVE, or null when it belongs last.
  function refInsertBefore(entries, line) {
    const k = refSortKey(line);
    return entries.find((e) => refSortKey(e) > k) ?? null;
  }
  function worksCitedBlock(text) {
    const re = /(?:^|\n)[ \t]*(works cited|references|bibliography)[ \t]*:?[ \t]*(?=\n|$)/gi;
    let m, last = null;
    while ((m = re.exec(text))) last = m;
    if (!last) return null;
    const headStart = last.index + (last[0].startsWith("\n") ? 1 : 0);
    const bodyStart = last.index + last[0].length;
    const entries = text.slice(bodyStart).split("\n").map((l) => l.trim()).filter(Boolean);
    return { heading: last[1], headStart, end: text.length, entries };
  }

  // ── citation formatting ──
  // Plain text only (the Docs bridge appends plain lines). Returns
  // { doc, ref, marker }:
  //   ref    — the full reference, locator included (Copy cite, the popover)
  //   doc    — the same without the locator: docCite appends " — <url>", and
  //            bibliography lines must stay "N. <text> — <url>" on ONE line so
  //            sourcesBlock keeps parsing (and deduping) them
  //   marker — the in-text citation
  // Every field beyond title/url/publisher is optional (kind, authors,
  // groupAuthor, year, date, container, editors, doi from /api/sources; the
  // same plus volume/issue/pages/permalink from /api/cite-url). A source from
  // an older server, or an old scache entry, formats as far as its fields go.
  //
  // What the old formatter got wrong, and this one must not: it hard-coded
  // "(n.d.)" and a retrieval/access date (today's) on every source, and put
  // the publisher — or a bare hostname — in the author slot. The author slot
  // is now: the people named, else the group author, else the publisher for
  // an organisation's own page (never a hostname), else the title. News,
  // reference, journal and book sources with no author lead with the title,
  // as APA and MLA require. "n.d." appears only when no year or date is
  // known, and no citation carries a retrieval or access date.
  const CITE_STYLES = [["apa", "APA"], ["mla", "MLA"], ["chicago", "Chicago"]];
  const CITE_MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const CITE_MLA_MONTHS = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
  const CITE_PARTICLE = /^(van|von|de|del|della|der|den|da|di|du|dos|das|la|le|el|al|bin|ibn|ter|ten|st\.?)$/i;
  // Kinds where an organisation's page or report is its own work: the
  // publisher stands in as the group author when no author is named. A
  // report is an organisation's work even unsigned (APA leads with the
  // organisation, not the title); an authorless book leads with its title.
  const CITE_ORG_KINDS = ["institutional", "report", "archive", "other"];
  const CITE_KINDS = ["institutional", "news", "reference", "journal", "report", "book", "archive", "other"];

  const citeStr = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
  const citeLoose = (s) => String(s ?? "").toLowerCase().replace(/^the\s+/, "").replace(/\(.*?\)/g, "").replace(/[^a-z0-9]/g, "");
  const citeIsHost = (s) => /^[\w-]+(\.[\w-]+)+$/.test(s);
  const citeEndDot = (s) => (/[.?!]$/.test(s) ? s : `${s}.`);
  const citeQuote = (t) => `“${citeEndDot(t)}”`; // terminal punctuation inside the quotes

  // Generational suffixes, kept and printed where each style puts them.
  const CITE_SUFFIX = /^(?:(jr|sr|jnr|snr)\.?|(II|III|IV))$/i;
  // Degrees and honorifics, dropped: no style cites "Dr." or "PhD". Case-
  // sensitive, so a surname such as "Ma" or "Do" is never taken for one.
  const CITE_DEGREE = /^(?:Ph\.?\s?D\.?|D\.?Phil\.?|Ed\.?D\.?|Psy\.?D\.?|Dr\.?P\.?H\.?|Pharm\.?D\.?|M\.D\.|MD|MPH|M\.P\.H\.|DNP|RN|FACP|FRCP|FRCS|Esq\.?)$/;
  const CITE_HONORIFIC = /^(?:dr|prof|professor|mr|mrs|ms|mx|sir|dame|rev)\.?$/i;
  const citeSuffix = (t) => { const m = t.match(CITE_SUFFIX); return m[2] ? m[2].toUpperCase() : `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}.`; };

  /* A name as a page or the model wrote it → { family, given, suffix }.
     "Family, Given" and "Given Family" both arrive (citation_author tags are
     the first, the model's "full names as written" usually the second), with
     suffixes ("Martin Luther King Jr.", "King, Martin Luther, Jr."), degrees
     ("Jane Doe, PhD"), honorifics ("Dr. Jane Doe") and particles, which stay
     with the family name ("Ludwig van Beethoven" → "van Beethoven, L."). */
  function citeParseName(raw) {
    const s = citeStr(raw).replace(/^by\s+/i, "");
    if (!s) return null;
    let suffix = "";
    const segs = s.split(",").map((t) => t.trim()).filter(Boolean);
    // Trailing ", Jr." / ", PhD" / ", MD, MPH" segments. An all-capitals
    // segment is a degree only after a full name: "Jane Doe, MD" is a degree,
    // "Smith, JD" is a family name and initials.
    while (segs.length > 1) {
      const last = segs[segs.length - 1];
      if (CITE_SUFFIX.test(last)) { if (!suffix) suffix = citeSuffix(last); segs.pop(); }
      else if (CITE_DEGREE.test(last) && (!/^[A-Z]{2,4}$/.test(last) || segs[0].includes(" "))) segs.pop();
      else break;
    }
    if (segs.length >= 2) {
      const g = segs.slice(1).join(" ").split(" ");
      while (g.length > 1 && CITE_HONORIFIC.test(g[0])) g.shift(); // "Doe, Dr. Jane"
      return { family: segs[0], given: g.join(" "), suffix };
    }
    const w = segs[0].split(" ");
    while (w.length > 2 && CITE_HONORIFIC.test(w[0])) w.shift();
    while (w.length > 2 && CITE_DEGREE.test(w[w.length - 1])) w.pop();
    if (w.length > 1 && CITE_SUFFIX.test(w[w.length - 1])) { if (!suffix) suffix = citeSuffix(w[w.length - 1]); w.pop(); }
    let i = w.length - 1;
    while (i > 1 && CITE_PARTICLE.test(w[i - 1])) i--;
    return i === 0 ? { family: w.join(" "), given: "", suffix } : { family: w.slice(i).join(" "), given: w.slice(0, i).join(" "), suffix };
  }
  const citeInitials = (given) => given.split(/\s+/).filter(Boolean)
    .map((p) => p.split("-").map((h) => h.replace(/\./g, "")).filter(Boolean)
      .map((h) => (h.length > 1 && h === h.toUpperCase() ? h.split("").map((x) => `${x}.`).join(" ") : `${h[0].toUpperCase()}.`)).join("-"))
    .join(" ");
  // Inverted, a suffix follows the given names after a comma ("King, M. L.,
  // Jr." in APA; "King, Martin Luther, Jr." in MLA and Chicago); in natural
  // order it follows the family name with no comma ("Martin Luther King Jr.").
  const citeSfx = (a, sep) => (a.suffix ? `${sep}${a.suffix}` : "");
  const citeApaName = (a) => (a.given ? `${a.family}, ${citeInitials(a.given)}` : a.family) + citeSfx(a, ", ");
  const citeInv = (a) => (a.given ? `${a.family}, ${a.given}` : a.family) + citeSfx(a, ", ");
  const citeNat = (a) => (a.given ? `${a.given} ${a.family}` : a.family) + citeSfx(a, " ");
  const citeEdNat = (a) => (a.given ? `${citeInitials(a.given)} ${a.family}` : a.family) + citeSfx(a, " "); // APA editors: "M. McAuliffe"

  /** Two names for the same organisation: equal, or one is the other's
   *  acronym ("IOM" / "International Organization for Migration"). */
  function citeSameOrg(a, b) {
    if (!a || !b) return false;
    if (citeLoose(a) === citeLoose(b)) return true;
    const acro = (s) => s.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w[0]).join("");
    const short = [a, b].find((s) => /^[A-Z]{2,8}$/.test(s.trim()));
    if (!short) return false;
    const letters = acro(short === a ? b : a);
    let i = 0;
    for (const ch of letters) if (ch === short[i]) i++;
    return i === short.length && short.length >= Math.ceil(letters.length * 0.6);
  }

  function citeDateParts(src) {
    const m = citeStr(src.date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) {
      return { year: Number(m[1]), month: Number(m[2]) - 1, day: Number(m[3]) };
    }
    const y = Number.isInteger(src.year) ? src.year
      : /^\d{4}$/.test(citeStr(String(src.year ?? ""))) ? Number(src.year) : null;
    return { year: y, month: null, day: null };
  }

  function citeShortTitle(t) {
    let s = t.split(/:\s|\s[–—]\s|\?\s/)[0].replace(/[.,;:]+$/, "");
    const w = s.split(" ");
    if (w.length > 5) s = w.slice(0, 4).join(" ");
    return s;
  }

  function formatCitation(src, style) {
    const url = citeStr(src.url);
    const title = citeStr(src.title || src.url).replace(/[.]\s*$/, "") || url;
    const publisher = citeStr(src.publisher);
    const site = publisher && !citeIsHost(publisher) ? publisher : ""; // a hostname is never a site name
    const kind = CITE_KINDS.includes(src.kind) ? src.kind : "other"; // an older server sends none, a newer one may send one this build does not know
    const people = (Array.isArray(src.authors) ? src.authors : []).map(citeParseName).filter(Boolean);
    let group = citeStr(src.groupAuthor);
    if (!people.length && !group && site && CITE_ORG_KINDS.includes(kind)) group = site;
    const editors = (Array.isArray(src.editors) ? src.editors : []).map(citeParseName).filter(Boolean);
    const container = citeStr(src.container);
    const isJournal = kind === "journal";
    const isBookLike = kind === "book" || kind === "report";
    const isChapter = Boolean(container) && !isJournal && (editors.length > 0 || isBookLike);
    const isRef = kind === "reference";
    const standalone = isBookLike && !isChapter; // italic in print → no quotes here
    const { year, month, day } = citeDateParts(src);
    const hasDay = day != null && !isJournal && !isBookLike && !isChapter; // books and reports cite a year
    const doi = citeStr(src.doi).replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, "");
    const permalink = citeStr(src.permalink);
    const locator = doi ? `https://doi.org/${doi}` : (isRef && permalink && hasDay ? permalink : url);
    const vol = citeStr(src.volume), iss = citeStr(src.issue), pages = citeStr(src.pages);
    const join = (parts) => parts.filter(Boolean).join(" ");
    const edList = (fmt, amp) => (editors.length === 2
      ? `${fmt(editors[0])} ${amp} ${fmt(editors[1])}`
      : editors.length > 2 ? `${editors.slice(0, -1).map(fmt).join(", ")}, ${amp} ${fmt(editors[editors.length - 1])}` : fmt(editors[0]));

    if (style === "mla") {
      // MLA 9: an organisation that is both author and publisher is named
      // once, as publisher, and the entry starts with the title.
      const authorIsPublisher = !people.length && group && (citeSameOrg(group, site) || citeSameOrg(group, container));
      let head = "";
      if (people.length === 1) head = citeEndDot(citeInv(people[0]));
      else if (people.length === 2) head = citeEndDot(`${citeInv(people[0])}, and ${citeNat(people[1])}`);
      else if (people.length > 2) head = citeEndDot(`${citeInv(people[0])}, et al.`);
      else if (group && !authorIsPublisher) head = citeEndDot(group);
      const t = standalone ? citeEndDot(title) : citeQuote(title);
      const when = year == null ? "" : hasDay ? `${day} ${CITE_MLA_MONTHS[month]} ${year}` : String(year);
      const loc = doi ? locator : locator.replace(/^https?:\/\//, "");
      const els = [];
      if (isJournal) {
        els.push(container || site, vol && `vol. ${vol}`, iss && `no. ${iss}`, when, pages && `pp. ${pages}`);
      } else if (isChapter) {
        els.push(container, editors.length && `edited by ${editors.length > 2 ? `${citeNat(editors[0])} et al.` : edList(citeNat, "and")}`, site, when);
      } else {
        els.push(site, when);
      }
      const tail = els.filter(Boolean);
      const ref = join([head, t, tail.length ? `${tail.join(", ")},` : "", citeEndDot(loc)]);
      const doc = join([head, t, tail.length ? citeEndDot(tail.join(", ")) : ""]);
      let lead;
      if (people.length === 1) lead = people[0].family;
      else if (people.length === 2) lead = `${people[0].family} and ${people[1].family}`;
      else if (people.length > 2) lead = `${people[0].family} et al.`;
      else if (group && !authorIsPublisher) lead = group;
      else lead = standalone ? citeShortTitle(title) : `“${citeShortTitle(title)}”`;
      return { doc, ref, marker: `(${lead})` };
    }

    if (style === "chicago") {
      // CMOS 18 author-date. No author: the site owner stands in (an unsigned
      // news story files under the paper), else the title leads.
      let head = "", lead = "";
      if (people.length) {
        const n = people.length;
        head = n === 1 ? citeInv(people[0])
          : n >= 7 ? `${citeInv(people[0])}, ${citeNat(people[1])}, ${citeNat(people[2])}, et al.`
          : `${[citeInv(people[0]), ...people.slice(1, -1).map(citeNat)].join(", ")}, and ${citeNat(people[n - 1])}`;
        lead = n >= 3 ? `${people[0].family} et al.` : n === 2 ? `${people[0].family} and ${people[1].family}` : people[0].family;
      } else if (group || site) {
        head = group || site;
        lead = head;
      }
      const y = year ?? "n.d.";
      const t = standalone ? citeEndDot(title) : citeQuote(title);
      const ySeg = citeEndDot(String(y)); // "n.d." already ends in its period
      const parts = head ? [citeEndDot(head), ySeg, t] : [t, ySeg];
      if (isJournal) {
        // Nothing to name (no journal, a hostname publisher) → no element, never a stray "."
        const j = `${container || site}${vol ? ` ${vol}` : ""}${iss ? ` (${iss})` : ""}`.trim();
        const jEl = pages ? (j ? `${j}: ${pages}` : pages) : j;
        if (jEl) parts.push(citeEndDot(jEl));
      } else if (isChapter) {
        parts.push(citeEndDot(`In ${container}${editors.length ? `, edited by ${edList(citeNat, "and")}` : ""}`));
        if (site) parts.push(citeEndDot(site));
      } else {
        const showSite = site && !citeSameOrg(site, head);
        const full = hasDay ? `${CITE_MONTHS[month]} ${day}, ${year}` : "";
        if (isRef && full) parts.push(showSite ? citeEndDot(site) : "", `Last modified ${full}.`);
        else if (showSite || full) parts.push(citeEndDot([showSite ? site : "", full].filter(Boolean).join(", ")));
      }
      const doc = join(parts);
      const ref = join([doc, citeEndDot(locator)]);
      if (!lead) lead = standalone ? citeShortTitle(title) : `“${citeShortTitle(title)}”`;
      return { doc, ref, marker: `(${lead} ${y})` };
    }

    // APA 7
    let author = "", lead = "";
    if (people.length) {
      const n = people.length;
      author = n === 1 ? citeApaName(people[0])
        : n >= 21 ? `${people.slice(0, 19).map(citeApaName).join(", ")}, . . . ${citeApaName(people[n - 1])}`
        : `${people.slice(0, -1).map(citeApaName).join(", ")}, & ${citeApaName(people[n - 1])}`;
      lead = n >= 3 ? `${people[0].family} et al.` : n === 2 ? `${people[0].family} & ${people[1].family}` : people[0].family;
    } else if (group) {
      author = group;
      lead = group;
    }
    const when = year == null ? "n.d." : hasDay ? `${year}, ${CITE_MONTHS[month]} ${day}` : String(year);
    const parts = author ? [citeEndDot(author), `(${when}).`, citeEndDot(title)] : [citeEndDot(title), `(${when}).`];
    if (isJournal) {
      const jEl = [container || site, `${vol}${iss ? `(${iss})` : ""}`, pages].filter(Boolean).join(", ");
      if (jEl) parts.push(citeEndDot(jEl)); // never a stray "." when there is nothing to name
    } else if (isChapter) {
      const eds = editors.length ? `${edList(citeEdNat, "&")} (${editors.length === 1 ? "Ed." : "Eds."}), ` : "";
      parts.push(citeEndDot(`In ${eds}${container}`));
      if (site && !citeSameOrg(site, author)) parts.push(citeEndDot(site));
    } else if (isRef) {
      if (site) parts.push(`In ${citeEndDot(site)}`); // never a guessed "Wikipedia"
    } else if (site && !citeSameOrg(site, author)) {
      parts.push(citeEndDot(site)); // site / publisher only when it is not the author
    }
    const doc = join(parts);
    const ref = join([...parts, locator]);
    if (!lead) lead = standalone || (!isRef && kind !== "news" && !isJournal && !isChapter) ? citeShortTitle(title) : `“${citeShortTitle(title)},”`;
    const marker = lead.endsWith(",”") ? `(${lead} ${year ?? "n.d."})` : `(${lead}, ${year ?? "n.d."})`;
    return { doc, ref, marker };
  }

  /* ── sentence boundaries: the server's rules, inlined ─────────────────
     This used to split at every ".", "!" or "?" — so "the U.S. Army" became
     the sentence "…the U." and "Harry S. Truman" ended at "S.", and the
     checker, asked about a fragment, flagged it "Doesn't make sense" (a
     tester's screenshots, 2026-09-28: two of those in one paragraph). The
     desktop and the server already split with server/shared/sentenceSplit.js,
     whose rules were each written after a real document was cut in the wrong
     place; they are ported here verbatim rather than imported, because a
     content script has no modules. test/mirror.test.js runs the two copies
     over one corpus. The rules lean toward NOT splitting: two sentences
     merged is one long claim, a sentence split is a fragment flagged as
     nonsense and a citation severed from the claim it backs. */
  const SPLIT_ABBREVIATIONS = new Set(["dr", "mr", "mrs", "ms", "prof", "st", "jr", "sr", "vs", "etc", "fig", "no", "pp", "al", "inc", "ltd", "co", "ed", "eds", "vol", "approx", "cf", "med"]);
  const SPLIT_BRACKET_LOOKAHEAD = 120;
  function splitInsideBrackets(text, dotIndex, spanStart) {
    let depth = 0;
    for (let i = spanStart; i < dotIndex; i++) {
      const ch = text[i];
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    }
    if (depth === 0) return false;
    const limit = Math.min(text.length, dotIndex + SPLIT_BRACKET_LOOKAHEAD);
    for (let i = dotIndex + 1; i < limit; i++) {
      const ch = text[i];
      if (ch === ")" || ch === "]") return true;
      if (ch === "(" || ch === "[") return false; // the earlier bracket never closed
    }
    return false;
  }
  function splitRealBoundary(text, dotIndex, spanStart) {
    if (splitInsideBrackets(text, dotIndex, spanStart)) return false;
    if (text[dotIndex] !== ".") return true;
    let i = dotIndex - 1;
    while (i >= 0 && /[A-Za-z]/.test(text[i])) i--;
    const word = text.slice(i + 1, dotIndex);
    // "8:30 a.m. Studies show…": a time's a.m./p.m. before a capitalised word ends the sentence.
    if (/\d\s*[ap]\.m$/i.test(text.slice(Math.max(0, dotIndex - 8), dotIndex)) && /^\.\s+["'“‘(]?[A-Z]/.test(text.slice(dotIndex, dotIndex + 6))) return true;
    if (word.length === 1) return false; // an initial (R.) or one segment of U.S. / e.g.
    return !SPLIT_ABBREVIATIONS.has(word.toLowerCase());
  }
  // One line's sentences as [start, end) over that line, text trimmed.
  function splitLineSentences(line) {
    const spans = [];
    const boundary = /(?:[.!?]+["'’”)\]¹²³⁰-⁹]*(?:\s+|$))/g;
    let start = 0, m;
    while ((m = boundary.exec(line))) {
      if (!splitRealBoundary(line, m.index, start)) continue;
      const end = m.index + m[0].length;
      if (line.slice(start, end).trim()) spans.push([start, end]);
      start = end;
    }
    if (start < line.length && line.slice(start).trim()) spans.push([start, line.length]);
    return spans;
  }

  function segmentText(text) {
    const segs = [];
    const block = sourcesBlock(text);
    const wc = worksCitedBlock(text);
    const lineRe = /[^\n]+/g;
    let lm;
    while ((lm = lineRe.exec(text))) {
      const line = lm[0];
      const base = lm.index;
      if (block && base >= block.headStart && base < block.end) continue; // skip the bibliography
      if (wc && base >= wc.headStart) continue; // and the writer's Works Cited / References
      for (const [s0, e0] of splitLineSentences(line)) {
        const raw = line.slice(s0, e0);
        const lead = raw.match(/^\s*/)[0].length;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const start = base + s0 + lead;
        segs.push({ text: trimmed, start, end: start + trimmed.length, hash: hashText(trimmed) });
      }
    }
    for (const seg of segs) {
      const words = seg.text.split(/\s+/).length;
      const endsTerminal = /[.!?]["')\]]*$/.test(seg.text);
      const moreAfter = text.slice(seg.end).trim().length > 0;
      seg.checkable = words >= 3 && seg.text.length <= 2000 && (endsTerminal || moreAfter)
        // Raw-code claim gate: never spend an API call on text that cannot
        // be a factual claim. Conservative on purpose — a skipped real claim
        // costs trust, a checked non-claim only costs pennies. (No opinion-
        // opener filter: "I think the Great Wall is visible from space" is a
        // checkable falsehood wearing a hedge.)
        && !/\?\s*$/.test(seg.text)                       // bare questions aren't claims ("(or was it 1945?)" tails still check)
        && /\p{L}/u.test(seg.text)                        // any-script letters — numbers/dividers only
        && !/^[\d\s.)\-–—•*#]+$/.test(seg.text)           // list markers / rules
        && !(!endsTerminal && words <= 6 && looksLikeHeading(seg.text)); // short title-cased unpunctuated line = heading
    }
    return segs;
  }

  /* A short unpunctuated line is a heading only if it is CASED like one. Any
     short unpunctuated line used to count, so "Lamine Yamal is 24 years old"
     (six words, no period, a line of its own) was never checked, while the
     same sentence with a period was: whether a false claim got flagged
     depended on one keystroke. A heading capitalises its long words ("Early
     Life", "The Rise of Barcelona", "INTRODUCTION"); a sentence does not
     ("years", "old"). Mid-typing fragments this lets through wait for
     readyToSend's settle rule instead of being sent half-written. */
  const HEADING_SMALL_WORDS = new Set(["from", "with", "into", "onto", "over", "upon", "than", "that", "versus"]);
  function looksLikeHeading(text) {
    return text.split(/\s+/).every((w) => !/^\p{Ll}\p{L}{3,}/u.test(w) || HEADING_SMALL_WORDS.has(w.toLowerCase().replace(/\P{L}+$/u, "")));
  }

  /* Check timing. A check used to start CHECK_INTERVAL_MS (10 s) after the
     previous one ENDED, so a sentence finished just after a check began waited
     for that check, then ten seconds, then its own: ~15-25 s to an underline.
     Now the page is read every READ_INTERVAL_MS while the text is changing,
     and a check goes out as soon as something is ready — still one at a time.

     Cost is the number of sentences sent (and the requests carrying them), not
     how often the page is read; unchanged text is never re-sent (hash cache).
     What a faster read could add is HALF-WRITTEN sentences, so only a sentence
     that ends in . ! ? goes at first sight; one without (a fragment with text
     after it) must read the same twice in a row first. That holds back
     fragments the 10 s timer used to catch and send. */
  const READ_INTERVAL_MS = 3_000;
  const ACTIVE_WINDOW_MS = 30_000;
  const REVIEW_IDLE_MS = 5_000;    // /api/review waits until the text has been still this long
  const REVIEW_FLOOR_MS = 60_000;  // and asks at most this often (the server's REVIEW_MIN_INTERVAL_MS) — and retries a failure after it
  const REVIEW_REPEAT_MS = 180_000; // after a review that ANSWERED, the next waits this long

  /* Whether a resume has changed enough since its last review to pay for
     another (~0.1-0.3¢ each; Free allows 30 a day). Cost idea 1, 2026-10-04:
     the first gate re-reviewed on ANY change, so fixing one typo in a bullet
     bought a whole new review. Now only a line that is new or REWRITTEN counts
     — not one within a few characters of a line that was there (a typo, a
     changed digit), and not a deleted line (its tips drop out locally, see
     resumeTips). The free format rules still update on every read. */
  function reviewWorthwhile(prev, next) {
    if (prev == null) return true;
    const lines = (t) => String(t).split("\n").map((l) => l.toLowerCase().replace(/\s+/g, " ").trim()).filter((l) => l.length >= 3);
    const before = lines(prev);
    const seen = new Set(before);
    for (const line of lines(next)) {
      if (seen.has(line)) continue;
      if (!before.some((b) => nearlySame(b, line, 3))) return true; // new, or rewritten past a typo
    }
    return false;
  }
  // Levenshtein distance <= max, abandoned as soon as a row's best exceeds it.
  function nearlySame(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return false;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return false;
      prev = cur;
    }
    return prev[b.length] <= max;
  }

  /* Underlines hold while the text holds. Owner, 2026-10-08: "I can use
     tracely at night have it underline things and wake up and different
     things are underlined … I want it to be consistently underlining the
     same thing yet maintaining efficiency and accuracy". The fact verdicts
     were already kept per sentence with the doc (VCACHE_KEY) and never asked
     again while the sentence stands. The review was not: it lived in the
     page, so any reload — a tab Chrome put to sleep overnight, Docs
     reconnecting, an extension update — paid for a new review of the same
     text, and a model never picks or words its notes the same way twice.
     Now the last review is kept with the doc too (reviewSnapshot /
     restoreReview), so the same text reads back the same notes, for free. */
  const REVIEW_KEEP_CHARS = 60_000; // a longer document is reviewed again after a reload rather than filling the page's storage
  function reviewSnapshot(review) {
    if (review.lastText == null || review.lastText.length > REVIEW_KEEP_CHARS || !review.kind) return null;
    return { v: 1, kind: review.kind, lastText: review.lastText, findings: review.findings, okAt: review.okAt, serving: review.serving, seen: [...review.seen].slice(-40) };
  }
  // Fills `review` from a stored snapshot; anything malformed is ignored (the page's storage is shared with the site).
  function restoreReview(review, raw) {
    let snap = null;
    try { snap = JSON.parse(raw ?? "null"); } catch { return false; }
    if (!snap || snap.v !== 1 || typeof snap.kind !== "string" || typeof snap.lastText !== "string" || !Array.isArray(snap.findings)) return false;
    const okAt = Number.isFinite(snap.okAt) ? snap.okAt : 0;
    Object.assign(review, {
      kind: snap.kind, lastText: snap.lastText, findings: snap.findings.filter((f) => f && typeof f === "object"),
      okAt, at: okAt, serving: typeof snap.serving === "boolean" ? snap.serving : null,
      seen: new Map((Array.isArray(snap.seen) ? snap.seen : []).filter((e) => Array.isArray(e) && typeof e[0] === "string" && e[1] && typeof e[1] === "object")),
    });
    return true;
  }
  /* And after an edit, a review re-reads the whole essay and could move notes
     off paragraphs the edit never touched. A note about one sentence — its
     evidence, its analysis, a quotation, a citation, a resume bullet or typo
     — stays while its paragraph is word for word what the last review read,
     unless the new review says something else about that same sentence. A
     paragraph that changed gets the new review's word, and so do the notes
     an edit anywhere can settle: the thesis, the structure, how parts relate
     (relevance, contradiction) and the DBQ's documents, sourcing and
     complexity. Dismissed notes stay dismissed (essayFeedbackTips). */
  const LOCAL_NOTE_KINDS = ["evidence", "analysis", "quotation", "citation", "source", "bibliography", "reasoning", "bullet", "typo"];
  const REVIEW_NOTE_CAP = 10; // what a panel can hold: the new review's own notes first
  function carryReviewNotes(prevFindings, prevText, nextFindings, nextText) {
    const norm = (x) => String(x ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    const paragraphs = (t) => String(t ?? "").split(/\n+/).map(norm).filter(Boolean);
    const before = new Set(paragraphs(prevText));
    const now = paragraphs(nextText);
    const fresh = (Array.isArray(nextFindings) ? nextFindings : []).filter((f) => f && typeof f === "object");
    const spoken = new Set(fresh.filter((f) => f.quote).map((f) => norm(f.quote)));
    const carried = [];
    for (const f of Array.isArray(prevFindings) ? prevFindings : []) {
      if (!f || !LOCAL_NOTE_KINDS.includes(f.kind) || !f.quote) continue;
      const q = norm(f.quote);
      if (!q || spoken.has(q)) continue;
      const para = now.find((x) => x.includes(q));
      if (para && before.has(para)) { carried.push(f); spoken.add(q); }
    }
    return [...fresh, ...carried].slice(0, Math.max(REVIEW_NOTE_CAP, fresh.length));
  }

  /* Reusing a verdict after a trivial edit. Cost idea 2, 2026-10-04: any
     change to a sentence gave it a new hash, so fixing "recieve" or adding a
     comma paid for a fresh check of a sentence already judged. Now the new
     sentence inherits the verdict (and a dismissal) of the one it replaced
     when the only change is case, spacing, punctuation, or one typo-sized
     edit to an ordinary word.

     The rule leans hard toward re-checking, because a reused verdict on a
     sentence whose meaning DID change is a wrong answer, and a re-check is a
     fraction of a cent. So it never reuses across a change to: a number or
     anything holding a digit ("24" → "22", "2.5" → "25"), a % or currency
     sign, a capitalised word past the first (names: "Austria" → "Australia"),
     a negation ("is" → "isn't", "not"), a number or quantity word ("nine" →
     "none"), a word under 4 letters, or more than one word. The changed word
     must be within one letter, or two swapped. */
  const PROTECTED_WORDS = new Set(("not no nor never none nothing nobody neither cannot without " +
    "zero one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty hundred thousand million billion trillion " +
    "first second third fourth fifth sixth seventh eighth ninth tenth half twice double triple dozen " +
    "all every each any some most many much few fewer less least more several only always often rarely seldom sometimes usually").split(" "));
  const editTokens = (s) => String(s).match(/[\p{L}\p{N}]+(?:['’.,][\p{L}\p{N}]+)*|[%$€£¥°]/gu) || [];
  function smallEdit(a, b) {
    const x = editTokens(a), y = editTokens(b);
    if (x.length !== y.length || x.length === 0) return false;
    let changed = 0;
    for (let i = 0; i < x.length; i++) {
      if (x[i].toLowerCase() === y[i].toLowerCase()) continue;
      if (++changed > 1) return false;
      const p = x[i].toLowerCase(), q = y[i].toLowerCase();
      if (/[^\p{L}'’]/u.test(p + q) || p.length < 4 || q.length < 4) return false; // digits, signs, short words
      if (i > 0 && (/^\p{Lu}/u.test(x[i]) || /^\p{Lu}/u.test(y[i]))) return false; // a name
      if (/n['’]t$/.test(p) || /n['’]t$/.test(q) || PROTECTED_WORDS.has(p) || PROTECTED_WORDS.has(q)) return false;
      const swapped = p.length === q.length && [...p].some((c, k) => k + 1 < p.length && c === q[k + 1] && p[k + 1] === q[k] &&
        p.slice(0, k) === q.slice(0, k) && p.slice(k + 2) === q.slice(k + 2));
      if (!swapped && !nearlySame(p, q, 1)) return false;
    }
    return true;
  }
  // The verdict a new sentence may inherit: from a checked sentence on the
  // previous read that is gone from this one and differs only by smallEdit.
  // Each old sentence is inherited once (`taken`).
  function inheritedVerdict(seg, prevSegs, liveHashes, cache, taken) {
    for (const old of prevSegs) {
      if (liveHashes.has(old.hash) || taken.has(old.hash) || !cache.has(old.hash)) continue;
      if (smallEdit(old.text, seg.text)) { taken.add(old.hash); return old; }
    }
    return null;
  }
  /* Whether a resume's review stands in for the fact check. Cost idea 5,
     2026-10-04: on a resume the check's only visible output is "false" — a
     public fact stated wrongly, like a school's real name (flagShown hides
     needs_citation and questionable there) — and /api/review now looks for
     that too, alongside the bullets and typos. So while the review serves the
     resume, no sentence is sent to /api/check at all. serving is null until
     the first review is tried (the check waits: the review is due within
     seconds of the writer pausing), true once one answers for a resume, and
     false after a failure, a reply saying it is not a resume, or a server
     without the route (unavailable) — and then the check runs as before. */
  // Which review a document gets: resume tips, essay feedback, or none.
  function reviewKindFor(genre) {
    if (genre === "resume") return FEATURES.resumeTips ? "resume" : null;
    if (isArgumentGenre(genre) && genre !== "lab") return FEATURES.essayFeedback ? "essay" : null;
    return null;
  }
  function reviewCoversCheck(genre, review) {
    return genre === "resume" && !review.unavailable && review.serving !== false;
  }
  const REVIEW_MAX_CHARS = 12_000; // what the server reads (runReview's clamp), so no more is sent — PRIVACY.md says 12,000 // read fast for this long after the last change, then idle at CHECK_INTERVAL_MS

  /* How long to leave Google's export alone after it answers 429 Too Many
     Requests. Owner's console, 2026-10-04: "GET …/export … 429". Reads run
     every 3 s while the writer types (READ_INTERVAL_MS), and a refused read
     used to retry 10 s later at the same pace, straight back into the limit.
     Now: Google's Retry-After when it sends one, else 30 s, doubling on each
     refusal in a row, at most 5 minutes; the first good read resets it. */
  const EXPORT_BACKOFF_MIN_MS = 30_000;
  const EXPORT_BACKOFF_MAX_MS = 300_000;
  function exportBackoffMs(prevMs, retryAfter) {
    const next = prevMs > 0 ? Math.min(prevMs * 2, EXPORT_BACKOFF_MAX_MS) : EXPORT_BACKOFF_MIN_MS;
    const asked = Number(retryAfter) > 0 ? Math.min(Number(retryAfter) * 1000, EXPORT_BACKOFF_MAX_MS) : 0;
    return Math.max(next, asked);
  }

  function readyToSend(seg, prevHashes) {
    return /[.!?]["')\]]*$/.test(seg.text) || prevHashes.has(seg.hash);
  }

  // How long after the last read (or check) the next one is due. A failed
  // check backs off to the old interval so an outage is not retried every 3 s.
  function nextReadGap(now, lastChangeAt, failed) {
    if (failed) return CHECK_INTERVAL_MS;
    return now - lastChangeAt <= ACTIVE_WINDOW_MS ? READ_INTERVAL_MS : CHECK_INTERVAL_MS;
  }

  /* Evidence suggestions. A sentence can be TRUE and still be the kind of
     point a marker wants backed: "Getting enough sleep improves memory" is
     accurate, so the checker rightly does not flag it, yet an essay arguing
     that sleep matters is stronger with a study behind it. Owner,
     2026-10-03: suggest evidence "depending on what you are writing about …
     dont force this, as it isnt always necessary".

     So: offered, never pushed. Only sentences the checker already judged
     "accurate" (a real factual claim, not an opinion — those come back
     no_claim) that make an argumentative or causal point (EVIDENCE_CUE), are
     not already sourced, and were not dismissed; at most three; no underline,
     no count on the launcher, a folded section in the panel. Nothing is
     searched until the writer clicks "Find evidence" — a source search costs
     ~1-6¢ against a check's 0.09¢, and the free plan has 5 a day — so this
     adds no cost of its own and decides locally, from verdicts already paid
     for. Common knowledge ("Water boils at 100 degrees") has no cue and is
     left alone. */
  const EVIDENCE_CUE = /\b(?:improv|reduc|increas|decreas|lower|rais|boost|strengthen|weaken|harm|damag|hurt|caus|prevent|protect|benefit|contribut|lead(?:s|ing)? to|led to|result(?:s|ed)? in|linked to|associated with|tied to|affect|impact|more likely|less likely|risk|good for|bad for|essential|vital|crucial|effective|makes? (?:people|students|you|us|them)\b)/i;
  // Already carries a source: an (Author, year) parenthetical, a [n] marker, or prose attribution.
  const ALREADY_SOURCED = /\([^()]*\b\d{4}[a-z]?\b[^()]*\)|\[\d+\]|\baccording to\b|\b(?:study|studies|research|survey|report|paper)\s+(?:by|from|in|published)\b/i;
  const MAX_EVIDENCE_SUGGESTIONS = 3;
  function evidenceCandidates(segments, cache, dismissed) {
    const out = [];
    const seen = new Set();
    for (const seg of segments) {
      if (!seg.checkable || seen.has(seg.hash)) continue;
      seen.add(seg.hash);
      if (cache.get(seg.hash)?.verdict !== "accurate" || dismissed.has(seg.hash)) continue;
      if (!EVIDENCE_CUE.test(seg.text) || ALREADY_SOURCED.test(seg.text)) continue;
      out.push(seg);
      if (out.length >= MAX_EVIDENCE_SUGGESTIONS) break;
    }
    return out;
  }

  /* What kind of document this is. Owner, 2026-10-03, on a resume the checker
     answered with eight "needs_citation" flags: "Tracely should be able to
     detect the context". The server's check prompt now decides this for
     itself (lib/factcheck.js "Decide first what the DOCUMENT is"); this local
     copy is what the UI needs — whether to show Resume tips, whether to ask
     /api/review, and whether to hide a citation flag a server from before
     that prompt still sends. Deliberately strict: a resume needs two section
     headings of its own AND contact details or date ranges, and is not mostly
     full sentences. An essay that says "experience" in a heading is not one. */
  const RESUME_HEADING = /^(?:education|(?:work |professional |relevant )?experience|employment(?: history)?|skills(?:\s*[/&]\s*interests)?|technical skills|projects|certifications?|awards(?:\s*[/&]\s*achievements)?|honou?rs|extracurricular(?: activities)?|activities|leadership|volunteer(?:ing| work| experience)?|summary|profile|objective|interests|languages|publications|references)$/i;
  const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
  const DATE_RANGE = new RegExp(`\\b${MONTH}\\s+(?:\\d{1,2},\\s*)?\\d{4}\\s*[–—-]\\s*(?:${MONTH}\\s+(?:\\d{1,2},\\s*)?\\d{4}|Present|Current|Now)\\b|\\b(?:19|20)\\d{2}\\s*[–—-]\\s*(?:(?:19|20)\\d{2}|Present|Current|Now)\\b`, "gi");
  /* A letter or email: it opens with a salutation and closes with a sign-off.
     Its figures are the writer's own ("I scored a 5 on AP Statistics"), so
     no citation flags (flagShown). Checked before the length floor, because
     an email is often four lines. Both ends are required for anything longer
     than a short note: "Hi" alone opens plenty of blog posts. */
  const SALUTATION = /^(?:dear|hi|hello|hey|greetings|good (?:morning|afternoon|evening)|to whom it may concern|to the (?:editor|editors|admissions committee|selection committee|hiring committee))\b[^!?\n]{0,60}[,:!]?$/i;
  const SIGNOFF_WORDS = "sincerely|sincerely yours|best|best regards|best wishes|all the best|kind regards|warm regards|warmest regards|warm wishes|regards|respectfully|respectfully yours|thanks|thank you|thanks so much|thank you so much|thanks again|thank you again|many thanks|with gratitude|gratefully|cheers|warmly|love|with love|lots of love|take care|talk soon|see you soon|yours|yours truly|yours sincerely|yours faithfully|cordially";
  const SIGNOFF = new RegExp(`^(?:${SIGNOFF_WORDS}|(?:thanks|thank you)(?: so much| again)? for [^,.!?]{2,40})[,.!]?$`, "i");
  /* Homework, not writing. Owner, 2026-10-04: Tracely "keeps trying to help
     me with other things such as my physics homework … only make it help on
     literature", on "3. Determine the net area under the velocity vs time
     curve … How does the area under the curve compare to …?". A worksheet is
     a list of TASKS — numbered prompts that tell the student to determine,
     calculate or explain, and questions — about a STEM subject; an essay
     makes claims. Two ways to be one, both needing tasks to be a large share
     of the text so an essay with a rhetorical question is never caught:
       - at least one task, half or more of the sentences tasks, and a
         third or more of the sentences using STEM vocabulary, units or math;
       - three or more numbered task items making up 40% of the sentences.
     Tracely then sends nothing, draws nothing, and says why. */
  const TASK_START = /^(?:\(?(?:\d{1,2}|[a-h])[.)]\s*)?(?:determine|calculate|find|solve|compute|show that|prove|derive|evaluate|simplify|estimate|sketch|graph|plot|draw|label|identify|list|state|describe how|explain how|explain why|compare|use (?:the|your)|what is|what are|what was|what were|how does|how do|how did|how many|how much|how far|how long|why does|why do|which)\b/i;
  const NUMBERED_ITEM = /^\(?(?:\d{1,2}|[a-h])[.)]\s+\S/i;
  const STEM_TERM = /\b(?:velocity|acceleration|displacement|momentum|kinetic|potential energy|newtons?|joules?|watts?|gravity|friction|vectors?|scalars?|slope|intercept|derivative|integral|equations?|formula|graphs?|axis|axes|curve|functions?|variables?|coefficient|molar|moles?|reactants?|stoichiometr\w*|hypotenuse|triangle|radius|diameter|circumference|probability|area under|net area|position[- ]time|velocity[- ]time)\b|\d\s?(?:m\/s²?|km\/h|kg|cm|mm|N|J|W|Hz|mol|°C)\b|[=√±×÷^]/i;
  function looksLikeHomework(text) {
    const sentences = [];
    for (const line of String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
      for (const s of line.split(/(?<=[.!?])\s+(?=["“(]?[A-Z0-9])/)) if (s.split(/\s+/).length >= 3) sentences.push(s);
    }
    const n = sentences.length;
    if (n === 0) return false;
    const isTask = (s) => TASK_START.test(s) || /\?["”’)]?$/.test(s);
    const tasks = sentences.filter(isTask).length;
    const stem = sentences.filter((s) => STEM_TERM.test(s)).length;
    const numbered = sentences.filter((s) => NUMBERED_ITEM.test(s) && isTask(s)).length;
    // Numbered QUESTIONS with answers under them (a history worksheet): the answers are sentences, the items are not.
    const items = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    const asked = items.filter((l) => NUMBERED_ITEM.test(l) && (TASK_START.test(l) || /\?["”’)]?$/.test(l))).length;
    // Worked math — "3x + y = 16" line after line — and a sheet that says what it is.
    const mathy = items.filter((l) => /[=≈≤≥]/.test(l) && /\d/.test(l) && l.split(/\s+/).length <= 16).length;
    const sheet = /^(?:directions?\s*:|worksheet\b|show (?:all )?(?:of )?your work|answer key\b)|\bworksheet\b/im.test(items.slice(0, 4).join("\n"));
    return (tasks >= 1 && tasks / n >= 0.5 && stem / n >= 0.3) || (numbered >= 3 && numbered / n >= 0.4) || (asked >= 3 && asked / items.length >= 0.25)
      || (mathy >= 4 && mathy / items.length >= 0.3) || (sheet && (asked >= 2 || mathy >= 3 || items.filter((l) => NUMBERED_ITEM.test(l)).length >= 3));
  }

  /* What kind of writing this is, from its text alone — free, instant, and
     the same answer for the same text (no model is asked). Owner, 2026-10-09:
     "make it extremely good at type of literature detection. For example, if
     it is world history DBQ, no need for citations and worked cited. If it is
     a poem, cite this way. If it is a research paper, cite that way. Even
     things i dont mention such as resumes or emails". The kind decides what
     is checked and how a source is cited — GENRE_QUIET, GENRE_OWN and
     GENRE_NO_SOURCE (flagShown), genreWantsList (a Works Cited), what the
     panel says (genreLineHtml) — and the most distinctive shapes are looked
     for first: a salutation and a sign-off, numbered tasks, a script's
     speakers, a resume's headings, a DBQ's document numbers, an annotated
     bibliography's entries, a speech's address to the room, a lab report's
     sections, a poem's lines, notes' bullets; then a paper's headings or a
     literary essay's quotations, a news story's attributions, and last the
     voice — a story's dialogue, a personal essay's looking back. Anything
     else is an essay ("prose"). Measured on
     server/test/fixtures/writing-types.js (ext-writing-types.test.js). */
  function detectGenre(text) {
    const raw = String(text ?? "").replace(/\r\n?|[\u000b\u2028\u2029]/g, "\n");
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return "prose";
    const letter = letterKind(raw, lines);
    if (letter) return letter;
    if (looksLikeHomework(raw)) return "homework";
    if (looksLikeScript(lines)) return "script";
    if (lines.length >= 6 && looksLikeResume(raw, lines)) return "resume";
    if (looksLikeDbq(raw)) return "dbq";
    if (looksLikeAnnotated(lines)) return "annotated";
    if (looksLikeSpeech(raw, lines)) return "speech";
    if (looksLikeLab(lines)) return "lab";
    if (looksLikePoem(raw, lines)) return "poem";
    if (looksLikeNotes(lines)) return "notes";
    const kind = essayKind(raw, lines);
    if (kind !== "prose") return kind;
    if (looksLikeNews(raw, lines)) return "news";
    return narrativeKind(raw) ?? "prose";
  }
  // A resume: two section headings of its own AND contact details or date ranges, and not mostly sentences.
  function looksLikeResume(raw, lines) {
    const headings = lines.filter((l) => l.length <= 40 && RESUME_HEADING.test(l.replace(/[^\p{L}\s/&]/gu, " ").replace(/\s+/g, " ").trim())).length;
    const contact = /[\w.+-]+@[\w-]+|\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(lines.slice(0, 6).join(" "));
    const ranges = (raw.match(DATE_RANGE) ?? []).length;
    const sentences = lines.filter((l) => /[.!?]["')\]]*$/.test(l) && l.split(/\s+/).length >= 12).length;
    return headings >= 2 && (contact || ranges >= 2) && sentences / lines.length < 0.6;
  }
  /* A letter, an email or a cover letter: a salutation — on the first line,
     or under a short heading block (an address, a date, a Subject line) —
     and a sign-off. An opening that addresses an AUDIENCE ("Good morning,
     everyone") and ends "Thank you." is a speech: an address like that needs
     a signature under it to be a letter ("Hi all, … Thanks, Sam"). */
  const SIGNOFF_LEAD = new RegExp(`^(?:${SIGNOFF_WORDS})\\s*[,.!]\\s*[-–—]?\\s*(.+)$`, "i");
  const SIGNATURE = /^[-–—~]?\s*(?:(?:Mr|Mrs|Ms|Mx|Dr|Prof)\.?\s+)?[A-Z][\p{L}'’-]*\.?(?:\s+[A-Z][\p{L}'’-]*\.?){0,3}$/u;
  const AUDIENCE = /\b(?:everyone|everybody|y'all|all of you|ladies|gentlemen|fellow|class of|graduates|classmates|students|teachers|parents|families|delegates|judges|faculty|guests|members of)\b/i;
  const COVER_CUE = /\b(?:position|internship|role|opening|job|application|apply|applying|candidate|résumé|resume|interview|qualifications?|qualified|employer|hire|hiring|join (?:your|the) team)\b/gi;
  const EMAIL_CUE = /\b(?:hope (?:this|you)(?: email| message| note)? finds you|hope you(?:'re| are) (?:doing )?well|let me know|thanks in advance|attached|following up|quick question|get back to me|looking forward to hearing|extension|deadline|due (?:date|on|by)|office hours|meeting|zoom|tomorrow|this (?:week|weekend|friday|monday|tuesday|wednesday|thursday)|next (?:week|class|period)|assignment|absent|reschedule)\b/i;
  function signOffLine(l) {
    if (SIGNOFF.test(l)) return "bare";
    const m = l.match(SIGNOFF_LEAD);
    return m && SIGNATURE.test(m[1].trim()) ? "named" : null;
  }
  function letterKind(raw, lines) {
    if (lines.length < 2) return null;
    let at = -1;
    for (let i = 0; i < Math.min(lines.length - 1, 14); i++) {
      if (SALUTATION.test(lines[i])) { at = i; break; }
      if (lines[i].split(/\s+/).length > 8 && !/^(?:subject|re|fwd?|to|from|date|cc|bcc|sent)\s*:/i.test(lines[i])) break; // body text before any salutation: no letter's head
    }
    if (at < 0) return null;
    const sal = lines[at];
    const tail = lines.slice(-7); // a signature can carry a title, a school and a phone number under the name
    const offs = tail.map(signOffLine);
    const closing = (l, o) => o === "bare" || (/^[^.!?]{2,40},$/.test(l) && l.split(/\s+/).length <= 5);
    const named = offs.includes("named") || offs.some((o, i) => closing(tail[i], o) && tail.slice(i + 1, i + 3).some((l) => SIGNATURE.test(l)));
    // A formal letter may be signed with the name alone ("To the Editor: … Ruth Ellison / Westfield").
    const last = lines[lines.length - 1];
    const formal = /^(?:dear|to whom|to the)\b/i.test(sal) && SIGNATURE.test(last) && last.split(/\s+/).length <= 4;
    if (AUDIENCE.test(sal) && !named) return null;
    if (!named && !formal && !offs.includes("bare") && lines.length > 4) return null; // both ends, unless it is a short note
    const head = lines.slice(0, at + 1).join("\n");
    const body = lines.slice(at + 1).join(" ");
    if (/\bhiring\b/i.test(sal) || (body.match(COVER_CUE) ?? []).length >= 3) return "coverletter";
    if (/^(?:subject|re|fwd?)\s*:/im.test(head) || /^(?:hi|hello|hey)\b/i.test(sal) || EMAIL_CUE.test(body)) return "email";
    return "letter";
  }
  /* A script: screenplay sluglines (INT. / EXT.), or the same few speakers
     cued again and again — "MAYA: …" in a play, a capitalised name above
     each speech in a screenplay. A label that is not a person ("Thesis:",
     "Note:", "Q:") never counts. */
  const NOT_A_SPEAKER = /^(?:thesis|claim|evidence|reasoning|note|notes|example|answer|question|hook|topic|source|summary|date|name|period|subject|re|to|from|cc|step|part|title|tip|warning|objective|purpose|hypothesis|conclusion|introduction|materials|procedure|data|results|analysis|q|a|definition|key|main idea|vocab|vocabulary|cause|causes|effect|effects|pro|pros|con|cons|ps|p\.s|education|experience|skills|projects|awards|summary)$/i;
  function looksLikeScript(lines) {
    if (lines.filter((l) => /^(?:INT|EXT|INT\.?\/EXT|I\/E)[.\s]/.test(l) || /^(?:FADE (?:IN|OUT)|CUT TO|DISSOLVE TO)\b/.test(l)).length >= 2) return true;
    const speakers = new Map();
    let cued = 0;
    for (const l of lines) {
      if (/^(?:[IVX]{1,4}|[A-Za-z]|\d{1,2})[.)]\s/.test(l)) continue; // an outline's or a list's point, not a speaker
      const name = l.match(/^([A-Z][A-Za-z.'’-]+(?: [A-Z][A-Za-z.'’-]+)?)\s*(?:\([^)]{1,30}\))?\s*:\s*\S/)?.[1]
        ?? (/^[A-Z][A-Z.'’ -]{1,24}(?:\s*\((?:V\.O\.|O\.S\.|O\.C\.|CONT'D|cont'd)\))?$/.test(l) && l.split(/\s+/).length <= 3 ? l.replace(/\s*\(.*$/, "") : null);
      if (!name || NOT_A_SPEAKER.test(name.replace(/\.$/, ""))) continue;
      const key = name.toUpperCase();
      speakers.set(key, (speakers.get(key) ?? 0) + 1);
      cued++;
    }
    return [...speakers.values()].filter((c) => c >= 2).length >= 2 && cued >= 5 && cued / lines.length >= 0.25;
  }
  /* A DBQ: the documents it was given, cited by number or letter — (Doc 3),
     "Document A shows", IB's "Source B" — two different ones, or one with the
     prompt's own words ("Using the documents …"). */
  const DOC_REF = /\b[Dd]oc(?:ument)?s?\.?\s*#?\s*(\d{1,2}|[A-H])\b/g;
  const IB_SOURCE = /\bSource\s+([A-H])\b/g;
  const DBQ_PROMPT = /\b(?:DBQ|document[- ]based|(?:using|use) (?:the |all |at least \w+ (?:of the )?)?(?:\w+ )?documents|historical (?:context|situation)|contextuali[sz]ation)\b/i;
  function looksLikeDbq(raw) {
    const ids = new Set();
    let refs = 0;
    for (const m of raw.matchAll(DOC_REF)) { ids.add(m[1].toUpperCase()); refs++; }
    for (const m of raw.matchAll(IB_SOURCE)) { ids.add(`S${m[1]}`); refs++; }
    return ids.size >= 2 || (refs >= 1 && DBQ_PROMPT.test(raw));
  }
  /* An annotated bibliography: entries that open with a reference — "Lee,
     Ana. …" or "Lee, A. (2019)." with its year — each followed by what the
     writer says about it ("This article argues …"). An essay's Works Cited is
     references back to back, with nothing said about them. */
  const REF_START = /^[\p{Lu}][\p{L}'’-]+(?:\s[\p{Lu}][\p{L}'’-]+)?,\s+(?:[\p{Lu}][\p{L}'’.-]*\s?){1,4}(?:,|\.|\()/u;
  const SUMMARY_CUE = /\b(?:this (?:[\w-]+ ){0,2}(?:article|source|book|study|website|site|essay|report|chapter|piece|paper|author|text|film|documentary|video|podcast|interview|collection)|the (?:authors?|article|study|source|book|website|writer|researchers?) (?:argues?|explains?|describes?|discuss(?:es)?|shows?|claims?|suggests?|provides?|presents?|explores?|examines?|focus(?:es)?|uses?|offers?)|(?:will|would) (?:be|help)|is (?:useful|helpful|relevant|credible|reliable)|I (?:will|plan to|can) use)\b/i;
  function looksLikeAnnotated(lines) {
    if (lines.slice(0, 6).some((l) => /\bannotated bibliography\b/i.test(l) && l.split(/\s+/).length <= 12)) return true;
    const isRef = (l) => (REF_START.test(l) || /^["“][^"”]{3,}["”]\s*[.,]?\s+\S/.test(l)) && /\b(?:1[5-9]|20)\d\d\b|\bn\.\s?d\./.test(l);
    let refs = 0, said = 0;
    lines.forEach((l, i) => {
      if (!isRef(l)) return;
      refs++;
      if (SUMMARY_CUE.test(l.slice(60)) || (lines[i + 1] && !isRef(lines[i + 1]) && SUMMARY_CUE.test(lines[i + 1]))) said++;
    });
    return said >= 2 && refs / lines.length >= 0.25;
  }
  /* A speech: it addresses the people in the room ("Good morning,
     everyone", "Fellow students", "Ladies and gentlemen"), talks to them
     ("imagine", "vote for me", "all of you") and thanks them at the end. */
  const SPEECH_OPEN = /^(?:(?:good (?:morning|afternoon|evening)|hello|hi|hey|greetings|welcome)\b[^.!?\n]{0,40}?\b(?:everyone|everybody|all|y'all|ladies|gentlemen|students|classmates|teachers|parents|families|graduates|class of|delegates|judges|members|friends|guests|faculty|staff|board)\b|(?:ladies and gentlemen|fellow (?:students|classmates|graduates|citizens|delegates|members|americans)|distinguished guests|honou?red guests|members of the (?:board|committee|class|jury|school board)|(?:madam|mister|mr\.?) (?:chair|speaker|president)))/i;
  const SPEECH_CLOSE = /\bthank you\b[^.!?]{0,40}[.!]?$|\b(?:vote for me|god bless)\b/i;
  const SPEECH_CUE = /\b(?:I stand (?:here|before you)|today,? I (?:want|would like|am here|'d like) to|I(?:'m| am) here (?:today )?to|let me (?:tell|ask|remind) you|imagine (?:a|if|for a moment|with me)|raise your hand|vote for me|please vote|my fellow|as your (?:president|representative|class president|treasurer|secretary)|ask yourselves?|look around (?:you|this room)|(?:each|all|many|some|most) of you|thank you (?:all )?for (?:listening|your (?:time|attention|support))|I ask you|together,? we)\b/gi;
  const BLOG_CUE = /\b(?:blog|this post|in the comments|subscribe|newsletter|my channel|this video|link (?:below|in my bio)|follow me)\b/i;
  function looksLikeSpeech(raw, lines) {
    if (BLOG_CUE.test(raw)) return false; // "Hi everyone! Welcome back to the blog." greets readers, not a room
    const open = lines.slice(0, 3).some((l) => SPEECH_OPEN.test(l));
    const close = lines.slice(-3).some((l) => SPEECH_CLOSE.test(l));
    const cues = (raw.match(SPEECH_CUE) ?? []).length;
    const words = raw.split(/\s+/).filter(Boolean).length;
    const you = (raw.match(/\byou(?:r|rs|rself|rselves|'re|'ll|'ve)?\b/gi) ?? []).length;
    return (open && (close || cues >= 1 || you / words >= 0.015)) || (close && cues >= 2) || cues >= 3;
  }
  /* A lab report: its sections — Hypothesis, Materials, Procedure, Data,
     Observations, Calculations, Sources of error — as headings or as
     "Hypothesis: …" lines. A paper's Abstract or Participants makes it a
     research paper instead (APA's Method has Materials and Procedure too). */
  const LAB_HEAD = /^(?:(?:\d+|[IVX]+)[.)]\s*)?(?:purpose|objective|aim|(?:research )?question|problem|hypothesis|background(?: information)?|materials(?: and methods| (?:and|&) equipment)?|equipment|apparatus|procedures?|methods?|methodology|variables|(?:independent|dependent|controlled|control) variables?|data(?: (?:and|&) observations| tables?| analysis)?|observations|results|calculations|analysis|discussion|error analysis|sources of error|conclusions?|references)\s*(?::|$)/i;
  const LAB_CORE = /^(?:(?:\d+|[IVX]+)[.)]\s*)?(hypothesis|materials|equipment|apparatus|procedures?|variables|independent|dependent|controlled|control|data|observations|calculations|error analysis|sources of error)\b/i;
  function looksLikeLab(lines) {
    if (lines.some((l) => /^(?:abstract|participants|literature review|related work)\s*:?$/i.test(l))) return false;
    const heads = lines.filter((l) => (l.length <= 40 || /^[^:]{2,40}:/.test(l)) && LAB_HEAD.test(l));
    const core = new Set(heads.map((h) => h.match(LAB_CORE)?.[1]?.toLowerCase()).filter(Boolean)).size;
    const titled = lines.slice(0, 4).some((l) => /\blab(?:oratory)?\b|\bexperiment\b/i.test(l) && l.split(/\s+/).length <= 12);
    return (core >= 2 && heads.length >= 3) || (titled && core >= 1 && heads.length >= 2);
  }
  /* A poem is lines, not paragraphs: hardly a line holds two sentences or
     runs to a paragraph's length, and its stanzas, its rhymes or its open
     line-ends say so. A list, notes or an outline are short-lined too —
     bullets, numbers, "Label:" lines and an outline's words rule them out. */
  const OUTLINE_WORD = /^(?:[IVX]{1,4}\.\s*|[A-H][.)]\s*|\d{1,2}[.)]\s*)?(?:introduction|intro|body(?: paragraph)?(?: \d)?|conclusion|thesis(?: statement)?|hook|claim|evidence|reasoning|counter ?argument|counterclaim|rebuttal|topic sentence|transition|background|main idea|supporting (?:detail|evidence))\b/i;
  const WEAK_RHYME = new Set(["ed", "ly", "es", "ng", "er", "al", "on", "ts", "ns", "rs", "ds", "st", "nt", "le", "ty", "ry", "re", "se", "ce", "te"]);
  function looksLikePoem(raw, lines) {
    let body = lines;
    if (body.length >= 5 && body[0].split(/\s+/).length <= 8 && !/[.!?,;:]$/.test(body[0])) body = body.slice(1); // a title
    if (body.length >= 5 && /^by\s+\S/i.test(body[0])) body = body.slice(1); // a byline
    const n = body.length;
    if (n < 4) return false;
    const share = (pred) => body.filter(pred).length / n;
    const avg = body.reduce((sum, l) => sum + l.split(/\s+/).length, 0) / n;
    if (share((l) => /^(?:[-•●○■▪◦*–>]|\(?\d{1,2}[.)]|[A-Za-z][.)]\s|[IVX]{1,4}\.\s)/.test(l)) > 0.3) return false; // a list
    if (share((l) => /[=≈≤≥]/.test(l) && /\d/.test(l)) > 0.2) return false; // worked math
    if (share((l) => /^[^:.!?]{2,30}:\s*\S/.test(l) || OUTLINE_WORD.test(l)) > 0.25) return false; // notes, an outline
    if (body.some((l) => RESEARCH_HEADING.test(l.replace(/[:.]$/, "")))) return false; // a paper's sections
    const groups = raw.split(/\n[ \t]*\n/).map((g) => g.split("\n").map((l) => l.trim()).filter(Boolean)).filter((g) => g.length);
    const stanzas = groups.filter((g) => g.length >= 2).length;
    // Long lines, but verse: every stanza two lines or more, and its lines run on
    // (a comma, a dash, no stop) into the next — prose breaks only at a paragraph.
    const inner = groups.flatMap((g) => g.slice(0, -1));
    if (stanzas >= 2 && stanzas === groups.length && inner.length >= 3
      && inner.filter((l) => !/[.!?]["”’)]?$/.test(l) && l.split(/\s+/).length >= 6).length / inner.length >= 0.6) return true;
    if (share((l) => /[.!?]["”’)]?\s+["“(]?[A-Z]/.test(l)) > 0.2 || avg > 14) return false; // paragraphs
    const end = (l) => (l.toLowerCase().match(/([a-z]+)[^a-z]*$/) ?? [])[1] ?? "";
    const rhymes = (a, b) => a.length >= 2 && b.length >= 2 && a !== b && (a.slice(-3) === b.slice(-3) || (a.slice(-2) === b.slice(-2) && !WEAK_RHYME.has(a.slice(-2))));
    const rhymed = share((l, i) => [body[i + 1], body[i + 2]].some((o) => o && rhymes(end(l), end(o))));
    const open = share((l) => !/[.!?]["”’)]?$/.test(l));
    return (stanzas >= 2 && open >= 0.3) || rhymed >= 0.3 || (open >= 0.6 && n >= 6) || (open >= 0.75 && avg <= 9); // a quatrain too
  }
  /* Notes or an outline: mostly bullets, numbered or lettered points,
     "Label: …" lines or an outline's own words, and mostly fragments. */
  function looksLikeNotes(lines) {
    const n = lines.length;
    if (n < 5) return false;
    const pointed = lines.filter((l) => /^(?:[-•●○■▪◦*–>]\s*|\(?\d{1,2}[.)]\s+|[a-hA-H][.)]\s+|[IVX]{1,4}\.\s+)/.test(l) || /^[^.!?:]{2,40}:(?:\s|$)/.test(l) || OUTLINE_WORD.test(l)).length;
    const fragments = lines.filter((l) => !/[.!?]["”’)]?$/.test(l) || l.split(/\s+/).length <= 6).length;
    return pointed / n >= 0.5 && fragments / n >= 0.5;
  }

  /* Research paper, literary essay, or essay. Owner, 2026-10-04: "does it have
     types of writing detection like research paper vs english essay with page
     number and stuff detection". All three keep every check and the same
     citation style; the type is shown in the panel ("Reading this as …") and
     changes what quoteCitationTips says. A research paper announces itself:
     an Abstract, or a methods/results-style section beside another heading —
     or, with no headings, a long reference list cited all through. A literary
     essay quotes a text and talks about how it works. Anything short of that
     is an essay — "prose", the default it always was. */
  const RESEARCH_HEADING = /^(?:abstract|introduction|background|literature review|related work|methods?|methodology|materials and methods|participants|procedure|data|results|findings|analysis|discussion|limitations|conclusions?|references|bibliography|works cited)$/i;
  const RESEARCH_CORE = /^(?:abstract|literature review|related work|methods?|methodology|materials and methods|participants|procedure|results|findings|discussion|limitations)$/i;
  const LITERARY_CUE = /\b(?:the (?:author|narrator|speaker|protagonist|antagonist|novel|novella|poem|play|playwright|story|reader)|symboli[sz]\w*|imagery|metaphor\w*|simile\w*|foreshadow\w*|irony|ironic\w*|motif\w*|characteri[sz]ation|soliloquy|stanza\w*|juxtapos\w*|personif\w*|allusion\w*)\b/gi;
  // An in-text citation of a work: (Lee, 2019), (Lee 2019, 45), (Lee 45).
  const WORK_CITE = /\([^()\n]*\b(?:1[5-9]|20)\d\d[a-z]?\b[^()\n]*\)|\([\p{Lu}][\p{L}'’-]+(?: (?:and|&) [\p{Lu}][\p{L}'’-]+| et al\.)? \d{1,4}(?:[-–]\d{1,4})?\)/gu;
  function essayKind(text, lines) {
    const heads = lines.map((l) => l.replace(/^(?:\d+|[IVX]+)[.)]?\s+/, "").replace(/[:.]$/, "").trim()).filter((l) => l.length <= 40 && RESEARCH_HEADING.test(l));
    const core = heads.filter((h) => RESEARCH_CORE.test(h));
    if (heads.some((h) => /^abstract$/i.test(h)) || (core.length >= 1 && heads.length >= 2)) return "research";
    const quotes = (String(text).match(/[“"][^”"\n]{8,600}[”"]/g) ?? []).length;
    const cues = (String(text).match(LITERARY_CUE) ?? []).length;
    if (quotes >= 2 && cues >= 3) return "literary";
    const wc = worksCitedBlock(String(text));
    const cites = (String(text).slice(0, wc ? wc.headStart : undefined).match(WORK_CITE) ?? []).length;
    return wc && wc.entries.length >= 4 && cites >= 8 ? "research" : "prose";
  }
  /* A news story: a dateline ("SPRINGFIELD, Ill. — "), a byline with
     attributions, or people quoted by name and role ("said Maya Chen, a
     junior") — and never a parenthetical citation. */
  const DATELINE = /^[A-Z][A-Z .'’-]{2,30}(?:,\s*[A-Z][A-Za-z.]+(?:\s[A-Z][A-Za-z.]+)?)?\s*(?:\([A-Z]{2,6}\)\s*)?[—–-]{1,2}\s*\S/;
  const BYLINE = /^[Bb][Yy]\s+[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}.'’-]*){0,3}(?:\s*[,|]\s*.{2,40})?$/u;
  const ATTRIBUTION = /\b(?:said|says|told|stated|explained|added|noted|announced|according to)\b/gi;
  const NEWS_SOURCE = /\b(?:officials?|spokes(?:person|man|woman)|police|department|mayor|principal|superintendent|chief|director|president|captain|coach|junior|senior|sophomore|freshman|organizers?|residents?|council|district|county|authorities)\b/i;
  function looksLikeNews(raw, lines) {
    if ((raw.match(WORK_CITE) ?? []).length) return false;
    if (lines.slice(0, 5).some((l) => DATELINE.test(l))) return true;
    const said = (raw.match(ATTRIBUTION) ?? []).length;
    // Sentences that attribute to an official, a department, a role: "…, city officials said."
    const attributed = raw.split(/(?<=[.!?]["”’)]?)\s+/).filter((x) => /\b(?:said|says|told|according to|announced|reported)\b/i.test(x) && NEWS_SOURCE.test(x)).length;
    const pronouns = (raw.match(/\b(?:he|she|they|I|we)\s+(?:said|asked|whispered|replied|shouted|yelled|muttered|answered)\b/g) ?? []).length;
    const firstPerson = (raw.replace(/["“][^"”]*["”]/g, " ").match(/\b(?:I|[Mm]y|[Mm]e|[Ww]e|[Oo]ur|[Uu]s)\b/g) ?? []).length;
    const when = /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|yesterday|this (?:week|morning|afternoon|evening)|last (?:week|night))\b/.test(raw);
    const headline = !/[.!?]["”’)]?$/.test(lines[0]) && lines[0].split(/\s+/).length <= 14;
    if (lines.slice(0, 4).some((l) => BYLINE.test(l)) && said >= 2 && attributed >= 1 && pronouns <= 1) return true;
    if (pronouns <= 1 && ((attributed >= 2 && firstPerson <= 1) || (attributed >= 1 && when && headline && firstPerson === 0))) return true;
    const named = (raw.match(/\b(?:said|says|according to)\s+(?:[A-Z][\p{L}'’-]+\s){0,2}[A-Z][\p{L}'’-]+,\s+(?:a|an|the)\s/gu) ?? []).length
      + (raw.match(/\b[A-Z][\p{L}'’-]+,\s+(?:a|an|the)\s+[^,.\n]{2,60},\s+(?:said|says|told)\b/gu) ?? []).length;
    const pronounSaid = (raw.match(/\b(?:he|she|they|I|we)\s+(?:said|asked|whispered|replied|shouted|yelled|muttered|answered)\b/g) ?? []).length;
    return named >= 2 && said >= 3 && pronounSaid <= named;
  }
  /* Fiction, or the writer's own story, by its voice: dialogue tagged "she
     said" and narration ("he turned", "she whispered") make a story; the
     first person looking back ("I learned", "taught me", "my grandmother")
     makes a personal essay. Either one with citations in it is an essay. */
  const SPEECH_VERB = "said|says|asked|asks|whispered|whispers|shouted|shouts|replied|replies|yelled|yells|muttered|mutters|called|calls|answered|answers|cried|cries|exclaimed|murmured|murmurs|snapped|snaps|laughed|laughs|sighed|sighs|added|adds|told|tells";
  const DIALOGUE = new RegExp(`["”]\\s*,?\\s*(?:[A-Za-z]+\\s){0,2}(?:${SPEECH_VERB})\\b|\\b(?:${SPEECH_VERB})\\s*,\\s*["“]`, "gi");
  const NARRATION = /\b(?:he|she|they|I) (?:walked|walks|looked|looks|turned|turns|smiled|smiles|laughed|whispered|ran|runs|stared|stares|glanced|glances|nodded|nods|shrugged|shrugs|frowned|frowns|wondered|opened|opens|closed|closes|stood|stands|sat|sits|grabbed|grabs|reached|reaches|pulled|pulls|pushed|pushes|noticed|notices|heard|hears|watched|watches|stepped|steps|waited|waits|sighed|froze|freezes|paused|pauses|hums|hands|scans|taps|washes|lets)\b/gi;
  const REFLECTION = /\b(?:I (?:learned|realized|realised|discovered|understood|have (?:always|never|learned|come to|grown)|now (?:know|understand|see|realize)|grew up|was (?:born|raised)|will never forget|remember)|taught me|(?:this|that) experience|looking back|in hindsight|growing up|ever since|shaped (?:me|who I am)|who I am(?: today)?|I want to (?:study|become|pursue|major)|my (?:passion|goal|dream)s?|my (?:mom|dad|mother|father|parents|grandma|grandmother|grandpa|grandfather|family|abuela|abuelo|sister|brother|coach|best friend))\b/gi;
  function narrativeKind(raw) {
    const words = raw.split(/\s+/).filter(Boolean).length;
    if (words < 80 || (raw.match(WORK_CITE) ?? []).length) return null;
    const dialogue = (raw.match(DIALOGUE) ?? []).length;
    const narration = (raw.match(NARRATION) ?? []).length;
    const reflection = (raw.match(REFLECTION) ?? []).length;
    const unquoted = raw.replace(/["“][^"”]*["”]/g, " ");
    const firstPerson = (unquoted.match(/\b(?:I|[Mm]y|[Mm]e|[Mm]ine|[Mm]yself)\b/g) ?? []).length / words;
    if (reflection >= 2 && firstPerson >= 0.025 && reflection >= dialogue / 2) return "personal";
    const spokenLines = raw.split("\n").filter((l) => /^\s*["“]/.test(l)).length / Math.max(1, raw.split("\n").filter((l) => l.trim()).length);
    if (dialogue >= 3 || (narration >= 4 && dialogue >= 1) || narration >= 6 || spokenLines >= 0.5) return "story";
    if (firstPerson >= 0.04 && reflection >= 1) return "personal";
    return null;
  }
  const GENRE_LABEL = {
    resume: "a resume", letter: "a letter", email: "an email", coverletter: "a cover letter", research: "a research paper",
    literary: "a literary essay", homework: "homework questions", dbq: "a DBQ", lab: "a lab report", speech: "a speech",
    news: "a news article", personal: "a personal essay", notes: "notes", annotated: "an annotated bibliography",
    poem: "a poem", story: "a story", script: "a script",
  };
  // The essay-like kinds: the citation notes, the essay review, the off-topic lines.
  const isArgumentGenre = (g) => g === "prose" || g === "research" || g === "literary" || g === "lab" || g === "dbq";
  // A reference list is part of the writing — Works Cited, References — and a claim can be sent to find a source.
  const genreWantsList = (g) => g === "prose" || g === "research" || g === "literary" || g === "lab";
  /* What a literary essay is about, which says how its quotes are cited: a
     poem by line, a play by act, scene and line, a novel or story by page. */
  function literaryForm(text) {
    const t = String(text ?? "");
    const n = (re) => (t.match(re) ?? []).length;
    const poem = n(/\b(?:poem|poet|poetry|stanzas?|speaker|verses?|rhyme[sd]?|sonnet|couplets?|quatrains?|enjambment|meter|iambic)\b/gi) + 2 * n(/\(\s*(?:[\p{L}'’-]+,?\s+)?lines?\s+\d/giu);
    const play = n(/\b(?:play|playwright|act [IVX\d]+|scene [ivx\d]+|soliloquy|monologue|stage directions?|dramatic irony|tragedy)\b/gi) + 2 * n(/\(\s*(?:[\p{L}.'’-]+\s+)?[IVX\d]+\.\d+\.\d+/gu);
    const prose = n(/\b(?:novel|novella|chapter|narrator|short story|memoir)\b/gi) + 2 * n(/\([\p{Lu}][\p{L}'’-]+ \d{1,4}\)/gu);
    const best = Math.max(poem, play, prose);
    return best === 0 || prose === best ? "prose" : poem === best ? "poem" : "play";
  }
  /* The citation style the document already uses, or null: its own in-text
     citations — (Lee, 2019) is APA, (Lee 45) MLA, (Lee 2019, 45) and
     footnote marks Chicago — and its list's heading. Tracely cites the way
     the writer already does unless they picked a style themselves
     (settings.styleChosen); with nothing to go on it is MLA (owner,
     2026-10-03). */
  function docCitationStyle(text) {
    const t = String(text ?? "");
    const wc = worksCitedBlock(t);
    const body = wc ? t.slice(0, wc.headStart) : t;
    const count = (re) => (body.match(re) ?? []).length;
    let apa = count(/\([^()\n]*\b[\p{Lu}][\p{L}'’-]+(?: et al\.)?(?: (?:&|and) [\p{Lu}][\p{L}'’-]+)?, (?:1[5-9]|20)\d\d[a-z]?(?:, (?:pp?\.|para\.) ?\d+(?:[-–]\d+)?)?\)/gu)
      + count(/\b[\p{Lu}][\p{L}'’-]+(?: et al\.)? \((?:1[5-9]|20)\d\d[a-z]?\)/gu);
    let mla = count(/\([\p{Lu}][\p{L}'’-]+(?: (?:and|&) [\p{Lu}][\p{L}'’-]+| et al\.)? (?!(?:1[5-9]|20)\d\d\b)\d{1,4}(?:[-–]\d{1,4})?\)/gu);
    let chicago = count(/\([\p{Lu}][\p{L}'’-]+(?: et al\.)? (?:1[5-9]|20)\d\d(?:, \d{1,4}(?:[-–]\d+)?)?\)/gu) + count(/[.!?,]["”’]?[¹²³⁴⁵⁶⁷⁸⁹]/g);
    const head = wc?.heading.toLowerCase();
    if (head === "works cited") mla += 3; else if (head === "references") apa += 3; else if (head === "bibliography") chicago += 3;
    const best = Math.max(apa, mla, chicago);
    if (best < 2) return null;
    const tops = [["apa", apa], ["mla", mla], ["chicago", chicago]].filter(([, k]) => k === best);
    return tops.length === 1 ? tops[0][0] : null;
  }

  /* A direct quotation cited without the page it came from. Every common style
     wants the page for a quote — MLA (Ghosh 23), APA (Ghosh, 2020, p. 23),
     Chicago (Ghosh 2020, 23) — and Tracely cannot know which page, so it asks.
     Only a quote followed by its own parenthetical is judged; a parenthetical
     with a page, paragraph, line or act.scene.line already has its locator. A
     source with no pages needs none: a quote whose author's Works Cited entry
     is a web address with no page range is left alone. Free and local. */
  // A closing number is a page unless it looks like a year (1500-2099): (Tolstoy 1204) is a page, (Smith 2019) is not.
  const LOCATOR = /\b(?:pp?|paras?|par|ch|chap|l{1,2}|lines?|sec|loc|n\.\s*pag)\.?\s*\d|(?:^|[\s,])(?:\d{1,3}|(?!1[5-9]\d\d\b|20\d\d\b)\d{4})(?:\s*[–-]\s*\d{1,4})?\s*$|\b\d+\.\d+(?:\.\d+)?\b|\bn\.\s*pag\b/i;
  function quoteCitationTips(text, style) {
    const raw = String(text ?? "");
    const wc = worksCitedBlock(raw);
    const out = [];
    let form = null;
    for (const m of raw.matchAll(/([“"])([^”"\n]{12,600})([”"])\s*\(([^()\n]{1,80})\)/g)) {
      const inner = m[4].trim();
      if (!/[A-Z]|\d/.test(inner) || LOCATOR.test(inner)) continue; // not a citation, or it has its page
      if (/^Doc(?:ument)?\.?\s*\d{1,2}$/i.test(inner)) continue; // a DBQ's document number: the assignment's own citation, no page
      const author = inner.match(/^([\p{Lu}][\p{L}'’-]+)/u)?.[1] ?? null;
      const year = inner.match(/\b(?:1[5-9]|20)\d{2}\b/)?.[0] ?? null;
      if (author && wc) {
        const entry = wc.entries.find((e) => e.toLowerCase().startsWith(author.toLowerCase()));
        if (entry && /https?:\/\/|\bwww\.|\.(?:com|org|net|gov|edu)\b/i.test(entry) && !/\bpp?\.\s*\d|\b\d+\s*[–-]\s*\d+\b/.test(entry)) continue; // a web page: no pages to cite
      }
      const who = author ?? "Author";
      const styleName = style === "apa" ? "APA" : style === "chicago" ? "Chicago" : "MLA";
      const quote = m[0].slice(-Math.min(m[0].length, 160));
      // A poem is cited by its lines and a play by act, scene and line — not by page.
      form ??= literaryForm(raw);
      if (form === "poem") {
        const ex = style === "apa" ? `(${who}, ${year ?? "1923"}, lines 5–8)` : style === "chicago" ? `(${who} ${year ?? "1923"}, lines 5–8)` : `(${who}, lines 5–8)`;
        out.push({ quote, kind: "page", label: "Add the line numbers", message: `A quoted line of a poem needs its line numbers — in ${styleName}, like ${ex}.` });
      } else if (form === "play") {
        const ex = style === "apa" ? `(${who}, ${year ?? "1603"}, 3.1.56–58)` : `(${who} 3.1.56–58)`;
        out.push({ quote, kind: "page", label: "Add act, scene and line", message: `A quote from a play needs its act, scene and line numbers — in ${styleName}, like ${ex}.` });
      } else {
        const example = style === "apa" ? `(${who}, ${year ?? "2020"}, p. 23)` : style === "chicago" ? `(${who} ${year ?? "2020"}, 23)` : `(${who} 23)`;
        out.push({ quote, kind: "page", message: `A direct quote needs the page it came from — in ${styleName}, like ${example}. If the source has no page numbers, leave it as it is.` });
      }
      if (out.length >= 6) break;
    }
    return out;
  }

  /* A fix that only negates its sentence is no fix. Owner, 2026-10-05: "The
     Mongols invented the American dollar" was "fixed" to "Furthermore, the
     Mongols did not invent the American dollar" — true, and still nothing to
     do with the essay. The check is told not to (its "revision" rule), and a
     fix that does it anyway is dropped here: the card keeps the correct fact
     and offers nothing to paste. A copy of factcheck.js isBareNegation. */
  const FIX_NEGATION = /\b(?:not|never|no|n['’]t)\b/i;
  const FIX_FILLER = /^(?:the|and|did|does|was|were|not|never|furthermore|however|also|that|this|but|have|has|had)$/;
  function bareNegation(original, rewrite) {
    if (!rewrite || !FIX_NEGATION.test(rewrite) || FIX_NEGATION.test(original ?? "")) return false;
    const words = (x) => (String(x).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !FIX_FILLER.test(w)).map((w) => w.replace(/(?:ed|es|s)$/, ""));
    const before = new Set(words(original));
    return words(rewrite).every((w) => before.has(w));
  }
  const usableRevision = (original, rewrite) => (bareNegation(original, rewrite) ? "" : rewrite);

  /* Citations that cannot lead a reader to a source. Owner, 2026-10-05, on a
     deliberately flawed essay whose revisions kept "[History.com / Gutenberg
     / accessed yesterday]", hedged with "Some researchers have argued … but
     the evidence requires verification", and said "The study does not need a
     publication date because Harvard is a famous institution". Each rule says
     what is missing and never supplies it — no date, author, title or page is
     ever filled in. Free and local; underlined on the passage (cite_tip). */
  const VAGUE_ATTRIBUTION = /\b(?:some|many|several|most|certain) (?:researchers|scholars|historians|experts|scientists|studies|sources|people)(?: (?:have|has))? (?:argued|argue|say|said|claim|claimed|believe|believed|suggest|suggested|found|shown|show|think)\b|\b(?:experts|studies|research|scientists|historians) (?:say|says|show|shows|agree|suggest|suggests)\b|\bit is (?:widely|generally|often) (?:believed|said|thought|accepted)\b/i;
  const VERIFY_NOTE = /\b(?:requires?|needs?|pending|awaiting) (?:further )?verification\b|\b(?:citation|source) needed\b|\bto be verified\b/i;
  const PRESTIGE_EXCUSE = /\b(?:does not|doesn't|do not|don't|did not|didn't) need (?:a |an |the |any )?(?:publication |publishing )?(?:date|author|citation|page(?: number)?|year|source)\b/i;
  const BAD_INLINE = /\[[^\]\n]{3,120}\/[^\]\n]{1,120}\]|\baccessed (?:yesterday|today|last (?:week|month|year)|recently)\b/i;
  /* "(Shiraishi)" at the end of a sentence reporting what someone argued or
     found: a surname (or two, or "et al."), no year, no page, and no entry
     in a reference list to say which work it is. Owner, 2026-10-08: the
     panel called it an "Unnamed source" — but it names a person; what it
     leaves out is the work. MLA allows a bare name for an unpaginated source
     WITH its Works Cited entry, so a matching entry means no note. An
     all-capitals parenthetical is an acronym — (NATO) — never a name. */
  const NAME_CITE_END = /\(([^()\n]{2,60})\)\s*[.!?]?["”’]?\s*$/;
  const BARE_NAME = /^[\p{Lu}][\p{L}'’-]+(?:\s+(?:and|&)\s+[\p{Lu}][\p{L}'’-]+|\s+et al\.)?$/u;
  const REPORTS = /\b(?:argue[sd]?|found|finds|show(?:s|n|ed)?|suggest(?:s|ed)?|claim(?:s|ed)?|state[sd]?|note[sd]?|wrote|writes?|report(?:s|ed)?|contend(?:s|ed)?|maintain(?:s|ed)?|according to)\b/i;
  function nameOnlyCitation(sentence, text) {
    const m = String(sentence ?? "").match(NAME_CITE_END);
    const inner = m ? m[1].trim() : "";
    if (!m || !BARE_NAME.test(inner) || /^[\p{Lu}\s&.]+$/u.test(inner) || CITED_NOT_A_WORK.test(`${inner} `) || !REPORTS.test(sentence)) return null;
    if (referenceEntryFor(inner, text)) return null;
    return { raw: `(${m[1]})`, inner, name: inner.split(/\s+(?:and|&)\s+|\s+et al\./)[0] };
  }
  function citationHygieneTips(text) {
    const out = [];
    const body = (() => { const wc = worksCitedBlock(String(text ?? "")); return wc ? String(text).slice(0, wc.headStart) : String(text ?? ""); })();
    // Sentences paragraph by paragraph, so an unnamed source the NEXT sentence
    // goes on to cite ("Studies show X. Smith (2019) found …") is left alone.
    const sentences = [];
    for (const para of body.split(/\n+/)) {
      const ss = para.split(/(?<=[.!?]["”’)\]]?)\s+/).map((x) => x.trim()).filter(Boolean);
      ss.forEach((x, i) => sentences.push({ s: x, next: ss[i + 1] ?? "" }));
    }
    for (const { s, next } of sentences) {
      if (s.length < 12) continue;
      const bracket = s.match(BAD_INLINE);
      if (bracket) out.push({ quote: bracket[0], kind: "badcite", message: "This cannot lead a reader to a source: name one source with its author, title and date (or n.d. if it truly has none), and cite it in your style. Do not guess missing details." });
      else if (PRESTIGE_EXCUSE.test(s)) out.push({ quote: s, kind: "excuse", message: "A source's reputation never excuses missing citation details. This line is a note to yourself, not part of your argument: delete it, and give the cited source's date (or n.d. if it truly has none)." });
      else if (VERIFY_NOTE.test(s)) out.push({ quote: s, kind: "placeholder", message: "A note to yourself is not support. Verify the claim and cite where you found it, or remove it." });
      else if (nameOnlyCitation(s, text)) {
        const { raw, name } = nameOnlyCitation(s, text);
        out.push({ quote: s, kind: "nameonly", message: `${raw} names a person, not which of their works you mean. Find the cited work lists what ${name} has published on this subject — cite the one that makes this point, with its year.` });
      }
      else if (VAGUE_ATTRIBUTION.test(s) && !hasCitationMark(s) && !hasCitationMark(next)) out.push({ quote: s, kind: "vague", message: "An unnamed source is not a citation: say which researchers or study, and cite it — or remove the claim." });
      if (out.length >= 8) break;
    }
    return out;
  }

  /* Resume format slips a rule can be RIGHT about, free and instant — the
     /api/review model call adds bullet quality and typos on top. Each rule
     names the minority, never the majority: the writer's own dominant style
     is the house style. At most six, every quote verbatim from the text. */
  const US_STATES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"];
  const STATE_ABBR = /^(?:A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[DLNA]|K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY])$/;
  function resumeFormatIssues(text) {
    const raw = String(text ?? "");
    const out = [];
    const add = (quote, message) => { if (out.length < 6 && quote && !out.some((o) => o.quote === quote)) out.push({ quote, kind: "format", message }); };
    // 1. An email address with no domain ending.
    for (const m of raw.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*/g)) {
      if (!/@[\w-]+\.[\w-]{2,}/.test(m[0])) add(m[0], "This email address has no domain ending (like .com), so a reply to it would bounce.");
    }
    // 2. Date ranges written in more than one style, or with different dash spacing.
    const ranges = [...raw.matchAll(DATE_RANGE)].map((m) => m[0]);
    const style = (r) => /\d{1,2},\s*\d{4}/.test(r) ? "day" : /^\d{4}/.test(r) ? "year" : "month";
    const spacing = (r) => (/\s[–—-]\s/.test(r) ? "spaced" : /[–—-]\s|\s[–—-]/.test(r) ? "lopsided" : "tight");
    const tally = (f) => ranges.reduce((m, r) => m.set(f(r), (m.get(f(r)) ?? 0) + 1), new Map());
    const major = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (ranges.length >= 2) {
      const styles = tally(style), sp = tally(spacing);
      const mainStyle = major(styles), mainSp = major(sp);
      for (const r of ranges) {
        if (styles.size > 1 && style(r) !== mainStyle) add(r, mainStyle === "month" ? "Your other dates are month and year (\"June 2026 – August 2026\"); this one is written differently." : "This date is written in a different style from your others.");
        else if (sp.size > 1 && spacing(r) !== mainSp) add(r, "The spacing around this dash differs from your other dates.");
      }
    }
    // 3. Locations that mix state abbreviations and full names.
    const locs = raw.split("\n").map((l) => l.trim()).map((l) => [l, l.match(/^[A-Z][\w .'-]+,\s*([A-Za-z ]+)$/)?.[1]?.trim()]).filter(([, s]) => s && (STATE_ABBR.test(s) || US_STATES.includes(s)));
    const abbr = locs.filter(([, s]) => STATE_ABBR.test(s)), full = locs.filter(([, s]) => !STATE_ABBR.test(s));
    if (abbr.length && full.length) {
      const minority = abbr.length < full.length ? abbr : full;
      const msg = abbr.length === full.length
        ? `Your locations mix abbreviated states (${abbr[0][1]}) and spelled-out ones (${full[0][1]}); pick one style.`
        : abbr.length < full.length ? "Most of your locations spell the state out; this one abbreviates it." : "Most of your locations abbreviate the state; this one spells it out.";
      for (const [line] of minority) add(line, msg);
    }
    // 4. Bullets marked in some places and not others, and stray leading spaces.
    const bulletish = raw.split("\n").filter((l) => l.trim().split(/\s+/).length >= 8);
    const marked = bulletish.filter((l) => /^\s*[•▪◦*·-]\s/.test(l)), plain = bulletish.filter((l) => !/^\s*[•▪◦*·-]\s/.test(l));
    if (marked.length && plain.length && marked.length < plain.length) {
      for (const l of marked.slice(0, 2)) add(l.trim(), "Only some of your bullets start with a marker; use one for all of them, or none.");
    }
    for (const l of plain) if (/^ +\S/.test(l)) add(l.trim(), "This line starts with a stray space, so it won't line up with the lines around it.");
    return out;
  }

  // An id the server left out of its answer stays uncached and would be re-sent
  // on every read; hold it this long first, so a faster loop cannot become a
  // faster bill.
  const OMITTED_HOLD_MS = 30_000;
  function holdOmitted(held, sent, findings, now) {
    const got = new Set((findings ?? []).map((f) => f.id));
    for (const s of sent) if (!got.has(s.hash)) held.set(s.hash, now + OMITTED_HOLD_MS);
  }
  function isHeld(held, hash, now) {
    const until = held.get(hash);
    if (until === undefined) return false;
    if (now >= until) { held.delete(hash); return false; }
    return true;
  }

  /* A line or sentence that has nothing to do with the rest of the document.
     Owner, 2026-10-04, on a Model UN position paper about youth and peace
     with "Lamine Yamal is 19 years old" typed between the last paragraph and
     the references: "if I type something that is completely irrelevant or
     unrelated flag it."

     Free and local, no model call: a LINE (a paragraph, or a sentence typed
     on a line of its own) is off topic when NONE of its meaningful words
     appears anywhere else in the body. Real prose about one
     subject keeps reusing its words (youth, peace, nation…), so a line that
     shares not one with the whole essay stands out. Lines, not sentences:
     measured on the eval essays, single sentences inside a paragraph share
     nothing with the rest far too often to flag ("Days later he addressed a
     joint session of Congress.") — telling one of those apart from a stray
     sentence needs a reader, not a word count. Words are compared by
     their first five letters, so "peace"/"peacemaking" and "solution"/
     "solutions" count as the same word; that can only make a flag rarer.

     Left out on purpose: the reference list (worksCitedBlock), bracketed
     citations, header lines like "Country: United Kingdom", lines under four
     words (titles, headings), generic words ("years", "people", "important")
     that would tie anything to anything, and documents too short to have a
     subject (under 150 words or 4 paragraphs). Essays and papers only. */
  const OFF_TOPIC_MIN_WORDS = 150;
  const OFF_TOPIC_MIN_PARAGRAPHS = 4;
  const OFF_TOPIC_STOP = new Set(("a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each even ever every few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just let like may me might more most must my myself no nor not now of off on once only or other ought our ours ourselves out over own same shall she should so some such than that the their theirs them themselves then there these they this those through to too under until up upon us very was we were what when where which while who whom why will with within without would yet you your yours yourself " +
    "however therefore thus although though whereas moreover furthermore indeed fact also still already instead rather quite really often always never sometimes usually perhaps maybe " +
    "year years old new time times day days people person way ways thing things lot lots many much one two three first second last next good great big small important different same certain several various " +
    "make makes made making get gets got take takes took give gives gave go goes went come came say says said see seen know known think thought use used want need needs show shows").split(" "));
  function topicKeys(sentence) {
    const words = String(sentence).replace(/\([^()]*\)|\[[^\]]*\]/g, " ").toLowerCase().match(/[a-z][a-z'’-]*[a-z]/g) || [];
    const keys = new Set();
    for (let w of words) {
      w = w.replace(/['’]s$/, "");
      if (w.length < 3 || OFF_TOPIC_STOP.has(w)) continue;
      keys.add(w.length > 5 ? w.slice(0, 5) : w.replace(/(?:ies|es|s)$/, (m) => (w.length - m.length >= 3 ? "" : m)));
    }
    return keys;
  }
  function offTopicSentences(text) {
    const refs = worksCitedBlock(text);
    const body = refs ? text.slice(0, refs.headStart) : text;
    const units = [];
    let started = false; // titles and header lines come before the first full sentence
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line || /^[A-Z][\w &()/.'’-]{0,40}:\s*\S/.test(line) && line.split(/\s+/).length <= 12) continue; // "Country: United Kingdom"
      if (!started) { started = /[.!?]["”’)]?$/.test(line); if (!started) continue; }
      if (line.split(/\s+/).length < 4) continue; // a heading
      // "That is the part people point at." points back at the paragraph before it.
      const refersBack = /^["“]?(?:this|that|these|those|it|its|he|she|they|his|her|their|such|here|there)\b/i.test(line);
      units.push({ text: line, keys: topicKeys(line), refersBack });
    }
    const words = body.split(/\s+/).filter(Boolean).length;
    if (units.length < OFF_TOPIC_MIN_PARAGRAPHS || words < OFF_TOPIC_MIN_WORDS) return [];
    const seenIn = new Map(); // key → how many paragraphs use it
    for (const u of units) for (const k of u.keys) seenIn.set(k, (seenIn.get(k) ?? 0) + 1);
    return units
      .filter((u) => !u.refersBack && u.keys.size >= 2 && [...u.keys].every((k) => seenIn.get(k) === 1))
      .map((u) => u.text);
  }

  /* The reference list, checked against itself and against the text. Owner,
     2026-10-04, after a position paper listed Ord & Davies (2022) twice and
     a Samoa country profile nothing in the paper cited. Free and local.

     - Listed twice: two entries equal once case, spacing and punctuation are
       ignored, or two entries carrying the same DOI or link. The LATER copy
       is the one flagged — it is the one to delete.
     - Not cited: no in-text citation points at the entry. A citation is a
       parenthetical — (Ord & Davies, 2022), (Shoup 45), ("Youth Matters",
       2025), several split by ";" — or a narrative "Wheaton and Ferro
       (2016)". A name citation matches an entry carrying its first author's
       surname; a quoted-title citation one carrying most (60%) of its
       words. Either way a year, when both sides give one, must agree — which
       is what keeps ("United Nations: UN Meetings Coverage", 2025) from
       counting as a citation of "United Nations. (2023). SDG Country
       Profile Samoa". An entry led by a personal name ("Fitzgerald, F.
       Scott.") also counts as cited when that surname appears anywhere in
       the text: MLA attributes in prose ("Fitzgerald writes …") and cites
       only the page.
     The uncited check is skipped for numbered and footnoted work ([1], ¹,
     "1." entries), where the link is a number this does not trace. */
  const REF_STOP = new Set("the and for from with that this into over under about how why what when are was were its their our your his her a an of in on to by at as or is be not".split(" "));
  const refNorm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const refWords = (s) => (refNorm(s).match(/\p{L}{3,}/gu) || []).filter((w) => !REF_STOP.has(w));
  const REF_YEAR = /\b(1[5-9]\d\d|20\d\d)\b/;
  function inTextCitations(body) {
    const cites = [];
    for (const m of body.matchAll(/\(([^()]{2,240})\)/g)) {
      for (const part of m[1].split(";")) {
        const p = part.trim();
        const year = (p.match(REF_YEAR) || [])[1] ?? null;
        const quoted = p.match(/["“‘']([^"”’']{3,})["”’']/);
        if (quoted) { cites.push({ title: refWords(quoted[1]), year }); continue; }
        const names = p.replace(/\bet al\.?/g, "").split(/,|\s(?:&|and)\s|\d/)[0].trim();
        const surname = (names.match(/([\p{Lu}][\p{L}'’-]+)\s*$/u) || [])[1];
        if (surname && (year || /\d/.test(p))) cites.push({ surname: surname.toLowerCase(), year });
      }
    }
    for (const m of body.matchAll(/\b([\p{Lu}][\p{L}'’-]+)(?:\s+(?:and|&)\s+[\p{Lu}][\p{L}'’-]+|\s+et al\.?)?\s+\((1[5-9]\d\d|20\d\d)/gu)) {
      cites.push({ surname: m[1].toLowerCase(), year: m[2] });
    }
    return cites;
  }
  function referenceListIssues(text) {
    const refs = worksCitedBlock(text);
    if (!refs || refs.entries.length < 2) return [];
    const body = text.slice(0, refs.headStart);
    const out = [];
    const seenText = new Set(), seenLink = new Set();
    for (const entry of refs.entries) {
      const key = refNorm(entry);
      // A DOI is the same source however it is written (doi:…, https://doi.org/…); other links by address.
      const trim = (l) => l.toLowerCase().replace(/[.,;)]+$/, "");
      const dois = (entry.match(/\b10\.\d{4,}\/[^\s"<>]+/g) || []).map(trim);
      const urls = (entry.match(/https?:\/\/\S+/gi) || []).filter((u) => !/doi\.org\//i.test(u)).map((u) => trim(u).replace(/^https?:\/\/(www\.)?/, ""));
      const links = [...dois, ...urls];
      if (seenText.has(key) || links.some((l) => seenLink.has(l))) out.push({ quote: entry, kind: "refdup" });
      seenText.add(key);
      for (const l of links) seenLink.add(l);
    }
    // An entry that cannot be found from what it says. Named, never filled in.
    for (const entry of refs.entries) {
      if (out.some((o) => o.quote === entry)) continue;
      const missing = [];
      if (/\baccessed (?:yesterday|today|last (?:week|month|year)|recently)\b/i.test(entry)) missing.push("a real access date, not a relative one");
      if (/\bpages? (?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty|forty|fifty|hundred)\b/i.test(entry)) missing.push("the page as a number");
      if (/\b(?:website|site|article|page|book|study|video|document) (?:about|on|regarding)\b/i.test(entry)) missing.push("the source's actual title");
      if (missing.length) out.push({ quote: entry, kind: "refincomplete", missing });
    }
    const numbered = /\[\d+\]|[¹²³⁴⁵⁶⁷⁸⁹]/.test(body) || refs.entries.filter((e) => /^\[?\d+[.)\]]/.test(e)).length >= refs.entries.length / 2;
    if (numbered) return out;
    const cites = inTextCitations(body);
    const flagged = new Set(out.map((o) => o.quote));
    for (const entry of refs.entries) {
      if (flagged.has(entry)) continue; // a duplicate's note already says what to do
      const words = new Set(refWords(entry));
      const years = new Set(entry.match(new RegExp(REF_YEAR.source, "g")) || []);
      const yearOk = (y) => !y || years.size === 0 || years.has(y);
      const cited = cites.some((c) => yearOk(c.year) && (c.surname
        ? words.has(c.surname)
        : c.title.length >= 1 && c.title.filter((w) => words.has(w)).length >= Math.max(1, Math.ceil(c.title.length * 0.6))));
      const lead = (entry.match(/^([\p{Lu}][\p{L}'’-]+),\s+[\p{Lu}]/u) || [])[1];
      const named = lead && new RegExp(`\\b${lead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "u").test(body);
      if (!cited && !named && !out.some((o) => o.quote === entry)) out.push({ quote: entry, kind: "refuncited" });
    }
    return out;
  }

  /* Only sources that BACK the sentence are offered. Owner, 2026-10-04:
     "Find sources" handed him Ord & Davies (2022) — a paper on youth work
     and austerity cuts — for a sentence about youth leadership gaining
     support but not action, which it never says. "From now on dont
     recommend me sources that do not align." A search result is kept when
     its stance is "supports"; "refutes" too when the sentence is flagged
     wrong (those back the correction, and show why); "context" — on the
     topic, but not saying this — is dropped and only counted, so the card
     can say the search found reading on the subject and none of it backs
     the sentence as written. A source with no stance is one the writer
     pasted themselves, and is theirs to keep (so is /api/cite-url's
     "manual" one, which a reload used to drop).
     Receipts (2.21.25, server of 2026-10-07): a server that read a source
     says so — `verified`, and for a backing source the `quote` from its own
     text and where it read it (`readFrom`). A source it could NOT read
     (`verified: false`) is never backing, whatever its stance: it goes to
     `unread`, shown collapsed with Open only — never Cite or Copy cite. An
     older server sends no `verified`, and its sources behave as before. */
  function backingSources(list, verdict) {
    const all = Array.isArray(list) ? list : [];
    const unread = all.filter((s) => s && s.verified === false);
    const keep = all.filter((s) => s && s.verified !== false && (s.stance === undefined || s.stance === "manual" || s.stance === "supports" ||
      (s.stance === "refutes" && (verdict === "false" || verdict === "incoherent"))));
    return { list: keep, unbacked: all.length - keep.length - unread.length, unread };
  }
  const UNBACKED_NOTE = (n) => `The search found ${n} source${n === 1 ? "" : "s"} on this topic, but none says what this sentence says. Reword it to match what you can cite, or search again.`;
  const RECEIPT_COPY = {
    says: "The source says:",
    from: { abstract: "from the abstract", page: "from the page" },
    unread: "Couldn't read these — check them yourself",
    unreadOnly: (n) => `The search found ${n} source${n === 1 ? "" : "s"}, but Tracely couldn't open ${n === 1 ? "it" : "them"} to check what ${n === 1 ? "it says" : "they say"}. Read ${n === 1 ? "it" : "them"} yourself before citing, or search again.`,
    open: "Open ↗",
  };
  /* What a source shows under its title: the receipt — "The source says:
     “…”" and where it was read — when the server read it, else the
     search's snippet, as before. */
  function sourceSaysHtml(src) {
    if (src?.quote) {
      const from = RECEIPT_COPY.from[src.readFrom];
      return `<div class="src-says">${esc(RECEIPT_COPY.says)} “${esc(src.quote)}”</div>${from ? `<div class="src-from">${esc(from)}</div>` : ""}`;
    }
    return src?.snippet ? `<div class="src-snip">${esc(src.snippet)}</div>` : "";
  }
  /* The sources the server could not read, collapsed under one toggle (the
     panel re-renders every few seconds, so the open state lives in the
     sources entry, `unreadOpen`). Open only — nobody is told to cite a
     source nothing read. */
  function unreadSourcesHtml(hash, unread, open) {
    const list = Array.isArray(unread) ? unread.filter(Boolean) : [];
    if (!list.length) return "";
    const rows = open ? list.map((src) => `
        <div class="src src-unread-row">
          <div class="src-body">
            <span class="src-title">${esc(src.title || src.url)}</span>
            <div class="src-meta">${esc(src.publisher || "")}</div>
            <div class="src-actions"><a class="src-open" href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(RECEIPT_COPY.open)}</a></div>
          </div>
        </div>`).join("") : "";
    return `<div class="src-unread"><button class="src-unread-toggle" data-unread-toggle="${esc(hash)}" aria-expanded="${open ? "true" : "false"}">${open ? "▾" : "▸"} ${esc(RECEIPT_COPY.unread)} (${list.length})</button>${rows}</div>`;
  }

  /* Sentences a citation LATER in the same paragraph covers: writers state an
     idea across a sentence or two and cite once at the close. The desktop's
     citationScope.ts reads the paragraph the same way ("Forward,
     unconditionally"). Paragraph = no line break between two sentences. */
  function coveredByLaterCitation(text, segs) {
    const covered = new Set();
    let citedAhead = false;
    for (let i = segs.length - 1; i >= 0; i--) {
      const next = segs[i + 1];
      if (next && /\n/.test(String(text).slice(segs[i].end, next.start))) citedAhead = false; // a new paragraph starts after this one
      if (citedAhead) covered.add(segs[i].hash);
      if (hasCitationMark(segs[i].text)) citedAhead = true;
    }
    return covered;
  }

  /* Hover intent for the Docs card. Owner, 2026-10-06: "it jumps too much
     when there are underlines everywhere". Two causes. A card opened the
     instant the pointer crossed ANY underline, so moving the mouse across a
     marked page flashed card after card. And the way from a sentence down to
     its card crosses the lines in between, each of which swapped the card
     before the pointer could reach a button. Now:
     - a card opens once the pointer has stayed on an underline for
       HOVER_OPEN_MS, so a pass across the page opens nothing;
     - the safe triangle (Amazon's menu-aim): from where the pointer last was
       on the open card's sentence to the near edge of the card, whatever it
       crosses is ignored. Stopping on another underline in there for
       HOVER_REST_MS still opens that one, so nothing becomes unreachable;
     - outside the triangle, another underline takes over after HOVER_SWAP_MS,
       and empty page closes the card after HOVER_HIDE_MS.
     s: { open, popHash, onCard, onOwn, inTri, under } → { act, hash?, ms?, rest? },
     act one of "none" | "stay" | "open" | "swap" | "hide". */
  /* Snappy, the way Grammarly's card is (owner, 2026-10-09: "the cursor
     detection hover system is bad. make it as snappy and just like grammarly
     … when I stop hovering over underline, sometimes it stays"). 2.21.34 held
     the card outright while the pointer got closer to it (`approaching`) or
     sat in the triangle, and needed the pointer to STOP on another underline
     before it took over. Holding was the sticky part: a decision only ever
     ran on a mouse move, so a pointer that stopped while held left the card
     up for good — reproduced on a Docs stand-in: off the underline, beside
     the card, still open 5 s later. Now every state but "on the card or on
     its own underline" ends in a timer, so a still pointer always resolves;
     and the card opens UNDER THE POINTER (popAnchorDx), so the way to it is
     straight down and crosses no other line:
     - a card opens once the pointer has been on an underline HOVER_OPEN_MS;
     - another underline takes over after HOVER_SWAP_MS on it; empty page
       closes the card after HOVER_HIDE_MS;
     - in the triangle, on the way to the card, nothing changes while the
       pointer moves; once it rests there HOVER_REST_MS, the underline under
       it opens, or over empty page the card closes. */
  const HOVER_OPEN_MS = 70, HOVER_SWAP_MS = 90, HOVER_REST_MS = 220, HOVER_HIDE_MS = 140;
  function hoverIntent(s) {
    if (!s.open) return s.under ? { act: "open", hash: s.under, ms: HOVER_OPEN_MS } : { act: "none" };
    if (s.onCard || s.onOwn) return { act: "stay" };
    const other = s.under && s.under !== s.popHash ? s.under : null;
    if (s.inTri) return other ? { act: "swap", hash: other, ms: HOVER_REST_MS, rest: true } : { act: "hide", ms: HOVER_REST_MS, rest: true };
    if (other) return { act: "swap", hash: other, ms: HOVER_SWAP_MS };
    return { act: "hide", ms: HOVER_HIDE_MS };
  }
  /* Is (x, y) on the way from `apex` to the card? The region is the convex
     hull of a short segment around the apex (2·slack wide, so the first pixel
     of a move is never outside a needle-thin tip) and the whole card, widened
     by `slack` — Floating UI's safePolygon reaches the card's FAR corners for
     the same reason: a card sits ~10px under its line, so a pointer coming
     from the end of a long line reaches the card's side, not its top edge. */
  function inSafeTriangle(apex, card, x, y, slack = 6) {
    if (!apex || !card) return false;
    const pts = [
      [apex.x - slack, apex.y], [apex.x + slack, apex.y],
      [card.left - slack, card.top - slack], [card.right + slack, card.top - slack],
      [card.right + slack, card.bottom + slack], [card.left - slack, card.bottom + slack],
    ].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (list) => {
      const h = [];
      for (const p of list) {
        while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
        h.push(p);
      }
      h.pop();
      return h;
    };
    const hull = [...half(pts), ...half([...pts].reverse())];
    for (let i = 0; i < hull.length; i++) {
      if (cross(hull[i], hull[(i + 1) % hull.length], [x, y]) < 0) return false;
    }
    return true;
  }
  /* Does a mark draw itself in, or is it one the reader already saw? Marks are
     rebuilt on every re-match (scroll, typing, a new verdict), so animating
     every draw would make them pulse — the flicker fixed in 2.21.16. Only a
     mark that is new on the page animates: its sentence was not drawn last
     time, and nothing of the same colour sat on that spot recently (typing
     in a flagged sentence changes its hash, not its place). `recent`:
     [{ hash, color, x0, x1, y }] in document coordinates. */
  function isFreshMark(recent, m) {
    for (const r of recent) {
      if (r.hash === m.hash) return false;
      if (r.color === m.color && Math.abs(r.y - m.y) <= 6 && r.x0 < m.x1 && m.x0 < r.x1) return false;
    }
    return true;
  }
  const MARK_IN_MS = 260, MARK_OUT_MS = 180, MARK_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
  /* A new underline draws itself in from the left, like a pen stroke.
     Chromium freezes animations on a page that is not painting, and this one
     holds the mark invisible until it runs — so a timer cancels it, and the
     worst case is a mark that simply appears (the overlay's entrance-fade
     lesson, CLAUDE.md "Invisibility"). */
  function drawMarkIn(el, delay) {
    if (typeof el.animate !== "function" || markReducedMotion()) return;
    try {
      const anim = el.animate(
        [{ opacity: 0, clipPath: "inset(0 100% 0 0)" }, { opacity: 1, clipPath: "inset(0 0% 0 0)" }],
        { duration: MARK_IN_MS, delay, easing: MARK_EASE, fill: "backwards" },
      );
      setTimeout(() => { if (anim.playState !== "finished") anim.cancel(); }, delay + MARK_IN_MS + 300);
    } catch { /* no animation: it simply appears */ }
  }

  /* ── "Find the cited work" (2.21.24) ──────────────────────────────────
     Owner, 2026-10-06: "it says if a citation is invalid, but it doesnt find
     citation for me … it doesnt go find the publication date for me". A card
     that says a citation is the problem now looks the cited work up —
     /api/compare-source: Crossref and Open Library, scored lexically, no
     model — and offers the record's own in-text marker in place of the one
     that could not be traced. These are its pure halves: which citation a
     card is about, what is sent, which reference entry it points at, and the
     sentence with the citation swapped. Nothing here supplies a field: every
     author, title, year and venue shown or inserted is the record's, and a
     resolved record is the work the writer CITED — never evidence that the
     sentence is true. */
  // A parenthetical that names a position, not a work: (Figure 3), (Doc 4) —
  // a DBQ's own document number — (Table 2), (Chapter 4).
  const CITED_NOT_A_WORK = /^(?:fig(?:ure)?|table|chapter|ch|section|sec|appendix|page|part|doc(?:ument)?|exhibit|step|phase|grade|level|vol(?:ume)?|item|line|lines|act|scene|verse|para(?:graph)?)\.?\s/i;
  /* The work citations in one sentence, in order: each part of a
     parenthetical that starts with a name or a quoted title and carries a
     year, n.d. or a page — (Ghosh, 2025), ("Youth Matters", 2025), (Shoup 45),
     (Genghis Khan and the, 2022). `shared`: the parenthetical holds more than
     one work, so swapping it would take the others with it. A [3] or a
     footnote mark is not one: it names a position in a list, not a work. */
  function inTextCitationsOf(sentence) {
    const out = [];
    for (const m of String(sentence ?? "").matchAll(/\(([^()\n]{2,240})\)/g)) {
      const parts = m[1].split(";").map((p) => p.trim()).filter(Boolean);
      const works = parts.filter((p) => !CITED_NOT_A_WORK.test(`${p} `) && /^[\p{Lu}"“‘']/u.test(p) && /\p{L}{2,}/u.test(p)
        && (/\d/.test(p) || /\bn\.\s?d\./i.test(p) || /^["“‘'][^"”’']{3,}["”’']/.test(p)));
      for (const inner of works) out.push({ raw: m[0], inner, start: m.index, end: m.index + m[0].length, shared: parts.length > 1 });
    }
    return out;
  }
  // The citation a card about this sentence means: its only work citation.
  // null for none, or for several — which one the card is about would then
  // be a guess, and a guess here rewrites the half the writer did not mean.
  function lookupableCitation(sentence) {
    const all = inTextCitationsOf(sentence);
    return all.length === 1 && !all[0].shared ? all[0] : null;
  }
  // A verdict that puts a cited sentence in doubt puts its citation in doubt.
  const CITED_VERDICTS = ["false", "questionable", "incoherent"];
  function flaggedCitationOf(verdict, sentence) {
    return CITED_VERDICTS.includes(verdict) ? lookupableCitation(sentence) : null;
  }
  /* What is sent: the citation's (or entry's) words without what a lookup
     cannot use — a link, a DOI, an access note, a bare site name, a volume or
     page number. `thin` when fewer than two words are left beside a year:
     "(Khan, 2022)" alone matches any Khan who published in any year, and a
     match like that must never be offered as the work the writer meant. */
  function citedRefQuery(text) {
    const query = String(text ?? "")
      .replace(/https?:\/\/\S+|\bwww\.\S+|\bdoi:\s*\S+|\b10\.\d{4,}\/\S+/gi, " ")
      .replace(/\b(?:retrieved|accessed)\b[^.;\]]*/gi, " ")
      .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|edu|gov|io|co|uk|info)\b/gi, " ")
      .replace(/\b(?:vol|nos?|pp?|eds?|para|ch)\.\s*/gi, " ")
      .replace(/\b(?!(?:1[5-9]|20)\d\d[a-z]?\b)\d+[a-z]?(?:\s*[-–]\s*\d+)?\b/gi, " ")
      .replace(/[[\]()/|:]+/g, " ")
      .replace(/\s+([,.;])/g, "$1").replace(/([,.;])(?:\s*[,.;])+/g, "$1").replace(/\s+/g, " ")
      .replace(/^[\s,.;]+|[\s,;]+$/g, "")
      .slice(0, 400);
    const words = refWords(query.replace(/\b(?:1[5-9]|20)\d\d[a-z]?\b|\bn\.\s?d\./gi, " "));
    return { query, thin: words.length < 2 };
  }
  // The year a citation or entry gives, "n.d." for an explicit no-date, else null.
  function citedYearOf(text) {
    const t = String(text ?? "");
    const y = t.match(/\b(1[5-9]\d\d|20\d\d)[a-z]?\b/);
    return y ? y[1] : /\bn\.\s?d\./i.test(t) ? "n.d." : null;
  }
  /* The reference entry an in-text citation points at, by the same reading
     referenceListIssues uses: the name (or quoted title) words before the
     year, most of them in one entry. A year that agrees picks between two
     such entries; one that disagrees does not rule an entry out, because a
     wrong year is exactly what this is for. null for no list, no entry, or a
     tie — sending the wrong entry would look up the wrong work. */
  function referenceEntryFor(inner, text) {
    const wc = worksCitedBlock(String(text ?? ""));
    if (!wc || !wc.entries.length) return null;
    const p = String(inner ?? "");
    const year = (p.match(REF_YEAR) || [])[1] ?? null;
    const quoted = p.match(/["“‘']([^"”’']{3,})["”’']/);
    const words = refWords(quoted ? quoted[1] : p.replace(/\bet al\.?/gi, " ").split(/,|\d/)[0]);
    if (!words.length) return null;
    const scored = [];
    for (const e of wc.entries) {
      const have = new Set(refWords(e));
      const frac = words.filter((w) => have.has(w)).length / words.length;
      if (frac < 0.6) continue;
      const years = e.match(/\b(?:1[5-9]\d\d|20\d\d)\b/g) || [];
      scored.push({ e, frac, yearOk: !year || years.length === 0 || years.includes(year) });
    }
    const agree = scored.filter((s) => s.yearOk);
    const pool = agree.length ? agree : scored;
    if (!pool.length) return null;
    const best = Math.max(...pool.map((s) => s.frac));
    const top = [...new Set(pool.filter((s) => s.frac === best).map((s) => s.e))];
    return top.length === 1 ? top[0] : null;
  }
  // How many times the body (the text above its reference list) carries a citation.
  function citationUses(text, raw) {
    const t = String(text ?? ""), r = String(raw ?? "");
    if (!r) return 0;
    const wc = worksCitedBlock(t);
    const body = wc ? t.slice(0, wc.headStart) : t;
    let n = 0;
    for (let i = body.indexOf(r); i >= 0; i = body.indexOf(r, i + r.length)) n++;
    return n;
  }
  /* A citation that names only a person — "(Shiraishi)", "(Khan, 2022)",
     "(Lee 45)" — names no work, and no lookup can say which one it meant.
     Owner, 2026-10-08, on "(Shiraishi)" in a Mongol Empire essay: what can
     still be said is whether that person has published on the essay's
     subject, and what (the server's authorWorks). `author` is the family
     name; `topic` the essay's subject — its most repeated words; `claimTerms`
     the sentence's own rarer words, which a title about THIS claim would
     share ("literacy", where "empire" is the whole essay's). */
  const NAME_ONLY = /^([\p{Lu}][\p{L}'’-]+)(?:\s+(?:and|&)\s+[\p{Lu}][\p{L}'’-]+|\s+et al\.)?(?:,?\s*(?:(?:1[5-9]|20)\d\d[a-z]?|n\.\s?d\.))?(?:,?\s*(?:pp?\.\s*)?\d{1,4}(?:\s*[-–]\s*\d{1,4})?)?$/u;
  const citedAuthorOnly = (inner) => String(inner ?? "").trim().match(NAME_ONLY)?.[1] ?? null;
  const GENERIC_WORDS = new Set("researchers scholars historians experts scientists studies study research argued argue argues claim claimed claims suggest suggested suggests found shown show shows think believe believed some many several most parts part extent remains remain uncertain however although because which while whether there these those other others also more less very much have been were they them their would could should".split(" "));
  function subjectWords(text, n = 4) {
    const counts = new Map();
    for (const w of refWords(text)) if (w.length >= 4 && !GENERIC_WORDS.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
    return [...counts.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([w]) => w);
  }
  function claimTermsOf(sentence, text) {
    const all = new Map();
    for (const w of refWords(text)) all.set(w, (all.get(w) ?? 0) + 1);
    return [...new Set(refWords(sentence))].filter((w) => w.length >= 5 && !GENERIC_WORDS.has(w) && (all.get(w) ?? 0) <= 2).slice(0, 3);
  }
  // Whether a record's marker is the citation already there (MLA's "(Shiraishi)" for Shiraishi's work).
  const sameCitation = (raw, marker, style) => Boolean(raw) && markerWithPage(marker, citationPage(String(raw).slice(1, -1)), style) === raw;
  /* The lookup one card makes. `target` (tipCitedTarget, or a verdict card's
     sentence) says what the card is about; the matching reference entry is
     sent when there is one, because it is richer than the in-text form. */
  function citedLookupPlan(target, text) {
    if (!target) return null;
    const isEntry = target.kind === "entry";
    const entry = isEntry ? target.entry : referenceEntryFor(target.inner, text);
    const { query, thin } = citedRefQuery(entry ?? target.inner);
    const author = thin && !isEntry && !entry ? citedAuthorOnly(target.inner) : null;
    return {
      citedRef: query, thin, entry,
      author, topic: author ? subjectWords(text).join(" ") : "",
      claimTerms: author && target.sentence ? claimTermsOf(target.raw ? target.sentence.replace(target.raw, " ") : target.sentence, text) : [],
      noEntry: !isEntry && !entry && Boolean(worksCitedBlock(String(text ?? ""))),
      citedYear: citedYearOf(isEntry ? target.entry : target.inner) ?? (entry ? citedYearOf(entry) : null),
      display: String(target.inner ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    };
  }
  // Said plainly when the record and the citation disagree on the year.
  function citedYearNote(recordYear, citedYear) {
    const r = Number.isInteger(recordYear) ? String(recordYear) : "";
    if (!citedYear || r === citedYear) return "";
    if (citedYear === "n.d.") return r ? `This record is from ${r}; your citation gives no date.` : "";
    return r ? `This record is from ${r}; your citation says ${citedYear}.` : `This record gives no year; your citation says ${citedYear}.`;
  }
  /* One /api/compare-source match → the shape formatCitation reads. Only the
     record's own fields, and only where they mean what the slot means: a
     journal's or a chapter's venue is its container; a book's "venue" may be
     its publisher or its series, which cannot be told apart, so a book is
     cited without one rather than with a guess. */
  function citedWorkSource(m) {
    const s = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
    const t = s(m?.venueType);
    const kind = t === "journal" ? "journal" : t === "book" || t === "chapter" ? "book" : t === "report" ? "report" : t === "news" ? "news" : "other";
    const venue = s(m?.venue);
    const doi = s(m?.doi);
    return {
      title: s(m?.title),
      authors: Array.isArray(m?.authors) ? m.authors.map(s).filter(Boolean) : [],
      year: Number.isInteger(m?.year) ? m.year : null,
      doi,
      url: s(m?.url) || (doi ? `https://doi.org/${doi}` : ""),
      kind,
      container: t === "journal" || t === "chapter" ? venue : "",
      publisher: t === "news" ? venue : "",
      provider: m?.provider === "openlibrary" ? "Open Library" : m?.provider === "crossref" ? "Crossref" : "",
    };
  }
  // The marker and the reference entry for a record. A book is found by its
  // author, title and publisher; an Open Library address is not part of it.
  function citedWorkEntry(src, style) {
    const c = formatCitation(src, style);
    return { marker: c.marker, entry: src.kind === "book" && !src.doi && !src.container ? c.doc : c.ref };
  }
  // The page a citation gives (its writer's own), or null. A year is not a page.
  function citationPage(inner) {
    const p = String(inner ?? "");
    const m = p.match(/\bpp?\.\s*(\d{1,4}(?:\s*[-–]\s*\d{1,4})?)/i) || p.match(/(?:^|[\s,:])(\d{1,4}(?:\s*[-–]\s*\d{1,4})?)\s*$/);
    if (!m) return null;
    const n = m[1].replace(/\s+/g, "");
    return /^(?:1[5-9]|20)\d\d$/.test(n) ? null : n;
  }
  function markerWithPage(marker, page, style) {
    if (!page || !/\)$/.test(marker)) return marker;
    const sep = style === "apa" ? (/[-–]/.test(page) ? ", pp. " : ", p. ") : style === "chicago" ? ", " : " ";
    return `${marker.slice(0, -1)}${sep}${page})`;
  }
  /* The sentence with the flagged citation swapped for the record's marker,
     keeping a page the writer gave. null unless that citation is in the
     sentence exactly once: which copy is meant would otherwise be a guess. */
  function swapCitation(sentence, raw, marker, style) {
    const s = String(sentence ?? ""), r = String(raw ?? "");
    if (!r || !marker) return null;
    const at = s.indexOf(r);
    if (at < 0 || s.indexOf(r, at + r.length) >= 0) return null;
    const out = s.slice(0, at) + markerWithPage(marker, citationPage(r.slice(1, -1)), style) + s.slice(at + r.length);
    return out === s ? null : out;
  }
  /* "Some researchers have argued" with the source that backs it named in
     their place: "Lee (2021) has argued". Owner, 2026-10-08: "when there is
     an unnamed source, there is only a dismiss button when there should be
     one to fix it." The name and year are formatCitation's own marker, never
     typed from anywhere else; MLA names the author and adds no parenthesis (a
     page is the writer's to give). The check counts a named author as cited
     ("X reported…", factcheck.js). null — cite it the ordinary way — when the
     source has no author to name (its marker leads with a title), when the
     sentence already cites something, when the words are not an unnamed
     source a name can stand in for ("people believe", "experts agree", "it
     is widely believed" are claims about how many think so, which one author
     is not), or when a determiner owns them ("the studies show"). */
  const NAMEABLE_SOURCE = /\b(?:(?:some|many|several|most|certain) (?:researchers|scholars|historians|experts|scientists|studies|sources)|experts|studies|research|scientists|historians|scholars|researchers)( (?:have|has))? (argued|argues|argue|said|says|say|claimed|claims|claim|believed|believes|believe|suggested|suggests|suggest|found|shown|shows|show|think|thinks)\b/i;
  // What may come right before the words: nothing, a clause break, or a word that opens a clause.
  const NAME_SLOT_BEFORE = /(?:^|[,;:(—–-]|\b(?:and|but|as|while|although|though|because|since|yet|so|that|however|indeed|moreover|furthermore|in fact))\s*["“]?$/i;
  const VERB_BASE = { argues: "argue", says: "say", claims: "claim", believes: "believe", suggests: "suggest", shows: "show", thinks: "think" };
  const VERB_THIRD = { argue: "argues", say: "says", claim: "claims", believe: "believes", suggest: "suggests", show: "shows", think: "thinks" };
  function narrativeCitation(src, style) {
    const inner = String(formatCitation(src, style).marker ?? "").replace(/^\(|\)$/g, "");
    let lead = inner, year = null;
    if (style !== "mla") {
      const m = inner.match(style === "apa" ? /^(.+), ((?:1[5-9]|20)\d\d[a-z]?|n\.d\.)$/ : /^(.+) ((?:1[5-9]|20)\d\d[a-z]?|n\.d\.)$/);
      if (!m) return null;
      [, lead, year] = m;
    }
    const title = citeStr(src.title || src.url).replace(/[.]\s*$/, "");
    if (!lead || /^["“]/.test(lead) || lead === citeShortTitle(title)) return null;
    lead = lead.replace(/ & /g, " and ");
    return { name: year ? `${lead} (${year})` : lead, plural: / and |\bet al\.$/.test(lead) };
  }
  function nameTheSource(sentence, src, style) {
    const s = String(sentence ?? "");
    if (!src || inTextCitationsOf(s).length || /\[\d+(?:[,–-]\s?\d+)*\]/.test(s)) return null;
    const m = s.match(NAMEABLE_SOURCE);
    if (!m || !NAME_SLOT_BEFORE.test(s.slice(0, m.index))) return null;
    const n = narrativeCitation(src, style);
    if (!n) return null;
    const verb = m[2].toLowerCase();
    const said = m[1] ? `${n.plural ? "have" : "has"} ${verb}` : n.plural ? VERB_BASE[verb] ?? verb : VERB_THIRD[VERB_BASE[verb] ?? verb] ?? verb;
    return s.slice(0, m.index) + `${n.name} ${said}` + s.slice(m.index + m[0].length);
  }
  /* Notes whose fix is taking the words out get a Delete that does it: a
     line that doesn't belong, a correction left in, a reference listed twice
     or cited nowhere, an essay note marked "Delete this". The engine never
     deletes a sentence outright (docs-hook.js: every edit selects something
     and pastes something), so the edit replaces the passage AND a sentence
     beside it with that sentence alone — the next one on its line, else the
     one before it, else (a passage that is its whole paragraph, like a
     reference entry) the last sentence of the paragraph above, across the
     line break, or the first of the one below. Both ends are whole sentences
     of the export, which is how the engine finds them; the edit is read back,
     and Undo puts the passage back where it was. `last`: the later of two
     copies. null when the passage is not in the text, does not begin and end
     on a sentence boundary (deleting more than the note quotes is not its
     fix), or has nothing beside it to anchor on. */
  const DELETE_KINDS = ["refdup", "refuncited", "offtopic", "residue", "excuse"];
  const DELETE_LABEL = { refdup: "Delete this copy", refuncited: "Remove from list", offtopic: "Delete this line", residue: "Delete it", excuse: "Delete this sentence" };
  const tipDeletes = (tip) => Boolean(tip?.quote) && (DELETE_KINDS.includes(tip.kind) || tip.action === "delete");
  function deleteEditFor(text, quote, last = false) {
    const t = String(text ?? ""), q = String(quote ?? "").trim();
    if (!q) return null;
    const at = last ? t.lastIndexOf(q) : t.indexOf(q);
    if (at < 0) return null;
    const end = at + q.length;
    // A line's sentences as [start, end) offsets into t, trimmed.
    const spans = (s, e) => splitLineSentences(t.slice(s, e)).map(([a, b]) => {
      const raw = t.slice(s + a, s + b);
      const lead = raw.length - raw.trimStart().length;
      return [s + a + lead, s + a + lead + raw.trim().length];
    }).filter(([a, b]) => b > a);
    const lineStart = t.lastIndexOf("\n", at - 1) + 1;
    const lineEnd = t.indexOf("\n", end) < 0 ? t.length : t.indexOf("\n", end);
    const line = spans(lineStart, lineEnd);
    if (!line.some(([a]) => a === at) || !line.some(([, b]) => b === end)) return null;
    let from = null, to = null, keep = null;
    const next = line.find(([a]) => a >= end);
    const prev = [...line].reverse().find(([, b]) => b <= at);
    if (next) [from, to, keep] = [at, next[1], t.slice(next[0], next[1])];
    else if (prev) [from, to, keep] = [prev[0], end, t.slice(prev[0], prev[1])];
    else {
      for (let e = lineStart - 1; e > 0 && from == null;) {
        const s = t.lastIndexOf("\n", e - 1) + 1;
        const sp = spans(s, e);
        if (sp.length) { const [a, b] = sp[sp.length - 1]; [from, to, keep] = [a, end, t.slice(a, b)]; }
        e = s - 1;
      }
      for (let s = lineEnd + 1; s < t.length && from == null;) {
        const e = t.indexOf("\n", s) < 0 ? t.length : t.indexOf("\n", s);
        const sp = spans(s, e);
        if (sp.length) [from, to, keep] = [at, sp[0][1], t.slice(sp[0][0], sp[0][1])];
        s = e + 1;
      }
    }
    if (from == null || !keep.trim()) return null;
    const find = t.slice(from, to);
    const hits = [];
    for (let i = t.indexOf(find); i >= 0; i = t.indexOf(find, i + 1)) hits.push(i);
    return { find, replacement: keep, occurrence: Math.max(0, hits.indexOf(from)), occurrences: Math.max(1, hits.length) };
  }
  /* "Add the page number": the writer types the page and it goes into the
     quote's own citation, in the style's form — (Fitzgerald 45), (Smith,
     2019, p. 45), (Smith 2019, 45). Tracely never supplies the number. */
  const PAGE_INPUT = /^(?:\d{1,5}(?:\s*[-–]\s*\d{1,5})?|[ivxlcdm]{1,8}(?:\s*[-–]\s*[ivxlcdm]{1,8})?)$/i;
  function pageEditFor(passage, quote, page, style) {
    const s = String(passage ?? ""), q = String(quote ?? "");
    const p = String(page ?? "").trim();
    if (!PAGE_INPUT.test(p) || !q.endsWith(")")) return null;
    const qa = s.indexOf(q), open = q.lastIndexOf("(");
    if (qa < 0 || open < 0) return null;
    const raw = q.slice(open), at = qa + open;
    const out = s.slice(0, at) + markerWithPage(raw, p.replace(/\s*[-–]\s*/, "–"), style) + s.slice(at + raw.length);
    return out === s ? null : out;
  }
  /* The sentence a citation note is about, as an index into segs
     (segmentText's), or -1. An unusable citation, an unnamed source, a note
     to self are about their own sentence — unless the note is all the
     sentence is; an excuse ("does not need a publication date because…")
     is about the claim before it. */
  function claimSentenceIndex(kind, quote, segs) {
    const q = String(quote ?? "").trim();
    const list = Array.isArray(segs) ? segs : [];
    let i = list.findIndex((s) => s.text === q);
    if (i < 0) i = list.findIndex((s) => s.text.includes(q) || (q.length >= 12 && q.includes(s.text)));
    if (i < 0) return -1;
    const rest = (t) => t.replace(VERIFY_NOTE, " ").split(/\s+/).filter((w) => /\p{L}{3,}/u.test(w)).length;
    const noteOnly = kind === "excuse" || (kind === "placeholder" && rest(list[i].text) < 5);
    return noteOnly ? i - 1 : i;
  }
  /* What a tip card's "Find the cited work" looks up, or null. "sentence": a
     citation inside a sentence, swapped in place; "entry": a reference line,
     completed in place. An unusable citation is the bracket itself; an
     essay note or an excuse, the one work citation in the sentence it
     means. segHash is null when that sentence is not one of segs. */
  function tipCitedTarget(tip, segs) {
    if (!tip) return null;
    const list = Array.isArray(segs) ? segs : [];
    if (tip.kind === "refincomplete") return { kind: "entry", entry: tip.quote, inner: tip.quote, raw: null, segHash: null, sentence: "" };
    if (tip.kind === "badcite") {
      const seg = list.find((s) => s.text.includes(tip.quote)) ?? null;
      return { kind: "sentence", raw: tip.quote, inner: tip.quote.replace(/^\[|\]$/g, ""), segHash: seg?.hash ?? null, sentence: seg?.text ?? "" };
    }
    let seg = null, c = null;
    if (tip.kind === "excuse") {
      const i = claimSentenceIndex("excuse", tip.quote, list);
      seg = i >= 0 ? list[i] : null;
      c = seg ? lookupableCitation(seg.text) : null;
    } else if (tip.kind === "nameonly") {
      const m = String(tip.quote).match(NAME_CITE_END);
      c = m ? { raw: `(${m[1]})`, inner: m[1].trim() } : null;
      if (c) seg = list.find((s) => s.text.includes(tip.quote) || tip.quote.includes(s.text)) ?? null;
    } else if (tip.kind === "citation" || tip.kind === "source") {
      c = lookupableCitation(tip.quote);
      if (c) seg = list.find((s) => s.text.includes(c.raw) && (s.text.includes(tip.quote) || tip.quote.includes(s.text))) ?? null;
    }
    return c ? { kind: "sentence", raw: c.raw, inner: c.inner, segHash: seg?.hash ?? null, sentence: seg?.text ?? "" } : null;
  }
  // The notes whose fix is a source for the claim they excuse or hedge.
  const TIP_FIND_SOURCE = ["excuse", "placeholder", "vague"];
  // A lookup that answered nothing usable, in words that never call a source fake.
  function citedFailureNote(err) {
    const kind = err?.kind;
    if (kind === "forbidden" || kind === "not_found") return "This Tracely server can't look up cited works yet, so this citation wasn't checked — that says nothing about whether the work exists.";
    if (kind === "rate_limit" || kind === "budget") return `${String(err?.message ?? "Too many lookups just now.")} This citation wasn't checked.`;
    if (err?.offline || kind === "no_engine") return "Couldn't reach Tracely to look up the cited work, so this citation wasn't checked.";
    return `The lookup didn't answer${err?.message ? ` (${String(err.message).slice(0, 80)})` : ""}, so this citation wasn't checked.`;
  }
  const CITED_COPY = {
    find: "Find the cited work",
    looking: "Looking up the work you cited…",
    searching: "Looking up the work you cited",
    one: "The work you cited",
    many: (n) => `${n} records match your citation`,
    intro: (c) => `From Crossref and Open Library, for “${c}”. Check it is the work you meant: this is where your citation points, not proof the sentence is true.`,
    thin: (c) => `“${c}” doesn't name enough of a work — an author and a title — to look it up.`,
    byAuthorTitle: (name) => `Works by ${name} on this subject`,
    byAuthorIntro: (name, c) => `“${c}” names a person, not a work. These are ${name}'s works on your essay's subject in Crossref and Open Library. If you read one of them, pick it to complete your citation — and check it says your sentence. If you didn't, remove the citation.`,
    offClaim: (terms) => `None of these titles mentions ${terms.length > 1 ? `${terms.slice(0, -1).map((t) => `“${t}”`).join(", ")} or “${terms[terms.length - 1]}”` : `“${terms[0]}”`} — what your sentence claims.`,
    noAuthorWorks: (name, c) => `No work by ${name} on your essay's subject turned up in Crossref or Open Library, so a reader can't find this source from “${c}”. Name the work — its title and year — or remove the citation and cite a source you can name.`,
    addEntry: "Add its entry", adding: "Adding…",
    notFound: "Not found in Crossref or Open Library. These indexes hold journal articles and books, so no match does not mean the source doesn't exist. Verify it by hand instead.",
    noEntry: "Nothing in your reference list matches this citation.",
    fallback: "Sources for the sentence instead:",
    yours: "YOUR CITATION",
    replace: "Replace citation", replacing: "Replacing…", complete: "Complete entry", completing: "Completing…",
    copyRef: "Copy reference", different: "Find a different source",
    replacedTitle: "Citation replaced", completedTitle: "Entry completed",
  };

  // TEST ANCHOR (server/test/ext-*) — do not rename or re-indent the next line.
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* A source's favicon, from Google's public favicon service — the desktop's
     choice (src/main/services/search/favicon.ts). It identifies the
     PUBLICATION, where the two-letter tile only restated its name. It tells
     Google the source's domain (never the user's text), which PRIVACY.md
     names. A DOI resolver's host is not the publisher's, so a doi.org link
     gets no icon: a resolver's mark on someone's paper is worse than the
     tile. Callers keep the tile underneath and drop the image if it fails,
     which is also what a page whose policy refuses the image gets. */
  function faviconUrl(url) {
    let host = "";
    try { host = new URL(String(url)).hostname.replace(/^www\./, ""); } catch { return null; }
    if (!host || /(^|\.)doi\.org$|(^|\.)handle\.net$/.test(host)) return null;
    return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}`;
  }

  /* ── the widget's chrome, from Figma ──────────────────────────────────
     "Collapsed Launcher" (267:64): a 56px ink circle carrying the Tracely
     mark, and a 31px orange count badge overlapping its top-right edge.
     "Widget over Document" (282:70): a panel headed "N claims flagged" with a
     round close button, ONE claim at a time and "Show all (N)" under it.
     Both modes draw these. They live here, beside esc(), because that is the
     region server/test loads alongside render(): the tests keep running the
     real markup instead of a stub of it.

     The mark is the desktop launcher's asset (src/renderer/src/assets/
     figma-logo.png, trimmed to 44px), inlined because a content script's
     images load under the PAGE's policy and the extension exposes no
     web_accessible_resources. A page whose policy refuses data: images gets
     the plane glyph instead (wireChrome), never an empty circle. */
  const MARK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAtCAYAAADV2ImkAAAACXBIWXMAAAsTAAALEwEAmpwYAAALJUlEQVR42s1ZCVRTVxqO1VmsnZn2nOl05py258zMmZ5KBdk3WSQLBAKEJLxAQhDZgoiCtvVU64xxrFUURW07WusyrR3RBpcCLuBSUNzQ6tTqUK1Lre0RkS1hCy/v3vfNDUub2mmnm8I95z//TfLeu9/77vcv90QCWB5wmdXKjcbdVhs5pt/A5v3XSR6Q/MTDEmkZ80GJadzVEtPv7Oum/uXO2nSfO28aI+zWDJWtcqqxe3fu8z3bM0u6NqaX20r0837QIhxnHf3+esuD1w6af9O4Pu0Pl7Zwf7y0Qed1ZSMX0m41hN0pS1XZylM4Wzln6NphmtFbYZrnqDD+vbfCsKZ3V8rm3h36d/t2pOx37Eg55dhpuMjvMnzOV6a3Cfsze8jBbF48lANUm4Gd2eBfTUb7gpiPmosiV98pkPpKWo/medjOZvg170sKs1ckxdsqtSm2Km5G5x5ubnuVemnH3oQ1tirVZlulurxzb9Kenmrt0b4a7Zmeas1lvlrzae9eTZtjr9Yh7NcR1HDAAWY1OmZatiizg2x+OAWoNQzYYSP7LpV5Nq8zAUczmc+GuC8bdGsGyCot2gon0+v6wMuXlB4vN3o+6WuRuO1s02bNOuyLA63XUJxhDz+VBBxXAyeYP8UWbEhmXjdgDYP+BLNjzOqZHWG/1zGrTQY9nAxySCcKB3QiqdFRyozUcIRWcwKp1gv0gEHAkSmCeCybkLocga/I5O2v6knnHDnajQG4qnimpTHsqU1nPZ+U1T4qeWgII4BRODF7LCSSURJOIhndXORdipIgkLeiBGd1gpOc0BGhQUvIMTUh9UmCcDSJCEe1RKjXElrPANSnuIySej0VjqaI9GgqM4NIjhjRb3WGfqPMUM9YbGAsNphBanPQ+0462pepSfO0SGrX+eK23ANXIp5quBz259zzSs/H+wG6gLHRuibtcUeluaB3S+aZlmJD/hfoXf5W/oRpfXO8+rDAF/wr4cRZkQhyMhX0nBHiGbb4qRSIp5hvMLK5acAa0kBPprHr0pmfAnoig9kUiKenQvyAbfO/zRCOmNFbxkAuikNzxiTyeZwXtUWPZ0DHC9cVT++4luCtuGix/HyITVfwt71uUvZZM7eixnwb5WY0z45+d8tjknGSobdxZQTX/OqcAFnPXO+bmOcJ5xwv4lwcIjq3xEKoY8Au5II25kA8nwlyjoE7y/zZLND3mZ1l+jtvBv3PdJCLBRCO58NRlgb7QiU6poaiVeVJW2UepEflhfZ4L+ETlWfV5USfCHc2T8zmxnZuNSXx1vTDwt5sEXXTKUo0uJzgUz5TIvmF+7X9o9YSOcblz1siH7fN938PC31B50yg/CwP6pzrDecaGfg9bKvPTQP9uIhZIeilIpDrz7P5cxBOF4Evz0Lv4nj0ZAajM8ET9tjxYqdqAuG1PiKf7IOmRJ/TV+MDZO6LWzludPdb2XEOq+l97GfSeS9XdFZkO20z5WiMmlBpDQ4e23+95X+k1P7cyx7EsYe0zAtezC/wo7B4u4AToWi8KMyeAGFhCPo2qeE8zsA2LgRfMxP8ai34wkkQUr0h6Lzg5CaiT+9D+RRfAhZMNs7n1k2NT6bruQMyHNTom9mBvWXGWlo5BdifBRzKoo7tmX22KaG4PPnp2kpz/IODL/fN+d/1JlarpP/BN+aHhHa/6Hsei/xAX/Sh5AUvQoo8RZIzHs48P/BzI0BmsJ3I8YSY4w0xyw9Chr8omAIJMoLBpwUIbfqA1ZfMfr8d0qfLX9tQ+JjtzdSNwk5jH/YzeVWZiFhnJva1aUJ7kjduyp45uSdf9cg3Mvs10G66PpaV+Ks78/0X9D3na8dsBnyaNxXM3kTM9AEx+4A+6w+xKAB0uj9olj9FTgBBXii6pgafuzklJOKLnRtcuH1DagZfpr+JfSaQCiMle9MJPWRG+xItvRPthVtyj48+1Pr/aUgu36uiuW6AxdK/0Lm0MI8Wc/A2Z4E/j5kMYJ4vA+5LSGGASAoZ2HwGtCAIQn6Ioy03/OWa5xTjBhjy6M8A11ZzT/Zu0lhRzoHu5kRht4GQ/ekiPZiPthfjaWuUB24rPZtP6/x9+u/jJKN/UBkeYntId1fMoSG2HL+DQkGggMIgYEaQSGcEUhSyQJsWcvFGbnjoANDIMUOB3PF6ipbfpG5CuRbEqiNkdyoVa1hVq8lHx7OxYqvUA7aEic4rat+Y/gQQOXDfjxoupt3eetSN/KjQVnPQbn5GYB+dFYbWvPC1NaZBVq1cP6s3rbPH2tdr1tKtrHJuTRSFbRpCdqaAVmfAuS8P9hkKdMpZQGt8cSPRr7D/3p8C7NeA48t8eCk/zKupSDZ5KPphGQD72T90Xp2b4s9jexLI24nEuV0t0h160H3pcFbloTtPhp5oDwHJAWhJCtr4o2TwnYC76fvLzwPstG/Qmfgtie3YnsAamkRBKNeKdBcDyzKCUMEqX44MjpiJBPpAdGkDj9coTOO+VhjuGXAW/RiMZleQdmzmltLtGiaBBFEoS6Rkpw60gpX4Q1PgfNeMnqzJ4JXeIrhA8Fxwe2N8uO/QzknuxxhipdZiGWP/V9I2VLHO7Z14gVg1VNzFMkIl6z8OZUDYNw2OXCmcyokQNEEU+hC06SJz74luvzX1Debr5lJFNDbGML2qBWFXsihWsWZpD2P2cCac1ay3mCYHiWVVMIkVFS6UVb/wLfeVWfdy7vL2JfKXUDoZwsooQjaoIOzkWG88FcIBBraINVDx3iAalv50rLSnTLrRkBH5+/um268AHswYXUuiq7FSyk4MUYS+Fg1hQxz4XWlwzIoFifNlPUawSLXMuEloTonQDgXqsICtLVI/3LU46lMsY4BXRlGyLpZlhyTWVyfDEcf6iwQWYInBBCnhsOvD3hkWKbgv+tEitWfvEikVl04GKZWLdJ0KtEyPnufj4JD7whkfIiIhGA7tpNarBvlfvnNTc6/0+1lJogorFEBxFKWroiG+zjS8gbGrD4MzOghOVRCBNhy3k8IswyKFu5v+9mXK6ShVQFwqJWIpA/xGAnjWyPMxAQxsCIU6FD3asAtvK5W/HpZA+1ISA4BtxcrlWB0DWiwTaCnzb2jgLJBDUASCJk4i0EnRlByVOazsuuuwY0XcNqxiQEvkAl3FssIrWjj1EXDGsQKhi0SXTnrSwnFDB81RkuEeXctj68CkQJbLCH0lDs5FieBVoSJVh1FwUbidqtQMP7uDTFlYSe5eqrjoCjqhRE7pawxsoRJCXAhBshSdnKzBz2z+2bCz+8Wp18I91LlEfhPLZaAroildzQ6oaTKQeMauXorPU+X6YWfXvWjUzzU+0lscfdvFMF2pFIWXWXbQRlIkR6FTL/3QkhH5y2HNDHcDriiUPsYAt6KEscoAO+eyvkEdwY73CjQZ5S+MCHbdAVvnKR/tLpa3uCQhrFCK/EylCO1k9KUqWi5MVT/hfu2IALzbon64d5miCStYw7NCRfksOUGqDK2G6OHrGb4t6Law43z3csUnWMkAL1FRZ5qUwiDDVWOMdsTI4StBxBjsWhbzAViFc/4tToBRil6D9FKN6T6e074vaHtx7Huu0izMieZhlKE9RV46oti9u73seFlVhtWsWBTJnS45fGxSJIxQwIPNz0uKYpQqgekydKVKP3k7bZi7sv/XXrYtUplREgMUxKDLGL1+RLLrDurWSwlKFMcBuUo0GUaoHNw1fJ4dkfrYfxjdGbLOC+roJwaSh+SBkQd4sHj8kx1CO+erOmxZMafcfh4lGYljCLT9r+rTLWblq+5nvZEJeFAW12ep0xuzYkLudTn+L96+p5yNvf0WAAAAAElFTkSuQmCC";
  let focusCard = null;     // the open card (foldCards): the underline last clicked, or the card last opened
  function launcherHtml(countCls, countTxt, title) {
    return `<div class="launcher" id="pill" role="button" tabindex="0" title="${esc(title)}">
      <img class="launch-mark" src="${MARK_PNG}" alt="" draggable="false" />
      <span class="count ${countCls}">${esc(countTxt)}</span>
    </div>`;
  }
  /* The header counts what is wrong, kind by kind. Owner, 2026-10-08: "on
     the widget overlay … it says how many of each thing is wrong. So for
     example it would say 2 wrong citations with a little icon next to it,
     and 4 wrong factual pieces with another little red icon". Four kinds,
     each with its own shape AND its finding's colour, and the words — never
     colour alone: facts that are wrong or make no sense (red), facts worth
     checking (orange), citations (amber: a missing one, a citation note, the
     reference list's), writing (orange: the review's notes, stray lines,
     resume tips). A chip opens the first card of its kind. Nothing open and
     the check done: "All clear". The status line says only what the chips
     cannot — checking, an error. */
  const TALLY_ICON = {
    wrong: `<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="6" fill="currentColor"/><rect x="5.2" y="2.5" width="1.6" height="4.6" rx=".8" fill="#fff"/><circle cx="6" cy="9" r=".95" fill="#fff"/></svg>`,
    check: `<svg viewBox="0 0 12 12"><circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7.7 7.7l3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    cite: `<svg viewBox="0 0 12 12"><rect width="12" height="12" rx="3" fill="currentColor"/><path d="M2.8 8.4V6.6c0-1.6.6-2.6 1.9-3.2l.5.8c-.6.3-.9.8-1 1.5h1v2.7zm3.8 0V6.6c0-1.6.6-2.6 1.9-3.2l.5.8c-.6.3-.9.8-1 1.5h1v2.7z" fill="#fff"/></svg>`,
    writing: `<svg viewBox="0 0 12 12"><path d="M8.5 1.1l2.4 2.4-6.6 6.6-3.1.8.8-3.1z" fill="currentColor"/></svg>`,
    clear: `<svg viewBox="0 0 12 12"><path d="M2.2 6.3l2.4 2.4 5.2-5.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };
  // [kind, its MARK_COLORS key (read when drawn), its words]
  const TALLY = [
    ["wrong", "false", (n) => `${n} factual ${n === 1 ? "error" : "errors"}`],
    ["check", "questionable", (n) => `${n} to double-check`],
    ["cite", "needs_citation", (n) => `${n} citation ${n === 1 ? "issue" : "issues"}`],
    ["writing", "note_tip", (n) => `${n} writing ${n === 1 ? "note" : "notes"}`],
  ];
  const verdictCat = (v) => (v === "questionable" ? "check" : v === "needs_citation" ? "cite" : "wrong");
  const tipCat = (t) => (CITE_TIP_KINDS.includes(t?.kind) ? "cite" : "writing");
  // The header's counts: the claims' verdicts, and every note the list shows.
  function tallyOf(verdicts, tips) {
    const c = { wrong: 0, check: 0, cite: 0, writing: 0 };
    for (const v of verdicts ?? []) c[verdictCat(v)]++;
    for (const t of tips ?? []) c[tipCat(t)]++;
    return c;
  }
  const GRIP_SVG = `<svg viewBox="0 0 10 16" width="8" height="14"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></g></svg>`;
  function panelHeadHtml(counts, statusMsg, statusErr) {
    const c = counts ?? {};
    const total = TALLY.reduce((n, [k]) => n + (c[k] || 0), 0);
    const chips = TALLY.filter(([k]) => c[k] > 0).map(([k, mark, label]) =>
      `<button class="chip" data-jump="${k}" title="Show the first one"><span class="chip-ico" style="color:${MARK_COLORS[mark]}" aria-hidden="true">${TALLY_ICON[k]}</span>${esc(label(c[k]))}</button>`);
    if (!total && !statusErr && statusMsg === "all clear") chips.push(`<span class="chip chip-clear"><span class="chip-ico" aria-hidden="true">${TALLY_ICON.clear}</span>All clear</span>`);
    const quiet = /^(?:all clear|\d+ issues? found)$/.test(String(statusMsg ?? ""));
    const status = statusErr || !quiet ? statusMsg : "";
    return `<div class="head" id="dragHead" title="Drag to move · double-click to put it back">
      <span class="grip" aria-hidden="true">${GRIP_SVG}</span>
      <span class="name">Tracely</span>
      <span class="status${statusErr ? " error" : ""}">${esc(status)}</span>
      <button class="close" id="panelClose" title="Close" aria-label="Close">×</button>
    </div>
    <div class="tally">${chips.join("")}</div>`;
  }
  // The claim cards, all of them: foldCards keeps one open. `cards` pairs each hash with its HTML.
  function cardListHtml(cards) {
    return cards.map((c) => c.html).join("");
  }
  // A group of the list under its name and count — "Claims (2)", "Citations (1)".
  function groupHtml(title, n, inner) {
    return `<div class="tips"><div class="tips-head">${title}${n ? ` (${n})` : ""}</div>${inner}</div>`;
  }
  /* The panel's evidence section (see evidenceCandidates). Folded until
     opened; neutral, never a finding colour (CLAUDE.md "Colour only ever
     means a finding"); every card can be dismissed. `sourcesFor(seg)` is the
     mode's own source list, so citing works exactly as on an issue card. */
  function evidenceSectionHtml(candidates, open, sourcesFor, searched) {
    if (!candidates.length) return "";
    const head = `<button class="ev-toggle" id="evidenceToggle" aria-expanded="${open}">${open ? "▾" : "▸"} Evidence you could add (${candidates.length})</button>`;
    if (!open) return `<div class="evidence">${head}</div>`;
    const cards = candidates.map((seg) => `
      <div class="card ev-card" data-card="${seg.hash}">
        <div class="top"><span class="ctitle">A source would strengthen this</span><button class="x" data-dismiss="${seg.hash}" title="Not needed">✕</button></div>
        <div class="quote">“${esc(seg.text.length > 140 ? seg.text.slice(0, 139) + "…" : seg.text)}”</div>
        <div class="expl">This holds up, but it is a point a reader may want backed. A study or official source would make it harder to argue with.</div>
        ${searched(seg) ? "" : `<div class="row"><button class="act" data-sources="${seg.hash}">Find evidence</button></div>`}
        ${sourcesFor(seg)}
      </div>`).join("");
    return `<div class="evidence">${head}<div class="ev-intro">Optional — only where evidence would help your argument.</div>${cards}</div>`;
  }
  /* Resume tips: the free format rules first (instant), then what /api/review
     found, a line once — a model note on a line the rules already flagged is
     kept only if it is a different kind. A note whose quote is no longer in
     the text (the writer fixed it) drops out without waiting for the next
     review. */
  const TIP_LABEL = { bullet: "This bullet could be stronger", format: "Formatting", typo: "Possible typo", page: "Add the page number", offtopic: "Doesn't seem to belong", residue: "Correction left in the essay", refdup: "Listed twice", refuncited: "Not cited in your text",
    thesis: "Thesis", evidence: "Needs specific evidence", analysis: "Explain this evidence", structure: "Structure",
    documents: "Document evidence (DBQ)", sourcing: "Sourcing (DBQ)", complexity: "Complexity (DBQ)",
    relevance: "Doesn't support the argument", source: "Source problem", quotation: "Quotation problem", citation: "Citation problem",
    bibliography: "Works Cited problem", reasoning: "Reasoning", contradiction: "Contradiction",
    vague: "Unnamed source", nameonly: "Citation names no work", nolist: "No Works Cited", placeholder: "Unverified placeholder", excuse: "Missing citation details", badcite: "Unusable citation", refincomplete: "Incomplete entry" };
  const NOTE_ACTION = { delete: "Delete this", rewrite: "Rewrite", cite: "Add a real source", needs_info: "Needs more information" };
  const NOTE_STATUS = { confirmed: "confirmed", unsupported: "unsupported", unverified: "unverified", possible: "possible" };
  function resumeTips(text, modelFindings, dismissed) {
    const norm = (q) => String(q).toLowerCase().replace(/\s+/g, " ").trim();
    const hay = norm(text);
    /* The quote must still be in the text AS ITSELF, not as the start of
       something longer: "jordan.rivera@outlook" fixed to "…@outlook.com" is
       still a substring, and the note about the missing ending would linger
       over the fix. A following letter, digit, or ".x"/"@x"/"-x" means the
       quoted text has grown. */
    const standsAlone = (q) => {
      for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + 1)) {
        const next = hay.slice(i + q.length, i + q.length + 2);
        if (!/^\w/.test(next) && !/^[.@-]\w/.test(next)) return true;
      }
      return false;
    };
    const seen = new Set();
    const out = [];
    for (const f of [...resumeFormatIssues(text), ...(Array.isArray(modelFindings) ? modelFindings : [])]) {
      if (!f || !TIP_LABEL[f.kind] || !f.quote || !standsAlone(norm(f.quote))) continue;
      const key = norm(f.quote) + "|" + f.kind;
      if (seen.has(key)) continue;
      seen.add(key);
      const id = "tip:" + hashText(key);
      if (dismissed.has(id)) continue;
      out.push({ id, quote: String(f.quote), kind: f.kind, message: String(f.message ?? ""), suggestion: String(f.suggestion ?? "") });
    }
    return out;
  }
  function resumeTipsHtml(tips, reviewing, copiedId) {
    const note = reviewing ? "Reading your bullets…" : tips.length ? "" : "No resume tips — this reads cleanly.";
    return tipsSectionHtml("Resume tips", tips, note, copiedId);
  }
  /* Page-number notes for an essay or paper: shown only when there is one —
     an essay with every quote paged gets no empty section. */
  function citationTips(text, style, dismissed, genre = "prose") {
    // A DBQ cites its documents by number: no page, no Works Cited entry, no source for its outside evidence.
    const notInDbq = (t) => genre !== "dbq" || !["page", "nameonly", "vague"].includes(t.kind);
    return [...quoteCitationTips(text, style), ...citationHygieneTips(text)].filter(notInDbq)
      .map((t) => ({ ...t, id: "tip:" + hashText(t.quote + "|" + t.kind), suggestion: "" }))
      .filter((t) => !dismissed.has(t.id));
  }
  // The citation notes and the reference list's, as one group: both are about citing.
  function citationTipsHtml(tips, copiedId) {
    return tips.length ? tipsSectionHtml("Citations", tips, "", copiedId) : "";
  }
  // Lines that share no word with the rest of the essay (offTopicSentences): shown only when there is one.
  const OFF_TOPIC_MESSAGE = "Nothing in this line connects to the rest of your writing. If it doesn't belong, delete it; if it does, tie it to your point.";
  /* A correction left in the essay. Owner, 2026-10-05: a revised draft
     "became a sequence of corrections: 'This does not prove…', 'The Mongols
     did not…', 'Pizza is not evidence…'". A sentence whose point is what
     something does NOT show is a note about the draft, not an argument.
     Narrow on purpose — proof-negations only; "The treaty did not end the
     war" is history and is left alone. */
  const CORRECTION_RESIDUE = /^(?:this|that|it|these|those|which|such)\b[^.!?]{0,80}\b(?:does|do|did) not (?:prove|show|demonstrate|support|establish)\b|\b(?:is|are|was|were) not (?:evidence|proof)\b|\bhas nothing to do with\b|\b(?:cannot|can't) be (?:verified|proven)\b/i;
  // "did not mean the Mongols abandoned …", "this does not prove X, but …":
  // a contrast is the essay arguing, and is left alone (a DBQ's complexity).
  const CONTRAST = /\b(?:but|however|although|though|instead|rather|yet|while)\b/i;
  function correctionResidue(text) {
    const wc = worksCitedBlock(String(text ?? ""));
    const body = wc ? String(text).slice(0, wc.headStart) : String(text ?? "");
    return body.split(/(?<=[.!?]["”’)\]]?)\s+|\n+/).map((x) => x.trim())
      .filter((x) => x.length >= 12 && CORRECTION_RESIDUE.test(x) && !CONTRAST.test(x)).slice(0, 6);
  }
  const RESIDUE_MESSAGE = "This says what something does not show — a correction note, not part of your argument. Delete it, or make the point the paragraph needs.";
  function offTopicTips(text, dismissed) {
    return [
      ...offTopicSentences(text).map((quote) => ({ id: "tip:" + hashText(quote + "|offtopic"), quote, kind: "offtopic", message: OFF_TOPIC_MESSAGE, suggestion: "" })),
      ...correctionResidue(text).map((quote) => ({ id: "tip:" + hashText(quote + "|residue"), quote, kind: "residue", message: RESIDUE_MESSAGE, suggestion: "" })),
    ].filter((t) => !dismissed.has(t.id));
  }
  // The reference list's two notes (referenceListIssues): shown only when there is one.
  const REF_MESSAGES = {
    refdup: "This source is listed twice. Delete this copy.",
    refuncited: "Nothing in your text cites this source. If you used it, add an in-text citation; if not, remove it from the list.",
    refincomplete: "A reader cannot find this source from this entry. Add what is missing from the source itself — never guess it.",
  };
  function referenceTips(text, dismissed, genre = "prose", style = "mla") {
    return [
      ...noListTip(text, genre, style),
      ...referenceListIssues(text).map((r) => ({ id: "tip:" + hashText(r.quote + "|" + r.kind), quote: r.quote, kind: r.kind, message: r.missing ? `${REF_MESSAGES[r.kind]} Missing: ${r.missing.join("; ")}.` : REF_MESSAGES[r.kind], suggestion: "" })),
    ].filter((t) => !dismissed.has(t.id));
  }
  /* No Works Cited. Owner, 2026-10-09: "right now when it needs to its still
     not automatically inserting works cited". An essay or paper that cites
     works in its text and has no reference list gets a note that offers to
     add one ("Add Works Cited", docAddWorksCited). Not on a DBQ, a speech, a
     news story or the writer's own account: those have none
     (genreWantsList). The works are each distinct citation of a work —
     (Lee, 2019) and (Lee 45) are one — and a surname after a reported claim,
     "(Shiraishi)". */
  function citedWorksWithoutList(text) {
    const t = String(text ?? "");
    if (worksCitedBlock(t)) return [];
    const works = new Map();
    const add = (raw, inner, sentence) => {
      const author = citedAuthorOnly(inner);
      const year = citedYearOf(inner);
      const title = (String(inner).match(/["“]([^"”]{3,})["”]/) ?? [])[1] ?? "";
      const key = `${(author ?? title).toLowerCase()}|${year ?? ""}`;
      if (!works.has(key)) works.set(key, { key, raw, inner, author, year, title, sentence });
    };
    for (const para of t.split(/\n+/)) {
      for (const sentence of para.split(/(?<=[.!?]["”’)\]]?)\s+/)) {
        for (const c of inTextCitationsOf(sentence)) add(c.raw, c.inner, sentence);
        const n = nameOnlyCitation(sentence, t);
        if (n) add(n.raw, n.inner, sentence);
      }
    }
    // (Weatherford 112) beside (Weatherford, 2004) is a page of that work, not another one.
    const dated = new Set([...works.values()].filter((w) => w.author && w.year).map((w) => w.author.toLowerCase()));
    return [...works.values()].filter((w) => w.year || !w.author || !dated.has(w.author.toLowerCase()));
  }
  function noListTip(text, genre, style) {
    if (!genreWantsList(genre)) return [];
    const works = citedWorksWithoutList(text);
    if (!works.length) return [];
    const list = REF_HEADINGS[style] ?? REF_HEADINGS.mla;
    const named = works.slice(0, 3).map((w) => w.raw).join(", ") + (works.length > 3 ? ` and ${works.length - 3} more` : "");
    return [{
      id: "tip:" + hashText(`nolist|${works.map((w) => w.key).join(",")}`), quote: "", kind: "nolist", label: `No ${list}`, suggestion: "",
      message: `You cite ${named}, but there is no ${list}. Every work you cite needs an entry there, at the end.`,
    }];
  }
  /* The record a citation plainly means, or null. An entry nobody picked has
     to be the right one: the record's author is the cited name and its year
     the cited year (when one is given); a title-only citation shares most of
     its title's words; and for a surname-only citation — whose lookup lists
     that author's works on the subject — exactly one of them is about the
     sentence's claim. Anything less is left for the citation's own card,
     where the writer picks. */
  function citedMatchFor(work, r, plan) {
    if (!r?.resolved || !Array.isArray(r.matches) || !r.matches.length) return null;
    const fold = (x) => String(x ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const year = work.year && work.year !== "n.d." ? Number(work.year) : null;
    let pool = r.matches.filter((m) => !year || m.year === year);
    if (work.author) {
      const surname = fold(work.author);
      pool = pool.filter((m) => (m.authors ?? []).some((a) => fold(a).split(/[\s,.]+/).includes(surname)));
    } else if (work.title) {
      const want = refWords(work.title);
      pool = pool.filter((m) => { const have = new Set(refWords(m.title)); return want.length && want.filter((w) => have.has(w)).length / want.length >= 0.6; });
    } else return null;
    if (r.byAuthor) {
      if (year && pool.length === 1) return pool[0]; // (Weatherford, 2004): one work of his from that year
      const terms = (plan?.claimTerms ?? []).map((w) => w.slice(0, 5));
      const on = pool.filter((m) => { const t = new Set(refWords(`${m.title} ${m.container ?? ""}`).map((w) => w.slice(0, 5))); return terms.some((w) => t.has(w)); });
      return on.length === 1 ? on[0] : null;
    }
    return pool[0] ?? null;
  }
  /* A speech or a news story names its source in the sentence and has no
     list: "According to Pew Research Center in 2021, most teens …". */
  const LOWER_OPENER = /^(?:The|A|An|This|That|These|Those|Most|Many|Some|More|Over|About|Nearly|Almost|Every|Each|It|There|Only|Few|Half|All|One|Two|Three|Four|Five|Our|We|They|People|Students|Teens|Kids|Children|Adults|Americans)\b/;
  function attributeAloud(sentence, src) {
    const text = String(sentence ?? "").trim();
    if (!src || !text || /^according to\b/i.test(text) || inTextCitationsOf(text).length) return null;
    const inner = String(formatCitation(src, "apa").marker ?? "").replace(/^\(|\)$/g, "");
    const m = inner.match(/^(.+?),\s*((?:1[5-9]|20)\d\d[a-z]?|n\.d\.)$/);
    const who = (m ? m[1] : inner).replace(/ & /g, " and ").trim();
    if (!who || who.length > 80) return null;
    const year = m && m[2] !== "n.d." ? ` in ${m[2]}` : "";
    const rest = LOWER_OPENER.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
    return `According to ${who}${year}, ${rest}`;
  }
  /* Writing feedback (owner, 2026-10-05, on an AP World DBQ whose facts were
     all right: "it flags things too little … It should of flagged these
     important parts of the DBQ"). /api/review with kind "essay" reads the
     essay against its rubric and returns at most five notes, each on one
     sentence or on the whole essay. Shown only when they belong to the text
     on screen: a sentence note whose sentence is gone drops out at once. */
  const ESSAY_NOTE_KINDS = ["relevance", "source", "quotation", "citation", "bibliography", "reasoning", "contradiction", "evidence", "analysis", "thesis", "structure", "documents", "sourcing", "complexity"];
  function essayFeedbackTips(text, findings, dismissed) {
    const norm = (x) => String(x).toLowerCase().replace(/\s+/g, " ").trim();
    const hay = norm(text);
    return (Array.isArray(findings) ? findings : [])
      .filter((f) => f && ESSAY_NOTE_KINDS.includes(f.kind) && f.message && (!f.quote || hay.includes(norm(f.quote))))
      .map((f) => ({
        id: "tip:" + hashText(String(f.quote ?? "") + "|" + f.kind + "|" + (f.quote ? "" : f.message)),
        quote: String(f.quote ?? ""), kind: f.kind, message: String(f.message),
        action: NOTE_ACTION[f.action] ? f.action : null, status: NOTE_STATUS[f.status] ? f.status : null,
        suggestion: f.action === "rewrite" ? String(f.suggestion ?? "") : "",
      }))
      .filter((t) => !dismissed.has(t.id));
  }
  /* Fixed since an earlier review: a sentence note whose sentence is no
     longer in the text, and that the latest review did not raise again.
     Shown apart from what is still open, so a revised draft says what was
     done and what was not — never that it is now flawless. */
  function resolvedNotes(seen, open, text) {
    const norm = (x) => String(x).toLowerCase().replace(/\s+/g, " ").trim();
    const hay = norm(text);
    const openIds = new Set(open.map((t) => t.id));
    return [...seen.values()].filter((t) => t.quote && !openIds.has(t.id) && !hay.includes(norm(t.quote)));
  }
  function essayFeedbackHtml(tips, reviewing, copiedId, fixed = []) {
    if (!tips.length && !reviewing && !fixed.length) return "";
    const note = reviewing && !tips.length ? "Reading your essay…" : !tips.length ? "Nothing open from the last review." : "";
    const fixedHtml = fixed.length ? `<div class="ev-intro">Fixed since an earlier review (${fixed.length}): ${fixed.slice(0, 6).map((t) => esc(TIP_LABEL[t.kind] ?? t.kind)).join(", ")}${fixed.length > 6 ? "…" : ""}</div>` : "";
    return tipsSectionHtml("Writing feedback", tips, note, copiedId).replace(/<\/div>$/, `${fixedHtml}</div>`);
  }
  // Sentence notes as marks (note_tip), placed like the citation notes.
  function essayFeedbackMarks(text, tips) {
    const out = [];
    for (const t of tips) {
      if (!t.quote) continue;
      const at = text.indexOf(t.quote);
      if (at >= 0) out.push({ ...t, start: at, end: at + t.quote.length, mark: t.quote, lastCopy: false, markKind: "note_tip" });
    }
    return out;
  }

  /* One underline per span of text. Owner, 2026-10-08: "sometimes a sentence
     is underlined with two different problems and it becomes jumbled" — two
     translucent bands on the same words read as neither. A note over the
     whole of a flagged sentence (an unnamed source, an excuse, a review note
     on that sentence) is not drawn: the sentence's own mark carries it, and
     its card lists it ("Also here", Docs) or the panel does (fields). A note
     on part of the sentence — a citation, a bracket — is drawn beside the
     fact mark, which stops short of it (factSpanOf). */
  function tipCoversSentence(sentence, mark) {
    const s = String(sentence ?? ""), m = String(mark ?? "");
    return Boolean(s && m) && (s === m || (m.length >= s.length * 0.8 && (s.includes(m) || m.includes(s))));
  }
  // The part of a flagged sentence its own mark covers, as [start, end) in
  // it: all of it, or — beside a smaller note's span — the longer side of it
  // (a citation at the end leaves the words before it).
  function factSpanOf(sentence, tips) {
    const s = String(sentence ?? "");
    const t = (Array.isArray(tips) ? tips : []).find((x) => x?.mark && s.includes(x.mark) && !tipCoversSentence(s, x.mark));
    if (!t) return { start: 0, end: s.length };
    const at = s.lastIndexOf(t.mark);
    const before = s.slice(0, at).trimEnd().length;
    const tail = s.slice(at + t.mark.length);
    const after = at + t.mark.length + (tail.length - tail.trimStart().length);
    return before >= s.length - after ? { start: 0, end: before } : { start: after, end: s.length };
  }

  /* Where each citation note goes on the page (cite_tip marks). Owner,
     2026-10-04: "what if it needs to flag for two different things, say wrong
     information and wrong citation" — so a citation note is underlined on
     the citation, not the sentence: a quote missing its page on its
     "(Fitzgerald)", a reference listed twice or never cited on the entry.
     The fact mark keeps the sentence. start/end are offsets into `text`;
     `lastCopy` tells Docs, which locates by text, to underline only the
     later of two identical entries (the one the note says to delete). */
  function citationMarks(text, style, dismissed, genre = "prose") {
    const out = [];
    for (const t of citationTips(text, style, dismissed, genre)) {
      const at = text.indexOf(t.quote);
      if (at < 0) continue;
      if (t.kind !== "page") { out.push({ ...t, start: at, end: at + t.quote.length, mark: t.quote, lastCopy: false }); continue; }
      const p = t.quote.lastIndexOf("(");
      if (p < 0) continue;
      out.push({ ...t, start: at + p, end: at + t.quote.length, mark: t.quote.slice(p), lastCopy: false });
    }
    for (const t of referenceTips(text, dismissed, genre, style)) {
      if (!t.quote) continue; // a note about the whole document has no line to underline
      const at = t.kind === "refdup" ? text.lastIndexOf(t.quote) : text.indexOf(t.quote);
      if (at < 0) continue;
      out.push({ ...t, start: at, end: at + t.quote.length, mark: t.quote, lastCopy: t.kind === "refdup" });
    }
    return out;
  }
  /* "Reading this as a research paper" — the detected kind, said plainly so a
     wrong guess is visible — and what that kind means for its citations. */
  const GENRE_QUIET_LINE = {
    homework: "This looks like homework questions. Tracely checks essays and other writing, so it is staying quiet here.",
    poem: "This reads as a poem — nothing in it needs a source, so Tracely is staying quiet.",
    story: "This reads as a story — fiction needs no sources, so Tracely is staying quiet.",
    script: "This reads as a script — nothing in it needs a source, so Tracely is staying quiet.",
  };
  function genreCiteNote(genre, text, style) {
    const list = REF_HEADINGS[style] ?? REF_HEADINGS.mla;
    switch (genre) {
      case "dbq": return "cite the documents by number, like (Doc 3); outside evidence needs no source, and a DBQ has no Works Cited";
      case "research": return `every finding needs an in-text citation and an entry in your ${list}`;
      case "lab": return `your own data needs no source; background facts do, with an entry in your ${list}`;
      case "literary": {
        const f = literaryForm(text);
        return f === "poem" ? `quote the poem by its line numbers and list it in your ${list}`
          : f === "play" ? `quote the play by act, scene and line, like (3.1.56), and list it in your ${list}`
          : `quote with page numbers and list the book in your ${list}`;
      }
      case "speech": return "name each source out loud (“According to …”); a speech has no Works Cited";
      case "news": return "name each source in the sentence (“…, according to …”); an article has no Works Cited";
      case "personal": return "your own story needs no citations";
      case "email": case "letter": case "coverletter": return "no citations needed";
      case "notes": return "no citations needed; a wrong fact still shows";
      case "annotated": return "each entry is your summary of its source — nothing more to cite";
      default: return "";
    }
  }
  function genreLineHtml(genre, text = "", style = "mla") {
    if (GENRE_QUIET_LINE[genre]) return `<div class="genre-line">${GENRE_QUIET_LINE[genre]}</div>`;
    if (!GENRE_LABEL[genre]) return "";
    const how = genreCiteNote(genre, text, style);
    return `<div class="genre-line">Reading this as ${GENRE_LABEL[genre]}${how ? ` — ${how}` : ""}</div>`;
  }
  /* A note's dot is its underline's colour (MARK_COLORS): amber for a note on
     a citation (cite_tip), orange for one on the writing (note_tip). A note
     with no underline — a resume line, a stray line — has none: colour only
     ever means a finding someone can see in the text. */
  const CITE_TIP_KINDS = ["page", "vague", "nameonly", "excuse", "placeholder", "badcite", "refdup", "refuncited", "refincomplete", "nolist"];
  const tipDot = (t) => (CITE_TIP_KINDS.includes(t.kind) ? "d-cite" : ESSAY_NOTE_KINDS.includes(t.kind) ? "d-quest" : "");
  function tipsSectionHtml(title, tips, note, copiedId) {
    const cards = tips.map((t) => `
      <div class="card tip-card" data-card="${t.id}" data-cat="${tipCat(t)}">
        <div class="top">${tipDot(t) ? `<span class="dot ${tipDot(t)}"></span>` : ""}<span class="ctitle">${t.label ?? TIP_LABEL[t.kind]}</span><button class="x" data-tip-x="${t.id}" title="Dismiss">✕</button></div>
        ${t.action || t.status ? `<div class="src-meta">${[NOTE_ACTION[t.action], t.status ? NOTE_STATUS[t.status] : ""].filter(Boolean).map(esc).join(" · ")}</div>` : ""}
        ${t.quote ? `<div class="quote">${t.kind === "page" ? "" : "“"}${esc(t.quote.length > 160 ? t.quote.slice(0, 159) + "…" : t.quote)}${t.kind === "page" ? "" : "”"}</div>` : ""}
        ${t.message ? `<div class="expl">${esc(t.message)}</div>` : ""}
        ${t.suggestion ? `<div class="fix"><div class="fix-label">Suggested rewrite</div><div class="fix-text">${esc(t.suggestion)}</div><div class="row"><button class="act" data-tip-copy="${t.id}">${copiedId === t.id ? "Copied ✓" : "Copy rewrite"}</button></div></div>` : ""}
      </div>`).join("");
    return `<div class="tips"><div class="tips-head">${title}${tips.length ? ` (${tips.length})` : ""}</div>${note ? `<div class="ev-intro">${note}</div>` : ""}${cards}</div>`;
  }
  /* "Find the cited work" in a panel card (both modes). `c` is one card's
     lookup: { loading } | { resolved:false, note } | { resolved:true,
     matches, plan }. Every line under a match is the record's own field;
     `actionsFor(i, src)` is the mode's buttons for match i. */
  function citedAuthors(list) {
    const a = Array.isArray(list) ? list.filter(Boolean) : [];
    return a.length > 3 ? `${a.slice(0, 3).join(", ")} et al.` : a.join(", ");
  }
  function citedMetaLine(src) {
    return [citedAuthors(src.authors), src.year, src.container || src.publisher, src.provider].filter((x) => x != null && x !== "").join(" · ");
  }
  function citedWorkHtml(c, actionsFor, more = "") {
    if (!c) return "";
    if (c.loading) return `<div class="sources"><div class="loading">${esc(CITED_COPY.looking)}</div></div>`;
    if (!c.resolved) {
      return `<div class="sources"><div class="sources-title">${esc(CITED_COPY.one)}</div><div class="loading">${esc(c.note)}</div>`
        + `${c.plan?.noEntry ? `<div class="src-snip">${esc(CITED_COPY.noEntry)}</div>` : ""}${c.target?.segHash ? `<div class="src-snip">${esc(CITED_COPY.fallback)}</div>` : ""}</div>`;
    }
    const rows = c.matches.map((src, i) => {
      const meta = citedMetaLine(src);
      const yn = citedYearNote(src.year, c.plan?.citedYear);
      return `
        <div class="src" data-cited-row="${i}">
          <div class="src-body">
            ${src.url ? `<a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.title)}</a>` : `<span class="src-title">${esc(src.title)}</span>`}
            ${meta ? `<div class="src-meta">${esc(meta)}</div>` : ""}
            ${yn ? `<div class="src-snip">${esc(yn)}</div>` : ""}
            <div class="src-actions">${actionsFor(i, src)}</div>
          </div>
        </div>`;
    }).join("");
    const by = c.byAuthor;
    return `<div class="sources"><div class="sources-title">${esc(by ? CITED_COPY.byAuthorTitle(by.name) : c.matches.length === 1 ? CITED_COPY.one : CITED_COPY.many(c.matches.length))}</div>`
      + `<div class="src-snip">${esc(by ? CITED_COPY.byAuthorIntro(by.name, c.plan?.display ?? "") : CITED_COPY.intro(c.plan?.display ?? ""))}</div>`
      + `${by?.offClaim?.length ? `<div class="src-snip"><b>${esc(CITED_COPY.offClaim(by.offClaim))}</b></div>` : ""}`
      + `${c.plan?.noEntry ? `<div class="src-snip">${esc(CITED_COPY.noEntry)}</div>` : ""}${rows}${more}</div>`;
  }
  /* One card open at a time. Owner, 2026-10-08, on the panel: "make this
     more organized polished … restructure it" — every card open at once read
     as a wall. The open card is the underline last clicked or the card last
     opened (focusCard), else the first, which is then kept open while the
     writer works in it even if a new card lands above it. The rest fold to
     their title and the first line of their sentence and open on a click or
     Enter. A card's own buttons are only in the open card. Evidence cards
     sit in their own fold and are left as they are. */
  function foldCards(shadow, rerender) {
    const cards = [...shadow.querySelectorAll(".list .card[data-card]:not(.ev-card)")];
    if (cards.length < 2) return;
    if (!cards.some((c) => c.dataset.card === focusCard)) focusCard = cards[0].dataset.card;
    for (const card of cards) {
      card.setAttribute("aria-expanded", String(card.dataset.card === focusCard));
      if (card.dataset.card === focusCard) continue;
      card.classList.add("shut");
      card.tabIndex = 0;
      const open = (e) => {
        if (e.target.closest?.("button, a, input")) return; // its ✕ still dismisses
        focusCard = card.dataset.card;
        rerender();
      };
      card.addEventListener("click", open);
      card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); } });
    }
  }
  // TEST ANCHOR (server/test/ext-*) — do not rename or re-indent the next line.
  function wireChrome(shadow, close, rerender) {
    shadow.getElementById("panelClose")?.addEventListener("click", close);
    // A count in the header opens the first card of its kind.
    for (const chip of shadow.querySelectorAll("[data-jump]")) {
      chip.addEventListener("click", () => {
        const card = shadow.querySelector(`.list .card[data-cat="${chip.dataset.jump}"]`);
        if (!card) return;
        focusCard = card.dataset.card;
        rerender();
        try { shadow.querySelector(`.list .card[data-card="${CSS.escape(focusCard)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch { /* old engine */ }
      });
    }
    wireDrag(shadow);
    for (const img of shadow.querySelectorAll(".src-ico img")) img.addEventListener("error", () => img.remove(), { once: true });
    const mark = shadow.querySelector(".launch-mark");
    mark?.addEventListener("error", () => { mark.outerHTML = `<span class="launch-plane">${PLANE_SVG}</span>`; }, { once: true });
    const pill = shadow.getElementById("pill");
    pill?.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pill.click(); } });
  }

  /* The panel goes where the writer puts it. Owner, 2026-10-08: "make the
     overlay movable and draggable across the screen". Dragged by its header
     (not by its buttons), kept wholly on screen, remembered for the site in
     the page's own storage, and put back in its corner by a double-click on
     the header. The panel is redrawn often, so the drag follows the pointer
     on the window and places whichever panel is current. */
  const PANEL_POS_KEY = "tracely.widget.panelPos";
  let panelPos = (() => {
    try {
      const p = JSON.parse(localStorage.getItem(PANEL_POS_KEY) ?? "null");
      return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
    } catch { return null; }
  })();
  const keepPanelPos = () => { try { if (panelPos) localStorage.setItem(PANEL_POS_KEY, JSON.stringify(panelPos)); else localStorage.removeItem(PANEL_POS_KEY); } catch { /* storage denied */ } };
  // Where a panel w×h may sit: wholly inside the window, 8px in.
  const panelSpot = (x, y, w, h) => ({
    x: Math.round(Math.min(Math.max(8, x), Math.max(8, innerWidth - w - 8))),
    y: Math.round(Math.min(Math.max(8, y), Math.max(8, innerHeight - h - 8))),
  });
  function placePanel(panel) {
    if (!panel) return;
    if (!panelPos) { Object.assign(panel.style, { position: "", left: "", top: "", right: "", bottom: "" }); return; }
    const r = panel.getBoundingClientRect();
    const at = panelSpot(panelPos.x, panelPos.y, r.width, r.height);
    Object.assign(panel.style, { position: "fixed", left: `${at.x}px`, top: `${at.y}px`, right: "auto", bottom: "auto" });
  }
  let panelResizeWired = false;
  function wireDrag(shadow) {
    const head = shadow.getElementById("dragHead");
    placePanel(shadow.querySelector(".panel"));
    if (!panelResizeWired) {
      panelResizeWired = true; // a smaller window keeps a moved panel on it
      globalThis.window?.addEventListener("resize", () => { if (panelPos) placePanel(shadow.querySelector(".panel")); });
    }
    if (!head || head.dataset.drag) return;
    head.dataset.drag = "1";
    head.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest?.("button, a, input, label, select")) return;
      const panel = shadow.querySelector(".panel");
      if (!panel) return;
      const r = panel.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      e.preventDefault();
      panel.classList.add("dragging");
      const move = (ev) => {
        const cur = shadow.querySelector(".panel");
        const box = cur ? cur.getBoundingClientRect() : r;
        panelPos = panelSpot(ev.clientX - dx, ev.clientY - dy, box.width, box.height);
        if (cur) { cur.classList.add("dragging"); placePanel(cur); }
      };
      const up = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", up, true);
        shadow.querySelector(".panel")?.classList.remove("dragging");
        keepPanelPos();
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", up, true);
    });
    head.addEventListener("dblclick", (e) => {
      if (e.target.closest?.("button")) return;
      panelPos = null;
      keepPanelPos();
      placePanel(shadow.querySelector(".panel"));
    });
  }

  // Carry [n] citation markers from the original sentence into a revision that
  // dropped them (mirrors applyFix in the app).
  function withMarkers(original, revision) {
    const markers = [...new Set(original.match(/\[\d+\]/g) ?? [])].filter((m) => !revision.includes(m));
    if (!markers.length) return revision;
    const punct = revision.match(/[.!?]+["')\]]*$/);
    const at = punct ? revision.length - punct[0].length : revision.length;
    return revision.slice(0, at).replace(/\s+$/, "") + " " + markers.join(" ") + revision.slice(at);
  }

  /* ── transport ─────────────────────────────────────────────────────────── */

  // Inside the real extension every call relays through the background
  // worker, which picks which Tracely server answers it. The harness and
  // plain-script test pages fetch the server directly.
  const useRelay = !harness && typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);

  initTier(); // the plan gate asks the worker, so it can only start once useRelay is known

  async function api(path, body) {
    if (useRelay) {
      let resp;
      try {
        resp = await chrome.runtime.sendMessage({ type: "tracely-api", path, body });
      } catch {
        throw new Error("Tracely extension was reloaded — refresh this page");
      }
      if (!resp) throw new Error("No reply from the Tracely background worker");
      if (!resp.ok) {
        throw Object.assign(new Error(resp.message ?? `HTTP ${resp.status}`), { kind: resp.kind, offline: resp.offline });
      }
      return resp.data;
    }
    const res = await fetch(`${SERVER}${path}`, body === undefined
      ? undefined
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(data?.error?.message ?? `HTTP ${res.status}`), { kind: data?.error?.kind });
    }
    return data;
  }

  function offlineError(err) {
    return Boolean(err?.offline) || err instanceof TypeError || /failed to fetch/i.test(String(err?.message));
  }

  /* The live source search (POST /api/sources/stream, server 2026-10-08+).
     Owner, 2026-10-08: "make the search for articles faster or at least
     ways to make it seem faster". It is the same search and the same final
     answer as /api/sources, with what is happening sent as it happens:
     onEvent gets { type: "searching" }, { type: "found", sources: [{ title,
     url, publisher }] } (real sites, never a stance), { type: "links", urls }
     (dead links dropped), { type: "read", url, read, from } per source, and
     { type: "judging", count }. Resolves /api/sources' own body. */
  // "data: {json}" blocks out of a buffer. A copy of background.js
  // sseEvents; test/ext-live-search.test.js runs the two side by side.
  function sseEvents(buffer) {
    const events = [];
    let k;
    while ((k = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, k);
      buffer = buffer.slice(k + 2);
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try { events.push(JSON.parse(line.slice(6))); } catch { /* a garbled event is skipped, never fatal */ }
    }
    return { events, rest: buffer };
  }
  async function apiStream(path, body, onEvent) {
    const emit = (ev) => { try { onEvent?.(ev); } catch { /* the card's trouble, never the search's */ } };
    const fail = (r) => Object.assign(new Error(r?.message ?? `HTTP ${r?.status}`), { kind: r?.kind, offline: r?.offline, status: r?.status, started: r?.started !== false });
    if (useRelay) {
      let port;
      try {
        port = chrome.runtime.connect({ name: "tracely-stream" });
      } catch {
        throw new Error("Tracely extension was reloaded — refresh this page");
      }
      const result = await new Promise((resolve) => {
        let settled = false;
        const finish = (r) => {
          if (settled) return;
          settled = true;
          resolve(r);
          try { port.disconnect(); } catch { /* already gone */ }
        };
        port.onMessage.addListener((m) => {
          if (m?.type === "event") emit(m.event);
          else if (m?.type === "end") finish(m.result);
        });
        // The worker went away mid-search: whether the server took it on is
        // unknown, so it is never asked again on its own (that could pay twice).
        port.onDisconnect.addListener(() => finish({ ok: false, kind: "server", message: "No reply from the Tracely background worker" }));
        port.postMessage({ type: "tracely-api-stream", path, body });
      });
      if (!result?.ok) throw fail(result);
      return result.data;
    }
    // The harness and plain test pages: the server directly.
    const res = await fetch(`${SERVER}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw fail({ status: res.status, message: data?.error?.message, kind: data?.error?.kind, started: false });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", done = null, failed = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      const parsed = sseEvents(buffer + decoder.decode(value, { stream: true }));
      buffer = parsed.rest;
      for (const ev of parsed.events) {
        if (ev?.type === "done") done = ev;
        else if (ev?.type === "error") failed = ev;
        else emit(ev);
      }
    }
    if (done) { const { type: _t, ...data } = done; return data; }
    throw fail(failed ? { status: failed.status, message: failed.error?.message, kind: failed.error?.kind } : { status: 502, kind: "server", message: "The search stopped before it finished — try again." });
  }
  /* A server from before the live search refuses its route before searching
     (404, or 403 for a route it does not know) — asked the old way then, and
     from then on, so a writer never waits on the deploy. A search the server
     took on and lost is an error like any other: asking again would pay twice. */
  let liveSearchMissing = false;
  async function searchSources(body, onEvent) {
    if (!liveSearchMissing) {
      try {
        return await apiStream("/api/sources/stream", body, onEvent);
      } catch (err) {
        const missing = err?.started === false && (err.status === 404 || (err.status === 403 && err.kind === "forbidden"));
        if (!missing) throw err;
        liveSearchMissing = true;
      }
    }
    return api("/api/sources", body);
  }

  /* "Find the cited work": one /api/compare-source call (citedLookupPlan
     says what is sent). Resolves { resolved, matches, note } and never
     throws. A server from before 2.21.24 refuses the route by origin (403),
     and that reads as "not checked", never as an answer about the work. A
     citation too thin to look up is not sent at all. At most three records,
     each passed through citedWorkSource so only its own fields travel on. */
  async function lookupCitedWork(plan) {
    if (!plan) return { resolved: false, matches: [], note: CITED_COPY.notFound };
    if (plan.thin && plan.author) return lookupAuthorWorks(plan);
    if (plan.thin) return { resolved: false, matches: [], note: CITED_COPY.thin(plan.display) };
    try {
      const data = await api("/api/compare-source", { citedRef: plan.citedRef });
      const matches = (Array.isArray(data?.matches) ? data.matches : [])
        .filter((m) => m && typeof m.title === "string" && m.title.trim()).slice(0, 3).map(citedWorkSource);
      if (data?.resolved === true && matches.length) return { resolved: true, matches, note: "" };
      const note = typeof data?.resolvedNote === "string" && data.resolvedNote.trim() ? data.resolvedNote.trim() : CITED_COPY.notFound;
      return { resolved: false, matches: [], note };
    } catch (err) {
      return { resolved: false, matches: [], note: citedFailureNote(offlineError(err) ? { ...err, kind: err?.kind, offline: true } : err), failed: true };
    }
  }

  /* A surname-only citation's lookup: that author's works on the essay's
     subject (/api/compare-source with `author`, server 2026-10-08+). The
     records come back as the card's matches, marked `byAuthor`, so picking
     the one the writer read completes the citation the usual way. None of
     them is offered as the work the writer meant — the card says to pick the
     one they read and to check it says the sentence — and when no title shares
     the claim's own words, it says so. A server from before this answers
     without `authorWorks`, and the card says what it said before. */
  async function lookupAuthorWorks(plan) {
    try {
      const data = await api("/api/compare-source", { citedRef: plan.author, author: plan.author, topic: plan.topic });
      const aw = data?.authorWorks;
      if (!aw || !Array.isArray(aw.works)) return { resolved: false, matches: [], note: CITED_COPY.thin(plan.display) };
      const matches = aw.works.filter((m) => m && typeof m.title === "string" && m.title.trim()).slice(0, 5).map(citedWorkSource);
      if (!matches.length) return { resolved: false, matches: [], note: CITED_COPY.noAuthorWorks(plan.author, plan.display) };
      const terms = Array.isArray(plan.claimTerms) ? plan.claimTerms : [];
      const titled = (m) => new Set(refWords(`${m.title} ${m.container}`).map((w) => w.slice(0, 5)));
      const onClaim = !terms.length || matches.some((m) => { const t = titled(m); return terms.some((w) => t.has(w.slice(0, 5))); });
      return { resolved: true, matches, note: "", byAuthor: { name: plan.author, offClaim: onClaim ? [] : terms } };
    } catch (err) {
      return { resolved: false, matches: [], note: citedFailureNote(offlineError(err) ? { ...err, kind: err?.kind, offline: true } : err), failed: true };
    }
  }

  /* ── widget chrome (shared shadow-DOM shell) ───────────────────────────── */

  const PLANE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>`;

  /* What an ORPHANED tab's pill says — the extension was reloaded, updated,
     disabled or uninstalled while this page kept running (Chrome orphans the
     content script in every one of those cases, and the script cannot tell
     which). That script can no longer reach the server, and its findings
     predate the change, so a count in the pill is a stale claim (it used to
     stay up after the underlines had been cleared). Say what happened
     without claiming an update the user may not have had, and the one thing
     that fixes it either way — a reload reconnects, or clears the pill of an
     extension that is off — in the quiet style: nothing is wrong with the
     user's writing. No click-to-reload — on a field-mode site that could
     throw away what they were typing. */
  const ORPHAN_PILL_TEXT = "Tracely was updated or turned off — reload this tab";
  function orphanPillHtml() {
    return `<div class="pill quiet orphan" id="pill" title="${ORPHAN_PILL_TEXT}"><span class="plane">${PLANE_SVG}</span>${ORPHAN_PILL_TEXT}</div>`;
  }

  /* ── the app's design tokens ───────────────────────────────────────────
     The extension is meant to read as the same product as the Tracely app,
     so every colour, radius and shadow below is the app's own value
     (src/renderer/src/styles/index.css, and markMotion/problemCopy for the
     marks). Two copies on purpose: CSS custom properties for the widget's
     shadow root, and this object for the Docs popovers, which live in the
     page DOM and cannot see shadow CSS. Dark mode is deliberately absent —
     the app's dark tokens are --bg #0b0b0d / --surface #17171b / --text
     #f6f6f8 / --border rgba(255,255,255,.18) for whoever adds it. */
  const APP = {
    // The app ships NO webfont: it renders in the reader's system font, so
    // matching it means using the same stack, not bundling a face. The
    // extension used to load Plus Jakarta Sans, which is why the same
    // sentence looked like a different product in Docs.
    font: `'Instrument Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Roboto, Arial, sans-serif`,
    surface: "#ffffff", bg: "#f0f0f1", surface2: "rgba(0,0,0,.02)",
    text: "#000000", ink: "#1c1c1c", body: "#737373",
    muted: "rgba(0,0,0,.6)", label: "rgba(0,0,0,.56)", chipInk: "#55555c",
    border: "rgba(0,0,0,.18)", borderStrong: "rgba(0,0,0,.26)", hairline: "#d9d9d9",
    accent: "#f97316", accent2: "#f9a050",
    /* Accent as TEXT, not as a fill. #f97316 on white is 2.80:1 — under AA for
       body text, and the accent labels here are 10–12px. Same hue (24.6deg) and
       saturation, walked down to 4.87:1 on white and 4.55:1 on the accent wash.
       Fills, borders, dots and gradients keep the undarkened accent, so the two
       read as one colour. The desktop app sets `color: var(--accent)` directly
       in several places and has the same gap; it should take this token too. */
    accentInk: "#bd5005",
    accentGradient: "linear-gradient(164deg,#f47b20 0%,#f9a050 100%)",
    accentWash: "rgba(244,123,32,.07)", accentBorder: "rgba(244,123,32,.18)",
    ring: "rgba(244,123,32,.25)", danger: "#fb2c36",
    chipWash: "rgba(0,0,0,.07)",
    shadowSm: "0 1px 3px rgba(15,15,16,.06)",
    shadowCard: "0 8px 24px rgba(0,0,0,.18)",
    shadowLg: "0 20px 40px rgba(15,15,16,.16)",
    rCard: "16px", rBtn: "8px", rChip: "20px",
  };
  const JAKARTA = APP.font; // name kept where it is threaded through inline styles

  const WIDGET_CSS = `
    :host {
      all: initial;
      --surface: ${APP.surface}; --bg: ${APP.bg}; --surface-2: ${APP.surface2};
      --text: ${APP.text}; --ink: ${APP.ink}; --body: ${APP.body};
      --muted: ${APP.muted}; --label: ${APP.label}; --chip-ink: ${APP.chipInk};
      --border: ${APP.border}; --border-strong: ${APP.borderStrong}; --hairline: ${APP.hairline};
      --accent: ${APP.accent}; --accent-2: ${APP.accent2}; --accent-ink: ${APP.accentInk};
      --accent-gradient: ${APP.accentGradient}; --accent-wash: ${APP.accentWash};
      --accent-border: ${APP.accentBorder}; --ring: ${APP.ring}; --danger: ${APP.danger};
      --chip-wash: ${APP.chipWash};
      --shadow-sm: ${APP.shadowSm}; --shadow-card: ${APP.shadowCard}; --shadow-lg: ${APP.shadowLg};
      --r-card: ${APP.rCard}; --r-btn: ${APP.rBtn}; --r-chip: ${APP.rChip};
    }
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: ${JAKARTA}; -webkit-font-smoothing: antialiased; }
    .root { position: fixed; right: 22px; bottom: 22px; z-index: 2147483647; }
    /* ── Pill ─────────────────────────────────────────────────────────── */
    .pill {
      display: flex; align-items: center; gap: 8px; height: 40px;
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border); border-radius: 999px;
      padding: 0 14px 0 8px;
      box-shadow: var(--shadow-lg);
      cursor: pointer; user-select: none;
      font-size: 13px; font-weight: 600;
      transition: transform .1s ease, border-color .15s ease;
    }
    .pill:hover { transform: translateY(-1px); border-color: var(--border-strong); }
    .pill.quiet { color: var(--label); font-weight: 500; }
    .pill.quiet .plane { background: #c8c8cc; }
    .pill.orphan { cursor: default; color: var(--label); font-weight: 500; height: auto; min-height: 40px; padding: 8px 14px 8px 8px; white-space: normal; max-width: min(360px, calc(100vw - 44px)); }
    .pill.orphan:hover { transform: none; border-color: var(--border); }
    .plane {
      width: 24px; height: 24px; border-radius: 50%;
      background: var(--accent-gradient);
      display: flex; align-items: center; justify-content: center;
      color: #fff; flex-shrink: 0;
    }
    .plane svg { width: 13px; height: 13px; }
    /* The app's count chip: neutral, so the number carries the meaning. */
    .count, .badge {
      display: inline-flex; align-items: center; height: 20px; padding: 0 8px;
      background: var(--chip-wash); color: var(--chip-ink);
      border-radius: var(--r-chip);
      font-size: 11px; font-weight: 600; letter-spacing: .02em; font-variant-numeric: tabular-nums;
    }
    .count.off { color: var(--label); }

    /* ── Launcher (Figma "Collapsed Launcher" 267:64) ──────────────────────
       The desktop overlay's launcher, value for value (OverlayApp.tsx): a
       56px ink circle, the mark turned white, and a 31px count badge 8.5px
       above the top edge and 3.5px past the right. The badge is orange
       because it counts findings; while checking it is grey "…", and with
       nothing flagged there is no badge at all, as in the frame. */
    .launcher {
      position: relative; width: 56px; height: 56px; border-radius: 50%;
      background: var(--ink); cursor: pointer; user-select: none;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 2px 10px rgba(0,0,0,.18);
      transition: box-shadow .12s ease, transform .12s ease;
      margin-left: auto;
    }
    .launcher:hover { box-shadow: 0 6px 18px rgba(0,0,0,.25); transform: scale(1.06); }
    .launcher:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    @media (prefers-reduced-motion: reduce) { .launcher, .launcher:hover { transition: none; transform: none; } }
    .launch-mark { width: 22px; height: auto; display: block; filter: brightness(0) invert(1); pointer-events: none; }
    .launch-plane { width: 22px; height: 22px; color: #fff; display: flex; }
    .launch-plane svg { width: 100%; height: 100%; }
    .launcher .count {
      position: absolute; top: -8.5px; right: -3.5px; min-width: 31px; height: 31px; padding: 0 8px;
      border-radius: 999px; border: 2px solid #fff; background: ${MARK_COLORS.questionable}; color: #fff;
      font-size: 16px; font-weight: 600; letter-spacing: 0;
      display: flex; align-items: center; justify-content: center;
    }
    .launcher .count.off { background: #9a9ba1; font-size: 12px; }
    .launcher .count.ok { display: none; }

    /* ── Panel ────────────────────────────────────────────────────────── */
    /* ── Panel (Figma "Widget over Document" 282:70) ─────────────────────
       480 wide, 1px ink border, 24px radius, 22/24 padding, a hairline under
       the header inset to the content width. Capped to the viewport: a 480px
       card does not fit beside a narrow Docs window. */
    .panel {
      position: absolute; right: 0; bottom: 70px;
      width: min(480px, calc(100vw - 44px)); max-height: min(620px, calc(100vh - 120px));
      background: var(--surface); border: 1px solid #000; border-radius: 24px;
      box-shadow: 0 8px 12px rgba(0,0,0,.18);
      display: flex; flex-direction: column; overflow: hidden;
    }
    /* The header is the panel's handle (wireDrag): a grip, the name, and the
       close; the counts sit under it (.tally) and carry the rule. */
    .head {
      display: flex; align-items: center; gap: 8px;
      margin: 0 24px; padding: 18px 0 10px; cursor: grab; user-select: none; touch-action: none;
    }
    .panel.dragging { box-shadow: 0 16px 36px rgba(0,0,0,.24); }
    .panel.dragging .head { cursor: grabbing; }
    .grip { display: flex; color: #b9bac0; margin-left: -4px; }
    .head:hover .grip { color: #6b6c72; }
    .head .name { font-weight: 600; font-size: 18px; color: #1a1a1f; white-space: nowrap; }
    .tally { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 24px; padding: 0 0 14px; border-bottom: 1px solid #e7e7e7; }
    .chip {
      display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px 0 8px;
      border-radius: 999px; border: 1px solid var(--border); background: var(--surface);
      font-family: inherit; font-size: 12px; font-weight: 600; color: var(--ink); cursor: pointer;
      font-variant-numeric: tabular-nums; line-height: 1;
      transition: border-color .15s cubic-bezier(.2,.8,.2,1), background-color .15s cubic-bezier(.2,.8,.2,1);
    }
    .chip:hover { border-color: var(--border-strong); background: var(--surface-2); }
    .chip-ico { display: inline-flex; width: 12px; height: 12px; flex-shrink: 0; }
    .chip-ico svg { width: 12px; height: 12px; display: block; }
    .chip-clear { cursor: default; font-weight: 500; color: var(--ink); }
    .chip-clear:hover { border-color: var(--border); background: var(--surface); }
    .close {
      margin-left: 8px; flex-shrink: 0; width: 30px; height: 30px; border-radius: 50%;
      border: none; background: #f2f2f2; color: #1a1a1f; cursor: pointer;
      font-size: 17px; font-weight: 500; line-height: 1; font-family: inherit;
      display: flex; align-items: center; justify-content: center;
    }
    .close:hover { background: #e7e7e7; }
    /* The one legend (never colour alone): what each underline's LINE means. */
    .legend { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 2px 4px 0; font-size: 12px; color: #6b6c72; flex-shrink: 0; }
    .legend-item { display: inline-flex; align-items: center; gap: 6px; }
    .legend-line { display: inline-block; width: 22px; border-radius: 1px; }
    .legend-ico { display: inline-flex; width: 12px; height: 12px; }
    .legend-ico svg { width: 12px; height: 12px; display: block; }
    /* Evidence suggestions: neutral on purpose — not a finding, so no finding colour. */
    .evidence { display: flex; flex-direction: column; gap: 10px; flex-shrink: 0; padding-top: 4px; border-top: 1px solid #ededed; }
    .ev-toggle { align-self: flex-start; display: inline-flex; align-items: center; min-height: 28px; border: none; background: none; padding: 4px 0; font: inherit; font-size: 12px; font-weight: 500; line-height: 1.3; color: var(--ink); cursor: pointer; border-radius: 4px; }
    .ev-toggle:hover { text-decoration: underline; text-underline-offset: 2px; }
    .ev-intro { font-size: 12px; color: #6b6c72; margin-top: -6px; padding: 0 2px; }
    /* Resume tips: neutral, like evidence suggestions — writing advice, not a finding. */
    /* The list's groups — Claims, Citations, Writing feedback — each a name
       and its cards; the name is chrome, so ink, never a finding colour. */
    .tips { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
    .tips + .tips { margin-top: 6px; }
    .tips-head { font-size: 12px; font-weight: 600; color: #6b6c72; letter-spacing: .01em; padding: 2px 2px 0; }
    .genre-line { font-size: 12px; color: #6b6c72; padding: 0 2px; flex-shrink: 0; }
    .head .autosrc { flex-shrink: 0; }
    .status { margin-left: auto; font-size: 12px; font-weight: 400; color: #8a8b90; max-width: 170px; text-align: right; }
    .status.error { color: var(--danger); }
    .selects { display: flex; gap: 6px; padding: 9px 16px; border-bottom: 1px solid var(--border); align-items: center; }
    .foot .act { padding: 5px 10px; font-size: 11px; }
    .foot-left { display: flex; align-items: center; gap: 10px; }
    select {
      height: 32px; padding: 0 26px 0 10px; font-size: 13px; font-weight: 500; font-family: ${JAKARTA}; line-height: 1;
      border: 1px solid var(--border-strong); border-radius: var(--r-btn);
      background: var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%231c1c1c' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") no-repeat right 8px center / 12px 12px;
      color: var(--text); outline: none; cursor: pointer; appearance: none; -webkit-appearance: none;
      transition: border-color .15s cubic-bezier(.2,.8,.2,1), box-shadow .15s cubic-bezier(.2,.8,.2,1);
    }
    select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring); }
    .list { overflow-y: auto; padding: 16px 24px; display: flex; flex-direction: column; gap: 10px; }
    .empty { text-align: center; color: var(--body); font-size: 13px; line-height: 18.2px; padding: 28px 12px; }

    /* ── Cards ────────────────────────────────────────────────────────── */
    /* Each card is its own box, so where one ends is never a guess; the
       open one (foldCards) is drawn a shade firmer, the folded ones are a
       title and one line of why it was flagged (the sentence itself when a
       card has no reason), so the writer can choose which to open. Focus is
       the primitives' ink ring at the end of this sheet. */
    .card {
      background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
      padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
      transition: background-color .15s cubic-bezier(.2,.8,.2,1), border-color .15s cubic-bezier(.2,.8,.2,1);
    }
    .card[aria-expanded="true"] { border-color: var(--border-strong); box-shadow: var(--shadow-sm); }
    .card.shut { gap: 4px; padding: 10px 14px; cursor: pointer; }
    .card.shut:hover { background: var(--surface-2); border-color: var(--border-strong); }
    .card.shut > :not(.top):not(.expl) { display: none; }
    .card.shut .expl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
    .card.shut:not(:has(.expl)) > .quote { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .top { display: flex; align-items: center; gap: 8px; }
    /* The dot replaces the left colour bar; the title beside it says the same
       thing in words, so colour is never the only carrier. */
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #9a9ba1; flex-shrink: 0; }
    /* MARK_COLORS, so a card's dot matches the underline that raised it. */
    .d-false { background: #d93636; }
    .d-quest { background: #ff5900; }
    .d-inco { background: #d93636; }
    .d-cite { background: #ffb800; }
    /* A flow issue is advice, not a finding: the pending grey (MARK_PENDING). */
    .d-flow { background: #9a9ba1; }
    /* FEATURES: the switched-off controls are drawn and then hidden here, so
       render() stays the code server/test exercises. */
    ${FEATURES.citeHintsToggle ? "" : "label.autosrc:has(#citeTgl) { display: none; }"}
    ${FEATURES.autoSources ? "" : "label.autosrc:has(#autoSrcTgl) { display: none; }"}
    ${FEATURES.deepDive ? "" : ".deep, .deep-row { display: none; }"}
    .ctitle { font-size: 14px; font-weight: 600; line-height: 20px; color: var(--ink); min-width: 0; }
    .x {
      margin-left: auto; flex-shrink: 0; width: 24px; height: 24px; padding: 0;
      display: inline-flex; align-items: center; justify-content: center; border-radius: 6px;
      background: none; border: none; color: var(--label); cursor: pointer; font-size: 14px; line-height: 1; font-family: inherit;
      transition: color .15s cubic-bezier(.2,.8,.2,1), background-color .15s cubic-bezier(.2,.8,.2,1);
    }
    .x:hover { color: var(--text); background: var(--surface-2); }
    /* The writer's own words in ink, set off by a rule; the reason under it is
       muted — ink, muted and label are the card's only three greys. */
    .quote { font-size: 13px; line-height: 1.5; color: var(--ink); padding-left: 10px; border-left: 2px solid var(--border); }
    .expl { font-size: 13px; line-height: 1.5; color: var(--muted); }

    /* ── Insets (deep dive, suggested revision) ───────────────────────── */
    .deep, .fix {
      background: var(--surface-2); border: 1px solid var(--border);
      border-radius: var(--r-btn); padding: 10px 12px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .deep-row { margin: -2px 0 0; }
    .deep-btn {
      display: inline-flex; align-items: center; height: 32px; padding: 0 12px; line-height: 1;
      background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-btn);
      font-family: ${JAKARTA}; font-size: 13px; font-weight: 500;
      color: var(--ink); cursor: pointer;
      transition: background-color .15s cubic-bezier(.2,.8,.2,1), border-color .15s cubic-bezier(.2,.8,.2,1);
    }
    .deep-btn:hover { background: rgba(0,0,0,.04); }
    .deep-btn.locked { color: var(--label); cursor: not-allowed; }
    .deep-btn.locked:hover { background: var(--surface); color: var(--label); }
    .deep-pro {
      display: inline-flex; align-items: center; margin-left: 6px; height: 16px; line-height: 16px; padding: 0 5px;
      border-radius: var(--r-chip); background: var(--accent-wash); color: var(--accent-ink);
      font-size: 11px; font-weight: 600; letter-spacing: .04em; vertical-align: middle;
    }
    .deep-label, .fix-label, .sources-title {
      font-size: 11px; font-weight: 600; color: var(--label); letter-spacing: .01em;
    }
    .deep .badge { align-self: flex-start; }
    .deep-prefix { font-size: 13px; font-weight: 600; color: var(--ink); }
    .deep-sub { margin-top: 6px; }
    .deep .row { margin-top: 4px; }
    .deep-text, .fix-text { font-size: 13px; line-height: 18.2px; color: var(--body); white-space: pre-line; }
    .fix-text { white-space: normal; }
    .deep-note { font-size: 11px; color: var(--label); }
    .deep-note.err { color: var(--danger); }
    .deep-note a { color: var(--accent-ink); font-weight: 500; text-decoration: none; }
    .deep-note a:hover { text-decoration: underline; }
    .deep-loading { flex-direction: row; align-items: center; gap: 8px; font-size: 13px; color: var(--body); }
    .deep-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--accent-border); border-top-color: var(--accent); animation: deepspin .8s linear infinite; flex-shrink: 0; }
    @keyframes deepspin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .deep-spin { animation: none; } }
    /* A card's actions sit at their own width, the one it asks for first and
       filled: a full-width bar per button outweighed the advice. */
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    .row > button.act { flex: 0 0 auto; }
    .edit-note { font-size: 11px; color: var(--label); }
    .undo-strip {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      font-size: 12px; font-weight: 500; color: var(--ink);
      background: var(--surface-2); border: 1px solid var(--border);
      border-radius: var(--r-btn); padding: 6px 8px 6px 12px;
    }
    .undo-strip button.act { padding: 5px 10px; font-size: 11px; }
    /* The live search: its sites' icons in the panel card, and the "Sources
       ready" note over the launcher (ink only — colour is for findings). */
    .live-strip { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    .live-strip img { width: 16px; height: 16px; border-radius: 4px; background: var(--surface-2); }
    .live-strip img.faded { opacity: .35; }
    .ready-ping {
      display: flex; align-items: center; gap: 8px; margin: 0 0 10px auto; max-width: 320px;
      font-size: 12px; font-weight: 500; color: var(--ink);
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-btn);
      padding: 6px 6px 6px 12px; box-shadow: var(--shadow-lg);
    }
    .ready-ping .ready-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ready-ping button.act { padding: 5px 10px; font-size: 11px; flex-shrink: 0; }
    .fix-ping .ready-text { display: inline-flex; align-items: center; gap: 6px; }
    /* "Let Tracely fix these" (Docs): the undo strip's shape, ink only. */
    .walk-strip {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      font-size: 12px; font-weight: 500; color: var(--ink);
      background: var(--surface-2); border: 1px solid var(--border);
      border-radius: var(--r-btn); padding: 6px 8px 6px 12px;
    }
    .walk-strip button.act { padding: 5px 10px; font-size: 11px; flex-shrink: 0; }
    /* "Let Tracely fix these": the prepared changes, each waiting for the
       writer. Ink only — a removed word struck through, an added one
       underlined; the dot is the flag's own finding colour. */
    .fixes { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2); }
    .fixes-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .fixes-title { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--ink); }
    .fixes-acts { display: inline-flex; gap: 6px; }
    .fixes-acts button.act { padding: 5px 12px; font-size: 12px; }
    .fixes-note { font-size: 11.5px; color: #6b6c72; }
    .fx { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid #ececec; border-radius: 10px; background: var(--surface); }
    .fx-top { display: flex; align-items: center; gap: 8px; }
    .fx-title { font-size: 12.5px; font-weight: 600; color: #1a1a1f; }
    .fx-diff { font-size: 12.5px; line-height: 1.5; color: #55565c; }
    .fx-diff del { color: #8a8b90; text-decoration: line-through; }
    .fx-diff ins { color: var(--ink); text-decoration: none; font-weight: 600; background: #efeff2; border-radius: 3px; padding: 0 2px; }
    .fx-line { font-size: 11.5px; color: #55565c; }
    .fx-src { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: #55565c; min-width: 0; }
    .fx-src img { width: 14px; height: 14px; border-radius: 3px; flex-shrink: 0; }
    .fx-src span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fx-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #6b6c72; }
    .fx-applied { opacity: .75; }
    .fx-applied .fx-state { color: var(--ink); font-weight: 500; }
    .fx-skipped { opacity: .55; }
    .fx .row button.act { padding: 5px 12px; font-size: 12px; }

    /* ── Buttons: the app's .btn / .btn-dark ──────────────────────────── */
    /* The frame's pills: an ink fill, or a 1.5px ink outline. */
    button.act {
      display: inline-flex; align-items: center; justify-content: center; height: 32px; padding: 0 12px; line-height: 1;
      border: 1px solid var(--border-strong); background: var(--surface); color: var(--ink);
      border-radius: var(--r-btn);
      font-size: 13px; font-weight: 500; font-family: ${JAKARTA}; cursor: pointer; white-space: nowrap;
      transition: background-color .15s cubic-bezier(.2,.8,.2,1), border-color .15s cubic-bezier(.2,.8,.2,1), color .15s cubic-bezier(.2,.8,.2,1);
    }
    button.act:hover:not([disabled]) { background: rgba(0,0,0,.04); }
    button.act:active:not([disabled]) { background: rgba(0,0,0,.08); }
    button.act.primary { background: var(--ink); border-color: var(--ink); color: #fff; }
    button.act.primary:hover:not([disabled]) { background: #000; border-color: #000; color: #fff; }
    button.act.primary:active:not([disabled]) { background: #000; border-color: #000; }
    button.act[disabled] { opacity: .5; cursor: not-allowed; }

    /* ── Sources ──────────────────────────────────────────────────────── */
    .sources { border-top: 1px solid var(--border); padding-top: 10px; display: flex; flex-direction: column; gap: 4px; }
    .src { display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px; border-radius: var(--r-btn); }
    .src:hover { background: var(--surface-2); }
    .stance {
      font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: var(--r-chip);
      margin-top: 2px; flex-shrink: 0;
      background: var(--chip-wash); color: var(--chip-ink);
    }
    .st-supports { color: #1f7a4d; }
    .st-refutes { color: #b02a2a; }
    .st-context { color: var(--chip-ink); }
    .st-manual { color: #245d99; }
    .src-ico { width: 20px; height: 20px; flex-shrink: 0; margin-top: 1px; border-radius: 6px; border: 1px solid #e5e5e5; background: #fff; display: flex; align-items: center; justify-content: center; overflow: hidden; }
    .src-ico:empty { display: none; }
    .src-ico img { width: 14px; height: 14px; display: block; }
    .src-body { flex: 1; min-width: 0; }
    .src a { font-size: 13px; font-weight: 500; color: var(--ink); text-decoration: none; display: block; }
    .src-title { font-size: 13px; font-weight: 500; color: var(--ink); display: block; }
    .src a:hover { color: var(--accent-ink); }
    .src-meta { font-size: 11px; color: var(--label); }
    .src-snip { font-size: 12px; line-height: 16.8px; color: var(--body); }
    .src-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    /* The receipt: the source's own words, and where they were read. */
    .src-says { font-size: 12px; line-height: 16.8px; color: var(--ink); margin-top: 2px; user-select: text; }
    .src-from { font-size: 10.5px; color: var(--label); margin-top: 2px; }
    .src-unread { margin-top: 6px; display: flex; flex-direction: column; gap: 2px; }
    .src-unread-toggle { align-self: flex-start; display: inline-flex; align-items: center; min-height: 28px; background: none; border: none; padding: 4px 0; font: inherit; font-size: 12px; font-weight: 500; line-height: 1.3; color: var(--muted); cursor: pointer; text-align: left; border-radius: 4px; }
    .src-unread-toggle:hover { color: var(--ink); text-decoration: underline; text-underline-offset: 2px; }
    .src a.src-open {
      display: inline-flex; align-items: center; height: 28px; padding: 0 10px; line-height: 1;
      font-size: 12px; font-weight: 500; color: var(--ink);
      border: 1px solid var(--border-strong); border-radius: var(--r-btn); background: var(--surface);
      transition: background-color .15s cubic-bezier(.2,.8,.2,1), border-color .15s cubic-bezier(.2,.8,.2,1);
    }
    .src a.src-open:hover { background: var(--surface-2); color: var(--ink); }
    .loading { font-size: 13px; color: var(--body); }
    .cite-url { display: flex; gap: 8px; }
    .cite-url input {
      flex: 1; min-width: 0; height: 32px; padding: 0 10px; font-size: 13px; line-height: 1;
      border: 1px solid var(--border-strong); border-radius: var(--r-btn); outline: none;
      color: var(--text); background: var(--surface); font-family: ${JAKARTA};
      transition: border-color .15s cubic-bezier(.2,.8,.2,1), box-shadow .15s cubic-bezier(.2,.8,.2,1);
    }
    .cite-url input::placeholder { color: var(--label); opacity: 1; }
    .cite-url input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring); }
    .autosrc { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 500; color: var(--label); cursor: pointer; user-select: none; }
    .autosrc input { width: 14px; height: 14px; margin: 0; flex-shrink: 0; accent-color: var(--accent); cursor: pointer; }
    .foot { margin: 0 24px; padding: 12px 0 18px; border-top: 1px solid #e7e7e7; font-size: 11px; color: var(--label); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    /* The panel eases up out of the pill when it opens (re-renders while it
       stays open don't replay it). Reduced motion: it just appears. */
    .panel.opening { animation: tracely-panel-in 170ms cubic-bezier(0.2, 0.8, 0.2, 1) both; transform-origin: 100% 100%; }
    @keyframes tracely-panel-in {
      from { opacity: 0; transform: translateY(8px) scale(0.98); }
      to { opacity: 1; transform: none; }
    }
    @media (prefers-reduced-motion: reduce) { .panel.opening { animation: none; } }
    .card.flash { animation: tracely-flash 1.2s ease-out; }
    @keyframes tracely-flash {
      0% { box-shadow: 0 0 0 3px var(--ring); }
      100% { box-shadow: none; }
    }

    /* ── Primitives: focus, scrollbar, motion ─────────────────────────────
       Shared recipes, appended so they win over the sections above: the
       small button in strips and footers, one ink focus ring for every
       control that is not a text field (those keep the accent ring), the
       list's thin scrollbar, and the one reduced-motion block. */
    .foot .act, .undo-strip .act, .ready-ping .act, .walk-strip .act, .fixes-acts .act, .fx .row .act, .src-actions .act { height: 28px; padding: 0 10px; font-size: 12px; }
    button.act:focus-visible, .deep-btn:focus-visible, .chip:focus-visible, .card.shut:focus-visible, .launcher:focus-visible, .close:focus-visible, .x:focus-visible, .pill:focus-visible,
    .ev-toggle:focus-visible, .src-unread-toggle:focus-visible, .src a.src-open:focus-visible, .autosrc input:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
    .list { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
    .list::-webkit-scrollbar { width: 8px; }
    .list::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; border: 2px solid var(--surface); }
    .list::-webkit-scrollbar-track { background: transparent; }
    @media (prefers-reduced-motion: reduce) {
      .launcher, .launcher:hover, .pill, .pill:hover, button.act, .chip, .deep-btn, .x, .src a.src-open, select, .cite-url input { transition: none; transform: none; }
      .panel.opening, .card.flash, .deep-spin { animation: none; }
    }
  `;

  function makeWidget() {
    const host = document.createElement("div");
    host.id = "tracely-host";
    const shadow = host.attachShadow({ mode: "open" });
    document.documentElement.appendChild(host);
    const style = document.createElement("style");
    style.textContent = WIDGET_CSS;
    shadow.appendChild(style);
    const root = document.createElement("div");
    root.className = "root";
    shadow.appendChild(root);
    return { host, shadow, root };
  }

  function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function lsSet(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } } // false: sandboxed page or quota
  function lsDel(key) { try { localStorage.removeItem(key); } catch { /* sandboxed */ } }
  function jsonParse(raw, fallback) { try { return JSON.parse(raw); } catch { return fallback; } }

  /* The Docs widget's persisted verdicts (vcache) and flow issues (fcache)
     are keyed by doc and sentence hash only, and a sentence already in the
     cache is never re-checked. Everything saved before 2026-09-21 came from
     gpt-5-nano, which never flagged an uncited statistic and called some false
     claims accurate — so those keys are retired (the "2" generation replaces
     them) and deleted once, and the first open after this update re-checks
     every sentence on the current models. Source lists (scache) are search
     results, not verdicts, and dismissals are the user's own: both are kept.
     Bump CACHE_GEN when a model change should invalidate verdicts again. */
  const CACHE_GEN = "2";
  const VERDICT_CACHE = /^tracely\.widget\.(?:vcache|fcache|rcache)(\d*)\./; // group 1: the generation, "" before 2
  function sweepRetiredCaches() {
    if (lsGet("tracely.widget.cacheGen") === CACHE_GEN) return;
    try {
      for (const k of Object.keys(localStorage)) {
        const m = VERDICT_CACHE.exec(k);
        if (m && m[1] !== CACHE_GEN) lsDel(k);
      }
    } catch { return; } // sandboxed: nothing was readable, so try again next load
    lsSet("tracely.widget.cacheGen", CACHE_GEN);
  }

  if (harness || IS_DOCS) docsMode();
  else fieldMode();

  /* ════════════════════════════════════════════════════════════════════════
     DOCS MODE — the original Google Docs widget, behavior unchanged.
     ════════════════════════════════════════════════════════════════════════ */
  // TEST ANCHOR (server/test/ext-*) — do not rename or re-indent the next line.
  function docsMode() {
    const DOC_ID = harness ? "harness" : (location.pathname.match(/\/document\/(?:u\/\d+\/)?d\/([^/]+)/)?.[1] ?? null);
    if (!DOC_ID) return;
    const ACCOUNT_PREFIX = harness ? "" : docAccountPrefix(
      (() => { try { return performance.getEntriesByType("navigation")[0]?.name; } catch { return ""; } })(),
      location.href,
    );

    const SETTINGS_KEY = "tracely.widget.settings";
    const DISMISS_KEY = `tracely.widget.dismissed.${DOC_ID}`;
    const VCACHE_KEY = `tracely.widget.vcache${CACHE_GEN}.${DOC_ID}`;
    const SCACHE_KEY = `tracely.widget.scache.${DOC_ID}`;
    const FCACHE_KEY = `tracely.widget.fcache${CACHE_GEN}.${DOC_ID}`;
    const RCACHE_KEY = `tracely.widget.rcache${CACHE_GEN}.${DOC_ID}`; // the last review (reviewSnapshot)
    sweepRetiredCaches(); // before anything reads a cache

    /* ── consent: a Doc is checked only after the user turns Docs on ──────
       Opening a Doc used to start the export-and-check loop on its own —
       the whole document, to Tracely's server, every ten seconds, with no
       ask. The Web Store's user-data policy wants a prominent disclosure and
       consent before content leaves the page, and the listing's own line —
       "nothing runs on a site until you enable it" — was simply untrue here.
       So Docs now waits for one answer, given once per browser profile
       (chrome.storage "docsEnabled") and reversible on the options page,
       exactly as field mode waits for its per-site switch. Until then the
       pill offers the switch and nothing is exported, checked or sent. A
       plain test page has no extension storage and keeps the old behaviour. */
    const docsStorage = useRelay && typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
    let docsOn = harness || !docsStorage;
    if (docsStorage) {
      storageGet({ docsEnabled: false }, (st) => {
        docsOn = st.docsEnabled === true;
        if (widget) render();
        if (docsOn) cycle();
      });
      storageOnChanged((changes, area) => {
        if (area !== "local" || !changes.docsEnabled) return;
        docsOn = changes.docsEnabled.newValue === true;
        if (widget) render();
        if (docsOn) cycle();
      });
    }
    const DOCS_CONSENT_TEXT = "Tracely sends this document's text to Tracely's server (api.jointracely.com) to check its facts, every few seconds while you write. It is processed there and not stored. This turns on checking for every Google Doc you open; switch it off any time with Turn off in Tracely's panel, or in its options.";

    // ── state ──
    // Verdicts and source lists persist per doc: reopening the tab re-checks
    // NOTHING that hasn't changed (hash-keyed, stale entries just never
    // match) and never re-searches a claim it already has sources for.
    const cache = new Map(jsonParse(lsGet(VCACHE_KEY) ?? "[]", []));
    const dismissed = new Set(jsonParse(lsGet(DISMISS_KEY) ?? "[]", []));
    const sourcesMap = new Map(jsonParse(lsGet(SCACHE_KEY) ?? "[]", [])
      .map(([h, st]) => [h, { loading: false, list: backingSources(st.list, cache.get(h)?.verdict).list, unread: backingSources(st.unread, cache.get(h)?.verdict).unread, copiedUrl: null, citedUrl: st.citedUrl ?? null }]));
    /* ── flow coaching state ──────────────────────────────────────────────
       Flow is judged on the SHAPE of the document, so it re-runs only when
       the paragraph structure actually changes — not on every keystroke like
       the sentence checker. One fast-model call per structural change, cached
       across reloads, so the whole feature costs a fraction of a cent. */
    const flowSaved = jsonParse(lsGet(FCACHE_KEY) ?? "null", null);
    let flowIssues = FEATURES.flow && Array.isArray(flowSaved?.issues) ? flowSaved.issues : [];
    let flowSig = String(flowSaved?.sig ?? "");
    let flowAt = 0;
    let flowInflight = false;
    let flowDismissed = new Set(Array.isArray(flowSaved?.dismissed) ? flowSaved.dismissed : []);
    const FLOW_MIN_CHARS = harness ? 0 : 400; // below this there's no structure to judge
    // Opt-in escape hatch, read once. See the comment at the draw site.
    const FLOW_IN_DOC = lsGet("tracely.flowInDoc") === "1";
    /* Never more than one flow call per 125 s. The server's floor is 120 s
       (shared/plan.js FLOW_MIN_INTERVAL_MS answers faster callers 429), and
       the 5 s is margin: this clock starts when the request is SENT and the
       server's starts when it ARRIVES, so two sends exactly 120 s apart land
       under the floor whenever the second call's latency is lower than the
       first's. The 429 is swallowed, so the cost of being a hair early is
       that a structural change waits another whole interval. */
    const FLOW_MIN_INTERVAL = 125_000;

    // Signature of the document's SHAPE: paragraph count plus each one's
    // opening and closing words. Editing inside a sentence doesn't move it;
    // adding, cutting, or reordering a paragraph does.
    // The LAST paragraph contributes its opening words and a COARSE length
    // bucket instead of its closing words: that is where the writer is
    // typing, and every keystroke at the end of the document used to count
    // as a new shape and re-run flow. The bucket keeps single keystrokes
    // silent while still moving once a whole block of prose has landed.
    // Without it, a draft written as ONE paragraph — the shape that most
    // needs flow feedback — has a signature nothing can ever change, so flow
    // runs once on its first 400 characters and never again (flowSig is
    // persisted, so that stays true across reloads).
    const FLOW_TAIL_WORDS = 50; // words the last paragraph must gain to count as a new shape
    function flowSignature(text) {
      const paras = text.split(/\n{1,}/).map((p) => p.trim()).filter((p) => p.split(/\s+/).length >= 12);
      return paras.length + "|" + paras.map((p, i) => {
        const w = p.split(/\s+/);
        const close = i === paras.length - 1 ? "~" + Math.floor(w.length / FLOW_TAIL_WORDS) : w.slice(-3).join(" ");
        return w.slice(0, 4).join(" ") + "…" + close;
      }).join("¶");
    }

    function persistFlow() {
      lsSet(FCACHE_KEY, JSON.stringify({ sig: flowSig, issues: flowIssues, dismissed: [...flowDismissed] }));
    }

    function flowHashOf(issue) { return "flow" + hashText(issue.passage); }

    function activeFlowIssues() {
      return flowIssues.filter((i) => !flowDismissed.has(flowHashOf(i)));
    }

    async function requestFlow() {
      if (flowInflight || document.hidden) return;
      const text = docText;
      if (text.length < FLOW_MIN_CHARS) { // too short to have a shape
        if (flowIssues.length) { flowIssues = []; flowSig = ""; persistFlow(); scheduleDocsMarks(); }
        return;
      }
      const sig = flowSignature(text);
      if (sig === flowSig) return;                            // structure unchanged — cached answer stands
      if (Date.now() - flowAt < FLOW_MIN_INTERVAL) return;    // rate floor
      flowInflight = true;
      flowAt = Date.now();
      try {
        // The model and no effort: the server pins flow to the fast model at
        // low whatever a request says (shared/plan.js modelForRoute).
        const data = await api("/api/flow", { text: text.slice(0, MAX_INPUT_CHARS), model: CHECK_MODEL });
        flowIssues = Array.isArray(data.issues) ? data.issues : [];
        flowSig = sig;
        persistFlow();
        render();
        scheduleDocsMarks();
      } catch {
        // Flow is an enhancement — a failure must never disturb the checker's
        // status line. That includes the server's 429 "flow_rate" (another
        // tab or an old build asked within 120 s) and the daily flow quota:
        // silent, and since flowSig was not advanced, retried one interval
        // later (flowAt was stamped before the call) if the shape still differs.
      } finally {
        flowInflight = false;
      }
    }

    function persistCaches() {
      // Doc-aware eviction: verdicts for sentences STILL IN the doc are what
      // stop reload re-checks — persist those first, pad with recent others.
      // Blind slice(-400) on a long doc evicted live verdicts and re-spent
      // API calls on every reload, forever.
      const live = new Set(segments.map((s) => s.hash));
      const entries = [...cache];
      const keep = entries.filter(([h]) => live.has(h)).slice(-400);
      if (keep.length < 400) {
        keep.push(...entries.filter(([h]) => !live.has(h)).slice(-(400 - keep.length)));
      }
      const src = [...sourcesMap]
        .filter(([, st]) => st.list?.length)
        .map(([h, st]) => [h, { list: st.list.slice(0, 5), unread: (st.unread ?? []).slice(0, 5), citedUrl: st.citedUrl ?? null }]);
      let ok = lsSet(VCACHE_KEY, JSON.stringify(keep));
      ok = lsSet(SCACHE_KEY, JSON.stringify(src.slice(-20))) && ok;
      if (!ok) {
        // Quota (shared with Google Docs' own storage): drop other docs'
        // Tracely caches, then retry once at reduced size. Never throw.
        try {
          for (const k of Object.keys(localStorage)) {
            if (/^tracely\.widget\.(vcache\d*|scache|rcache\d*)\./.test(k) && k !== VCACHE_KEY && k !== SCACHE_KEY && k !== RCACHE_KEY) lsDel(k);
          }
        } catch { /* sandboxed */ }
        lsSet(VCACHE_KEY, JSON.stringify(keep.slice(-100)));
        lsSet(SCACHE_KEY, JSON.stringify(src.slice(-5)));
      }
    }
    // LRU registry of docs holding Tracely caches — GC the oldest beyond 20
    // so dead docs never fill the origin's localStorage (shared with Docs).
    {
      const REG_KEY = "tracely.widget.docs";
      const reg = jsonParse(lsGet(REG_KEY) ?? "[]", []).filter((e) => Array.isArray(e) && e[0] !== DOC_ID);
      reg.push([DOC_ID, Date.now()]);
      reg.sort((a, b) => a[1] - b[1]);
      while (reg.length > 20) {
        const [old] = reg.shift();
        lsDel(`tracely.widget.vcache${CACHE_GEN}.${old}`);
        lsDel(`tracely.widget.scache.${old}`);
        lsDel(`tracely.widget.fcache${CACHE_GEN}.${old}`); // flow issues were never collected here
        lsDel(`tracely.widget.rcache${CACHE_GEN}.${old}`);
        lsDel(`tracely.widget.dismissed.${old}`);
      }
      lsSet(REG_KEY, JSON.stringify(reg));
    }
    let settings = loadSettings(SETTINGS_KEY);
    let segments = [];
    let citedLater = new Set(); // sentences a later citation in their paragraph covers
    let inflight = false;
    let sourcesInflight = false;
    let lastCheckEnd = Date.now();
    let lastTextChangeAt = Date.now(); // drives nextReadGap: read fast while the doc is changing
    let lastCheckFailed = false;
    let prevHashes = new Set();        // sentence hashes on the previous read (readyToSend's settle rule)
    const heldHashes = new Map();      // ids the server left out — see holdOmitted
    let statusMsg = "starting…";
    let statusKind = "idle"; // idle | checking | error | offline
    let orphaned = false; // the extension was reloaded under this tab — see standDown
    let expanded = false;
    let showEvidence = false; // the evidence section starts folded: offered, never pushed
    let docGenre = "prose";   // detectGenre of the last read: "resume" turns on Resume tips
    const review = { lastText: null, findings: [], at: 0, okAt: 0, inflight: false, unavailable: false, serving: null, kind: null, seen: new Map() };
    restoreReview(review, lsGet(RCACHE_KEY)); // the same text reads back the same notes, without a new review
    function persistReview() {
      const snap = reviewSnapshot(review);
      if (snap) lsSet(RCACHE_KEY, JSON.stringify(snap)); // full storage: the next reload reviews again, as before
    }
    let copiedTipId = null;
    /* Ask /api/review for this resume's bullet and typo notes — only for a
       resume, only once the text has been still REVIEW_IDLE_MS, only when a
       line is new or rewritten since the last answer (reviewWorthwhile), at
       most every REVIEW_FLOOR_MS and REVIEW_REPEAT_MS after an answer. A
       server without the route (404 not_found) switches it off until reload;
       any other failure waits out the floor and tries again. The free format
       rules (resumeFormatIssues) show either way. */
    async function requestReview(text) {
      const kind = reviewKindFor(docGenre);
      if (!kind || review.inflight || review.unavailable) return;
      // A document that changed kind (a resume pasted over an essay) starts over.
      if (review.kind !== kind) Object.assign(review, { kind, lastText: null, findings: [], at: 0, okAt: 0, seen: new Map() });
      if (!reviewWorthwhile(review.lastText, text) || Date.now() - lastTextChangeAt < REVIEW_IDLE_MS || Date.now() - review.at < REVIEW_FLOOR_MS || Date.now() - review.okAt < REVIEW_REPEAT_MS) return;
      review.inflight = true;
      render();
      try {
        const data = await api("/api/review", { text: text.slice(0, REVIEW_MAX_CHARS), model: CHECK_MODEL, kind });
        const found = Array.isArray(data?.findings) ? data.findings : [];
        review.findings = review.lastText == null ? found : carryReviewNotes(review.findings, review.lastText, found, text); // untouched paragraphs keep their notes
        if (kind === "essay") for (const t of essayFeedbackTips(text, review.findings, new Set())) review.seen.set(t.id, t);
        review.lastText = text;
        review.okAt = Date.now();
        review.serving = data?.genre === "resume"; // the model disagrees that it is one: back to the check
        persistReview();
      } catch (err) {
        review.serving = false; // until a review answers again, the check covers the resume
        if (err?.kind === "not_found") review.unavailable = true;
      } finally {
        review.at = Date.now();
        review.inflight = false;
        render();
      }
    }
    let panelWasOpen = false; // so only the render that OPENS the panel animates it
    let docText = "";
    let copiedFixHash = null; // survives re-renders, unlike a bare textContent swap
    let bridgeReady = false;  // Docs bridge configured server-side (developer builds) → in-doc edit buttons
    let docBusy = false;      // one document edit at a time, across every button
    // The in-editor engine's last ping (docs-hook.js). editable = its text API
    // is there and the editor doesn't look view-only; the read-back after each
    // edit is the real test.
    let inDoc = { api: false, editable: false, editor: false, viewOnly: false, mode: "unknown", ok: false };
    let lastPingAt = 0;
    // Per-button edit state, keyed "fix:<hash>" / "cite:<hash>:<url>" / "flow:<hash>":
    // { state: "applying" | "applied" | "undoing" | "failed", copied?, note? }
    const docEditState = new Map();
    let lastDocEdit = null;   // { key, tokens, onUndone, label } — the one edit the Undo button reverses
    const editedHashes = new Map(); // sentence hash → when we rewrote it (export lags; don't re-check the old text)
    const popEditSyncs = new Set(); // popover edit buttons re-sync on every state change
    let autoSourceTimes = []; // rolling-hour guard on automatic source lookups
    /* "Find the cited work": a card's key (a sentence's hash, or a tip's id)
       → its lookup ({ loading } | lookupCitedWork's answer, with the target
       and plan it was made for). citedFallback: a sentence's hash → the
       citation in it a card found at fault, so a source cited from the
       search that follows takes its place (docCite) instead of sitting beside
       it. For this page session only; nothing here is persisted. */
    const citedMap = new Map();
    const citedFallback = new Map();
    let copiedCitedKey = null; // "key:i" of the last Copy reference, for its ✓

    // ── doc reading ──
    let exportBackoff = 0, exportPausedUntil = 0; // see exportBackoffMs
    async function getDocText() {
      if (harness) return harness.getText();
      const res = await fetch(docExportUrl(DOC_ID, ACCOUNT_PREFIX), {
        credentials: "same-origin",
      });
      if (res.status === 429) {
        exportBackoff = exportBackoffMs(exportBackoff, res.headers.get("retry-after"));
        exportPausedUntil = Date.now() + exportBackoff;
        throw Object.assign(new Error("Google is limiting how often this doc can be read"), { kind: "rate_limited" });
      }
      if (!res.ok) throw new Error(`doc export failed (${res.status})`);
      exportBackoff = 0;
      const t = await res.text();
      return t.replace(/^﻿/, "").replace(/\r\n/g, "\n");
    }

    // Cost idea 2: a sentence changed only by a typo or punctuation keeps
    // the verdict it had (smallEdit). The counts are for the console.
    let verdictsReused = 0, sentencesChecked = 0;
    function inheritVerdicts(before) {
      const live = new Set(segments.map((sg) => sg.hash));
      const taken = new Set();
      let n = 0;
      for (const seg of segments) {
        if (!seg.checkable || cache.has(seg.hash)) continue;
        const old = inheritedVerdict(seg, before, live, cache, taken);
        if (!old) continue;
        cache.set(seg.hash, cache.get(old.hash));
        if (dismissed.has(old.hash) && !dismissed.has(seg.hash)) {
          dismissed.add(seg.hash);
          lsSet(DISMISS_KEY, JSON.stringify([...dismissed]));
        }
        n++;
      }
      if (n) {
        verdictsReused += n;
        console.debug(`[tracely] reused ${n} verdict(s) after a small edit — ${verdictsReused} reused, ${sentencesChecked} sent to be checked on this page`);
      }
      return n;
    }

    function uncheckedSegments() {
      if (FEATURES.writingOnly && GENRE_QUIET.has(docGenre)) return []; // homework, a poem, a story, a script: nothing to check
      if (FEATURES.resumeTips && reviewCoversCheck(docGenre, review)) return []; // cost idea 5
      const out = [];
      const seen = new Set();
      for (const seg of segments) {
        if (!seg.checkable || seen.has(seg.hash)) continue;
        seen.add(seg.hash);
        if (cache.has(seg.hash) || editedHashes.has(seg.hash)) continue;
        if (isHeld(heldHashes, seg.hash, Date.now()) || !readyToSend(seg, prevHashes)) continue;
        out.push(seg);
      }
      return out;
    }

    async function cycle() {
      if (orphaned || inflight || document.hidden) return;
      if (!docsOn) return; // nothing leaves the page until Docs is turned on
      inflight = true;
      lastCheckFailed = false;
      try {
        const readAt = Date.now();
        const newText = await getDocText();
        if (newText !== docText) lastTextChangeAt = readAt;
        docText = newText;
        const before = segments;
        segments = segmentText(docText);
        docGenre = FEATURES.resumeTips ? detectGenre(docText) : "prose";
        // A sentence we rewrote stays hidden until the export stops showing it
        // (the edit has propagated) — or for 30s, if it never does (undone by hand).
        const liveHashes = new Set(segments.map((sg) => sg.hash));
        for (const [h, at] of editedHashes) if (!liveHashes.has(h) || Date.now() - at > 30_000) editedHashes.delete(h);
        settleEditStates(readAt);
        if (inheritVerdicts(before)) persistCaches();
        citedLater = coveredByLaterCitation(docText, segments);
        const todo = uncheckedSegments().slice(0, MAX_SENTENCES_PER_CHECK);
        prevHashes = new Set(segments.map((sg) => sg.hash)); // after todo: this read is "previous" from here on
        if (!settings.styleChosen) settings.citationStyle = docCitationStyle(docText) ?? "mla"; // cite the way the doc already does
        if (todo.length > 0) {
          statusKind = "checking";
          statusMsg = `checking ${todo.length}…`;
          render();
          sentencesChecked += todo.length;
          const data = await api("/api/check", {
            text: docText.slice(0, MAX_INPUT_CHARS),
            sentences: todo.map((s) => ({ id: s.hash, text: s.text })),
            model: CHECK_MODEL, // no effort: the server decides (the fast model at medium)
          });
          for (const f of data.findings ?? []) {
            cache.set(f.id, { verdict: f.verdict, explanation: f.explanation, revision: usableRevision(todo.find((x) => x.hash === f.id)?.text, f.revision), confidence: f.confidence });
          }
          holdOmitted(heldHashes, todo, data.findings, Date.now());
          persistCaches();
          autoFindSources(data.findings ?? []); // fire-and-forget, capped
        }
        statusKind = "idle";
        const n = currentIssues().length + activeFlowIssues().length;
        statusMsg = n > 0 ? `${n} issue${n === 1 ? "" : "s"} found` : "all clear";
        if (FEATURES.flow) requestFlow(); // fire-and-forget; gated on structure change + rate floor
        requestReview(docText); // fire-and-forget; resumes only, gated on stillness, a real change and the floors
      } catch (err) {
        lastCheckFailed = true;
        if (err?.kind === "rate_limited") {
          statusKind = "idle"; // not an error the writer can do anything about
          statusMsg = `Google is pacing reads of this doc — checking again in ${Math.round(exportBackoff / 1000)}s`;
        } else if (err?.kind === "no_engine") {
          statusKind = "offline";
          statusMsg = err.message;
        } else if (offlineError(err)) {
          statusKind = "offline";
          statusMsg = "Can't reach Tracely — checks will resume when the server is back";
        } else {
          statusKind = "error";
          statusMsg = err?.message ?? "check failed";
        }
      } finally {
        inflight = false;
        lastCheckEnd = Date.now();
        render();
      }
    }

    function currentIssues() {
      const out = [];
      const seen = new Set();
      for (const seg of segments) {
        if (!seg.checkable || seen.has(seg.hash)) continue;
        seen.add(seg.hash);
        const f = cache.get(seg.hash);
        if (!f || dismissed.has(seg.hash) || editedHashes.has(seg.hash) || !flagShown(f, settings, docGenre, seg.text, citedLater.has(seg.hash))) continue;
        out.push({ seg, f });
      }
      return out;
    }

    /* ── overlay underlines over the Docs canvas ──────────────────────────
       Docs paints text onto canvas tiles, so field mode's DOM techniques
       can't see it. docs-hook.js (page world, document_start) wraps the
       canvas text calls and keeps a ledger of what was painted where; we ask
       it to locate each flagged sentence and draw the same wavy underlines
       in a fixed overlay. If the hook finds nothing (Docs changed how it
       paints, hook not injected), nothing is drawn and the widget behaves
       exactly as before — this is strictly additive. */
    let locateSeq = 0;
    let lastVerdictByHash = new Map();
    let tipMarkById = new Map(); // cite_tip marks drawn on the last locate: id → citationMarks entry
    let coTipsByHash = new Map(); // a flagged sentence's hash → the notes it carries instead of drawing them (tipCoversSentence)

    /* ── PRIMARY position source: Docs' SVG annotation layer ──────────────
       Modern Docs keeps an invisible SVG beside each canvas tile: one
       <rect aria-label="line text" data-font-css="…"> per painted text run.
       It is ordinary DOM — every line is ALWAYS represented (no repaint
       churn, so never "one underline at a time") and getBoundingClientRect
       is always current (no locate round-trip, so no scroll lag). The
       canvas-paint hook remains only as a fallback for docs where this
       layer is absent. Matching logic mirrors the hook's (whitespace-free). */
    const nrm = (s) => s.toLowerCase().replace(/[​‌﻿ ]/g, " ").replace(/\s+/g, "");
    const SVG_STRIP = /[\s​‌﻿ ]/;
    function svgRawIndexAt(text, normIdx) {
      let n = 0;
      for (let i = 0; i < text.length; i++) {
        if (SVG_STRIP.test(text[i])) continue;
        if (n === normIdx) return i;
        n++;
      }
      return text.length;
    }
    function svgOverlapRange(L, S) {
      const i = L.indexOf(S);
      if (i >= 0) return [i, i + S.length];
      if (L.length >= 6 && S.includes(L)) return [0, L.length];
      const lim = Math.min(L.length, S.length);
      for (let p = lim; p >= 12; p--) {
        let ok = true;
        const off = L.length - p;
        for (let k = 0; k < p; k++) if (L.charCodeAt(off + k) !== S.charCodeAt(k)) { ok = false; break; }
        if (ok) return [L.length - p, L.length];
      }
      const tailMin = /[.!?…"'’”)\]]$/.test(S) ? 5 : 12;
      for (let p = lim; p >= tailMin; p--) {
        let ok = true;
        const off = S.length - p;
        for (let k = 0; k < p; k++) if (L.charCodeAt(k) !== S.charCodeAt(off + k)) { ok = false; break; }
        if (ok) return [0, p];
      }
      return null;
    }
    let svgMeas = null;
    function svgFrac(node, text, font, rawTo) {
      if (!svgMeas) svgMeas = document.createElement("canvas").getContext("2d");
      try {
        svgMeas.font = font || "16px Arial";
        const full = svgMeas.measureText(text).width || 1;
        return svgMeas.measureText(text.slice(0, rawTo)).width / full;
      } catch {
        return 0;
      }
    }
    function svgLineNodes() {
      let nodes = document.querySelectorAll(".kix-canvas-tile-content svg rect[aria-label]");
      if (!nodes.length) nodes = document.querySelectorAll("svg rect[aria-label][data-font-css]");
      return [...nodes].filter((n) => (n.getAttribute("aria-label") || "").trim());
    }
    // Group nodes into visual lines by rendered top, join normalized text,
    // find each sentence's covered span, convert boundary coverage into
    // FRACTIONS of each node's width (zoom-proof), return bar descriptors.
    function svgLocate(issues) {
      const nodes = svgLineNodes();
      if (!nodes.length) return null; // no annotation layer — fall back
      const buckets = new Map();
      for (const node of nodes) {
        const r = node.getBoundingClientRect();
        if (r.width === 0) continue;
        const key = Math.round(r.top / 4) * 4;
        let b = buckets.get(key);
        if (!b) { b = []; buckets.set(key, b); }
        b.push({ node, r, raw: node.getAttribute("aria-label"), font: node.getAttribute("data-font-css") || "" });
      }
      const lines = [];
      for (const runs of buckets.values()) {
        runs.sort((a, b) => a.r.left - b.r.left);
        let joined = "";
        const spans = [];
        for (const run of runs) {
          const n = nrm(run.raw);
          spans.push([joined.length, joined.length + n.length, run]);
          joined += n;
        }
        if (joined) lines.push({ joined, spans, top: runs[0].r.top });
      }
      const bars = [];
      /* Whole sentences, however they wrap. Owner, 2026-10-05: "it doesnt
         underline whole sentence, it has a habit of only being able to
         highlight one line … at a time in google docs". Matching line by
         line needed a sentence's piece at the end or start of a line to be
         at least 12 characters (svgOverlapRange), so "Napoleon was" wrapping
         at a line's end — 11 — lost that line's underline. Now the visible
         lines are joined in reading order and the sentence is found in the
         whole text, then cut back into each line it covers, however little
         of it that is. The line-by-line match stays as the fallback for a
         sentence that cannot be found whole (part of it scrolled out of
         Docs' rendered pages). */
      const ordered = [...lines].sort((a, b) => a.top - b.top);
      let flat = "";
      for (const line of ordered) { line.base = flat.length; flat += line.joined; }
      const barsFor = (seg, line, range) => {
        for (const [s, e, run] of line.spans) {
          if (e <= range[0] || s >= range[1]) continue;
          let f0 = 0, f1 = 1;
          if (range[0] > s) f0 = svgFrac(run.node, run.raw, run.font, svgRawIndexAt(run.raw, range[0] - s));
          if (range[1] < e) f1 = svgFrac(run.node, run.raw, run.font, svgRawIndexAt(run.raw, range[1] - s));
          if (f1 - f0 <= 0.005) continue;
          bars.push({ hash: seg.hash, node: run.node, raw: run.raw, f0, f1 });
        }
      };
      for (const { seg } of issues) {
        const S = nrm(seg.text);
        if (S.length < 4) continue;
        let hits = [];
        for (let at = flat.indexOf(S); at >= 0; at = flat.indexOf(S, at + 1)) hits.push(at);
        if (seg.lastCopy && hits.length) hits = [hits[hits.length - 1]]; // only the later of two identical entries
        if (hits.length) {
          for (const at of hits) {
            for (const line of ordered) {
              const ls = line.base, le = ls + line.joined.length;
              if (le <= at || ls >= at + S.length) continue;
              barsFor(seg, line, [Math.max(at, ls) - ls, Math.min(at + S.length, le) - ls]);
            }
          }
          continue;
        }
        // Two identical entries match twice; a lastCopy mark keeps only the
        // later one — from the last line where the text STARTS, downwards.
        let fromTop = -Infinity;
        if (seg.lastCopy) {
          for (const line of lines) {
            const r = svgOverlapRange(line.joined, S);
            if (r && (line.joined.indexOf(S) >= 0 || r[1] === line.joined.length && r[0] > 0 || r[0] === 0 && S.startsWith(line.joined.slice(0, r[1])))) fromTop = Math.max(fromTop, line.top);
          }
        }
        for (const line of lines) {
          if (line.top < fromTop - 1) continue;
          const range = svgOverlapRange(line.joined, S);
          if (!range) continue;
          for (const [s, e, run] of line.spans) {
            if (e <= range[0] || s >= range[1]) continue;
            let f0 = 0, f1 = 1;
            if (range[0] > s) f0 = svgFrac(run.node, run.raw, run.font, svgRawIndexAt(run.raw, range[0] - s));
            if (range[1] < e) f1 = svgFrac(run.node, run.raw, run.font, svgRawIndexAt(run.raw, range[1] - s));
            if (f1 - f0 <= 0.005) continue;
            bars.push({ hash: seg.hash, node: run.node, raw: run.raw, f0, f1 });
          }
        }
      }
      return bars;
    }

    /* PART of a sentence, for the Type preview: chars [a, b) of nrm(text) —
       the whitespace-free count svgLocate matches in — as `pieces` {node, f0,
       f1} (each a share of one annotation run, zoom-proof; barTextRect reads
       them live), and `at` {node, f}: where char a starts or, for an empty
       range (an insertion), where char a-1 ends — right after the kept word,
       not after the space that follows it. The visible lines are grouped and
       joined exactly as svgLocate groups them (keep the two in step;
       ext-type-preview.test.js checks the bucket). Null when there is no
       annotation layer, the sentence is not rendered whole, or it is rendered
       more than once and `near` (a viewport rect on one copy) does not say
       which: a copy is never guessed at. */
    function svgRangeRects(text, a, b, near = null) {
      const S = nrm(String(text ?? ""));
      if (!S || !(a >= 0 && b >= a && b <= S.length)) return null;
      const nodes = svgLineNodes();
      if (!nodes.length) return null;
      const buckets = new Map();
      for (const node of nodes) {
        const r = node.getBoundingClientRect();
        if (r.width === 0) continue;
        const key = Math.round(r.top / 4) * 4;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({ node, r, raw: node.getAttribute("aria-label"), font: node.getAttribute("data-font-css") || "" });
      }
      const runs = []; // [start, end, run] in the joined visible text, reading order
      let flat = "";
      const lines = [...buckets.values()].map((rs) => rs.sort((x, y) => x.r.left - y.r.left)).sort((x, y) => x[0].r.top - y[0].r.top);
      for (const line of lines) {
        for (const run of line) {
          const n = nrm(run.raw);
          runs.push([flat.length, flat.length + n.length, run]);
          flat += n;
        }
      }
      const frac = (run, k) => svgFrac(run.node, run.raw, run.font, k);
      const piecesOf = (lo, hi) => {
        const out = [];
        for (const [s, e, run] of runs) {
          if (e <= lo || s >= hi) continue;
          const f0 = lo > s ? frac(run, svgRawIndexAt(run.raw, lo - s)) : 0;
          const f1 = hi < e ? frac(run, svgRawIndexAt(run.raw, hi - s)) : 1;
          if (f1 - f0 > 0.005) out.push({ node: run.node, f0, f1 });
        }
        return out;
      };
      const hits = [];
      for (let i = flat.indexOf(S); i >= 0; i = flat.indexOf(S, i + 1)) hits.push(i);
      let at = hits.length === 1 ? hits[0] : null;
      if (at == null && hits.length > 1 && near) {
        const cx = near.left + (near.width || 0) / 2, cy = near.top + (near.height || 0) / 2;
        at = hits.find((h) => piecesOf(h, h + S.length).some((p) => {
          const r = p.node.getBoundingClientRect();
          const l = r.left + p.f0 * r.width, rt = r.left + p.f1 * r.width;
          return cx >= l - 2 && cx <= rt + 2 && cy >= r.top - 4 && cy <= r.top + r.height + 4;
        })) ?? null;
      }
      if (at == null) return null;
      const lo = at + a;
      let point = null;
      for (const [s, e, run] of runs) {
        if (a === b && a > 0) {
          if (lo - 1 >= s && lo - 1 < e) { point = { node: run.node, f: frac(run, svgRawIndexAt(run.raw, lo - 1 - s) + 1) }; break; }
        } else if (lo >= s && lo < e) { point = { node: run.node, f: frac(run, svgRawIndexAt(run.raw, lo - s)) }; break; }
      }
      return point ? { pieces: piecesOf(lo, at + b), at: point } : null;
    }

    /* Bars are carried by the COMPOSITOR wherever that is possible, and glued
       to the document by a per-frame loop only where it is not:
         - SVG mode  → a <rect> beside Docs' own annotation rect (in-tree);
         - canvas fallback → an absolutely-positioned div inside the kix PAGE
           the text is painted on (page-anchored, see ensurePageLayer);
         - anything unresolvable → a position:fixed div in marksLayer, glued
           every frame. Laggy, but it is never absent.
       The v2.6 lesson ("never inject into DOM an app owns") was about kix's
       TILE divs, which kix wipes. Both exceptions above are measured, not
       assumed — see the note on ensurePageLayer. */
    let marksLayer = null;
    let docsBars = []; // [{hash, el, tile, rx, ry, w, size, fallLeft, fallTop, inSvg, inPage}]
    const tileState = new Map(); // tileId → {canvas, sx, sy, shiftX, shiftY}
    const pageLayers = new Map(); // kix page el → our overlay div inside it
    let glueRaf = 0;
    let docsScroller = null;
    let selfMutating = false;      // our own annotation-SVG writes, for the observer to skip
    let inTreeDisabledUntil = 0;   // in-tree bars paused until this time if Docs fights us
    let inTreeCooldown = 60_000;   // doubles per latch, capped at 15min
    let hostileStrikes = [];       // timestamps of Docs deleting our bars targetedly

    function ensureLayer() {
      if (marksLayer && marksLayer.isConnected) return;
      marksLayer = document.createElement("div");
      marksLayer.setAttribute("data-tracely-docs-marks", "");
      Object.assign(marksLayer.style, {
        // Modest z: above the editing surface, below Docs menus/dialogs.
        position: "fixed", inset: "0", pointerEvents: "none", zIndex: "900",
      });
      document.documentElement.appendChild(marksLayer);
    }

    /* ── the canvas fallback's compositor anchor ───────────────────────────
       One overlay div per kix page, holding that page's bars. Measured on
       real Docs (signed-out doc, so the annotation layer was absent and this
       WAS the live path) rather than assumed:

       - `div.kix-page-paginated` carries an inline
         `position:absolute; top:…; left:…; z-index:N; width:816px; height:1056px`,
         so it is the canvas tile's offsetParent — canvas.offsetLeft/offsetTop
         are page-local CSS px with no transform anywhere in the chain, which
         is exactly the space the hook's canvas-relative rects convert into.
       - kix does NOT sanitize children out of it: zero removals across two
         documents, every scroll, every repaint, and page recycling. (The nodes
         kix wipes are the TILE divs; this is the page above them.)
       - a div in there is rigidly compositor-locked to the text — a probe bar
         held its offset to the page to the pixel across every scroll position,
         with no script in the loop. That is the whole point of this path.
       - the page is overflow:visible, so it does NOT clip: the overlay carries
         overflow:hidden itself, which is what keeps a bar off the gutter
         between pages (the fixed layer never managed that).
       - the page sets a z-index (its page number), making it a stacking
         context, and the canvas inside it carries that same z-index. So the
         overlay needs to outrank the canvas — and a max-int z-index is safe
         precisely BECAUSE the page is a stacking context: it cannot escape the
         page to cover Docs' menus. */
    function ensurePageLayer(page) {
      let layer = pageLayers.get(page);
      if (layer && layer.isConnected && layer.parentNode === page) return layer;
      layer = document.createElement("div");
      // Same marker the annotation observer uses to recognize our own writes —
      // a differently-tagged node would read as an external mutation and spin
      // a re-locate loop.
      layer.setAttribute("data-tracely-bar", "");
      layer.setAttribute("data-tracely-page-layer", "");
      layer.setAttribute("aria-hidden", "true");
      Object.assign(layer.style, {
        position: "absolute", left: "0", top: "0", width: "100%", height: "100%",
        overflow: "hidden", pointerEvents: "none", zIndex: "2147483647",
      });
      page.appendChild(layer);
      pageLayers.set(page, layer);
      return layer;
    }

    // The kix page a tile canvas paints onto, or null when this document isn't
    // shaped the way the measurements above describe (pageless view, a future
    // re-layout) — callers then fall through to the glued layer.
    function pageOf(canvas) {
      const page = canvas?.closest?.(".kix-page-paginated");
      // offsetParent identity is the load-bearing part: it is what makes
      // canvas.offsetLeft/offsetTop page-local, and it is false the moment
      // kix stops positioning pages the way we measured.
      return page && canvas.offsetParent === page ? page : null;
    }

    function clearDocsMarks() {
      // Kill any pending glue frame FIRST: draw paths call glueFrame()
      // synchronously right after this, and an orphaned pending handle would
      // self-perpetuate as a second parallel rAF chain (they accumulate).
      if (glueRaf) { cancelAnimationFrame(glueRaf); glueRaf = 0; }
      selfMutating = true;
      if (marksLayer) marksLayer.textContent = "";
      // In-tree bars live inside Docs' annotation SVGs and page-anchored bars
      // inside kix's pages — remove them there, plus a sweep for strays whose
      // tile was recycled out from under us.
      for (const b of docsBars) if (b.inSvg) b.el.remove();
      pageObs.disconnect();
      for (const layer of pageLayers.values()) layer.remove();
      pageLayers.clear();
      for (const stray of document.querySelectorAll("[data-tracely-bar]:not([data-tracely-leaving])")) stray.remove();
      docsBars = [];
      tileState.clear();
      queueMicrotask(() => { selfMutating = false; });
    }

    /* Page recycling — the one way a compositor-carried bar can go wrong.
       kix keeps a small POOL of page elements and reuses them for other pages
       as you scroll: the very elements a probe was injected into at document
       offsets 5px and 1071px turned up later at 33051px and 31985px, overlay
       still attached. A bar left on a recycled page would underline whatever
       text now occupies it.

       kix positions both the page and its tile canvas through their inline
       style attributes, so a `style`-filtered observer on exactly the nodes we
       anchored to fires on exactly that event and little else — the same trick
       the annotation observer plays on the SVG path, and for the same reason:
       observer callbacks run BEFORE the next paint, so a stale bar is hidden
       before a wrong frame can reach the screen. Re-matching is left to the
       usual locate pass; this only has to stop the lie. */
    const pageObs = new MutationObserver(() => {
      let stale = false;
      for (const b of docsBars) {
        if (!b.inPage || b.el.style.display === "none") continue;
        const moved = b.page.offsetTop !== b.pageTop || b.page.offsetLeft !== b.pageLeft ||
          b.canvas.offsetTop !== b.canvasTop || b.canvas.offsetLeft !== b.canvasLeft;
        if (!moved) continue;
        b.el.style.display = "none";
        stale = true;
      }
      if (stale) fastDocsMarks(); // this page now paints other text — re-match NOW
    });

    function glueFrame() {
      glueRaf = 0;
      if (docsBars.length === 0) return;
      let staleSvg = false;
      let needLoop = false;
      for (const t of tileState.values()) {
        if (t.canvas && !t.canvas.isConnected) t.canvas = null;
        if (!t.canvas) continue;
        t.rect = t.canvas.getBoundingClientRect();
      }
      // Bars must never draw over Docs' own chrome: clip to the editor's
      // scroll area (tiles for scrolled-away text keep DOM positions that
      // land on the toolbar otherwise).
      let clip = null;
      if (!docsScroller || !docsScroller.isConnected) {
        docsScroller = document.querySelector(".kix-appview-editor");
      }
      if (docsScroller) clip = docsScroller.getBoundingClientRect();
      for (const b of docsBars) {
        // Compositor-carried: no per-frame work, clipped natively (in-tree by
        // the editor, page-anchored by its own overflow:hidden overlay).
        if (b.inSvg || b.inPage) continue;
        needLoop = true;
        if (b.node) {
          // SVG mode: the annotation rect IS the live position — zero lag.
          // Docs RECYCLES annotation nodes when tiles scroll far: the same
          // element suddenly describes different text. Validate the binding
          // every frame — a recycled node hides its bar instantly instead of
          // underlining the wrong sentence until the next re-match.
          if (!b.node.isConnected || b.node.getAttribute("aria-label") !== b.raw) {
            b.el.style.opacity = "0";
            staleSvg = true;
            continue;
          }
          const r = b.node.getBoundingClientRect();
          const x = r.left + b.f0 * r.width;
          const y = r.bottom + 1;
          b.el.style.transform = `translate(${x}px, ${y}px)`;
          b.el.style.width = (b.f1 - b.f0) * r.width + "px";
          const out = y < -20 || y > innerHeight + 20 ||
            (clip && (y < clip.top + 2 || y > clip.bottom - 2 || x > clip.right || x + (b.f1 - b.f0) * r.width < clip.left));
          b.el.style.opacity = out ? "0" : "1";
          b.size = r.height || b.size;
          continue;
        }
        const t = tileState.get(b.tile);
        if (t && t.canvas && t.rect) {
          const x = t.rect.left + b.rx + t.shiftX * t.sx;
          const y = t.rect.top + b.ry + t.shiftY * t.sy;
          const off = y < -20 || y > innerHeight + 20;
          b.el.style.transform = `translate(${x}px, ${y}px)`;
          b.el.style.opacity = off ? "0" : "1";
        } else {
          // Tile unresolvable — fall back to the viewport position the hook
          // computed at locate time (v2.5-era behavior: right place, lags on
          // scroll until the next locate instead of showing nothing).
          b.el.style.transform = `translate(${b.fallLeft}px, ${b.fallTop}px)`;
          b.el.style.opacity = "1";
        }
      }
      if (staleSvg) fastDocsMarks(); // Docs recycled annotation nodes — re-match NOW
      // In-tree and page-anchored bars ride the compositor; only glued bars
      // need frames. !glueRaf: fastDocsMarks above can synchronously redraw and
      // schedule its own chain — never stack a second one on top.
      if (needLoop && !glueRaf) glueRaf = requestAnimationFrame(glueFrame);
    }
    function startGlue() {
      if (!glueRaf && docsBars.some((b) => !b.inSvg && !b.inPage)) glueRaf = requestAnimationFrame(glueFrame);
    }

    function drawDocsMarks(rects) {
      try {
        ensureLayer();
        selfMutating = true;
        clearDocsMarks();
        let received = 0, anchored = 0, glued = 0;
        for (const [hash, list] of Object.entries(rects ?? {})) {
          const verdict = lastVerdictByHash.get(hash);
          const color = MARK_COLORS[verdict];
          if (!color) continue;
          const pattern = MARK_PATTERN[verdict];
          for (const r of list) {
            if (!r || r.width < 3) continue;
            received++;
            if (!tileState.has(r.tile)) {
              const fresh = {
                canvas: document.querySelector(`canvas[data-tracely-tile="${r.tile}"]`),
                sx: 1, sy: 1, shiftX: 0, shiftY: 0, rect: null,
              };
              if (fresh.canvas) {
                fresh.sx = (fresh.canvas.getBoundingClientRect().width || 1) / (fresh.canvas.width || 1);
                fresh.sy = (fresh.canvas.getBoundingClientRect().height || 1) / (fresh.canvas.height || 1);
              }
              tileState.set(r.tile, fresh);
            }
            const t = tileState.get(r.tile);
            /* PAGE-ANCHORED bar — the fallback's answer to scroll lag. The
               hook hands us canvas-relative CSS px; the tile canvas is
               positioned inside its kix page, so page-local coordinates are
               just canvas.offsetLeft/offsetTop plus that. Written once into a
               div inside the page, the bar is then carried by the compositor
               exactly like the in-tree SVG path, with no frame loop at all.
               (Skipped while the hostility latch is engaged — if Docs is
               deleting our nodes out of its own subtree, this is not the
               moment to put more of them there.) */
            const page = Date.now() >= inTreeDisabledUntil ? pageOf(t?.canvas) : null;
            const bar = document.createElement("div");
            Object.assign(bar.style, {
              left: "0", top: "0", width: r.width + "px", height: "3px",
              background: markFill(color, pattern), borderRadius: "2px", pointerEvents: "none",
            });
            if (page) {
              bar.setAttribute("data-tracely-bar", "");
              bar.setAttribute("aria-hidden", "true");
              const x = t.canvas.offsetLeft + r.x;
              const y = t.canvas.offsetTop + r.y;
              // No will-change: this transform is written once and never
              // again, so promoting 40 bars to their own layers would only
              // spend memory. The page they sit in is already composited.
              bar.style.position = "absolute";
              bar.style.transform = `translate(${x}px, ${y}px)`;
              ensurePageLayer(page).appendChild(bar);
              pageObs.observe(page, { attributes: true, attributeFilter: ["style"] });
              pageObs.observe(t.canvas, { attributes: true, attributeFilter: ["style"] });
              docsBars.push({
                hash, el: bar, tile: r.tile,
                rx: r.x, ry: r.y, size: r.size || 18,
                fallLeft: r.left ?? 0, fallTop: r.top ?? 0,
                // Baked source geometry: the recycling observer diffs these to
                // tell "kix restyled this page" from "kix MOVED it".
                inPage: true, page, canvas: t.canvas,
                pageTop: page.offsetTop, pageLeft: page.offsetLeft,
                canvasTop: t.canvas.offsetTop, canvasLeft: t.canvas.offsetLeft,
              });
              anchored++;
            } else {
              // No resolvable page (pageless view, or the latch is on): the
              // v2.5-era fixed div, glued to the tile every frame.
              bar.style.position = "fixed";
              bar.style.willChange = "transform";
              marksLayer.appendChild(bar);
              docsBars.push({
                hash, el: bar, tile: r.tile,
                rx: r.x, ry: r.y, size: r.size || 18,
                fallLeft: r.left ?? 0, fallTop: r.top ?? 0,
              });
              glued++;
            }
          }
        }
        queueMicrotask(() => { selfMutating = false; });
        // One log per draw — screenshot-diagnosable if bars ever go missing.
        console.debug(`[tracely] v${EXT_VERSION} docs marks (canvas fallback): ${docsBars.length} bar(s) from ${received} rect(s) — ${anchored} page-anchored across ${pageLayers.size} page(s), ${glued} glued; tiles resolved: ${[...tileState.values()].filter((t) => t.canvas).length}/${tileState.size}`);
        glueFrame(); // position immediately, then keep gluing
        startGlue();
      } catch (err) {
        console.warn("[tracely] docs mark draw failed:", err);
      }
    }

    /* Visual rows of the page, in reading order: one entry per painted line,
       carrying its annotation rect(s) and attribute-space geometry. The
       underline matcher buckets the same nodes by top; flow needs whole rows
       (and their extents) so it can bracket a paragraph in the margin. */
    function svgRows() {
      const rows = new Map();
      for (const node of svgLineNodes()) {
        const r = node.getBoundingClientRect();
        if (r.width === 0) continue;
        const key = Math.round(r.top / 4) * 4;
        let row = rows.get(key);
        if (!row) { row = { key, nodes: [], clientTop: r.top }; rows.set(key, row); }
        row.nodes.push(node);
      }
      const out = [];
      for (const row of [...rows.values()].sort((a, b) => a.clientTop - b.clientTop)) {
        row.nodes.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        const joined = row.nodes.map((n) => nrm(n.getAttribute("aria-label"))).join("");
        if (!joined) continue;
        const g = row.nodes.map((n) => ({
          x: parseFloat(n.getAttribute("x")), y: parseFloat(n.getAttribute("y")),
          w: parseFloat(n.getAttribute("width")), h: parseFloat(n.getAttribute("height")),
          svg: n.ownerSVGElement, node: n,
        })).filter((v) => [v.x, v.y, v.w, v.h].every(Number.isFinite) && v.svg);
        if (!g.length) continue;
        // Rects are bucketed by their TOP, which quietly merges a table's
        // cells into one pseudo-row: its text is every column concatenated and
        // its box spans the whole table. Prose runs on one line sit flush
        // against each other, so the widest horizontal gap tells the two
        // apart, and a flow bracket must never anchor to the table shape.
        const sorted = [...g].sort((a, b) => a.x - b.x);
        let maxGap = 0;
        for (let i = 1; i < sorted.length; i++) {
          maxGap = Math.max(maxGap, sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w));
        }
        const y = Math.min(...g.map((v) => v.y));
        const bottom = Math.max(...g.map((v) => v.y + v.h));
        out.push({
          joined, nodes: row.nodes, svg: g[0].svg,
          x: Math.min(...g.map((v) => v.x)),
          right: Math.max(...g.map((v) => v.x + v.w)),
          y, bottom,
          segmented: maxGap > Math.max(12, (bottom - y) * 1.5),
        });
      }
      return out;
    }

    /* Locate each flow issue's PARAGRAPH on the page. The model anchors an
       issue to one verbatim sentence; the bracket spans the whole paragraph
       that sentence belongs to, which is what the design shows. */
    function svgFlowLocate(flows) {
      if (!flows.length) return [];
      const rows = svgRows();
      if (!rows.length) return [];
      const paras = docText.split(/\n+/).map((p) => p.trim()).filter(Boolean);
      const out = [];
      const used = new Set();
      for (const issue of flows) {
        const S = nrm(issue.passage);
        if (S.length < 8) continue;
        const para = paras.find((p) => nrm(p).includes(S)) ?? issue.passage;
        const P = nrm(para);
        /* Anchor on the PASSAGE, not on "any row that happens to appear inside
           the paragraph". The looser test matched the first SHORT row whose
           text coincided with something in the paragraph — a title fragment, a
           table cell like "1492" — which put the bracket at the top of the
           document and, because a short row's right edge is far left, stranded
           the chip out in the margin with no bracket beside it. */
        /* Match the anchor on letters and digits only. `nrm` strips whitespace
           but KEEPS punctuation, and the text Docs exports does not always
           punctuate identically to the text it renders — a straight quote for
           a curly one, an en dash for a hyphen — so a key carrying a comma or
           a quote can fail to match a line that is plainly the right one. The
           underline matcher keeps `nrm`, which has earned its keep on
           sentences; only this anchor needs to be forgiving. */
        const loose = (t) => t.replace(/[^a-z0-9]/g, "");
        const key = loose(S).slice(0, 24);
        const start = key.length < 12 ? -1
          : rows.findIndex((r) => !r.segmented && loose(r.joined).includes(key));
        // No confident anchor: draw NOTHING. The looser fallbacks that used to
        // sit here are what put a bracket on a title and a pair of chips on a
        // table header. The issue still counts in the widget, where it needs
        // no position to be useful — a flag in the wrong place is worse than
        // one the reader has to open the panel to see.
        if (start === -1) continue;
        // Two issues resolving to one line drew their chips on top of each
        // other, which reads as corrupted text rather than as two findings.
        if (used.has(start)) continue;
        used.add(start);
        // Extend while rows still belong to this paragraph and the same tile:
        // a bracket is one shape, so it can't straddle two annotation layers.
        let end = start;
        for (let i = start + 1; i < rows.length; i++) {
          if (rows[i].svg !== rows[start].svg) break;
          if (rows[i].segmented) break; // a table below the paragraph ends it
          if (!rows[i].joined || !P.includes(rows[i].joined)) break;
          if (rows[i].y > rows[end].bottom + rows[end].bottom - rows[end].y) break; // paragraph gap
          end = i;
        }
        /* The chip belongs in the MARGIN, past the text — which means it must
           be placed from the text COLUMN's right edge, not from the matched
           row's. A row's rects do not always span the whole visual line (the
           rest of the line can sit in a separate rect that buckets
           elsewhere), and positioning off that partial edge dropped the chip
           on top of the next words on the same line. The column edge is the
           widest row on this page, which is stable whatever the line does. */
        const colRight = Math.max(...rows.filter((r) => r.svg === rows[start].svg).map((r) => r.right));
        out.push({
          hash: flowHashOf(issue), issue,
          svg: rows[start].svg,
          colRight,
          x: Math.min(...rows.slice(start, end + 1).map((r) => r.x)),
          right: Math.max(...rows.slice(start, end + 1).map((r) => r.right)),
          top: rows[start].y,
          bottom: rows[end].bottom,
          lineH: Math.max(8, rows[start].bottom - rows[start].y),
        });
      }
      return out;
    }

    const SVGNS = "http://www.w3.org/2000/svg";
    function svgEl(name, attrs) {
      const el = document.createElementNS(SVGNS, name);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      return el;
    }

    /* Draw one flow flag in the annotation layer: margin bracket, badge, and
       a right-margin chip — all in-tree, so they ride the compositor with the
       text exactly like the underlines do. Geometry mirrors the Figma frame. */
    function drawFlowFlag(f) {
      const g = svgEl("g", { "data-tracely-bar": "", "data-tracely-flow": "", "aria-hidden": "true", "pointer-events": "none" });
      const lh = f.lineH;
      const bx = f.x - lh * 1.55;              // bracket sits in the left margin
      const top = f.top + lh * 0.15;
      const bot = f.bottom;
      const r = lh * 0.34;                     // corner radius, scales with type size
      // Vertical spine with a rounded elbow into a short arrow at the foot.
      g.appendChild(svgEl("path", {
        d: `M ${bx} ${top + r} L ${bx} ${bot - r} Q ${bx} ${bot} ${bx + r} ${bot} L ${bx + r * 1.5} ${bot}`,
        fill: "none", stroke: FLOW_COLOR, "stroke-width": Math.max(1.2, lh * 0.075),
        "stroke-linecap": "round", "stroke-linejoin": "round",
      }));
      g.appendChild(svgEl("path", {
        d: `M ${bx + r * 0.9} ${bot - r * 0.5} L ${bx + r * 1.7} ${bot} L ${bx + r * 0.9} ${bot + r * 0.5} Z`,
        fill: FLOW_COLOR,
      }));
      // Badge: filled disc at the head of the bracket with a flow glyph.
      const cy = f.top + lh * 0.42, cr = lh * 0.62;
      g.appendChild(svgEl("circle", { cx: bx, cy, r: cr, fill: FLOW_COLOR }));
      g.appendChild(svgEl("path", {
        d: `M ${bx - cr * 0.5} ${cy + cr * 0.08} q ${cr * 0.25} ${-cr * 0.55} ${cr * 0.5} 0 q ${cr * 0.25} ${cr * 0.55} ${cr * 0.5} 0`,
        fill: "none", stroke: "#fff", "stroke-width": Math.max(1, cr * 0.22),
        "stroke-linecap": "round",
      }));
      // Right-margin chip — dot plus label, aligned to the first line.
      const chipX = (f.colRight ?? f.right) + lh * 0.9, chipY = f.top + lh * 0.62;
      g.appendChild(svgEl("circle", { cx: chipX, cy: chipY - lh * 0.2, r: Math.max(2, lh * 0.13), fill: FLOW_ACCENT }));
      const label = svgEl("text", {
        x: chipX + lh * 0.42, y: chipY, fill: FLOW_ACCENT,
        "font-size": lh * 0.62, "font-family": "Arial, Helvetica, sans-serif", "font-weight": "500",
      });
      label.textContent = "Flow issue";
      g.appendChild(label);
      f.svg.appendChild(g);
      return g;
    }

    /* One continuous line per sentence per visual line. Owner, 2026-10-05:
       "underline segments are word by word and disconnected". Docs often
       gives each word (or each styled run) its own annotation rect, and a bar
       was drawn per rect, so the spaces between words showed as gaps. Two
       consecutive bars of the same sentence on the same line, in the same
       SVG group and transform, are joined: the first stretches to where the
       next begins. Re-applied after the observer moves bars. */
    function joinBars() {
      const bars = docsBars.filter((b) => b.inSvg && !b.flow && b.el?.isConnected && b.node?.isConnected);
      for (let i = 0; i + 1 < bars.length; i++) {
        const a = bars[i], b = bars[i + 1];
        if (a.hash !== b.hash || a.node.parentNode !== b.node.parentNode || (a.tf || "") !== (b.tf || "")) continue;
        if (Math.abs((a.gy + a.gh) - (b.gy + b.gh)) > 2) continue; // another line
        const ax = a.gx + a.f0 * a.gw, bx = b.gx + b.f0 * b.gw;
        if (bx > ax) a.el.setAttribute("width", String(Math.max(2, bx - ax + 0.5)));
      }
      for (const b of bars) {
        if (!b.wash) continue;
        b.wash.setAttribute("x", b.el.getAttribute("x"));
        b.wash.setAttribute("width", b.el.getAttribute("width"));
        b.wash.setAttribute("y", String(b.gy));
        b.wash.setAttribute("height", String(b.gh));
        if (b.tf) b.wash.setAttribute("transform", b.tf); else b.wash.removeAttribute("transform");
      }
    }

    /* Motion for the in-tree bars. Removed with their sentence (dismissed,
       fixed, edited away), a bar fades out where it was instead of blinking
       off; a bar new on the page draws in (isFreshMark). */
    let docsRecent = [];
    function docOrigin() {
      if (!docsScroller || !docsScroller.isConnected) docsScroller = document.querySelector(".kix-appview-editor");
      return { x: docsScroller?.scrollLeft ?? 0, y: docsScroller?.scrollTop ?? 0 };
    }
    function barRecord(b, o) {
      const r = b.el.getBoundingClientRect();
      return r.width ? { hash: b.hash, color: b.color, x0: r.left + o.x, x1: r.right + o.x, y: r.top + o.y } : null;
    }
    function settleDocsMotion(leaving, recentBefore) {
      const o = docOrigin();
      const now = docsBars.filter((b) => b.inSvg && !b.flow && b.el.isConnected).map((b) => [b, barRecord(b, o)]).filter(([, r]) => r);
      // In: new on the page, top to bottom, a few ms apart.
      const fresh = now.filter(([, r]) => isFreshMark(recentBefore, r)).sort((a, b) => a[1].y - b[1].y || a[1].x0 - b[1].x0);
      fresh.forEach(([b], i) => drawMarkIn(b.el, Math.min(i * 14, 180)));
      // Out: gone from this draw. Over a mark that took its place (an edit
      // re-hashed the sentence) it just goes; elsewhere it fades.
      for (const b of leaving) {
        const r = barRecord(b, o);
        const replaced = r && now.some(([, n]) => n.color === r.color && Math.abs(n.y - r.y) <= 6 && n.x0 < r.x1 && r.x0 < n.x1);
        let done = false;
        const gone = () => { if (done) return; done = true; selfMutating = true; b.el.remove(); b.wash?.remove(); queueMicrotask(() => { selfMutating = false; }); };
        if (!r || replaced || markReducedMotion() || typeof b.el.animate !== "function") { gone(); continue; }
        b.wash?.remove();
        try {
          b.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MARK_OUT_MS, easing: "ease-out", fill: "forwards" }).finished.then(gone, gone);
        } catch { gone(); }
        setTimeout(gone, MARK_OUT_MS + 220); // a page that is not painting never finishes the fade
      }
      if (now.length) docsRecent = now.map(([, r]) => r);
    }

    /* The hovered sentence, and the one whose card is open, get the wash
       behind their words and a slightly heavier line — Grammarly's gesture,
       and the one field mode already makes (paintHover). */
    let docsHoverHash = null;
    /* The wash's fade. Not a CSS transition: one measured pending forever on
       a page that was not painting, holding the wash at 0 — the end state is
       set first and the fade is cancelled by a timer, so the worst case is a
       highlight that simply appears. */
    function fadeWash(el, op) {
      const from = el.style.opacity || "0";
      el.style.opacity = op;
      if (markReducedMotion() || typeof el.animate !== "function") return;
      try {
        const anim = el.animate([{ opacity: from }, { opacity: op }], { duration: 120, easing: "ease" });
        setTimeout(() => anim.cancel(), 400);
      } catch { /* it simply changes */ }
    }
    function paintDocsActive() {
      for (const b of docsBars) {
        if (!b.wash) continue;
        const on = b.hash === popHash || b.hash === docsHoverHash;
        const op = on ? "1" : "0";
        if (b.wash.style.opacity !== op) fadeWash(b.wash, op);
        const h = String(on ? b.h0 + 1 : b.h0);
        if (b.el.getAttribute("height") !== h) b.el.setAttribute("height", h);
      }
    }

    function drawDocsMarksSvg(svgBars, flows = []) {
      try {
        ensureLayer();
        selfMutating = true;
        const incoming = new Set(svgBars.map((sb) => sb.hash));
        const recentBefore = docsRecent;
        // Bars whose sentence is no longer marked leave on their own clock.
        const leaving = docsBars.filter((b) => b.inSvg && !b.flow && b.el.isConnected && b.el.style.display !== "none" && !incoming.has(b.hash));
        for (const b of leaving) { b.el.setAttribute("data-tracely-leaving", ""); b.wash?.setAttribute("data-tracely-leaving", ""); }
        docsBars = docsBars.filter((b) => !leaving.includes(b));
        clearDocsMarks();
        let inTree = 0, glued = 0;
        for (const sb of svgBars) {
          const color = MARK_COLORS[lastVerdictByHash.get(sb.hash)];
          if (!color) continue;
          const pattern = MARK_PATTERN[lastVerdictByHash.get(sb.hash)];
          const svg = sb.node.ownerSVGElement;
          const rx = parseFloat(sb.node.getAttribute("x"));
          const ry = parseFloat(sb.node.getAttribute("y"));
          const rw = parseFloat(sb.node.getAttribute("width"));
          const rh = parseFloat(sb.node.getAttribute("height"));
          if (Date.now() >= inTreeDisabledUntil && svg && [rx, ry, rw, rh].every(Number.isFinite)) {
            /* IN-TREE bar — Grammarly's actual trick. The rect lives in the
               same SVG as Google's text geometry, so the COMPOSITOR scrolls
               it with the text: zero lag with no script in the loop. (The
               v2.6 "never inject into kix's DOM" lesson was about the tile
               DIVS, which kix wipes; this SVG layer exists FOR extensions —
               annotate_canvas_by_ext — and is where Grammarly draws.) */
            const bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            bar.setAttribute("data-tracely-bar", "");
            bar.setAttribute("aria-hidden", "true");
            bar.setAttribute("x", String(rx + sb.f0 * rw));
            bar.setAttribute("y", String(ry + rh - 2));
            bar.setAttribute("width", String(Math.max(2, (sb.f1 - sb.f0) * rw)));
            bar.setAttribute("height", "2.5");
            bar.setAttribute("rx", "1.25");
            bar.setAttribute("fill", svgMarkFill(color, pattern));
            bar.setAttribute("pointer-events", "none");
            const tf = sb.node.getAttribute("transform");
            if (tf) bar.setAttribute("transform", tf);
            // Sibling of the matched rect, not the SVG root: inherits the
            // exact ancestor transform chain (a <g transform> would otherwise
            // silently offset every bar).
            sb.node.parentNode.insertBefore(bar, sb.node.nextSibling);
            // The highlight behind the words, shown while this sentence is
            // hovered or its card is open (paintDocsActive). Under the line.
            const wash = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            wash.setAttribute("data-tracely-bar", "");
            wash.setAttribute("aria-hidden", "true");
            wash.setAttribute("pointer-events", "none");
            wash.setAttribute("rx", "2");
            wash.setAttribute("fill", withAlpha(color, MARK_BAND_ALPHA)); // a highlight, not a line: the bar above is the line
            if (tf) wash.setAttribute("transform", tf);
            wash.style.opacity = "0";
            sb.node.parentNode.insertBefore(wash, bar);
            inTree++;
            docsBars.push({
              hash: sb.hash, el: bar, wash, color, h0: Number(bar.getAttribute("height")), node: sb.node, raw: sb.raw, f0: sb.f0, f1: sb.f1,
              // size feeds hover-band math and popover placement in CSS px —
              // rh is SVG user units, so measure through the transform chain.
              size: sb.node.getBoundingClientRect().height || rh || 18,
              // Baked source geometry: the observer diffs these to follow
              // in-place re-coordination of the same node.
              gx: rx, gy: ry, gw: rw, gh: rh, tf: tf || "",
              inSvg: true,
            });
          } else {
            // Unusable geometry (or Docs proved hostile to in-tree bars):
            // fixed-layer div glued per-frame — laggy but never absent.
            const bar = document.createElement("div");
            Object.assign(bar.style, {
              position: "fixed", left: "0", top: "0",
              width: "0px", height: "3px",
              background: markFill(color, pattern), borderRadius: "2px", pointerEvents: "none",
              willChange: "transform",
            });
            marksLayer.appendChild(bar);
            glued++;
            docsBars.push({ hash: sb.hash, el: bar, node: sb.node, raw: sb.raw, f0: sb.f0, f1: sb.f1, size: 18 });
          }
        }
        joinBars();
        drawMarginIcons(svgBars);
        /* IN-DOCUMENT FLOW BRACKETS ARE OFF BY DEFAULT.
           Placing them against Google's rendered text has now failed in five
           distinct ways — anchored to a title, to a table header, to a partial
           line, drawn twice, and drawn over the words themselves. The feature
           is fine; POSITIONING it is what keeps breaking, and a flag in the
           wrong place is worse than one the reader opens the panel to find.
           Flow issues render as cards there, needing no position at all.
           localStorage tracely.flowInDoc = "1" re-enables the bracket. */
        let flowDrawn = 0;
        for (const f of (FLOW_IN_DOC ? svgFlowLocate(flows) : [])) {
          const g = drawFlowFlag(f);
          flowDrawn++;
          docsBars.push({
            hash: f.hash, el: g, node: f.svg, raw: null, inSvg: true, flow: f.issue,
            size: f.lineH, gx: f.x, gy: f.top, gw: f.right - f.x, gh: f.bottom - f.top, tf: "",
          });
        }
        settleDocsMotion(leaving, recentBefore);
        paintDocsActive();
        queueMicrotask(() => { selfMutating = false; });
        console.debug(`[tracely] v${EXT_VERSION} docs marks (svg): ${docsBars.length} bar(s) — ${inTree} in-tree, ${glued} glued, ${flowDrawn} flow — across ${new Set(svgBars.map((b) => b.node)).size} line node(s)`);
        glueFrame();
        startGlue();
      } catch (err) {
        console.warn("[tracely] docs svg mark draw failed:", err);
      }
    }

    /* The margin icon (MARK_ICON): one beside the line where each mark
       STARTS (a sentence that wraps gets one, not one a line), and one a line
       — the most serious kind starting there — in the page's left margin. Drawn like the bars, inside the SVG that holds the line's own
       text geometry (left of its leftmost run), so the compositor carries it
       with the text and it scales with the zoom. Marked as ours
       (data-tracely-bar): the next draw's sweep takes it away, and the
       annotation observer ignores it. Only in-tree lines get one; fields and
       Docs' fallback paths have no margin to put it in. */
    function drawMarginIcons(svgBars) {
      const lines = new Map(); // a line (its SVG parent and baseline) → { parent, ry, rh, tf, kind }
      const first = new Map(); // each mark's first piece: its top line, then its leftmost
      for (const sb of svgBars) {
        const y = parseFloat(sb.node.getAttribute("y")), x = parseFloat(sb.node.getAttribute("x"));
        const cur = first.get(sb.hash);
        if (!cur || y < cur.y - 1 || (Math.abs(y - cur.y) <= 1 && x < cur.x)) first.set(sb.hash, { sb, y, x });
      }
      for (const { sb } of first.values()) {
        const kind = MARK_ICON[lastVerdictByHash.get(sb.hash)];
        const parent = sb.node.parentNode;
        const ry = parseFloat(sb.node.getAttribute("y")), rh = parseFloat(sb.node.getAttribute("height"));
        if (!kind || !parent || ![ry, rh].every(Number.isFinite)) continue;
        const per = lines.get(parent) ?? new Map();
        lines.set(parent, per);
        const key = Math.round((ry + rh) / 2);
        const cur = per.get(key);
        if (!cur || MARK_ICON_RANK[kind] > MARK_ICON_RANK[cur.kind]) per.set(key, { parent, ry, rh, tf: sb.node.getAttribute("transform"), kind });
      }
      const NS = "http://www.w3.org/2000/svg";
      for (const per of lines.values()) {
        for (const line of per.values()) {
          // The line's leftmost run: where its text starts.
          let left = Infinity;
          for (const n of line.parent.children) {
            if (n.tagName?.toLowerCase() !== "rect" || !n.hasAttribute("aria-label")) continue;
            const y = parseFloat(n.getAttribute("y")), x = parseFloat(n.getAttribute("x"));
            if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(y - line.ry) <= 1) left = Math.min(left, x);
          }
          if (!Number.isFinite(left)) continue;
          const size = Math.max(8, Math.min(12, line.rh * 0.7));
          const icon = document.createElementNS(NS, "svg");
          icon.setAttribute("data-tracely-bar", "");
          icon.setAttribute("data-tracely-margin-icon", line.kind);
          icon.setAttribute("aria-hidden", "true");
          icon.setAttribute("pointer-events", "none");
          icon.setAttribute("viewBox", "0 0 12 12");
          for (const [k, v] of Object.entries({ x: left - size - 8, y: line.ry + (line.rh - size) / 2, width: size, height: size })) icon.setAttribute(k, String(v));
          if (line.tf) icon.setAttribute("transform", line.tf);
          icon.style.color = MARK_COLORS[Object.keys(MARK_ICON).find((v) => MARK_ICON[v] === line.kind)];
          icon.innerHTML = TALLY_ICON[line.kind].replace(/^<svg[^>]*>|<\/svg>$/g, "");
          line.parent.appendChild(icon);
        }
      }
    }

    // Docs' small scrolls blit pixels INSIDE a canvas (the tile doesn't
    // move) — the hook posts the shift at blit time so bars slide with the
    // pixels between authoritative locate rounds (which reset shifts).
    //
    // STILL LOAD-BEARING, despite page-anchored bars. It is dead for those:
    // in paginated view a tile canvas fills its page at offset 0,0, so a blit
    // that moves pixels within the tile moves them within the page too, and
    // page-local geometry simply stays correct — which is why those bars never
    // read a shift. But the glued path is not gone (pageless documents, an
    // unresolvable tile, the hostility latch), and there it is the only thing
    // keeping bars with blit-scrolled text between locates.
    window.addEventListener("message", (ev) => {
      if (ev.source !== window || ev.data?.type !== "tracely-docs-shift") return;
      const t = tileState.get(ev.data.tile);
      if (!t) return;
      t.shiftX += Number(ev.data.dx) || 0;
      t.shiftY += Number(ev.data.dy) || 0;
    });

    window.addEventListener("message", (ev) => {
      if (ev.source !== window || ev.data?.type !== "tracely-docs-rects") return;
      if (orphaned) return; // a reply already in flight when the tab stood down
      if (ev.data.id !== locateSeq) return; // stale response from an older request
      drawDocsMarks(ev.data.rects);
    });

    function requestDocsMarks() {
      if (orphaned || document.hidden) return;
      if (!docsOn) { if (docsBars.length) clearDocsMarks(); return; } // turned off: nothing drawn
      lastLocateAt = Date.now();
      armAnnotationObserver();
      // The hook caps at 40 wants — cap here too so nothing is silently dropped
      // on the other side of the protocol.
      const issues = currentIssues().slice(0, 40);
      const flows = activeFlowIssues();
      // Citation notes get their own marks, on the citation (citationMarks).
      const notes = FEATURES.essayFeedback && isArgumentGenre(docGenre) && review.kind === "essay"
        ? essayFeedbackMarks(docText, essayFeedbackTips(docText, review.findings, dismissed))
        : [];
      const allTips = [...(FEATURES.citeMarks && isArgumentGenre(docGenre) ? citationMarks(docText, settings.citationStyle, dismissed, docGenre) : []), ...notes];
      // One underline per span: a note over the whole of a flagged sentence
      // rides on that sentence's mark and card ("Also here"), not on a second
      // band over the same words (tipCoversSentence).
      coTipsByHash = new Map();
      const tips = [];
      for (const t of allTips) {
        const host = issues.find(({ seg }) => tipCoversSentence(seg.text, t.mark));
        if (host) coTipsByHash.set(host.seg.hash, [...(coTipsByHash.get(host.seg.hash) ?? []), t]);
        else if (tips.length < Math.max(0, 40 - issues.length)) tips.push(t);
      }
      tipMarkById = new Map([...tips, ...[...coTipsByHash.values()].flat()].map((t) => [t.id, t])); // a carried note's card still opens by its id
      if (issues.length === 0 && flows.length === 0 && tips.length === 0) {
        clearDocsMarks();
        // A card that just fixed the last issue stays up to show "Applied ✓ ·
        // Undo"; the pointer leaving it closes it as usual.
        if (!popPinned) hideDocsPopover();
        // Empty ping still prunes the fallback hook's ledgers. id 0 never
        // matches locateSeq, so its reply can never wipe drawn bars.
        window.postMessage({ type: "tracely-docs-locate", id: -1, wants: [] }, "*");
        return;
      }
      lastVerdictByHash = new Map(issues.map(({ seg, f }) => [seg.hash, f.verdict]));
      for (const t of tips) lastVerdictByHash.set(t.id, t.markKind ?? "cite_tip");
      // A flagged sentence whose citation carries its own note stops before
      // it, so the two marks sit side by side instead of on top of each other.
      const factText = (seg) => {
        const { start, end } = factSpanOf(seg.text, tips);
        return seg.text.slice(start, end);
      };
      const located = [...issues.map(({ seg }) => ({ seg: { hash: seg.hash, text: factText(seg) } })), ...tips.map((t) => ({ seg: { hash: t.id, text: t.mark, lastCopy: t.lastCopy } }))];
      // PRIMARY: the SVG annotation layer — complete and live-positioned.
      const svgBars = located.length ? svgLocate(located) : [];
      if (svgBars !== null) {
        drawDocsMarksSvg(svgBars, flows);
        // Keep the hook's ledgers pruned even though we're not using them.
        // id 0: the rects listener ignores this reply — it must never clear
        // the SVG bars we just drew (that exact bug blanked every underline).
        window.postMessage({ type: "tracely-docs-locate", id: -1, wants: [] }, "*");
        return;
      }
      // FALLBACK: no annotation layer — canvas-paint locate via the hook.
      locateSeq++;
      window.postMessage({
        type: "tracely-docs-locate",
        id: locateSeq,
        wants: located.map(({ seg }) => ({ hash: seg.hash, text: seg.text })),
      }, "*");
    }

    /* ── hover popover on the Docs underlines ─────────────────────────────
       Hovering an underline (or the text just above it) opens a compact card:
       verdict badge, explanation, suggested fix, and actions. Lives in the
       page DOM with inline styles only — Docs' stylesheets never touch it. */
    // (verdict labels/washes/colors are the shared top-level maps)
    let popEl = null, popHash = null, popFontIn = false;
    let popApex = null; // the pointer's last spot on the open card's sentence: the safe triangle's tip
    let popAnchor = null, popLastTop = 0, popFollowRaf = 0, popLostAt = 0;
    let popAnchorDx = 0; // where on its line the card hangs from: the pointer's x when it opened
    let popPinned = false; // an edit from this card may remove the underline it follows — stay put

    /* Nothing to load any more: the cards use the app's font stack, which is
       whatever the reader already has. Kept as a no-op so the call sites (and
       their ordering) stay exactly where they were. */
    function popFont() { popFontIn = true; }

    /* Motion. The card eases out of its underline (fade + a few px of slide
       + a hair of scale) instead of popping in, and fades out instead of
       vanishing. Only opacity and transform are animated, on the card itself:
       placeDocsPopover and the follow loop position it with left/top, so the
       two never fight. Moving straight from one underline to the next swaps
       cards with a short fade and no slide, so two cards never stack up. With
       prefers-reduced-motion the card simply appears and disappears. */
    let popClosing = null; // the previous card, fading out — not the live one
    const reducedMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
    const POP_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
    function dropClosingPopover() {
      if (popClosing) { popClosing.remove(); popClosing = null; }
    }
    function animatePopoverIn(el, switching) {
      if (reducedMotion() || typeof el.animate !== "function") return;
      const arrow = el.querySelector("[data-pop-arrow]");
      const ax = arrow ? (parseFloat(arrow.style.left) || 20) + 6 : 26;
      // Grow out of the caret, i.e. the underline — from below when the card
      // sits above its sentence.
      el.style.transformOrigin = `${ax}px ${popAbove ? "100%" : "0px"}`;
      const anim = el.animate(
        switching
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [{ opacity: 0, transform: `translateY(${popAbove ? 6 : -6}px) scale(0.98)` }, { opacity: 1, transform: "none" }],
        { duration: switching ? 70 : 120, easing: POP_EASE },
      );
      setTimeout(() => anim.cancel(), 500); // never a card held invisible by an animation that did not run
    }
    function animatePopoverOut(el) {
      dropClosingPopover();
      if (reducedMotion() || typeof el.animate !== "function") { el.remove(); return; }
      // No longer the live card: nothing may click it or find it while it fades.
      el.style.pointerEvents = "none";
      el.removeAttribute("data-tracely-docs-popover");
      popClosing = el;
      let gone = false;
      const done = () => { if (gone) return; gone = true; el.remove(); if (popClosing === el) popClosing = null; };
      try {
        el.animate(
          [{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateY(${popAbove ? 4 : -4}px)` }],
          { duration: 110, easing: "ease-in", fill: "forwards" },
        ).finished.then(done, done);
      } catch { done(); return; }
      setTimeout(done, 400); // belt and braces: never leave an invisible card behind
    }

    // `instant`: the caller is about to open another card in its place.
    function hideDocsPopover({ instant = false } = {}) {
      if (popEl) console.debug("[tracely] popover hide");
      if (popEl) { if (instant) { dropClosingPopover(); popEl.remove(); } else animatePopoverOut(popEl); }
      else if (instant) dropClosingPopover();
      popEl = null;
      popHash = null;
      popAnchor = null;
      popLostAt = 0;
      popPinned = false;
      popApex = null;
      popSide = null;
      popHeld = false;
      popEditSyncs.clear();
      if (popFollowRaf) { cancelAnimationFrame(popFollowRaf); popFollowRaf = 0; }
      paintDocsActive();
    }

    /* ── the app's popover, state for state ───────────────────────────────
       src/renderer/src/components/DocumentMarkLayer.tsx draws one card over a
       flagged sentence — the problem (dot, title, count; body; [action]
       [Dismiss]) — and, behind its primary button, the fix card, the applied
       card, the error card, and the citation flow's searching / results /
       no-results / failed / inserted cards. Every state below mirrors that
       file's JSX button for button, with index.css's .docmark-* values
       inlined: these cards live in the page DOM, outside the shadow root, so
       they cannot read its custom properties. Widths, gap and the above/
       below rule are the app's (POPOVER_WIDTH, POPOVER_GAP,
       shared/popoverPlacement.ts). What this file adds that the app has not
       got — "Explain in depth" — sits inside the fix card as one more of its
       issue blocks, so no action row gains a button the app's lacks. */
    // POP_CARET: the caret's distance from the card's left edge — it hangs from the word, as Grammarly's does.
    const POP_WIDTH = 320, POP_WIDTH_FLOW = 380, POP_GAP = 10, TAIL_W = 16, TAIL_H = 10, TAIL_NET = TAIL_H - 2, POP_CARET = 40;
    const MIN_CARD = 180; // shared/popoverPlacement.ts MIN_CARD_HEIGHT
    const DM = { // index.css .docmark-*
      ink: "#1c1c1c", body: "#737373", hint: "#9a9ba1", green: "#16a34a", red: "#d93636", amber: "#ffb800", orange: "#ff5900",
      blockBg: "#f8f8f8", rowSel: "#f8f8f8", rowBorder: "#e5e5e5", chipBg: "#f2f2f2", pillBorder: "#e0e0e0",
      badge: "#1a56db", credBg: "#eef7f0", credOtherBg: "#f2f2f3",
    };
    /* The app's copy, verbatim where a state exists there (fixFlowCopy.ts,
       citationFlowCopy.ts), and in its voice where it does not. */
    const POP_COPY = {
      suggestFix: "Suggest fix", findSource: "Find a source", dismiss: "Dismiss", back: "Back", done: "Done", undo: "Undo", undoing: "Undoing…",
      apply: "Apply revision", applying: "Applying…", copyRevision: "Copy revision", copied: "Copied ✓",
      revisionLabel: "SUGGESTED REVISION", foundLabel: "What the check found",
      fixRule: "Same sentence, same voice — only the detail the check found wrong is changed.",
      fixRuleNarrow: "Same sentence, same claim — only stated as carefully as the record supports.",
      noEdit: "Paste it over the sentence yourself — this document isn't editable from here.",
      appliedTitle: "Sentence fixed", appliedBody: "Your sentence now says what the check found. Undo — or ⌘Z — puts it back exactly as it was.",
      couldNot: "Could not apply",
      searching: "Searching for a source", searchHint: "Usually 10–15 seconds", cancel: "Cancel", keepWriting: "Keep writing",
      noSources: "No sources found", noBacking: "Nothing backs this as written", couldntRead: "Couldn't read the sources", searchFailed: "Search failed", searchAgain: "Search again",
      insert: "Cite in doc", inserting: "Citing…", name: "Name it in your sentence", copyCite: "Copy citation", openArticle: "Open article ↗", style: "Style",
      preview: "Preview", hidePreview: "Hide preview",
      copyEntry: "Copy entry",
      willInsert: "WILL BE INSERTED", added: "ADDED TO SOURCES", citedTitle: "Citation added", resolved: "Claim resolved",
      flowTitle: "Flow issue", bridgeLabel: "SUGGESTED BRIDGE", addBridge: "Add transition", copyBridge: "Copy transition",
      bridgeApplied: "Transition added", bridgeAppliedBody: "The bridge sits just before the passage. Undo — or ⌘Z — takes it out again.",
      deep: "Explain in depth", deepLabel: "In depth",
    };
    const CITE_STYLE_LABEL = { apa: "APA 7", mla: "MLA 9", chicago: "Chicago 17" };
    const STANCE_LABEL = { supports: "Supports", refutes: "Refutes", context: "Context" };
    const KIND_LABEL = { journal: "Journal article", institutional: "Institution", reference: "Reference", report: "Report", book: "Book", news: "News", archive: "Archive", other: "Web page" };
    const TRUSTED_KINDS = new Set(["journal", "institutional", "reference", "report", "book"]);

    function truncateClaim(text, max = 70) {
      const clean = text.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
      if (clean.length <= max) return clean;
      const cut = clean.slice(0, max);
      const space = cut.lastIndexOf(" ");
      return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[.,;:]$/, "")}…`;
    }

    /* ── element recipes ─────────────────────────────────────────────────── */
    function el(tag, style, text) {
      const n = document.createElement(tag);
      if (style) Object.assign(n.style, style);
      if (text != null) n.textContent = text;
      return n;
    }
    function dmHead(color, title, right = null) {
      const h = el("div", { display: "flex", alignItems: "center", gap: "8px", flex: "0 0 auto" });
      h.appendChild(el("span", { width: "8px", height: "8px", borderRadius: "50%", flexShrink: "0", background: color }));
      h.appendChild(el("span", { fontSize: "14px", fontWeight: "600", color: DM.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, title));
      if (right) { right.style.marginLeft = "auto"; h.appendChild(right); }
      return h;
    }
    const dmBody = (text) => el("p", { margin: "0", fontSize: "13px", lineHeight: "1.4", color: DM.body, flex: "0 0 auto" }, text);
    const dmHint = (text) => el("span", { fontSize: "12px", color: DM.hint }, text);
    function dmChip(text) {
      return el("span", { flexShrink: "0", borderRadius: "999px", background: DM.chipBg, padding: "3px 9px", fontSize: "11.5px", fontWeight: "500", color: DM.body }, text);
    }
    /* A card's row of buttons. It wraps: the card is 320px and clips what
       overflows, and "Apply revision · Back · Explain in depth PRO" is wider
       than that — the owner's screenshot, 2026-10-09, had the primary cut on
       the left and PRO on the right. Now what does not fit drops to the next
       line (the link keeps its marginLeft:auto, so it sits at the right). */
    function dmActions(...kids) {
      const row = el("div", { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", flex: "0 0 auto" });
      for (const k of kids) if (k) row.appendChild(k);
      return row;
    }
    function dmBtn(label, primary, { disabled = false, wide = false, title } = {}) {
      const b = el("button", {
        padding: "8px 14px", borderRadius: "8px", fontSize: "13px", whiteSpace: "nowrap", cursor: disabled ? "default" : "pointer",
        fontFamily: "inherit", lineHeight: "normal", opacity: disabled ? ".6" : "1",
        background: primary ? DM.ink : "#fff", border: `1px solid ${primary ? DM.ink : "#d9d9d9"}`,
        color: primary ? "#fff" : DM.ink, fontWeight: primary ? "600" : "400", width: wide ? "100%" : "",
      }, label);
      b.type = "button";
      b.disabled = disabled;
      if (title) b.title = title;
      if (!disabled) {
        b.addEventListener("mouseenter", () => { b.style.background = primary ? "#000" : "rgba(0,0,0,0.04)"; });
        b.addEventListener("mouseleave", () => { b.style.background = primary ? DM.ink : "#fff"; });
      }
      return b;
    }
    /* A hint-styled control for what the app puts beside a button row (the
       "Usually 3–5 seconds" hint): the one place "Explain in depth" lives. */
    function dmLink(label) {
      const b = el("button", { background: "none", border: "none", padding: "0", fontFamily: "inherit", fontSize: "12px", color: DM.hint, cursor: "pointer", marginLeft: "auto", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "6px" }, label);
      b.type = "button";
      b.addEventListener("mouseenter", () => { b.style.textDecoration = "underline"; });
      b.addEventListener("mouseleave", () => { b.style.textDecoration = "none"; });
      return b;
    }
    function dmBlock(label, ...kids) {
      const b = el("div", { width: "100%", boxSizing: "border-box", background: DM.blockBg, borderRadius: "10px", padding: "12px", display: "flex", flexDirection: "column", gap: "6px", flex: "0 0 auto" });
      if (label) b.appendChild(el("div", { fontSize: "10.5px", fontWeight: "600", color: DM.hint, letterSpacing: "0.6px" }, label));
      for (const k of kids) if (k) b.appendChild(k);
      return b;
    }
    const dmQuote = (text, mono = false) => el("div", { fontSize: mono ? "12px" : "13px", lineHeight: "1.45", color: DM.ink, userSelect: "text", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "inherit" }, text);
    const dmBlockMarker = (text) => el("div", { fontSize: "12.5px", fontWeight: "500", color: DM.ink }, text);
    const dmBlockBody = (text) => el("div", { fontSize: "12px", lineHeight: "1.4", color: DM.body }, text);
    function dmIssue(title, detail) {
      const w = el("div", { display: "flex", flexDirection: "column", gap: "2px", flex: "0 0 auto" });
      if (title) w.appendChild(el("div", { fontSize: "13px", fontWeight: "500", color: DM.ink }, title));
      w.appendChild(dmBody(detail));
      return w;
    }
    function dmProgress() {
      const bar = el("div", { width: "100%", height: "6px", borderRadius: "999px", background: "#ededed", overflow: "hidden", flex: "0 0 auto" });
      // Ink, not the frame's orange: orange is a finding colour, and a search
      // in progress is not a finding (CLAUDE.md "UI decisions").
      const fill = el("div", { height: "100%", width: "40%", borderRadius: "999px", background: DM.ink });
      bar.appendChild(fill);
      if (!reducedMotion() && typeof fill.animate === "function") {
        fill.animate([{ transform: "translateX(-100%)" }, { transform: "translateX(250%)" }], { duration: 1100, iterations: Infinity, easing: "ease-in-out" });
      }
      return bar;
    }
    function dmSkeletons() {
      const w = el("div", { display: "flex", flexDirection: "column", gap: "10px", flex: "0 0 auto" });
      for (const [wide, narrow] of [[214, 122], [186, 96]]) {
        const row = el("div", { display: "flex", alignItems: "center", gap: "10px" });
        row.appendChild(el("span", { display: "block", width: "28px", height: "28px", borderRadius: "8px", background: "#ebebeb", flexShrink: "0" }));
        const lines = el("span", { display: "flex", flexDirection: "column", gap: "6px" });
        lines.appendChild(el("span", { display: "block", height: "9px", borderRadius: "999px", background: "#ebebeb", width: `${wide}px` }));
        lines.appendChild(el("span", { display: "block", height: "8px", borderRadius: "999px", background: "#f4f4f4", width: `${narrow}px` }));
        row.appendChild(lines);
        w.appendChild(row);
        if (!reducedMotion() && typeof row.animate === "function") row.animate([{ opacity: 0.5 }, { opacity: 1 }, { opacity: 0.5 }], { duration: 1100, iterations: Infinity, easing: "ease-in-out" });
      }
      return w;
    }
    function initialsOf(src) {
      const name = String(src.publisher || src.title || "").replace(/^www\./, "").trim();
      const words = name.split(/[\s.\-_/]+/).filter(Boolean);
      const s = words.length >= 2 ? words[0][0] + words[1][0] : name.slice(0, 2);
      return (s || "??").toUpperCase();
    }
    /* The row's 28px / 8px-radius box: the favicon on white when there is one,
       the design's two-letter tile underneath it otherwise — and again if the
       image fails, so a row never shows an empty square. */
    function dmSourceIcon(src) {
      const box = el("span", { position: "relative", width: "28px", height: "28px", flexShrink: "0", borderRadius: "8px", overflow: "hidden", background: DM.badge, color: "#fff", fontSize: "10px", fontWeight: "600", display: "flex", alignItems: "center", justifyContent: "center" }, initialsOf(src));
      const icon = faviconUrl(src.url);
      if (!icon) return box;
      const wrap = el("span", { position: "absolute", inset: "0", background: "#fff", border: "1px solid #e5e5e5", borderRadius: "8px", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center" });
      const img = el("img", { width: "18px", height: "18px", display: "block" });
      img.alt = "";
      img.referrerPolicy = "no-referrer"; // the domain is all Google needs; never the page the user is on
      img.addEventListener("error", () => wrap.remove(), { once: true });
      img.src = icon;
      wrap.appendChild(img);
      box.appendChild(wrap);
      return box;
    }
    function dmRow(src, selected, onSelect) {
      const row = el("button", {
        display: "flex", alignItems: "center", gap: "10px", width: "100%", padding: "8px", borderRadius: "10px",
        border: `1px solid ${selected ? DM.rowBorder : "transparent"}`, background: selected ? DM.rowSel : "transparent",
        textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer", flex: "0 0 auto", boxSizing: "border-box",
      });
      row.type = "button";
      row.appendChild(dmSourceIcon(src));
      const meta = el("span", { minWidth: "0", flex: "1", display: "flex", flexDirection: "column", gap: "2px", overflow: "hidden" });
      meta.appendChild(el("span", { fontSize: "13.5px", fontWeight: "500", color: DM.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, src.title || src.url));
      const sub = el("span", { display: "flex", alignItems: "center", gap: "6px", minWidth: "0", fontSize: "12px", color: DM.hint });
      sub.appendChild(el("span", { minWidth: "0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, `${src.publisher || "Unknown publisher"}${src.year ? ` · ${src.year}` : ""}`));
      // The app's match column never shrinks; here it says the source's stance on the claim.
      const stance = STANCE_LABEL[src.stance] ?? "Context";
      sub.appendChild(el("span", { color: src.stance === "supports" ? DM.green : src.stance === "refutes" ? DM.red : DM.body, fontWeight: "500", whiteSpace: "nowrap", flexShrink: "0" }, stance));
      meta.appendChild(sub);
      // The receipt (backingSources): the source's own words, two lines
      // until the row is picked, then whole — and where they were read.
      if (src.quote) {
        const says = el("span", { fontSize: "12px", lineHeight: "1.4", color: DM.ink, whiteSpace: "normal", marginTop: "2px" }, `${RECEIPT_COPY.says} “${src.quote}”`);
        says.setAttribute("data-pop-receipt", "");
        if (!selected) {
          says.style.display = "-webkit-box";
          says.style.setProperty("-webkit-line-clamp", "2");
          says.style.setProperty("-webkit-box-orient", "vertical");
          says.style.overflow = "hidden";
        }
        meta.appendChild(says);
        const from = RECEIPT_COPY.from[src.readFrom];
        if (from) meta.appendChild(el("span", { fontSize: "11px", color: DM.hint }, from));
      }
      const trusted = TRUSTED_KINDS.has(src.kind);
      meta.appendChild(el("span", { alignSelf: "flex-start", fontSize: "10.5px", fontWeight: "600", letterSpacing: "0.3px", borderRadius: "999px", padding: "2px 7px", marginTop: "3px", whiteSpace: "nowrap", background: trusted ? DM.credBg : DM.credOtherBg, color: trusted ? DM.green : DM.body }, KIND_LABEL[src.kind] ?? KIND_LABEL.other));
      row.appendChild(meta);
      const radio = el("span", { width: "18px", height: "18px", flexShrink: "0", borderRadius: "999px", boxSizing: "border-box" });
      if (selected) Object.assign(radio.style, { border: "none", background: DM.ink, boxShadow: `inset 0 0 0 6px ${DM.ink}, inset 0 0 0 3px #fff` });
      else Object.assign(radio.style, { border: "1.5px solid #d1d1d1", background: "#fff" });
      row.appendChild(radio);
      row.addEventListener("click", onSelect);
      return row;
    }
    /* The sources the server could not read (backingSources' `unread`),
       behind one toggle, closed until asked: Open only, never Cite. */
    function dmUnread(unread, open, onToggle) {
      if (!Array.isArray(unread) || !unread.length) return null;
      const w = el("div", { display: "flex", flexDirection: "column", gap: "4px", flex: "0 0 auto" });
      const t = dmLink(`${open ? "▾" : "▸"} ${RECEIPT_COPY.unread} (${unread.length})`);
      Object.assign(t.style, { marginLeft: "0", alignSelf: "flex-start" });
      t.setAttribute("aria-expanded", open ? "true" : "false");
      t.setAttribute("data-pop-unread", "");
      t.addEventListener("click", onToggle);
      w.appendChild(t);
      if (open) {
        for (const src of unread) {
          const row = el("div", { display: "flex", alignItems: "center", gap: "10px", padding: "4px 8px" });
          row.appendChild(dmSourceIcon(src));
          const meta = el("span", { minWidth: "0", flex: "1", display: "flex", flexDirection: "column", gap: "2px", overflow: "hidden" });
          meta.appendChild(el("span", { fontSize: "13px", fontWeight: "500", color: DM.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, src.title || src.url));
          meta.appendChild(el("span", { fontSize: "12px", color: DM.hint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, src.publisher || ""));
          row.appendChild(meta);
          const go = dmBtn(RECEIPT_COPY.open, false, { title: src.url });
          go.addEventListener("click", () => window.open(src.url, "_blank", "noopener,noreferrer"));
          row.appendChild(go);
          w.appendChild(row);
        }
      }
      return w;
    }
    function dmStyles(current, onSet) {
      const w = el("div", { display: "flex", alignItems: "center", gap: "6px", flex: "0 0 auto" });
      w.appendChild(el("span", { fontSize: "12px", fontWeight: "500", color: DM.body }, POP_COPY.style));
      for (const [key] of CITE_STYLES) {
        const on = key === current;
        const p = el("button", { borderRadius: "999px", padding: "5px 11px", fontFamily: "inherit", fontSize: "12px", fontWeight: on ? "600" : "400", color: on ? "#fff" : DM.body, background: on ? DM.ink : "#fff", border: `1px solid ${on ? DM.ink : DM.pillBorder}`, cursor: "pointer" }, CITE_STYLE_LABEL[key]);
        p.type = "button";
        p.addEventListener("click", () => onSet(key));
        w.appendChild(p);
      }
      return w;
    }
    function dmTail(pointing, above) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", String(TAIL_W)); svg.setAttribute("height", String(TAIL_H));
      svg.setAttribute("viewBox", "0 0 13.8564 7.5"); svg.setAttribute("fill", "none"); svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("data-pop-arrow", "");
      Object.assign(svg.style, { position: "relative", display: "block", left: "12px", flex: "0 0 auto",
        transform: pointing === "down" ? "scaleY(-1)" : "", ...(above ? { marginTop: "-2px" } : { marginBottom: "-2px" }) });
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M11.5708 6.5H2.28562L6.9282 1.47363L11.5708 6.5Z");
      path.setAttribute("fill", "white"); path.setAttribute("stroke", "black"); path.setAttribute("stroke-width", "2");
      svg.appendChild(path);
      return svg;
    }

    /* ── state ───────────────────────────────────────────────────────────── */
    // hash → { step, selected, searched }: which of the app's cards is showing.
    const popSteps = new Map();
    const stepOf = (hash) => popSteps.get(hash) ?? { step: "problem", selected: null, searched: false };
    function setStep(hash, patch) { popSteps.set(hash, { ...stepOf(hash), ...patch }); paintPop(); }
    let popCard = null, popAbove = false, popWidth = POP_WIDTH;

    function editState(key) { return docEditState.get(key)?.state ?? null; }
    const fixTitle = (verdict) => verdict === "questionable" ? "Narrow this claim" : verdict === "false" ? "What to check" : "What to change";

    /* ── placement: the app's above/below rule, in viewport space ──────────
       Owner, 2026-10-09: "the underline overlay compacts when it is under the
       screen … when I hover over underline and go to click the action button
       such as delete this, it jumps around". The card was measured AFTER its
       height had been capped to the room below the line, so near the bottom
       of the screen it was squeezed — and then judged by the squeezed size,
       so it stayed squeezed, or flipped above and back as its content changed
       and moved out from under a pointer on its way to a button. Now the
       card's FULL height decides (popNaturalHeight); it opens below when it
       fits there, else above when it fits there, else on the roomier side;
       it keeps that side while it still fits — and always while the pointer
       is on it (popHeld) — and only a card taller than its side's room is
       capped (its list scrolls).
       And then it is ONE PIECE (owner, 2026-10-09: "make the whole overlay
       move as one piece … so when I scroll it to be half out of frame it
       moves accordingly"): its side and its size are decided when it opens
       and when its content changes (popPlanned, reset by paintPop) — never
       by a scroll. A scroll only carries it with its line, half out of view
       if that is where the line takes it: no flip, no squeeze, no pinning to
       the screen's edge. */
    let popSide = null; // "above" | "below": the side the open card keeps
    let popHeld = false; // the pointer is on the card: it does not change side under it
    let popPlanned = false; // side and size decided for what the card shows now
    function popNaturalHeight() {
      // What the scroll regions hide when the card is capped, added back.
      let hidden = 0;
      for (const d of popCard.querySelectorAll("div")) if (d.style.overflowY === "auto") hidden += Math.max(0, d.scrollHeight - d.clientHeight);
      return popCard.offsetHeight + hidden + Math.max(0, popCard.scrollHeight - popCard.clientHeight);
    }
    function placeDocsPopover(r) {
      if (!popEl || !popCard) return;
      const width = popWidth;
      const cx = r.centerX ?? r.left + 24;
      // Under the pointer, hanging down-right from it, so straight down is the card.
      const idealLeft = cx - POP_CARET;
      const left = Math.max(8, Math.min(idealLeft, innerWidth - width - 8));
      const markTop = r.top, markH = (r.bottom ?? r.top + 4) - r.top;
      const below = markTop + markH + POP_GAP;
      if (!popPlanned) {
        popPlanned = true;
        // The card's own height, uncapped and tail excluded: what has to fit on one side.
        const cardH = popNaturalHeight();
        const spaceBelow = innerHeight - below - 8;
        const spaceAbove = markTop - POP_GAP - 8;
        const fits = (side) => cardH <= (side === "above" ? spaceAbove : spaceBelow) - TAIL_NET;
        if (!popSide || (!popHeld && !fits(popSide))) {
          popSide = fits("below") ? "below" : fits("above") ? "above" : spaceAbove > spaceBelow ? "above" : "below";
        }
        // Capped only when it is taller than the room on its side, so the
        // buttons never fall past the fold; then its list is what scrolls.
        const room = (popSide === "above" ? spaceAbove : spaceBelow) - TAIL_NET;
        const cap = cardH > room ? `${Math.max(MIN_CARD, room)}px` : "";
        if (popCard.style.maxHeight !== cap) popCard.style.maxHeight = cap;
      }
      const above = popSide === "above";
      if (above !== popAbove) {
        popAbove = above;
        const old = popEl.querySelector("[data-pop-arrow]");
        if (old) old.remove();
        const tail = dmTail(above ? "down" : "up", above);
        if (above) popEl.appendChild(tail); else popEl.insertBefore(tail, popEl.firstChild);
      }
      // Carried with its line, wherever that is — half out of view included.
      const top = above ? markTop - POP_GAP - popCard.offsetHeight - TAIL_NET : below;
      const leftPx = `${left}px`, topPx = `${Math.round(top)}px`;
      if (popEl.style.left !== leftPx) popEl.style.left = leftPx;
      if (popEl.style.top !== topPx) popEl.style.top = topPx;
      const tail = popEl.querySelector("[data-pop-arrow]");
      if (tail) tail.style.left = `${Math.max(12, Math.min(cx - left - TAIL_W / 2, width - 28))}px`;
    }

    /* Follow loop — only alive while a popover is open. The underlines are
       compositor-carried, so a card parked at its open position visibly
       detaches on the first scroll; this re-pins it every frame. When a
       re-locate rebuilds docsBars, the old anchor element dies — re-bind to
       the same claim's nearest bar. Anchor gone >400ms → the text left the
       viewport (or the claim resolved): let the card go. */
    function popFollowFrame() {
      popFollowRaf = 0;
      if (!popEl) return;
      const ok = (b) => b && b.el.isConnected && b.el.style.display !== "none" && b.el.style.opacity !== "0";
      if (!ok(popAnchor)) {
        let best = null, bestD = Infinity;
        for (const b of docsBars) {
          if (b.hash !== popHash || !ok(b)) continue;
          const d = Math.abs(b.el.getBoundingClientRect().top - popLastTop);
          if (d < bestD) { best = b; bestD = d; }
        }
        if (best) popAnchor = best;
      }
      let placed = false;
      if (ok(popAnchor)) {
        const r = popAnchor.el.getBoundingClientRect();
        if (!docsScroller || !docsScroller.isConnected) {
          docsScroller = document.querySelector(".kix-appview-editor");
        }
        const clip = docsScroller ? docsScroller.getBoundingClientRect() : null;
        // Carried with its line wherever it goes — the line out of view and the
        // card half out with it (owner, 2026-10-09). It is lost only once the
        // CARD has left the view.
        popLastTop = r.top;
        placeDocsPopover({ left: r.left, top: r.top, bottom: r.bottom, size: popAnchor.size, centerX: r.left + Math.min(popAnchorDx, r.width) });
        const pb = popEl.getBoundingClientRect();
        if (!clip || (pb.bottom > clip.top + 8 && pb.top < clip.bottom - 8)) {
          popLostAt = 0;
          placed = true;
        }
      }
      if (!placed && !popPinned) {
        if (!popLostAt) popLostAt = performance.now();
        else if (performance.now() - popLostAt > 400) { hideDocsPopover(); return; }
      }
      popFollowRaf = requestAnimationFrame(popFollowFrame);
    }

    /* ── open / paint ────────────────────────────────────────────────────── */
    function openPop(hash, rect, anchorBar, width) {
      popFont();
      const switching = Boolean(popEl);
      hideDocsPopover({ instant: true });
      popHash = hash;
      popWidth = width;
      popAbove = false;
      popSide = null;
      popHeld = false;
      popPlanned = false;
      popEl = el("div", { position: "fixed", zIndex: "901", width: `${width}px`, display: "flex", flexDirection: "column", fontFamily: APP.font, color: DM.ink, WebkitFontSmoothing: "antialiased" });
      popEl.setAttribute("data-tracely-docs-popover", "");
      popEl.appendChild(dmTail("up", false));
      popCard = el("div", { display: "flex", flexDirection: "column", gap: "12px", background: "#fff", border: "2px solid #000", borderRadius: "16px", padding: "16px", boxShadow: "0 8px 24px rgba(0,0,0,0.18)", boxSizing: "border-box", width: "100%", overflow: "hidden" });
      popCard.setAttribute("data-pop-card", "");
      popEl.appendChild(popCard);
      popEl.addEventListener("pointerenter", () => { popHeld = true; });
      popEl.addEventListener("pointerleave", () => { popHeld = false; });
      popEditSyncs.add(paintPop); // every edit-state change repaints the card
      paintPop();
      popEl.style.visibility = "hidden";
      document.documentElement.appendChild(popEl);
      placeDocsPopover(rect);
      popEl.style.visibility = "visible";
      animatePopoverIn(popEl, switching);
      popAnchor = anchorBar ?? null;
      popAnchorDx = Math.max(0, (rect.centerX ?? rect.left + POP_CARET) - rect.left);
      popLastTop = rect.top;
      popLostAt = 0;
      if (!popFollowRaf) popFollowRaf = requestAnimationFrame(popFollowFrame);
      paintDocsActive();
    }
    function showDocsPopover(hash, rect, anchorBar) {
      if (!cache.get(hash) && !tipMarkById.has(hash)) return;
      openPop(hash, rect, anchorBar, POP_WIDTH);
    }
    function showFlowPopover(bar, rect, anchorBar) {
      console.debug("[tracely] flow popover open", bar.hash);
      popFlowBar = bar;
      openPop(bar.hash, rect, anchorBar, POP_WIDTH_FLOW);
    }
    let popFlowBar = null;
    // The two entry points other code already calls: repaint if this claim is up.
    function renderPopSources(hash) { if (popEl && (popHash === hash || stepOf(popHash).claim === hash)) paintPop(); }
    function renderPopDeep(hash) { if (popEl && popHash === hash) paintPop(); }

    /* A citation note's card: what is wrong with the citation, the passage it
       is about, and what can be done — "Find the cited work" where it names
       a work, "Find a source" for the claim an excuse, a hedge or an unnamed
       source leaves unsupported — then Dismiss. The block names what it
       quotes: the sentence for a note about one, the citation for a bracket
       that stands in for one, the entry for a reference-list note. It said
       REFERENCE over every sentence an excuse or a hedge was found in. */
    function citeTipBlockLabel(tip) {
      if (tip.markKind === "note_tip" || TIP_FIND_SOURCE.includes(tip.kind)) return "SENTENCE";
      if (tip.kind === "page") return "QUOTED";
      if (tip.kind === "badcite") return "CITATION";
      return "REFERENCE";
    }
    /* "Also here": the notes a flagged sentence carries on its own underline
       (coTipsByHash), one row each, opening that note's card in this one —
       with a way back to the sentence's. The dot is the note's own finding
       colour; the words say what it is. */
    function dmAlso(tips, backTo, backLabel) {
      const box = el("div", { display: "flex", flexDirection: "column", gap: "4px", flex: "0 0 auto" });
      for (const t of tips) {
        const b = el("button", { display: "flex", alignItems: "center", gap: "8px", width: "100%", padding: "6px 10px", borderRadius: "8px", border: `1px solid ${DM.rowBorder}`, background: DM.blockBg, font: "inherit", fontSize: "12.5px", color: DM.ink, cursor: "pointer", textAlign: "left", boxSizing: "border-box" });
        b.type = "button";
        b.append(el("span", { width: "8px", height: "8px", borderRadius: "50%", background: MARK_COLORS[t.markKind ?? "cite_tip"], flexShrink: "0" }), el("span", { flex: "1", minWidth: "0" }, `Also here: ${TIP_LABEL[t.kind] ?? "a note"}`), el("span", { color: DM.hint }, "›"));
        b.addEventListener("click", () => { popPinned = true; popSteps.set(t.id, { ...stepOf(t.id), backTo, backLabel }); popHash = t.id; paintPop(); });
        box.appendChild(b);
      }
      return box;
    }
    function paintCiteTip(tip, put) {
      const from = stepOf(tip.id);
      if (from.backTo) {
        const back = dmLink(`‹ ${from.backLabel ?? POP_COPY.back}`);
        Object.assign(back.style, { marginLeft: "0", alignSelf: "flex-start" });
        back.addEventListener("click", () => { popPinned = true; popHash = from.backTo; paintPop(); });
        put(back);
      }
      put(dmHead(MARK_COLORS[tip.markKind ?? "cite_tip"], tip.label ?? TIP_LABEL[tip.kind] ?? "Citation"));
      put(dmBody(tip.message));
      put(dmBlock(citeTipBlockLabel(tip), dmQuote(tip.quote.length > 220 ? tip.quote.slice(0, 219) + "…" : tip.quote)));
      const target = tipCitedTarget(tip, segments);
      // An excuse's fix is deleting it and dating the citation it excuses
      // (Find the cited work, which searches for the claim when nothing
      // resolves): a search beside those read as citing the excuse itself.
      const findSrc = (TIP_FIND_SOURCE.includes(tip.kind) || tip.action === "cite") && !(tip.kind === "excuse" && target) && claimSentenceIndex(tip.kind, tip.quote, segments) >= 0;
      const fix = tipFixControls(tip, put);
      let cited = null, src = null;
      if (target) {
        cited = dmBtn(CITED_COPY.find, true);
        cited.addEventListener("click", () => { findCitedWork(tip.id); });
      }
      if (findSrc) {
        src = dmBtn(POP_COPY.findSource, !target, { wide: Boolean(target) });
        src.addEventListener("pointerdown", () => prestartClaim(tip.id));
        src.addEventListener("click", () => { findClaimSource(tip.id); });
      }
      const dismiss = dmBtn("Dismiss", false);
      dismiss.addEventListener("click", () => {
        dismissed.add(tip.id);
        lsSet(DISMISS_KEY, JSON.stringify([...dismissed]));
        hideDocsPopover();
        render();
        requestDocsMarks();
      });
      // Two to a row: a third button would push Dismiss past the card's edge.
      const first = fix ?? cited ?? src;
      put(dmActions(first, dismiss));
      for (const b of [cited, src]) if (b && b !== first) { b.style.width = "100%"; put(b); }
    }
    /* The note's own fix in the hover card (paintCiteTip): Delete, the page
       box, or Rewrite in doc. Returns the button for the action row; a page
       box goes in above it. null when the note has none the editor can make. */
    function tipFixControls(tip, put) {
      if (!canEditDoc()) return null;
      if (canDeleteTip(tip)) {
        const busy = editState(`del:${tip.id}`) === "applying";
        const b = dmBtn(deleteLabel(tip), true, { disabled: busy || docBusy });
        b.addEventListener("click", () => { popPinned = true; armOrDelete(tip.id); });
        return b;
      }
      if (tip.kind === "page") {
        const key = `page:${tip.id}`;
        const busy = editState(key) === "applying";
        const input = el("input", { flex: "1", minWidth: "0", padding: "8px 10px", borderRadius: "8px", border: "1px solid #d9d9d9", fontSize: "13px", fontFamily: "inherit", color: DM.ink });
        input.placeholder = "Page number, e.g. 45";
        input.inputMode = "numeric";
        input.value = pageDrafts.get(tip.id) ?? "";
        input.setAttribute("aria-label", "Page number");
        const b = dmBtn(busy ? "Adding…" : "Add page", true, { disabled: busy || docBusy || !PAGE_INPUT.test(input.value.trim()) });
        const go = () => { if (PAGE_INPUT.test(input.value.trim())) { popPinned = true; docAddPage(tip.id, input.value.trim()); } };
        input.addEventListener("focus", () => { popPinned = true; });
        input.addEventListener("input", () => {
          pageDrafts.set(tip.id, input.value);
          const ok = PAGE_INPUT.test(input.value.trim());
          b.disabled = !ok || docBusy;
          b.style.opacity = b.disabled ? ".6" : "1";
        });
        // The page is typed here, not into the Doc behind the card.
        input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") go(); });
        b.addEventListener("click", go);
        const row = el("div", { display: "flex", gap: "8px", alignItems: "center", flex: "0 0 auto" });
        row.append(input, b);
        put(row);
        return null;
      }
      if (tipRewrite(tip)) {
        put(dmBlock("SUGGESTED REWRITE", dmBlockBody(tipRewrite(tip))));
        const busy = editState(`rw:${tip.id}`) === "applying";
        const b = dmBtn(busy ? POP_COPY.applying : "Rewrite in doc", true, { disabled: busy || docBusy });
        b.addEventListener("click", () => { popPinned = true; docRewriteTip(tip.id); });
        return b;
      }
      return null;
    }
    // After a note's own fix: what happened, with Undo while it is the last edit.
    function paintTipDone(tipId, pst, put) {
      const key = pst.editKey ?? "";
      const st = docEditState.get(key);
      if (st?.state === "failed") {
        put(dmHead(DM.red, POP_COPY.couldNot), dmBody(`${st.copied ? "Copied instead — " : ""}${st.note || "the editor couldn't make that edit"}.`));
        const b = dmBtn(POP_COPY.back, true);
        b.addEventListener("click", () => { setEditState(key, null); popSteps.delete(tipId); hideDocsPopover(); });
        put(dmActions(b));
        return;
      }
      const title = key.startsWith("del:") ? "Deleted" : key.startsWith("page:") ? "Page added" : "Rewritten";
      put(dmHead(DM.green, title), dmBody(`${title === "Deleted" ? "It's out of your document" : "Your document has the change"}. Undo — or ⌘Z — puts it back exactly as it was.`));
      const ok = dmBtn(POP_COPY.done, true);
      ok.addEventListener("click", () => { popSteps.delete(tipId); hideDocsPopover(); });
      const undo = dmBtn(st?.state === "undoing" ? POP_COPY.undoing : POP_COPY.undo, false, { disabled: st?.state === "undoing" || lastDocEdit?.key !== key });
      undo.addEventListener("click", () => { popPinned = true; undoLastDocEdit(); });
      put(dmActions(ok, undo));
    }

    /* "Find the cited work", card for card: looking it up, the record(s) with
       Replace citation / Complete entry / Copy reference, and the edit's
       applied and failed states. A lookup that resolves nothing never shows
       here — the card has already moved on to the sentence's search, with
       the server's note on top (paintSources' `note`). */
    function dmWorkRow(src, selected, onSelect) {
      const row = el("button", {
        display: "flex", alignItems: "flex-start", gap: "10px", width: "100%", padding: "8px", borderRadius: "10px",
        border: `1px solid ${selected ? DM.rowBorder : "transparent"}`, background: selected ? DM.rowSel : "transparent",
        textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer", flex: "0 0 auto", boxSizing: "border-box",
      });
      row.type = "button";
      const meta = el("span", { minWidth: "0", flex: "1", display: "flex", flexDirection: "column", gap: "2px" });
      meta.appendChild(el("span", { fontSize: "13.5px", fontWeight: "500", color: DM.ink, overflowWrap: "anywhere" }, src.title));
      const line = citedMetaLine(src);
      if (line) meta.appendChild(el("span", { fontSize: "12px", color: DM.hint, overflowWrap: "anywhere" }, line));
      row.appendChild(meta);
      const radio = el("span", { width: "18px", height: "18px", flexShrink: "0", borderRadius: "999px", boxSizing: "border-box", marginTop: "2px" });
      if (selected) Object.assign(radio.style, { border: "none", background: DM.ink, boxShadow: `inset 0 0 0 6px ${DM.ink}, inset 0 0 0 3px #fff` });
      else Object.assign(radio.style, { border: "1.5px solid #d1d1d1", background: "#fff" });
      row.appendChild(radio);
      row.addEventListener("click", onSelect);
      return row;
    }
    function paintCited(key, put) {
      const c = citedMap.get(key);
      const t = c.target;
      const style = settings.citationStyle || "mla";
      const back = () => { popSteps.delete(key); paintPop(); };
      // The edit made from this card, if one is showing.
      const editKey = [...docEditState.keys()].find((k) => k.startsWith(`recite:${key}:`) || k.startsWith(`entry:${key}:`)) ?? null;
      // An edit the export already shows keeps its confirmation here; its
      // Undo has moved to the panel's strip by then.
      const done = editKey ? docEditState.get(editKey) : c.done ? { state: "applied" } : null;
      const doneKey = editKey ?? c.done?.key ?? "";
      if (done && (done.state === "applied" || done.state === "undoing")) {
        const entry = doneKey.startsWith("entry:");
        put(dmHead(DM.green, entry ? CITED_COPY.completedTitle : CITED_COPY.replacedTitle), dmBody(c.done?.message ?? (entry ? "The reference entry now gives the record's details." : "Your sentence now cites the work you meant.")));
        if (c.done?.paste) put(dmBlock(`ADD THIS TO YOUR ${String(c.done.list || "Works Cited").toUpperCase()}`, dmBlockBody(c.done.paste)));
        const ok = dmBtn(POP_COPY.done, true);
        ok.addEventListener("click", () => { if (editKey) setEditState(editKey, null); popSteps.delete(key); hideDocsPopover(); });
        const undo = dmBtn(done.state === "undoing" ? POP_COPY.undoing : POP_COPY.undo, false, { disabled: done.state === "undoing" || lastDocEdit?.key !== doneKey });
        undo.addEventListener("click", () => { popPinned = true; undoLastDocEdit(); });
        put(dmActions(ok, undo));
        return;
      }
      if (done?.state === "failed") {
        put(dmHead(DM.red, POP_COPY.couldNot), dmBody(`${done.copied ? "Copied instead — " : ""}${done.note || "the editor couldn't make that edit"}.`));
        const b = dmBtn(POP_COPY.back, true);
        b.addEventListener("click", () => { setEditState(doneKey, null); paintPop(); });
        put(dmActions(b));
        return;
      }
      if (c.loading) {
        put(dmHead(MARK_PENDING, CITED_COPY.searching), dmBody(`Searching Crossref and Open Library for “${c.plan?.display ?? ""}”.`), dmProgress());
        const cancel = dmBtn(POP_COPY.cancel, false);
        cancel.addEventListener("click", back);
        put(dmActions(cancel));
        return;
      }
      if (!c.resolved) {
        // An entry has no sentence to search for: the note is the answer.
        put(dmHead(DM.amber, CITED_COPY.one), dmBody(c.note));
        if (c.plan?.noEntry) put(dmHint(CITED_COPY.noEntry));
        const b = dmBtn(POP_COPY.back, true);
        b.addEventListener("click", back);
        put(dmActions(b));
        return;
      }
      const list = c.matches;
      const sel = Math.min(Math.max(0, c.selected ?? 0), list.length - 1);
      const src = list[sel];
      const styleChip = dmChip(CITE_STYLE_LABEL[style]);
      const by = c.byAuthor;
      // Amber, not green: works by the author the citation names are not the
      // work it meant until the writer picks the one they read.
      put(dmHead(by ? DM.amber : DM.green, by ? CITED_COPY.byAuthorTitle(by.name) : list.length === 1 ? CITED_COPY.one : CITED_COPY.many(list.length), styleChip));
      styleChip.style.marginLeft = "0";
      const scroll = el("div", { flex: "1 1 auto", minHeight: "0", overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px" });
      scroll.appendChild(dmBody(by ? CITED_COPY.byAuthorIntro(by.name, c.plan?.display ?? "") : CITED_COPY.intro(c.plan?.display ?? "")));
      if (by?.offClaim?.length) scroll.appendChild(el("p", { margin: "0", fontSize: "13px", lineHeight: "1.4", color: DM.ink, fontWeight: "500", flex: "0 0 auto" }, CITED_COPY.offClaim(by.offClaim)));
      if (c.plan?.noEntry) scroll.appendChild(dmHint(CITED_COPY.noEntry));
      const rows = el("div", { display: "flex", flexDirection: "column", gap: "4px" });
      list.forEach((m, i) => rows.appendChild(dmWorkRow(m, i === sel, () => { c.selected = i; paintPop(); })));
      scroll.appendChild(rows);
      const yn = citedYearNote(src.year, c.plan?.citedYear);
      if (yn) scroll.appendChild(dmBlock("THE YEAR", dmBlockBody(yn)));
      scroll.appendChild(dmStyles(style, (k) => { settings.citationStyle = k; settings.styleChosen = true; saveSettings(); paintPop(); render(); }));
      const { marker, entry } = citedWorkEntry(src, style);
      const swapped = t?.kind === "sentence" && t.raw ? swapCitation(t.sentence, t.raw, marker, style) : null;
      // The sentence already cites it as the style would ("(Shiraishi)" in
      // MLA): what is missing is the entry, and that is what the button adds.
      const same = !swapped && t?.kind === "sentence" && sameCitation(t.raw, marker, style);
      scroll.appendChild(dmBlock(swapped ? "YOUR SENTENCE WILL READ" : "REFERENCE", swapped ? dmBlockBody(swapped) : null, dmBlockBody(entry)));
      put(scroll);
      const repKey = `recite:${key}:${sel}`, entKey = `entry:${key}:${sel}`;
      let primary = null;
      if (canEditDoc() && (swapped || same) && t.segHash) {
        const busy = editState(repKey) === "applying";
        primary = dmBtn(busy ? (same ? CITED_COPY.adding : CITED_COPY.replacing) : same ? CITED_COPY.addEntry : CITED_COPY.replace, true, { disabled: busy || docBusy });
        primary.addEventListener("click", () => { popPinned = true; docReplaceCitation(key, sel, popAnchor); });
      } else if (canEditDoc() && t?.kind === "entry") {
        const busy = editState(entKey) === "applying";
        primary = dmBtn(busy ? CITED_COPY.completing : CITED_COPY.complete, true, { disabled: busy || docBusy });
        primary.addEventListener("click", () => { popPinned = true; docCompleteEntry(key, sel); });
      }
      const copy = dmBtn(copiedCitedKey === `${key}:${sel}` ? POP_COPY.copied : CITED_COPY.copyRef, !primary);
      copy.addEventListener("click", () => copyCitedReference(key, sel));
      put(dmActions(primary, copy));
      if (t?.segHash) {
        const more = dmBtn(CITED_COPY.different, false, { wide: true });
        more.addEventListener("pointerdown", () => { fetchSources(t.segHash).catch(() => {}); });
        more.addEventListener("click", () => { startClaimSources(key, t.segHash, t.sentence); });
        put(more);
      }
      if (!canEditDoc() && (swapped || t?.kind === "entry")) put(dmHint(editBlockReason()));
    }
    // A card's search for the sentence it is about, painted with the
    // citation flow's own cards (paintSources), whatever opened it.
    function paintClaimSources(key, pst, put) {
      const seg = segments.find((s) => s.hash === pst.claim) ?? { hash: pst.claim, text: String(pst.claimText ?? "") };
      paintSources(pst.claim, seg, cache.get(pst.claim), pst, put, {
        stepKey: key,
        onBack: () => { popSteps.delete(key); paintPop(); },
        note: citedNote(key),
      });
    }

    function paintPop() {
      if (!popEl || !popCard) return;
      popPlanned = false; // new content: its side and size are decided again (popHeld keeps the side)
      const hash = popHash;
      popCard.textContent = "";
      const put = (...kids) => { for (const k of kids) if (k) popCard.appendChild(k); };
      const flow = popFlowBar && popFlowBar.hash === hash ? popFlowBar.flow : null;
      if (flow) { paintFlow(hash, flow, put); requestPlace(); return; }
      // "Find the cited work", and a card's search for the sentence it is
      // about: painted from their own state, which outlives the underline
      // the card was opened on (an edit from here can remove it).
      const pst = stepOf(hash);
      if (pst.step === "cited" && citedMap.has(hash)) { paintCited(hash, put); requestPlace(); return; }
      if (pst.step === "sources" && pst.claim) { paintClaimSources(hash, pst, put); requestPlace(); return; }
      if (pst.step === "tipdone") { paintTipDone(hash, pst, put); requestPlace(); return; }
      const tip = tipMarkById.get(hash);
      if (tip) { paintCiteTip(tip, put); requestPlace(); return; }
      const f = cache.get(hash);
      const seg = segments.find((s) => s.hash === hash);
      // The edit made from this card — its own revision, or the fuller
      // answer's ("deepfix:") — shows how it went even after the sentence it
      // replaced is gone. A fix drops that sentence's verdict, and the card
      // used to paint itself empty right there, over "Sentence fixed".
      const fixKey = editState(`deepfix:${hash}`) ? `deepfix:${hash}` : `fix:${hash}`;
      const fixState = editState(fixKey);
      if (fixState === "applied" || fixState === "undoing") {
        put(dmHead(DM.green, POP_COPY.appliedTitle), dmBody(POP_COPY.appliedBody));
        const done = dmBtn(POP_COPY.done, true);
        done.addEventListener("click", () => { setEditState(fixKey, null); popSteps.delete(hash); hideDocsPopover(); });
        const undo = dmBtn(fixState === "undoing" ? POP_COPY.undoing : POP_COPY.undo, false, { disabled: fixState === "undoing" || lastDocEdit?.key !== fixKey });
        undo.addEventListener("click", () => { popPinned = true; undoLastDocEdit(); });
        put(dmActions(done, undo));
        requestPlace(); return;
      }
      if (fixState === "failed") {
        const s = docEditState.get(fixKey);
        put(dmHead(DM.red, POP_COPY.couldNot), dmBody(`${s?.copied ? "Copied instead — " : ""}${s?.note || "the editor couldn't make that edit"}.`));
        const back = dmBtn(POP_COPY.back, true);
        back.addEventListener("click", () => { setEditState(fixKey, null); setStep(hash, { step: "fix" }); });
        put(dmActions(back));
        requestPlace(); return;
      }
      if (!f || !seg) return;
      const st = stepOf(hash);
      const color = MARK_COLORS[f.verdict] ?? "#9a9ba1";
      const hasRevision = Boolean(f.revision) && f.verdict !== "needs_citation";

      if (st.step === "sources") { paintSources(hash, seg, f, st, put, { note: citedNote(hash) }); requestPlace(); return; }

      if (st.step === "fix" || fixState === "applying") {
        // The fix card: what the check found, the revision, Apply / Back.
        put(dmHead(color, fixTitle(f.verdict)));
        put(dmBody(f.verdict === "questionable" ? POP_COPY.fixRuleNarrow : POP_COPY.fixRule));
        if (f.basis) put(dmIssue(POP_COPY.foundLabel, f.basis));
        else if (f.explanation) put(dmIssue(POP_COPY.foundLabel, f.explanation));
        put(paintDeep(hash, f));
        if (hasRevision) put(dmBlock(POP_COPY.revisionLabel, dmQuote(f.revision)));
        const applying = fixState === "applying";
        let primary = null;
        if (hasRevision && canEditDoc()) {
          primary = dmBtn(applying ? POP_COPY.applying : POP_COPY.apply, true, { disabled: applying || docBusy });
          primary.addEventListener("click", () => { popPinned = true; docFix(hash, popAnchor); });
        } else if (hasRevision) {
          primary = dmBtn(POP_COPY.copyRevision, true);
          primary.addEventListener("click", () => { try { navigator.clipboard.writeText(f.revision); } catch { /* denied */ } primary.textContent = POP_COPY.copied; });
        }
        const back = dmBtn(POP_COPY.back, false);
        back.addEventListener("click", () => setStep(hash, { step: "problem" }));
        // The link sits beside the buttons; the locked note is a line of its own.
        const link = deepLink(hash, f);
        const inRow = link?.tagName === "BUTTON";
        put(dmActions(primary, back, inRow ? link : null));
        if (link && !inRow) put(dmActions(link));
        if (hasRevision && !canEditDoc()) put(dmHint(editBlockReason()));
        requestPlace(); return;
      }

      // The problem card — exactly the app's: dot, title; body; [action][Dismiss].
      // A sentence whose citation the verdict puts in doubt also offers to
      // find the cited work: first when there is no fix to suggest, else
      // under the row (two buttons to a row; a third pushes Dismiss off).
      put(dmHead(color, VERDICT_LABEL[f.verdict] ?? f.verdict));
      const also = (coTipsByHash.get(hash) ?? []).filter((t) => !dismissed.has(t.id));
      if (also.length) put(dmAlso(also, hash, VERDICT_LABEL[f.verdict] ?? f.verdict));
      put(dmBody(f.explanation || f.basis || seg.text));
      const citedHere = Boolean(flaggedCitationOf(f.verdict, seg.text));
      const findSource = () => {
        // The search marks itself in flight before its first await, so the
        // card painted next already reads "searching" rather than "failed".
        const started = fetchSources(hash);
        setStep(hash, { step: "sources", searched: true });
        started.then((ok) => { if (ok === false) setStep(hash, { step: "problem" }); }).catch(() => {});
      };
      const action = dmBtn(hasRevision ? POP_COPY.suggestFix : citedHere ? CITED_COPY.find : POP_COPY.findSource, true);
      if (!hasRevision && !citedHere) action.addEventListener("pointerdown", () => { fetchSources(hash).catch(() => {}); });
      action.addEventListener("click", () => {
        if (hasRevision) { setStep(hash, { step: "fix" }); return; }
        if (citedHere) { findCitedWork(hash); return; }
        findSource();
      });
      const dis = dmBtn(POP_COPY.dismiss, false);
      dis.addEventListener("click", () => {
        dismissed.add(hash);
        lsSet(DISMISS_KEY, JSON.stringify([...dismissed]));
        popSteps.delete(hash);
        hideDocsPopover();
        requestDocsMarks();
        render();
      });
      put(dmActions(action, dis));
      if (citedHere) {
        const more = dmBtn(hasRevision ? CITED_COPY.find : POP_COPY.findSource, false, { wide: true });
        if (!hasRevision) more.addEventListener("pointerdown", () => { fetchSources(hash).catch(() => {}); });
        more.addEventListener("click", () => { if (hasRevision) findCitedWork(hash); else findSource(); });
        put(more);
      }
      // A card with no fix of its own has no fix card to hold "Explain in
      // depth": it lives here instead — the answer, and its own fix when it
      // has one, or the link that asks for it.
      if (!hasRevision) {
        put(paintDeep(hash, f));
        const link = deepLink(hash, f);
        if (link) put(dmActions(link));
      }
      requestPlace();
    }

    /* "Explain in depth" inside the fix card: the app's `.docmark-fix-issues`
       shape (a titled paragraph), and the loading and locked states in it. */
    function paintDeep(hash, f) {
      if (!FEATURES.deepDive) return null;
      const v = deepView(hash, f.verdict);
      if (v.kind === "loading") {
        const w = el("div", { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: DM.body, flex: "0 0 auto" });
        const spin = el("span", { width: "12px", height: "12px", borderRadius: "50%", flexShrink: "0", border: "2px solid rgba(255,89,0,0.25)", borderTopColor: DM.orange });
        if (!reducedMotion() && typeof spin.animate === "function") spin.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 800, iterations: Infinity });
        w.append(spin, document.createTextNode(v.text));
        return w;
      }
      if (v.kind === "result") {
        const title = v.prefix ? `${POP_COPY.deepLabel} — ${v.prefix}` : POP_COPY.deepLabel;
        const w = dmIssue(title, v.text);
        if (v.verdictLabel) w.insertBefore(el("span", { alignSelf: "flex-start", fontSize: "10px", fontWeight: "600", padding: "1px 6px", borderRadius: "20px", background: "rgba(0,0,0,.07)", color: "#55555c", margin: "2px 0" }, v.verdictLabel), w.lastChild);
        if (v.note) w.appendChild(dmHint(v.note));
        if (!v.basis && !v.revision) return w;
        // What the fuller answer rests on, and its own fix — applied like the
        // card's (docFix, one Undo), or copied where the doc cannot be edited.
        const col = el("div", { display: "flex", flexDirection: "column", gap: "10px", flex: "0 0 auto" });
        col.appendChild(w);
        if (v.basis) col.appendChild(dmIssue("What it rests on", v.basis));
        if (v.revision) {
          const own = Boolean(f.revision) && f.verdict !== "needs_citation";
          col.appendChild(dmBlock("IN-DEPTH REVISION", dmQuote(v.revision)));
          let apply = null;
          if (canEditDoc()) {
            const busy = editState(`deepfix:${hash}`) === "applying";
            apply = dmBtn(busy ? POP_COPY.applying : own ? "Apply this one" : POP_COPY.apply, !own, { disabled: busy || docBusy });
            apply.addEventListener("click", () => { popPinned = true; docFix(hash, popAnchor, deepRevision(hash)); });
          }
          const copy = dmBtn(POP_COPY.copyRevision, !apply && !own);
          copy.addEventListener("click", () => { try { navigator.clipboard.writeText(v.revision); } catch { /* denied */ } copy.textContent = POP_COPY.copied; });
          col.appendChild(dmActions(apply, copy));
        }
        return col;
      }
      return null;
    }
    // The link that asks for it — beside the fix card's buttons, as the app
    // puts its hint beside Cancel. Locked: the PRO chip and a "See plans" note.
    function deepLink(hash, f) {
      if (!FEATURES.deepDive) return null;
      const v = deepView(hash, f.verdict);
      if (v.kind === "loading" || v.kind === "result") return null;
      // Asked for and locked: say why, with the way to the plans — as the
      // panel does. The click before this one only says it; it never
      // navigates away from the doc on its own.
      if (v.kind === "locked" && v.note) {
        const plans = dmLink(DEEP_COPY.seePlans);
        Object.assign(plans.style, { marginLeft: "6px", color: APP.accentInk });
        plans.addEventListener("click", () => openOrderPage());
        const said = el("span", { fontSize: "12px", color: DM.hint }, `${v.note}.`);
        said.appendChild(plans);
        return said;
      }
      const link = dmLink(v.label);
      if (v.kind === "locked") {
        link.title = v.title;
        link.appendChild(el("span", { padding: "1px 6px", borderRadius: "20px", background: APP.accentWash, color: APP.accentInk, fontSize: "10px", fontWeight: "600", letterSpacing: ".02em" }, "PRO"));
        link.addEventListener("click", () => { lockDeep(hash); paintPop(); render(); });
      } else {
        link.addEventListener("click", () => { explainSentence(hash); paintPop(); });
      }
      if (v.error) link.title = v.error;
      return link;
    }

    /* ── the citation flow, card for card ───────────────────────────────── */
    /* opts, for a search a card started for a sentence that is not its own
       (a note's claim, a lookup's fallback): stepKey — the card whose step
       this is; onBack — where Cancel goes; note — what the lookup before it
       found, said first. A cited source takes the place of the sentence's
       faulty citation when a card found one (replaceFor). */
    function paintSources(hash, seg, f, st, put, opts = {}) {
      const s = sourcesMap.get(hash);
      const style = settings.citationStyle || "mla";
      const stepKey = opts.stepKey ?? hash;
      const back = opts.onBack ?? (() => setStep(stepKey, { step: "problem" }));
      const noteEl = () => (opts.note ? dmBlock(CITED_COPY.yours, dmBlockBody(opts.note)) : null);
      const replace = replaceFor(hash);
      const citedKey = (url) => `cite:${hash}:${url}`;
      // Inserted: the marker is in the sentence, the entry in the Sources list.
      const citedUrl = s?.citedUrl ?? null;
      const citedState = citedUrl ? editState(citedKey(citedUrl)) : null;
      if (citedState === "applied" || citedState === "undoing") {
        const src = s.list.find((x) => x.url === citedUrl);
        const c = src ? formatCitation(src, style) : null;
        // The desktop overlay's rule (CLAUDE.md, "The confirmation says
        // different things on the two surfaces"): never say ADDED over a
        // list nothing was added to.
        const paste = s.pasteEntry || null;
        put(dmHead(DM.green, POP_COPY.citedTitle), dmBody(paste
          ? `${c ? c.marker : "The citation"} is in your sentence${s.replaced ? ", in place of the citation that couldn't be traced" : ""}. Docs didn't let Tracely add the reference itself — copy it below and paste it at the end of your document.`
          : s.named
            ? `Your sentence now names ${s.named} where it named no one. ${CITE_STYLE_LABEL[style]} citation.`
          : s.replaced
            ? `${c ? c.marker : "The source"} now stands where the citation that couldn't be traced was. ${CITE_STYLE_LABEL[style]} in-text citation.`
            : `This claim is now backed by a source in your document. ${CITE_STYLE_LABEL[style]} in-text citation inserted.`));
        const listName = s.citedList || REF_HEADINGS[style] || "Works Cited";
        if (paste) put(dmBlock(`ADD THIS TO YOUR ${listName.toUpperCase()}`, dmBlockBody(paste)));
        else if (c) put(dmBlock(`ADDED TO ${listName.toUpperCase()}`, dmBlockBody(c.ref)));
        const left = segments.filter((x) => x.hash !== hash && flagShown(cache.get(x.hash), settings, docGenre, x.text, citedLater.has(x.hash)) && !dismissed.has(x.hash)).length;
        const res = el("div", { display: "flex", alignItems: "center", gap: "6px", fontSize: "12.5px", whiteSpace: "nowrap", flex: "0 0 auto" });
        res.append(el("span", { color: DM.green, fontWeight: "500" }, POP_COPY.resolved), dmHint(`· ${left === 0 ? "no flags left" : `${left} flag${left === 1 ? "" : "s"} left`}`));
        put(res);
        const done = dmBtn(POP_COPY.done, true);
        done.addEventListener("click", () => { popSteps.delete(stepKey); hideDocsPopover(); });
        const undo = dmBtn(citedState === "undoing" ? POP_COPY.undoing : POP_COPY.undo, false, { disabled: citedState === "undoing" || lastDocEdit?.key !== citedKey(citedUrl) });
        undo.addEventListener("click", () => { popPinned = true; undoLastDocEdit(); });
        let copyEntry = null;
        if (paste) {
          copyEntry = dmBtn(POP_COPY.copyEntry, false);
          copyEntry.addEventListener("click", () => { copyFallback(paste).then((ok) => { copyEntry.textContent = ok ? POP_COPY.copied : POP_COPY.copyEntry; }); });
        }
        put(dmActions(done, copyEntry, undo));
        return;
      }
      const failedKey = [...docEditState.keys()].find((k) => k.startsWith(`cite:${hash}:`) && docEditState.get(k)?.state === "failed");
      if (failedKey) {
        const fs = docEditState.get(failedKey);
        put(dmHead(DM.red, POP_COPY.couldNot), dmBody(`${fs?.copied ? "Copied instead — " : ""}${fs?.note || "the editor couldn't make that edit"}.`));
        const back = dmBtn(POP_COPY.back, true);
        back.addEventListener("click", () => { setEditState(failedKey, null); paintPop(); });
        put(dmActions(back));
        return;
      }
      // Searching.
      if (!s || s.loading) {
        if (!s && !sourcesInflight && st.searched) {
          put(dmHead(DM.red, POP_COPY.searchFailed), dmBody(statusMsg || "The search did not answer — try again."), noteEl());
          const again = dmBtn(POP_COPY.searchAgain, true);
          again.addEventListener("click", () => { const p = fetchSources(hash); setStep(stepKey, { searched: true }); p.catch(() => {}); });
          const cancel = dmBtn(POP_COPY.cancel, false);
          cancel.addEventListener("click", back);
          put(dmActions(again, cancel));
          return;
        }
        // Grey: the colour the marks already use for "still checking". The
        // live search fills it in as it goes (dmLive): the sites it found and
        // where each one's reading is.
        const live = s?.live ?? null;
        put(dmHead(MARK_PENDING, live ? liveTitle(live) : POP_COPY.searching), noteEl(), dmBody(live ? liveBody(live, seg) : `Searching the web for a source that supports “${truncateClaim(seg.text)}.”`));
        if (live?.found?.length) put(dmLive(live));
        else put(dmProgress(), dmSkeletons());
        // The search goes on with the card closed and says when it is done
        // (noteSourcesReady); it is never cancelled from here.
        const keep = dmBtn(POP_COPY.keepWriting, false);
        keep.addEventListener("click", () => { popPinned = false; hideDocsPopover(); });
        put(dmActions(keep, dmHint(liveHint(live))));
        return;
      }
      const list = s.list ?? [];
      const unread = s.unread ?? [];
      const unreadEl = () => dmUnread(unread, st.unreadOpen === true, () => setStep(stepKey, { unreadOpen: !st.unreadOpen }));
      const searchAgain = () => { sourcesMap.delete(hash); const p = fetchSources(hash); setStep(stepKey, { searched: true, selected: null }); p.catch(() => {}); };
      if (list.length === 0) {
        if (s.unbacked) put(dmHead(DM.amber, POP_COPY.noBacking), dmBody(UNBACKED_NOTE(s.unbacked)));
        else if (unread.length) put(dmHead(DM.amber, POP_COPY.couldntRead), dmBody(RECEIPT_COPY.unreadOnly(unread.length)));
        else put(dmHead(DM.amber, POP_COPY.noSources), dmBody(`Nothing came back for “${truncateClaim(seg.text)}.” That does not make the claim wrong — it means there is nothing here to cite for it yet.`));
        put(noteEl());
        // Opened, the unread list scrolls; the buttons below never move.
        const unreadBlock = unreadEl();
        if (unreadBlock) {
          const box = el("div", { flex: "1 1 auto", minHeight: "0", overflowY: "auto", display: "flex", flexDirection: "column" });
          box.appendChild(unreadBlock);
          put(box);
        }
        const again = dmBtn(POP_COPY.searchAgain, true);
        again.addEventListener("click", searchAgain);
        const dis = dmBtn(POP_COPY.dismiss, false);
        dis.addEventListener("click", back);
        put(dmActions(again, dis));
        return;
      }
      // Results.
      const selected = st.selected ?? list[0]?.url ?? null;
      const src = list.find((x) => x.url === selected) ?? null;
      const styleChip = dmChip(CITE_STYLE_LABEL[style]);
      put(dmHead(DM.green, `${list.length} source${list.length === 1 ? "" : "s"} found`, styleChip));
      styleChip.style.marginLeft = "0"; // beside the title, as the frame draws it
      const scroll = el("div", { flex: "1 1 auto", minHeight: "0", overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px" });
      scroll.setAttribute("data-pop-sources", "");
      const note = noteEl();
      if (note) scroll.appendChild(note);
      scroll.appendChild(dmBody(`Ranked by how directly each source supports “${truncateClaim(seg.text)}.”`));
      const rows = el("div", { display: "flex", flexDirection: "column", gap: "4px" });
      for (const item of list) rows.appendChild(dmRow(item, item.url === selected, () => setStep(stepKey, { selected: item.url })));
      scroll.appendChild(rows);
      const unreadBlock = unreadEl();
      if (unreadBlock) scroll.appendChild(unreadBlock);
      // The style pills and the preview scroll with the list. The app keeps
      // them outside its scroll region, in an editor tall enough not to
      // notice; in a browser window the card is often capped to the room
      // under the line, and with these fixed the list was what collapsed —
      // to nothing. Its own rule decides it: the header and the buttons
      // never move, everything between them gives.
      scroll.appendChild(dmStyles(style, (key) => { settings.citationStyle = key; settings.styleChosen = true; persistSettings(settings, SETTINGS_KEY); paintPop(); }));
      // Naming the source rewrites the writer's words, so what the sentence
      // will say is shown without asking, not behind Preview.
      const named = src && !replace ? nameTheSource(seg.text, src, style) : null;
      if (named && !st.preview) scroll.appendChild(dmBlock("YOUR SENTENCE WILL READ", dmBlockBody(named), dmBlockBody(formatCitation(src, style).ref)));
      // Behind "Preview", as in Figma "Find a Source (Results)": the card is
      // usually capped to the room under the line, and the citation is the
      // part a writer checks once, not on every source they click through.
      // "Open article" lives in it, so the action row is the frame's two.
      if (src && st.preview) {
        const c = formatCitation(src, style);
        const open = dmLink(POP_COPY.openArticle);
        Object.assign(open.style, { marginLeft: "0", alignSelf: "flex-start" });
        open.title = src.url;
        open.addEventListener("click", () => window.open(src.url, "_blank", "noopener,noreferrer"));
        const swapped = replace ? swapCitation(seg.text, replace, c.marker, style) : named;
        scroll.appendChild(swapped
          ? dmBlock("YOUR SENTENCE WILL READ", dmBlockBody(swapped), dmBlockBody(c.ref), open)
          : dmBlock(POP_COPY.willInsert, dmBlockMarker(c.marker), dmBlockBody(c.ref), open));
      }
      put(scroll);
      const i = src ? list.indexOf(src) : -1;
      const key = src ? citedKey(src.url) : null;
      const inserting = key ? editState(key) === "applying" : false;
      let primary;
      if (canEditDoc()) {
        // In place of the sentence's faulty citation when a card found one; beside it otherwise.
        primary = dmBtn(inserting ? POP_COPY.inserting : replace ? CITED_COPY.replace : named ? POP_COPY.name : POP_COPY.insert, true, { disabled: !src || inserting || docBusy });
        primary.addEventListener("click", () => { if (i >= 0) { popPinned = true; docCite(hash, i, popAnchor, replaceFor(hash)); } });
      } else {
        primary = dmBtn(POP_COPY.copyCite, true, { disabled: !src });
        primary.addEventListener("click", () => { if (!src) return; try { navigator.clipboard.writeText(formatCitation(src, style).ref); } catch { /* denied */ } primary.textContent = POP_COPY.copied; });
      }
      const preview = dmBtn(st.preview ? POP_COPY.hidePreview : POP_COPY.preview, false, { disabled: !src });
      preview.addEventListener("click", () => setStep(stepKey, { preview: !st.preview }));
      put(dmActions(primary, preview));
      const again = dmBtn(POP_COPY.searchAgain, false, { wide: true });
      again.addEventListener("click", searchAgain);
      put(again);
    }

    /* ── the flow card: the same card, over a paragraph that jumps ───────── */
    function paintFlow(hash, issue, put) {
      const key = `flow:${hash}`;
      const state = editState(key);
      if (state === "applied" || state === "undoing") {
        put(dmHead(DM.green, POP_COPY.bridgeApplied), dmBody(POP_COPY.bridgeAppliedBody));
        const done = dmBtn(POP_COPY.done, true);
        done.addEventListener("click", () => { setEditState(key, null); hideDocsPopover(); });
        const undo = dmBtn(state === "undoing" ? POP_COPY.undoing : POP_COPY.undo, false, { disabled: state === "undoing" || lastDocEdit?.key !== key });
        undo.addEventListener("click", () => { popPinned = true; undoLastDocEdit(); });
        put(dmActions(done, undo));
        return;
      }
      if (state === "failed") {
        const s = docEditState.get(key);
        put(dmHead(DM.red, POP_COPY.couldNot), dmBody(`${s?.copied ? "Copied instead — " : ""}${s?.note || "the editor couldn't make that edit"}.`));
        const back = dmBtn(POP_COPY.back, true);
        back.addEventListener("click", () => { setEditState(key, null); paintPop(); });
        put(dmActions(back));
        return;
      }
      put(dmHead(FLOW_ACCENT, POP_COPY.flowTitle), dmBody(issue.explanation));
      if (issue.transition) put(dmBlock(POP_COPY.bridgeLabel, dmQuote(issue.transition)));
      let primary = null;
      if (issue.transition && canEditDoc()) {
        const applying = state === "applying";
        primary = dmBtn(applying ? POP_COPY.applying : POP_COPY.addBridge, true, { disabled: applying || docBusy });
        primary.addEventListener("click", () => { popPinned = true; addTransition(hash, issue); });
      } else if (issue.transition) {
        primary = dmBtn(POP_COPY.copyBridge, true);
        primary.addEventListener("click", () => { try { navigator.clipboard.writeText(issue.transition); } catch { /* denied */ } primary.textContent = POP_COPY.copied; });
      }
      const dis = dmBtn(POP_COPY.dismiss, false);
      dis.addEventListener("click", () => { flowDismissed.add(hash); persistFlow(); hideDocsPopover(); requestDocsMarks(); render(); });
      put(dmActions(primary, dis));
      if (issue.transition && !canEditDoc()) put(dmHint(editBlockReason()));
    }

    // A repaint changes the card's height; the next frame re-places it (the
    // follow loop does this every frame while a card is up, so this is only
    // for the frame between a paint and the loop).
    function requestPlace() {
      if (!popAnchor?.el?.isConnected) return;
      const r = popAnchor.el.getBoundingClientRect();
      placeDocsPopover({ left: r.left, top: r.top, bottom: r.bottom, size: popAnchor.size, centerX: r.left + Math.min(popAnchorDx, r.width) });
    }

    /* Hover intent (hoverIntent, inSafeTriangle). One pending decision at a
       time; when its timer fires the pointer is looked at again, and the
       decision runs only if it still holds. */
    let hoverRafBusy = false, hoverPt = { x: -1, y: -1 }, hoverPending = null;
    function clearHoverPending() { if (hoverPending) { clearTimeout(hoverPending.timer); hoverPending = null; } }
    // Tracely's own panel and suggestions cover the underlines beneath them.
    function overTracelyUi(x, y) {
      const t = document.elementFromPoint?.(x, y) ?? null;
      return Boolean(t && !(popEl && popEl.contains(t)) && typeof t.closest === "function" && t.closest("#tracely-host, [data-tracely-fix-card], [data-tracely-type-bubble]"));
    }
    function hoverState(x, y) {
      // Bars are DOM-anchored now — read their LIVE viewport rects, which
      // are correct mid-scroll by construction.
      // In-tree bars are PAINT-clipped by the editor natively but their
      // client rects still exist off-viewport — clip the hit-test too, or
      // scrolled-away bars open phantom popovers over Docs chrome.
      if (!docsScroller || !docsScroller.isConnected) {
        docsScroller = document.querySelector(".kix-appview-editor");
      }
      const clip = docsScroller ? docsScroller.getBoundingClientRect() : null;
      const hitOf = (b) => {
        if (!b.el.isConnected || b.el.style.opacity === "0" || b.el.style.display === "none") return null;
        const r = b.el.getBoundingClientRect();
        if (clip && (r.bottom < clip.top + 2 || r.top > clip.bottom - 2 || r.left > clip.right || r.right < clip.left)) return null;
        return x >= r.left - 2 && x <= r.right + 2 && y >= r.top - b.size && y <= r.bottom + 3
          ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, size: b.size, centerX: r.left + r.width / 2 }
          : null;
      };
      let onOwn = false, bar = null, hit = null;
      for (const b of docsBars) {
        if (popEl && b.hash === popHash) { if (!onOwn && hitOf(b)) onOwn = true; continue; }
        if (bar) continue;
        const h = hitOf(b);
        if (h) { bar = b; hit = h; }
      }
      let onCard = false, inTri = false;
      if (popEl) {
        const pb = popEl.getBoundingClientRect();
        onCard = x >= pb.left - 12 && x <= pb.right + 12 && y >= pb.top - 12 && y <= pb.bottom + 12;
        if (!onCard && !onOwn) inTri = inSafeTriangle(popApex, (popCard ?? popEl).getBoundingClientRect(), x, y);
      }
      // Not while pinned: an edit from this card is still settling. And not
      // through Tracely's own panel or suggestions.
      if ((popEl && popPinned) || (bar && overTracelyUi(x, y))) bar = null;
      return { open: Boolean(popEl), popHash, onCard, onOwn, inTri, under: bar?.hash ?? null, bar, hit };
    }
    function runHoverDecision(d, st) {
      if (d.act === "hide") { hideDocsPopover(); return; }
      if (!st.bar) return;
      // Hung from the pointer's spot on the line, not the line's middle.
      const hit = { ...st.hit, centerX: Math.max(st.hit.left, Math.min(st.hit.right ?? st.hit.left, hoverPt.x)) };
      if (st.bar.flow) showFlowPopover(st.bar, hit, st.bar);
      else showDocsPopover(st.bar.hash, hit, st.bar);
      popApex = { x: hoverPt.x, y: hoverPt.y };
    }
    function hoverHit() {
      hoverRafBusy = false;
      const { x, y } = hoverPt;
      const st = hoverState(x, y);
      const d = hoverIntent(st);
      if (st.onOwn) popApex = { x, y };
      // The sentence under a closed pointer lights up at once; its card follows.
      const lit = d.act === "open" ? d.hash : null;
      if (lit !== docsHoverHash) { docsHoverHash = lit; paintDocsActive(); }
      if (d.act === "stay" || d.act === "none") { clearHoverPending(); return; }
      const same = hoverPending && hoverPending.act === d.act && hoverPending.hash === d.hash && hoverPending.rest === Boolean(d.rest);
      // Already counting down — unless this one waits for the pointer to REST
      // and it has moved since.
      if (same && !(d.rest && Math.hypot(x - hoverPending.x, y - hoverPending.y) > 3)) return;
      clearHoverPending();
      const pending = { act: d.act, hash: d.hash, rest: Boolean(d.rest), x, y, timer: 0 };
      pending.timer = setTimeout(() => {
        if (hoverPending !== pending) return;
        hoverPending = null;
        const now = hoverState(hoverPt.x, hoverPt.y);
        const again = hoverIntent(now);
        if (again.act === d.act && again.hash === d.hash) runHoverDecision(again, now);
        // Something else holds now and no move may come to say so: decide again.
        else hoverHit();
      }, d.ms);
      hoverPending = pending;
    }
    window.addEventListener("mousemove", (e) => {
      hoverPt = { x: e.clientX, y: e.clientY };
      if (hoverRafBusy) return;
      hoverRafBusy = true;
      // rAF starves in hidden/throttled tabs — a lone mousemove during a
      // tab-hide must not wedge hover forever, so a timer backstops the frame.
      let hoverRan = false;
      const runHover = (fn) => { if (hoverRan) return; hoverRan = true; fn(); };
      setTimeout(() => runHover(hoverHit), 90);
      requestAnimationFrame(() => runHover(hoverHit));
    }, { passive: true });
    // Out of the window (the toolbar, another app): no move will come to close
    // the card, so the pointer counts as nowhere.
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget) return;
      hoverPt = { x: -1e4, y: -1e4 };
      hoverHit();
    }, { passive: true });
    /* Typing closes an open card, as Grammarly's does — not typing into the
       card itself (a page number), not while an edit from it settles, not
       while the pointer is on it. Esc closes it too. */
    function typingClosesCard(e) {
      if (!popEl || popPinned || popHeld || ["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
      const t = e.target;
      if (t && typeof t.closest === "function" && t.closest("[data-tracely-docs-popover], #tracely-host")) return;
      clearHoverPending();
      hideDocsPopover();
    }

    // Scroll/wheel fire at frame rate; a trailing 140ms throttle keeps the
    // locate pass (line assembly + matching in the page world) off the hot
    // path while underlines still track a scroll closely.
    let locateQueued = false;
    function scheduleDocsMarks() {
      if (locateQueued) return;
      locateQueued = true;
      setTimeout(() => {
        locateQueued = false;
        requestDocsMarks();
      }, 140);
    }

    /* ── instant re-match ──────────────────────────────────────────────
       Bars are repositioned every frame from live annotation-rect geometry,
       so scrolling itself never lags. What DID lag: after Google recycles or
       re-coordinates its annotation nodes (typing, reflow, fast scroll), we
       waited out a 140ms throttle or the 900ms poll before re-matching.
       A MutationObserver on the editor subtree, filtered to exactly the
       attributes Google's annotation layer mutates, re-matches within one
       frame of Google's own update — the earliest any extension can know. */
    let lastLocateAt = 0;
    function fastDocsMarks() {
      // 90ms floor: continuous typing mutates annotations every frame, and a
      // full locate pass per frame would jank the editor. One locate per 90ms
      // reads as instant; bursts fall through to the trailing throttle.
      if (Date.now() - lastLocateAt > 90) requestDocsMarks();
      else scheduleDocsMarks();
    }
    let annoObs = null, annoObsTarget = null, annoRafPending = false;
    function armAnnotationObserver() {
      const target = document.querySelector(".kix-appview-editor");
      if (!target || target === annoObsTarget) return;
      if (annoObs) annoObs.disconnect();
      annoObsTarget = target;
      annoObs = new MutationObserver((records) => {
        // Our own bars live INSIDE the observed subtree now — filter out our
        // writes or every draw would trigger a re-locate loop.
        const oursEl = (n) => n.nodeType === 1 && n.hasAttribute("data-tracely-bar");
        let external = false;
        const removedOurs = [];
        for (const rec of records) {
          if (rec.type === "attributes") {
            if (oursEl(rec.target)) continue; // our geometry-follow writes below
            external = true;
            continue;
          }
          const added = [...rec.addedNodes], removed = [...rec.removedNodes];
          // Insertion-only all-ours records are ALWAYS our own draw — nothing
          // else creates data-tracely-bar elements. (Gating this on
          // selfMutating is a microtask-ordering trap: a clear that touched
          // nothing observable queues its reset BEFORE the first insertion
          // enqueues the observer callback, so the flag is already false.)
          if (removed.length === 0 && added.length > 0 && added.every(oursEl)) continue;
          if (selfMutating && added.every(oursEl) && removed.every(oursEl)) continue; // our clear pass
          for (const n of removed) if (oursEl(n)) removedOurs.push(n);
          external = true;
        }
        if (!external) return;
        /* Hostility check — batch-scoped and precise: a strike only when Docs
           deleted OUR node while the host it was injected into is still
           connected (the annotation rect for an in-tree bar, the kix page for
           a page-anchored bar or its overlay). Benign tile teardown (even one
           removeChild per record, à la Closure) takes the host down too, so it
           never strikes; targeted sanitization of foreign children does. Retry
           first — re-injection is one locate — and latch to the glued layer on
           4 strikes in 10s, with a doubling cooldown instead of forever.

           One latch covers both in-tree strategies deliberately: they differ
           only in WHERE inside Docs' subtree the node goes, and a Docs that
           sanitizes one is not a Docs to keep feeding the other. */
        if (removedOurs.length && Date.now() >= inTreeDisabledUntil) {
          const hostAlive = (el) => {
            if (el.hasAttribute("data-tracely-page-layer")) {
              for (const [page, layer] of pageLayers) if (layer === el) return page.isConnected;
              return false;
            }
            const b = docsBars.find((bar) => bar.el === el);
            return !!(b?.node?.isConnected || b?.page?.isConnected);
          };
          const targeted = removedOurs.some(hostAlive);
          if (targeted) {
            const now = Date.now();
            hostileStrikes = hostileStrikes.filter((t) => now - t < 10_000);
            hostileStrikes.push(now);
            if (hostileStrikes.length >= 4) {
              inTreeDisabledUntil = now + inTreeCooldown;
              inTreeCooldown = Math.min(inTreeCooldown * 2, 900_000);
              hostileStrikes = [];
              console.warn(`[tracely] Docs keeps deleting bars injected into its subtree — glued fallback for ${Math.round((inTreeDisabledUntil - now) / 1000)}s`);
            }
          }
        }
        /* Same-microtask maintenance: observer callbacks run BEFORE the next
           paint, so bars are corrected before a wrong frame can ever hit the
           screen. Recycled binding → hide until re-match; re-coordinated
           geometry/transform on the SAME text → follow it in place. */
        /* No blank frame per keystroke. Owner, 2026-10-04: "every time I type
           a character the underlines flicker". Typing rewrites the line's
           annotation (and reflows every line after it in the paragraph); the
           old code HID each such bar and waited a frame — or up to 140ms when
           typing fast (fastDocsMarks' floor) — to re-match, so every bar on
           those lines blinked on every key. Now a bar whose line only changed
           its text keeps following that line, and anything that needs a
           re-match gets one HERE, in this callback, which runs before the
           next paint: the frame the user sees is already corrected. */
        let relocateNow = false;
        for (const b of docsBars) {
          if (!b.node || !b.inSvg) continue;
          if (b.flow) { // brackets are re-located wholesale by the next pass
            if (!b.el.isConnected || !b.node.isConnected) { b.el.style.display = "none"; relocateNow = true; }
            continue;
          }
          if (!b.el.isConnected || !b.node.isConnected) {
            b.el.style.display = "none"; // Docs replaced the line: nothing to follow
            relocateNow = true;
            if (b.wash) b.wash.style.display = "none";
            continue;
          }
          // Same line, new text: keep following it until the re-match below.
          if (b.node.getAttribute("aria-label") !== b.raw) relocateNow = true;
          const rx = parseFloat(b.node.getAttribute("x"));
          const ry = parseFloat(b.node.getAttribute("y"));
          const rw = parseFloat(b.node.getAttribute("width"));
          const rh = parseFloat(b.node.getAttribute("height"));
          const tf = b.node.getAttribute("transform") || "";
          if (![rx, ry, rw, rh].every(Number.isFinite)) { b.el.style.display = "none"; continue; }
          if (rx !== b.gx || ry !== b.gy || rw !== b.gw || rh !== b.gh || tf !== b.tf) {
            b.gx = rx; b.gy = ry; b.gw = rw; b.gh = rh; b.tf = tf;
            b.el.setAttribute("x", String(rx + b.f0 * rw));
            b.el.setAttribute("y", String(ry + rh - 2));
            b.el.setAttribute("width", String(Math.max(2, (b.f1 - b.f0) * rw)));
            if (tf) b.el.setAttribute("transform", tf); else b.el.removeAttribute("transform");
            b.size = b.node.getBoundingClientRect().height || b.size;
          }
        }
        joinBars(); // the follow above reset each bar to its own rect's width
        if (relocateNow) { requestDocsMarks(); return; } // before paint, not a frame later
        if (annoRafPending) return;
        annoRafPending = true;
        // Coalesce a mutation burst into one re-match, aligned to the frame.
        requestAnimationFrame(() => { annoRafPending = false; fastDocsMarks(); });
      });
      // Our own layers (marks, popover) hang off documentElement, OUTSIDE this
      // subtree — the observer can never feed back on our own writes.
      annoObs.observe(target, {
        subtree: true, childList: true,
        attributes: true, attributeFilter: ["aria-label", "x", "y", "width", "height", "transform"],
      });
      console.debug("[tracely] annotation observer armed");
    }

    /* Stamp the version. Several "it's still broken" reports have turned out
       to be an older build still loaded — a stale unpacked copy, a tab that
       was never reloaded, or the Web Store copy running alongside a dev one.
       A version in the console settles that from a screenshot. */
    console.log(`[tracely] v${EXT_VERSION} docs overlay armed`);
    const marksTimer = setInterval(requestDocsMarks, 900);
    window.addEventListener("scroll", scheduleDocsMarks, { capture: true, passive: true });
    window.addEventListener("wheel", scheduleDocsMarks, { capture: true, passive: true });
    window.addEventListener("resize", scheduleDocsMarks, { passive: true });

    /* THE GHOST INSTANCE.
       Reloading the extension does not stop the content script already running
       in an open tab. Its chrome.* calls start failing, but NOTHING about
       drawing needs chrome.* — it keeps its cached findings, keeps its 900ms
       timer, and keeps painting marks into the same annotation SVG the NEW
       instance is painting into. Two instances, two sets of marks.

       Underlines hid it: two identical bars stack on the same pixels and look
       like one. The flow CHIP is text, and text drawn twice a few pixels apart
       reads as garbled overlap — which is what "Flow issue" doubling was. The
       two also fight, because each one's clear sweeps `[data-tracely-bar]` and
       so deletes the other's marks, provoking a redraw.

       So an orphaned instance must not merely stop calling chrome.* — it has
       to stand down completely and take its marks with it. */
    function standDown(why) {
      clearInterval(marksTimer);
      if (annoObs) { annoObs.disconnect(); annoObs = null; }
      window.removeEventListener("scroll", scheduleDocsMarks, { capture: true });
      window.removeEventListener("wheel", scheduleDocsMarks, { capture: true });
      window.removeEventListener("resize", scheduleDocsMarks);
      hideDocsPopover();
      clearDocsMarks();
      // The pill goes too: a count with no underlines under it, from an
      // instance that can no longer check anything, reads as a live widget.
      orphaned = true;
      expanded = false;
      render();
      console.log(`[tracely] v${EXT_VERSION} stood down (${why}) — reload the tab to resume`);
    }
    /* Only meaningful where there WAS an extension context to lose. The
       harness page has no chrome.* at all, so extAlive() is false from the
       first tick — without this gate the overlay would stand itself down
       immediately and the harness would render nothing. */
    const orphanTimer = useRelay ? setInterval(() => {
      if (extAlive()) return;
      clearInterval(orphanTimer);
      standDown("extension reloaded");
    }, 900) : 0;

    async function fetchSources(hash, auto = false, { batch = false } = {}) {
      // Returns false when NOTHING was started (another claim's search holds
      // the slot, or the sentence vanished) so callers can restore their UI
      // instead of pretending a search is running. `batch`: one of "Let
      // Tracely fix these"'s searches, paced by fixSearch — it neither waits
      // for nor holds the slot a card's search uses, and says nothing in the
      // status line (the list says it).
      if (sourcesMap.get(hash)?.list?.length) return true; // cached — never re-search
      if (sourcesMap.get(hash)?.loading) return true; // already running: started on the press (prestartSearch)
      if (sourcesInflight && !batch) return false;
      const seg = segments.find((s) => s.hash === hash);
      if (!seg) return false;
      const f = cache.get(hash);
      if (!batch) sourcesInflight = true;
      // What the live search has said so far (searchSources' events), drawn
      // by the card while it runs (dmLive, liveSourcesHtml). `shown`: the
      // sites already animated in, so a repaint never replays their entrance.
      const live = { stage: "searching", t0: Date.now(), found: [], kept: null, read: {}, shown: new Set() };
      sourcesMap.set(hash, { loading: true, list: null, copiedUrl: null, live });
      render();
      renderPopSources(hash); // the hover card shows the search as it runs
      let repaint = 0;
      const onEvent = (ev) => {
        if (sourcesMap.get(hash)?.live !== live) return;
        if (ev?.type === "found" && Array.isArray(ev.sources)) {
          live.found = ev.sources.filter((x) => x && typeof x.url === "string" && /^https?:/i.test(x.url)).slice(0, 10)
            .map((x) => ({ title: String(x.title || x.url).slice(0, 200), url: x.url, publisher: String(x.publisher ?? "") }));
          live.stage = "found";
        } else if (ev?.type === "links" && Array.isArray(ev.urls)) {
          live.kept = new Set(ev.urls);
          live.stage = "reading";
        } else if (ev?.type === "read" && typeof ev.url === "string") {
          live.read[ev.url] = ev.read ? (ev.from === "abstract" ? "abstract" : "page") : "unread";
          live.stage = "reading";
        } else if (ev?.type === "judging") {
          live.stage = "judging";
        } else return;
        if (!repaint) repaint = (typeof requestAnimationFrame === "function" ? requestAnimationFrame : setTimeout)(() => { repaint = 0; render(); renderPopSources(hash); });
      };
      try {
        const data = await searchSources({
          claim: seg.text,
          correction: f?.revision || undefined,
          context: docText.slice(0, 6000),
          // The model and no effort — the server ignores a client's effort
          // on searches and runs the vendor's default.
          model: CHECK_MODEL,
        }, onEvent);
        const { list, unbacked, unread } = backingSources(data.sources, f?.verdict);
        sourcesMap.set(hash, { loading: false, list, unbacked, unread, copiedUrl: null });
        persistCaches();
        noteSourcesReady(hash, list.length, auto);
      } catch (err) {
        sourcesMap.delete(hash);
        if (!auto) statusKind = "error";
        if (!batch) statusMsg = err?.message ?? "source search failed";
      } finally {
        if (!batch) sourcesInflight = false;
        render();
        renderPopSources(hash); // popover may be waiting on this claim
      }
      return true;
    }

    /* "Keep writing": a search goes on with its card closed, and says so when
       it is done — a small "Sources ready" note over the launcher, with Show
       (showSourcesFor). Not for a search the writer is watching, and not for
       auto-sources (nobody asked). It lets go after 15 seconds. */
    let readyPing = null; // { hash, n, at }
    function noteSourcesReady(hash, n, auto) {
      if (auto) return;
      const watching = Boolean(popEl?.isConnected) && (popHash === hash || stepOf(popHash).claim === hash);
      if (watching) return;
      const at = Date.now();
      readyPing = { hash, n, at };
      setTimeout(() => { if (readyPing?.at === at) { readyPing = null; render(); } }, 15_000);
    }
    function readyPingHtml() {
      const seg = readyPing ? segments.find((x) => x.hash === readyPing.hash) : null;
      if (!seg || expanded) return "";
      const n = readyPing.n;
      const what = n ? `${n} source${n === 1 ? "" : "s"} ready` : "Search finished";
      return `<div class="ready-ping" role="status"><span class="ready-text">${esc(what)} · “${esc(truncateClaim(seg.text, 38))}”</span><button class="act primary" data-ready-show="1">Show</button><button class="x" data-ready-x="1" aria-label="Dismiss" title="Dismiss">✕</button></div>`;
    }
    // Show: the claim's card over its underline when it is on screen, else the panel.
    function showSourcesFor(hash) {
      const key = [...popSteps.entries()].find(([, st]) => st.step === "sources" && st.claim === hash)?.[0] ?? hash;
      if (!popSteps.has(key)) popSteps.set(key, { step: "sources", searched: true });
      const bar = docsBars.find((b) => b.hash === key && b.el?.isConnected);
      const rb = bar ? bar.el.getBoundingClientRect() : null;
      if (rb && rb.width > 0 && rb.top >= 0 && rb.bottom <= innerHeight) {
        showDocsPopover(bar.hash, { left: rb.left, top: rb.top, bottom: rb.bottom, size: bar.size, centerX: rb.left + rb.width / 2 }, bar);
        if (popEl && popHash === bar.hash) popPinned = true;
        render();
        return;
      }
      expanded = true;
      render();
      widgetCard(key)?.scrollIntoView({ block: "nearest" });
    }
    function widgetCard(key) {
      try { return root.getRootNode().querySelector(`[data-card="${CSS.escape(key)}"]`); } catch { return null; }
    }
    /* "Find a source" starts its search on the press, not the release — the
       few hundred milliseconds between them are the search's, not the wait's.
       The click that follows finds it running (fetchSources is idempotent). */
    function prestartClaim(tipId) {
      const tip = tipById(tipId);
      const i = tip ? claimSentenceIndex(tip.kind, tip.quote, segments) : -1;
      if (i >= 0) fetchSources(segments[i].hash).catch(() => {});
    }
    /* The live search, as the hover card draws it: each real site it found,
       its icon, and where its reading is — "Reading…", "Read the abstract",
       "Read the page", "Couldn't read", "Link is dead". Nothing here says a
       source backs anything: that is the receipts' answer, after "done". */
    function liveTitle(live) {
      if (!live || live.stage === "searching") return "Searching the web";
      const n = live.kept ? live.kept.size : live.found.length;
      if (live.stage === "judging") return "Checking which back your sentence";
      if (live.stage === "reading") return `Reading ${n} source${n === 1 ? "" : "s"}`;
      return `Found ${n} site${n === 1 ? "" : "s"}`;
    }
    function liveBody(live, seg) {
      if (!live?.found?.length) return `Looking for a source that backs “${truncateClaim(seg.text)}.”`;
      return "Reading what each one actually says. Only a source whose own words back your sentence is offered.";
    }
    const LIVE_STATUS = { found: "", reading: "Reading…", abstract: "✓ Read the abstract", page: "✓ Read the page", unread: "Couldn't read", dead: "Link is dead" };
    const liveState = (live, url) => (live.kept && !live.kept.has(url) ? "dead" : live.read[url] ?? (live.kept ? "reading" : "found"));
    const hostName = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
    function dmLive(live) {
      const box = el("div", { display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 auto", minHeight: "0", overflowY: "auto" });
      const motion = !reducedMotion();
      live.found.forEach((src, i) => {
        const state = liveState(live, src.url);
        const faded = state === "dead" || state === "unread";
        const row = el("div", { display: "flex", alignItems: "center", gap: "10px", padding: "4px 2px", flex: "0 0 auto", opacity: faded ? "0.5" : "1" });
        const ico = faviconUrl(src.url);
        let icon;
        if (ico) {
          icon = el("img", { width: "20px", height: "20px", borderRadius: "5px", flexShrink: "0", background: "#f2f2f2" });
          icon.src = ico;
          icon.alt = "";
          icon.referrerPolicy = "no-referrer";
          icon.addEventListener("error", () => { icon.style.visibility = "hidden"; });
        } else {
          icon = el("span", { width: "20px", height: "20px", borderRadius: "5px", flexShrink: "0", background: "#ebebeb", fontSize: "9px", fontWeight: "600", color: DM.body, display: "inline-flex", alignItems: "center", justifyContent: "center" }, initialsOf(src));
        }
        const meta = el("span", { minWidth: "0", flex: "1", display: "flex", flexDirection: "column" });
        meta.appendChild(el("span", { fontSize: "13px", color: DM.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, src.title));
        meta.appendChild(el("span", { fontSize: "11.5px", color: DM.hint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, hostName(src.url)));
        const status = el("span", { fontSize: "12px", color: state === "abstract" || state === "page" ? DM.ink : DM.hint, whiteSpace: "nowrap", flexShrink: "0" }, LIVE_STATUS[state]);
        row.append(icon, meta, status);
        box.appendChild(row);
        if (motion && typeof row.animate === "function") {
          if (!live.shown.has(src.url)) row.animate([{ opacity: 0, transform: "translateY(6px) scale(.98)" }, { opacity: faded ? 0.5 : 1, transform: "none" }], { duration: 240, delay: i * 70, easing: "ease-out", fill: "backwards" });
          if (state === "reading") status.animate([{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], { duration: 1100, delay: (i % 4) * 140, iterations: Infinity, easing: "ease-in-out" });
        }
        live.shown.add(src.url);
      });
      return box;
    }
    function liveHint(live) {
      if (!live) return POP_COPY.searchHint;
      const sec = Math.max(0, Math.round((Date.now() - live.t0) / 1000));
      return live.found.length ? `${sec} s` : `${sec} s · usually 10–15`;
    }
    // The panel's card while the search runs: the stage, and the sites' icons.
    function liveSourcesHtml(live) {
      const line = `<div class="loading">${esc(liveTitle(live))}…</div>`;
      if (!live?.found?.length) return line;
      const icons = live.found.map((src) => {
        const state = liveState(live, src.url);
        const ico = faviconUrl(src.url);
        const cls = state === "dead" || state === "unread" ? "faded" : state === "abstract" || state === "page" ? "read" : "";
        return ico ? `<img class="${cls}" src="${esc(ico)}" alt="" title="${esc(hostName(src.url))}${LIVE_STATUS[state] ? ` — ${esc(LIVE_STATUS[state])}` : ""}" referrerpolicy="no-referrer" />` : "";
      }).join("");
      return `${line}<div class="live-strip">${icons}</div>`;
    }

    // Auto-sources for flagged claims — capped per cycle and per rolling hour.
    async function autoFindSources(findings) {
      if (!FEATURES.autoSources || settings.autoSources !== true) return; // cost: auto web-search is opt-in
      let started = 0;
      for (const f of findings) {
        if (started >= 3) break;
        if (!AUTO_SOURCE_VERDICTS.includes(f.verdict)) continue;
        if (sourcesMap.has(f.id) || dismissed.has(f.id)) continue;
        if (!segments.some((s) => s.hash === f.id)) continue;
        autoSourceTimes = autoSourceTimes.filter((t) => Date.now() - t < 3_600_000);
        if (autoSourceTimes.length >= 15) { statusMsg = "auto-sources paused — hourly cap"; break; }
        autoSourceTimes.push(Date.now());
        started++;
        await fetchSources(f.id, true); // sequential: one paid search at a time
      }
    }

    // "Paste a URL and cite it" — free metadata fetch, then cite in the doc if we can.
    async function citeUrlWidget(hash, rawUrl) {
      if (docBusy) return;
      try {
        const data = await api("/api/cite-url", { url: rawUrl });
        const src = data.source;
        const st = sourcesMap.get(hash) ?? { loading: false, list: [], copiedUrl: null };
        st.loading = false;
        st.list = st.list ?? [];
        if (!st.list.some((s) => s.url === src.url)) st.list.unshift(src);
        sourcesMap.set(hash, st);
        persistCaches(); // pasted-URL sources survive reloads too
        if (canEditDoc()) {
          await docCite(hash, st.list.findIndex((s) => s.url === src.url));
        } else {
          statusKind = "idle";
          statusMsg = "source added — use Copy cite";
        }
      } catch (e) {
        statusKind = "error";
        statusMsg = e?.message ?? "couldn't cite that URL";
      }
      render();
    }

    function copyText(text, hash, url) {
      navigator.clipboard?.writeText(text).catch(() => {});
      if (hash && url) {
        const st = sourcesMap.get(hash);
        if (st) st.copiedUrl = url;
      }
      render();
    }

    /* ── "Find the cited work" ─────────────────────────────────────────────
       A card whose citation is the problem looks the cited work up
       (lookupCitedWork) and offers it: Replace citation, Complete entry,
       Copy reference. When nothing resolves, the card says so in the
       server's words and searches for the sentence instead — and a source
       cited from there replaces the faulty citation (replaceFor, docCite). */
    // Every note a card can be opened on, as the panel lists them (kept for
    // as long as the text, the dismissals and the review stay the same).
    let tipsMemo = null;
    function allTips() {
      if (!isArgumentGenre(docGenre)) return [];
      const k = { text: docText, gone: dismissed.size, review: review.findings, style: settings.citationStyle };
      if (tipsMemo && Object.keys(k).every((x) => tipsMemo.k[x] === k[x])) return tipsMemo.list;
      const list = [
        ...citationTips(docText, settings.citationStyle, dismissed, docGenre),
        ...(FEATURES.refList ? referenceTips(docText, dismissed, docGenre, settings.citationStyle) : []),
        ...(FEATURES.essayFeedback && review.kind === "essay" ? essayFeedbackTips(docText, review.findings, dismissed) : []),
      ];
      tipsMemo = { k, list };
      return list;
    }
    function tipById(id) { return tipMarkById.get(id) ?? allTips().find((t) => t.id === id) ?? null; }
    /* A note's own fix (Delete, the page box, Rewrite in doc): the state its
       buttons read, here beside the panel that draws them (decorateCard);
       the edits themselves are with the others (docDeleteTip). */
    const deleteArmed = new Map(); // tip id → when the second click stops counting
    const pageDrafts = new Map();  // tip id → the page typed so far (the panel re-renders under it)
    const DELETE_ARM_MS = 4000;
    // Any note in either list: the citation and essay notes, off-topic lines, a resume's.
    function anyTipById(id) {
      return tipById(id)
        ?? [...offTopicTips(docText, dismissed), ...(docGenre === "resume" ? resumeTips(docText, review.findings, dismissed) : [])].find((t) => t.id === id)
        ?? null;
    }
    const deleteArmedNow = (id) => (deleteArmed.get(id) ?? 0) > Date.now();
    function deleteLabel(tip) {
      if (editState(`del:${tip.id}`) === "applying") return "Deleting…";
      return deleteArmedNow(tip.id) ? "Click again to delete" : DELETE_LABEL[tip.kind] ?? "Delete this";
    }
    const canDeleteTip = (tip) => canEditDoc() && tipDeletes(tip) && Boolean(deleteEditFor(docText, tip.quote, tip.kind === "refdup"));
    const tipRewrite = (tip) => (tip?.quote && tip.suggestion && tip.kind !== "page" ? usableRevision(tip.quote, tip.suggestion) : "");
    // What a card's lookup is about: a tip's own target, or a flagged sentence's one citation.
    function citedTargetFor(key) {
      if (String(key).startsWith("tip:")) return tipCitedTarget(tipById(key), segments);
      const seg = segments.find((s) => s.hash === key);
      const c = seg ? flaggedCitationOf(cache.get(key)?.verdict, seg.text) : null;
      return c ? { kind: "sentence", raw: c.raw, inner: c.inner, segHash: seg.hash, sentence: seg.text } : null;
    }
    // The citation a source cited for this sentence takes the place of, or null (added beside).
    function replaceFor(hash) {
      if (citedFallback.has(hash)) return citedFallback.get(hash);
      const seg = segments.find((s) => s.hash === hash);
      return seg ? flaggedCitationOf(cache.get(hash)?.verdict, seg.text)?.raw ?? null : null;
    }
    function refreshCited(key) {
      render();
      if (popEl && popHash === key) paintPop();
    }
    // A card's search for the sentence it is about (a claim that is not the card's own).
    function startClaimSources(key, claimHash, claimText) {
      setStep(key, { step: "sources", claim: claimHash, claimText, searched: true, selected: null });
      fetchSources(claimHash).then(() => refreshCited(key)).catch(() => {});
    }
    async function findCitedWork(key) {
      const target = citedTargetFor(key);
      if (!target) return false;
      const cur = citedMap.get(key);
      if (cur?.loading) return true;
      if (cur?.resolved) { setStep(key, { step: "cited" }); render(); return true; } // answered this session
      const plan = citedLookupPlan(target, docText);
      if (target.raw && target.segHash) citedFallback.set(target.segHash, target.raw);
      citedMap.set(key, { loading: true, target, plan, matches: [], selected: 0 });
      setStep(key, { step: "cited" });
      refreshCited(key);
      const r = await lookupCitedWork(plan);
      citedMap.set(key, { loading: false, target, plan, selected: 0, ...r });
      if (!r.resolved && target.segHash) startClaimSources(key, target.segHash, target.sentence);
      refreshCited(key);
      return true;
    }
    // An excused, hedged or unnamed claim: the search for the sentence the note is about.
    function findClaimSource(tipId) {
      const tip = tipById(tipId);
      const i = tip ? claimSentenceIndex(tip.kind, tip.quote, segments) : -1;
      if (i < 0) return;
      const claim = segments[i];
      // An excuse is about the citation in its claim: a source cited from here replaces it.
      const c = tip.kind === "excuse" ? lookupableCitation(claim.text) : null;
      if (c) citedFallback.set(claim.hash, c.raw);
      startClaimSources(tipId, claim.hash, claim.text);
      render();
    }
    // What a search started from a lookup that found nothing says first, or "".
    function citedNote(key) {
      const c = citedMap.get(key);
      return c && !c.loading && !c.resolved ? c.note : "";
    }
    function copyCitedReference(key, i) {
      const src = citedMap.get(key)?.matches?.[Number(i)];
      if (!src) return;
      navigator.clipboard?.writeText(citedWorkEntry(src, settings.citationStyle || "mla").entry).catch(() => {});
      copiedCitedKey = `${key}:${i}`;
      render();
      if (popEl && popHash === key) paintPop();
    }
    /* The panel's extras for one card, after its HTML is in: "Find the cited
       work" / "Find a source" where the card earns them, the lookup's answer,
       and the search that follows it. Added to the rendered card rather than
       to its template, so the card markup every test reads stays as it is. */
    function decorateCard(card, sourcesFor) {
      const key = card.dataset.card;
      if (!key || card.classList.contains("ev-card")) return;
      const isTip = key.startsWith("tip:");
      const tip = isTip ? anyTipById(key) : null;
      const target = citedTargetFor(key);
      const ci = tip && (TIP_FIND_SOURCE.includes(tip.kind) || tip.action === "cite") && !(tip.kind === "excuse" && target) ? claimSentenceIndex(tip.kind, tip.quote, segments) : -1;
      const st = stepOf(key);
      const c = citedMap.get(key);
      const buttons = [];
      // The note's own fix comes first: it is what the note asks for.
      const fixBtn = tip && canDeleteTip(tip) ? editBtnHtml(`del:${key}`, deleteLabel(tip), `data-tip-del="${esc(key)}"`) : "";
      if (fixBtn) buttons.push(fixBtn);
      if (target) buttons.push(`<button class="act${isTip && !fixBtn ? " primary" : ""}" data-cited="${esc(key)}"${c?.loading ? " disabled" : ""}>${esc(CITED_COPY.find)}</button>`);
      if (ci >= 0) buttons.push(`<button class="act${target || fixBtn ? "" : " primary"}" data-claim-src="${esc(key)}">${esc(POP_COPY.findSource)}</button>`);
      if (tip && canEditDoc() && tip.kind === "page") {
        card.insertAdjacentHTML("beforeend", `<div class="cite-url"><input type="text" inputmode="numeric" placeholder="Page number, e.g. 45" aria-label="Page number" data-page-input="${esc(key)}" value="${esc(pageDrafts.get(key) ?? "")}" />${editBtnHtml(`page:${key}`, "Add page", `data-tip-page="${esc(key)}"`)}</div>${editNoteHtml(`page:${key}`)}`);
      }
      if (tip && canEditDoc() && tipRewrite(tip)) {
        card.querySelector(".fix .row")?.insertAdjacentHTML("afterbegin", editBtnHtml(`rw:${key}`, "Rewrite in doc", `data-tip-rewrite="${esc(key)}"`));
        const note = editNoteHtml(`rw:${key}`);
        if (note) card.querySelector(".fix")?.insertAdjacentHTML("beforeend", note);
      }
      if (tip?.kind === "nolist" && canEditDoc()) {
        const lb = listBuilds.get(key);
        buttons.push(editBtnHtml(`list:${key}`, lb?.loading ? "Looking up the cited works…" : `Add ${REF_HEADINGS[settings.citationStyle] ?? REF_HEADINGS.mla}`, `data-tip-list="${esc(key)}"${lb?.loading ? " disabled" : ""}`));
      }
      let html = fixBtn ? editNoteHtml(`del:${key}`) : "";
      if (tip?.kind === "nolist") html += editNoteHtml(`list:${key}`) + (listBuildNote(listBuilds.get(key)) ? `<div class="src-snip">${esc(listBuildNote(listBuilds.get(key)))}</div>` : "");
      if (c) html += citedWorkHtml(c, (i, src) => citedActionsHtml(key, c, i, src), c.resolved && c.target?.segHash ? `<div class="row"><button class="act" data-cited-more="${esc(key)}">${esc(CITED_COPY.different)}</button></div>` : "");
      const claim = st.claim ? segments.find((s) => s.hash === st.claim) : null;
      if (isTip && claim) html += sourcesFor(claim); // a verdict card already lists its own sentence's sources
      if (isTip && buttons.length) card.insertAdjacentHTML("beforeend", `<div class="row">${buttons.join("")}</div>${html}`);
      else if (buttons.length || html) {
        const row = card.querySelector(".row");
        if (row && buttons.length) row.insertAdjacentHTML("beforeend", buttons.join(""));
        const at = card.querySelector(".sources") ?? card.querySelector(".cite-url");
        if (html) { if (at) at.insertAdjacentHTML("beforebegin", html); else card.insertAdjacentHTML("beforeend", html); }
      }
    }
    // One match's buttons in the panel: the edit (Replace citation or
    // Complete entry) where the doc can be edited, and Copy reference always.
    function citedActionsHtml(key, c, i, src) {
      const t = c.target;
      const style = settings.citationStyle || "mla";
      let edit = "";
      const k = t?.kind === "entry" ? `entry:${key}:${i}` : `recite:${key}:${i}`;
      if (c.done?.i === i && !editState(k)) {
        // Settled: the doc shows it, and the Undo is on the panel's strip.
        edit = `<button class="act primary" disabled>${t?.kind === "entry" ? "Completed ✓" : "Replaced ✓"}</button>`;
      } else if (canEditDoc() && t?.kind === "sentence" && t.segHash && t.raw && (swapCitation(t.sentence, t.raw, formatCitation(src, style).marker, style) || sameCitation(t.raw, formatCitation(src, style).marker, style))) {
        const label = swapCitation(t.sentence, t.raw, formatCitation(src, style).marker, style) ? CITED_COPY.replace : CITED_COPY.addEntry;
        edit = editBtnHtml(k, label, `data-cited-replace="${esc(key)}" data-i="${i}"`) + editNoteHtml(k);
      } else if (canEditDoc() && t?.kind === "entry") {
        edit = editBtnHtml(k, CITED_COPY.complete, `data-cited-entry="${esc(key)}" data-i="${i}"`) + editNoteHtml(k);
      }
      return `${edit}<button class="act${edit ? "" : " primary"}" data-cited-copy="${esc(key)}" data-i="${i}">${copiedCitedKey === `${key}:${i}` ? "Copied ✓" : esc(CITED_COPY.copyRef)}</button>`;
    }

    /* ── editing the document ─────────────────────────────────────────────
       "Fix in doc", "Cite in doc" and "Add transition" reach the document by
       whichever path is live, best first:
         1. the in-editor engine in docs-hook.js (MAIN world): the user's own
            editor makes the edit, reads it back, and can take it back;
         2. the local server's Apps Script bridge (developer builds only —
            bridgeReady comes from /api/status);
         3. Copy — always offered, and where every failure lands.
       Edits happen only on an explicit click. The only thing on a timer is
       the read-only ping. */
    const DOCS_EDIT_TIMEOUT_MS = 6000;
    // An undo verifies each step (up to ~3.6 s apiece when Cmd+Z has to be
    // redone and the edit reversed by hand), so its wait grows with the group.
    const undoTimeout = (tokens) => DOCS_EDIT_TIMEOUT_MS + 4000 * (Array.isArray(tokens) ? tokens.length : 1);
    let docsEditSeq = 0;

    // One request to the engine. Resolves its reply, or {ok:false, reason:"timeout"};
    // never rejects. onLate(reply): an answer that arrives AFTER the timeout —
    // an ok one means the document DID change.
    function docsEdit(op, args = {}, { timeoutMs = DOCS_EDIT_TIMEOUT_MS, onLate } = {}) {
      return new Promise((resolve) => {
        const id = `te${++docsEditSeq}-${Date.now()}`;
        let settled = false;
        let timer = 0;
        const onMsg = (ev) => {
          const d = ev.data;
          if (ev.source !== window || ev.origin !== location.origin || !d || d.source !== "tracely-hook"
            || d.type !== "tracely-docs-edit-result" || d.id !== id) return;
          window.removeEventListener("message", onMsg);
          if (settled) { try { onLate?.(d); } catch { /* ignore */ } return; }
          settled = true;
          clearTimeout(timer);
          resolve(d);
        };
        window.addEventListener("message", onMsg);
        timer = setTimeout(() => {
          settled = true;
          resolve({ ok: false, reason: "timeout" });
          setTimeout(() => window.removeEventListener("message", onMsg), 15_000); // a late reply still counts
        }, timeoutMs);
        try {
          window.postMessage({ ...args, source: "tracely", type: "tracely-docs-edit", id, op }, location.origin);
        } catch {
          settled = true;
          clearTimeout(timer);
          window.removeEventListener("message", onMsg);
          resolve({ ok: false, reason: "error" });
        }
      });
    }

    async function probeInDoc() {
      if (orphaned || harness || !IS_DOCS || document.hidden) return;
      lastPingAt = Date.now();
      const r = await docsEdit("ping", {}, { timeoutMs: 3000 });
      const was = canEditDoc();
      inDoc = { api: !!(r.ok && r.api), editable: !!(r.ok && r.editable), editor: !!(r.ok && r.editor), viewOnly: !!(r.ok && r.viewOnly), mode: r.ok ? String(r.mode ?? "unknown") : "unknown", ok: !!r.ok };
      if (canEditDoc() !== was) render();
    }

    const canEditDoc = () => !harness && (inDoc.editable || bridgeReady);
    /* Why the doc cannot be edited from here, in the words the card shows
       under its Copy button — never a silent swap to Copy. */
    function editBlockReason() {
      if (canEditDoc()) return "";
      if (!inDoc.ok) return "Docs hasn't answered yet — the editor may still be loading. Copy the revision, or try again in a moment.";
      if (inDoc.viewOnly || inDoc.mode === "viewing") return "This document is view-only for you, so copy the revision and paste it where it belongs.";
      if (!inDoc.editor) return "Docs' editor isn't ready yet — try again in a moment, or copy the revision.";
      return "This document isn't editable from here — copy the revision and paste it over the sentence.";
    }

    async function fetchServerStatus() {
      if (orphaned) return;
      try {
        const s = await api("/api/status");
        bridgeReady = Boolean(s.docsBridge);
      } catch { bridgeReady = false; }
    }

    // A reply that came back after we had already reported failure and copied
    // instead: if it carries an undo token the document DID change behind the
    // UI's back — landed (ok) or landed wrong (ok:false, "mismatch") — so take
    // it back.
    function lateEdit(r) {
      if (!r?.undoToken) return;
      docsEdit("undo", { undoToken: r.undoToken }, { timeoutMs: undoTimeout(r.undoToken) }).then((u) => {
        if (u.ok) return;
        statusKind = "error";
        statusMsg = u.newest
          ? "An edit landed late — ⌘Z / Ctrl+Z in the doc undoes it"
          : "An edit landed late and couldn't be taken back — check the doc";
        render();
      });
    }

    // What to tell the user when the hook could not take an edit back. ⌘Z is
    // the right advice only while the doc reads exactly as our edit left it
    // (the hook says newest); after they typed, or undid it themselves, ⌘Z
    // would take back THEIR work.
    const undoAdvice = (u) => (u?.newest ? "press ⌘Z / Ctrl+Z" : "check the doc");

    // The best live path right now. A group of edits picks it ONCE, so a ping
    // landing mid-group can never split one group across two paths.
    const editPath = () => (harness ? "none" : inDoc.editable ? "hook" : bridgeReady ? "bridge" : "none");

    // One edit by the given path. Resolves {ok, reason?, undoToken?, via};
    // never throws.
    async function docApply(payload, hint, path = editPath()) {
      const { action, ...args } = payload;
      if (path === "hook") {
        const r = await docsEdit(action, hint ? { ...args, hint } : args, { onLate: lateEdit });
        return { ...r, via: "hook" };
      }
      if (path === "bridge") {
        try {
          await api("/api/docs/apply", { docId: DOC_ID, ...payload });
          return { ok: true, via: "bridge" };
        } catch (e) {
          return { ok: false, reason: "bridge", detail: e?.message, via: "bridge" };
        }
      }
      return { ok: false, reason: "no-editor", via: "none" };
    }

    // Which copy of a repeated sentence is meant: its index among the export's
    // copies, and where its underline is on screen (the engine clicks one to
    // read the caret offset). A copy is a whole SENTENCE of the export — the
    // engine counts only whole sentences too, so the tail of a longer
    // sentence counts on neither side — and the engine refuses when the two
    // counts disagree (one side is stale). It never overrides the text check.
    //
    // anchor = the underline a popover hangs from. When the sentence is
    // repeated, only THAT copy is meant: its rect goes alone, and no index
    // goes at all (the index would name the export's first copy, which may not
    // be the one the user pointed at). The panel's card stands for every copy,
    // so from there nothing says which: the engine refuses as ambiguous.
    function segHint(seg, anchor = null) {
      const copies = segments.filter((s) => s.text === seg.text);
      const hint = { occurrence: Math.max(0, copies.findIndex((s) => s.start === seg.start)), occurrences: Math.max(1, copies.length) };
      const onScreen = (r) => r && r.width > 0 && r.left >= 0 && r.top >= 0 && r.left + r.width <= innerWidth && r.top + r.height <= innerHeight;
      if (hint.occurrences > 1) {
        delete hint.occurrence;
        const r = anchor && anchor.hash === seg.hash && anchor.el?.isConnected ? barTextRect(anchor) : null;
        if (onScreen(r)) hint.rects = [r];
        return hint;
      }
      // Unique: every bar is this one copy (the no-API path selects across them).
      const rects = [];
      for (const b of docsBars) {
        if (b.hash !== seg.hash || !b.el?.isConnected) continue;
        const r = barTextRect(b);
        if (onScreen(r)) rects.push(r);
      }
      if (rects.length) hint.rects = rects.slice(0, 8);
      return hint;
    }
    function barTextRect(b) {
      try {
        if (b.node && Number.isFinite(b.f0) && Number.isFinite(b.f1)) {
          // SVG mode: Docs' annotation rect IS the painted run; f0/f1 are the sentence's share of it.
          const r = b.node.getBoundingClientRect();
          return { left: r.left + b.f0 * r.width, top: r.top, width: (b.f1 - b.f0) * r.width, height: r.height };
        }
        // Canvas fallback: the bar sits on the baseline, the text is `size` above it.
        const r = b.el.getBoundingClientRect();
        return { left: r.left, top: r.top - (b.size || 18), width: r.width, height: b.size || 18 };
      } catch {
        return null;
      }
    }

    // A sentence we just rewrote: its underline drops now, and the old text is
    // not re-checked while the export (a few seconds behind) still shows it.
    function markEdited(hash) { editedHashes.set(hash, Date.now()); }

    function editReasonText(r) {
      switch (r?.reason) {
        case "not-found":
        case "stale": return "that sentence changed since the last check";
        case "ambiguous": return "that sentence appears more than once";
        case "view-only":
        case "not-applied": return "this doc isn't editable right now";
        case "mismatch": return "the edit didn't land as expected, so it was taken back";
        case "timeout": return "the editor didn't answer";
        case "bridge": return String(r.detail || "the Docs bridge refused the edit").slice(0, 120);
        case "no-api": return "Docs isn't sharing this document's text with Tracely, so it can't add to it here";
        case "no-editor": return "Docs' editor isn't ready — try again in a moment";
        case "selection-failed":
        case "selection-mismatch":
        case "selection-unverifiable": return "Tracely couldn't select that sentence safely, so nothing was changed";
        case "edits-disabled": return "editing is switched off on this page";
        // The reason code, so the next report names the cause instead of this sentence.
        default: return `the editor couldn't make that edit (${r?.reason || "unknown"})`;
      }
    }

    async function copyFallback(text) {
      if (!text) return false;
      try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
    }

    function refreshEditViews() {
      render();
      for (const sync of popEditSyncs) sync();
    }
    function setEditState(key, state) {
      if (state) docEditState.set(key, state);
      else docEditState.delete(key);
      refreshEditViews();
    }
    // "Applied ✓" answers a click; it is not a lasting fact about the doc.
    // Once an export read that started after the edit shows the doc changed
    // (the edit has propagated) — or after 30 s if it never does (undone in
    // Docs first) — the button goes back to what the doc now says, and the
    // Undo moves to the panel's strip. Otherwise ⌘Z in Docs, or the sentence
    // typed back, would leave a flagged sentence whose only button is a
    // disabled "Applied ✓". Waiting for the export (not a fixed delay) keeps
    // a lagging export from offering an edit that has already been made.
    function settleEditStates(readAt) {
      let changed = false;
      for (const [key, st] of docEditState) {
        if (st.state !== "applied" || !(readAt > st.at)) continue;
        if (docText !== st.base || readAt - st.at > 30_000) { docEditState.delete(key); changed = true; }
      }
      if (changed) refreshEditViews();
    }

    // What an edit button shows, from its state.
    function editView(key, idle) {
      const s = docEditState.get(key);
      switch (s?.state) {
        case "applying": return { label: "Applying…", disabled: true, note: "" };
        case "undoing": return { label: "Undoing…", disabled: true, note: "" };
        case "applied": return { label: "Applied ✓", disabled: true, undo: lastDocEdit?.key === key, note: s.note || "" };
        case "failed": return { label: s.copied ? "Couldn't apply — copied instead" : "Couldn't apply", disabled: docBusy, note: s.note || "" };
        default: return { label: idle, disabled: docBusy, note: "" };
      }
    }
    let undoShown = false; // set while render() builds cards: did a card carry the Undo?
    function editBtnHtml(key, idle, attrs) {
      const v = editView(key, idle);
      if (v.undo) undoShown = true;
      return `<button class="act primary" ${attrs}${v.disabled ? " disabled" : ""}>${esc(v.label)}</button>`
        + (v.undo ? `<button class="act" data-doc-undo="1"${docBusy ? " disabled" : ""}>Undo</button>` : "");
    }
    function editNoteHtml(key) {
      const { note } = editView(key, "");
      return note ? `<div class="edit-note">${esc(note)}</div>` : "";
    }

    /* The Type preview (its own block, after this section) puts itself here
       when FEATURES.typePreview is on: runDocEdit awaits it before a single
       step is sent, and false sends nothing at all. null — the switch off,
       and server/test's slices of this section — sends straight away, as
       before. Undo and a failed group's rollback never come through here. */
    let previewDocEdit = null;
    /* "Let Tracely fix these" (fixBatch) prepares every change before any
       reaches the Doc: while `collect` is set, an edit whose key starts with
       its prefix is only handed to `take` — nothing is sent. A change the
       writer accepted from that list is in `approved` and goes without a
       second preview: the list was the preview. */
    const editGate = { collect: null, approved: new Set() };

    /* Run one edit — or a GROUP of edits that must land together — and settle
       the button. A group that fails part-way is taken back, newest first, so
       the doc is exactly as it was; then the text is copied instead. */
    async function runDocEdit(key, job) {
      if (docBusy) return false;
      if (editGate.collect && key.startsWith(editGate.collect.prefix)) {
        editGate.collect.take(key, job); // recorded for the writer to choose; nothing is sent
        return false;
      }
      docBusy = true;
      if (previewDocEdit && !job.previewed && !editGate.approved.has(key)) {
        let accepted = false;
        try { accepted = await previewDocEdit(key, job); } catch { accepted = false; }
        if (!accepted) {
          // Rejected (or the preview could not be shown): nothing reached the Doc.
          docBusy = false;
          setEditState(key, null);
          return false;
        }
      }
      setEditState(key, { state: "applying" });
      const path = editPath();
      const tokens = []; // newest first
      let untracked = 0; // steps that landed with no way to take them back (the bridge)
      let rollbackOnly = false; // a step the hook could only verify blind: no later Undo
      let fail = null;
      let reason = null; // why it failed, before any "stuck" — for a late take-back
      let shown = null;  // { copied } once the failure is on screen
      let lateBack = false;
      // A take-back that answered after its timeout: if it did land, the doc
      // IS as it was, and the "stuck — check the doc" note is wrong.
      const lateRollback = (u) => {
        if (!u?.ok) return;
        lateBack = true;
        if (shown) settleTakenBack();
      };
      const settleTakenBack = () => {
        if (docEditState.get(key)?.state !== "failed") return;
        const note = job.notes?.[reason.reason] ?? editReasonText(reason);
        statusKind = "idle";
        statusMsg = `${shown.copied ? "Couldn't apply — copied instead" : "Couldn't apply"} (${note})`;
        setEditState(key, { state: "failed", copied: shown.copied, note });
        setTimeout(() => { if (docEditState.get(key)?.state === "failed" && !docBusy) setEditState(key, null); }, 4000);
      };
      try {
        for (const step of job.steps) {
          const { hint, ...payload } = step;
          const r = await docApply(payload, hint, path);
          // One line per step, so "it didn't work" can be read off the console
          // rather than guessed at. No document text: the action, the path
          // and the hook's answer only.
          console.debug(`[tracely] edit ${key.split(":")[0]} · ${payload.action} via ${r.via ?? path} → ${r.ok ? "ok" : `failed (${r.reason ?? "?"})`}${r.noop ? " noop" : ""}${r.undoToken ? "" : " untracked"}${r.endShape ? ` · ${r.endShape}` : ""}`);
          if (r.undoToken) tokens.unshift(r.undoToken);
          else if (r.ok && !r.noop) untracked++;
          if (r.rollbackOnly) rollbackOnly = true;
          if (!r.ok) { fail = reason = { ...r, action: payload.action }; break; }
        }
        if (fail && tokens.length) {
          // rollback: this is the immediate take-back, the one time the hook
          // may undo a blind step with Cmd/Ctrl+Z.
          const u = await docsEdit("undo", { undoToken: tokens, rollback: true }, { timeoutMs: undoTimeout(tokens), onLate: lateRollback });
          if (!u.ok) fail = { ...fail, stuck: undoAdvice(u) };
        }
        // (a bridge edit is made by Apps Script, not in the user's undo stack)
        if (fail && untracked) fail = { ...fail, stuck: "check the doc" };
      } catch {
        fail = fail || { ok: false, reason: "error" }; // docApply never throws; belt and braces
        reason = reason || fail;
      } finally {
        docBusy = false;
      }
      if (!fail) {
        // Only an edit the hook can take back replaces the Undo. One that
        // changed nothing (a no-op) or went by the bridge keeps the previous
        // edit's Undo; one verified blind drops it (no later Undo is safe).
        if (tokens.length) lastDocEdit = rollbackOnly ? null : { key, tokens, onUndone: job.onUndone, label: String(job.doneMsg || "edited in doc") };
        try { job.onApplied?.(); } catch { /* bookkeeping only */ }
        statusKind = "idle";
        statusMsg = job.doneMsg;
        lastCheckEnd = lastTextChangeAt = Date.now(); // the text just changed: read again in READ_INTERVAL_MS (the export lags slightly)
        setEditState(key, { state: "applied", at: Date.now(), base: docText });
        requestDocsMarks(); // the edited sentence's underline drops right away
        return true;
      }
      /* An in-order Works Cited insert that Docs did not take (the read-back
         did not show the entry as its own paragraph) has been rolled back
         cleanly: run the group once more with the entry at the END instead.
         An out-of-order entry beats losing the citation — which is what a
         group failure means, marker and all. Only when the rollback held
         (nothing stuck), and only once. */
      if (job.retry && fail.action === "insertLineBefore" && !fail.stuck) {
        console.debug(`[tracely] cite: in-order insert refused (${fail.reason ?? "?"}) — appending instead`);
        return runDocEdit(key, { ...job, steps: job.retry, retry: null, previewed: true }); // already accepted
      }
      const copied = await copyFallback(job.copy);
      const note = fail.stuck
        ? `Part of it landed and couldn't be undone automatically — ${fail.stuck}`
        : job.notes?.[fail.reason] ?? editReasonText(fail);
      statusKind = fail.stuck ? "error" : "idle";
      statusMsg = `${copied ? "Couldn't apply — copied instead" : "Couldn't apply"} (${note})`;
      setEditState(key, { state: "failed", copied, note });
      shown = { copied };
      if (lateBack) settleTakenBack();
      if (!fail.stuck) {
        setTimeout(() => { if (docEditState.get(key)?.state === "failed" && !docBusy) setEditState(key, null); }, 4000);
      }
      return false;
    }

    async function undoLastDocEdit() {
      const e = lastDocEdit;
      if (!e || docBusy) return false;
      docBusy = true;
      setEditState(e.key, { state: "undoing" });
      let r = { ok: false };
      let reported = false;
      const undone = (u) => {
        try { e.onUndone?.(); } catch { /* bookkeeping only */ }
        statusKind = "idle";
        statusMsg = u.already ? "already undone in the doc" : "undone";
        setEditState(e.key, null);
      };
      // An undo that finishes after its timeout did happen: say so, instead
      // of leaving advice that would now redo or undo something else.
      const onLate = (u) => {
        if (!u?.ok || !reported) return;
        undone(u);
        lastCheckEnd = lastTextChangeAt = Date.now(); // the text just changed: read again in READ_INTERVAL_MS (the export lags slightly)
        requestDocsMarks();
      };
      try { r = await docsEdit("undo", { undoToken: e.tokens }, { timeoutMs: undoTimeout(e.tokens), onLate }); } finally { docBusy = false; }
      lastDocEdit = null;
      reported = true;
      if (r.ok) {
        undone(r);
      } else {
        statusKind = "error";
        statusMsg = `Couldn't undo automatically — ${undoAdvice(r)}`;
        setEditState(e.key, { state: "applied", note: statusMsg, at: Date.now(), base: docText });
      }
      lastCheckEnd = lastTextChangeAt = Date.now(); // the text just changed: read again in READ_INTERVAL_MS (the export lags slightly)
      requestDocsMarks();
      return !!r.ok;
    }

    // A repeated sentence from the panel (no anchor): say where to click instead.
    const REPEATED_NOTE = "that sentence appears more than once — use Fix in doc on the underline you mean";

    // anchor: the underline bar a popover was opened from (null from the panel).
    // revision: "Explain in depth"'s own fix (deepRevision), in place of the
    // card's — its own button, so its own edit key ("deepfix:").
    async function docFix(hash, anchor = null, revision = null) {
      const seg = segments.find((s) => s.hash === hash);
      const f = cache.get(hash);
      const rev = revision || f?.revision;
      if (!seg || !rev || docBusy) return false;
      const hint = segHint(seg, anchor);
      // Another copy stays in the doc, flagged exactly as before: keep its
      // verdict and its underline (hiding the hash would hide every copy).
      const repeated = hint.occurrences > 1;
      return runDocEdit(`${revision ? "deepfix" : "fix"}:${hash}`, {
        steps: [{ action: "replace", find: seg.text, replacement: withMarkers(seg.text, rev), hint }],
        copy: rev,
        doneMsg: "fixed in doc",
        notes: repeated && !anchor ? { ambiguous: REPEATED_NOTE } : null,
        onApplied: () => {
          if (!repeated) {
            cache.delete(hash); // the rewritten sentence gets re-verified on the next read
            markEdited(hash);
          }
          persistCaches();
        },
        onUndone: () => {
          if (f && !cache.has(hash)) cache.set(hash, f); // the original is back — and already checked
          editedHashes.delete(hash);
          persistCaches();
        },
      });
    }

    /* A note's own fix, where the note has one the editor can make: Delete
       (deleteEditFor), the writer's page number (pageEditFor), or the
       review's rewrite. One replace each, read back by the engine, with Undo
       like every other edit. A Delete asks again first — the button says
       "Click again to delete" — unless the edit is previewed before it lands
       (FEATURES.typePreview), where Accept is that confirmation. */
    function armOrDelete(tipId) {
      if (!FEATURES.typePreview && !deleteArmedNow(tipId)) {
        deleteArmed.set(tipId, Date.now() + DELETE_ARM_MS);
        setTimeout(() => { if (deleteArmed.has(tipId) && !deleteArmedNow(tipId)) { deleteArmed.delete(tipId); refreshEditViews(); } }, DELETE_ARM_MS + 50);
        refreshEditViews();
        return;
      }
      deleteArmed.delete(tipId);
      docDeleteTip(tipId);
    }
    // The card stays up over an edit that removes its own underline, saying what happened.
    const tipDone = (tipId, key) => () => { popSteps.set(tipId, { ...stepOf(tipId), step: "tipdone", editKey: key }); };
    async function docDeleteTip(tipId) {
      const tip = anyTipById(tipId);
      const plan = tip && tipDeletes(tip) ? deleteEditFor(docText, tip.quote, tip.kind === "refdup") : null;
      if (!plan || docBusy) return false;
      const key = `del:${tipId}`;
      return runDocEdit(key, {
        steps: [{ action: "replace", find: plan.find, replacement: plan.replacement, hint: { occurrence: plan.occurrence, occurrences: plan.occurrences } }],
        copy: null,
        doneMsg: tip.kind === "refdup" ? "deleted the second copy" : tip.kind === "refuncited" ? "removed the entry from the list" : "deleted it from the doc",
        notes: { "not-found": "the passage has changed since the last read — delete it in the doc yourself" },
        onApplied: tipDone(tipId, key),
        onUndone: () => popSteps.delete(tipId),
      });
    }
    async function docAddPage(tipId, page) {
      const tip = anyTipById(tipId);
      if (!tip || tip.kind !== "page" || docBusy) return false;
      const at = docText.indexOf(tip.quote);
      // The whole sentence(s) the quote sits in — how the engine finds text.
      const covering = at < 0 ? [] : segments.filter((s) => s.end > at && s.start < at + tip.quote.length);
      if (!covering.length) return false;
      const passage = docText.slice(covering[0].start, covering[covering.length - 1].end);
      const replacement = pageEditFor(passage, tip.quote, page, settings.citationStyle || "mla");
      if (!replacement) return false;
      const hits = [];
      for (let i = docText.indexOf(passage); i >= 0; i = docText.indexOf(passage, i + 1)) hits.push(i);
      const key = `page:${tipId}`;
      return runDocEdit(key, {
        steps: [{ action: "replace", find: passage, replacement, hint: { occurrence: Math.max(0, hits.indexOf(covering[0].start)), occurrences: Math.max(1, hits.length) } }],
        copy: replacement,
        doneMsg: `added page ${String(page).trim()} to the citation`,
        onApplied: () => { pageDrafts.delete(tipId); tipDone(tipId, key)(); },
        onUndone: () => popSteps.delete(tipId),
      });
    }
    async function docRewriteTip(tipId) {
      const tip = anyTipById(tipId);
      const rev = tipRewrite(tip);
      if (!rev || docBusy) return false;
      const hits = [];
      for (let i = docText.indexOf(tip.quote); i >= 0; i = docText.indexOf(tip.quote, i + 1)) hits.push(i);
      const key = `rw:${tipId}`;
      return runDocEdit(key, {
        steps: [{ action: "replace", find: tip.quote, replacement: rev, hint: hits.length > 1 ? { occurrences: hits.length } : { occurrence: 0, occurrences: 1 } }],
        copy: rev,
        doneMsg: "rewrote it in the doc",
        notes: { ambiguous: "that sentence is in the doc more than once — paste the rewrite over the one you mean" },
        onApplied: tipDone(tipId, key),
        onUndone: () => popSteps.delete(tipId),
      });
    }

    // In-text marker + the Sources entry (and the heading, the first time),
    // as ONE group: all of it lands, or none of it stays. `replace`: the
    // sentence's citation a card found at fault (replaceFor) — the marker
    // takes its place instead of standing beside it ("(Genghis Khan and the,
    // 2022) (Weatherford)" was what citing one used to leave behind).
    async function docCite(hash, i, anchor = null, replace = null) {
      const seg = segments.find((s) => s.hash === hash);
      const st = sourcesMap.get(hash);
      const src = st?.list?.[Number(i)];
      if (!seg || !src || docBusy) {
        console.debug(`[tracely] cite skipped: ${!seg ? "sentence no longer in the doc" : !src ? "source not found" : "another edit is running"}`);
        return false;
      }
      /* The STYLE's citation, not a number. This inserted " [n]" and a
         numbered "Sources:" list whatever style was picked, while Preview
         showed the style's real marker — so the card promised "(Ghosh)" and
         the Doc got "[1]". Now the sentence takes formatCitation's marker
         and the entry goes under the style's own heading (Works Cited for
         MLA, References for APA and Chicago), added only when the Doc has no
         reference list yet. A source already in the list is not added twice. */
      const style = settings.citationStyle || "mla";
      const styled = formatCitation(src, style);
      const marker = styled.marker;
      // Only where that citation is in the sentence exactly once; otherwise
      // the marker goes beside it, as it always did.
      const swapped = replace ? swapCitation(seg.text, replace, marker, style) : null;
      // An unnamed source ("some researchers have argued") is named instead:
      // the sentence then cites by its words, and no marker is added beside them.
      const named = swapped ? null : nameTheSource(seg.text, src, style);
      // A speech or a news story names its source in the sentence, and has no list.
      const spoken = swapped || named || genreWantsList(docGenre) ? null : attributeAloud(seg.text, src);
      const { steps, retry, hint, pasteEntry, listName, replacement } = await citePlan(seg, styled, src, { anchor, swapped: swapped ?? named ?? spoken, listOnly: Boolean(spoken) });
      if (!steps.length) {
        if (editGate.collect && `cite:${hash}:${src.url}`.startsWith(editGate.collect.prefix)) return false; // preparing: nothing to choose, and no copy
        // Marker and entry are both in the doc already: nothing to change —
        // so no "Applied ✓", and the last real edit keeps its Undo.
        if (st.citedUrl !== src.url) { st.citedUrl = src.url; persistCaches(); }
        statusKind = "idle";
        statusMsg = `already cited ${marker} in the doc`;
        if (pasteEntry) {
          // The marker was already there; the entry still is not.
          st.pasteEntry = pasteEntry;
          const copied = await copyFallback(pasteEntry);
          statusMsg = copied ? `${marker} is in the doc — its reference is copied, paste it into ${listName}` : `${marker} is in the doc — add its reference to ${listName}`;
        }
        refreshEditViews();
        return true;
      }
      const prevCited = st.citedUrl ?? null;
      const did = swapped ? `replaced ${replace} with ${markerWithPage(marker, citationPage(replace.slice(1, -1)), style)}` : named ? `named ${narrativeCitation(src, style).name} as the source` : spoken ? "named the source in the sentence" : `cited ${marker}`;
      return runDocEdit(`cite:${hash}:${src.url}`, {
        steps,
        // If Docs refuses the in-order insert for real: the same group, the entry last.
        retry,
        copy: styled.ref,
        doneMsg: pasteEntry ? `${did} in doc — paste its reference into ${listName}` : `${did} in doc`,
        notes: hint.occurrences > 1 && !anchor ? { ambiguous: REPEATED_NOTE.replace("Fix in doc", "Cite in doc") } : null,
        onApplied: () => {
          if (replacement) {
            const newHash = hashText(replacement);
            // A swapped citation was what the verdict was about: the sentence
            // that cites a real source now is checked afresh, not told the same.
            // So is one whose unnamed source is now named.
            if (!swapped && !named && !spoken && cache.has(hash) && !cache.has(newHash)) cache.set(newHash, cache.get(hash));
            if (sourcesMap.has(hash) && !sourcesMap.has(newHash)) sourcesMap.set(newHash, sourcesMap.get(hash));
            if (!(hint.occurrences > 1)) markEdited(hash); // another copy keeps its underline
          }
          st.citedUrl = src.url;
          st.pasteEntry = pasteEntry;
          st.citedList = listName;
          st.replaced = Boolean(swapped);
          st.named = named ? narrativeCitation(src, style).name : null;
          if (pasteEntry) copyFallback(pasteEntry);
          persistCaches();
        },
        onUndone: () => {
          editedHashes.delete(hash);
          st.citedUrl = prevCited;
          st.pasteEntry = null;
          st.replaced = false;
          st.named = null;
          persistCaches();
        },
      });
    }

    /* The group a citation sends, decided before anything is sent: the
       sentence first — `swapped` (its faulty citation replaced), or the
       marker added before its closing punctuation — then the reference
       entry: in its alphabetical place, or appended, or (`oldEntry`) over the
       writer's own entry for the same work. Dry runs ask the hook first
       whether each line can be placed; one that cannot is handed over to
       paste (pasteEntry). `entryLine` overrides the source's own reference;
       `listOnly` adds an entry only to a list the doc already has. */
    async function citePlan(seg, styled, src, { anchor = null, swapped = null, entryLine: line = null, oldEntry = null, listOnly = false } = {}) {
      const hint = segHint(seg, anchor);
      const style = settings.citationStyle || "mla";
      const marker = styled.marker;
      const heading = REF_HEADINGS[style] ?? REF_HEADINGS.mla;
      const list = worksCitedBlock(docText);
      const doi = String(src.doi ?? "").replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, "");
      // By address WITHOUT its scheme: MLA prints "example.com/wall", APA
      // "https://example.com/wall", and the writer may have typed either.
      const urlKey = String(src.url ?? "").replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "");
      const listed = Boolean(list?.entries.some((l) => (urlKey && l.includes(urlKey)) || (doi && l.includes(doi))));
      const entryLine = listed || (listOnly && !list) ? null : line ?? styled.ref;
      console.debug(`[tracely] cite: ${style} · path ${editPath()} · text API ${inDoc.api ? "yes" : "no"} · reference list ${list ? `"${list.heading}"` : "none"}${listed ? " (source already listed)" : ""}`);
      const steps = [];
      let replacement = null;
      /* The entry needs Docs' text API (docs-hook.js doAppendLine refuses a
         blind append, as it should: nothing could verify it). The marker does
         not — doReplace falls back to mouseReplace — so on a Doc that does not
         share its text the marker goes in and the entry is handed over to
         paste. And a dry run asks first whether the line can be placed at
         all: on a Doc whose text does not end the way the hook knows ("doc-
         end-unknown", measured 2026-10-03) the group used to land the marker,
         fail the append and roll the marker back. */
      let canAppend = editPath() !== "hook" || inDoc.api;
      // The writer's own entry for this work, rewritten where it stands — while
      // it is one line of the list that the hook can select and replace.
      let over = oldEntry && entryLine && canAppend && list?.entries.includes(oldEntry) ? oldEntry : null;
      const overHint = over ? { occurrences: list.entries.filter((e) => e === over).length } : null;
      if (over && editPath() === "hook") {
        const probe = await docsEdit("replace", { find: over, replacement: entryLine, hint: overHint, dryRun: true }, { timeoutMs: 3000 });
        if (!probe.ok) {
          console.debug(`[tracely] cite: can't rewrite the old entry in place (${probe.reason ?? "?"}) — the new one is added instead`);
          over = null;
        }
      }
      // Alphabetical: above the first entry that sorts after it — kept only
      // when that entry is a single paragraph the hook can find (it refuses
      // otherwise, and the entry then goes last rather than nowhere).
      let above = list && entryLine && !over ? refInsertBefore(list.entries, entryLine) : null;
      if (above && editPath() === "hook" && canAppend) {
        const probe = await docsEdit("insertLineBefore", { line: entryLine, before: above, dryRun: true }, { timeoutMs: 3000 });
        if (!probe.ok) {
          console.debug(`[tracely] cite: can't place the entry in order (${probe.reason ?? "?"}) — it will go at the end`);
          above = null;
        }
      } else if (editPath() !== "hook") above = null; // the dev bridge only appends
      if (entryLine && canAppend && editPath() === "hook" && !above && !over) {
        const plan = await docsEdit("appendLine", { line: list ? entryLine : heading, dryRun: true }, { timeoutMs: 3000 });
        if (!plan.ok) {
          canAppend = false;
          console.debug(`[tracely] cite: the reference can't be placed here (${plan.reason ?? "?"}${plan.endShape ? ` · ${plan.endShape}` : ""}) — it will be handed over to paste`);
        }
      }
      const pasteEntry = entryLine && !canAppend ? (list ? entryLine : `${heading}\n${entryLine}`) : null;
      // The marker first: it is the step most likely to be refused (the
      // sentence changed), and refusing before anything landed needs no rollback.
      if (swapped) {
        replacement = swapped;
        steps.push({ action: "replace", find: seg.text, replacement, hint });
      } else if (!seg.text.includes(marker)) {
        const punct = seg.text.match(/[.!?]+["'’”)\]]*$/);
        const at = punct ? seg.text.length - punct[0].length : seg.text.length;
        replacement = seg.text.slice(0, at).replace(/\s+$/, "") + ` ${marker}` + seg.text.slice(at);
        steps.push({ action: "replace", find: seg.text, replacement, hint });
      }
      if (entryLine && canAppend) {
        if (over) steps.push({ action: "replace", find: over, replacement: entryLine, hint: overHint });
        else {
          if (!list) steps.push({ action: "appendLine", line: heading });
          steps.push(above ? { action: "insertLineBefore", line: entryLine, before: above } : { action: "appendLine", line: entryLine });
        }
      }
      const listName = list ? list.heading.replace(/\b\w/g, (c) => c.toUpperCase()) : heading;
      return {
        steps, hint, pasteEntry, listName, replacement, entryLine, rewroteEntry: Boolean(over && entryLine && canAppend),
        retry: above ? steps.map((st) => (st.action === "insertLineBefore" ? { action: "appendLine", line: st.line } : st)) : null,
      };
    }

    /* "Replace citation": the sentence's faulty citation swapped for the
       record's marker (a page the writer gave is kept), and the record's
       entry in the reference list — over the writer's own entry for that
       work when one matched and nothing else in the text cites it, else in
       its alphabetical place; a doc with no list gets none, and Copy
       reference is beside the button. ONE group, read back by the hook and
       taken back by one Undo, like Cite in doc. */
    async function docReplaceCitation(key, i, anchor = null) {
      const c = citedMap.get(key);
      const src = c?.matches?.[Number(i)];
      const t = c?.target;
      const seg = t?.segHash ? segments.find((s) => s.hash === t.segHash) : null;
      if (!src || !seg || !t.raw || docBusy) {
        console.debug(`[tracely] replace citation skipped: ${!src ? "record not found" : !seg ? "sentence no longer in the doc" : "another edit is running"}`);
        if (src && !seg && !docBusy) { statusKind = "idle"; statusMsg = "that sentence changed since it was checked — nothing was changed"; render(); }
        return false;
      }
      const style = settings.citationStyle || "mla";
      const styled = formatCitation(src, style);
      const swapped = swapCitation(seg.text, t.raw, styled.marker, style);
      // Already cited as the style would: only the entry is added (a
      // surname-only citation completed with the work the writer picked).
      const same = !swapped && sameCitation(t.raw, styled.marker, style);
      if (!swapped && !same) {
        statusKind = "idle";
        statusMsg = "that citation is no longer in the sentence exactly once — nothing was changed";
        render();
        return false;
      }
      const shown = markerWithPage(styled.marker, citationPage(t.raw.slice(1, -1)), style);
      const oldEntry = c.plan?.entry && citationUses(docText, t.raw) <= 1 ? c.plan.entry : null;
      // An essay or paper with no list gets one (owner, 2026-10-09); a DBQ, a speech or a news story never does.
      const plan = await citePlan(seg, styled, src, { anchor, swapped, entryLine: citedWorkEntry(src, style).entry, oldEntry, listOnly: !same && !genreWantsList(docGenre) });
      if (!plan.steps.length) {
        statusKind = "idle";
        statusMsg = same ? `${plan.listName} already has this work's entry` : "nothing to change";
        render();
        return true;
      }
      return runDocEdit(`recite:${key}:${i}`, {
        steps: plan.steps,
        retry: plan.retry,
        copy: same ? citedWorkEntry(src, style).entry : swapped,
        doneMsg: same ? (plan.pasteEntry ? `copied the entry for ${shown} — paste it into ${plan.listName}` : `added the entry for ${shown} to ${plan.listName}`)
          : plan.pasteEntry ? `replaced the citation with ${shown} — paste its reference into ${plan.listName}` : `replaced the citation with ${shown}`,
        notes: plan.hint.occurrences > 1 && !(anchor && anchor.hash === seg.hash) ? { ambiguous: REPEATED_NOTE.replace("Fix in doc", "Replace citation") } : null,
        onApplied: () => {
          if (!(plan.hint.occurrences > 1)) markEdited(seg.hash); // the new sentence is checked afresh
          const where = plan.rewroteEntry ? `, and your ${plan.listName} entry for it now gives the record's details`
            : plan.entryLine && !plan.pasteEntry ? `, and its entry is in your ${plan.listName}` : "";
          c.done = {
            i: Number(i), key: `recite:${key}:${i}`,
            message: same
              ? `${plan.pasteEntry ? `The entry for ${shown} is ready to paste into your ${plan.listName}` : `Your ${plan.listName} now has the entry for ${shown}`}.${plan.pasteEntry ? " Docs didn't let Tracely add it itself — paste it from below." : ""}`
              : `Your sentence now cites ${shown}${where}.${plan.pasteEntry ? " Docs didn't let Tracely add the reference itself — paste it from below." : ""}`,
            paste: plan.pasteEntry, list: plan.listName,
          };
          if (plan.pasteEntry) copyFallback(plan.pasteEntry);
          persistCaches();
        },
        onUndone: () => {
          editedHashes.delete(seg.hash);
          c.done = null;
          persistCaches();
        },
      });
    }

    /* "Add Works Cited" (owner, 2026-10-09: "when it needs to its still not
       automatically inserting works cited"). The no-list note's own fix: each
       cited work is looked up (lookupCitedWork — the record's own fields,
       never a guess; LOOKUP_ROUTES, 10 a minute, no model) and kept only when
       the record is plainly the one cited (citedMatchFor); a work Tracely
       cited itself comes from its source. Then the style's heading and the
       entries, alphabetical, go in at the end as ONE group with one Undo — or
       are copied to paste where Docs refuses the append. A citation no
       record plainly matches is named in the note and left for its own card,
       where the writer picks its work. */
    const LIST_MAX_LOOKUPS = 8;
    const listBuilds = new Map(); // tip id → { loading } | { sig, entries, missing }
    function ownCitedSource(work, style) {
      for (const st of sourcesMap.values()) {
        const src = st?.citedUrl ? st.list?.find((x) => x.url === st.citedUrl) : null;
        const mk = src ? formatCitation(src, style).marker : "";
        if (mk && (mk === work.raw || work.raw.startsWith(mk.slice(0, -1)))) return src;
      }
      return null;
    }
    async function buildWorksCited(tipId) {
      const works = citedWorksWithoutList(docText);
      const sig = works.map((w) => w.key).join(",");
      const have = listBuilds.get(tipId);
      if (have?.loading || (have && have.sig === sig)) return have;
      listBuilds.set(tipId, { loading: true, sig });
      render();
      const style = settings.citationStyle || "mla";
      const entries = [], missing = [];
      for (const [i, w] of works.entries()) {
        const own = ownCitedSource(w, style);
        if (own) { entries.push(formatCitation(own, style).ref); continue; }
        const plan = i < LIST_MAX_LOOKUPS ? citedLookupPlan({ kind: "sentence", raw: w.raw, inner: w.inner, sentence: w.sentence }, docText) : null;
        const r = plan ? await lookupCitedWork(plan) : null;
        const m = r ? citedMatchFor(w, r, plan) : null;
        if (m) entries.push(citedWorkEntry(m, style).entry); else missing.push(w.raw);
      }
      const built = { loading: false, sig, entries: [...new Set(entries)].sort((a, b) => refSortKey(a).localeCompare(refSortKey(b))), missing };
      listBuilds.set(tipId, built);
      render();
      return built;
    }
    function listBuildNote(b) {
      if (!b || b.loading) return "";
      const n = b.entries.length, m = b.missing.length;
      const who = b.missing.slice(0, 3).join(", ") + (m > 3 ? ` and ${m - 3} more` : "");
      if (!m) return `Found ${n === 1 ? "the cited work" : `all ${n} cited works`}.`;
      return `${n ? `Found ${n} of ${n + m}. ` : ""}Not sure which work ${who} ${m === 1 ? "is" : "are"} — ${n ? "the rest go in, and " : "the heading goes in, and "}${m === 1 ? "its" : "each one's"} card finds it for you to pick.`;
    }
    async function docAddWorksCited(tipId) {
      const tip = tipById(tipId);
      if (!tip || tip.kind !== "nolist" || docBusy) return false;
      const built = await buildWorksCited(tipId);
      if (!built || built.loading || worksCitedBlock(docText)) return false;
      const style = settings.citationStyle || "mla";
      const heading = REF_HEADINGS[style] ?? REF_HEADINGS.mla;
      const lines = [heading, ...built.entries];
      const key = `list:${tipId}`;
      // Docs' end of document has to be one the hook can append to (its text API, and a dry run that
      // says so); where it is not, the list is copied to paste — never while fix-all only prepares.
      let canAppend = editPath() !== "hook" || inDoc.api;
      if (canAppend && editPath() === "hook") canAppend = Boolean((await docsEdit("appendLine", { line: heading, dryRun: true }, { timeoutMs: 3000 }))?.ok);
      if (!canAppend) {
        if (editGate.collect) return false;
        const copied = await copyFallback(lines.join("\n"));
        statusKind = "idle";
        statusMsg = copied ? `Docs didn't let Tracely add your ${heading} — it is copied: paste it at the end of the doc` : `Docs didn't let Tracely add your ${heading} — add it at the end of the doc`;
        render();
        return false;
      }
      const n = built.entries.length;
      return runDocEdit(key, {
        steps: lines.map((line) => ({ action: "appendLine", line })),
        copy: lines.join("\n"),
        doneMsg: n ? `added your ${heading} with ${n} ${n === 1 ? "entry" : "entries"}` : `added a ${heading} heading`,
        onApplied: tipDone(tipId, key),
        onUndone: () => popSteps.delete(tipId),
      });
    }

    /* "Complete entry": an incomplete reference line replaced, where it
       stands, by the record's entry — one step, read back by the hook, one
       Undo. Its own underline's rects go along, so a Doc that does not share
       its text can still be edited by selecting them. */
    async function docCompleteEntry(key, i) {
      const c = citedMap.get(key);
      const src = c?.matches?.[Number(i)];
      const t = c?.target;
      if (!src || t?.kind !== "entry" || docBusy) return false;
      const list = worksCitedBlock(docText);
      const n = list ? list.entries.filter((e) => e === t.entry).length : 0;
      if (!n) {
        statusKind = "idle";
        statusMsg = "that entry changed since it was checked — nothing was changed";
        render();
        return false;
      }
      const entry = citedWorkEntry(src, settings.citationStyle || "mla").entry;
      const onScreen = (r) => r && r.width > 0 && r.left >= 0 && r.top >= 0 && r.left + r.width <= innerWidth && r.top + r.height <= innerHeight;
      const rects = n === 1 ? docsBars.filter((b) => b.hash === key && b.el?.isConnected).map(barTextRect).filter(onScreen).slice(0, 8) : [];
      return runDocEdit(`entry:${key}:${i}`, {
        steps: [{ action: "replace", find: t.entry, replacement: entry, hint: { occurrences: n, ...(rects.length ? { rects } : {}) } }],
        copy: entry,
        doneMsg: "completed the reference entry",
        onApplied: () => { c.done = { i: Number(i), key: `entry:${key}:${i}`, message: "The entry now gives the record's details — check them against the work itself." }; },
        onUndone: () => { c.done = null; },
      });
    }

    // The suggested transition goes in as its own sentence ahead of the
    // flagged passage (the minimal diff pastes only the bridge), then the next
    // structural pass re-judges the flow.
    async function addTransition(hash, issue) {
      if (docBusy || !issue?.transition) return false;
      const bridge = issue.transition.trim().replace(/\s+/g, " ");
      const passage = String(issue.passage ?? "").trim();
      // A flow flag can be old (it lives until its paragraph changes): when
      // the passage is one sentence of the export, say how many copies there
      // are now, so the engine refuses if the live doc disagrees.
      const copies = segments.filter((s) => s.text === passage).length;
      return runDocEdit(`flow:${hash}`, {
        steps: [{ action: "replace", find: passage, replacement: `${bridge} ${passage}`, ...(copies ? { hint: { occurrences: copies } } : {}) }],
        copy: issue.transition,
        doneMsg: "transition added",
        onApplied: () => {
          flowDismissed.add(hash); // resolved — clears immediately
          flowSig = "";            // structure changed: re-run flow next cycle
          persistFlow();
        },
        onUndone: () => {
          flowDismissed.delete(hash);
          persistFlow();
        },
      });
    }

    // (the bridge "highlight in doc" feature was removed — real overlay
    //  underlines replaced background tints)

    /* ── Type preview ─────────────────────────────────────────────────────
       Owner, 2026-10-08: "tracely can be a cursor that moves around and can
       type in there … then you confirm the changes and other people can only
       see it once you click yes". Every in-doc edit goes through runDocEdit,
       and with FEATURES.typePreview on it first awaits previewDocEdit: nothing
       is sent to Docs until the writer accepts, so collaborators see nothing
       until then — nothing has touched the Doc. (Docs' Suggesting mode would
       show them the suggestion, which is why it is not used.) No model call,
       no server: it is all local DOM in Tracely's own fixed layers, never
       kix's tiles (the marks layer's lesson).

       Since 2.21.28 Tracely moves like a Figma collaborator. Its cursor — an
       arrow with a "Tracely" pill, ink because colour only ever means a
       finding — glides from the button that was pressed to the change and
       clicks there. The old words are struck over their exact runs
       (svgRangeRects) and the new words are typed IN THE LINE, in the
       document's own font at its zoom, with the rest of the paragraph
       re-flowed after them (tpParagraph, previewFlow): what Docs' suggestion
       mode would show, on this screen only. Accept (Enter) and Reject (Esc,
       or a click anywhere else) sit in a compact bar under the paragraph.
       Where the line can't be drawn faithfully the change is shown in a
       bubble instead: under the line when the paragraph is not rendered
       whole, runs past 15 lines or looks like a table or columns; pinned
       beside the card when it is right-to-left or not on screen — never
       scrolling the view (the hook promises an edit never moves it). A
       click on the bar or bubble while it types skips to the end;
       prefers-reduced-motion shows the end at once. The harness only sees
       any of it when it opts in (window.__tracelyHarness.typePreview ===
       true), so a test page never waits on a click.

       "Let Tracely fix these" (the panel; prepareFixes, below) does not come
       through here: it lists every change first, and the writer's Accept in
       that list is the preview (editGate.approved). */
    const TP_GLIDE_MS = 350, TP_CLICK_MS = 300, TP_STRIKE_MS = 200, TP_FADE_MS = 120, TP_CHAR_MS = 30, TP_TYPE_MAX_MS = 1200;
    const TP_FLOW_MAX_LINES = 15;
    const TP_WASH = "rgba(28,28,28,0.07)"; // ink at 7%: the struck and the inserted words alike, never a hue
    const TP_RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
    const TP_COPY = {
      typing: "Typing a preview — click it to skip", ready: "Only you can see this until you accept",
      accept: "Accept", reject: "Reject", keys: "Enter · Esc",
      deletes: "Deletes the struck-out words.", same: "Nothing in this sentence changes.",
      offscreen: "Not on screen, so it's shown here — your view stays put.",
      label: "Tracely's edit — a private preview, not in the document yet",
    };
    // TEST ANCHOR (server/test/ext-*) — do not rename or re-indent the next line.
    const TP_TOKEN = /\s+|[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*|[\s\S]/gu;
    /* What an edit changes, for showing it: whole tokens (words, runs of
       space, single marks — docs-hook.js planDiff's tokens) kept at each end,
       the middle removed and inserted. keepBefore + removed + keepAfter is the
       old text; keepBefore + inserted + keepAfter the new. A deletion arrives
       as a replace whose replacement is the neighbour it spans ("Off-topic
       line. Next sentence." → "Next sentence."): all strike, nothing typed.
       Display only — the hook plans its own paste. */
    function previewDiff(oldText, newText) {
      const A = String(oldText ?? "").match(TP_TOKEN) || [];
      const B = String(newText ?? "").match(TP_TOKEN) || [];
      let p = 0;
      while (p < A.length && p < B.length && A[p] === B[p]) p++;
      let s = 0;
      while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
      return {
        keepBefore: A.slice(0, p).join(""), removed: A.slice(p, A.length - s).join(""),
        inserted: B.slice(p, B.length - s).join(""), keepAfter: A.slice(A.length - s).join(""),
      };
    }
    /* A job's steps as the preview shows them: the text edits (replace, and
       insertAfter — the hook's sugar for `find` → `find` + `text`), the lines
       a citation adds to the reference list, and a count of anything else. */
    function previewPlan(job) {
      const edits = [], lines = [];
      let other = 0;
      for (const st of Array.isArray(job?.steps) ? job.steps : []) {
        const find = String(st?.find ?? "");
        if (st?.action === "replace") edits.push({ find, next: String(st.replacement ?? ""), hint: st.hint ?? null });
        else if (st?.action === "insertAfter") edits.push({ find, next: find.replace(/\s+$/, "") + String(st.text ?? "").replace(/\s+$/, ""), hint: st.hint ?? null });
        else if (st?.action === "appendLine" || st?.action === "insertLineBefore") lines.push({ line: String(st.line ?? ""), before: st.before == null ? null : String(st.before) });
        else other++;
      }
      return { edits, lines, other };
    }
    // "Also adds to Works Cited: …" — the reference-list half of a citation.
    function previewLineRows(lines, text) {
      const heads = new Set([...Object.values(REF_HEADINGS), "Bibliography"].map((h) => h.toLowerCase()));
      const head = lines.find((l) => heads.has(l.line.trim().replace(/:$/, "").toLowerCase())) ?? null;
      const list = head ? null : worksCitedBlock(String(text ?? ""))?.heading ?? null;
      const name = head ? head.line.trim().replace(/:$/, "") : list ? list.replace(/\b\w/g, (c) => c.toUpperCase()) : null;
      const rest = lines.filter((l) => l !== head);
      if (head && !rest.length) return [{ label: "Also adds the heading", text: name }];
      return rest.map((l) => ({ label: head ? `Also starts ${name} with` : name ? `Also adds to ${name}` : "Also adds at the end", text: l.line }));
    }
    /* The rest of a paragraph re-flowed after the typed words: `runs`
       ([{ text, ins }] — the inserted words, then what followed the change)
       laid out from `startX` on the change's line, wrapped at `right`, later
       lines from `left`, `pitch` apart. Wrapped the way Docs wraps: at a
       space (the space hangs at the line's end), a word wider than a whole
       line broken by characters. `measure(s)` is s's width in the
       paragraph's font. Pure — words, a measure and the box in; positioned
       lines out ({ x, top, text, end, spans: [{ x, text, ins }] }). */
    function previewFlow(runs, measure, { startX, left, right, top, pitch }) {
      const text = (runs ?? []).map((r) => String(r.text ?? "")).join("");
      const ins = [];
      for (const r of runs ?? []) for (let k = 0; k < String(r.text ?? "").length; k++) ins.push(Boolean(r.ins));
      const lines = [];
      let cur = { x: startX, top, from: 0, to: 0 };
      const fits = (from, to, x) => x + measure(text.slice(from, to)) <= right + 0.5;
      const newLine = (at) => { lines.push(cur); cur = { x: left, top: cur.top + pitch, from: at, to: at }; };
      const tok = /\s+|\S+/g;
      for (let m = tok.exec(text); m; m = tok.exec(text)) {
        const s = m.index, e = s + m[0].length;
        if (/^\s/.test(m[0])) { cur.to = e; continue; }
        if (fits(cur.from, e, cur.x)) { cur.to = e; continue; }
        // Onto the next line — unless this one is already a whole empty line.
        if (text.slice(cur.from, s).trim() || cur.x > left + 0.5) newLine(s);
        if (fits(cur.from, e, cur.x)) { cur.to = e; continue; }
        for (let k = s; k < e; k++) {
          if (cur.to > cur.from && !fits(cur.from, k + 1, cur.x)) newLine(k);
          cur.to = k + 1;
        }
      }
      lines.push(cur);
      return lines.map((l) => {
        const spans = [];
        for (let k = l.from; k < l.to;) {
          let j = k;
          while (j < l.to && ins[j] === ins[k]) j++;
          spans.push({ x: l.x + measure(text.slice(l.from, k)), text: text.slice(k, j), ins: ins[k] });
          k = j;
        }
        return { x: l.x, top: l.top, text: text.slice(l.from, l.to), end: l.x + measure(text.slice(l.from, l.to).replace(/\s+$/, "")), spans };
      });
    }
    /* When each part of a preview happens, in ms from its start: the glide
       (only from somewhere — a pressed button, the walkthrough's cursor),
       the click, the strike (drawn while the click lands), the bar or bubble,
       the typing (30 ms a character, 1.2 s at most however long), Accept. */
    function tpTimeline({ inDoc, glide, strike, chars }) {
      const glideMs = inDoc && glide ? TP_GLIDE_MS : 0;
      const clickMs = inDoc ? TP_CLICK_MS : 0;
      const showAt = glideMs + clickMs;
      const perChar = chars ? Math.min(TP_CHAR_MS, TP_TYPE_MAX_MS / chars) : 0;
      const typeAt = showAt + (chars ? (inDoc ? 60 : TP_FADE_MS) : 0);
      return {
        glideMs, clickAt: glideMs, clickMs, strikeAt: glideMs + (inDoc ? 100 : 0), strikeMs: inDoc && strike ? TP_STRIKE_MS : 0,
        showAt, typeAt, perChar, readyAt: typeAt + chars * perChar,
      };
    }
    /* "Let Tracely fix these": which flags it goes to, in reading order, and
       what it clicks in each card. A sentence with a fix it can apply →
       Apply revision; a sentence missing its citation → Find a source, then
       the top source that backs it; an unnamed source → the same, named in
       the sentence; a note whose fix is a Delete → Delete. Anything else is
       left for the writer (`left`). Pure: the flags in, the plan out. */
    function walkPlan(flags, notes) {
      const items = [];
      let left = 0;
      for (const f of flags ?? []) {
        const act = f.revision ? "fix" : f.verdict === "needs_citation" && !f.citedHere ? "cite" : null;
        if (act) items.push({ key: f.key, start: f.start, act, verdict: f.verdict });
        else left++;
      }
      for (const n of notes ?? []) {
        const act = n.deletes ? "delete" : n.kind === "vague" && n.claim ? "name" : n.kind === "nolist" ? "list" : null;
        if (act) items.push({ key: n.key, start: n.start, act, kind: n.kind });
        else left++;
      }
      items.sort((x, y) => x.start - y.start);
      return { items, left };
    }
    // The source the walkthrough cites: the top one that BACKS the sentence
    // (backingSources, and a stance that says so) — never one that merely
    // shares its topic, never one the server could not read. null: none does.
    function walkSource(list, verdict) {
      return backingSources(list, verdict).list.find((s) => s.stance === "supports" || (s.stance === "refutes" && (verdict === "false" || verdict === "incoherent"))) ?? null;
    }

    /* Where the cursor starts: the last press (or Enter / Space) on Tracely's
       own UI — the popover, or the panel — and the card it sits in, which
       the off-screen bubble is pinned beside. Noted only while the switch is
       on; nothing but two rects and a time is kept. */
    let tpPress = null;
    function tpNotePress(e) {
      try {
        if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
        const t = typeof e.composedPath === "function" ? e.composedPath()[0] : e.target;
        if (!t || typeof t.getBoundingClientRect !== "function") return;
        const pop = t.closest?.("[data-tracely-docs-popover]") ?? null;
        const host = t.getRootNode?.()?.host;
        const panel = !pop && host?.id === "tracely-host" ? host.shadowRoot?.querySelector(".root") ?? null : null;
        if (!pop && !panel) return;
        tpPress = { rect: t.getBoundingClientRect(), box: (pop ?? panel).getBoundingClientRect(), at: Date.now() };
      } catch { /* nothing to note */ }
    }
    function tpActive() {
      let a = document.activeElement;
      while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
      return a ?? null;
    }
    const tpStop = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    const tpClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const tpEase = (k) => 1 - (1 - tpClamp(k, 0, 1)) ** 3; // ease-out
    const tpClip = (s, n, fromEnd) => (s.length <= n ? s : fromEnd ? `…${s.slice(s.length - n).replace(/^\S*\s/, "")}` : `${s.slice(0, n).replace(/\s\S*$/, "")}…`);
    let tpMeas = null;
    const tpMeasurer = () => (tpMeas ??= document.createElement("canvas").getContext("2d"));

    /* ── the cursor: a Figma-style multiplayer pointer ──────────────────────
       An ink arrow with a thin white outline (so it reads on text and on
       white), the "Tracely" pill below-right of it, and a ring for a click.
       One for the page: the walkthrough's cursor is the preview's. Above the
       panel (it starts on the panel's button), and never takes a click. */
    let tcCur = null;
    function tcCursor() {
      if (tcCur && tcCur.root.isConnected) return tcCur;
      const ns = "http://www.w3.org/2000/svg";
      const root = el("div", { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none", transform: "translate(-100px, -100px)" });
      root.setAttribute("data-tracely-cursor", "");
      root.setAttribute("aria-hidden", "true");
      const ring = el("div", { position: "absolute", left: "-14px", top: "-14px", width: "28px", height: "28px", borderRadius: "50%", border: `2px solid ${DM.ink}`, boxSizing: "border-box", opacity: "0", transform: "scale(0.3)" });
      const arrow = document.createElementNS(ns, "svg");
      arrow.setAttribute("width", "18"); arrow.setAttribute("height", "24"); arrow.setAttribute("viewBox", "0 0 18 24");
      Object.assign(arrow.style, { position: "absolute", left: "-2px", top: "-2px", overflow: "visible", transformOrigin: "2px 2px" });
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", "M2 2 L2 19.5 L6.6 15.2 L9.6 22 L12.9 20.6 L9.9 13.9 L16.2 13.9 Z");
      path.setAttribute("fill", DM.ink); path.setAttribute("stroke", "#fff"); path.setAttribute("stroke-width", "1.5"); path.setAttribute("stroke-linejoin", "round");
      arrow.appendChild(path);
      const pill = el("div", {
        position: "absolute", left: "13px", top: "19px", background: DM.ink, color: "#fff", fontFamily: APP.font, fontSize: "11.5px",
        fontWeight: "600", lineHeight: "18px", padding: "0 7px", borderRadius: "6px", whiteSpace: "nowrap", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
      }, "Tracely");
      root.append(ring, arrow, pill);
      document.documentElement.appendChild(root);
      tcCur = { root, arrow, pill, ring, x: -100, y: -100 };
      return tcCur;
    }
    // (x, y) is the arrow's tip.
    function tcCursorAt(x, y) {
      const c = tcCursor();
      c.x = x; c.y = y;
      c.root.style.transform = `translate(${x}px, ${y}px)`;
    }
    // A click, k from 0 to 1: the arrow presses to 0.9 and back, a ring spreads and fades.
    function tcCursorPress(k) {
      const c = tcCursor();
      const on = k > 0 && k < 1;
      c.arrow.style.transform = `scale(${on ? (k < 0.35 ? 1 - 0.1 * (k / 0.35) : 0.9 + 0.1 * tpClamp((k - 0.35) / 0.35, 0, 1)) : 1})`;
      c.ring.style.opacity = on ? String(0.55 * (1 - k)) : "0";
      c.ring.style.transform = `scale(${0.3 + 1.3 * tpClamp(k, 0, 1)})`;
    }
    function tcCursorHide() {
      if (tcCur) tcCur.root.remove();
      tcCur = null;
    }

    /* The change's paragraph, for typing in the line: its runs on screen,
       where the rest after the change starts (`end`) and the runs to mask
       (`mask`), the font at this zoom (data-font-css, its size scaled by the
       run's drawn width over its measured width) and where its baseline sits
       in a run's box. null when the line can't be drawn faithfully: the
       paragraph not rendered whole (or edited since the last read), over 15
       lines, or runs on one line far apart / wrapped lines that do not share
       a left edge (a table, columns). The re-flowed part is drawn plain, in
       the font of the run it continues: bold, italics, links and colours in
       it are not reproduced in the preview — the edit itself keeps them. */
    function tpParagraph(main, diff, geo) {
      if (!geo || /\n/.test(main.find)) return null;
      const P = String(docText ?? "").split("\n").find((l) => l.includes(main.find));
      if (!P) return null;
      const r0 = geo.at.node.getBoundingClientRect();
      const near = { left: r0.left + geo.at.f * r0.width, top: r0.top, width: 1, height: r0.height };
      const N = nrm(P).length;
      const at = P.indexOf(main.find) + diff.keepBefore.length + diff.removed.length; // where the change ends, in P
      const A = nrm(P.slice(0, at)).length;
      const whole = svgRangeRects(P, 0, N, near);
      const end = svgRangeRects(P, A, A, near);
      const rest = A < N ? svgRangeRects(P, A, N, near) : { pieces: [] };
      if (!whole?.pieces.length || !end || !rest) return null;
      const lines = tpLines(whole.pieces.map((p) => barTextRect(p)).filter(Boolean));
      if (!lines.length || lines.length > TP_FLOW_MAX_LINES) return null;
      if (lines.some((l) => l.gap > 2.5 * l.height) || lines.slice(2).some((l) => Math.abs(l.left - lines[1].left) > 4)) return null;
      const node = (rest.pieces[0] ?? whole.pieces[whole.pieces.length - 1]).node; // the run the flow continues in
      const css = node.getAttribute("data-font-css") || "";
      const raw = node.getAttribute("aria-label") || "";
      const size = parseFloat(css.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? "");
      const box = node.getBoundingClientRect();
      if (!(size > 0) || !raw.trim() || !(box.width > 0)) return null;
      const m = tpMeasurer();
      m.font = css;
      const natural = m.measureText(raw).width;
      const scale = natural > 0 ? box.width / natural : 1;
      const font = css.replace(/(\d+(?:\.\d+)?)px/, `${(size * scale).toFixed(3)}px`);
      m.font = font;
      const met = m.measureText(raw);
      const asc = met.fontBoundingBoxAscent ?? met.actualBoundingBoxAscent ?? size * scale * 0.8;
      const desc = met.fontBoundingBoxDescent ?? met.actualBoundingBoxDescent ?? size * scale * 0.2;
      const h = box.height || lines[0].height;
      const left = lines[lines.length > 1 ? 1 : 0].left;
      const right = Math.max(...lines.map((l) => l.right), tpColumnRight(left, h));
      const diffs = lines.slice(1).map((l, i) => l.top - lines[i].top).sort((x, y) => x - y);
      const pitch = diffs.length ? diffs[Math.floor(diffs.length / 2)] : tpPitch(h);
      return {
        rest: P.slice(at), pieces: whole.pieces, mask: rest.pieces, end: end.at, font, base: (h - (asc + desc)) / 2 + asc, h, pitch,
        leftOff: left - lines[0].left, rightOff: right - lines[0].left,
        gap: diff.removed.trim() ? Math.max(2, m.measureText(" ").width * 0.6) : 0,
      };
    }
    // Rects grouped into visual lines: { top, height, left, right, gap } (gap: the widest space between two runs).
    function tpLines(rects) {
      const out = [];
      for (const r of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
        const l = out.find((x) => Math.abs(x.top - r.top) <= 3);
        if (!l) { out.push({ top: r.top, height: r.height, left: r.left, right: r.left + r.width, gap: 0 }); continue; }
        l.gap = Math.max(l.gap, r.left - l.right);
        l.left = Math.min(l.left, r.left);
        l.right = Math.max(l.right, r.left + r.width);
        l.height = Math.max(l.height, r.height);
      }
      return out;
    }
    // The text column's right edge near `left`: the widest visible line that starts there.
    function tpColumnRight(left, h) {
      const lines = tpLines(svgLineNodes().map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0));
      return Math.max(0, ...lines.filter((l) => Math.abs(l.left - left) <= 4 && l.height <= h * 1.5).map((l) => l.right));
    }
    // A single-line paragraph's line pitch, read off the wrapped lines around it.
    function tpPitch(h) {
      const tops = tpLines(svgLineNodes().map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0)).map((l) => l.top);
      const d = tops.slice(1).map((t, i) => t - tops[i]).filter((x) => x > h * 0.9 && x < h * 2);
      return d.length ? Math.min(...d) : Math.round(h * 1.2);
    }

    let tpOpen = null; // the preview on screen — only ever one
    let tpSeq = 0;
    let tpShown = 0;   // previews opened so far: how the walkthrough knows its click reached one

    // Resolves true on Accept, false on Reject (or when it cannot be shown —
    // never an edit the writer did not accept).
    function showTypePreview(key, job) {
      tpShown++;
      if (tpOpen) tpOpen.finish(false);
      return new Promise((resolve) => {
        try {
          tpOpen = tpShow(previewPlan(job), resolve);
        } catch (err) {
          console.debug(`[tracely] type preview could not be shown (${err?.message ?? err}) — nothing was sent`);
          resolve(false);
        }
      });
    }

    function tpShow(plan, resolve) {
      const main = plan.edits[0] ?? null;
      const diff = main ? previewDiff(main.find, main.next) : null;
      const near = main?.hint?.rects?.[0] ?? null;
      const a = diff ? nrm(diff.keepBefore).length : 0;
      const span = diff ? [a, a + nrm(diff.removed).length] : null;
      const under = plan.lines.find((l) => l.before) ?? null; // an entry going in above another
      const locateMain = () => (main ? svgRangeRects(main.find, span[0], span[1], near) : null);
      const locateUnder = () => (under ? svgRangeRects(under.before, 0, nrm(under.before).length) : null);
      const scroller = document.querySelector(".kix-appview-editor");
      const clip = () => {
        const r = scroller && scroller.isConnected ? scroller.getBoundingClientRect() : null;
        return { top: Math.max(0, r ? r.top : 0), bottom: Math.min(innerHeight, r ? r.bottom : innerHeight) };
      };
      const pointOf = (g) => {
        const r = g.at.node.getBoundingClientRect();
        return { x: r.left + g.at.f * r.width, y: r.top, h: r.height || 18 };
      };
      const onScreen = (g) => {
        if (!g) return false;
        const p = pointOf(g), c = clip();
        return p.x >= 0 && p.x <= innerWidth && p.y >= c.top && p.y + p.h <= c.bottom;
      };
      // Right-to-left text: the runs' fractions would mirror, so nothing is drawn over it.
      const rtl = Boolean(main && TP_RTL.test(main.find + main.next));
      let geo = rtl ? null : locateMain();
      let geoUnder = locateUnder();
      const inDoc = main ? onScreen(geo) : onScreen(geoUnder);
      const target = () => (main ? geo : geoUnder);
      const ins = Array.from(diff?.inserted ?? "");
      let para = inDoc && main && ins.length ? tpParagraph(main, diff, geo) : null;
      // inline: typed in the line · strike: a deletion, struck in place ·
      // bubble: typed in a bubble under the line · pinned: beside the card.
      const mode = !inDoc ? "pinned" : !main ? "strike" : para ? "inline" : ins.length ? "bubble" : "strike";
      const compact = mode === "inline" || mode === "strike";
      // (Cite in doc asks the hook a few dry-run questions first: up to ~10 s.)
      const press = tpPress && Date.now() - tpPress.at < 15_000 ? tpPress : null;
      // From where the walkthrough's cursor is, else from the pressed button (or the underline).
      const from = press?.rect ?? near;
      const fontCss = inDoc ? target().at.node.getAttribute("data-font-css") || "" : "";
      const family = fontCss.match(/\d[\d.]*px(?:\/\S+)?\s+(.+)$/)?.[1] ?? null;
      const tl = tpTimeline({ inDoc, glide: Boolean(from), strike: Boolean(span && span[1] > span[0]), chars: ins.length });

      /* ── build (detached, so a failure here leaves nothing behind) ── */
      const layer = el("div", { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "902" });
      layer.setAttribute("data-tracely-type-preview", "");
      layer.setAttribute("data-tracely-type-mode", mode);
      // The re-flowed paragraph is painted on a canvas, as Docs paints it: same font, same metrics.
      const cv = mode === "inline" ? el("canvas", { position: "absolute", left: "0", top: "0", width: "100%", height: "100%" }) : null;
      if (cv) { cv.setAttribute("aria-hidden", "true"); cv.setAttribute("data-tracely-type-flow", ""); layer.appendChild(cv); }
      const strikes = [];
      const strikeEl = () => {
        const box = el("div", { position: "absolute", background: TP_WASH, borderRadius: "2px", opacity: "0", display: "none" });
        const line = el("div", { position: "absolute", left: "0", width: "100%", top: "56%", height: "2px", marginTop: "-1px", background: DM.ink, borderRadius: "1px", transformOrigin: "0 50%", transform: "scaleX(0)" });
        box.setAttribute("aria-hidden", "true");
        box.setAttribute("data-tracely-type-strike", "");
        box.appendChild(line);
        layer.appendChild(box);
        return { box, line };
      };
      const mark = el("div", { position: "absolute", height: "2px", background: DM.ink, borderRadius: "1px", opacity: "0.7", display: "none" });
      mark.setAttribute("aria-hidden", "true");
      mark.setAttribute("data-tracely-type-mark", "");
      layer.appendChild(mark);
      // The text caret where the words go in: 2px, the line's height.
      const caret = el("div", { position: "absolute", left: "0", top: "0", width: "2px", height: "18px", background: DM.ink, borderRadius: "1px", display: "none" });
      caret.setAttribute("aria-hidden", "true");
      caret.setAttribute("data-tracely-type-caret", "");

      // Typing in the line, Accept / Reject sit on a card in the right margin beside the change, the
      // way Docs puts a suggestion's card in its margin: opaque, so nothing ever shows through it.
      const bubble = el("div", compact ? {
        position: "absolute", left: "0", top: "0", pointerEvents: "auto", boxSizing: "border-box", width: "max-content", minWidth: "200px", maxWidth: "280px",
        padding: "8px 10px 10px", background: "#fff", border: "1px solid #dadce0", borderRadius: "8px",
        boxShadow: "0 1px 3px rgba(60,64,67,0.3), 0 4px 8px 3px rgba(60,64,67,0.15)",
        fontFamily: APP.font, color: DM.ink, display: "none", flexDirection: "column", gap: "8px", opacity: "1", outline: "none", WebkitFontSmoothing: "antialiased",
      } : {
        position: "absolute", left: "0", top: "0", pointerEvents: "auto", boxSizing: "border-box", width: "max-content",
        minWidth: "240px", maxWidth: "380px", padding: "10px 12px 12px", background: "#fff", border: `1.5px dashed ${DM.ink}`,
        borderRadius: "12px", boxShadow: "0 8px 24px rgba(0,0,0,0.16)", fontFamily: APP.font, color: DM.ink,
        display: "none", flexDirection: "column", gap: "8px", opacity: "0", outline: "none", WebkitFontSmoothing: "antialiased",
      });
      bubble.setAttribute("role", "dialog");
      bubble.setAttribute("aria-label", TP_COPY.label);
      bubble.setAttribute("data-tracely-type-bubble", "");
      bubble.tabIndex = -1;
      const head = el("div", { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" });
      head.appendChild(el("span", { background: DM.ink, color: "#fff", fontSize: "11px", fontWeight: "600", lineHeight: "16px", padding: "0 6px", borderRadius: "4px", whiteSpace: "nowrap" }, "Tracely"));
      if (mode === "strike" && diff) head.appendChild(el("span", { fontSize: "12px", color: DM.ink }, diff.removed.trim() ? TP_COPY.deletes : TP_COPY.same));
      const status = el("span", { fontSize: "11.5px", color: DM.body }, TP_COPY.typing);
      head.appendChild(status);
      bubble.appendChild(head);

      // In the line, the typed words are on the canvas; this span carries them for the bubble.
      const text = el("div", compact
        ? { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }
        : { fontSize: "15px", lineHeight: "1.45", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: family ? `${family}, ${APP.font}` : "inherit" });
      text.setAttribute("aria-hidden", "true"); // read whole from the description, not letter by letter
      const typed = el("span", { color: DM.ink });
      typed.setAttribute("data-tracely-type-typed", "");
      const typingCaret = el("span", { display: "inline-block", width: "2px", height: "1.1em", marginLeft: "1px", verticalAlign: "text-bottom", background: DM.ink, borderRadius: "1px" });
      const struck = (s) => el("span", { textDecoration: "line-through", textDecorationThickness: "2px", color: DM.body, background: TP_WASH, borderRadius: "2px" }, s);
      if (diff && mode === "pinned") {
        // Off screen: the change written inline, between a few kept words.
        if (diff.keepBefore) text.appendChild(el("span", { color: DM.body }, tpClip(diff.keepBefore, 60, true)));
        if (diff.removed) text.appendChild(struck(diff.removed));
        text.appendChild(typed);
        if (ins.length) text.appendChild(typingCaret);
        if (diff.keepAfter) text.appendChild(el("span", { color: DM.body }, tpClip(diff.keepAfter, 40, false)));
      } else if (diff && ins.length) {
        text.appendChild(typed);
        if (!compact) text.appendChild(typingCaret);
      } else if (diff && !compact) {
        text.appendChild(el("span", { fontSize: "13px", color: DM.body }, diff.removed ? TP_COPY.deletes : TP_COPY.same));
      }
      if (diff) bubble.appendChild(text);
      if (main && mode === "pinned") bubble.appendChild(el("div", { fontSize: "11.5px", color: DM.body }, TP_COPY.offscreen));
      const change = (d) => {
        const out = tpClip(d.removed.trim(), 80, false), put = tpClip(d.inserted.trim(), 120, false);
        return out && put ? `“${out}” → “${put}”` : out ? `deletes “${out}”` : put ? `adds “${put}”` : "nothing";
      };
      const rows = [
        ...plan.edits.slice(1).map((e) => ({ label: "Also changes", text: change(previewDiff(e.find, e.next)) })),
        ...previewLineRows(plan.lines, docText),
        ...(plan.other ? [{ label: "And", text: `${plan.other} more change${plan.other === 1 ? "" : "s"} not shown here` }] : []),
      ];
      for (const r of rows) {
        const row = el("div", { display: "flex", flexDirection: "column", gap: "2px" });
        row.appendChild(el("div", { fontSize: "10.5px", fontWeight: "600", color: DM.body, letterSpacing: "0.4px", textTransform: "uppercase", whiteSpace: "nowrap" }, r.label));
        row.appendChild(el("div", { fontSize: "12.5px", lineHeight: "1.4", color: DM.ink, wordBreak: "break-word" }, tpClip(String(r.text), 220, false)));
        bubble.appendChild(row);
      }
      const accept = dmBtn(TP_COPY.accept, true);
      const reject = dmBtn(TP_COPY.reject, false);
      accept.setAttribute("data-tracely-type-accept", "");
      reject.setAttribute("data-tracely-type-reject", "");
      if (compact) for (const b of [accept, reject]) Object.assign(b.style, { padding: "5px 12px", fontSize: "12.5px" });
      // Our own focus ring, in ink: the browser's can be amber, which means a missing citation.
      for (const btn of [accept, reject]) {
        btn.addEventListener("focus", () => { btn.style.outline = `2px solid ${DM.ink}`; btn.style.outlineOffset = "2px"; });
        btn.addEventListener("blur", () => { btn.style.outline = ""; btn.style.outlineOffset = ""; });
      }
      const actions = dmActions(accept, reject, el("span", { fontSize: "11.5px", color: DM.body, marginLeft: "auto", whiteSpace: "nowrap" }, TP_COPY.keys));
      actions.style.display = "none";
      bubble.appendChild(actions);
      const summary = !diff ? "" : diff.removed.trim() && ins.length ? `Replaces “${diff.removed.trim()}” with “${diff.inserted.trim()}”.`
        : diff.removed.trim() ? `Deletes “${diff.removed.trim()}”.` : ins.length ? `Adds “${diff.inserted.trim()}”.` : TP_COPY.same;
      const desc = el("div", { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" },
        [summary, ...rows.map((r) => `${r.label}: ${r.text}.`)].filter(Boolean).join(" "));
      desc.id = `tracely-type-preview-${++tpSeq}`;
      bubble.setAttribute("aria-describedby", desc.id);
      bubble.appendChild(desc);
      layer.appendChild(caret);
      layer.appendChild(bubble);

      /* ── state ── */
      const t0 = performance.now();
      const path0 = location.pathname;
      let skipped = reducedMotion();
      let ready = false, done = false, typedN = -1, raf = 0, tmr = 0, relocAt = 0, shownOnce = false;
      let flowNow = null; // the last layout drawn: where the caret and the bar go
      let barBox = null;  // where the bar or bubble is: the parked cursor keeps off it
      const prevFocus = tpActive();
      // The popover would sit on top of the change: out of the way while it
      // is drawn in the document, back as it was afterwards.
      const pop = inDoc && popEl && popEl.isConnected ? popEl : null;
      const popVis = pop ? pop.style.visibility : "";
      const skip = () => { skipped = true; frame(); };

      const finish = (ok) => {
        if (done) return;
        done = true;
        if (raf) cancelAnimationFrame(raf);
        if (tmr) clearTimeout(tmr);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("pointerdown", onDown, true);
        window.removeEventListener("pagehide", onHide);
        layer.remove();
        if (pop) pop.style.visibility = popVis;
        tcCursorHide(); // the edit's cursor goes with it
        if (tpOpen === handle) tpOpen = null;
        try { if (prevFocus?.isConnected && typeof prevFocus.focus === "function") prevFocus.focus({ preventScroll: true }); } catch { /* best effort */ }
        console.debug(`[tracely] type preview ${ok ? "accepted" : "rejected"}`);
        resolve(Boolean(ok));
      };
      const handle = { finish };
      const onKey = (e) => {
        if (e.key === "Escape") { tpStop(e); finish(false); return; }
        if (e.key === "Enter" && !e.isComposing) {
          tpStop(e);
          if (!ready) skip(); // see it whole before it can be accepted
          else finish(tpActive() !== reject);
          return;
        }
        if (e.key === "Tab" && ready) { tpStop(e); (tpActive() === accept ? reject : accept).focus({ preventScroll: true }); }
      };
      const onDown = (e) => {
        const path = typeof e.composedPath === "function" ? e.composedPath() : [e.target];
        if (path.includes(bubble)) { if (!ready) skip(); return; }
        // A press on a scrollbar scrolls; it is not a "no".
        const t = e.target;
        if (t && t.clientWidth > 0 && (t.scrollHeight > t.clientHeight || t.scrollWidth > t.clientWidth)
          && (e.offsetX >= t.clientWidth || e.offsetY >= t.clientHeight)) return;
        finish(false);
      };
      const onHide = () => finish(false);
      accept.addEventListener("click", () => finish(true));
      reject.addEventListener("click", () => finish(false));

      /* ── the paragraph, live: re-read from Docs' runs every frame (they follow scroll) ── */
      const paraLive = () => {
        if (!para) return null;
        const rects = para.pieces.map((p) => barTextRect(p)).filter(Boolean);
        if (rects.length !== para.pieces.length || !para.end.node.isConnected) return null;
        const lines = tpLines(rects);
        const e = pointOf({ at: para.end });
        return {
          lines, left: lines[0].left + para.leftOff, right: lines[0].left + para.rightOff, end: e,
          bottom: Math.max(...lines.map((l) => l.top + l.height)), mask: para.mask.map((p) => barTextRect(p)).filter(Boolean),
        };
      };
      const measure = (s) => tpMeasurer().measureText(s).width;
      const drawFlow = (t) => {
        flowNow = null;
        if (!cv) return;
        const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
        // The layer's own box, not innerWidth: a page scrollbar narrows it, and a
        // bitmap sized to innerWidth would be squeezed to fit — every x off a little.
        const cw = layer.clientWidth || innerWidth, ch = layer.clientHeight || innerHeight;
        const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
        if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
        const ctx = cv.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        if (t < tl.showAt) return; // the original line, untouched, until the click lands
        const g = paraLive();
        if (!g) return;
        tpMeasurer().font = para.font;
        const flow = previewFlow([{ text: typed.textContent, ins: true }, { text: para.rest, ins: false }], measure,
          { startX: g.end.x + para.gap, left: g.left, right: g.right, top: g.end.y, pitch: para.pitch });
        const c = clip();
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, c.top, innerWidth, c.bottom - c.top);
        ctx.clip();
        // Page white over the original words after the change, and under every line drawn
        // (lines past the paragraph's own overlay what is below it).
        ctx.fillStyle = "#fff";
        for (const r of g.mask) ctx.fillRect(r.left - 1, r.top - 1, r.width + 2, r.height + 5); // its underline too: marks do not re-flow
        flow.forEach((l, i) => {
          if (i === 0) ctx.fillRect(l.x - 1, l.top - 1, Math.max(0, g.right - l.x + 2), para.h + 2);
          else ctx.fillRect(g.left - 1, flow[i - 1].top + para.h, g.right - g.left + 2, l.top - flow[i - 1].top + 1);
        });
        // Past the paragraph's own last line the re-flow is a sheet lifted over the page —
        // opaque white, a soft shadow on its bottom edge only, no taller than the lines it
        // carries — so what it covers reads as underneath, not gone.
        const flowBottom = flow[flow.length - 1].top + para.h;
        if (flowBottom > g.bottom + 1) {
          const sx = g.left - 6, sw = g.right - g.left + 12, sy = g.bottom + 1;
          // Its bottom snaps past every Docs line it touches — and Tracely's own underline under that
          // line — so a line is under it whole, never cut in half.
          let bottom = flowBottom + 2;
          const marks = docsBars.filter((b) => b.el?.isConnected && b.el.style.display !== "none").map((b) => {
            const r = b.el.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height };
          });
          for (let grew = true; grew;) {
            grew = false;
            for (const r of [...visibleRuns(), ...marks]) {
              if (r.top < bottom && r.bottom > sy && r.right > sx && r.left < sx + sw && r.bottom + 2 > bottom) { bottom = r.bottom + 2; grew = true; }
            }
          }
          const sh = bottom - sy;
          ctx.save();
          ctx.beginPath();
          ctx.rect(sx, sy, sw, sh + 16); // clipped to its own width and below its top: the shadow falls under it only
          ctx.clip();
          ctx.shadowColor = "rgba(60,64,67,0.28)";
          ctx.shadowBlur = 8;
          ctx.shadowOffsetY = 2;
          ctx.fillStyle = "#fff";
          ctx.fillRect(sx, sy, sw, sh);
          ctx.restore();
        }
        ctx.font = para.font;
        ctx.textBaseline = "alphabetic";
        for (const l of flow) {
          for (const s of l.spans) {
            if (s.ins) { ctx.fillStyle = TP_WASH; ctx.fillRect(s.x, l.top, measure(s.text.replace(/\s+$/, "")), para.h); }
            ctx.fillStyle = s.ins ? DM.ink : "#000";
            ctx.fillText(s.text, s.x, l.top + para.base);
          }
        }
        ctx.restore();
        // The layout once every letter is in: where the parked cursor must not go, from the start.
        const final = typed.textContent.length === diff.inserted.length ? flow
          : previewFlow([{ text: diff.inserted, ins: true }, { text: para.rest, ins: false }], measure,
            { startX: g.end.x + para.gap, left: g.left, right: g.right, top: g.end.y, pitch: para.pitch });
        flowNow = { flow, final, g };
      };
      // Where the typed words end (the text caret), and the line it is on.
      const typedEnd = () => {
        if (mode === "inline" && flowNow) {
          const { flow } = flowNow;
          for (let i = flow.length - 1; i >= 0; i--) {
            const s = [...flow[i].spans].reverse().find((x) => x.ins);
            if (s) return { x: s.x + measure(s.text), y: flow[i].top };
          }
          return { x: flow[0].x, y: flow[0].top };
        }
        const g = target();
        return g ? (() => { const p = pointOf(g); return { x: p.x, y: p.y }; })() : null;
      };
      /* Parked, the cursor never covers a word. The words on screen: Docs' runs (re-read at
         most every 300 ms), the re-flowed lines as they will be once typed, and the bar. */
      let runsCache = null, runsAt = -Infinity;
      const visibleRuns = () => {
        const now = performance.now();
        if (!runsCache || now - runsAt > 300) {
          runsAt = now;
          runsCache = svgLineNodes().map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0)
            .map((r) => ({ left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height }));
        }
        return runsCache;
      };
      const colRight = () => Math.max(0, ...visibleRuns().map((r) => r.right));
      const colLeft = () => Math.min(innerWidth, ...visibleRuns().map((r) => r.left));
      const hits = (a, list) => list.some((b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
      const arrowBox = (q) => ({ left: q.x - 1, top: q.y - 1, right: q.x + 15, bottom: q.y + 21 });
      const pillBox = (q) => ({ left: q.x + 13, top: q.y + 19, right: q.x + 13 + (tcCur?.pill.getBoundingClientRect().width || 60), bottom: q.y + 37 });
      const solid = () => {
        const list = [...visibleRuns()];
        if (mode === "inline" && flowNow) for (const l of flowNow.final) list.push({ left: l.x, top: l.top, right: l.end, bottom: l.top + para.h });
        if (barBox) list.push(barBox);
        return list;
      };
      // Near `a` ({ x, y: its line's top, h }) and off every word: just after it, after its
      // line's last word, below it between the lines, then the right or the left margin.
      const freeSpot = (a, words) => {
        const c = clip();
        const lineEnd = Math.max(a.x, ...words.filter((r) => !r.bar && Math.abs(r.top - a.y) <= 3).map((r) => r.right));
        const spots = [
          { x: a.x + 3, y: a.y + 1 }, { x: lineEnd + 2, y: a.y + 1 }, { x: a.x + 1, y: a.y + a.h + 1 },
          { x: colRight() + 6, y: a.y + 1 }, { x: colLeft() - 20, y: a.y + 1 },
        ];
        return spots.find((q) => {
          const b = arrowBox(q);
          return b.left >= 0 && b.right <= innerWidth && b.top >= c.top && b.bottom <= c.bottom && !hits(b, words);
        }) ?? spots[spots.length - 1];
      };
      // Where it parks while the words go in (beside where they start), and once they are in
      // (beside where they end); a deletion's both, beside the strike's end.
      const anchors = () => {
        const p = pointOf(target());
        const struckRects = (main && geo ? geo.pieces : []).map((q) => barTextRect(q)).filter(Boolean);
        const last = struckRects[struckRects.length - 1];
        if (mode === "strike" && last) { const a = { x: last.left + last.width, y: last.top, h: last.height }; return [a, a]; }
        if (mode === "inline" && flowNow) {
          const start = { x: flowNow.g.end.x, y: flowNow.g.end.y, h: para.h };
          const f = flowNow.final;
          for (let i = f.length - 1; i >= 0; i--) {
            const s = [...f[i].spans].reverse().find((x) => x.ins);
            if (s) return [start, { x: s.x + measure(s.text.replace(/\s+$/, "")), y: f[i].top, h: para.h }];
          }
          return [start, start];
        }
        return [p, p];
      };
      const placeCursor = (t) => {
        const g = target();
        if (!inDoc || !g) return;
        const p = pointOf(g), c = clip();
        const click = { x: p.x, y: p.y + p.h * 0.55 };
        const clickEnd = tl.clickAt + tl.clickMs;
        const settle = Math.max(tl.readyAt, clickEnd + 150); // all typed, and off the click
        const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
        let at, words = null, parked = false;
        if (from && t < tl.glideMs) {
          const f = { x: from.left + (from.width || 0) / 2, y: from.top + (from.height || 0) / 2 };
          at = lerp(f, click, tpEase(t / tl.glideMs));
        } else if (t < clickEnd) {
          at = click;
        } else {
          words = solid();
          const [startA, endA] = anchors();
          const s1 = freeSpot(startA, words), s2 = freeSpot(endA, words);
          if (t < settle) at = lerp(click, s1, skipped ? 1 : tpEase((t - clickEnd) / 150));
          else at = lerp(s1, s2, skipped ? 1 : tpEase((t - settle) / 150));
          parked = skipped || (t >= clickEnd + 150 && (t < settle || t >= settle + 150));
        }
        tcCursorPress(t >= tl.clickAt && t < clickEnd ? (t - tl.clickAt) / tl.clickMs : 1);
        tcCursorAt(at.x, at.y);
        const off = t >= tl.glideMs && (at.y < c.top || at.y > c.bottom);
        const cur = tcCursor();
        cur.root.style.visibility = off ? "hidden" : "visible";
        // Its name shows only where it covers nothing; settled, the arrow steps back to 60%.
        cur.pill.style.opacity = parked && hits(pillBox(at), words) ? "0" : "1";
        cur.arrow.style.opacity = t >= settle + 1000 ? "0.6" : "1";
      };
      const placeCaret = (t) => {
        if (!inDoc || mode === "strike" || t < tl.showAt) { caret.style.display = "none"; return; }
        const g = target();
        const e = typedEnd();
        if (!g || !e) { caret.style.display = "none"; return; }
        const h = mode === "inline" && para ? para.h : pointOf(g).h;
        const c = clip();
        caret.style.display = e.y + h < c.top || e.y > c.bottom ? "none" : "block";
        caret.style.height = `${h}px`;
        caret.style.transform = `translate(${e.x}px, ${e.y}px)`;
      };
      const placeStrikes = (t) => {
        const pieces = inDoc && main && geo ? geo.pieces : [];
        while (strikes.length < pieces.length) strikes.push(strikeEl());
        const rects = pieces.map((p) => barTextRect(p));
        const total = rects.reduce((n, r) => n + (r ? r.width : 0), 0) || 1;
        const k = tl.strikeMs ? tpClamp((t - tl.strikeAt) / tl.strikeMs, 0, 1) : 1;
        const c = clip();
        let run = 0;
        strikes.forEach((s, i) => {
          const r = rects[i];
          if (!r || r.top + r.height < c.top || r.top > c.bottom) { s.box.style.display = "none"; return; }
          const share = r.width / total;
          Object.assign(s.box.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, opacity: String(tpClamp(k * 2, 0, 1)) });
          s.line.style.transform = `scaleX(${share ? tpClamp((k - run) / share, 0, 1) : 1})`;
          run += share;
        });
      };
      const placeMark = () => {
        const g = geoUnder;
        if (!g || !g.pieces.length) { mark.style.display = "none"; return; }
        const rects = g.pieces.map((p) => barTextRect(p)).filter(Boolean);
        const top = Math.min(...rects.map((r) => r.top));
        const first = rects.filter((r) => Math.abs(r.top - top) <= 2);
        const left = Math.min(...first.map((r) => r.left)), right = Math.max(...first.map((r) => r.left + r.width));
        const c = clip();
        if (top < c.top || top > c.bottom) { mark.style.display = "none"; return; }
        Object.assign(mark.style, { display: "block", left: `${left}px`, top: `${top - 4}px`, width: `${Math.max(24, right - left)}px` });
      };
      const placeBubble = (t) => {
        if (t < tl.showAt) { bubble.style.display = "none"; return; }
        bubble.style.display = "flex";
        if (!shownOnce) {
          shownOnce = true;
          // Keys come to this page, not to Docs' editor frame.
          try { bubble.focus({ preventScroll: true }); } catch { /* best effort */ }
        }
        // The bar is opaque from its first frame: no words may show through it, even fading in.
        bubble.style.opacity = String(skipped || compact ? 1 : tpClamp((t - tl.showAt) / TP_FADE_MS, 0, 1));
        const w = bubble.offsetWidth || 260, h = bubble.offsetHeight || 120;
        let left, top;
        if (inDoc && target()) {
          const p = pointOf(target());
          const rects = (main && geo ? geo.pieces : []).map((q) => barTextRect(q)).filter(Boolean);
          let firstTop = Math.min(p.y, ...rects.map((r) => r.top)); // the first changed line
          let lastBottom = Math.max(p.y + p.h, ...rects.map((r) => r.top + r.height));
          const margin = colRight() + 16;
          if (compact && margin + w <= innerWidth - 8) {
            // Beside the change, in the right margin, level with its first line.
            left = margin;
            top = firstTop;
          } else {
            left = p.x - 14;
            if (mode === "inline" && flowNow) {
              // No room in the margin: under the paragraph's last line — its own, or the last re-flowed.
              const f = flowNow.flow;
              lastBottom = Math.max(flowNow.g.bottom, f[f.length - 1].top + para.h);
              firstTop = Math.min(firstTop, flowNow.g.lines[0].top);
              left = flowNow.g.lines[0].left;
            } else if (mode === "strike") {
              left = Math.min(...rects.map((r) => r.left), p.x);
            }
            top = lastBottom + (compact ? 8 : 10);
            if (top + h > innerHeight - 8 && firstTop - 10 - h >= clip().top) top = firstTop - 10 - h;
          }
        } else {
          // Beside the card: the open popover, else the panel card that was pressed.
          const box = popEl && popEl.isConnected && popEl.style.visibility !== "hidden" ? popEl.getBoundingClientRect() : press?.box ?? press?.rect ?? null;
          if (box) {
            const right = box.left + box.width + 12;
            left = right + w <= innerWidth - 8 ? right : box.left - 12 - w >= 8 ? box.left - 12 - w : box.left;
            top = left === box.left ? box.top - 12 - h : box.top;
          } else {
            left = innerWidth - w - 24;
            top = innerHeight - h - 96;
          }
        }
        left = tpClamp(left, 8, Math.max(8, innerWidth - w - 8));
        top = tpClamp(top, 8, Math.max(8, innerHeight - h - 8));
        bubble.style.left = `${left}px`;
        bubble.style.top = `${top}px`;
        barBox = { left, top, right: left + w, bottom: top + h, bar: true };
      };
      const paintText = (t) => {
        const n = t >= tl.readyAt ? ins.length : Math.max(0, Math.floor((t - tl.typeAt) / (tl.perChar || 1)));
        if (n !== typedN) { typedN = n; typed.textContent = ins.slice(0, n).join(""); }
      };
      // All typed and the bar on screen: Accept / Reject, and Accept focused.
      const markReady = (t) => {
        if (!ready && t >= tl.readyAt && shownOnce) {
          ready = true;
          typingCaret.remove();
          text.removeAttribute("aria-hidden");
          status.textContent = TP_COPY.ready;
          actions.style.display = "flex";
          try { accept.focus({ preventScroll: true }); } catch { /* best effort */ }
          if (!reducedMotion() && typeof caret.animate === "function") {
            caret.animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }], { duration: 1060, iterations: Infinity });
          }
        }
      };
      function frame() {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        if (tmr) { clearTimeout(tmr); tmr = 0; }
        if (done) return;
        if (orphaned || location.pathname !== path0) { finish(false); return; }
        try {
          const t = skipped ? Infinity : performance.now() - t0;
          // Docs recycles a tile's annotation rects as it scrolls: find the
          // sentence again (a few times a second at most) when ours went.
          const gone = (g) => g && (!g.at.node.isConnected || g.pieces.some((p) => !p.node.isConnected));
          const paraGone = para && (!para.end.node.isConnected || para.pieces.some((p) => !p.node.isConnected));
          if ((gone(geo) || gone(geoUnder) || paraGone) && performance.now() - relocAt > 250) {
            relocAt = performance.now();
            if (gone(geo)) geo = locateMain();
            if (gone(geoUnder)) geoUnder = locateUnder();
            if (paraGone && geo) para = tpParagraph(main, diff, geo) ?? para;
          }
          paintText(t);
          drawFlow(t);
          placeStrikes(t);
          placeMark();
          placeCaret(t);
          placeBubble(t);
          placeCursor(t); // after the bar: it parks off the bar too
          markReady(t);
        } catch (err) {
          console.debug(`[tracely] type preview frame: ${err?.message ?? err}`);
        }
        // A frame, or 50 ms, whichever comes first: a pane that is not
        // compositing never runs rAF (renderer/src/frameScheduler.ts).
        raf = requestAnimationFrame(frame);
        tmr = setTimeout(frame, 50);
      }

      /* ── on screen ── */
      if (pop) pop.style.visibility = "hidden";
      // Out of Docs' editor frame, whose keystrokes this page never hears.
      if (document.activeElement?.tagName === "IFRAME") document.activeElement.blur();
      document.documentElement.appendChild(layer);
      if (inDoc) tcCursor();
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("pointerdown", onDown, true);
      window.addEventListener("pagehide", onHide);
      console.debug(`[tracely] type preview · ${mode} · ${main ? `${nrm(diff.removed).length} struck, ${ins.length} typed` : "no sentence change"} · ${plan.lines.length} line(s)`);
      frame();
      return handle;
    }

    /* ── "Let Tracely fix these": everything prepared, then the writer picks ──
       Owner, 2026-10-08: "it waits a while when it clicks find citations. It
       also waits after each fix for you to confirm. I want to have it finish
       everything and theres like multiple things waiting for you to choose."
       (It used to drive the cursor flag by flag: each citation waited on its
       own search, and each change on the writer's Accept, before the next.)
       One press now prepares every change walkPlan can make, at once:
         • the searches its citations need all start, FIX_SEARCHES at a time
           and FIX_SEARCHES_PER_MIN a minute (the server allows a caller 4);
         • each change is worked out by the very function its card's button
           calls — docFix, docDeleteTip, docCite — against the doc as it is,
           with runDocEdit only RECORDING it (editGate.collect): nothing
           reaches the Doc.
       Each lands in the panel the moment it is ready — what it changes, and
       from which source — and the writer accepts it, skips it, or accepts
       them all. An accepted change is made by that same function again, so it
       is planned against the doc as it is THEN, and goes in without a second
       preview (editGate.approved): one at a time, each after a read of the
       doc the last one changed. Nothing here accepts anything for the
       writer, and a source is only ever one that BACKS its sentence
       (walkSource). */
    const FIX_SEARCHES = 3;
    const FIX_SEARCHES_PER_MIN = 3; // the server's callerSourcesPerMinute is 4: one is left for the writer's own
    let fixBatch = null;        // { items, left, preparing, stopped, applying }
    let fixQueue = Promise.resolve(); // collections run one at a time (runDocEdit's docBusy)
    let fixSearchStarts = [];   // when this page's batch searches started (the minute's pace)
    let fixSearchesRunning = 0;
    const FIX_COPY = {
      go: "Let Tracely fix these", stop: "Stop", done: "Done", accept: "Accept", skip: "Skip",
      all: (n) => `Accept all ${n}`,
      offer: (n) => `Tracely can prepare ${n === 1 ? "this fix" : `${n} of these fixes`} at once — then you choose what goes in`,
      preparing: (ready, n) => `Preparing ${n} ${n === 1 ? "fix" : "fixes"} · ${ready} ready`,
      ready: (n) => `${n} ${n === 1 ? "fix" : "fixes"} ready — accept what you want`,
      finished: (n) => `${n} ${n === 1 ? "change" : "changes"} in your doc`,
      nothing: "Nothing left to choose",
      searching: "Finding a source that backs it…", working: "Working it out…", waiting: "Waiting its turn…",
      applying: "Putting it in…", applied: "In your doc", skipped: "Skipped",
      couldNot: (n, why) => `${n} couldn't be prepared (${why}) — ${n === 1 ? "its card is" : "their cards are"} still there`,
      left: (n) => `${n} more ${n === 1 ? "needs" : "need"} you — open ${n === 1 ? "its card" : "their cards"}`,
    };
    const FIX_ACT = { fix: "Fix", cite: "Cite", name: "Name the source", delete: "Delete", list: "Add the list" };
    const tcSleep = (ms) => new Promise((r) => setTimeout(r, ms));
    function walkInputs() {
      const flags = currentIssues().map(({ seg, f }) => ({
        key: seg.hash, start: seg.start, verdict: f.verdict,
        revision: Boolean(f.revision) && f.verdict !== "needs_citation", citedHere: Boolean(flaggedCitationOf(f.verdict, seg.text)),
      }));
      const notes = [...tipMarkById.values()].map((tip) => ({
        key: tip.id, kind: tip.kind, start: Math.max(0, docText.indexOf(tip.quote)),
        deletes: canDeleteTip(tip), claim: tip.kind === "vague" && claimSentenceIndex(tip.kind, tip.quote, segments) >= 0,
      }));
      // No underline to hang it on: the missing list sits after everything else.
      const nolist = FEATURES.refList && genreWantsList(docGenre) ? allTips().find((t) => t.kind === "nolist") : null;
      if (nolist) notes.push({ key: nolist.id, kind: "nolist", start: docText.length });
      return walkPlan(flags, notes);
    }
    const walkOffered = () => Boolean(FEATURES.typePreview && previewDocEdit && canEditDoc() && !(harness && harness.typePreview !== true) && walkInputs().items.length);

    // The sentence a citation goes on: the flag's own, or the one an unnamed source is in.
    function fixClaimOf(item) {
      if (item.act === "cite") return segments.some((s) => s.hash === item.key) ? item.key : null;
      const tip = tipById(item.key);
      const i = tip ? claimSentenceIndex(tip.kind, tip.quote, segments) : -1;
      return i >= 0 ? segments[i].hash : null;
    }
    // The card's own function for this change; the key prefix runDocEdit will see.
    function fixMake(item) {
      if (item.act === "fix") return docFix(item.key);
      if (item.act === "list") return docAddWorksCited(item.key);
      if (item.act === "delete") return docDeleteTip(item.key);
      return docCite(item.claim, item.srcIndex, null, replaceFor(item.claim));
    }
    const fixPrefix = (item) => (item.act === "fix" ? `fix:${item.key}` : item.act === "delete" ? `del:${item.key}` : item.act === "list" ? `list:${item.key}` : `cite:${item.claim}:`);
    // The change, recorded and not sent: { key, job }, or null when there is none to make.
    function fixCollect(item) {
      const run = async () => {
        while (docBusy) await tcSleep(200); // a card's own edit (and its preview) goes first
        let got = null;
        editGate.collect = { prefix: fixPrefix(item), take: (key, job) => { got ??= { key, job }; } };
        try { await fixMake(item); } catch { got = null; } finally { editGate.collect = null; }
        return got;
      };
      const p = fixQueue.then(run, run);
      fixQueue = p.catch(() => null);
      return p;
    }
    // One batch search, paced; resolves once the claim has an answer (or has none to give).
    async function fixSearch(hash, b) {
      for (let tries = 0; tries < 2; tries++) {
        for (;;) {
          if (fixBatch !== b || b.stopped) return;
          fixSearchStarts = fixSearchStarts.filter((t) => Date.now() - t < 60_000);
          if (fixSearchesRunning < FIX_SEARCHES && fixSearchStarts.length < FIX_SEARCHES_PER_MIN) break;
          await tcSleep(500);
        }
        fixSearchesRunning++;
        fixSearchStarts.push(Date.now());
        try {
          await fetchSources(hash, true, { batch: true });
          const t0 = Date.now(); // a search the writer started on its card: wait for that one
          while (sourcesMap.get(hash)?.loading && Date.now() - t0 < 90_000) await tcSleep(300);
        } finally {
          fixSearchesRunning--;
        }
        if (sourcesMap.get(hash)?.list) return;
      }
    }
    function fixSettle(item, status, why = "") {
      item.status = status;
      item.why = why;
      if (status === "ready" && !item.dropped) fixTourPush(item);
      render();
    }
    async function prepareFix(item, b) {
      if (item.act === "list") {
        fixSettle(item, "searching");
        await buildWorksCited(item.key); // the lookups first, outside the queue: the edit itself is then quick to plan
        if (fixBatch !== b || b.stopped) return;
      }
      if (item.act === "cite" || item.act === "name") {
        item.claim = fixClaimOf(item);
        if (!item.claim) return fixSettle(item, "none", "the sentence changed");
        if (!sourcesMap.get(item.claim)?.list) {
          fixSettle(item, "searching");
          await fixSearch(item.claim, b);
          if (fixBatch !== b || b.stopped) return;
        }
        const st = sourcesMap.get(item.claim);
        if (!st?.list) return fixSettle(item, "none", "the search didn't answer");
        const top = walkSource(st.list, cache.get(item.claim)?.verdict);
        if (!top) return fixSettle(item, "none", "no source backs it");
        item.srcIndex = st.list.indexOf(top);
        item.src = top;
      }
      fixSettle(item, "working");
      const got = await fixCollect(item);
      if (fixBatch !== b || b.stopped) return;
      if (!got) return fixSettle(item, "none", item.src ? "already cited, or the sentence changed" : "the sentence changed");
      item.editKey = got.key;
      item.job = got.job;
      fixSettle(item, "ready");
    }
    function prepareFixes() {
      if (fixBatch?.preparing || fixBatch?.applying || docBusy || !walkOffered()) return;
      const plan = walkInputs();
      const b = { items: plan.items.map((it) => ({ ...it, status: "waiting", why: "", dropped: false })), left: plan.left, preparing: true, stopped: false, applying: false };
      fixBatch = b;
      fixTour = { queue: [], running: false };
      expanded = false; // the panel gets out of the way: the suggestions go in the doc
      render();
      Promise.allSettled(b.items.map((it) => prepareFix(it, b).catch((err) => {
        console.debug(`[tracely] fix-all: ${err?.message ?? err}`);
        fixSettle(it, "none", "something went wrong");
      }))).then(() => {
        if (fixBatch !== b) return;
        b.preparing = false;
        if (!fixTour?.running) tcCursorHide();
        render();
      });
    }
    function stopFixes() {
      const b = fixBatch;
      if (!b) return;
      b.stopped = true; // searches already running finish into the cache; nothing more is prepared
      b.preparing = false;
      for (const it of b.items) if (["waiting", "searching", "working"].includes(it.status)) { it.status = "none"; it.why = "stopped"; }
      render();
    }
    function closeFixes() {
      if (fixBatch?.applying) return;
      if (fixBatch) fixBatch.stopped = true;
      fixBatch = null;
      fixTour = null;
      tcCursorHide();
      render();
    }
    function rejectAllFixes() {
      for (const it of fixBatch?.items ?? []) if (it.status === "ready") { it.status = "skipped"; it.why = ""; }
      render();
    }
    function skipFix(i) {
      const it = fixBatch?.items[i];
      if (it?.status === "ready") fixSettle(it, "skipped");
    }
    // Made by its card's own function, planned against the doc as it is now; no second preview.
    async function acceptFix(i) {
      const b = fixBatch;
      const it = b?.items[i];
      if (!it || it.status !== "ready" || docBusy) return false;
      fixSettle(it, "applying");
      editGate.approved.add(it.editKey);
      let ok = false;
      try { ok = Boolean(await fixMake(it)); } catch { ok = false; } finally { editGate.approved.delete(it.editKey); }
      if (fixBatch !== b) return ok;
      fixSettle(it, ok ? "applied" : "failed", ok ? "" : docEditState.get(it.editKey)?.note || "the doc changed — use its card");
      return ok;
    }
    // After a change goes in, the next waits for the doc's export to show it (it lags a little).
    async function fixFreshRead(before) {
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        await tcSleep(600);
        if (inflight) continue;
        await cycle();
        if (docText !== before) return true;
      }
      return false;
    }
    async function acceptAllFixes() {
      const b = fixBatch;
      if (!b || b.applying) return;
      b.applying = true;
      render();
      try {
        for (let i = 0; i < b.items.length; i++) {
          if (fixBatch !== b) break;
          if (b.items[i].status !== "ready") continue;
          const before = docText;
          if (await acceptFix(i)) await fixFreshRead(before);
        }
      } finally {
        b.applying = false;
        render();
      }
    }
    // What a prepared change does, in the writer's words: the sentence before → after, and any line it adds.
    function fixChangeHtml(job) {
      const plan = previewPlan(job);
      const e = plan.edits[0];
      let html = "";
      if (e) {
        const d = previewDiff(e.find, e.next);
        html += `<div class="fx-diff">${esc(tpClip(d.keepBefore, 70, true))}${d.removed.trim() ? `<del>${esc(d.removed)}</del>` : ""}${d.inserted.trim() ? `<ins>${esc(d.inserted)}</ins>` : ""}${esc(tpClip(d.keepAfter, 50, false))}</div>`;
      }
      for (const l of plan.lines) html += `<div class="fx-line"><span aria-hidden="true">+</span> ${esc(tpClip(l.line, 120, false))}</div>`;
      return html;
    }
    function fixRowHtml(it, i) {
      const flag = it.verdict ? VERDICT_LABEL[it.verdict] : TIP_LABEL[it.kind] ?? "Note";
      const dot = it.verdict ? `d-${it.verdict === "false" ? "false" : it.verdict === "questionable" ? "quest" : it.verdict === "needs_citation" ? "cite" : "inco"}` : tipDot({ kind: it.kind });
      const state = { waiting: FIX_COPY.waiting, searching: it.act === "list" ? "Looking up the cited works…" : FIX_COPY.searching, working: FIX_COPY.working, applying: FIX_COPY.applying, applied: FIX_COPY.applied, skipped: FIX_COPY.skipped, failed: it.why }[it.status] ?? "";
      const busy = ["waiting", "searching", "working", "applying"].includes(it.status);
      const src = it.src ? `<div class="fx-src">${faviconUrl(it.src.url) ? `<img src="${esc(faviconUrl(it.src.url))}" alt="" referrerpolicy="no-referrer" />` : ""}<span>${esc(it.src.title)}</span></div>` : "";
      return `
        <div class="fx fx-${it.status}" data-fx-row="${i}">
          <div class="fx-top">${dot ? `<span class="dot ${dot}"></span>` : ""}<span class="fx-title">${esc(FIX_ACT[it.act])} · ${esc(flag)}</span></div>
          ${it.job && it.status !== "failed" ? fixChangeHtml(it.job) : ""}
          ${src}
          ${it.status === "ready" ? `<div class="row"><button class="act primary" data-fx-accept="${i}"${docBusy || fixBatch?.applying ? " disabled" : ""}>${FIX_COPY.accept}</button><button class="act" data-fx-skip="${i}">${FIX_COPY.skip}</button></div>`
            : state ? `<div class="fx-state">${busy ? `<span class="deep-spin"></span>` : ""}${esc(state)}</div>` : ""}
        </div>`;
    }
    /* ── the suggestions, in the doc ──────────────────────────────────────
       Owner, 2026-10-09: "the let tracely fix these it should go do all of
       them and then disappear and just leave the accept reject multiple
       times instead of waiting after each turn". So the press closes the
       panel, and as each change is ready Tracely's cursor goes to its
       underline (when it is on screen — the doc is never scrolled for it),
       and leaves a suggestion there, in the page's right margin the way
       Docs' own suggestions sit: what changes, its source, ✓ Accept and
       ✕ Reject. The cursor goes when the last one is down; the suggestions
       stay, stacked beside their lines and following the scroll, until the
       writer answers each — or all, from the note above the launcher. Accept
       is acceptFix, the panel list's own (it lists the same changes). */
    const FIX_CARD_W = 248;
    let fixTour = null;       // { queue, running }: the cursor's visits, in the order the changes got ready
    let fixCardsEl = null;    // the layer the suggestions sit in (page DOM, like the hover card)
    let fixCardsRaf = 0;
    function fixBarFor(key) {
      let best = null, top = Infinity;
      for (const b of docsBars) {
        if (b.hash !== key || !b.el?.isConnected || b.el.style.display === "none" || b.el.style.opacity === "0") continue;
        const t = b.el.getBoundingClientRect().top;
        if (t < top) { top = t; best = b; }
      }
      return best;
    }
    function fixTourPush(item) {
      if (!fixTour) { item.dropped = true; return; }
      fixTour.queue.push(item);
      if (!fixTour.running) runFixTour(fixTour);
    }
    async function fixGlide(x, y) {
      const c = tcCursor();
      const x0 = c.x < 0 ? innerWidth - 60 : c.x, y0 = c.y < 0 ? innerHeight - 60 : c.y; // from the launcher the first time
      if (reducedMotion()) { tcCursorAt(x, y); return; }
      const steps = Math.round(tpClamp(Math.hypot(x - x0, y - y0) / 40, 6, 16));
      for (let k = 1; k <= steps; k++) {
        const e = tpEase(k / steps);
        tcCursorAt(x0 + (x - x0) * e, y0 + (y - y0) * e);
        await tcSleep(18);
      }
    }
    async function runFixTour(t) {
      t.running = true;
      try {
        while (t.queue.length && fixTour === t) {
          const it = t.queue.shift();
          if (it.status !== "ready" || it.dropped) continue;
          const bar = fixBarFor(it.key);
          const r = bar?.el.getBoundingClientRect();
          const seen = Boolean(r && r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && !document.hidden);
          if (seen) {
            await fixGlide(r.left + Math.min(r.width / 2, 30), r.top - (bar.size || 14) * 0.45);
            for (let k = 1; k <= 4; k++) { tcCursorPress(k / 4); await tcSleep(30); } // the click that leaves it
          }
          it.dropped = true;
          paintFixCards();
          if (seen) await tcSleep(140);
        }
      } finally {
        t.running = false;
        if (fixTour === t && !fixBatch?.preparing) tcCursorHide();
      }
    }
    // One suggestion: the change in the writer's words, and its two answers.
    function fixCardEl(it, i) {
      const color = it.verdict ? MARK_COLORS[it.verdict] : MARK_COLORS[CITE_TIP_KINDS.includes(it.kind) ? "cite_tip" : "note_tip"];
      const flag = it.verdict ? VERDICT_LABEL[it.verdict] : TIP_LABEL[it.kind] ?? "Note";
      const card = el("div", {
        position: "absolute", left: "0", top: "0", width: `${FIX_CARD_W}px`, boxSizing: "border-box", padding: "10px 12px 12px",
        background: "#fff", border: `1.5px solid ${DM.ink}`, borderRadius: "12px", boxShadow: "0 6px 18px rgba(0,0,0,.14)",
        pointerEvents: "auto", display: "flex", flexDirection: "column", gap: "6px", fontFamily: APP.font, color: DM.ink,
        fontSize: "12.5px", lineHeight: "1.45", visibility: "hidden", WebkitFontSmoothing: "antialiased",
      });
      card.setAttribute("data-tracely-fix-card", "");
      card.dataset.key = it.key;
      if (it.act === "list") card.dataset.loose = "1";
      const top = el("div", { display: "flex", alignItems: "center", gap: "7px", fontWeight: "600", fontSize: "12px" });
      top.append(el("span", { width: "8px", height: "8px", borderRadius: "50%", background: color, flex: "0 0 auto" }), el("span", {}, `${FIX_ACT[it.act]} · ${flag}`));
      card.appendChild(top);
      const plan = it.job ? previewPlan(it.job) : { edits: [], lines: [] };
      const e = plan.edits[0];
      if (e) {
        const d = previewDiff(e.find, e.next);
        const diff = el("div", { color: DM.body });
        diff.append(document.createTextNode(tpClip(d.keepBefore, 46, true)));
        if (d.removed.trim()) diff.appendChild(el("span", { textDecoration: "line-through", color: "#8a8b90" }, d.removed));
        if (d.inserted.trim()) diff.appendChild(el("span", { fontWeight: "600", color: DM.ink, background: "#efeff2", borderRadius: "3px", padding: "0 2px" }, d.inserted));
        diff.append(document.createTextNode(tpClip(d.keepAfter, 30, false)));
        card.appendChild(diff);
      }
      for (const l of plan.lines) card.appendChild(el("div", { color: DM.body, fontSize: "11.5px" }, `+ ${tpClip(l.line, 80, false)}`));
      if (it.src) card.appendChild(el("div", { color: DM.body, fontSize: "11.5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, `Source: ${it.src.title}`));
      if (it.status === "ready") {
        const row = el("div", { display: "flex", gap: "6px", marginTop: "2px" });
        const busy = docBusy || Boolean(fixBatch?.applying);
        const yes = dmBtn("✓ Accept", true, { disabled: busy });
        const no = dmBtn("✕ Reject", false, { disabled: busy });
        for (const b of [yes, no]) Object.assign(b.style, { padding: "5px 11px", fontSize: "12px" });
        yes.addEventListener("click", () => acceptFix(i));
        no.addEventListener("click", () => skipFix(i));
        row.append(yes, no);
        card.appendChild(row);
      } else {
        const why = it.status === "applying" ? FIX_COPY.applying : it.why;
        const row = el("div", { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", color: DM.body, fontSize: "12px" }, why);
        if (it.status === "failed") {
          const x = dmBtn("✕", false);
          Object.assign(x.style, { padding: "3px 8px", fontSize: "11px" });
          x.addEventListener("click", () => { it.status = "skipped"; render(); });
          row.appendChild(x);
        }
        card.appendChild(row);
      }
      return card;
    }
    // Built when what they show changes; placed every frame (placeFixCards).
    function paintFixCards() {
      const b = fixBatch;
      const items = b ? b.items.map((it, i) => [it, i]).filter(([it]) => it.dropped && ["ready", "applying", "failed"].includes(it.status)) : [];
      if (!items.length) {
        fixCardsEl?.remove();
        fixCardsEl = null;
        if (fixCardsRaf) { cancelAnimationFrame(fixCardsRaf); fixCardsRaf = 0; }
        return;
      }
      if (!fixCardsEl?.isConnected) {
        fixCardsEl = el("div", { position: "fixed", left: "0", top: "0", width: "0", height: "0", zIndex: "901", pointerEvents: "none" });
        fixCardsEl.setAttribute("data-tracely-fix-cards", "");
        document.documentElement.appendChild(fixCardsEl);
      }
      const sig = items.map(([it, i]) => `${i}:${it.status}:${it.why}`).join("|") + (docBusy || b.applying ? "|busy" : "");
      if (fixCardsEl.dataset.sig !== sig) {
        fixCardsEl.dataset.sig = sig;
        fixCardsEl.textContent = "";
        for (const [it, i] of items) fixCardsEl.appendChild(fixCardEl(it, i));
      }
      if (!fixCardsRaf) fixCardsRaf = requestAnimationFrame(placeFixCards);
    }
    // Beside each line, in the page's right margin; stacked so none covers another; only while its line is in view.
    function placeFixCards() {
      fixCardsRaf = 0;
      if (!fixCardsEl?.isConnected || !fixCardsEl.children.length) return;
      if (!docsScroller || !docsScroller.isConnected) docsScroller = document.querySelector(".kix-appview-editor");
      const clip = docsScroller ? docsScroller.getBoundingClientRect() : { top: 0, bottom: innerHeight };
      const placed = [];
      for (const card of fixCardsEl.children) {
        const bar = fixBarFor(card.dataset.key);
        const r = bar ? bar.el.getBoundingClientRect() : null;
        if (!r && card.dataset.loose) { // the missing Works Cited: at the foot of the margin, where the list will go
          const pg = document.querySelector(".kix-page-paginated")?.getBoundingClientRect();
          placed.push({ card, x: Math.max(8, Math.min((pg ? pg.right : innerWidth - FIX_CARD_W - 40) + 14, innerWidth - FIX_CARD_W - 12)), want: clip.bottom - card.offsetHeight - 16 });
          continue;
        }
        if (!r || r.bottom < clip.top || r.top > clip.bottom) { card.style.visibility = "hidden"; continue; }
        const page = bar.el.closest?.(".kix-page-paginated");
        const right = page ? page.getBoundingClientRect().right : r.right;
        placed.push({ card, x: Math.max(8, Math.min(right + 14, innerWidth - FIX_CARD_W - 12)), want: r.top - 10 });
      }
      placed.sort((a, b) => a.want - b.want);
      let floor = clip.top + 6;
      for (const p of placed) {
        const top = Math.max(p.want, floor);
        const h = p.card.offsetHeight;
        p.card.style.visibility = top + Math.min(h, 60) > clip.bottom ? "hidden" : "visible";
        p.card.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(top)}px)`;
        floor = top + h + 8;
      }
      fixCardsRaf = requestAnimationFrame(placeFixCards);
    }
    // Above the launcher while the panel is closed: how many wait, and the answer to all of them.
    function fixPingHtml() {
      const b = fixBatch;
      if (!b || expanded) return "";
      const ready = b.items.filter((it) => it.status === "ready").length;
      if (!ready && !b.preparing) return "";
      const busy = docBusy || b.applying ? " disabled" : "";
      const text = b.preparing ? `Preparing fixes · ${ready} ready` : `${ready} ${ready === 1 ? "suggestion" : "suggestions"} in your doc`;
      return `<div class="ready-ping fix-ping" role="status"><span class="ready-text">${b.preparing ? `<span class="deep-spin"></span>` : ""}${esc(text)}</span>`
        + `${ready > 1 ? `<button class="act primary" data-fxp-all="1"${busy}>Accept all</button>` : ""}${ready ? `<button class="act" data-fxp-none="1"${busy}>Reject all</button>` : ""}</div>`;
    }
    function walkStripHtml() {
      const b = fixBatch;
      if (!b) {
        if (!walkOffered()) return "";
        return `<div class="walk-strip"><span>${esc(FIX_COPY.offer(walkInputs().items.length))}</span><button class="act primary" data-walk-go="1"${docBusy ? " disabled" : ""}>${FIX_COPY.go}</button></div>`;
      }
      const ready = b.items.filter((it) => it.status === "ready").length;
      const applied = b.items.filter((it) => it.status === "applied").length;
      const none = b.items.filter((it) => it.status === "none");
      const rows = b.items.map((it, i) => (it.status === "none" ? "" : fixRowHtml(it, i))).join("");
      const title = b.preparing ? FIX_COPY.preparing(ready, b.items.length) : ready ? FIX_COPY.ready(ready) : applied ? FIX_COPY.finished(applied) : FIX_COPY.nothing;
      const lead = ready > 1 ? `<button class="act primary" data-fx-all="1"${docBusy || b.applying ? " disabled" : ""}>${FIX_COPY.all(ready)}</button>` : "";
      const end = b.preparing ? `<button class="act" data-walk-stop="1">${FIX_COPY.stop}</button>` : `<button class="act" data-fx-close="1"${b.applying ? " disabled" : ""}>${FIX_COPY.done}</button>`;
      const whys = [...new Set(none.map((it) => it.why).filter(Boolean))].join("; ");
      return `<div class="fixes">
        <div class="fixes-head"><span class="fixes-title">${b.preparing ? `<span class="deep-spin"></span>` : ""}${esc(title)}</span><span class="fixes-acts">${lead}${end}</span></div>
        ${rows}
        ${none.length ? `<div class="fixes-note">${esc(FIX_COPY.couldNot(none.length, whys))}</div>` : ""}
        ${b.left ? `<div class="fixes-note">${esc(FIX_COPY.left(b.left))}</div>` : ""}
      </div>`;
    }

    if (FEATURES.typePreview) {
      previewDocEdit = (key, job) => (harness && harness.typePreview !== true ? Promise.resolve(true) : showTypePreview(key, job));
      window.addEventListener("pointerdown", tpNotePress, true);
      window.addEventListener("keydown", tpNotePress, true);
    }

    // ── widget UI ──
    const { shadow, root } = makeWidget();
    // The plan decides whether "Explain in depth" is offered or locked.
    tierListeners.push(() => render());

    /* The ask. One card, the app's shape, and the one decision it needs. */
    /* Turn off: the same switch the consent card turns on (docsEnabled), so it
       holds for every Doc until the writer turns it back on — from the pill,
       which goes back to "Turn on Tracely for Docs", or from the options
       page. Underlines and any open card go at once, not at the next read. */
    function turnDocsOff() {
      docsOn = false;
      expanded = false;
      storageSet({ docsEnabled: false });
      hideDocsPopover();
      clearDocsMarks();
      render();
    }

    function renderDocsConsent() {
      root.innerHTML = `
        ${expanded ? `
        <div class="panel opening">
          <div class="head"><span class="plane">${PLANE_SVG}</span><span class="name">Tracely</span></div>
          <div class="list">
            <div class="card">
              <div class="top"><span class="dot"></span><span class="ctitle">Check this document with Tracely?</span></div>
              <div class="expl">${esc(DOCS_CONSENT_TEXT)}</div>
              <div class="row">
                <button class="act primary" id="docsOn">Turn on for Google Docs</button>
                <button class="act" id="docsNotNow">Not now</button>
              </div>
            </div>
          </div>
          <div class="foot"><span>Nothing is sent until you turn it on.</span><a href="https://github.com/Tracely-app/Tracely/blob/main/PRIVACY.md" target="_blank" rel="noopener noreferrer" style="color:var(--accent-ink);text-decoration:none">Privacy</a></div>
        </div>` : ""}
        <div class="pill quiet" id="pill" title="${esc(DOCS_CONSENT_TEXT)}"><span class="plane">${PLANE_SVG}</span>Turn on Tracely for Docs</div>`;
      shadow.getElementById("pill").addEventListener("click", () => { expanded = !expanded; render(); });
      shadow.getElementById("docsOn")?.addEventListener("click", () => {
        expanded = false;
        storageSet({ docsEnabled: true }); // the storage change turns it on and starts the first check
      });
      shadow.getElementById("docsNotNow")?.addEventListener("click", () => { expanded = false; render(); });
    }

    function render() {
      if (orphaned) { root.innerHTML = orphanPillHtml(); return; }
      if (!docsOn) { renderDocsConsent(); return; }
      const issues = currentIssues();
      const offTopic = FEATURES.offTopic && isArgumentGenre(docGenre) ? offTopicTips(docText, dismissed) : [];
      const refTips = FEATURES.refList && isArgumentGenre(docGenre) ? referenceTips(docText, dismissed, docGenre, settings.citationStyle) : [];
      const essayNotes = FEATURES.essayFeedback && isArgumentGenre(docGenre) && review.kind === "essay" ? essayFeedbackTips(docText, review.findings, dismissed) : [];
      const citeTips = FEATURES.quoteTips && isArgumentGenre(docGenre) ? citationTips(docText, settings.citationStyle, dismissed, docGenre) : [];
      const resumeList = FEATURES.resumeTips && docGenre === "resume" ? resumeTips(docText, review.findings, dismissed) : [];
      // A stray line counts on the launcher too: a ✓ over it would say all is well.
      const flagged = issues.length + offTopic.length + refTips.length + essayNotes.length + citeTips.length;
      const tally = tallyOf(issues.map(({ f }) => f.verdict), [...citeTips, ...refTips, ...essayNotes, ...offTopic, ...resumeList]);
      const countCls = statusKind === "offline" || statusKind === "error" || inflight ? "off" : flagged > 0 ? "" : "ok";
      const countTxt = statusKind === "offline" ? "off" : inflight ? "…" : flagged > 0 ? String(flagged) : "✓";

      const panelOpening = expanded && !panelWasOpen;
      panelWasOpen = expanded;
      let panelHtml = "";
      let cardSources = null; // the panel's sourcesFor, for decorateCard once the HTML is in
      if (expanded) {
        undoShown = false;
        /* Flow issues live in the PANEL, not only in the document. The
           in-document bracket is off by default (FLOW_IN_DOC) after repeated
           mis-positioning, so this is where the feature actually reads — and
           it needs no position to be useful. */
        const flowCards = activeFlowIssues().map((fi) => {
          const h = flowHashOf(fi);
          const flowBtn = canEditDoc()
            ? editBtnHtml(`flow:${h}`, "Add transition", `data-flow-go="${esc(h)}"`)
            : `<button class="act primary" data-flow-go="${esc(h)}">Copy transition</button>`;
          return `
            <div class="card">
              <div class="top"><span class="dot d-flow"></span><span class="ctitle">Flow issue</span><button class="x" data-flow-x="${esc(h)}">✕</button></div>
              <div class="quote">${esc(fi.passage.slice(0, 160))}</div>
              <div class="fix">
                <div class="fix-label">Why it jumps</div>
                <div class="fix-text">${esc(fi.explanation)}</div>
                ${fi.transition ? `<div class="fix-label" style="margin-top:8px">Suggested bridge</div><div class="fix-text">${esc(fi.transition)}</div>` : ""}
                ${fi.transition ? `<div class="row">${flowBtn}</div>${editNoteHtml(`flow:${h}`)}` : ""}
              </div>
            </div>`;
        }).join("");

        const sourcesFor = (seg) => {
          const st = sourcesMap.get(seg.hash);
          let sourcesHtml = "";
          if (st?.loading) {
            sourcesHtml = `<div class="sources">${liveSourcesHtml(st.live)}</div>`;
          } else if ((st?.unbacked || st?.unread?.length) && !st.list?.length) {
            sourcesHtml = `<div class="sources"><div class="loading">${esc(st.unbacked ? UNBACKED_NOTE(st.unbacked) : RECEIPT_COPY.unreadOnly(st.unread.length))}</div>${unreadSourcesHtml(seg.hash, st.unread, st.unreadOpen)}</div>`;
          } else if (st?.list?.length) {
            sourcesHtml = `<div class="sources"><div class="sources-title">Sources — pick one to cite</div>` +
              st.list.map((src, i) => `
                <div class="src">
                  <span class="src-ico">${faviconUrl(src.url) ? `<img src="${esc(faviconUrl(src.url))}" alt="" referrerpolicy="no-referrer" />` : ""}</span>
                  <span class="stance st-${esc(src.stance)}">${esc(src.stance)}</span>
                  <div class="src-body">
                    <a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.title)}</a>
                    <div class="src-meta">${esc(src.publisher)}</div>
                    ${sourceSaysHtml(src)}
                    <div class="src-actions">
                      ${canEditDoc() ? editBtnHtml(`cite:${seg.hash}:${src.url}`, st.citedUrl === src.url ? "Cited ✓" : replaceFor(seg.hash) ? CITED_COPY.replace : nameTheSource(seg.text, src, settings.citationStyle || "mla") ? POP_COPY.name : "Cite in doc", `data-doc-cite="${seg.hash}" data-i="${i}"`) : ""}
                      <button class="act" data-copy-src="${seg.hash}" data-i="${i}">${st.copiedUrl === src.url ? "Copied ✓" : "Copy cite"}</button>
                    </div>
                    ${editNoteHtml(`cite:${seg.hash}:${src.url}`)}
                  </div>
                </div>`).join("") + unreadSourcesHtml(seg.hash, st.unread, st.unreadOpen) + `</div>`;
          }
          return sourcesHtml;
        };
        cardSources = sourcesFor;
        const cards = issues.map(({ seg, f }) => {
          const kind = f.verdict === "false" ? "false" : f.verdict === "questionable" ? "quest" : f.verdict === "needs_citation" ? "cite" : "inco";
          const sourcesHtml = sourcesFor(seg);
          return { hash: seg.hash, html: `
          <div class="card" data-card="${seg.hash}" data-cat="${verdictCat(f.verdict)}">
            <div class="top">
              <span class="dot d-${kind}"></span><span class="ctitle">${VERDICT_LABEL[f.verdict]}</span>
              <button class="x" data-dismiss="${seg.hash}" title="Dismiss">✕</button>
            </div>
            <div class="quote">“${esc(seg.text.length > 140 ? seg.text.slice(0, 139) + "…" : seg.text)}”</div>
            ${f.explanation ? `<div class="expl">${esc(f.explanation)}</div>` : ""}
            ${deepHtml(seg.hash, f.verdict, (h) => (canEditDoc() ? editBtnHtml(`deepfix:${h}`, "Fix in doc", `data-deep-fix="${h}"`) + editNoteHtml(`deepfix:${h}`) : ""))}
            ${f.revision ? `
            <div class="fix">
              <div class="fix-label">Suggested revision</div>
              <div class="fix-text">${esc(f.revision)}</div>
              <div class="row">
                ${canEditDoc() ? editBtnHtml(`fix:${seg.hash}`, "Fix in doc", `data-doc-fix="${seg.hash}"`) : ""}
                <button class="act${canEditDoc() ? "" : " primary"}" data-copy-fix="${seg.hash}">${copiedFixHash === seg.hash ? "Copied ✓" : "Copy fix"}</button>
                <button class="act" data-sources="${seg.hash}">Find sources</button>
              </div>
              ${editNoteHtml(`fix:${seg.hash}`)}
            </div>` : `<div class="row"><button class="act" data-sources="${seg.hash}">Find sources</button></div>`}
            ${sourcesHtml}
            <div class="cite-url"><input type="url" placeholder="Or paste a URL you found…" data-url-input="${seg.hash}" /><button class="act" data-url-add="${seg.hash}"${docBusy ? " disabled" : ""}>Cite</button></div>
          </div>` };
        });
        const cardsHtml = cards.length ? cardListHtml(cards) + legendHtml() : "";
        const genreHtml = FEATURES.resumeTips || FEATURES.quoteTips ? genreLineHtml(docGenre, docText, settings.citationStyle) : "";
        /* The list, most serious first (owner, 2026-10-08: "make this more
           organized … restructure it"): the claims, then the citations (the
           citation notes and the reference list's), then the writing (the
           review's notes and the stray lines), then evidence you could add —
           one card open at a time (foldCards). */
        const claimsHtml = cardsHtml ? groupHtml("Claims", cards.length, cardsHtml) : "";
        const tipsHtml = (FEATURES.resumeTips && docGenre === "resume" ? resumeTipsHtml(resumeList, review.inflight, copiedTipId)
          : (FEATURES.offTopic || FEATURES.refList || FEATURES.quoteTips || FEATURES.essayFeedback) && isArgumentGenre(docGenre)
            ? citationTipsHtml([...citeTips, ...refTips], copiedTipId) + essayFeedbackHtml([...essayNotes, ...offTopic], review.inflight && review.kind === "essay", copiedTipId, review.kind === "essay" ? resolvedNotes(review.seen, essayNotes, docText) : [])
            : "");
        const evidenceHtml = FEATURES.evidenceHints && genreWantsList(docGenre)
          ? evidenceSectionHtml(evidenceCandidates(segments, cache, dismissed), showEvidence, sourcesFor, (seg) => sourcesMap.has(seg.hash))
          : "";

        // The last edit's Undo outlives its card: a fixed sentence's card goes
        // as soon as the sentence is re-read, so the Undo moves up here.
        const undoStrip = lastDocEdit && !undoShown
          ? `<div class="undo-strip"><span>${esc(lastDocEdit.label.charAt(0).toUpperCase() + lastDocEdit.label.slice(1))}</span><button class="act" data-doc-undo="1"${docBusy ? " disabled" : ""}>Undo</button></div>`
          : "";
        panelHtml = `
        <div class="panel${panelOpening ? " opening" : ""}">
          ${panelHeadHtml(tally, statusMsg, statusKind === "error" || statusKind === "offline")}
          <div class="list">
            ${undoStrip}${typeof walkStripHtml === "function" ? walkStripHtml() : "" /* (absent from server/test's slices of render) */}${genreHtml}${claimsHtml}${tipsHtml}${flowCards}${claimsHtml || flowCards || tipsHtml || GENRE_QUIET.has(docGenre) ? "" : `<div class="empty">${statusKind === "offline" ? "Start the Tracely server, then reopen this doc." : "Nothing flagged. Keep writing — sentences are checked as you finish them."}</div>`}${evidenceHtml}
          </div>
          <div class="foot">
            <span class="foot-left">
              <label class="autosrc" title="Underline sentences that are accurate but would benefit from a citation. Off: only false, unverifiable or incoherent sentences are marked."><input type="checkbox" id="citeTgl"${settings.citeHints !== false ? " checked" : ""} /><span>Citation suggestions</span></label>
              <label class="autosrc" title="Automatically look up sources for flagged claims (capped)"><input type="checkbox" id="autoSrcTgl"${settings.autoSources === true ? " checked" : ""} /><span>Auto-src</span></label>
            </span>
            <button class="act" id="turnOff" title="Stop checking Google Docs. Turn it back on from Tracely's button or its options.">Turn off</button>
          </div>
        </div>`;
      }

      const prevScroll = shadow.querySelector(".list")?.scrollTop ?? 0;
      // A page number being typed keeps its box and caret through the re-render.
      const typing = shadow.activeElement?.dataset?.pageInput ?? null;
      const caret = typing ? shadow.activeElement.selectionStart : null;
      root.innerHTML = `
        ${panelHtml}
        ${readyPingHtml()}${typeof fixPingHtml === "function" ? fixPingHtml() : "" /* (absent from server/test's slices of render) */}
        ${launcherHtml(countCls, countTxt, issues.length ? `Tracely — ${issues.length} flagged` : "Tracely")}
      `;
      // "Find the cited work" and a note's "Find a source", added to the cards now they exist.
      if (cardSources) {
        for (const card of shadow.querySelectorAll(".card[data-card]")) decorateCard(card, cardSources);
        if (undoShown) shadow.querySelector(".undo-strip")?.remove(); // a card carries the Undo now
        foldCards(shadow, render);
      }
      if (typing) {
        const box = [...shadow.querySelectorAll("[data-page-input]")].find((i) => i.dataset.pageInput === typing);
        if (box) { box.focus(); try { box.setSelectionRange(caret, caret); } catch { /* not a text box */ } }
      }
      const listEl = shadow.querySelector(".list");
      if (listEl) listEl.scrollTop = prevScroll;

      shadow.getElementById("pill").addEventListener("click", () => { expanded = !expanded; render(); });
      wireChrome(shadow, () => { expanded = false; render(); }, render);
      // The notes above the launcher show while the panel is CLOSED, so they are
      // wired here, not with the panel: the live search's "Sources ready"
      // (noteSourcesReady) and Let Tracely fix these's suggestions (fixPingHtml).
      shadow.querySelector("[data-ready-show]")?.addEventListener("click", () => { const p = readyPing; readyPing = null; if (p) showSourcesFor(p.hash); });
      shadow.querySelector("[data-ready-x]")?.addEventListener("click", () => { readyPing = null; render(); });
      shadow.querySelector("[data-fxp-all]")?.addEventListener("click", () => acceptAllFixes());
      shadow.querySelector("[data-fxp-none]")?.addEventListener("click", () => rejectAllFixes());
      if (typeof paintFixCards === "function") paintFixCards(); // the suggestions in the doc follow every change of state
      if (expanded) {
        shadow.getElementById("turnOff").addEventListener("click", turnDocsOff);
        // "Let Tracely fix these" (the Type preview block): start, and Stop.
        shadow.querySelector("[data-walk-go]")?.addEventListener("click", () => prepareFixes());
        shadow.querySelector("[data-walk-stop]")?.addEventListener("click", () => stopFixes());
        shadow.querySelector("[data-fx-all]")?.addEventListener("click", () => acceptAllFixes());
        shadow.querySelector("[data-fx-close]")?.addEventListener("click", () => closeFixes());
        for (const b of shadow.querySelectorAll("[data-fx-accept]")) b.addEventListener("click", () => acceptFix(Number(b.dataset.fxAccept)));
        for (const b of shadow.querySelectorAll("[data-fx-skip]")) b.addEventListener("click", () => skipFix(Number(b.dataset.fxSkip)));
        wireDeep(shadow, explainSentence, render);
        shadow.getElementById("evidenceToggle")?.addEventListener("click", () => { showEvidence = !showEvidence; render(); });
        for (const btn of shadow.querySelectorAll("[data-tip-x]")) {
          btn.addEventListener("click", () => { dismissed.add(btn.dataset.tipX); lsSet(DISMISS_KEY, JSON.stringify([...dismissed])); render(); requestDocsMarks(); });
        }
        for (const btn of shadow.querySelectorAll("[data-tip-copy]")) {
          btn.addEventListener("click", () => {
            const tip = [...resumeTips(docText, review.findings, dismissed), ...essayFeedbackTips(docText, review.findings, dismissed)].find((t) => t.id === btn.dataset.tipCopy);
            if (!tip?.suggestion) return;
            navigator.clipboard?.writeText(tip.suggestion).catch(() => { /* denied */ });
            copiedTipId = tip.id;
            render();
          });
        }
        for (const btn of shadow.querySelectorAll("[data-dismiss]")) {
          btn.addEventListener("click", () => {
            dismissed.add(btn.dataset.dismiss);
            lsSet(DISMISS_KEY, JSON.stringify([...dismissed]));
            render();
          });
        }
        // A note's own fix (decorateCard): Delete, Rewrite in doc, the page box.
        for (const btn of shadow.querySelectorAll("[data-tip-del]")) btn.addEventListener("click", () => armOrDelete(btn.dataset.tipDel));
        for (const btn of shadow.querySelectorAll("[data-tip-list]")) btn.addEventListener("click", () => docAddWorksCited(btn.dataset.tipList));
        for (const btn of shadow.querySelectorAll("[data-tip-rewrite]")) btn.addEventListener("click", () => docRewriteTip(btn.dataset.tipRewrite));
        for (const input of shadow.querySelectorAll("[data-page-input]")) {
          input.addEventListener("input", () => pageDrafts.set(input.dataset.pageInput, input.value));
          // Typed into the box, never into the Doc behind it.
          input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter" && PAGE_INPUT.test(input.value.trim())) docAddPage(input.dataset.pageInput, input.value.trim());
          });
        }
        for (const btn of shadow.querySelectorAll("[data-tip-page]")) {
          btn.addEventListener("click", () => {
            const box = [...shadow.querySelectorAll("[data-page-input]")].find((i) => i.dataset.pageInput === btn.dataset.tipPage);
            const v = box?.value.trim() ?? "";
            if (PAGE_INPUT.test(v)) docAddPage(btn.dataset.tipPage, v);
            else box?.focus();
          });
        }
        for (const btn of shadow.querySelectorAll("[data-copy-fix]")) {
          btn.addEventListener("click", () => {
            const f = cache.get(btn.dataset.copyFix);
            if (f?.revision) { copiedFixHash = btn.dataset.copyFix; copyText(f.revision); }
          });
        }
        for (const btn of shadow.querySelectorAll("[data-sources]")) {
          btn.addEventListener("pointerdown", () => { fetchSources(btn.dataset.sources).catch(() => {}); });
          btn.addEventListener("click", () => fetchSources(btn.dataset.sources));
        }
        for (const btn of shadow.querySelectorAll("[data-flow-go]")) {
          btn.addEventListener("click", async () => {
            const fi = activeFlowIssues().find((x) => flowHashOf(x) === btn.dataset.flowGo);
            if (!fi) return;
            if (!canEditDoc()) {
              try { await navigator.clipboard.writeText(fi.transition); } catch { /* denied */ }
              btn.textContent = "Copied \u2713";
              return;
            }
            await addTransition(btn.dataset.flowGo, fi);
          });
        }
        for (const btn of shadow.querySelectorAll("[data-flow-x]")) {
          btn.addEventListener("click", () => {
            flowDismissed.add(btn.dataset.flowX);
            persistFlow();
            requestDocsMarks();
            render();
          });
        }
        for (const btn of shadow.querySelectorAll("[data-copy-src]")) {
          btn.addEventListener("click", () => {
            const st = sourcesMap.get(btn.dataset.copySrc);
            const src = st?.list?.[Number(btn.dataset.i)];
            if (src) copyText(formatCitation(src, settings.citationStyle || "mla").ref, btn.dataset.copySrc, src.url);
          });
        }
        // "Couldn't read these" opens and closes; the state lives in the entry (unreadSourcesHtml).
        for (const btn of shadow.querySelectorAll("[data-unread-toggle]")) {
          btn.addEventListener("click", () => {
            const st = sourcesMap.get(btn.dataset.unreadToggle);
            if (st) { st.unreadOpen = !st.unreadOpen; render(); }
          });
        }
        for (const btn of shadow.querySelectorAll("[data-doc-fix]")) {
          btn.addEventListener("click", () => docFix(btn.dataset.docFix));
        }
        // "Explain in depth"'s own revision, applied like the card's.
        for (const btn of shadow.querySelectorAll("[data-deep-fix]")) {
          btn.addEventListener("click", () => docFix(btn.dataset.deepFix, null, deepRevision(btn.dataset.deepFix)));
        }
        for (const btn of shadow.querySelectorAll("[data-doc-cite]")) {
          btn.addEventListener("click", () => docCite(btn.dataset.docCite, btn.dataset.i, null, replaceFor(btn.dataset.docCite)));
        }
        // "Find the cited work" and what it offers (decorateCard).
        for (const btn of shadow.querySelectorAll("[data-cited]")) btn.addEventListener("click", () => findCitedWork(btn.dataset.cited));
        for (const btn of shadow.querySelectorAll("[data-claim-src]")) {
          btn.addEventListener("pointerdown", () => prestartClaim(btn.dataset.claimSrc));
          btn.addEventListener("click", () => findClaimSource(btn.dataset.claimSrc));
        }
        for (const btn of shadow.querySelectorAll("[data-cited-more]")) {
          btn.addEventListener("click", () => {
            const t = citedMap.get(btn.dataset.citedMore)?.target;
            if (t?.segHash) startClaimSources(btn.dataset.citedMore, t.segHash, t.sentence);
          });
        }
        for (const btn of shadow.querySelectorAll("[data-cited-copy]")) btn.addEventListener("click", () => copyCitedReference(btn.dataset.citedCopy, btn.dataset.i));
        for (const btn of shadow.querySelectorAll("[data-cited-replace]")) btn.addEventListener("click", () => docReplaceCitation(btn.dataset.citedReplace, btn.dataset.i));
        for (const btn of shadow.querySelectorAll("[data-cited-entry]")) btn.addEventListener("click", () => docCompleteEntry(btn.dataset.citedEntry, btn.dataset.i));
        for (const btn of shadow.querySelectorAll("[data-doc-undo]")) {
          btn.addEventListener("click", () => undoLastDocEdit());
        }
        shadow.getElementById("autoSrcTgl")?.addEventListener("change", (e) => {
          settings.autoSources = e.target.checked;
          saveSettings();
        });
        shadow.getElementById("citeTgl")?.addEventListener("change", (e) => {
          settings.citeHints = e.target.checked;
          saveSettings();
          if (typeof requestDocsMarks === "function") requestDocsMarks(); // the underlines follow the switch
          if (typeof scheduleMarks === "function") scheduleMarks();
          render();
        });
        for (const btn of shadow.querySelectorAll("[data-url-add]")) {
          btn.addEventListener("click", () => {
            const input = shadow.querySelector(`[data-url-input="${btn.dataset.urlAdd}"]`);
            if (input?.value.trim()) citeUrlWidget(btn.dataset.urlAdd, input.value.trim());
          });
        }
        for (const input of shadow.querySelectorAll("[data-url-input]")) {
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && input.value.trim()) citeUrlWidget(input.dataset.urlInput, input.value.trim());
          });
        }
      }
    }

    // "Explain in depth" on one sentence. Repaints the panel, and any open
    // hover card for it IN PLACE (renderPopDeep) — the card is never rebuilt,
    // so it neither re-animates nor loses its position.
    function explainSentence(hash) {
      const seg = segments.find((s) => s.hash === hash);
      const f = cache.get(hash);
      if (!seg || !f) return;
      explainInDepth(hash, seg.text, docText, f.verdict, () => { render(); renderPopDeep(hash); });
    }

    function saveSettings() {
      persistSettings(settings, SETTINGS_KEY);
    }

    // ── loop ──
    /* Typing is what makes the next read due in READ_INTERVAL_MS. Waiting for
       a read to SEE a change meant the first sentence after a pause of over
       ACTIVE_WINDOW_MS waited out the idle 10 s first (measured in the
       harness: sent 11 s after it was typed). Docs routes keystrokes through
       a same-origin iframe (the one docs-hook.js types into), so listen there
       too; it can appear late, hence the re-scan. Nothing is read or sent
       here — this only moves the next export read earlier. */
    const markActive = (e) => { lastTextChangeAt = Date.now(); if (e?.type === "keydown") typingClosesCard(e); };
    document.addEventListener("keydown", markActive, true);
    document.addEventListener("input", markActive, true);
    const watchTypingFrame = () => {
      for (const fr of document.querySelectorAll("iframe.docs-texteventtarget-iframe")) {
        try {
          const d = fr.contentDocument;
          if (d && !d.__tracelyTyping) { d.__tracelyTyping = true; d.addEventListener("keydown", markActive, true); }
        } catch { /* not same-origin after all: the export diff still notices, one read later */ }
      }
    };
    watchTypingFrame();
    setInterval(watchTypingFrame, 5_000);
    setInterval(() => {
      if (orphaned) return;
      if (!inflight && !document.hidden && Date.now() >= exportPausedUntil && Date.now() - lastCheckEnd >= nextReadGap(Date.now(), lastTextChangeAt, lastCheckFailed)) {
        cycle(); // the panel shows no countdown (owner, 2026-10-08: "remove the next check timer thing")
      }
    }, 1000);
    fetchServerStatus();
    setInterval(fetchServerStatus, 30_000);
    // The in-editor engine: pinged at start, every 5s until it answers
    // editable (kix may still be booting), then every 30s, and on focus.
    // Read-only — a ping never edits.
    probeInDoc();
    setInterval(() => { if (!inDoc.editable || Date.now() - lastPingAt >= 30_000) probeInDoc(); }, 5_000);
    window.addEventListener("focus", () => { probeInDoc(); });
    cycle();
  }

  /* ════════════════════════════════════════════════════════════════════════
     FIELD MODE — any other site: ordinary editable fields, in-place fixes.
     Money rule: automatic checking (nextReadGap) runs ONLY when this site is enabled
     ("tracely.site.enabled"). Otherwise nothing is sent until the user clicks.
     ════════════════════════════════════════════════════════════════════════ */
  // TEST ANCHOR (server/test/ext-*) — do not rename or re-indent the next line.
  function fieldMode() {
    const SITE_KEY = "tracely.site.enabled";
    const SETTINGS_KEY = "tracely.widget.settings";
    const DISMISS_KEY = "tracely.widget.dismissed.field"; // localStorage is origin-scoped → per-site
    // Verdicts, so a reload does not ask the model again: a second answer can
    // differ from the first (and costs a second check). Same shape and cap as
    // Docs' vcache; written only while auto-check is on for this site, and
    // removed with the dismissals when it is switched off.
    const FIELD_CACHE_KEY = "tracely.widget.vcache.field";
    const FIELD_CACHE_MAX = 400;
    const STORED_VERDICTS = new Set(["accurate", "false", "questionable", "incoherent", "needs_citation", "no_claim"]);

    // Per-site enable lives in chrome.storage.local ("enabledSites": [origin])
    // so the options page can list and manage it. The old per-site localStorage
    // flag is kept in sync (and migrated in) for back-compat and for plain
    // test pages without extension APIs.
    const extStorage = useRelay && typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
    let siteOn = lsGet(SITE_KEY) === "1"; // seed from the legacy flag, then sync below
    const siteEnabled = () => siteOn;
    if (extStorage) {
      storageGet({ enabledSites: [] }, (st) => {
        const list = Array.isArray(st.enabledSites) ? st.enabledSites : [];
        if (siteOn && !list.includes(location.origin)) {
          storageSet({ enabledSites: [...list, location.origin] }); // migrate legacy opt-in
        } else if (siteOn !== list.includes(location.origin)) {
          siteOn = list.includes(location.origin);
          lsSet(SITE_KEY, siteOn ? "1" : "0");
          if (widget) render();
        }
      });
      storageOnChanged((changes, area) => {
        if (area !== "local" || !changes.enabledSites) return;
        const on = (changes.enabledSites.newValue ?? []).includes(location.origin);
        if (on !== siteOn) {
          siteOn = on;
          lsSet(SITE_KEY, on ? "1" : "0");
          if (widget) render();
        }
      });
    }

    // ── engine (server | offline) — learned from the background worker ──
    // "standalone" was a third state, for the removed bring-your-own-key
    // engine. Cite-url was hidden in it because that endpoint had no
    // standalone equivalent; with one engine left there is nothing to hide.
    let engine = { mode: "server" };
    async function refreshEngine() {
      if (!useRelay) return;
      try {
        const s = await sendMsg({ type: "tracely-getState" });
        if (s?.ok) {
          const changed = s.mode !== engine.mode;
          engine = s;
          if (changed && widget) render();
        }
      } catch { /* extension reloaded mid-flight */ }
    }
    refreshEngine();
    setInterval(refreshEngine, 30_000);

    // ── state (mirrors docs mode) ──
    const storedVerdicts = jsonParse(lsGet(FIELD_CACHE_KEY) ?? "[]", []); // the site can write this key too: trust nothing
    const cache = new Map((Array.isArray(storedVerdicts) ? storedVerdicts : [])
      .filter((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && e[1] && typeof e[1] === "object" && STORED_VERDICTS.has(e[1].verdict)));
    const dismissed = new Set(jsonParse(lsGet(DISMISS_KEY) ?? "[]", []));
    const sourcesMap = new Map();
    let settings = loadSettings(SETTINGS_KEY);
    let segments = [];
    let citedLater = new Set(); // sentences a later citation in their paragraph covers
    let inflight = false;
    let sourcesInflight = false;
    let lastCheckEnd = Date.now();
    let lastTextChangeAt = Date.now(); // see nextReadGap
    let lastCheckFailed = false;
    let prevHashes = new Set();        // readyToSend's settle rule
    const heldHashes = new Map();      // see holdOmitted
    let statusMsg = siteEnabled() ? "waiting for a text field…" : "auto-check off — click to check";
    let statusKind = "idle"; // idle | checking | error | offline
    let orphaned = false; // the extension was reloaded under this tab — see standDownField
    let expanded = false;
    let showEvidence = false; // the evidence section starts folded: offered, never pushed
    let docGenre = "prose";   // detectGenre of the last read: "resume" turns on Resume tips
    const review = { lastText: null, findings: [], at: 0, okAt: 0, inflight: false, unavailable: false, serving: null, kind: null, seen: new Map() };
    const persistReview = () => {}; // a field has no identity a later page load could find it by
    let copiedTipId = null;
    /* Ask /api/review for this resume's bullet and typo notes — only for a
       resume, only once the text has been still REVIEW_IDLE_MS, only when a
       line is new or rewritten since the last answer (reviewWorthwhile), at
       most every REVIEW_FLOOR_MS and REVIEW_REPEAT_MS after an answer. A
       server without the route (404 not_found) switches it off until reload;
       any other failure waits out the floor and tries again. The free format
       rules (resumeFormatIssues) show either way. */
    async function requestReview(text) {
      const kind = reviewKindFor(docGenre);
      if (!kind || review.inflight || review.unavailable) return;
      // A document that changed kind (a resume pasted over an essay) starts over.
      if (review.kind !== kind) Object.assign(review, { kind, lastText: null, findings: [], at: 0, okAt: 0, seen: new Map() });
      if (!reviewWorthwhile(review.lastText, text) || Date.now() - lastTextChangeAt < REVIEW_IDLE_MS || Date.now() - review.at < REVIEW_FLOOR_MS || Date.now() - review.okAt < REVIEW_REPEAT_MS) return;
      review.inflight = true;
      render();
      try {
        const data = await api("/api/review", { text: text.slice(0, REVIEW_MAX_CHARS), model: CHECK_MODEL, kind });
        const found = Array.isArray(data?.findings) ? data.findings : [];
        review.findings = review.lastText == null ? found : carryReviewNotes(review.findings, review.lastText, found, text); // untouched paragraphs keep their notes
        if (kind === "essay") for (const t of essayFeedbackTips(text, review.findings, new Set())) review.seen.set(t.id, t);
        review.lastText = text;
        review.okAt = Date.now();
        review.serving = data?.genre === "resume"; // the model disagrees that it is one: back to the check
        persistReview();
      } catch (err) {
        review.serving = false; // until a review answers again, the check covers the resume
        if (err?.kind === "not_found") review.unavailable = true;
      } finally {
        review.at = Date.now();
        review.inflight = false;
        render();
      }
    }
    let panelWasOpen = false; // so only the render that OPENS the panel animates it
    let fieldText = "";
    let copiedFixHash = null;
    const fieldFixed = new Set();
    let autoSourceTimes = [];
    let tracked = null;       // the editable element we watch
    let checkedOnce = false;  // pill leaves its quiet state after the first check
    // "Find the cited work" (docs mode's citedMap / citedFallback), and a
    // note's search for its claim: tip id → { hash, text } of that sentence.
    const citedMap = new Map();
    const citedFallback = new Map();
    const claimSearch = new Map();
    let copiedCitedKey = null;

    let widget = null; // created lazily — pages without qualifying fields get zero UI
    function ensureWidget() {
      if (!widget) widget = makeWidget();
      return widget;
    }
    // Same as docs mode; only repaint if the panel exists.
    tierListeners.push(() => { if (widget) render(); });

    /* ── editable tracking ── */

    const SECURE_RE = /passw|secret|token|otp|2fa|cvc|cvv|card[-_ ]?num|ssn|social[-_ ]?security|\bpin\b/i;
    function looksSecure(el) {
      const hints = [
        el.getAttribute?.("name"), el.id, el.getAttribute?.("aria-label"),
        el.getAttribute?.("autocomplete"), el.getAttribute?.("placeholder"),
      ].filter(Boolean).join(" ");
      return SECURE_RE.test(hints);
    }

    // Resolve a focus target to the editable we should track, or null.
    // <input> never qualifies (short, and where the secure stuff lives).
    function resolveEditable(target) {
      if (!(target instanceof Element)) return null;
      if (widget && (target === widget.host || widget.host.contains(target))) return null; // our own shadow DOM
      if (target instanceof HTMLInputElement) return null;
      if (target instanceof HTMLTextAreaElement) return looksSecure(target) ? null : target;
      if (target.isContentEditable) {
        let top = target;
        while (top.parentElement && top.parentElement.isContentEditable) top = top.parentElement;
        const attr = top.getAttribute("contenteditable");
        if (attr !== null && attr !== "" && attr.toLowerCase() !== "true") return null; // plaintext-only etc.
        return looksSecure(top) ? null : top;
      }
      return null;
    }

    /* ── canonical text index for contenteditable (ports public/app/analyze.js) ── */

    const BLOCK_TAGS = new Set(["DIV", "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "UL", "OL", "BLOCKQUOTE", "PRE", "TR", "SECTION", "ARTICLE"]);

    function buildTextIndex(rootEl) {
      let text = "";
      const nodeSegs = [];
      (function walk(node) {
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            const data = child.data.replace(/ /g, " "); // NBSP → space, 1:1
            nodeSegs.push({ node: child, start: text.length, end: text.length + data.length });
            text += data;
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            if (child.nodeName === "BR") { text += "\n"; continue; }
            const isBlock = BLOCK_TAGS.has(child.nodeName);
            if (isBlock && text.length > 0 && !text.endsWith("\n")) text += "\n";
            walk(child);
            if (isBlock && text.length > 0 && !text.endsWith("\n")) text += "\n";
          }
        }
      })(rootEl);
      return { text, segments: nodeSegs };
    }

    function rangeForOffsets(index, start, end) {
      const segs = index.segments;
      let a = null;
      let b = null;
      for (const seg of segs) {
        if (a == null && start >= seg.start && start < seg.end) a = { node: seg.node, off: start - seg.start };
        if (end > seg.start && end <= seg.end) b = { node: seg.node, off: end - seg.start };
      }
      if (a == null) {
        for (const seg of segs) {
          if (start === seg.end) { a = { node: seg.node, off: seg.end - seg.start }; break; }
        }
      }
      if (a == null || b == null) return null;
      const range = document.createRange();
      try {
        range.setStart(a.node, a.off);
        range.setEnd(b.node, b.off);
      } catch { return null; }
      return range;
    }

    function readField(el) {
      if (el instanceof HTMLTextAreaElement) return el.value;
      return buildTextIndex(el).text;
    }

    function fieldEligible() {
      if (!tracked || !tracked.isConnected) return false;
      const len = (tracked instanceof HTMLTextAreaElement ? tracked.value : tracked.textContent ?? "").trim().length;
      return len >= MIN_FIELD_CHARS;
    }

    /* ── Grammarly-style overlay underlines (ports the Ethos technique) ──
       A fixed, pointer-events-none layer holds one absolutely-positioned bar
       per line-box of each flagged sentence. Textareas are measured through
       an offscreen mirror div; contenteditable through offset→Range rects on
       the existing canonical text index. Repositioning is rAF-throttled off
       input/scroll/resize; clicks are hit-tested manually since the layer
       never intercepts pointer events. */

    let overlayEl = null;
    let mirror = null;
    const markRects = new Map(); // hash → visible rects (issue marks only — used for hit-testing)
    const markParts = new Map(); // hash → [{band, line, color}] for the hover state
    let hoveredMark = null;
    let marksRaf = null;

    function ensureOverlay() {
      if (overlayEl && overlayEl.isConnected) return overlayEl;
      overlayEl = document.createElement("div");
      overlayEl.id = "tracely-marks";
      Object.assign(overlayEl.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "2147483646" });
      document.documentElement.appendChild(overlayEl);
      return overlayEl;
    }

    // Offscreen mirror-div measurement for textarea sentence rects.
    function taRects(el, start, end) {
      const cs = getComputedStyle(el);
      if (!mirror) {
        mirror = document.createElement("div");
        document.documentElement.appendChild(mirror);
      }
      Object.assign(mirror.style, {
        position: "fixed", left: "-10000px", top: "0", visibility: "hidden",
        whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: cs.wordBreak,
        width: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + "px",
        font: cs.font, letterSpacing: cs.letterSpacing, tabSize: cs.tabSize,
      });
      const text = el.value;
      mirror.textContent = "";
      mirror.append(document.createTextNode(text.slice(0, start)));
      const span = document.createElement("span");
      span.textContent = text.slice(start, end);
      mirror.append(span, document.createTextNode(text.slice(end)));
      const mBox = mirror.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const padL = parseFloat(cs.paddingLeft), padT = parseFloat(cs.paddingTop);
      const bordL = parseFloat(cs.borderLeftWidth), bordT = parseFloat(cs.borderTopWidth);
      const out = [];
      for (const r of span.getClientRects()) {
        const x = box.left + bordL + padL + (r.left - mBox.left) - el.scrollLeft;
        const y = box.top + bordT + padT + (r.top - mBox.top) - el.scrollTop;
        if (y + r.height < box.top || y > box.bottom) continue; // clip to the visible box
        out.push({ left: x, top: y, width: r.width, height: r.height });
      }
      return out;
    }

    // Offset→Range rects for contenteditable, via the canonical text index.
    function ceRects(el, index, start, end) {
      const range = rangeForOffsets(index, start, end);
      if (!range) return [];
      const box = el.getBoundingClientRect();
      const out = [];
      for (const r of range.getClientRects()) {
        if (r.width === 0) continue;
        if (r.bottom < box.top || r.top > box.bottom) continue; // clip to the visible box
        out.push({ left: r.left, top: r.top, width: r.width, height: r.height });
      }
      return out;
    }

    function scheduleMarks() {
      if (marksRaf) return;
      marksRaf = requestAnimationFrame(() => { marksRaf = null; drawMarks(); });
    }

    /* One finding's mark (field mode): the app's highlighter band under a
       coloured line (src/shared/markMotion.ts), both growing on hover. Two
       children rather than a border, so the line paints over the band. Used
       for sentence marks and for citation notes (cite_tip) alike. */
    let fieldRecent = [], fieldDrawn = [];
    function paintMark(layer, hash, rects, color, pattern) {
      markRects.set(hash, rects);
      const fresh = isFreshMark(fieldRecent, { hash, color, x0: rects[0].left + scrollX, x1: rects[0].left + rects[0].width + scrollX, y: rects[0].top + scrollY });
      for (const r of rects) fieldDrawn.push({ hash, color, x0: r.left + scrollX, x1: r.left + r.width + scrollX, y: r.top + scrollY });
      for (const r of rects) {
        const bar = document.createElement("div");
        Object.assign(bar.style, {
          position: "fixed", left: r.left + "px", top: r.top + "px",
          width: r.width + "px", height: r.height + "px",
          background: "transparent", // Grammarly-style: a clean underline, no highlight wash
          pointerEvents: "none",
        });
        const band = document.createElement("div");
        Object.assign(band.style, {
          position: "absolute", left: "0", right: "0",
          top: `-${MARK_BAND_INSET_TOP}px`, bottom: `-${MARK_BAND_INSET_BOTTOM}px`,
          borderRadius: `${MARK_BAND_RADIUS}px`,
          background: withAlpha(color, 0),
          transform: `scaleY(${MARK_BAND_SCALE_RESTING})`, transformOrigin: "bottom",
          transition: markReducedMotion() ? "none" : MARK_BAND_TRANSITION,
        });
        const line = document.createElement("div");
        Object.assign(line.style, {
          position: "absolute", left: "0", right: "0", bottom: "0",
          height: `${markLineHeight(pattern, false)}px`, borderRadius: `${MARK_LINE_RADIUS}px`,
          background: markFill(color, pattern),
          transition: markReducedMotion() ? "none" : MARK_LINE_TRANSITION,
        });
        bar.append(band, line);
        markParts.set(hash, [...(markParts.get(hash) || []), { band, line, color, pattern }]);
        layer.appendChild(bar);
        if (fresh) drawMarkIn(line, 0);
      }
    }

    function drawMarks() {
      if (orphaned) { if (overlayEl) overlayEl.textContent = ""; markRects.clear(); markParts.clear(); return; }
      if (!overlayEl && !(tracked && tracked.isConnected)) return; // nothing drawn, nothing to clear
      const layer = ensureOverlay();
      layer.textContent = "";
      markRects.clear();
      markParts.clear();
      // What the reader saw last draw (fresh marks are tested against it).
      if (fieldDrawn.length) fieldRecent = fieldDrawn;
      fieldDrawn = [];
      if (!tracked || !tracked.isConnected) return;
      const isTa = tracked instanceof HTMLTextAreaElement;
      let index = null;
      let liveText;
      if (isTa) {
        liveText = tracked.value;
      } else {
        index = buildTextIndex(tracked);
        liveText = index.text;
      }
      if (liveText.trim().length < MIN_FIELD_CHARS) return;
      // Citation notes, on the citation itself (citationMarks); a flagged
      // sentence stops before a citation that carries one.
      const notes = FEATURES.essayFeedback && isArgumentGenre(docGenre) && review.kind === "essay"
        ? essayFeedbackMarks(liveText, essayFeedbackTips(liveText, review.findings, dismissed)).filter((t) => !(cache.get(hashText(t.mark)) && flagShown(cache.get(hashText(t.mark)), settings, docGenre, t.mark)))
        : [];
      const tips = [...(FEATURES.citeMarks && isArgumentGenre(docGenre) ? citationMarks(liveText, settings.citationStyle, dismissed, docGenre) : []), ...notes];
      const seen = new Set();
      const liveSegs = segmentText(liveText);
      const liveCovered = coveredByLaterCitation(liveText, liveSegs);
      // One underline per span (tipCoversSentence): a note over the whole of a
      // flagged sentence is not drawn — the sentence's mark opens the panel,
      // where both cards are.
      const flaggedText = liveSegs.filter((seg) => seg.checkable && !dismissed.has(seg.hash) && flagShown(cache.get(seg.hash), settings, docGenre, seg.text, liveCovered.has(seg.hash))).map((seg) => seg.text);
      for (const tip of tips) {
        if (flaggedText.some((t) => tipCoversSentence(t, tip.mark))) continue;
        const rects = isTa ? taRects(tracked, tip.start, tip.end) : ceRects(tracked, index, tip.start, tip.end);
        if (rects.length) paintMark(layer, tip.id, rects, MARK_COLORS[tip.markKind ?? "cite_tip"], MARK_PATTERN[tip.markKind ?? "cite_tip"]);
      }
      for (const seg of liveSegs) {
        if (!seg.checkable || seen.has(seg.hash) || dismissed.has(seg.hash)) continue;
        seen.add(seg.hash);
        const f = cache.get(seg.hash);
        let color = null;
        let pattern = "solid";
        let pending = false;
        if (flagShown(f, settings, docGenre, seg.text, liveCovered.has(seg.hash))) {
          color = MARK_COLORS[f.verdict];
          pattern = MARK_PATTERN[f.verdict];
        } else if (!f && inflight) {
          color = MARK_PENDING; // awaiting a verdict this cycle
          pending = true;
        } else {
          continue;
        }
        // Beside a note on part of it (a citation), the sentence's mark stops short of it.
        const span = factSpanOf(seg.text, tips.filter((t) => t.start >= seg.start && t.end <= seg.end));
        const rects = isTa ? taRects(tracked, seg.start + span.start, seg.start + span.end) : ceRects(tracked, index, seg.start + span.start, seg.start + span.end);
        if (rects.length === 0) continue;
        if (!pending) { paintMark(layer, seg.hash, rects, color, pattern); continue; }
        for (const r of rects) {
          // Provisional: a faint solid grey rule, no band — nothing to point at yet.
          const bar = document.createElement("div");
          Object.assign(bar.style, {
            position: "fixed", left: r.left + "px", top: r.top + "px",
            width: r.width + "px", height: r.height + "px",
            background: "transparent", pointerEvents: "none",
            borderBottom: `2px solid ${color}`, opacity: "0.45",
          });
          layer.appendChild(bar);
        }
      }
      // The elements are new on every draw, so re-apply the hover — and let it
      // go if the sentence it was on has been edited away or dismissed.
      if (hoveredMark && !markParts.has(hoveredMark)) hoveredMark = null;
      paintHover();
    }

    /* The hovered sentence's band fades up and its line thickens — the same
       gesture the app makes, so a mark behaves the same in both windows.
       Re-applied after every draw, because drawMarks rebuilds the elements. */
    function paintHover() {
      for (const [h, parts] of markParts) {
        const on = h === hoveredMark;
        for (const { band, line, color, pattern } of parts) {
          band.style.background = withAlpha(color, on ? MARK_BAND_ALPHA : 0);
          band.style.transform = `scaleY(${on ? 1 : MARK_BAND_SCALE_RESTING})`;
          line.style.height = `${markLineHeight(pattern, on)}px`;
        }
      }
    }

    function setHoveredMark(h) {
      if (h === hoveredMark) return;
      hoveredMark = h;
      paintHover();
    }

    function hitMark(x, y) {
      for (const [h, rects] of markRects) {
        for (const r of rects) {
          if (x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height + 2) return h;
        }
      }
      return null;
    }

    let flashTimer = null;
    function flashCard(hash) {
      if (!widget) return;
      const card = widget.shadow.querySelector(`[data-card="${hash}"]`);
      if (!card) return;
      card.scrollIntoView({ block: "nearest" });
      card.classList.add("flash");
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => card.classList.remove("flash"), 1300);
    }

    /* Hot path: this fires on every pointer move the page sees. It leaves
       early when nothing is marked, and identifies "over the widget" with an
       identity check rather than composedPath() — an event from inside the
       shadow root is retargeted to the host at this level, and composedPath()
       allocates the whole path array on every move. */
    document.addEventListener("mousemove", (e) => {
      if (!markParts.size) return;
      if (widget && e.target === widget.host) { setHoveredMark(null); return; }
      setHoveredMark(hitMark(e.clientX, e.clientY));
    }, true);

    // Clicking an underline opens the panel and flashes that verdict's card.
    document.addEventListener("mousedown", (e) => {
      if (widget && e.composedPath().includes(widget.host)) return;
      const h = hitMark(e.clientX, e.clientY);
      if (!h) return;
      expanded = true;
      focusCard = h;
      ensureWidget();
      render();
      flashCard(h);
    }, true);

    document.addEventListener("input", (e) => {
      if (tracked && (e.target === tracked || (tracked.contains && tracked.contains(e.target)))) {
        lastTextChangeAt = Date.now(); // typing makes the next read due in READ_INTERVAL_MS (see the Docs loop)
        scheduleMarks();
      }
    }, true);
    document.addEventListener("scroll", () => scheduleMarks(), true);
    window.addEventListener("resize", () => scheduleMarks());

    /* ── check pipeline (same guards as docs mode) ── */

    // Cost idea 2: a sentence changed only by a typo or punctuation keeps
    // the verdict it had (smallEdit). The counts are for the console.
    let verdictsReused = 0, sentencesChecked = 0;
    function inheritVerdicts(before) {
      const live = new Set(segments.map((sg) => sg.hash));
      const taken = new Set();
      let n = 0;
      for (const seg of segments) {
        if (!seg.checkable || cache.has(seg.hash)) continue;
        const old = inheritedVerdict(seg, before, live, cache, taken);
        if (!old) continue;
        cache.set(seg.hash, cache.get(old.hash));
        if (dismissed.has(old.hash) && !dismissed.has(seg.hash)) {
          dismissed.add(seg.hash);
          lsSet(DISMISS_KEY, JSON.stringify([...dismissed]));
        }
        n++;
      }
      if (n) {
        verdictsReused += n;
        console.debug(`[tracely] reused ${n} verdict(s) after a small edit — ${verdictsReused} reused, ${sentencesChecked} sent to be checked on this page`);
      }
      return n;
    }

    function uncheckedSegments() {
      if (FEATURES.writingOnly && GENRE_QUIET.has(docGenre)) return []; // homework, a poem, a story, a script: nothing to check
      if (FEATURES.resumeTips && reviewCoversCheck(docGenre, review)) return []; // cost idea 5
      const out = [];
      const seen = new Set();
      for (const seg of segments) {
        if (!seg.checkable || seen.has(seg.hash)) continue;
        seen.add(seg.hash);
        if (cache.has(seg.hash)) continue;
        if (isHeld(heldHashes, seg.hash, Date.now()) || !readyToSend(seg, prevHashes)) continue;
        out.push(seg);
      }
      return out;
    }

    function currentIssues() {
      const out = [];
      const seen = new Set();
      for (const seg of segments) {
        if (!seg.checkable || seen.has(seg.hash)) continue;
        seen.add(seg.hash);
        const f = cache.get(seg.hash);
        if (!f || dismissed.has(seg.hash) || !flagShown(f, settings, docGenre, seg.text, citedLater.has(seg.hash))) continue;
        out.push({ seg, f });
      }
      return out;
    }

    async function cycle() {
      if (orphaned || inflight || document.hidden) return;
      if (!tracked || !tracked.isConnected) {
        statusKind = "idle";
        statusMsg = "click into a text field first";
        render();
        return;
      }
      inflight = true;
      lastCheckFailed = false;
      try {
        const newText = readField(tracked);
        if (newText !== fieldText) lastTextChangeAt = Date.now();
        fieldText = newText;
        docGenre = FEATURES.resumeTips ? detectGenre(fieldText) : "prose";
        if (!settings.styleChosen) settings.citationStyle = docCitationStyle(fieldText) ?? "mla";
        if (fieldText.trim().length < MIN_FIELD_CHARS) {
          statusKind = "idle";
          statusMsg = `field under ${MIN_FIELD_CHARS} characters — keep writing`;
          segments = [];
          return;
        }
        const before = segments;
        segments = segmentText(fieldText);
        if (inheritVerdicts(before)) persistFieldCache();
        citedLater = coveredByLaterCitation(fieldText, segments);
        const todo = uncheckedSegments().slice(0, MAX_SENTENCES_PER_CHECK);
        prevHashes = new Set(segments.map((sg) => sg.hash));
        if (todo.length > 0) {
          statusKind = "checking";
          statusMsg = `checking ${todo.length}…`;
          render();
          sentencesChecked += todo.length;
          const data = await api("/api/check", {
            text: fieldText.slice(0, MAX_INPUT_CHARS),
            sentences: todo.map((s) => ({ id: s.hash, text: s.text })),
            model: CHECK_MODEL, // no effort: the server decides (the fast model at medium)
          });
          checkedOnce = true;
          for (const f of data.findings ?? []) {
            cache.set(f.id, { verdict: f.verdict, explanation: f.explanation, revision: usableRevision(todo.find((x) => x.hash === f.id)?.text, f.revision), confidence: f.confidence });
          }
          holdOmitted(heldHashes, todo, data.findings, Date.now());
          persistFieldCache();
          autoFindSources(data.findings ?? []); // fire-and-forget, capped
        }
        statusKind = "idle";
        const n = currentIssues().length;
        statusMsg = n > 0 ? `${n} issue${n === 1 ? "" : "s"} found` : "all clear";
        requestReview(fieldText); // fire-and-forget; resumes only
      } catch (err) {
        lastCheckFailed = true;
        if (err?.kind === "no_engine") {
          statusKind = "offline";
          statusMsg = err.message;
        } else if (offlineError(err)) {
          statusKind = "offline";
          statusMsg = "Tracely offline — checks will resume when the server is back";
        } else {
          statusKind = "error";
          statusMsg = err?.message ?? "check failed";
        }
      } finally {
        inflight = false;
        lastCheckEnd = Date.now();
        render();
      }
    }

    // Live sentences first, then the most recent, capped — the Docs rule.
    function persistFieldCache() {
      if (!siteEnabled()) return;
      const live = new Set(segments.map((sg) => sg.hash));
      const entries = [...cache.entries()];
      const keep = [...entries.filter(([h]) => live.has(h)), ...entries.filter(([h]) => !live.has(h)).reverse()].slice(0, FIELD_CACHE_MAX);
      lsSet(FIELD_CACHE_KEY, JSON.stringify(keep));
    }

    async function fetchSources(hash, auto = false) {
      if (sourcesInflight) return;
      const seg = segments.find((s) => s.hash === hash);
      if (!seg) return;
      const f = cache.get(hash);
      sourcesInflight = true;
      sourcesMap.set(hash, { loading: true, list: null, copiedUrl: null });
      render();
      try {
        const data = await api("/api/sources", {
          claim: seg.text,
          correction: f?.revision || undefined,
          context: fieldText.slice(0, 6000),
          // The model and no effort — the server ignores a client's effort
          // on searches and runs the vendor's default.
          model: CHECK_MODEL,
        });
        const { list, unbacked, unread } = backingSources(data.sources, f?.verdict);
        sourcesMap.set(hash, { loading: false, list, unbacked, unread, copiedUrl: null });
      } catch (err) {
        sourcesMap.delete(hash);
        if (!auto) statusKind = "error";
        statusMsg = err?.message ?? "source search failed";
      } finally {
        sourcesInflight = false;
        render();
      }
    }

    // Auto-sources — same toggle and rolling-hour guard as docs mode. Only
    // reachable after a check, which on a non-enabled site takes a click.
    async function autoFindSources(findings) {
      if (!FEATURES.autoSources || settings.autoSources !== true) return; // cost: auto web-search is opt-in
      let started = 0;
      for (const f of findings) {
        if (started >= 3) break;
        if (!AUTO_SOURCE_VERDICTS.includes(f.verdict)) continue;
        if (sourcesMap.has(f.id) || dismissed.has(f.id)) continue;
        if (!segments.some((s) => s.hash === f.id)) continue;
        autoSourceTimes = autoSourceTimes.filter((t) => Date.now() - t < 3_600_000);
        if (autoSourceTimes.length >= 15) { statusMsg = "auto-sources paused — hourly cap"; break; }
        autoSourceTimes.push(Date.now()); // stamp BEFORE the call
        started++;
        await fetchSources(f.id, true); // sequential: one paid search at a time
      }
    }

    async function citeUrlWidget(hash, rawUrl) {
      try {
        const data = await api("/api/cite-url", { url: rawUrl });
        const src = data.source;
        const st = sourcesMap.get(hash) ?? { loading: false, list: [], copiedUrl: null };
        st.loading = false;
        st.list = st.list ?? [];
        if (!st.list.some((s) => s.url === src.url)) st.list.unshift(src);
        sourcesMap.set(hash, st);
        statusKind = "idle";
        statusMsg = "source added — use Copy cite";
      } catch (e) {
        statusKind = "error";
        statusMsg = e?.message ?? "couldn't cite that URL";
      }
      render();
    }

    function copyText(text, hash, url) {
      navigator.clipboard?.writeText(text).catch(() => {});
      if (hash && url) {
        const st = sourcesMap.get(hash);
        if (st) st.copiedUrl = url;
      }
      render();
    }

    /* ── "Find the cited work" (docs mode's, on a field) ─────────────────
       The same lookup and the same cards; the edits go through the field
       (replaceInField) instead of Docs' editor. A field has no reference-list
       engine, so the record's entry rewrites the writer's own entry for that
       work when it is there exactly once, and is copied to paste otherwise. */
    let tipsMemo = null;
    function allTips() {
      if (!isArgumentGenre(docGenre)) return [];
      const k = { text: fieldText, gone: dismissed.size, review: review.findings, style: settings.citationStyle };
      if (tipsMemo && Object.keys(k).every((x) => tipsMemo.k[x] === k[x])) return tipsMemo.list;
      const list = [
        ...citationTips(fieldText, settings.citationStyle, dismissed, docGenre),
        ...(FEATURES.refList ? referenceTips(fieldText, dismissed, docGenre, settings.citationStyle) : []),
        ...(FEATURES.essayFeedback && review.kind === "essay" ? essayFeedbackTips(fieldText, review.findings, dismissed) : []),
      ];
      tipsMemo = { k, list };
      return list;
    }
    function tipById(id) { return allTips().find((t) => t.id === id) ?? null; }
    function citedTargetFor(key) {
      if (String(key).startsWith("tip:")) return tipCitedTarget(tipById(key), segments);
      const seg = segments.find((s) => s.hash === key);
      const c = seg ? flaggedCitationOf(cache.get(key)?.verdict, seg.text) : null;
      return c ? { kind: "sentence", raw: c.raw, inner: c.inner, segHash: seg.hash, sentence: seg.text } : null;
    }
    function replaceFor(hash) {
      if (citedFallback.has(hash)) return citedFallback.get(hash);
      const seg = segments.find((s) => s.hash === hash);
      return seg ? flaggedCitationOf(cache.get(hash)?.verdict, seg.text)?.raw ?? null : null;
    }
    function startClaimSources(key, claimHash, claimText) {
      claimSearch.set(key, { hash: claimHash, text: claimText });
      if (!sourcesMap.get(claimHash)?.list?.length) fetchSources(claimHash);
      render();
    }
    async function findCitedWork(key) {
      const target = citedTargetFor(key);
      if (!target) return;
      const cur = citedMap.get(key);
      if (cur?.loading || cur?.resolved) return;
      const plan = citedLookupPlan(target, fieldText);
      if (target.raw && target.segHash) citedFallback.set(target.segHash, target.raw);
      citedMap.set(key, { loading: true, target, plan, matches: [], selected: 0 });
      render();
      const r = await lookupCitedWork(plan);
      citedMap.set(key, { loading: false, target, plan, selected: 0, ...r });
      if (!r.resolved && target.segHash) startClaimSources(key, target.segHash, target.sentence);
      render();
    }
    function findClaimSource(tipId) {
      const tip = tipById(tipId);
      const i = tip ? claimSentenceIndex(tip.kind, tip.quote, segments) : -1;
      if (i < 0) return;
      const claim = segments[i];
      const c = tip.kind === "excuse" ? lookupableCitation(claim.text) : null;
      if (c) citedFallback.set(claim.hash, c.raw);
      startClaimSources(tipId, claim.hash, claim.text);
    }
    function copyCitedReference(key, i) {
      const src = citedMap.get(key)?.matches?.[Number(i)];
      if (!src) return;
      navigator.clipboard?.writeText(citedWorkEntry(src, settings.citationStyle || "mla").entry).catch(() => {});
      copiedCitedKey = `${key}:${i}`;
      render();
    }
    function decorateCard(card, sourcesFor) {
      const key = card.dataset.card;
      if (!key || card.classList.contains("ev-card")) return;
      const isTip = key.startsWith("tip:");
      const tip = isTip ? tipById(key) : null;
      const target = citedTargetFor(key);
      const ci = tip && TIP_FIND_SOURCE.includes(tip.kind) && !(tip.kind === "excuse" && target) ? claimSentenceIndex(tip.kind, tip.quote, segments) : -1;
      const c = citedMap.get(key);
      const buttons = [];
      if (target) buttons.push(`<button class="act${isTip ? " primary" : ""}" data-cited="${esc(key)}"${c?.loading ? " disabled" : ""}>${esc(CITED_COPY.find)}</button>`);
      if (ci >= 0) buttons.push(`<button class="act${target ? "" : " primary"}" data-claim-src="${esc(key)}">Find a source</button>`);
      let html = "";
      if (c) html += citedWorkHtml(c, (i, src) => citedActionsHtml(key, c, i, src), c.resolved && c.target?.segHash ? `<div class="row"><button class="act" data-cited-more="${esc(key)}">${esc(CITED_COPY.different)}</button></div>` : "");
      const cs = claimSearch.get(key);
      const claim = cs ? segments.find((s) => s.hash === cs.hash) : null;
      if (isTip && claim) html += sourcesFor(claim);
      if (isTip && buttons.length) card.insertAdjacentHTML("beforeend", `<div class="row">${buttons.join("")}</div>${html}`);
      else if (buttons.length || html) {
        const row = card.querySelector(".row");
        if (row && buttons.length) row.insertAdjacentHTML("beforeend", buttons.join(""));
        const at = card.querySelector(".sources") ?? card.querySelector(".cite-url");
        if (html) { if (at) at.insertAdjacentHTML("beforebegin", html); else card.insertAdjacentHTML("beforeend", html); }
      }
    }
    function citedActionsHtml(key, c, i, src) {
      const t = c.target;
      const style = settings.citationStyle || "mla";
      let edit = "";
      if (t?.kind === "sentence" && t.segHash && t.raw && swapCitation(t.sentence, t.raw, formatCitation(src, style).marker, style)) {
        edit = `<button class="act primary" data-cited-replace="${esc(key)}" data-i="${i}">${c.done?.i === i ? "Replaced ✓" : esc(CITED_COPY.replace)}</button>`;
      } else if (t?.kind === "entry") {
        edit = `<button class="act primary" data-cited-entry="${esc(key)}" data-i="${i}">${c.done?.i === i ? "Completed ✓" : esc(CITED_COPY.complete)}</button>`;
      }
      return `${edit}<button class="act${edit ? "" : " primary"}" data-cited-copy="${esc(key)}" data-i="${i}">${copiedCitedKey === `${key}:${i}` ? "Copied ✓" : esc(CITED_COPY.copyRef)}</button>`;
    }

    /* `find` swapped for `replacement` in the tracked field, in place — only
       where `find` is in the field exactly once (which copy is meant is
       otherwise a guess), and read back afterwards. A contenteditable takes
       it through insertText, so the page's own Undo takes it back. */
    function replaceInField(find, replacement) {
      const el = tracked;
      if (!el || !el.isConnected || !find || !replacement) return false;
      try {
        if (el instanceof HTMLTextAreaElement) {
          const v = el.value;
          const at = v.indexOf(find);
          if (at < 0 || v.indexOf(find, at + find.length) >= 0) return false;
          el.focus();
          el.setRangeText(replacement, at, at + find.length, "end");
          nativeValueSetter()?.call(el, el.value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          const index = buildTextIndex(el);
          const at = index.text.indexOf(find);
          if (at < 0 || index.text.indexOf(find, at + find.length) >= 0) return false;
          const range = rangeForOffsets(index, at, at + find.length);
          if (!range) return false;
          el.focus();
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          let ok = false;
          try { ok = document.execCommand("insertText", false, replacement); } catch { ok = false; }
          if (!ok) { sel.removeAllRanges(); return false; }
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return readField(el).includes(replacement);
      } catch {
        return false;
      }
    }
    // The record's entry over the writer's own one for that work, or copied to paste.
    function placeEntryInField(oldEntry, entry) {
      if (oldEntry && replaceInField(oldEntry, entry)) return "and its reference entry";
      navigator.clipboard?.writeText(entry).catch(() => {});
      return worksCitedBlock(readField(tracked)) ? "— its reference is copied, paste it into your list" : "— its reference is copied";
    }
    // "Replace citation" for a looked-up record.
    function fieldReplaceCitation(key, i) {
      const c = citedMap.get(key);
      const src = c?.matches?.[Number(i)];
      const t = c?.target;
      const seg = t?.segHash ? segments.find((s) => s.hash === t.segHash) : null;
      if (!src || !seg || !t.raw) return;
      const style = settings.citationStyle || "mla";
      const { marker, entry } = citedWorkEntry(src, style);
      const swapped = swapCitation(seg.text, t.raw, marker, style);
      if (!swapped || !replaceInField(seg.text, swapped)) {
        if (swapped) navigator.clipboard?.writeText(swapped).catch(() => {});
        statusKind = "idle";
        statusMsg = swapped ? "couldn't edit in place — copied the sentence instead" : "that citation is no longer in the sentence exactly once — nothing was changed";
        render();
        return;
      }
      const oldEntry = c.plan?.entry && citationUses(fieldText, t.raw) <= 1 ? c.plan.entry : null;
      const rest = worksCitedBlock(readField(tracked)) ? placeEntryInField(oldEntry, entry) : "";
      c.done = { i: Number(i) };
      statusKind = "idle";
      statusMsg = `citation replaced${rest ? ` ${rest}` : ""}`;
      lastCheckEnd = lastTextChangeAt = Date.now(); // the text just changed: read again in READ_INTERVAL_MS
      render();
    }
    // "Complete entry": the incomplete reference line, rewritten in place.
    function fieldCompleteEntry(key, i) {
      const c = citedMap.get(key);
      const src = c?.matches?.[Number(i)];
      const t = c?.target;
      if (!src || t?.kind !== "entry") return;
      const { entry } = citedWorkEntry(src, settings.citationStyle || "mla");
      if (!replaceInField(t.entry, entry)) {
        navigator.clipboard?.writeText(entry).catch(() => {});
        statusKind = "idle";
        statusMsg = "couldn't edit in place — copied the entry instead";
        render();
        return;
      }
      c.done = { i: Number(i) };
      statusKind = "idle";
      statusMsg = "reference entry completed";
      lastCheckEnd = lastTextChangeAt = Date.now();
      render();
    }
    // A source from the search, in place of the sentence's faulty citation (Cite in doc's field twin).
    function fieldCiteReplace(hash, i) {
      const seg = segments.find((s) => s.hash === hash);
      const src = sourcesMap.get(hash)?.list?.[Number(i)];
      const raw = replaceFor(hash);
      if (!seg || !src || !raw) return;
      const style = settings.citationStyle || "mla";
      const styled = formatCitation(src, style);
      const swapped = swapCitation(seg.text, raw, styled.marker, style);
      if (!swapped || !replaceInField(seg.text, swapped)) {
        copyText(styled.ref, hash, src.url);
        statusKind = "idle";
        statusMsg = "couldn't edit in place — copied the citation instead";
        render();
        return;
      }
      const rest = placeEntryInField(null, styled.ref);
      const st = sourcesMap.get(hash);
      if (st) st.copiedUrl = src.url;
      statusKind = "idle";
      statusMsg = `citation replaced ${rest}`;
      lastCheckEnd = lastTextChangeAt = Date.now();
      render();
    }

    /* ── in-place fix — the point of field mode ── */

    function nativeValueSetter() {
      return Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set ?? null;
    }

    // revision: "Explain in depth"'s own fix (deepRevision), in place of the card's.
    function fixInField(hash, revision = null) {
      const f = cache.get(hash);
      const rev = revision || f?.revision;
      if (!rev) return;
      const known = segments.find((s) => s.hash === hash);

      // Fallback when the live range can't be located (framework re-rendered,
      // field gone, execCommand refused): copy instead, and say so.
      const fallbackCopy = () => {
        copiedFixHash = hash;
        navigator.clipboard?.writeText(known ? withMarkers(known.text, rev) : rev).catch(() => {});
        statusKind = "idle";
        statusMsg = "couldn't edit in place — copied instead";
      };

      const el = tracked;
      if (!el || !el.isConnected) { fallbackCopy(); render(); return; }

      try {
        if (el instanceof HTMLTextAreaElement) {
          // Recompute the sentence's range against the CURRENT value.
          const seg = segmentText(el.value).find((s) => s.hash === hash);
          if (!seg) { fallbackCopy(); render(); return; }
          const replacement = withMarkers(seg.text, rev);
          el.focus();
          el.setRangeText(replacement, seg.start, seg.end, "end");
          // Controlled inputs (React et al.): re-assert through the native
          // setter so the framework's value tracker sees the change, then
          // dispatch input so it re-renders from the new value.
          nativeValueSetter()?.call(el, el.value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          // contenteditable: map sentence offsets onto text-node ranges, then
          // insertText over the selection so the page's own undo stack works.
          const index = buildTextIndex(el);
          const seg = segmentText(index.text).find((s) => s.hash === hash);
          const range = seg ? rangeForOffsets(index, seg.start, seg.end) : null;
          if (!range) { fallbackCopy(); render(); return; }
          const replacement = withMarkers(seg.text, rev);
          el.focus();
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          let ok = false;
          try { ok = document.execCommand("insertText", false, replacement); } catch { ok = false; }
          if (!ok) { sel.removeAllRanges(); fallbackCopy(); render(); return; }
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        fieldFixed.add(hash);
        cache.delete(hash); // the rewritten sentence gets re-verified on the next read
        statusKind = "idle";
        statusMsg = "fixed in field";
        lastCheckEnd = lastTextChangeAt = Date.now(); // the text just changed: read again in READ_INTERVAL_MS
      } catch {
        fallbackCopy();
      }
      render();
    }

    /* ── per-site opt-in ── */

    function setSiteEnabled(on) {
      if (!on) {
        // Off means off: the verdicts and source lists this page's localStorage
        // holds (readable by the site, and outliving an uninstall) go with it.
        for (const k of [DISMISS_KEY, FIELD_CACHE_KEY]) { try { localStorage.removeItem(k); } catch { /* storage denied */ } }
        cache.clear(); sourcesMap.clear(); dismissed.clear();
        citedMap.clear(); citedFallback.clear(); claimSearch.clear();
      }
      siteOn = on;
      lsSet(SITE_KEY, on ? "1" : "0");
      if (extStorage) {
        storageGet({ enabledSites: [] }, (st) => {
          const list = (Array.isArray(st.enabledSites) ? st.enabledSites : []).filter((o) => o !== location.origin);
          if (on) list.push(location.origin);
          storageSet({ enabledSites: list });
        });
      }
      if (on) {
        statusMsg = "auto-check on for this site";
        lastCheckEnd = 0;
        cycle(); // the toggle click is the prompt
      } else {
        statusKind = "idle";
        statusMsg = "auto-check off — click to check";
      }
      render();
    }

    /* ── render ── */

    function render() {
      scheduleMarks(); // keep in-page underlines in step with every state change
      if (!widget) return;
      const { shadow, root } = widget;
      if (orphaned) {
        // Shown where the counting pill would have been, never anywhere new.
        root.style.display = tracked && (fieldEligible() || segments.length > 0) ? "" : "none";
        root.innerHTML = orphanPillHtml();
        return;
      }
      const enabled = siteEnabled();
      const show = Boolean(tracked && (expanded || fieldEligible() || segments.length > 0));
      root.style.display = show ? "" : "none";

      const issues = currentIssues();
      const offTopic = FEATURES.offTopic && isArgumentGenre(docGenre) ? offTopicTips(fieldText, dismissed) : [];
      const refTips = FEATURES.refList && isArgumentGenre(docGenre) ? referenceTips(fieldText, dismissed, docGenre, settings.citationStyle) : [];
      const essayNotes = FEATURES.essayFeedback && isArgumentGenre(docGenre) && review.kind === "essay" ? essayFeedbackTips(fieldText, review.findings, dismissed) : [];
      const citeTips = FEATURES.quoteTips && isArgumentGenre(docGenre) ? citationTips(fieldText, settings.citationStyle, dismissed, docGenre) : [];
      const resumeList = FEATURES.resumeTips && docGenre === "resume" ? resumeTips(fieldText, review.findings, dismissed) : [];
      const quiet = !enabled && !checkedOnce && !inflight && statusKind === "idle";
      // A stray line counts on the launcher too: a ✓ over it would say all is well.
      const flagged = issues.length + offTopic.length + refTips.length + essayNotes.length + citeTips.length;
      const tally = tallyOf(issues.map(({ f }) => f.verdict), [...citeTips, ...refTips, ...essayNotes, ...offTopic, ...resumeList]);
      const countCls = statusKind === "offline" || statusKind === "error" || inflight ? "off" : flagged > 0 ? "" : "ok";
      const countTxt = statusKind === "offline" ? "off" : inflight ? "…" : flagged > 0 ? String(flagged) : "✓";

      const panelOpening = expanded && !panelWasOpen;
      panelWasOpen = expanded;
      let panelHtml = "";
      let cardSources = null; // the panel's sourcesFor, for decorateCard once the HTML is in
      if (expanded) {
        const sourcesFor = (seg) => {
          const st = sourcesMap.get(seg.hash);
          let sourcesHtml = "";
          if (st?.loading) {
            sourcesHtml = `<div class="sources"><div class="loading">Searching the web for sources…</div></div>`;
          } else if ((st?.unbacked || st?.unread?.length) && !st.list?.length) {
            sourcesHtml = `<div class="sources"><div class="loading">${esc(st.unbacked ? UNBACKED_NOTE(st.unbacked) : RECEIPT_COPY.unreadOnly(st.unread.length))}</div>${unreadSourcesHtml(seg.hash, st.unread, st.unreadOpen)}</div>`;
          } else if (st?.list?.length) {
            sourcesHtml = `<div class="sources"><div class="sources-title">Sources — copy one to cite</div>` +
              st.list.map((src, i) => `
                <div class="src">
                  <span class="src-ico">${faviconUrl(src.url) ? `<img src="${esc(faviconUrl(src.url))}" alt="" referrerpolicy="no-referrer" />` : ""}</span>
                  <span class="stance st-${esc(src.stance)}">${esc(src.stance)}</span>
                  <div class="src-body">
                    <a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.title)}</a>
                    <div class="src-meta">${esc(src.publisher)}</div>
                    ${sourceSaysHtml(src)}
                    <div class="src-actions">
                      ${replaceFor(seg.hash) ? `<button class="act primary" data-src-replace="${seg.hash}" data-i="${i}">${esc(CITED_COPY.replace)}</button>` : ""}
                      <button class="act" data-copy-src="${seg.hash}" data-i="${i}">${st.copiedUrl === src.url ? "Copied ✓" : "Copy cite"}</button>
                    </div>
                  </div>
                </div>`).join("") + unreadSourcesHtml(seg.hash, st.unread, st.unreadOpen) + `</div>`;
          }
          return sourcesHtml;
        };
        cardSources = sourcesFor;
        const cards = issues.map(({ seg, f }) => {
          const kind = f.verdict === "false" ? "false" : f.verdict === "questionable" ? "quest" : f.verdict === "needs_citation" ? "cite" : "inco";
          const sourcesHtml = sourcesFor(seg);
          return { hash: seg.hash, html: `
          <div class="card" data-card="${seg.hash}" data-cat="${verdictCat(f.verdict)}">
            <div class="top">
              <span class="dot d-${kind}"></span><span class="ctitle">${VERDICT_LABEL[f.verdict]}</span>
              <button class="x" data-dismiss="${seg.hash}" title="Dismiss">✕</button>
            </div>
            <div class="quote">“${esc(seg.text.length > 140 ? seg.text.slice(0, 139) + "…" : seg.text)}”</div>
            ${f.explanation ? `<div class="expl">${esc(f.explanation)}</div>` : ""}
            ${deepHtml(seg.hash, f.verdict, (h) => `<button class="act primary" data-deep-fix="${h}">${fieldFixed.has(h) ? "Fixed ✓" : "Fix in field"}</button>`)}
            ${f.revision ? `
            <div class="fix">
              <div class="fix-label">Suggested revision</div>
              <div class="fix-text">${esc(f.revision)}</div>
              <div class="row">
                <button class="act primary" data-field-fix="${seg.hash}">${fieldFixed.has(seg.hash) ? "Fixed ✓" : "Fix in field"}</button>
                <button class="act" data-copy-fix="${seg.hash}">${copiedFixHash === seg.hash ? "Copied ✓" : "Copy fix"}</button>
                <button class="act" data-sources="${seg.hash}">Find sources</button>
              </div>
            </div>` : `<div class="row"><button class="act" data-sources="${seg.hash}">Find sources</button></div>`}
            ${sourcesHtml}
            <div class="cite-url"><input type="url" placeholder="Or paste a URL you found…" data-url-input="${seg.hash}" /><button class="act" data-url-add="${seg.hash}">Cite</button></div>
          </div>` };
        });
        const cardsHtml = cards.length ? cardListHtml(cards) + legendHtml() : "";
        const genreHtml = FEATURES.resumeTips || FEATURES.quoteTips ? genreLineHtml(docGenre, fieldText, settings.citationStyle) : "";
        /* The list, most serious first (owner, 2026-10-08: "make this more
           organized … restructure it"): the claims, then the citations (the
           citation notes and the reference list's), then the writing (the
           review's notes and the stray lines), then evidence you could add —
           one card open at a time (foldCards). */
        const claimsHtml = cardsHtml ? groupHtml("Claims", cards.length, cardsHtml) : "";
        const tipsHtml = (FEATURES.resumeTips && docGenre === "resume" ? resumeTipsHtml(resumeList, review.inflight, copiedTipId)
          : (FEATURES.offTopic || FEATURES.refList || FEATURES.quoteTips || FEATURES.essayFeedback) && isArgumentGenre(docGenre)
            ? citationTipsHtml([...citeTips, ...refTips], copiedTipId) + essayFeedbackHtml([...essayNotes, ...offTopic], review.inflight && review.kind === "essay", copiedTipId, review.kind === "essay" ? resolvedNotes(review.seen, essayNotes, fieldText) : [])
            : "");
        const evidenceHtml = FEATURES.evidenceHints && genreWantsList(docGenre)
          ? evidenceSectionHtml(evidenceCandidates(segments, cache, dismissed), showEvidence, sourcesFor, (seg) => sourcesMap.has(seg.hash))
          : "";

        const emptyMsg = statusKind === "offline"
          ? "Tracely could not reach its server. Try again in a moment."
          : enabled
            ? "Nothing flagged. Sentences are checked as you finish them, while this field is focused."
            : "Tracely is off on this site, and nothing is sent. Turn it on to check what you write here.";

        panelHtml = `
        <div class="panel${panelOpening ? " opening" : ""}">
          ${panelHeadHtml(tally, statusMsg, statusKind === "error" || statusKind === "offline")}
          <div class="list">
            ${genreHtml}${claimsHtml}${tipsHtml}${claimsHtml || tipsHtml ? "" : `<div class="empty">${emptyMsg}</div>`}${evidenceHtml}
          </div>
          <div class="foot">
            <span class="foot-left">
              <label class="autosrc" title="Underline sentences that are accurate but would benefit from a citation. Off: only false, unverifiable or incoherent sentences are marked."><input type="checkbox" id="citeTgl"${settings.citeHints !== false ? " checked" : ""} /><span>Citation suggestions</span></label>
              <label class="autosrc" title="Automatically look up sources for flagged claims (capped)"><input type="checkbox" id="autoSrcTgl"${settings.autoSources === true ? " checked" : ""} /><span>Auto-src</span></label>
            </span>
            <button class="act${enabled ? "" : " primary"}" id="siteSwitch">${enabled ? "Turn off on this site" : "Turn on for this site"}</button>
          </div>
        </div>`;
      }

      const prevScroll = shadow.querySelector(".list")?.scrollTop ?? 0;
      root.innerHTML = `
        ${panelHtml}
        ${quiet
          ? `<div class="pill quiet" id="pill"><span class="plane">${PLANE_SVG}</span>Tracely is off here</div>`
          : launcherHtml(countCls, countTxt, issues.length ? `Tracely — ${issues.length} flagged` : "Tracely")}
      `;
      // "Find the cited work" and a note's "Find a source", added to the cards now they exist.
      if (cardSources) {
        for (const card of shadow.querySelectorAll(".card[data-card]")) decorateCard(card, cardSources);
        foldCards(shadow, render);
      }
      const listEl = shadow.querySelector(".list");
      if (listEl) listEl.scrollTop = prevScroll;

      shadow.getElementById("pill").addEventListener("click", () => { expanded = !expanded; render(); });
      wireChrome(shadow, () => { expanded = false; render(); }, render);
      if (expanded) {
        shadow.getElementById("siteSwitch").addEventListener("click", () => setSiteEnabled(!enabled));
        wireDeep(shadow, explainSentence, render);
        shadow.getElementById("evidenceToggle")?.addEventListener("click", () => { showEvidence = !showEvidence; render(); });
        for (const btn of shadow.querySelectorAll("[data-tip-x]")) {
          btn.addEventListener("click", () => { dismissed.add(btn.dataset.tipX); lsSet(DISMISS_KEY, JSON.stringify([...dismissed])); render(); scheduleMarks(); });
        }
        for (const btn of shadow.querySelectorAll("[data-tip-copy]")) {
          btn.addEventListener("click", () => {
            const tip = [...resumeTips(fieldText, review.findings, dismissed), ...essayFeedbackTips(fieldText, review.findings, dismissed)].find((t) => t.id === btn.dataset.tipCopy);
            if (!tip?.suggestion) return;
            navigator.clipboard?.writeText(tip.suggestion).catch(() => { /* denied */ });
            copiedTipId = tip.id;
            render();
          });
        }
        for (const btn of shadow.querySelectorAll("[data-dismiss]")) {
          btn.addEventListener("click", () => {
            dismissed.add(btn.dataset.dismiss);
            lsSet(DISMISS_KEY, JSON.stringify([...dismissed]));
            render();
          });
        }
        for (const btn of shadow.querySelectorAll("[data-field-fix]")) {
          btn.addEventListener("click", () => fixInField(btn.dataset.fieldFix));
        }
        // "Explain in depth"'s own revision, put in like the card's.
        for (const btn of shadow.querySelectorAll("[data-deep-fix]")) {
          btn.addEventListener("click", () => fixInField(btn.dataset.deepFix, deepRevision(btn.dataset.deepFix)));
        }
        for (const btn of shadow.querySelectorAll("[data-copy-fix]")) {
          btn.addEventListener("click", () => {
            const f = cache.get(btn.dataset.copyFix);
            if (f?.revision) { copiedFixHash = btn.dataset.copyFix; copyText(f.revision); }
          });
        }
        for (const btn of shadow.querySelectorAll("[data-sources]")) {
          btn.addEventListener("click", () => fetchSources(btn.dataset.sources));
        }
        for (const btn of shadow.querySelectorAll("[data-copy-src]")) {
          btn.addEventListener("click", () => {
            const st = sourcesMap.get(btn.dataset.copySrc);
            const src = st?.list?.[Number(btn.dataset.i)];
            if (src) copyText(formatCitation(src, settings.citationStyle || "mla").ref, btn.dataset.copySrc, src.url);
          });
        }
        // "Couldn't read these" opens and closes; the state lives in the entry (unreadSourcesHtml).
        for (const btn of shadow.querySelectorAll("[data-unread-toggle]")) {
          btn.addEventListener("click", () => {
            const st = sourcesMap.get(btn.dataset.unreadToggle);
            if (st) { st.unreadOpen = !st.unreadOpen; render(); }
          });
        }
        // "Find the cited work" and what it offers (decorateCard), and a
        // searched source in place of the sentence's faulty citation.
        for (const btn of shadow.querySelectorAll("[data-src-replace]")) btn.addEventListener("click", () => fieldCiteReplace(btn.dataset.srcReplace, btn.dataset.i));
        for (const btn of shadow.querySelectorAll("[data-cited]")) btn.addEventListener("click", () => findCitedWork(btn.dataset.cited));
        for (const btn of shadow.querySelectorAll("[data-claim-src]")) btn.addEventListener("click", () => findClaimSource(btn.dataset.claimSrc));
        for (const btn of shadow.querySelectorAll("[data-cited-more]")) {
          btn.addEventListener("click", () => {
            const t = citedMap.get(btn.dataset.citedMore)?.target;
            if (t?.segHash) startClaimSources(btn.dataset.citedMore, t.segHash, t.sentence);
          });
        }
        for (const btn of shadow.querySelectorAll("[data-cited-copy]")) btn.addEventListener("click", () => copyCitedReference(btn.dataset.citedCopy, btn.dataset.i));
        for (const btn of shadow.querySelectorAll("[data-cited-replace]")) btn.addEventListener("click", () => fieldReplaceCitation(btn.dataset.citedReplace, btn.dataset.i));
        for (const btn of shadow.querySelectorAll("[data-cited-entry]")) btn.addEventListener("click", () => fieldCompleteEntry(btn.dataset.citedEntry, btn.dataset.i));
        shadow.getElementById("autoSrcTgl")?.addEventListener("change", (e) => {
          settings.autoSources = e.target.checked;
          saveSettings();
        });
        shadow.getElementById("citeTgl")?.addEventListener("change", (e) => {
          settings.citeHints = e.target.checked;
          saveSettings();
          if (typeof requestDocsMarks === "function") requestDocsMarks(); // the underlines follow the switch
          if (typeof scheduleMarks === "function") scheduleMarks();
          render();
        });
        for (const btn of shadow.querySelectorAll("[data-url-add]")) {
          btn.addEventListener("click", () => {
            const input = shadow.querySelector(`[data-url-input="${btn.dataset.urlAdd}"]`);
            if (input?.value.trim()) citeUrlWidget(btn.dataset.urlAdd, input.value.trim());
          });
        }
        for (const input of shadow.querySelectorAll("[data-url-input]")) {
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && input.value.trim()) citeUrlWidget(input.dataset.urlInput, input.value.trim());
          });
        }
      }
    }

    // "Explain in depth" on one sentence (render bails while there is no widget).
    function explainSentence(hash) {
      const seg = segments.find((s) => s.hash === hash);
      const f = cache.get(hash);
      if (!seg || !f) return;
      explainInDepth(hash, seg.text, fieldText, f.verdict, render);
    }

    function saveSettings() {
      persistSettings(settings, SETTINGS_KEY);
    }

    /* ── focus tracking + loop ── */

    document.addEventListener("focusin", (e) => {
      const el = resolveEditable(e.target);
      if (el && el !== tracked) {
        tracked = el;
        segments = [];
        statusKind = "idle";
        statusMsg = siteEnabled() ? "watching this field" : "auto-check off — click to check";
        ensureWidget();
        render();
      }
      // Focus moving elsewhere (including into our widget) keeps the tracked
      // field, so panel buttons can still act on it.
    }, true);

    // Pick up a field that was already focused when we loaded.
    const initial = resolveEditable(document.activeElement);
    if (initial) {
      tracked = initial;
      ensureWidget();
      render();
    }

    /* Field mode's ghost instance (docs mode's standDown explains the
       general case): after an extension reload this script keeps running on
       its old findings, its underlines still drawn and its pill still
       counting, while every check it tries fails. Stand down: clear the
       marks, stop checking, and let the pill say why. */
    function standDownField(why) {
      orphaned = true;
      expanded = false;
      segments = [];
      drawMarks(); // the orphaned branch clears every bar
      if (widget) render();
      console.log(`[tracely] v${EXT_VERSION} stood down (${why}) — reload the tab to resume`);
    }

    setInterval(() => {
      // Only where there WAS an extension context to lose (plain test pages
      // have no chrome.* and would stand down on the first tick).
      if (useRelay && !orphaned && !extAlive()) standDownField("extension reloaded");
      if (tracked && !tracked.isConnected) {
        tracked = null;
        segments = [];
        scheduleMarks(); // clear any leftover underline bars
        if (widget) render();
        return;
      }
      if (!tracked || !widget) return;
      if (siteEnabled() && !inflight && !document.hidden && fieldEligible()
          && Date.now() - lastCheckEnd >= nextReadGap(Date.now(), lastTextChangeAt, lastCheckFailed)) {
        cycle(); // opted-in automatic path — nextReadGap (3 s while typing, 10 s idle or after a failure) + hash cache
      } else if (!expanded) {
        // Keep pill visibility fresh as the field grows/shrinks — no re-render.
        const show = Boolean(tracked && (fieldEligible() || segments.length > 0));
        widget.root.style.display = show ? "" : "none";
      }
    }, 1000);
    // Deliberately NO startup network calls in field mode: on a non-enabled
    // site, nothing is sent anywhere until the user clicks.
  }
})();
