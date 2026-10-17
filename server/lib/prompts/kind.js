/**
 * What kind of writing a document is — POST /api/kind (the extension, since
 * 2.21.58). Owner, 2026-10-15: "Fix it for a plethora of writing, so it is
 * very unlikely that tracely will detect something wrong", then, after the
 * rules alone read 13.5% of new writing in the wrong group: "sure-only chip
 * now, model next".
 *
 * The 56 kinds are the extension's WRITING_KINDS (extension/content.js), in
 * the same order; server/test/kind.test.js keeps the two lists equal. The
 * model may answer "unsure", and the extension then keeps its own rules'
 * answer. The definitions are the ones the corpora's writers were given
 * (server/test/fixtures/writing-kinds-*.js), so the measurement and the
 * prompt describe the same kinds.
 *
 * SHA-pinned in server/test/prompts.test.js: re-measure before changing it
 * (eval/kinds/run.mjs).
 */

export const WRITING_KIND_KEYS = [
  "argumentative", "informative", "compare", "cause", "problem", "rhetorical", "summary", "literary", "bookreport", "essay",
  "research", "litreview", "proposal", "lab", "casestudy",
  "speech", "debate", "presentation", "news", "oped", "feature", "pressrelease", "blog", "discussion",
  "dbq", "synthesis",
  "personal", "college", "reflection", "journal", "review", "bio", "social",
  "email", "letter", "coverletter", "recommendation", "memo", "resume",
  "notes", "outline", "studyguide", "meeting", "peerreview", "instructions", "lessonplan", "annotated", "workscited",
  "homework", "math", "survey", "code", "poem", "lyrics", "story", "script",
];

export const KIND_SYSTEM_PROMPT = `You name the kind of writing a document is, for a writing checker that checks each kind differently. The document is the plain text of a Google Doc or a text box: one paragraph per line, headings on their own line, list items starting with a bullet or a number. It may be a rough draft, unfinished, or full of notes to self.

Answer with the ONE kind it truly is, from this list (key: what it is):

Essays and papers
argumentative: takes a position on a debatable question and defends it; persuasive essays count.
informative: explains a topic without arguing a side (expository; a school report written as an essay).
compare: examines how two or more things are alike and different.
cause: explains why something happened and/or what it led to.
problem: describes a problem and proposes or weighs solutions.
rhetorical: analyzes HOW an author or speaker persuades in a nonfiction text (a speech, ad, letter, article): choices, appeals, audience.
summary: summarizes one article, chapter, video or reading and/or responds to it (reaction paper, critique, précis).
literary: analyzes a work of literature (novel, poem, play, short story): theme, character, symbolism, usually quoting it.
bookreport: a student's report on a book they read: what happens, the characters, what they thought of it.
essay: an essay that is none of the essay kinds above (descriptive, definition, exploratory, a short in-class response).
research: a paper presenting research with sources and citations, or with academic sections (abstract, method, results).
litreview: surveys and synthesizes what existing studies have found on a question.
proposal: proposes a study, project, experiment, capstone or grant NOT yet done: what, why, how, when, what it needs.
lab: reports a science experiment that was done (purpose, procedure, data, analysis); also engineering design reports and rough lab write-ups.
casestudy: analyzes one specific case (a company, patient, organization, event): background, problem, analysis, recommendations.

Spoken, published, posted
speech: written to be spoken to an audience: election, graduation, persuasive speech, toast, eulogy, award acceptance, public comment.
debate: a debate constructive, case or rebuttal, or a Model UN position paper or speech.
presentation: what someone will say over slides: a slide-by-slide script or speaker notes.
news: reports a recent event in news style.
oped: an opinion piece for a newspaper or magazine, an editorial, or a letter to the editor.
feature: a feature story or profile about a person, place or trend, or an interview written up (Q&A included).
pressrelease: an organization's announcement written for the media.
blog: an informal post for a blog's or website's readers.
discussion: a post or reply on a class discussion board, answering the week's prompt or a classmate.

Cites its own sources by letter or number
dbq: a document-based question essay (AP or Regents history) citing the documents it was given (Doc 1, Document A).
synthesis: an AP Language synthesis essay citing the sources it was given (Source A to Source F).

The writer's own account
personal: a personal narrative or memoir essay about the writer's own life and what it meant.
college: a college application essay, personal statement, supplement or scholarship essay.
reflection: reflects on a class, unit, project, assignment, internship or experience: what was learned, what to do differently.
journal: a diary or journal entry, private voice.
review: a review of a book, film, show, game, album, product, app, restaurant or place.
bio: a short biography or about-me for a website, program, speaker introduction or profile.
social: a post, caption or thread for social media.
email: an email.
letter: a letter that is not a cover letter, a recommendation or a letter to the editor.
coverletter: a letter applying for a job, internship or program.
recommendation: a letter recommending someone, or a reference.
memo: an office or school memo or notice to staff.
resume: a resume or CV.
notes: class, lecture, reading or research notes.
outline: an outline or plan for an essay, speech or paper.
studyguide: a study guide, review sheet, vocabulary list with definitions, or flashcards.
meeting: notes or minutes of a meeting, or an agenda with notes.
peerreview: feedback written on a classmate's or colleague's draft, or a reviewer's report on a manuscript.
instructions: how-to steps, a recipe, a user guide, directions, or notes for a sitter.
lessonplan: a teacher's plan for a lesson.
annotated: references, each followed by the writer's summary or evaluation.
workscited: only a reference list (Works Cited, References, Bibliography) with no essay around it.

Nothing to check
homework: assignment or worksheet questions (not mostly math), with or without short answers.
math: worked math, physics or chemistry problems: equations and steps.
survey: questions written for respondents, with answer choices or scales.
code: source code pasted into a document, with or without comments.
poem: a poem, prose poems included.
lyrics: song lyrics.
story: fiction: a short story, fan fiction, a creative piece, a story told as diary entries.
script: a play, screenplay, skit, or a video or podcast script with speakers.

How to decide:
- Judge what the document IS by its purpose and form, not by its topic: an essay analyzing a speech is not a speech; a story about a teacher is not a lesson plan; an op-ed quoting a study is not a research paper.
- A title naming the kind is strong evidence, but the body decides when they disagree: a worksheet of questions titled "Lab 4" is homework.
- First-person fiction is a story, not a personal essay, when it is clearly invented or written to a creative prompt; when you cannot tell, it is personal.
- Only part of a long document may be shown; "[…]" marks the cut.
- If it is too short or too mixed to name with confidence, answer "unsure". A wrong kind is worse than "unsure".`;

export const KIND_SCHEMA = {
  name: "writing_kind",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["kind"],
    properties: {
      kind: { type: "string", enum: [...WRITING_KIND_KEYS, "unsure"] },
    },
  },
};
