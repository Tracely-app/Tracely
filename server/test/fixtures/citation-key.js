/* The owner's twenty-sentence test sheet and its answer key (2026-10-15),
 * each sentence with the key's class. Tracely's answers on it before this
 * file: 11 of 20 (the check's own verdicts, one run against production).
 * "wrong-citation" is the wrong-source check's (lib/citeFit.js);
 * "missing-citation" with a named organisation is the extension's
 * "Source not cited" (citationHygieneTips, orgCredited). */
export const CITATION_KEY = [
  { n: 1, key: "correct", text: "A 2023 report by the Organisation for Economic Co-operation and Development found that average mathematics performance across OECD countries declined by nearly 15 points between the 2018 and 2022 PISA assessments (OECD, 2023)." },
  { n: 2, key: "false", text: "Researchers have demonstrated that the human brain completely stops forming new neural connections after age 18, making it biologically impossible for adults to develop new cognitive abilities." },
  { n: 3, key: "missing-citation", text: "The Centers for Disease Control and Prevention recommends that teenagers between the ages of 13 and 17 receive approximately 8 to 10 hours of sleep each night." },
  { n: 4, key: "wrong-citation", text: "Venus requires approximately 243 Earth days to complete one rotation, meaning that its rotational period is longer than its orbital period of approximately 225 Earth days (OECD, 2023)." },
  { n: 5, key: "missing-citation", text: "Although artificial intelligence can produce convincing academic explanations, the accuracy of its responses varies depending on the question, model, and available information. Therefore, students should verify important AI-generated claims against reliable sources." },
  { n: 6, key: "correct", text: "A 2023 UNESCO publication emphasized the importance of human-centered approaches, privacy protections, and age-appropriate safeguards when implementing generative artificial intelligence in education (Miao & Holmes, 2023)." },
  { n: 7, key: "false", text: "A comprehensive analysis of student performance concluded that every student who used artificial intelligence for at least 30 minutes daily experienced a measurable increase in intelligence, regardless of how the technology was used." },
  { n: 8, key: "wrong-citation", text: "The 2022 PISA assessment measured the mathematical, reading, and scientific literacy of 15-year-old students across participating education systems (NASA, 2023)." },
  { n: 9, key: "false", text: "Scientific research has established that students who regularly sleep fewer than six hours per night develop stronger long-term memory than students who consistently receive adequate sleep." },
  { n: 10, key: "correct", text: "Singapore achieved a mathematics score of 575 points in the 2022 PISA assessment, placing it above every other participating education system (OECD, 2023)." },
  { n: 11, key: "missing-citation", text: "The greenhouse effect contributes to Venus having a higher average surface temperature than Mercury, despite Mercury being closer to the Sun." },
  { n: 12, key: "overstated", text: "The OECD reported that average mathematics performance declined between the 2018 and 2022 PISA assessments, demonstrating that the COVID-19 pandemic was entirely responsible for the deterioration in educational outcomes." },
  { n: 13, key: "correct", text: "The American Academy of Sleep Medicine recommends that adolescents aged 13 to 18 sleep between 8 and 10 hours per 24-hour period (CDC, 2024)." },
  { n: 14, key: "wrong-citation", text: "Venus rotates in the opposite direction from Earth, causing the Sun to rise in the west and set in the east on Venus (CDC, 2024)." },
  { n: 15, key: "false", text: "All students who use AI-generated explanations instead of textbooks demonstrate superior critical-thinking skills, and no academic research has identified any limitations associated with AI-assisted learning." },
  { n: 16, key: "missing-citation", text: "In 2023, UNESCO published guidance addressing the educational opportunities and potential risks associated with generative artificial intelligence." },
  { n: 17, key: "overstated", text: "Because the OECD identified an association between digital distractions and lower mathematics performance, eliminating all digital devices from classrooms would necessarily improve every student's academic achievement." },
  { n: 18, key: "overstated", text: "The 2022 PISA assessment reported that Singapore performed significantly above all other participating education systems in mathematics, reading, and science (OECD, 2023)." },
  { n: 19, key: "wrong-citation", text: "The human brain retains the ability to adapt through learning and experience, a process commonly described as neuroplasticity (NASA, 2023)." },
  { n: 20, key: "overstated", text: "Research on adolescent sleep indicates that insufficient sleep can interfere with attention and academic performance, proving that students who receive exactly eight hours of sleep will always outperform students who receive seven hours." },
];

// The sheet as one document, a sentence to a paragraph.
export const CITATION_KEY_DOC = CITATION_KEY.map((x) => x.text).join("\n");
