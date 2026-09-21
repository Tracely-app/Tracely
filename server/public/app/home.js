/**
 * Home tab — the landing surface. Hero-weight stat tiles, two primary action
 * cards, recent documents with band-tinted grade chips, four in-app guides in
 * a subtle reader modal, and the Tracer launcher pinned bottom-left.
 */
import { applyAppearance, emptyState, esc, fmtDate, gradeBand } from "/app/settings.js";

const CSS = `
.home-tab { flex: 1; min-height: 0; overflow-y: auto; position: relative; padding: var(--tab-pad, 32px); }
.home-tab .home-inner {
  max-width: 1040px; margin: 0 auto; width: 100%;
  display: flex; flex-direction: column; gap: var(--tab-gap, 16px);
  padding-bottom: var(--s-2, 16px);
}

/* hero greeting */
.home-tab .home-hero { margin-bottom: var(--s-1, 8px); }
.home-tab .home-hero .eyebrow { display: block; margin-bottom: 6px; color: var(--accent-deep); }
.home-tab .home-hero h1 { font-family: var(--serif); font-size: var(--fs-2xl, 32px); font-weight: 700; letter-spacing: -.4px; }
.home-tab .home-hero .hero-sub { color: var(--ink-dim); margin-top: 6px; font-size: var(--fs-md, 15px); max-width: 60ch; }

.home-tab .eyebrow { display: block; margin-bottom: var(--s-1, 8px); }

/* hero-weight stat tiles */
.home-tab .home-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--s-2, 16px); }
.home-tab .home-stat { padding: var(--card-pad, 24px); }
.home-tab .home-stat:hover { transform: none; box-shadow: var(--shadow); }
.home-tab .home-stat .stat-label { font-size: var(--fs-xs, 12.5px); font-weight: 600; text-transform: uppercase; letter-spacing: .8px; color: var(--ink-faint); }
.home-tab .home-stat .stat-value {
  font-family: var(--serif); font-size: var(--fs-2xl, 32px); font-weight: 700; line-height: 1.15;
  margin-top: var(--s-1, 8px); font-variant-numeric: tabular-nums; letter-spacing: -.5px;
}
.home-tab .home-stat .stat-value small { font-size: var(--fs-md, 15px); font-weight: 400; color: var(--ink-faint); margin-left: 5px; letter-spacing: 0; }

/* action cards with an arrow affordance */
.home-tab .home-actions { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-2, 16px); }
.home-tab .home-action { padding: var(--card-pad, 24px); cursor: pointer; }
.home-tab .home-action:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.home-tab .home-action .act-row { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s-2, 16px); }
.home-tab .home-action .act-title { font-family: var(--serif); font-size: var(--fs-lg, 18px); font-weight: 700; line-height: 1.15; color: var(--accent-deep); }
.home-tab .home-action .act-desc { color: var(--ink-dim); margin-top: 5px; font-size: var(--fs-sm, 13.5px); max-width: 44ch; }
.home-tab .home-action .act-arrow {
  color: var(--ink-faint); font-size: var(--fs-lg, 18px); line-height: 1.15; flex-shrink: 0;
  transition: transform var(--t-fast, 150ms) var(--ease, ease), color var(--t-fast, 150ms) var(--ease, ease);
}
.home-tab .home-action:hover .act-arrow { transform: translateX(4px); color: var(--accent-deep); }
.home-tab .home-link-form { display: flex; gap: var(--s-1, 8px); margin-top: var(--s-2, 16px); }
.home-tab .home-link-form .input { flex: 1; }

/* recent documents */
.home-tab .home-recent { display: flex; gap: var(--s-2, 16px); overflow: hidden; }
.home-tab .home-doc {
  padding: 14px var(--s-2, 16px); display: flex; align-items: center; gap: 12px;
  cursor: pointer; min-width: 0; flex: 0 1 260px;
}
.home-tab .home-doc:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.home-tab .home-doc .doc-title { font-family: var(--serif); font-size: var(--fs-md, 15px); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.home-tab .home-doc .doc-date { font-size: var(--fs-xs, 12.5px); color: var(--ink-faint); white-space: nowrap; margin-top: 2px; }
.home-tab .home-recent .empty-state { padding: var(--s-3, 24px); margin: 0; flex: 1; max-width: none; }
.home-tab .home-recent .empty-plane { width: 32px; height: 32px; margin-bottom: 0; }

/* guides */
.home-tab .home-guides { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--s-2, 16px); }
.home-tab .home-guide-card { padding: var(--s-2, 16px); cursor: pointer; display: flex; flex-direction: column; gap: 5px; }
.home-tab .home-guide-card:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.home-tab .home-guide-card .g-title { font-family: var(--serif); font-size: var(--fs-md, 15px); font-weight: 700; line-height: 1.25; }
.home-tab .home-guide-card .g-blurb { font-size: var(--fs-xs, 12.5px); color: var(--ink-dim); flex: 1; line-height: 1.5; }
.home-tab .home-guide-card .g-read {
  font-size: var(--fs-xs, 12.5px); color: var(--accent-deep); font-weight: 600;
  transition: transform var(--t-fast, 150ms) var(--ease, ease);
}
.home-tab .home-guide-card:hover .g-read { transform: translateX(3px); }

/* tracer launcher */
.home-tab .home-tracer {
  position: sticky; bottom: 0; align-self: flex-start;
  display: inline-flex; align-items: center; gap: 9px;
  box-shadow: var(--shadow-lift);
}
.home-tab .home-tracer .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }

/* the guide reader modal */
.home-guide { padding: var(--s-4, 32px) var(--s-5, 40px); }
.home-guide header { display: flex; align-items: center; justify-content: space-between; gap: var(--s-2, 16px); margin-bottom: var(--s-2, 16px); }
.home-guide h2 { font-family: var(--serif); font-size: var(--fs-xl, 24px); font-weight: 700; line-height: 1.15; letter-spacing: -.2px; }
.home-guide .guide-body { font-family: var(--serif); font-size: var(--fs-md, 15px); line-height: 1.7; color: var(--ink); max-width: 62ch; }
.home-guide .guide-body p { margin-bottom: 14px; }
.home-guide .guide-body ul { margin: 0 0 14px 22px; }
.home-guide .guide-body li { margin-bottom: 6px; }
.home-guide .mark-swatch { display: inline-block; width: 11px; height: 11px; border-radius: 3px; margin-right: 7px; vertical-align: baseline; }
`;

