/**
 * The citation fields /api/sources asks the model for, validated before they
 * reach a student's reference list.
 *
 * The model is told to copy only what the page states and to leave the rest
 * empty. This is what holds when it does not: a hostname or "Staff" in the
 * author slot, an organisation filed as a person (which a formatter would
 * turn into "Migration, I. O. F."), a date that is not a date, a future year,
 * a year and a date that disagree (one of them is a guess, and there is no
 * telling which), a DOI that is not one.
 *
 * Returns only what survives. A field the model answered but that failed, or
 * that the page did not state, comes back EMPTY ([] / "" / null) rather than
 * absent, so a client can tell "the page names no author" from "a server too
 * old to ask" (the extension's formatter keys its legacy path on exactly
 * that). A source with none of these fields — a harvested url_citation —
 * gets none back.
 */
import { capAuthors, contradictsTitle, isHostname, looksLikeOrg, PLACEHOLDER_NAME, splitNames } from "./citeMeta.js";

export const SOURCE_KINDS = ["institutional", "news", "reference", "journal", "book", "archive", "other"];
const KINDS = new Set(SOURCE_KINDS);

const loose = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const str = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const notAName = (a) => !a || PLACEHOLDER_NAME.test(a) || isHostname(a) || /^https?:|@|^www\./i.test(a);

/**
 * @param raw   one source object as the model wrote it
 * @param opts  { publisher, title, now } — the merged source's publisher and
 *              title (for the author/container and title-year checks)
 */
export function citeFields(raw, { publisher = "", title = "", now = new Date() } = {}) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;

  const kind = str(raw.kind, 20).toLowerCase();
  if (KINDS.has(kind)) out.kind = kind;

  // People, and the organisation credited when no person is.
  let group = str(raw.groupAuthor, 150);
  if (notAName(group)) group = "";
  const names = [];
  // The model was told these are people, so a surname like Press or Bank
  // stays a person; one entry naming several people is split.
  for (const n of (Array.isArray(raw.authors) ? raw.authors : []).flatMap((a) => splitNames(str(a, 400)))) {
    if (notAName(n) || n.length > 120 || n.split(" ").length > 6) continue;
    if (looksLikeOrg(n, { person: true })) {
      if (!group) group = n; // an organisation in the people list is the group author
      continue;
    }
    if (loose(n) === loose(group) || loose(n) === loose(publisher)) continue;
    if (!names.some((x) => loose(x) === loose(n))) names.push(n);
  }
  if (Array.isArray(raw.authors)) out.authors = capAuthors(names);
  if (group && !names.length) out.groupAuthor = group;
  else if (typeof raw.groupAuthor === "string") out.groupAuthor = "";

  // Year and date: real, not in the future, not contradicting each other or
  // a past year the title is about.
  const y = Number.isInteger(raw.year) ? raw.year : /^\d{4}$/.test(String(raw.year ?? "").trim()) ? Number(String(raw.year).trim()) : null;
  const dm = str(raw.date, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let date = null;
  if (dm) {
    const d = new Date(Date.UTC(+dm[1], +dm[2] - 1, +dm[3]));
    const real = d.getUTCFullYear() === +dm[1] && d.getUTCMonth() === +dm[2] - 1 && d.getUTCDate() === +dm[3];
    if (real && +dm[1] >= 1500 && d.getTime() <= now.getTime() + 36 * 3600_000) date = dm[0];
  }
  const answered = "year" in raw || "date" in raw;
  if (date && contradictsTitle(Number(date.slice(0, 4)), title, now)) date = null;
  if (date && y != null && y !== Number(date.slice(0, 4))) {
    // The model contradicting itself (year 2021, date 2020-04-09) is a guess somewhere: keep neither.
    out.year = null;
  } else if (date) {
    out.date = date;
    out.year = Number(date.slice(0, 4));
  } else if (y != null && y >= 1500 && y <= now.getUTCFullYear() && !contradictsTitle(y, title, now)) {
    out.year = y;
  } else if (answered) {
    out.year = null;
  }

  const doi = str(raw.doi, 200).replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, "");
  if (/^10\.\d{4,9}\/\S+$/.test(doi)) out.doi = doi;

  // The larger work — never the publisher restated — and its editors, which
  // mean nothing without it.
  const container = str(raw.container, 200);
  if (container && loose(container) !== loose(publisher) && loose(container) !== loose(title)) out.container = container;
  if (out.container) {
    const eds = (Array.isArray(raw.editors) ? raw.editors : []).flatMap((a) => splitNames(str(a, 400)))
      .filter((a) => !notAName(a) && a.length <= 120 && !looksLikeOrg(a, { person: true }));
    if (eds.length) out.editors = [...new Set(eds)].slice(0, 10);
  }
  return out;
}
