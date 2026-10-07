/* The check cannot read a cited source, so it must not "correct" a cited
 * figure's wording to one it remembers. Owner, 2026-10-04, on: "…financial
 * investment in youth facilities has fallen by 73% between 2010/11 and
 * 2022/23 … ("Youth Matters: State of the Nation", 2025)." — flagged because
 * the figure is "youth services", when the cited report itself says
 * "facilities" (GOV.UK's strategy and press release say "services": one
 * department, one figure, two labels). */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "lib", "factcheck.js"), "utf8");

test("the check prompt judges a cited figure's number, years, place and direction — never its wording", () => {
  assert.match(SRC, /- You cannot read a cited source\. A cited figure you recall under a different label for the same measure \("services" or "facilities", "spending" or "investment"\) is not "false" or "questionable": judge its number, years, place and direction, never its wording\./);
});