function ensureStyles() {
  if (document.querySelector('style[data-tab="home"]')) return;
  const st = document.createElement("style");
  st.dataset.tab = "home";
  st.textContent = CSS;
  document.head.appendChild(st);
}

/* ── guides — written here, rendered into #modalRoot ──────────────────── */

const GUIDES = [
  { key: "grading", title: "How Tracely grades", blurb: "The rubric behind every letter grade" },
  { key: "marks", title: "Reading the marks", blurb: "What the coloured underlines mean" },
  { key: "citing", title: "Citing sources well", blurb: "Make claims your reader can verify" },
  { key: "cost", title: "What Tracely costs to run", blurb: "Which actions spend API money" },
];

function gradingGuide(ctx) {
  const parts = ctx.rubric.GRADE_COMPONENTS
    .map((k) => ctx.rubric.RUBRIC[k])
    .map((c) => `${esc(c.title)} (${c.points})`)
    .join(", ");
  return `
    <p>Tracely grades the way a careful teacher does: against a written rubric, one component at a time,
    rather than from an overall impression. The graded components and their points are ${parts}.
    Each component earns a fraction of its points and the total is scaled to a score out of 100,
    which maps to the letter grade you see on the report.</p>
    <p>Two rules keep the number honest. Body paragraphs are scored as the <em>fraction</em> that govern a
    claim, never the count — so padding an essay with extra paragraphs lowers the score instead of raising it.
    And when a draft contains no counterargument, that component leaves the denominator entirely rather than
    scoring zero, so prompts that never asked for one are not punished.</p>
    <p>Your grading level shifts the score: Tracely adds 1.5 points for every grade below 12, and the report
    prints that arithmetic as its own row so a student can trace exactly where the number came from.</p>
    <p>Credibility problems — the coloured marks — do not subtract points directly. They are listed beside the
    grade as work the draft owes before its claims can be trusted.</p>
  `;
}

function marksGuide(ctx) {
  const { PROBLEM_KINDS } = ctx.marks;
  const groups = ["red", "orange", "amber", "grey"].map((color) => {
    const kinds = PROBLEM_KINDS.filter((p) => p.color === color);
    if (kinds.length === 0) return "";
    const items = kinds.map((p) => `<li><span class="mark-swatch" style="background:var(--mark-${color})"></span>${esc(p.label)}</li>`).join("");
    const heading = { red: "Red — stop and check", orange: "Orange — the evidence is thin", amber: "Amber — the paperwork needs work", grey: "Grey — still checking" }[color];
    return `<p><strong>${heading}.</strong></p><ul>${items}</ul>`;
  }).join("");
  return `
    <p>Every mark Tracely draws uses one of three colours, plus grey while a check is still running.
    Red means something looks wrong — a fact the check believes is false, or a source that may not exist.
    Orange means the evidence is thin: nothing found, only partial support, or a statistic no one can verify.
    Amber means the claim may be fine but the citation work is not — incomplete, missing, or unverified
    against the work it names.</p>
    ${groups}
    <p>A sentence can carry several problems at once. The underline takes the colour of the most serious one,
    and clicking it opens a card listing all of them — the underline and the card always agree, because both
    read from the same list.</p>
  `;
}

