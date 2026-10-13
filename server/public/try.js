/* Try Tracely — the page around the engine (try.html).

   content.js does the checking, the underlines, the panel and its cards; the
   inline shim in try.html answers for the extension's background worker and
   exposes window.__tracelyDemo. This file is the page itself: the
   "Check my writing" button, the toolbar's status and allowance (from
   GET /api/demo/status after every demo call), the notice that says when a
   part of the try-out is used up, the character count, and the height the
   www.jointracely.com/try/ frame needs.

   How a check starts (field mode has no one-shot check; see the shim's
   comment): the first click opens content.js's panel and presses its own
   "Turn on for this site" switch, which runs the first check at once; later
   clicks un-pause the loop the shim holds paused, and the next read sends
   whatever sentences changed. Each click is one /api/demo/check at most. */
(() => {
  "use strict";
  const demo = window.__tracelyDemo;
  const $ = (id) => document.getElementById(id);
  const editor = $("editor");
  const checkBtn = $("check");
  const checkLabel = checkBtn.querySelector(".label");
  const statusEl = $("status");
  const toolbar = document.querySelector(".toolbar");
  const allowanceEl = $("allowance");
  const countEl = $("count");
  const announcer = $("announce");
  const notice = $("notice");
  const noticeText = $("notice-text");
  const noticeReload = $("notice-reload");
  const framed = document.documentElement.classList.contains("framed");

  const MIN_CHARS = 80;           // content.js MIN_FIELD_CHARS: shorter fields are not checked
  const ARM_WINDOW_MS = 12_000;   // a click with nothing new to send stops waiting after this
  const fmt = (n) => Number(n).toLocaleString("en-US");
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

  let left = null;          // what /api/demo/status says this visitor has left today
  let sourcesPaused = false;
  let checkedOnce = false;  // a check has answered on this page
  let lastChecked = null;   // the text the last answered check was sent with
  let busy = false;
  let sawRequest = false;   // a check went out during the current click
  let armTimer = 0;
  let noticeKind = "";
  let over = null;          // the text is over the limit (null: not rendered yet)

  // The text exactly as content.js reads a contenteditable (buildTextIndex),
  // so the count here is the length the server is sent and judges.
  const BLOCKS = new Set(["DIV", "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "UL", "OL", "BLOCKQUOTE", "PRE", "TR", "SECTION", "ARTICLE"]);
  function readText(root) {
    let text = "";
    (function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) text += child.data.replace(/ /g, " ");
        else if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.nodeName === "BR") { text += "\n"; continue; }
          const block = BLOCKS.has(child.nodeName);
          if (block && text && !text.endsWith("\n")) text += "\n";
          walk(child);
          if (block && text && !text.endsWith("\n")) text += "\n";
        }
      }
    })(root);
    return text;
  }

  /* ── the toolbar: status, allowance, count ──
     #status is the one live region that speaks as things happen; it is
     rewritten only when its words change (typing must not re-announce it).
     The count and the allowance change all the time and say nothing; the
     moments that matter go through announce(). */
  function setStatus(text, state = "idle") {
    if (statusEl.textContent !== text) statusEl.textContent = text;
    toolbar.dataset.state = state;
  }
  function announce(text) {
    announcer.textContent = "";
    requestAnimationFrame(() => { announcer.textContent = text; });
  }
  function renderAllowance() {
    if (!left) return;
    const checks = `<b>${fmt(left.check)}</b> ${left.check === 1 ? "check" : "checks"}`;
    allowanceEl.innerHTML = sourcesPaused
      ? `${checks} left · source search paused for today`
      : `${checks} · <b>${fmt(left.sources)}</b> source ${left.sources === 1 ? "search" : "searches"} left`;
  }
  function renderCount() {
    const n = readText(editor).length;
    const max = demo ? demo.limits.maxChars : 3000;
    countEl.textContent = n > max ? `${fmt(n)} / ${fmt(max)} characters: shorten it to check` : `${fmt(n)} / ${fmt(max)} characters`;
    countEl.classList.toggle("over", n > max);
    if (over !== null && over !== n > max) announce(n > max ? `Over ${fmt(max)} characters: shorten your text to check it.` : `Back under ${fmt(max)} characters.`);
    over = n > max;
    return n;
  }
  function updateButton() {
    const out = Boolean(demo && (demo.closed || demo.exhausted.check));
    checkBtn.classList.toggle("busy", busy);
    checkBtn.setAttribute("aria-disabled", String(out || busy));
    checkBtn.setAttribute("aria-busy", String(busy));
    checkLabel.textContent = busy ? "Checking…" : demo && demo.closed ? "Try-out closed" : out ? "No checks left" : "Check my writing";
    if (out || checkedOnce) checkBtn.classList.remove("invite");
  }
  function setBusy(on) { busy = on; updateButton(); }

  /* ── the notice (over the toolbar; the text below stays where it is) ── */
  // ctas: true for both links, "early" for Get early access alone.
  function showNotice(kind, text, { ctas = false, reload = false } = {}) {
    noticeKind = kind;
    notice.dataset.kind = kind === "sources" || kind === "paused" ? "info" : kind;
    noticeText.textContent = text;
    for (const a of notice.querySelectorAll(".notice-actions a")) a.hidden = !ctas || (ctas === "early" && !a.classList.contains("btn-primary"));
    noticeReload.hidden = !reload;
    notice.hidden = false;
  }
  function hideNotice() {
    const hadFocus = notice.contains(document.activeElement);
    notice.hidden = true;
    if (hadFocus) checkBtn.focus(); // never strand keyboard focus on a hidden button
    const short = {
      end: "That's the try-out. Get early access to keep going.",
      closed: demo && demo.closed ? demo.closed : "The try-out is closed for now.",
      session: "Reload the page to start the try-out again.",
      cookies: "The try-out needs cookies switched on. Allow them, then reload.",
    }[noticeKind];
    if (short) setStatus(short, "stopped");
    noticeKind = "";
  }
  function showSourcesUsed() {
    const n = demo.limits.sources;
    showNotice("sources", `You've used your ${plural(n, "source search", "source searches")} for this try-out. Checks still work.`);
  }
  function showEnd() {
    demo.exhausted.check = true;
    setBusy(false);
    setStatus("No checks left in this try-out.", "stopped");
    showNotice("end", "That's the try-out. In the full version Tracely checks as you write in Google Docs and anywhere you type, and finds sources for claims that need them.", { ctas: true });
  }
  function showClosed(message) {
    demo.closed = message || "The try-out has reached its limit for today. It comes back at midnight.";
    setBusy(false);
    const off = /isn't available/i.test(demo.closed);
    setStatus(off ? "The try-out isn't available right now." : "The try-out is closed for today.", "stopped");
    showNotice("closed", `${demo.closed} ${off ? "You can still get early access to Tracely." : "Tracely itself is unaffected: get early access to use it from launch."}`, { ctas: true });
  }
  function showSession(message) {
    setBusy(false);
    // Refused before any status came back: the cookie GET /try set never
    // stuck (cookies blocked), and "reload" alone would only loop.
    if (left === null || navigator.cookieEnabled === false) {
      setStatus("The try-out needs cookies.", "stopped");
      showNotice("cookies", `The try-out needs cookies switched on for ${location.hostname}. Allow them, then reload.`, { reload: true });
      return;
    }
    setStatus("Your try-out session has expired.", "stopped");
    showNotice("session", message || "Your try-out session has expired. Reload the page to start again.", { reload: true });
  }

  /* ── GET /api/demo/status: { open, left, limits, resetAt, sourcesPaused? } ── */
  const whole = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d);
  async function refreshStatus() {
    let res, data;
    try {
      res = await fetch("/api/demo/status", { credentials: "same-origin", cache: "no-store" });
      data = await res.json().catch(() => ({}));
    } catch { return; } // offline: the allowance keeps its last numbers
    const err = data && data.error;
    if (!res.ok) {
      if (err && err.kind === "demo_session") showSession(err.message);
      else if (err && err.kind === "demo_closed") showClosed(err.message);
      return;
    }
    const lim = data.limits || {};
    for (const k of ["check", "sources", "review", "maxChars"]) demo.limits[k] = whole(lim[k], demo.limits[k]);
    const l = data.left || {};
    const hadSources = left ? left.sources : null;
    left = { check: whole(l.check, demo.limits.check), sources: whole(l.sources, demo.limits.sources), review: whole(l.review, demo.limits.review) };
    for (const k of ["check", "sources", "review"]) demo.exhausted[k] = left[k] <= 0;
    sourcesPaused = data.sourcesPaused === true;
    if (hadSources > 0 && left.sources === 0 && !sourcesPaused) announce("That was your last source search in this try-out. Checks still work.");
    renderAllowance();
    renderCount();
    if (data.open === false) {
      // Off altogether (no secret, budget 0) reads as nothing left at all.
      const off = left.check === 0 && left.sources === 0 && left.review === 0;
      if (noticeKind !== "closed") showClosed(off ? "The try-out isn't available right now." : "");
    } else if (left.check <= 0) {
      if (noticeKind !== "end") showEnd();
    }
    updateButton();
  }

  /* ── framed: content.js's widget in the document, not at the frame's foot ──
     The website sizes the frame to this page's whole height, so the widget's
     position:fixed corner is the bottom of a tall frame, often below the
     visitor's screen. Framed, it is anchored in the document instead. Wide
     (the legend beside the essay): the launcher at the legend's top corner,
     the panel in the legend's column. Narrow: the launcher in the essay
     card's foot, the panel over the essay. The panel opens on the part of
     the frame the visitor can see, and never runs past the frame's end. A
     panel dragged by its header keeps content.js's own placement (inline
     styles, which win over these rules). */
  const PANEL_MAX = 620;   // content.js .panel max-height
  const STRIP = 40;
  const docEl = document.querySelector(".doc");
  const legendEl = document.querySelector(".legend");
  let placeStyle = null;   // <style> in the widget's shadow root
  let panelAt = null;      // the panel's top (document px), chosen as it opens
  let seenEnd = null;      // the visible part's bottom then, less a margin
  let seen = null;         // { top, bottom }: the part of the frame on screen now
  // A frame cannot read its parent's scroll; an IntersectionObserver can say
  // which of these invisible 40px strips down the page are on screen.
  function watchSeen() {
    if (!("IntersectionObserver" in window)) return () => {};
    const shown = new Map(), strips = document.createElement("div");
    strips.setAttribute("aria-hidden", "true");
    strips.style.cssText = "position:absolute;left:0;top:0;width:1px;height:0;visibility:hidden;pointer-events:none";
    document.body.appendChild(strips);
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) shown.set(e.target, [e.intersectionRect.top + scrollY, e.intersectionRect.bottom + scrollY]);
        else shown.delete(e.target);
      }
      const spans = [...shown.values()];
      seen = spans.length ? { top: Math.min(...spans.map((s) => s[0])), bottom: Math.max(...spans.map((s) => s[1])) } : null;
    }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
    let height = 0;
    return () => { // (re)lay the strips over exactly the page's height: no overflow, no scrollbar
      const h = Math.floor(document.body.getBoundingClientRect().height);
      if (h === height) return;
      height = h;
      io.disconnect(); shown.clear(); strips.textContent = "";
      for (let y = 0; y < h; y += STRIP) {
        const s = document.createElement("div");
        s.style.cssText = `position:absolute;left:0;top:${y}px;width:1px;height:${Math.min(STRIP, h - y)}px`;
        strips.appendChild(s);
        io.observe(s);
      }
    };
  }
  const layStrips = framed ? watchSeen() : () => {};
  function anchors() {
    const vw = document.documentElement.clientWidth;
    const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top + scrollY, bottom: r.bottom + scrollY, inset: Math.round(vw - r.right - scrollX) }; };
    const doc = box(docEl), legend = box(legendEl), ed = box(editor);
    const beside = legend.left >= doc.right - 1;
    if (beside) return { beside, root: { top: legend.top, right: legend.inset }, col: { top: legend.top, right: legend.inset } };
    const right = Math.max(22, doc.inset + 16);
    return { beside, root: { top: Math.round(doc.bottom - 70), right }, col: { top: Math.round(ed.top + 8), right } };
  }
  function placeWidget() {
    if (!placeStyle) return;
    const a = anchors(), end = document.documentElement.clientHeight - 16;
    const start = Math.max(a.col.top, panelAt ?? a.col.top);
    const h = Math.max(200, Math.min(PANEL_MAX, Math.max(360, (seenEnd ?? end) - start), end - a.col.top));
    const top = Math.max(a.col.top, Math.min(start, end - h));
    placeStyle.textContent = `div.root { position: absolute; top: ${a.root.top}px; right: ${a.root.right}px; bottom: auto; left: auto; }
      .root .panel { top: ${top - a.root.top}px; right: ${a.col.right - a.root.right}px; bottom: auto; max-height: ${h}px; }`;
  }
  // The panel's next spot: the top of what the visitor sees (or its column's top).
  function aim() {
    if (!placeStyle) return;
    panelAt = seen ? Math.round(seen.top + 16) : null;
    seenEnd = seen ? Math.round(seen.bottom - 16) : null;
    placeWidget();
  }
  const panelOf = (host) => host && host.shadowRoot.querySelector(".panel");
  function offScreen(panel) {
    if (!panel || !seen || panel.style.position === "fixed") return false; // dragged: the visitor's spot
    const r = panel.getBoundingClientRect();
    return r.top + scrollY > seen.bottom - 120 || r.bottom + scrollY < seen.top + 120;
  }

  /* ── content.js's widget ── */
  // Its host sits on <html>; the hidden one in <body> is the sentinel.
  const findHost = () => [...document.querySelectorAll("#tracely-host")].find((el) => el.shadowRoot && el.parentElement === document.documentElement) || null;
  function widgetHost() {
    let host = findHost();
    if (!host) {
      // content.js tracks the field focus moves into (its focusin listener).
      // A focus EVENT rather than a focus, so no phone keyboard jumps up.
      editor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      host = findHost();
    }
    if (host && !host.shadowRoot.querySelector("style[data-try]")) {
      // Controls with nothing behind them here: Settings (the options page
      // belongs to the installed extension), the per-site switch (this page
      // turns it on for the first check; off would wipe results), a card's
      // "paste a URL" box (/api/cite-url is not in the try-out) and the
      // locked "Explain in depth" (Pro, with a link to the order page and
      // its live checkout: nothing to buy before launch). The shim also
      // answers open-order itself, so no click there opens that page.
      const style = document.createElement("style");
      style.dataset.try = "";
      style.textContent = "#siteSwitch, #panelSettings, .cite-url, .deep-row, .deep-note a[data-deep-plans] { display: none !important; }";
      host.shadowRoot.appendChild(style);
      if (framed) { placeStyle = document.createElement("style"); host.shadowRoot.appendChild(placeStyle); placeWidget(); }
      // The panel's column is the legend's: html.tr-panel-open while it shows.
      let raf = 0, wasOpen = false;
      const sync = () => {
        raf = 0;
        const open = Boolean(host.shadowRoot.querySelector(".panel"));
        document.documentElement.classList.toggle("tr-panel-open", open);
        if (framed && open && !wasOpen && offScreen(panelOf(host))) aim(); // opened: where the visitor is looking
        wasOpen = open;
      };
      new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(sync); }).observe(host.shadowRoot, { childList: true, subtree: true });
      sync();
    }
    return host;
  }
  function panelSwitch(host) {
    const shadow = host.shadowRoot;
    if (!shadow.getElementById("siteSwitch")) shadow.getElementById("pill")?.click(); // opens the panel
    return shadow.getElementById("siteSwitch");
  }
  function openPanel() {
    const host = findHost();
    if (host && !host.shadowRoot.querySelector(".panel")) host.shadowRoot.getElementById("pill")?.click();
  }

  /* ── "Check my writing" ── */
  function disarm() {
    clearTimeout(armTimer);
    demo.armed = false;
    demo.paused = true;
    if (busy && !sawRequest) {
      setBusy(false);
      setStatus("Nothing new was sent. Tracely checks sentences that state facts: change one, then check again.", "done");
    }
  }
  function runCheck() {
    if (!demo || busy) return;
    stopQuietRead();
    if (demo.closed) { showClosed(demo.closed); return; }
    if (demo.exhausted.check) { showEnd(); return; }
    const text = readText(editor);
    if (text.length > demo.limits.maxChars) {
      renderCount();
      setStatus(`Shorten your text to ${fmt(demo.limits.maxChars)} characters to check it.`, "stopped");
      return;
    }
    if (text.trim().length < MIN_CHARS) { setStatus("Write a few sentences first: Tracely checks text of 80 characters or more.", "idle"); return; }
    if (checkedOnce && text === lastChecked) {
      openPanel();
      setStatus("Nothing has changed since the last check. Edit a sentence, then check again.", "done");
      return;
    }
    const host = demo.engineReady ? widgetHost() : null;
    if (!host) { setStatus("Tracely couldn't start on this page. Reload it to try again.", "stopped"); return; }
    document.documentElement.classList.add("tr-engaged");
    sawRequest = false;
    setBusy(true);
    setStatus("Tracely is checking this document…", "checking");
    demo.armed = true;   // one /api/check, for this click
    demo.paused = false; // and the loop may read the field until it has gone
    clearTimeout(armTimer);
    armTimer = setTimeout(disarm, ARM_WINDOW_MS);
    aim(); // framed: the panel opens where this button is, on screen
    const sw = panelSwitch(host);
    // content.js's setSiteEnabled(true): checks at once. The switch it saves
    // stays in the shim's memory, so the next visit starts click-to-check again.
    if (sw && /turn on/i.test(sw.textContent || "")) sw.click();
    // Already on: the loop's next read (within a few seconds) sends what changed.
  }

  /* One quiet read after a check. content.js asks for its writing review of
     an essay (/api/review, the try-out allows two) only on a read that finds
     the text still for 5 s, and reads happen only on a click here. So, 5.6 s
     after a check and only if nothing was typed since, the loop may read once:
     there is nothing new to check (and a check would be refused: no click
     armed it), so all it can send is that review. */
  let quietTimer = 0;
  function quietRead() {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (busy || demo.armed || demo.closed || demo.exhausted.review || readText(editor) !== lastChecked) return;
      demo.paused = false;
      quietTimer = setTimeout(() => { if (!demo.armed) demo.paused = true; }, 1600);
    }, 5600);
  }
  function stopQuietRead() {
    clearTimeout(quietTimer);
    if (!demo.armed) demo.paused = true;
  }

  /* ── what the engine's calls say (the shim's events) ── */
  const FLAGGED = new Set(["false", "incoherent", "questionable", "needs_citation"]);
  function wire() {
    demo.on("request", ({ feature }) => {
      if (feature !== "check") return;
      sawRequest = true;
      clearTimeout(armTimer); // the shim pauses the loop again when this answers
    });
    demo.on("response", (r) => {
      const failed = !r.ok;
      if (r.kind === "demo_closed") showClosed(r.message);
      else if (r.kind === "demo_session") showSession(r.message);
      else if (r.kind === "demo_limit") {
        if (r.limitFeature === "check") showEnd();
        else if (r.limitFeature === "sources") showSourcesUsed();
      }
      if (r.feature === "check") {
        setBusy(false);
        if (r.ok) {
          checkedOnce = true;
          lastChecked = readText(editor);
          const flagged = (r.data && Array.isArray(r.data.findings) ? r.data.findings : []).filter((f) => FLAGGED.has(f && f.verdict)).length;
          setStatus(flagged ? "Checked. Click an underlined sentence to see why." : "Checked. Nothing flagged in what was sent.", "done");
          quietRead();
        } else if (!/^demo_(closed|session|limit)$/.test(r.kind)) {
          setStatus(r.kind === "no_engine" ? "Tracely couldn't reach its server. Try again in a moment." : r.message || "The check didn't go through. Try again.", "stopped");
        }
        updateButton();
      }
      if (!r.local && !(failed && r.kind === "no_engine")) refreshStatus();
    });
    // A part already used up, refused here without a call.
    demo.on("limit", ({ feature }) => {
      if (feature === "sources") showSourcesUsed();
      else if (feature === "check") showEnd();
    });
    demo.on("settings", () => setStatus("Settings come with the full version.", toolbar.dataset.state || "idle"));
    demo.on("upgrade", () => showNotice("upgrade", "Explain in depth comes with Tracely Pro at launch.", { ctas: "early" }));
  }

  /* ── the editor ── */
  function onInput() {
    stopQuietRead(); // typing: the next read waits for a click
    renderCount();
    if (checkedOnce && !busy && noticeKind !== "end" && noticeKind !== "closed") {
      const changed = readText(editor) !== lastChecked;
      setStatus(changed ? "You've edited since the last check." : "Checked. Click an underlined sentence to see why.", changed ? "idle" : "done");
    }
  }
  editor.addEventListener("input", onInput);
  // Pasted text arrives as plain text: no fonts, images or links from elsewhere.
  editor.addEventListener("paste", (e) => {
    const text = e.clipboardData && e.clipboardData.getData("text/plain");
    if (typeof text !== "string") return;
    e.preventDefault();
    document.execCommand("insertText", false, text);
  });
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runCheck(); }
  });
  checkBtn.addEventListener("click", runCheck);
  $("notice-x").addEventListener("click", hideNotice);
  noticeReload.addEventListener("click", () => location.reload());

  /* ── inside www.jointracely.com/try/: tell the frame how tall to be ── */
  if (framed) {
    // The website frames with allow-top-navigation-by-user-activation, so a
    // click on early access / the download page moves the site itself rather
    // than opening a second tab of it.
    for (const a of document.querySelectorAll("#notice-actions a")) a.target = "_top";
    const parents = ["https://www.jointracely.com", "https://jointracely.com"];
    // Post only to the page that framed this one (every other target logs a
    // console warning on each resize): ancestorOrigins (Chromium, Safari) or
    // the referrer (Firefox; the website frames with an origin referrer).
    const anc = location.ancestorOrigins && location.ancestorOrigins.length ? location.ancestorOrigins[0] : "";
    let ref = "";
    try { ref = document.referrer ? new URL(document.referrer).origin : ""; } catch { /* no referrer */ }
    const framer = parents.find((o) => o === anc || o === ref);
    // A local copy of this page framed by a local test page (never production).
    const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    const targets = framer ? [framer] : local ? ["*"] : parents; // unknown framer: both, as before
    let last = 0;
    const post = () => {
      const height = Math.ceil(document.body.getBoundingClientRect().height);
      if (!height || height === last) return;
      last = height;
      for (const origin of targets) {
        try { window.parent.postMessage({ type: "tracely-try-height", height }, origin); } catch { /* no parent */ }
      }
    };
    const relayout = () => { post(); layStrips(); placeWidget(); };
    if ("ResizeObserver" in window) new ResizeObserver(relayout).observe(document.body);
    addEventListener("load", relayout);
    relayout();
    // An underline clicked: content.js opens its panel on this mousedown (and
    // scrolls to the card) in the document's capture phase, so the spot is
    // picked first, in the window's. An open panel moves only beside the
    // essay, never over the text clicked.
    addEventListener("mousedown", (e) => {
      if (!editor.contains(e.target)) return;
      const panel = panelOf(findHost());
      if (!panel || (offScreen(panel) && anchors().beside)) aim();
    }, true);
  }

  /* ── start ── */
  renderCount();
  if (!demo || !demo.engineReady) {
    setStatus("Tracely couldn't start in this browser. Try another browser.", "stopped");
    checkBtn.setAttribute("aria-disabled", "true");
    return;
  }
  wire();
  checkBtn.classList.add("invite");
  updateButton();
  refreshStatus();
})();
