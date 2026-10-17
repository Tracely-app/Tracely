import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DESKTOP_FEATURES } from './desktopFeatures.ts'

// Owner, 2026-10-13: "It shouldnt help with general writing tips either, so please
// remove writing tips in general." The desktop's writing help, off.
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('the writing help is off: grammar and style marks, off-topic marks, Tracer, the writing guides', () => {
  assert.deepEqual({ ...DESKTOP_FEATURES }, { proseMarks: false, offTopicMarks: false, tracerChat: false, writingGuides: false })
})

test('the editor reads every switch: no grammar marks, no off-topic call, no Tracer button or panel', () => {
  const src = read('../renderer/src/views/AnalyzeView.tsx')
  assert.match(src, /setProseMarks\(DESKTOP_FEATURES\.proseMarks \? measureProseMarks\(body, wrap\) : \[\]\)/)
  assert.match(src, /if \(!DESKTOP_FEATURES\.offTopicMarks \|\| !body \|\| !claims \|\| claims\.length === 0\) \{/)
  assert.match(src, /\{DESKTOP_FEATURES\.tracerChat \? \(\s*<button\s+className="docedit-tracer"/)
  assert.match(src, /\{DESKTOP_FEATURES\.tracerChat && tracerOpen \? \(/)
})

test('Home: no Tracer launcher, and only the guide about sources', () => {
  const src = read('../renderer/src/views/HomeView.tsx')
  assert.match(src, /GUIDES\.filter\(\(guide\) => DESKTOP_FEATURES\.writingGuides \|\| guide\.id === 'sources'\)/)
  assert.match(src, /\{DESKTOP_FEATURES\.tracerChat \? \(\s*<div className="home-tracer">/)
  assert.match(src, /\{DESKTOP_FEATURES\.tracerChat && tracerOpen \? <TracerChat/)
})