function citingGuide() {
  return `
    <p>A citation has one job: to let a reader put their finger on the exact work you used. The strongest
    citations name an author, a year, and a full title — enough that anyone can find the same source and
    check that it says what you say it says.</p>
    <p>Three habits make citations that hold up. First, cite the work you actually read, not a work you saw
    quoted somewhere else; second-hand citations are where errors and fabrications creep in. Second, keep the
    claim inside what the source supports — if a study found a link in one city over one summer, do not cite
    it for a universal law. Narrowing a sentence is cheaper than defending an overstatement. Third, prefer
    sources a reader can reach: journal articles, books, and reports beat a vanished webpage.</p>
    <p>Attribution in prose counts too. "According to the 2020 census…" carries a claim honestly even without
    a formal reference, and Tracely treats it as a citation. What it flags is the gap between confidence and
    support: precise numbers with no source, strong causal claims resting on one weak study, and references
    missing the pieces a reader needs. Fix those and the marks disappear.</p>
  `;
}

function costGuide(ctx) {
  const g = ctx.guards.GUARDS;
  return `
    <p>Tracely runs on your own OpenAI API key, so it is worth knowing which actions spend money and which
    are free. Searching scholarly indexes for evidence, resolving a citation against public records, saving
    sources to your library, and citing a pasted link cost nothing — those use free public services.</p>
    <p>Four things are model calls and therefore paid: detecting the claims in a draft, grading it against the
    rubric, fact-check critiques of individual claims, and chatting with Tracer. Web search for sources is
    also paid. The model you pick in Settings changes the price of every one of these — Thorough is the
    sharpest and by far the most expensive, Fast the cheapest.</p>
    <p>Every automatic path has a cap so a busy session cannot run away with your budget: at most
    ${g.maxAutoCritiqueClaims} automatic fact-checks per analysis, ${g.maxWebSearchesPerAnalysis} web searches
    per analysis, and ${g.maxWebSearchesPerHour} web searches per hour no matter how many analyses you run.
    Results are cached, so re-analyzing text that has not changed is free. The two switches in Settings that
    spend money — automatic fact-checking and auto-found sources — say so on their labels, and turning them
    off means Tracely only spends when you explicitly ask.</p>
  `;
}

function guideBody(key, ctx) {
  if (key === "grading") return gradingGuide(ctx);
  if (key === "marks") return marksGuide(ctx);
  if (key === "citing") return citingGuide();
  return costGuide(ctx);
}

