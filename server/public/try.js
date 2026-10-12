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

  /* ── the toolbar: status, allowance, count ── */
  function setStatus(text, state = "idle") {
    statusEl.textContent = text;
    toolbar.dataset.state = state;
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
  function showNotice(kind, text, { ctas = false, reload = false } = {}) {
    noticeKind = kind;
    notice.dataset.kind = kind === "sources" || kind === "paused" ? "info" : kind;
    noticeText.textContent = text;
    for (const a of notice.querySelectorAll(".notice-actions a")) a.hidden = !ctas;
    noticeReload.hidden = !reload;
    notice.hidden = false;
  }
  function hideNotice() {
    notice.hidden = true;
    const short = {
      end: "That's the try-out. Add Tracely to Chrome, free, to keep going.",
      closed: demo && demo.closed ? demo.closed : "The try-out is closed for now.",
      session: "Reload the page to start the try-out again.",
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
    showNotice("closed", `${demo.closed} ${off ? "You can still add Tracely to Chrome, free." : "Tracely itself is unaffected: add it to Chrome, free, and keep going."}`, { ctas: true });
  }
  function showSession(message) {
    setBusy(false);
    setStatus("Your try-out session has expired.", "stopped");
    showNotice("session", message || "Your try-out session has expired. Reload the page to start again.", { reload: true });
  }

  /* ── GET /api/demo/status: { open, left, limits, resetAt, sourcesPaused? } ── */
  const whole = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d);
  async function refreshStatus() {
    let res, data;
    try {
      res = await fetch("/api/demo/status", { credentials: "same-origin", cache: "no-store", headers: { "X-Tracely-Demo": "1" } });
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
    left = { check: whole(l.check, demo.limits.check), sources: whole(l.sources, demo.limits.sources), review: whole(l.review, demo.limits.review) };
    for (const k of ["check", "sources", "review"]) demo.exhausted[k] = left[k] <= 0;
    sourcesPaused = data.sourcesPaused === true;
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
      // Two controls with nothing behind them here: Settings (the options
      // page belongs to the installed extension) and the per-site switch
      // (this page turns it on for the first check; off would wipe results).
      const style = document.createElement("style");
      style.dataset.try = "";
      style.textContent = "#siteSwitch, #panelSettings { display: none !important; }";
      host.shadowRoot.appendChild(style);
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
    const sw = panelSwitch(host);
    if (sw && /turn on/i.test(sw.textContent || "")) {
      sw.click(); // content.js's setSiteEnabled(true): checks at once
      // It saved the switch for this site; the next visit starts click-to-check again.
      demo.forget();
    }
    // Already on: the loop's next read (within a few seconds) sends what changed.
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
    demo.on("settings", () => setStatus("Settings come with the installed extension.", toolbar.dataset.state || "idle"));
  }

  /* ── the editor ── */
  function onInput() {
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
    const parents = ["https://www.jointracely.com", "https://jointracely.com"];
    // A local copy of this page framed by a local test page (never production).
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) parents.push("*");
    let last = 0;
    const post = () => {
      const height = Math.ceil(document.body.getBoundingClientRect().height);
      if (!height || height === last) return;
      last = height;
      for (const origin of parents) {
        try { window.parent.postMessage({ type: "tracely-try-height", height }, origin); } catch { /* no parent */ }
      }
    };
    if ("ResizeObserver" in window) new ResizeObserver(post).observe(document.body);
    addEventListener("load", post);
    post();
  }

  /* ── start ── */
  renderCount();
  if (!demo || !demo.engineReady) {
    setStatus("Tracely couldn't start in this browser. Try another, or add Tracely to Chrome.", "stopped");
    checkBtn.setAttribute("aria-disabled", "true");
    return;
  }
  wire();
  checkBtn.classList.add("invite");
  updateButton();
  refreshStatus();
})();