function openGuide(guide, ctx) {
  const modalRoot = document.getElementById("modalRoot");
  if (!modalRoot) return;
  modalRoot.innerHTML = "";
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="home-guide">
        <header>
          <h2>${esc(guide.title)}</h2>
          <button class="btn btn-ghost" data-close>Close</button>
        </header>
        <div class="guide-body">${guideBody(guide.key, ctx)}</div>
      </div>
    </div>
  `;
  const close = () => {
    modalRoot.innerHTML = "";
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop || e.target.closest("[data-close]")) close();
  });
  document.addEventListener("keydown", onKey);
  modalRoot.appendChild(backdrop);
}

/* ── render ───────────────────────────────────────────────────────────── */

export async function render(mount, ctx) {
  applyAppearance(ctx.settings);
  ensureStyles();

  const root = document.createElement("div");
  root.className = "home-tab";
  mount.appendChild(root);

  const first = String(ctx.settings.firstName ?? "").trim();

  root.innerHTML = `
    <div class="home-inner">
      <div class="home-hero">
        <span class="eyebrow">Tracely</span>
        <h1>Welcome back${first ? `, ${esc(first)}` : ""}.</h1>
        <div class="hero-sub">Paper in, credible paper out — graded against a written rubric, every claim traced to its source.</div>
      </div>

      <div class="home-stats">
        <div class="card home-stat"><div class="stat-label">Documents graded this month</div><div class="stat-value" id="hsGraded">—</div></div>
        <div class="card home-stat"><div class="stat-label">Average grade</div><div class="stat-value" id="hsAvg">—</div></div>
        <div class="card home-stat"><div class="stat-label">Current grading streak</div><div class="stat-value" id="hsStreak">—</div></div>
      </div>

      <div class="home-actions">
        <div class="card home-action" id="hActNew">
          <div class="act-row">
            <div>
              <div class="act-title">New document</div>
              <div class="act-desc">Paste or upload writing for Tracely to grade</div>
            </div>
            <span class="act-arrow" aria-hidden="true">→</span>
          </div>
        </div>
        <div class="card home-action" id="hActLink">
          <div class="act-row">
            <div>
              <div class="act-title">Paste a link</div>
              <div class="act-desc">Point Tracely at a page and it will analyze the content</div>
            </div>
            <span class="act-arrow" aria-hidden="true">→</span>
          </div>
          <div class="home-link-form hidden" id="hLinkForm">
            <input class="input" id="hLinkUrl" type="url" placeholder="https://…" />
            <button class="btn btn-primary" id="hLinkGo">Cite it</button>
          </div>
        </div>
      </div>

      <div>
        <span class="eyebrow">Recent documents</span>
        <div class="home-recent" id="hRecent">${emptyState("Nothing here yet", "Start with a new document above — your recent work lands here.")}</div>
      </div>

      <div>
        <span class="eyebrow">Resources</span>
        <div class="home-guides" id="hGuides"></div>
      </div>

      <button class="btn home-tracer" id="hTracer"><span class="dot"></span>Chat with Tracer</button>
    </div>
  `;

  /* stats */
  try {
    const stats = await ctx.api.stats();
    if (!root.isConnected) return;
    root.querySelector("#hsGraded").textContent = String(stats.gradedThisMonth ?? 0);
    root.querySelector("#hsAvg").textContent =
      stats.averageScore != null ? ctx.rubric.letterFor(stats.averageScore) : "—";
    const streak = stats.streak ?? 0;
    root.querySelector("#hsStreak").innerHTML = `${streak}<small>day${streak === 1 ? "" : "s"}</small>`;

    const recent = (stats.recent ?? []).slice(0, 4);
    if (recent.length > 0) {
      const wrap = root.querySelector("#hRecent");
      wrap.innerHTML = recent.map((d) => `
        <div class="card home-doc" data-doc="${esc(d.id)}">
          <span class="grade-chip" data-band="${gradeBand(d.grade_letter)}">${esc(d.grade_letter ?? "—")}</span>
          <div style="min-width:0">
            <div class="doc-title">${esc(d.title)}</div>
            <div class="doc-date">Opened ${fmtDate(d.last_opened_at)}</div>
          </div>
        </div>
      `).join("");
      for (const el of wrap.querySelectorAll("[data-doc]")) {
        el.addEventListener("click", () => ctx.navigate("analyze", { docId: el.dataset.doc }));
      }
    }
  } catch (e) {
    ctx.toast(`Could not load stats: ${e.message}`, true);
  }

  /* guides */
  const guidesEl = root.querySelector("#hGuides");
  guidesEl.innerHTML = GUIDES.map((g, i) => `
    <div class="card home-guide-card" data-guide="${i}">
      <div class="g-title">${esc(g.title)}</div>
      <div class="g-blurb">${esc(g.blurb)}</div>
      <div class="g-read">Read →</div>
    </div>
  `).join("");
  for (const el of guidesEl.querySelectorAll("[data-guide]")) {
    el.addEventListener("click", () => openGuide(GUIDES[Number(el.dataset.guide)], ctx));
  }

  /* new document */
  root.querySelector("#hActNew").addEventListener("click", async () => {
    try {
      const doc = await ctx.api.documents.create({ title: "Untitled" });
      ctx.navigate("analyze", { docId: doc.id });
    } catch (e) {
      ctx.toast(`Could not create a document: ${e.message}`, true);
    }
  });

  /* paste a link — reveal inline form, then cite → create → analyze */
  const linkCard = root.querySelector("#hActLink");
  const linkForm = root.querySelector("#hLinkForm");
  const linkUrl = root.querySelector("#hLinkUrl");
  const linkGo = root.querySelector("#hLinkGo");

  linkCard.addEventListener("click", (e) => {
    if (e.target.closest(".home-link-form")) return;
    linkForm.classList.toggle("hidden");
    if (!linkForm.classList.contains("hidden")) linkUrl.focus();
  });

  async function citeLink() {
    const url = linkUrl.value.trim();
    if (!url) { linkUrl.focus(); return; }
    linkGo.disabled = true;
    linkGo.textContent = "Fetching…";
    try {
      const { source } = await ctx.api.citeUrl(url);
      const body =
        `<p>${esc(source.url)}</p>` +
        (source.snippet ? `<p>${esc(source.snippet)}</p>` : "");
      const doc = await ctx.api.documents.create({ title: source.title || "Untitled", bodyHtml: body });
      ctx.navigate("analyze", { docId: doc.id });
    } catch (e) {
      ctx.toast(e.message, true);
      linkGo.disabled = false;
      linkGo.textContent = "Cite it";
    }
  }
  linkGo.addEventListener("click", citeLink);
  linkUrl.addEventListener("keydown", (e) => { if (e.key === "Enter") citeLink(); });

  /* tracer launcher */
  root.querySelector("#hTracer").addEventListener("click", () => ctx.openTracer(null));
}
