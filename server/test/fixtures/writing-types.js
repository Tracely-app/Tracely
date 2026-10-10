/* Writing-type corpus for content.js detectGenre (server/test/ext-writing-types.test.js).
 * Every text is invented for this file; quotations come only from public-domain works. */
export const WRITING_TYPES = [
  // ───────────────────────────── dbq ─────────────────────────────
  {
    name: "AP World DBQ, industrialization, prompt pasted, teacher heading",
    expect: "dbq",
    text: `Jordan Lee
Mr. Patel
AP World History
12 March 2025

Evaluate the extent to which industrialization changed the lives of working people in the period 1750–1900. Using the documents and your knowledge of world history, develop an argument in response to the prompt.

Between 1750 and 1900, industrialization spread from Great Britain to Western Europe, the United States, Russia and Japan. While it eventually brought higher wages and new political power for some workers, industrialization changed the lives of working people to a great extent, because it moved them off the land and into factories and crowded cities, put their days under the control of the clock and the machine, and pulled women and children into wage labor outside the home.

The biggest change was in how people worked. Before the factory system most families worked together on farms or spun and wove at home, setting their own pace. Document 1, testimony given to a parliamentary committee in 1832, describes a girl who began working in a flax mill at six years old and stood at the machines from five in the morning until nine at night (Doc 1). The girl was testifying to a committee that wanted to limit child labor, so she may have been encouraged to emphasize the worst parts of her experience, but Parliament's passage of the Factory Act of 1833 suggests that conditions like hers were common. Document 3 adds that the rules of a Berlin machine works fined workers for arriving even a few minutes late and for talking on the job (Doc 3). The purpose of these rules was to make workers as regular as the machines they ran. Time itself became something the owner controlled.

Industrialization also changed where working people lived. Manchester grew from roughly 25,000 people in the 1770s to more than 300,000 by 1850, and most of the newcomers crowded into housing that was built quickly and cheaply. In Document 2, Friedrich Engels describes streets without drainage and whole families sharing a single room near the mills (Doc 2). Engels was a socialist writing to expose what he saw as the cruelty of capitalism, so he chose the worst neighborhoods to describe. Even so, Edwin Chadwick's 1842 report on sanitary conditions, which was written for the government and not for a political movement, found that laborers in industrial towns died far younger than people in the countryside.

Women and children were drawn into wage work in new ways. Document 6 is a report on a Japanese silk-reeling mill in the 1890s showing that most of the workers were teenage girls from farming villages who sent their wages home (Doc 6). This shows that industrialization did not completely destroy the old family economy, since the girls still worked for their families, but it took them away from home for years at a time. In Document 6, the author, a government inspector, seems more concerned with output than with the girls' health, which reflects the Meiji government's goal of building industry as fast as possible.

However, the change was not total, and workers were not simply victims. Document 4, a poster from the London Dock Strike of 1889, calls on all dockers to stop work until they are paid sixpence an hour (Doc 4), showing that workers organized to win better conditions. Outside the documents, the Reform Act of 1867 gave the vote to many urban working men in Britain. Document 5 also shows the limits of industrialization: a petition from Russian peasants in 1890 complains about land payments and taxes, not factories (Doc 5), because most Russians were still farmers at the end of the century.

In conclusion, industrialization transformed the lives of working people wherever it took hold by changing where they worked, how they spent their time and where they lived. In regions like rural Russia the change came slowly, but by 1900 the factory, the city and the clock had replaced the farm and the seasons for millions of workers.`,
    why: "Prompt pasted at top ('Evaluate the extent… Using the documents'), dense (Doc N) citations plus sourcing; outside evidence uncited.",
  },
  {
    name: "APUSH DBQ, causes of the Revolution, no prompt, no heading",
    expect: "dbq",
    text: `In the years after the French and Indian War, the relationship between Great Britain and its North American colonies fell apart in little more than a decade. Although Britain's new taxes are usually seen as the main reason for the American Revolution, the most important cause was the colonists' growing belief that Parliament had no right to govern them at all, a belief that grew out of the tax disputes but went far beyond them. Economic grievances started the conflict, but ideas about representation and self-government turned protest into independence.

Britain's decision to tax the colonies came directly from the cost of the French and Indian War. The war nearly doubled Britain's national debt, and Parliament believed the colonists should pay their share of the cost of defending them. Document 1, a letter from George Grenville in 1764, argues that the colonies had been protected at great expense and ought to contribute to their own defense (Document 1). Grenville's point of view as the minister responsible for the treasury explains why he saw the issue only in terms of money. The Proclamation of 1763, shown on the map in Document 2, made things worse by closing the land west of the Appalachians to settlement (Document 2). Colonists who had fought to open the Ohio Valley felt that Britain was taking away the reward they had earned.

These economic grievances quickly became arguments about rights. Document 3 shows the resolutions of the Stamp Act Congress in 1765, which state that the colonists could not be taxed except by their own representatives because they were not represented in Parliament (Document 3). What matters here is that delegates from nine colonies agreed on a single argument for the first time. Boycotts organized by groups like the Sons of Liberty made the Stamp Act so unprofitable that Parliament repealed it in 1766, but on the same day it passed the Declaratory Act, claiming the power to make laws for the colonies "in all cases whatsoever." The colonists won the fight over the tax but lost the argument about authority.

Violence after 1768 hardened opinion on both sides. Paul Revere's engraving of the Boston Massacre (Document 4) shows British soldiers firing in a neat line on peaceful citizens, even though the real event was a confused street brawl. Revere's purpose was propaganda, and it worked: the image spread through every colony and made the soldiers look like an army of occupation. By contrast, Document 5, a letter from a British officer stationed in Boston, describes the townspeople as a mob that insulted the troops and threw ice and oyster shells at them (Document 5). Read together, the two documents show each side beginning to see the other as the aggressor. After the Boston Tea Party in 1773, Parliament passed the Coercive Acts, which closed Boston Harbor and convinced many colonists outside Massachusetts that their own liberties could be next.

By 1776 the debate was no longer about taxes. In Document 6, Thomas Paine argues that "there is something very absurd, in supposing a continent to be perpetually governed by an island." Common Sense sold more than 100,000 copies in a few months, and Paine's plain language persuaded ordinary colonists that the king himself, not just Parliament, was the problem. The Declaration of Independence (Document 7) lists taxation without consent among its grievances, but most of its complaints concern the king's refusal to let the colonists govern themselves.

The taxes imposed after 1763 opened the conflict between Britain and its colonies, but they were not enough by themselves to cause a revolution. What made independence possible was the idea, built up through the Stamp Act crisis, the Boston Massacre and Common Sense, that Americans had the right to rule themselves.`,
    why: "No prompt and no heading; keys on '(Document N)' and 'Document 3 shows' with HIPP sourcing; one public-domain quote.",
  },
  {
    name: "DBQ Project essay, Dust Bowl, documents A–F named only in prose",
    expect: "dbq",
    text: `The Dust Bowl: Who or What Was to Blame?

Ava Martinez
Period 4
U.S. History

During the 1930s, huge dust storms rolled across the southern Great Plains, burying fences, killing livestock and forcing thousands of families to leave their farms. Some people blamed the weather, but the evidence shows that the Dust Bowl was caused mainly by people, because farmers plowed up the grasslands that held the soil in place and then kept planting wheat even after prices and rainfall dropped. The drought made it worse, but it was not the main cause.

The first reason the Dust Bowl was caused by people is that farmers destroyed the native grass. Document A is a map that shows the area that was hit the hardest, which included parts of Oklahoma, Texas, Kansas, Colorado and New Mexico. Document B shows how much land was planted in wheat, and it went up from a few million acres before World War I to more than 20 million acres by the late 1920s. During the war wheat prices were really high, so farmers bought tractors and plowed as much land as they could. The grass that used to be there had deep roots that held the soil down even when it was dry. Once the grass was gone there was nothing to hold the dirt when the wind came.

The second reason is that farmers kept plowing even when it was not making money. Document C is a newspaper article from 1931 that says wheat had dropped to around thirty cents a bushel. You would think farmers would plant less, but the article says a lot of them planted more so they could make up the difference and pay off their bank loans. This shows that the economy pushed farmers to overuse the land even more. In Document D there is a photograph of a farmer driving a tractor across a field with nothing growing on it, and dust is already blowing up behind him.

Some people would argue that nature was to blame. Document E is a chart of rainfall that shows the 1930s were much drier than normal, with some years getting less than half the usual rain. This is true, but Document E also shows that the Plains had droughts before, in the 1890s and the 1910s, and there were no dust storms like the ones in the 1930s. The difference was that during the earlier droughts the grass was still there.

Finally, the government itself decided the problem was caused by farming. Document F comes from a report by the Soil Conservation Service in 1936, and it says the land had been plowed in ways that did not fit the climate. The government started paying farmers to plant grass again and to plow along the contours of the land, and when they did, the storms got less severe. If the Dust Bowl had only been caused by the weather, changing the way farmers plowed would not have helped.

In conclusion, the drought was the spark, but people made the Dust Bowl. By plowing up the grasslands and planting too much wheat, farmers removed the one thing that protected the soil. The Dust Bowl is a reminder that how we use the land matters as much as the weather.`,
    why: "Tricky: no parenthetical citations at all, documents referred to only as 'Document A… Document F' in prose; middle-school voice.",
  },
  {
    name: "AP Euro DBQ, Reformation, lettered docs '(Doc. B)' and 'In Document F, the author'",
    expect: "dbq",
    text: `Sam Okafor
Ms. Brandt
AP European History
4 November 2025

Reformation DBQ

When Martin Luther posted his Ninety-five Theses in 1517, he presented his challenge to the Church as a purely religious matter. Yet the Reformation spread across the Holy Roman Empire as quickly as it did because German princes, cities and even peasants saw political and economic advantages in breaking with Rome. While religious conviction drove reformers like Luther, the success of the Protestant Reformation was caused mainly by political factors, since rulers adopted Protestantism to gain independence from the pope and the emperor and to take control of Church wealth.

Religious grievances were real and gave the movement its first energy. Luther's attack on indulgences answered genuine anger at what looked like the sale of salvation, and a woodcut contrasting Christ driving the moneychangers from the temple with the pope selling indulgences (Doc. A) shows how reformers used images to reach people who could not read. The artist, who worked with Luther's circle in Wittenberg, meant to present the pope as the opposite of Christ. Similarly, a villager's complaint that the local priest neglects his duties while collecting tithes (Doc. C) shows that ordinary believers resented clerical corruption long before 1517.

But the reformers could not have survived without political protection. After the Diet of Worms declared Luther an outlaw in 1521, Frederick the Wise of Saxony hid him at the Wartburg. Doc. B, a letter from a Saxon councilor, advises the elector that supporting Luther would weaken the emperor's authority in Saxony and keep German money from flowing to Rome. The councilor's purpose was to tell his prince what was useful, not what was true, which makes his reasoning especially revealing. In Document D, the author, an imperial diplomat, reports to Charles V that several princes are using the new faith as a pretext to seize monasteries and their lands. Because the diplomat served Charles, he had every reason to portray the Lutheran princes as greedy rather than sincere, but the seizure of Church property in Protestant territories shows his observation was not invented.

The English Reformation makes the political motive even clearer. Henry VIII had written against Luther in 1521, but when the pope refused to annul his marriage, Parliament passed the Act of Supremacy in 1534 making the king head of the Church of England. The dissolution of the monasteries that followed transferred enormous amounts of land to the crown and its supporters, and Doc. E, a list of former abbey lands granted to royal courtiers, shows exactly who benefited.

The limits of religious motivation appear in the German Peasants' War of 1524–1525. The peasants' Twelve Articles (Doc. F) used Luther's language of Christian freedom to demand an end to serfdom. In Document F, the author ties spiritual freedom directly to freedom from the lords, but Luther rejected that reading and urged the princes to crush the revolt. A movement that turned against the peasants who took its ideas most literally was one whose survival depended on the princes. Finally, the Peace of Augsburg in 1555 (Doc. G) let each ruler choose the religion of his territory, cuius regio, eius religio, treating faith as something a prince decided for his subjects.

In conclusion, religious anger created the Reformation, but politics determined where it succeeded. Princes, kings and city councils embraced Protestantism when it strengthened their power and filled their treasuries, and they abandoned reformers whose ideas threatened the social order.`,
    why: "Lettered documents in parentheses '(Doc. B)' and prose 'In Document F, the author'; heading block, no prompt pasted.",
  },

  // ─────────────────────────── research ───────────────────────────
  {
    name: "APA student study with Abstract/Introduction/Method/Results/Discussion/References",
    expect: "research",
    text: `Sleep Duration and Quiz Performance Among High School Juniors

Abstract
This study examined whether the number of hours students slept the night before a quiz was related to their quiz scores. Fifty-eight juniors at a suburban public high school completed an anonymous survey reporting their sleep on the night before a scheduled chemistry quiz, and their scores were matched by a teacher using a random code. Students who slept seven or more hours scored higher on average than students who slept fewer than six hours, and sleep duration was moderately correlated with score, r(56) = .34, p = .009. These findings are consistent with prior research linking sleep to memory consolidation (Hirano & Wells, 2018) and suggest that schools should consider sleep when scheduling assessments.

Introduction
Adolescents need between eight and ten hours of sleep per night, yet most high school students report sleeping less than seven (Okafor et al., 2020). Sleep loss has been associated with slower reaction times, lower mood and reduced attention in class (Delgado & Price, 2017). Laboratory studies have also shown that sleep after learning helps move new information into long-term memory (Hirano & Wells, 2018; Sorensen, 2021). Fewer studies, however, have looked at the night before a test, when many students stay up late to study. Some researchers argue that last-minute studying may offset the cost of lost sleep (Brandt, 2019), while others have found no benefit to cramming (Nguyen & Castillo, 2022). The present study asked whether juniors who slept more the night before a quiz scored higher than those who slept less.

Method
Participants
Participants were 58 eleventh-grade students (31 female, 26 male, 1 nonbinary) enrolled in three sections of honors chemistry. Participation was voluntary and parental consent was obtained.
Materials and Procedure
On the morning of a scheduled 20-point quiz, students completed a five-item survey asking what time they went to sleep, what time they woke up, and how many minutes they had studied the previous evening. Sleep duration was calculated from bedtime and wake time. Quiz scores were converted to percentages.

Results
Mean sleep duration was 6.4 hours (SD = 1.1). Students who slept seven or more hours (n = 21) had a mean quiz score of 84.2% (SD = 9.6), compared with 74.9% (SD = 12.3) for students who slept fewer than six hours (n = 17). A Pearson correlation found a moderate positive relationship between sleep duration and quiz score, r(56) = .34, p = .009. Minutes spent studying the night before were not significantly related to score, r(56) = .11, p = .41.

Discussion
The results support the hypothesis that more sleep before a quiz is associated with better performance. The lack of a relationship between study time and score suggests that staying up later to study did not make up for lost sleep, which agrees with Nguyen and Castillo (2022). Because the study was correlational, it cannot show that sleep caused higher scores; students who are more organized may both sleep more and study earlier in the week. The sample was also small and drawn from a single school. Future research could follow the same students across several quizzes.

References
Brandt, L. (2019). Cramming and recall in secondary students. Journal of Adolescent Learning, 14(2), 55–67.
Delgado, R., & Price, M. (2017). Sleep restriction and classroom attention. Sleep and Youth, 9(1), 12–24.
Hirano, K., & Wells, T. (2018). Sleep-dependent memory consolidation in adolescents. Developmental Cognition, 22(4), 301–315.
Nguyen, A., & Castillo, J. (2022). Does last-minute studying pay off? Educational Psychology Quarterly, 31(3), 188–201.
Okafor, C., Lin, S., & Meyer, D. (2020). Sleep patterns in American high school students. Journal of School Health Research, 40(6), 422–430.
Sorensen, P. (2021). The sleeping brain and new learning. Cognitive Science Review, 17(1), 3–19.`,
    why: "Textbook APA paper: Abstract/Method/Results/Discussion headings, (Author, Year) citations, statistics, References list.",
  },
  {
    name: "High-school research paper, no section headings, author-year + References",
    expect: "research",
    text: `Maya Thompson
Environmental Science
Mrs. Okonkwo
February 6, 2025

Microplastics in the Water We Drink

Every time someone fills a glass from the tap or opens a bottle of water, they are probably drinking tiny pieces of plastic. Microplastics are plastic particles smaller than five millimeters, and they come from larger plastic items that break down, from synthetic clothing fibers and from tire wear (Lindqvist, 2019). Researchers have found them in oceans, rivers, soil and even the air. Over the past ten years scientists have started asking whether these particles are also in our drinking water and what they might be doing to our bodies.

Studies show that microplastics are common in both tap and bottled water. In a survey of tap water from a dozen countries, researchers found plastic fibers in more than three-quarters of the samples (Halvorsen et al., 2018). Bottled water may be even worse. One analysis of more than two hundred bottles from eleven brands found particles in almost all of them, and the average bottle contained more particles than the average glass of tap water (Ibarra & Cole, 2018). The researchers suggested that some of the plastic came from the bottle and cap themselves during packaging (Ibarra & Cole, 2018). Newer methods that can detect even smaller particles, called nanoplastics, have found far higher counts than earlier studies did (Moreau & Tan, 2021).

Scientists are less certain about what this means for human health. The World Health Organization (2019) concluded that there was not enough evidence to say that microplastics in drinking water pose a health risk at the levels found, but it also called for more research. Laboratory studies on animals have shown that very small particles can cross the lining of the gut and cause inflammation (Rahman & Feld, 2020). Plastics can also carry chemicals like BPA and phthalates, which can interfere with hormones (Greer, 2017). Because people are exposed to so many other sources of plastic, it is hard to separate the effect of drinking water from everything else (Lindqvist, 2019).

Water treatment removes a large share of microplastics, but not all of them. Conventional treatment plants that use coagulation and sand filtration remove between 70 and 90 percent of particles, depending on their size (Okeke et al., 2020). Membrane filtration removes even more, but it is expensive, and many small towns cannot afford it (Okeke et al., 2020). Home filters vary widely in how well they work (Patel, 2022).

The most effective solution is to reduce the amount of plastic entering the environment in the first place. Some countries have banned microbeads in cosmetics, and the United States passed the Microbead-Free Waters Act in 2015 (Greer, 2017). Filters on washing machines that catch clothing fibers could also make a difference, since a single load of laundry can release hundreds of thousands of fibers (Rahman & Feld, 2020). Until scientists know more, cutting plastic use is the safest choice for both the environment and our health.

References
Greer, H. (2017). Plastic additives and endocrine disruption. Environmental Health Today, 12(3), 44–52.
Halvorsen, B., Diaz, R., & Kemp, L. (2018). Plastic fibers in global tap water. Water Quality Letters, 6(2), 101–110.
Ibarra, S., & Cole, J. (2018). Particle contamination in bottled water. Frontiers in Water Chemistry, 4, 407.
Lindqvist, A. (2019). Sources and fate of microplastics. Marine and Freshwater Review, 33(1), 1–19.
Moreau, C., & Tan, W. (2021). Detecting nanoplastics in drinking water. Analytical Water Science, 9(4), 220–233.
Okeke, U., Barros, P., & Lund, M. (2020). Microplastic removal in conventional treatment plants. Journal of Water Treatment, 18(5), 512–526.
Patel, R. (2022). How well do household filters remove microplastics? Consumer Science Reports, 2(1), 14–21.
Rahman, F., & Feld, D. (2020). Gut uptake of plastic particles in mammals. Toxicology Frontiers, 15(2), 88–97.
World Health Organization. (2019). Microplastics in drinking-water. World Health Organization.`,
    why: "Tricky: no Abstract/Methods headings, reads like an essay, but nearly every claim carries (Author, Year) and it ends in References.",
  },
  {
    name: "MLA research paper on music and studying, Works Cited",
    expect: "research",
    text: `Elena Ruiz
Mr. Dawson
English 11
28 April 2025

Does Music Help Students Study?

Walk into any school library and you will see students with earbuds in, working through homework while listening to music. Many of them insist that music helps them focus, but research on the subject is mixed. Studies suggest that the effect of music on concentration depends on the type of music, the type of task and the personality of the listener, and that for most reading and memorization tasks, silence is still better.

The idea that music makes people smarter became popular in the 1990s after a study suggested that listening to Mozart briefly improved spatial reasoning. Later researchers had trouble reproducing the effect, and most now believe any improvement came from being in a better mood or more alert rather than from the music itself (Fowler 23). This "arousal and mood" explanation helps account for why upbeat music can sometimes help with simple tasks. In one experiment, participants who listened to fast, cheerful music before a test of processing speed outperformed those who sat in silence (Ramirez 44).

Listening during a task is different from listening before it. When participants in a study by Chen and Abrams had to read passages and answer comprehension questions, those who listened to music with lyrics scored about twenty percent lower than those who worked in silence (112). The researchers argue that lyrics compete with the words on the page for the same part of working memory (Chen and Abrams 115). Instrumental music caused a smaller drop, and in some conditions no drop at all (Chen and Abrams 116). Similarly, a survey of college students found that those who studied with music on reported feeling more productive, even though their test scores did not improve (Okoro 9).

Personality also seems to matter. Introverts appear to be more easily distracted by background noise than extroverts, who may need more stimulation to stay alert (Lindgren and Shah 78). A student who is easily bored might therefore benefit from quiet instrumental music, while another student might find the same music distracting (Lindgren and Shah 81). Familiarity matters too: songs that students already know well seem to demand less attention than new ones ("Sound and Focus").

Taken together, these studies suggest that students should be careful about how they use music. For tasks like math practice or organizing notes, quiet instrumental music may improve mood without hurting performance (Ramirez 47). For reading, writing and memorizing, however, the evidence points toward silence, or at least music without words (Fowler 30). The best study playlist may be the one students turn off when it matters most.

Works Cited
Chen, Lily, and Mark Abrams. "Lyrics and Reading Comprehension in Young Adults." Journal of Applied Cognition, vol. 18, no. 2, 2019, pp. 108–120.
Fowler, Grace. Sound Minds: Music and the Myth of the Smarter Brain. Halden Press, 2016.
Lindgren, Erik, and Priya Shah. "Personality and Distraction During Study." Educational Psychology Today, vol. 7, no. 1, 2021, pp. 70–85.
Okoro, Daniel. "Student Beliefs About Studying with Music." Campus Learning Quarterly, vol. 3, no. 4, 2020, pp. 1–14.
Ramirez, Sofia. "Tempo, Mood, and Processing Speed." Music and Mind, vol. 11, 2018, pp. 40–52.
"Sound and Focus: What the Research Says." Learning Lab, 3 Mar. 2022, www.learninglab.example.org/sound-and-focus.`,
    why: "MLA (Author page) citations in nearly every sentence reporting studies and participants, plus Works Cited; no section headings.",
  },
  {
    name: "College literature review with Literature Review/Methods/Findings/Limitations headings",
    expect: "research",
    text: `Urban Tree Canopy and Summer Surface Temperatures: A Review of Recent Evidence

Introduction
Cities are consistently warmer than the rural areas around them, a pattern known as the urban heat island (UHI) effect. Dark roofs, pavement and a lack of vegetation absorb solar radiation during the day and release it at night, raising both surface and air temperatures (Oke et al., 2017). As heat waves become more frequent, the UHI effect has become a public health concern (Grant & Muller, 2021). Planting trees is one of the most commonly proposed responses, but estimates of how much cooling trees provide vary widely. This paper reviews recent studies of the relationship between tree canopy cover and summer surface temperatures in mid-sized U.S. cities.

Literature Review
Early remote-sensing studies established a negative relationship between vegetation and land surface temperature (LST). Using Landsat imagery, Ferreira and Holt (2015) found that each 10% increase in canopy cover within a neighborhood was associated with a decrease of 0.8–1.2 °C in afternoon LST. Later work showed that the relationship is not linear. Ziegler et al. (2019) reported that cooling increased sharply once canopy cover exceeded about 40%, suggesting that scattered street trees provide less benefit than continuous canopy. Others have emphasized species and irrigation; in arid cities, irrigated trees cooled their surroundings far more than drought-tolerant species did (Abara & Nolan, 2020).

The distribution of canopy also raises equity concerns. Neighborhoods that were redlined in the 1930s have, on average, less tree cover and higher summer temperatures today than neighborhoods that were not (Whitfield et al., 2020). Grant and Muller (2021) argue that planting programs should prioritize these areas, although they note that new trees take fifteen to twenty years to provide full shade.

Methods
Studies were identified through database searches using the terms "urban heat island," "tree canopy," and "land surface temperature," limited to peer-reviewed articles published between 2014 and 2023. Of 63 articles screened, 19 met the inclusion criteria: they examined at least one U.S. city with a population between 100,000 and 1,000,000 and reported a quantitative relationship between canopy and temperature.

Findings
Across the 19 studies, the median reported cooling was 0.9 °C per 10% increase in canopy cover (range 0.3–2.1 °C). Cooling was strongest in hot, dry cities and weakest in humid ones (Abara & Nolan, 2020; Lee & Pardo, 2022). Eleven studies measured surface temperature only; the four that measured air temperature found smaller effects, typically less than half the surface difference (Lee & Pardo, 2022).

Limitations
Most studies relied on satellite surface temperature, which is not the temperature people actually experience. Few controlled for building density, and none followed the same neighborhoods over time as their canopy changed.

Conclusion
The evidence consistently shows that tree canopy lowers summer surface temperatures, but the size of the effect depends on climate, canopy density and measurement method. Cities that plan to use trees against extreme heat should aim for continuous canopy in the hottest neighborhoods and should measure air temperature, not only surface temperature.

References
Abara, J., & Nolan, K. (2020). Irrigation, species choice, and cooling in arid cities. Urban Climate Studies, 8(2), 141–158.
Ferreira, L., & Holt, D. (2015). Canopy cover and land surface temperature in the Midwest. Landscape and Urban Planning Letters, 4(1), 22–35.
Grant, S., & Muller, E. (2021). Extreme heat and urban health. Journal of Public Health Geography, 15(3), 210–227.
Lee, H., & Pardo, M. (2022). Surface versus air temperature in canopy studies. Applied Urban Meteorology, 6(4), 377–392.
Oke, T. R., Mills, G., Christen, A., & Voogt, J. A. (2017). Urban climates. Cambridge University Press.
Whitfield, R., Adeyemi, O., & Barnes, C. (2020). Historical redlining and present-day heat exposure. Environmental Justice Review, 11(1), 1–17.
Ziegler, P., Han, Y., & Brooks, A. (2019). Nonlinear cooling from urban canopy. Remote Sensing of Cities, 2(3), 88–104.`,
    why: "Literature review: Literature Review/Methods/Findings/Limitations headings, 'et al.' and narrative citations 'Ferreira and Holt (2015)', References.",
  },
  // ───────────────────────────── lab ─────────────────────────────
  {
    name: "Chemistry titration lab, full headings Purpose→Sources of Error",
    expect: "lab",
    text: `Determining the Concentration of Acetic Acid in Vinegar by Titration
Chemistry Honors – Period 2
Lab partners: Daniel Kim, Rosa Alvarez
October 2, 2025

Purpose
To determine the molarity and percent acetic acid of a sample of store-bought white vinegar by titrating it with a standardized sodium hydroxide solution.

Hypothesis
If the vinegar is labeled as 5% acidity, then the titration will show an acetic acid concentration of about 0.83 M, because 5.0 g of acetic acid per 100 mL is 0.83 mol per liter.

Materials
- 50 mL buret and buret clamp
- ring stand
- 0.500 M NaOH (standardized)
- white vinegar
- 10.00 mL volumetric pipet and pipet bulb
- three 250 mL Erlenmeyer flasks
- phenolphthalein indicator
- distilled water, wash bottle
- white paper

Procedure
1. Rinse the buret with distilled water and then with two small portions of the NaOH solution.
2. Fill the buret with 0.500 M NaOH and record the initial volume to the nearest 0.01 mL.
3. Pipet 10.00 mL of vinegar into a clean Erlenmeyer flask and add about 50 mL of distilled water.
4. Add 3 drops of phenolphthalein.
5. Titrate with NaOH while swirling until a faint pink color lasts for 30 seconds.
6. Record the final buret reading.
7. Repeat for a total of three trials.

Data
Trial 1: initial 0.50 mL, final 17.30 mL, volume NaOH used 16.80 mL
Trial 2: initial 17.30 mL, final 34.25 mL, volume NaOH used 16.95 mL
Trial 3: initial 0.85 mL, final 17.55 mL, volume NaOH used 16.70 mL
Average volume of NaOH: 16.82 mL
Observations: the solution stayed clear until about 16 mL, then each drop made a pink swirl that faded. Trial 2 ended a darker pink than the others.

Calculations
mol NaOH = 0.500 mol/L × 0.01682 L = 8.41 × 10^-3 mol
mol CH3COOH = mol NaOH = 8.41 × 10^-3 mol (1:1 ratio)
Molarity of acetic acid = 8.41 × 10^-3 mol ÷ 0.01000 L = 0.841 M
Mass per 100 mL = 0.841 mol/L × 60.05 g/mol × 0.100 L = 5.05 g → 5.05% (m/v)
Percent error = |0.841 − 0.833| ÷ 0.833 × 100 = 0.96%

Conclusion
The average concentration of acetic acid in the vinegar was 0.841 M, or about 5.05 g per 100 mL, which supports our hypothesis that the label's 5% value is accurate. Our percent error was about 1.0%, which is small. The result was probably a little high because we overshot the endpoint in trial 2, which is why that trial used the most NaOH and ended darker pink.

Sources of Error
Overshooting the endpoint adds extra NaOH and makes the calculated molarity too high. Reading the meniscus from slightly above or below eye level could change each reading by about 0.05 mL. If the buret was not completely rinsed with NaOH, leftover water would dilute it and also make our answer too high. Next time we would add NaOH drop by drop once the pink started to linger.`,
    why: "Classic lab: Purpose/Hypothesis/Materials/Procedure/Data/Calculations/Conclusion, mL and M units, 'we overshot'.",
  },
  {
    name: "Physics pendulum lab, inline 'Heading:' labels, 'our group', table rows",
    expect: "lab",
    text: `Pendulum Lab Report
Physics 1 – Mr. Hargrove
Names: Tyler Brooks, Aaliyah Grant, Ben Cho
Date: September 18, 2025

Objective: Find out how the length of a pendulum, the mass of the bob, and the starting angle affect the period of a pendulum.

Hypothesis: We think length will affect the period the most. If the string is longer, then the period will be longer because the bob has farther to travel. We think mass will not affect the period and the angle will only change it a little.

Materials: string, ring stand with clamp, hooked masses (50 g, 100 g, 200 g), meter stick, protractor, stopwatch (phone)

Procedure:
1. Tie the 100 g mass to the string and hang it from the clamp so the length from the pivot to the center of the mass is 0.25 m.
2. Pull the mass back to 15° and release it. Time 10 complete swings and divide by 10 to get the period.
3. Repeat for lengths of 0.50 m, 0.75 m and 1.00 m.
4. Keep the length at 0.50 m and change the mass to 50 g and then 200 g.
5. Keep the length at 0.50 m and the mass at 100 g and test angles of 10°, 20° and 30°.

Data:
Length (m) | Time for 10 swings (s) | Period (s)
0.25 | 10.1 | 1.01
0.50 | 14.3 | 1.43
0.75 | 17.3 | 1.73
1.00 | 20.0 | 2.00

Mass (g) at L = 0.50 m | Period (s)
50 | 1.42
100 | 1.43
200 | 1.42

Angle at L = 0.50 m | Period (s)
10° | 1.42
20° | 1.43
30° | 1.45

Analysis: Our group found that length was the only variable that made a big difference. When we graphed period vs. length the graph curved, but when we graphed period squared vs. length it was a straight line with a slope of about 3.99 s²/m. Since T² = (4π²/g)L, we used the slope to find g = 4π² ÷ 3.99 = 9.89 m/s². The accepted value is 9.80 m/s², so our percent error was 0.9%. Changing the mass from 50 g to 200 g changed the period by only 0.01 s, which is smaller than our reaction time with the stopwatch. The 30° trial was a little slower, which makes sense because the small-angle formula only works well for small angles.

Conclusion: Our hypothesis was supported. The period of a pendulum depends on its length and not on its mass, and the angle only matters a little once it gets big. One source of error was starting and stopping the stopwatch by hand, which is why we timed 10 swings instead of one. Next time we would use a photogate.`,
    why: "Inline 'Objective:/Hypothesis:/Procedure:/Data:/Analysis:' labels, pipe tables with units, 'our group found', percent error.",
  },
  {
    name: "AP Bio catalase lab, NO Hypothesis heading (Introduction/Procedure/Data/Conclusion)",
    expect: "lab",
    text: `Lab: Effect of Temperature on Catalase Activity
AP Biology
Nadia Rahman
Partners: Leo Ferris, Jasmine Wu

Introduction
Catalase is an enzyme found in almost all living cells. It breaks down hydrogen peroxide, a toxic byproduct of metabolism, into water and oxygen gas: 2 H2O2 → 2 H2O + O2. Like all enzymes, catalase has an optimal temperature at which it works fastest. In this lab we used potato extract as a source of catalase and measured how quickly filter paper disks soaked in the extract floated to the top of a cup of hydrogen peroxide at different temperatures. Oxygen bubbles stick to the disk and lift it, so a shorter time means higher enzyme activity.

Procedure
1. Blend 50 g of peeled potato with 100 mL of cold distilled water and strain through cheesecloth.
2. Divide the extract into five test tubes and place them in water baths at 0 °C (ice), 22 °C (room temperature), 37 °C, 50 °C and 80 °C for 10 minutes.
3. Using forceps, dip a 6 mm filter paper disk into the extract and drop it into a cup containing 30 mL of 3% H2O2.
4. Start the timer when the disk touches the bottom and stop it when the disk reaches the surface.
5. Repeat three times for each temperature.

Data
Temperature (°C) / Trial 1 (s) / Trial 2 (s) / Trial 3 (s) / Average (s)
0 / 31.2 / 28.9 / 33.0 / 31.0
22 / 14.6 / 15.8 / 13.9 / 14.8
37 / 9.4 / 8.7 / 10.1 / 9.4
50 / 18.2 / 21.5 / 19.9 / 19.9
80 / did not rise / did not rise / did not rise / —
At 80 °C the disks stayed on the bottom for more than 2 minutes with only a few tiny bubbles. At 37 °C bubbles formed on the disk almost as soon as it hit the peroxide.

Conclusion
Catalase activity was highest at 37 °C, where the disks rose in an average of 9.4 seconds, and lowest at 0 °C, apart from 80 °C where there was no measurable activity. At low temperatures the enzyme and substrate molecules move more slowly and collide less often, so the reaction is slower. Above the optimum, the enzyme starts to denature: the heat breaks the weak bonds that hold its shape, so the active site no longer fits hydrogen peroxide. At 80 °C the catalase was almost completely denatured. Our results suggest the optimum is somewhere between 30 and 45 °C, but we would need to test more temperatures to find it exactly. One problem was that the extract started cooling or warming as soon as we took the tube out of the bath, so the real temperatures were probably closer to room temperature than we wrote down. The disks were also cut by hand and some may have held more extract than others, which could explain why trial 2 at 50 °C was so much slower.`,
    why: "Tricky: no Hypothesis/Purpose heading; still Procedure + Data table with units + Conclusion with error discussion.",
  },
  {
    name: "Osmosis potato-core lab, no blank lines, Question/Prediction/Method/Results/Discussion",
    expect: "lab",
    text: `Osmosis in Potato Cores
Biology – Ms. Fields – Lab #6
Question: How does the concentration of a sucrose solution affect the mass of potato cores?
Prediction: Potato cores in pure water will gain mass and cores in strong sugar solutions will lose mass, because water moves by osmosis from a region of low solute concentration to a region of high solute concentration.
Materials: potato, cork borer, ruler, scalpel, electronic balance (±0.01 g), 6 beakers, sucrose solutions (0.0, 0.2, 0.4, 0.6, 0.8 and 1.0 M), paper towels
Method: Our group cut 18 potato cores 4.0 cm long with the cork borer. We blotted each core dry and measured its mass, then put three cores in each beaker with 100 mL of solution. After 24 hours we removed them, blotted them again and measured the mass. We calculated the percent change in mass for each beaker using the total mass of its three cores divided by three.
Results:
0.0 M: initial 2.31 g, final 2.68 g, change +16.0%
0.2 M: initial 2.28 g, final 2.44 g, change +7.0%
0.4 M: initial 2.35 g, final 2.33 g, change −0.9%
0.6 M: initial 2.30 g, final 2.08 g, change −9.6%
0.8 M: initial 2.33 g, final 1.98 g, change −15.0%
1.0 M: initial 2.29 g, final 1.89 g, change −17.5%
The cores in water felt stiff and snapped when bent. The cores in 0.8 and 1.0 M were soft and bendy.
Discussion: Our prediction was correct. The cores in 0.0 and 0.2 M gained mass because the solution was hypotonic compared to the potato cells, so water moved into the cells. The cores in 0.6 M and above lost mass because the solution was hypertonic and water moved out. When we graphed percent change against concentration, the line crossed zero at about 0.38 M, which means the solute concentration inside the potato cells is about the same as a 0.38 M sucrose solution. The change in mass levels off at the highest concentrations, probably because the cells had already lost most of the water they could lose. Some error came from blotting, since we did not press every core equally, and the 0.4 M cores were left in a few minutes longer than the others because we ran out of time.`,
    why: "No blank lines between paragraphs; 'Prediction' instead of Hypothesis; masses in g, percent change, 'Our group cut'.",
  },

  // ─────────────────────────── literary ───────────────────────────
  {
    name: "Literary analysis of a poem, Dickinson, quotes with line numbers",
    expect: "literary",
    text: `Kayla Brooks
Ms. Hernandez
English 11 Honors
3 October 2025

A Gentle Ride: Death and Time in Dickinson's "Because I could not stop for Death"

Most poems about death treat it as something to fear, but Emily Dickinson's "Because I could not stop for Death" presents it as a polite gentleman caller. Through the extended metaphor of a carriage ride, the speaker's calm tone, and imagery that moves from life to the grave, Dickinson suggests that death is not an ending but a quiet passage into eternity, one the speaker barely notices until it is over.

The poem opens with an ironic reversal. The speaker admits she was too busy to make time for death, so "He kindly stopped for me" (line 2). The word "kindly" is surprising, since death is usually described as cruel or sudden. Here death is a courteous suitor who drives a carriage, and the speaker notes that "The Carriage held but just Ourselves – / And Immortality" (lines 3–4). Including Immortality as a passenger hints from the start that the ride does not end at the grave. The speaker even puts away "My labor and my leisure too" (line 7) out of respect for his civility, giving up her whole life out of good manners. Dickinson's dashes slow the reader down, mirroring the slow pace of the carriage.

The third stanza uses imagery to show the stages of life passing by. The carriage passes a school "where Children strove" (line 9), then "the Fields of Gazing Grain" (line 11), and finally "the Setting Sun" (line 12). The children represent youth, the ripe grain suggests maturity, and the setting sun stands for old age. The repetition of "We passed" creates the rhythm of a journey, but in the next stanza the speaker corrects herself: "Or rather – He passed Us" (line 13). Time is no longer something she moves through; it moves past her, because she has left it.

The mood darkens slightly as the speaker grows cold. Her gown is only "Gossamer" and her tippet "only Tulle" (lines 15–16), thin fabrics that cannot protect her from the chill of the dew in line 14. These details suggest she is dressed for a wedding rather than a funeral, which fits the image of death as a suitor. The house they pause before is "A Swelling of the Ground" (line 18), a grave described so gently that it barely sounds like one.

The final stanza reveals that centuries have passed, yet they feel "shorter than the Day" (line 22) when she first realized where the horses were heading. In the speaker's eternity, time has lost its meaning. Dickinson's calm, almost conversational tone and her image of death as a gentleman make the ending less frightening than it might be. Death, in this poem, is simply the driver who takes the speaker out of the busy world of time and into an eternity she can describe only in a whisper.`,
    why: "About a POEM: quoted fragments with (line N)/(lines 3–4), slash line breaks, talk of speaker/stanza/imagery/extended metaphor.",
  },
  {
    name: "Literary analysis of a play, Macbeth, act.scene.line citations",
    expect: "literary",
    text: `Blood and Guilt in Macbeth

In Shakespeare's Macbeth, blood is more than a sign of violence. At the start of the play it stands for honor in battle, but after Macbeth murders King Duncan it becomes a symbol of guilt that neither he nor Lady Macbeth can wash away. By following this image through the play, Shakespeare shows that guilt cannot be hidden or scrubbed off, and that it eventually destroys the people who try.

In Act 1, blood is a sign of courage. The wounded captain praises Macbeth for carving his way through the battle with his sword, and Duncan rewards him with a new title. Being covered in the enemy's blood makes Macbeth a hero. This changes as soon as he starts thinking about murder. Before killing Duncan, he imagines a dagger floating in the air and asks, "Is this a dagger which I see before me, / The handle toward my hand?" (2.1.44–45). Later in the same soliloquy the imaginary blade is stained with "gouts of blood" (2.1.57), as if his mind already sees the crime before he commits it.

Right after the murder, Macbeth is horrified by his own hands. He asks, "Will all great Neptune's ocean wash this blood / Clean from my hand?" (2.2.78–79), and answers that his hand would sooner turn the green sea red. The exaggeration shows how enormous his guilt feels. Lady Macbeth, by contrast, dismisses it, telling him that "A little water clears us of this deed" (2.2.86). At this point she seems stronger than her husband, but her confidence turns out to be one of the play's biggest ironies.

As the play goes on, Macbeth gets used to blood. After he has Banquo murdered and sees Banquo's ghost at the banquet, he admits he is "in blood / Stepped in so far" (3.4.168–169) that going back would be as hard as going on. Instead of feeling guilty, he becomes numb, and he orders the murder of Macduff's wife and children without hesitating. The blood that once horrified him is now just part of being a tyrant.

Lady Macbeth's guilt, on the other hand, returns in her sleep. In Act 5 she walks at night rubbing her hands and crying, "Out, damned spot! Out, I say!" (5.1.37). She complains that "all the perfumes of Arabia will not sweeten this little hand" (5.1.53–54). The woman who claimed a little water would clean them now cannot get rid of a smell, even though there is no real blood on her hands at all. Shakespeare shows that the guilt she pushed down in Act 2 never left; it was only waiting.

Through the symbol of blood, Shakespeare traces how guilt works on two very different people. Macbeth hardens himself until he feels almost nothing, while Lady Macbeth's buried guilt breaks out and destroys her. In both cases, the blood cannot be washed away.`,
    why: "About a PLAY: (2.2.78–79) act.scene.line citations, soliloquy, symbol, characters; no heading block.",
  },
  {
    name: "Literary analysis of a novel, The Great Gatsby, (Fitzgerald page) citations",
    expect: "literary",
    text: `Jamal Wright
Mrs. Sato
American Literature
January 22, 2025

The Green Light and the Limits of the Dream

In F. Scott Fitzgerald's The Great Gatsby, the narrator Nick Carraway first sees his mysterious neighbor standing alone on his lawn at night. Gatsby "stretched out his arms toward the dark water in a curious way," and when Nick looks across the bay he sees nothing except "a single green light, minute and far away, that might have been the end of a dock" (Fitzgerald 21). The light at the end of Daisy Buchanan's dock becomes the novel's central symbol. Fitzgerald uses it to show that Gatsby's dream is powerful precisely because it is out of reach, and that once a dream is reached, it loses its magic.

At first, the green light represents everything Gatsby wants: Daisy, the past they shared, and the wealthy world she belongs to. Green is the color of money and of spring, so the light combines Gatsby's desire for status with his hope for a new beginning. The fact that Gatsby reaches toward it across the water shows how much distance, both physical and social, separates him from Daisy. Gatsby has built an enormous house and thrown endless parties all to be near that light.

When Gatsby finally reunites with Daisy in Chapter 5, the symbol changes. Standing beside her, Gatsby realizes the light is just a light again. Nick reflects that "the colossal significance of that light had now vanished forever" and that Gatsby's "count of enchanted objects had diminished by one" (Fitzgerald 93). This is an important moment because it shows that the dream mattered more than the real Daisy. A woman whose "voice is full of money" (Fitzgerald 120) could never live up to five years of imagination.

Gatsby's tragedy is that he refuses to accept this. When Nick warns him that he cannot repeat the past, Gatsby answers, "Why of course you can!" (Fitzgerald 110). He believes that if he can only get Daisy to say she never loved Tom, they can return to Louisville in 1917 and begin again. The green light, which once pointed forward, now points backward.

In the novel's final pages, Nick connects the green light to something larger than Gatsby. He writes that "Gatsby believed in the green light, the orgastic future that year by year recedes before us" (Fitzgerald 180). The light becomes a symbol of the American Dream itself, a future that always seems one more effort away. The famous last line, "So we beat on, boats against the current, borne back ceaselessly into the past" (Fitzgerald 180), suggests that everyone, not just Gatsby, keeps reaching for a light they can never touch. Through this symbol, Fitzgerald shows that the dream's beauty and its cruelty are the same thing: it keeps us moving because it can never be reached.`,
    why: "About a NOVEL: (Fitzgerald 93)-style page citations, narrator, symbol, chapter references; quotes only from the 1925 text.",
  },
  {
    name: "Short literary response, Frost 'The Road Not Taken', line numbers, no heading",
    expect: "literary",
    text: `Misreading "The Road Not Taken"

Robert Frost's "The Road Not Taken" is often read at graduations as a poem about bravely choosing your own path. A closer look at the poem shows that it is actually about how people invent meaning for their choices after the fact.

The speaker stands where "Two roads diverged in a yellow wood" (line 1) and is "sorry I could not travel both" (line 2). He looks down the first road and then takes the other, which he says has "perhaps the better claim" because it was "grassy and wanted wear" (lines 7–8). But in the very next lines he takes this back, admitting that "the passing there / Had worn them really about the same" (lines 9–10). The two roads, in other words, were equal. Neither was less traveled.

This makes the last stanza ironic. The speaker predicts that "ages and ages hence" (line 17) he will be telling the story "with a sigh" (line 16), claiming that he took "the one less traveled by" (line 19). The future tense is the key. He knows that he will someday tell a neater version of the story than what really happened, because people want their lives to have turning points. The dash at the end of line 18, "and I—", sounds like the hesitation of someone choosing the version of the story he wants to believe.

Frost's rhyme scheme, ABAAB in each of the four stanzas, is regular and calm, which hides the poem's doubt under a confident sound. That may be why so many readers take the ending at face value. The poem is not a celebration of individualism but a gentle joke about how we look back at our decisions and decide they "made all the difference" (line 20).`,
    why: "Short poem analysis: line-numbered quotes, speaker, stanza, rhyme scheme ABAAB, irony; title line only, no heading block.",
  },
  // ───────────────────────────── poem ─────────────────────────────
  {
    name: "Free-verse poem, no title, four stanzas",
    expect: "poem",
    text: `the 6:40 bus smells like rain and someone's orange,
and the windows hold our faces
over the gray parking lots
like a second, quieter town.

Marcus sleeps against the glass.
A girl in the back is practicing Spanish verbs
under her breath, tengo, tienes, tiene,
as if she could keep something by naming it.

I count the stops I know by heart:
the laundromat, the church with the broken sign,
the house where a dog waits every morning
at the exact same corner of the fence.

Nobody talks.
Nobody has to.
We are all going the same way
for forty minutes, and then we're not.`,
    why: "Short lines, stanza breaks, no sentences running past a line; a first-person 'I' that is a lyric speaker, not an essay.",
  },
  {
    name: "Rhymed poem with a title line, ABAB quatrains",
    expect: "poem",
    text: `November Field

The corn is cut, the stalks lie low,
the crows walk out across the rows;
the light comes late and leaves too slow
for anything but what it knows.

My father stands beside the fence
and doesn't say what he can see—
the year, the debt, the small expense
of everything that used to be.

But in the ditch the frost has made
a lace of every broken weed,
and even here, where things are laid
to rest, the ground is keeping seed.`,
    why: "Title line then three rhymed quatrains (low/slow, rows/knows); end rhyme and even line lengths.",
  },
  {
    name: "Prose-like poem in long lines with stanza breaks, no title",
    expect: "poem",
    text: `My mother keeps the receipts from every grocery trip in a shoebox under the sink,
as though one day someone will come asking what we ate in the spring of 2009 and she will be ready.

I used to think it was about money. Now I think it is about proof—
that we were here, that there was milk and bread and the good apples when they were on sale, that nobody went hungry.

Some nights I hear her sorting them at the kitchen table,
the soft paper sound like a small animal turning over in its sleep, and I don't go in.

I let her have it. The lamp, the box,
the long columns of numbers adding up to a life no one else is keeping track of.`,
    why: "Tricky: long prose-length lines and a 'my mother' memoir feel, but couplet stanzas, enjambed breaks mid-sentence and imagery make it a poem.",
  },
  {
    name: "Poem with no punctuation at all, lowercase",
    expect: "poem",
    text: `what the river told me

slow down it said
the stones are older than your worry
and they are still here

go around it said
not everything in your way
is meant to be moved

be cold it said
be clear be low
let the light come down to you

i stood there a long time
with my shoes in my hand
and i listened`,
    why: "Zero punctuation and all lowercase, so no sentence boundaries; short lines in tercets are the only signal.",
  },

  // ───────────────────────────── story ─────────────────────────────
  {
    name: "Third-person short story with dialogue, 'The Last Ferry'",
    expect: "story",
    text: `The Last Ferry

The ferry horn sounded twice across the water, and Priya knew they were going to miss it.

"Run," she said, grabbing her brother's sleeve.

"I am running," Dev panted. He was carrying both of their backpacks and a paper bag of peaches their aunt had pressed on them at the door, and one of the peaches had already escaped and rolled under a parked truck.

They reached the dock just as the ramp began to lift. A man in an orange vest shook his head at them, not unkindly.

"Next one's at six-forty," he called over the engine. "Tomorrow morning."

Priya stood with her hands on her knees and watched the ferry slide away, its lights doubling in the dark water. On the other side of the bay, their mother would be pacing the kitchen, phone in hand.

"She's going to kill us," Dev said.

"She's going to kill me," Priya corrected. "I'm the one who said we had time for ice cream."

Dev sat down on the edge of the dock and let his sneakers dangle over the water. After a moment he opened the paper bag and held it out to her. She took a peach. It was warm from the afternoon and so ripe that the juice ran down her wrist.

"We could call Aunt Meena," he said. "She'd let us sleep on the couch."

"She'd also tell Mom we were eating ice cream instead of catching the boat."

"Mom's going to find out anyway."

He was right, and she hated that he was right. He was eleven and she was fifteen, and lately he was right more often than she liked.

The man in the orange vest came back down the ramp, coiling a rope over his shoulder. He stopped beside them and looked at the bag.

"Those from the Hendricks orchard?"

"Our aunt's tree," Dev said.

The man considered this. Then he nodded toward a small white boat tied at the end of the dock, its windows dark. "I'm taking the mail boat across in twenty minutes. Not supposed to carry passengers." He paused. "But I'm also not supposed to eat on the job."

Priya looked at Dev. Dev looked at the bag. Without a word, he held it up.

The man took two.

Twenty minutes later they were sitting on overturned crates in the back of the mail boat, the bay black and glittering around them, the town lights shrinking behind. Priya texted their mother: On our way. Long story. Dev was asleep against her shoulder before they were halfway across, the empty paper bag folded neatly in his lap.`,
    why: "Third-person past-tense narration, named characters, many '…,' she said' dialogue tags; no thesis, no citations.",
  },
  {
    name: "First-person fiction, pawn shop and a backward watch",
    expect: "story",
    text: `I had worked at Delgado's Pawn & Loan for almost a year before anyone tried to sell me time.

It was a Tuesday in February, the kind of gray afternoon when nobody comes in except people who have run out of other options. The bell over the door rang and an old man shuffled in, wearing a tweed coat too heavy for the weather and carrying a small wooden box under one arm.

"You buy watches?" he asked.

"Depends on the watch," I said, which is what Mr. Delgado taught me to say about everything.

He set the box on the counter and opened it. Inside, on a bed of faded green velvet, was a silver pocket watch engraved with vines and tiny birds. It was beautiful, but that wasn't what made me lean closer. The second hand was moving backward.

"It's broken," I said.

"It's not broken." He tapped the glass with one yellowed fingernail. "It's honest."

I laughed, but he didn't. I picked it up. It was heavier than it looked, and warm, as if it had been sitting in the sun. The minute hand was crawling backward too, from ten past four toward four o'clock.

"How much do you want for it?"

"Fifty dollars."

That was nothing. The silver alone was worth more. "Why so cheap?"

He looked at me for a long moment, and I noticed for the first time how blue his eyes were, the bright blue of a much younger man. "Because I've had enough of it," he said. "Every hour I carry it, I get one back. I'm eighty-one years old, son. I'd like to get on with things."

I should have said no. Mr. Delgado would have said no. Instead I counted two twenties and a ten out of the register and wrote him a receipt, and he walked out into the rain with his coat unbuttoned, whistling.

That night I put the watch on my nightstand. When I woke up, the scar on my thumb from a kitchen knife, the one I'd had since I was nine, was gone.

I'm writing this down because tomorrow I'm going to try to find him. I want to ask him how he made it stop.`,
    why: "Tricky: first-person 'I' like a personal essay, but invented events, a magical object, scene-by-scene dialogue and a twist make it fiction.",
  },
  {
    name: "Present-tense sci-fi flash fiction with a scene break",
    expect: "story",
    text: `Ration Day

On the colony, Ration Day comes once a month, and Lena Okoro has never missed one.

She stands in line outside the Commissary with the other families, her ration card clutched in both hands. The dome overhead is the pale orange of a Martian afternoon. Somewhere above it a dust storm is grinding across the plain, but inside the air is still and smells faintly of hydroponic tomatoes.

"Card," says the clerk, a tired man named Abel who used to be her mother's lab partner.

Lena hands it over. Abel scans it, frowns, and scans it again.

"There's an extra credit on here," he says.

"There can't be."

"There is." He turns the screen so she can see. Beside her family's name, where there should be four portions, there are five.

Lena's throat goes tight. Five was the number before the accident. Five was before her father went out to fix the north antenna and the storm came early.

"It's a mistake," she says. "The system didn't update."

Abel looks at her for a long moment. Behind her, someone coughs. The line shifts impatiently.

"The system," Abel says carefully, "updates when I tell it to update." He taps something, and the screen blinks. Five portions. "And I haven't gotten around to it."

* * *

That night Lena's little brother eats until he falls asleep at the table with a spoon in his hand. Her mother doesn't ask where the extra food came from. She just sits by the window watching the storm, and for the first time in months she hums.

Lena washes the dishes slowly, making the water last. Tomorrow she'll go back and tell Abel to fix it. Tomorrow, she tells herself, she'll be honest.

Tonight, she lets the five portions stay.`,
    why: "Present tense, invented setting, dialogue with 'says', '* * *' scene break; numbers ('five portions') are plot, not claims.",
  },

  // ───────────────────────────── script ─────────────────────────────
  {
    name: "Screenplay with sluglines and caps character cues",
    expect: "script",
    text: `FADE IN:

INT. JEFFERSON HIGH SCHOOL – CHEMISTRY LAB – DAY

Black lab tables in rows. A periodic table poster peels at one corner. MAYA TORRES (16, safety goggles shoved up into her hair) stares at a beaker of cloudy green liquid.

Her lab partner, DEV PATEL (16), leans in way too close.

DEV
Is it supposed to be that color?

MAYA
Nothing about this is supposed to be anything.

She checks the worksheet. Checks the beaker. Checks the worksheet again.

DEV
Mr. Hollis said if it turns green, we did step four wrong.

MAYA
(not looking up)
Then we did step four wrong.

The beaker BUBBLES. Once. Then again, louder.

Across the room, MR. HOLLIS (50s, cardigan, mug that says WORLD'S OKAYEST TEACHER) looks up from his grading.

MR. HOLLIS
Torres. Patel. What did you add?

DEV
(holding up a bottle)
The... clear one?

MR. HOLLIS
They're all clear ones, Dev.

Green foam creeps over the lip of the beaker and spills onto the table. The whole class turns to look.

MAYA
Okay. Okay. Everybody stay calm.

DEV
I am extremely calm.

The foam drips onto the floor. It hisses.

MR. HOLLIS
(already moving)
Everybody out. Now. Leave your bags.

CUT TO:

EXT. JEFFERSON HIGH SCHOOL – FRONT LAWN – CONTINUOUS

Thirty students mill around on the grass. A fire alarm WAILS inside. Maya and Dev stand apart from the others.

DEV
On the bright side, we're definitely getting extra credit for this.

MAYA
(deadpan)
Dev.

DEV
Negative extra credit?

Maya finally laughs. Behind them, the PRINCIPAL storms out the front doors, walkie-talkie in hand, looking straight at them.

MAYA
Oh no.

SMASH CUT TO:

INT. PRINCIPAL'S OFFICE – LATER

Maya and Dev sit side by side in two very small chairs.

FADE OUT.`,
    why: "INT./EXT. sluglines, CHARACTER NAMES alone on a line above dialogue, (parentheticals), FADE IN/CUT TO transitions.",
  },
  {
    name: "One-act stage play, NAME: dialogue and stage directions in parentheses",
    expect: "script",
    text: `WAITING ROOM
A one-act play

CHARACTERS
ROSA, seventies, sharp, impatient
MILES, seventeen, her grandson
NURSE, any age

(A hospital waiting room late at night. Three plastic chairs, a vending machine that hums. ROSA sits very straight with her purse on her lap. MILES enters carrying two paper cups.)

MILES: They only had decaf.
ROSA: Then why did you buy it?
MILES: (sitting down beside her) Because you said you wanted coffee.
ROSA: I wanted coffee. That is not coffee. That is brown water with ambitions.
MILES: (holding it out anyway) It's warm.
ROSA: (taking it) Warm is something.

(Pause. The vending machine hums. ROSA sips and makes a face.)

MILES: Did they say anything while I was gone?
ROSA: They said "soon." They have been saying "soon" since nine o'clock. In this building "soon" is a unit of geological time.
MILES: Grandpa's tough.
ROSA: Your grandfather is stubborn. It is not the same thing. (beat) Although it helps.

(MILES takes out his phone, looks at it, puts it away.)

ROSA: Your mother?
MILES: Her flight lands at six.
ROSA: She'll want to fight with the doctors.
MILES: You already fought with the doctors.
ROSA: I asked questions.
MILES: You asked one of them if he was old enough to drive.
ROSA: (shrugging) He looked twelve. (She sets the cup down.) When your grandfather and I got married, he told me he would live to a hundred just to annoy me. He is seventy-eight. He has twenty-two more years of annoying to do.

(MILES reaches over and takes her hand. She lets him. The NURSE enters with a clipboard. Both of them stand at once.)

NURSE: Mrs. Alvarez?
ROSA: (gripping MILES's hand) Yes.
NURSE: (smiling) He's awake. He's asking for coffee.
ROSA: (to MILES, without letting go) Go and find him some real coffee.

(MILES laughs and exits quickly. ROSA takes a breath, smooths her skirt, and follows the NURSE off. Lights fade on the empty chairs and the two paper cups.)

END OF PLAY`,
    why: "CHARACTERS list, 'NAME: line' on every line, (stage directions) in parentheses, END OF PLAY.",
  },

  // ───────────────────────────── speech ─────────────────────────────
  {
    name: "Student council campaign speech",
    expect: "speech",
    text: `Hi everyone! For those of you who don't know me, my name is Carlos Mendez, and I'm running for junior class vice president.

I know what you're thinking. Another speech. Another person promising to fix the vending machines. I'm not going to promise that, because honestly, I looked into it, and the vending machines are run by a company in Ohio and I have no power over Ohio.

What I can promise is that I'll actually listen. Last year I sat on the student advisory committee, and the thing I learned is that our class has a lot of good ideas that never go anywhere because nobody writes them down and follows up. So here's my plan.

First, I want to put a suggestion box, a real one and a digital one, in the library, and I'll go through every suggestion with the other class officers once a month. If your idea can happen, I'll push for it. If it can't, I'll tell you why instead of just ignoring it.

Second, prom. I know it feels far away, but junior prom costs money, and last year's class had to raise ticket prices at the last minute because they started fundraising too late. I want to start this fall, with stuff people actually like: a teachers-versus-students basketball game, a car wash, and a movie night on the football field.

Third, I want juniors to have a say in the new phone policy. Right now decisions get made and we hear about them on the morning announcements. I want at least two student reps in those meetings.

I'm not the loudest person in this gym. But I show up, I follow through, and I'll make sure your voice actually gets heard.

So on Friday, vote Carlos Mendez for junior class vice president. Thank you!`,
    why: "'Hi everyone!… my name is… I'm running for', direct address to 'you', 'vote … Thank you!' close.",
  },
  {
    name: "Persuasive speech on school start times with statistics said aloud",
    expect: "speech",
    text: `Good morning, Mrs. Alvarez, and good morning, fellow students.

Raise your hand if you were awake before six o'clock this morning. Keep it up if you hit snooze at least twice. Look around. That's most of the room.

Today I want to convince you that our school should start later, at 8:30 instead of 7:20.

Let's start with the science. Doctors say teenagers need eight to ten hours of sleep a night. But our body clocks naturally shift later during puberty, which means most of us can't fall asleep before eleven, no matter how hard we try. If you fall asleep at eleven and your alarm goes off at six, you're getting seven hours at best. That's why the American Academy of Pediatrics recommends that middle and high schools start no earlier than 8:30 a.m.

Now, some of you are thinking, "Just put your phone down and go to bed." And it's true that phones don't help. According to a 2022 Pew study, almost half of teenagers say they are online almost constantly. But even students who put their phones away at night are still fighting their own biology.

And this isn't just about being tired. Districts that moved their start times later have reported better attendance, fewer students falling asleep in first period, and even fewer car crashes involving teen drivers. Think about that. A later bell could make the drive to school safer.

I know there are challenges. Buses would need new routes. Practices would end later. But other districts have solved these problems, and so can we.

So here's what I'm asking. Next Tuesday the school board is holding a public meeting about the schedule. Come. Bring your parents. Tell them what your mornings are really like.

We can keep pretending that exhaustion is just part of being a teenager, or we can do something about it. Let's choose to wake up, at 8:30.

Thank you.`,
    why: "'Good morning… fellow students', 'Raise your hand', statistics spoken aloud ('According to a 2022 Pew study'), call to action, 'Thank you.'",
  },
  {
    name: "Speech with pasted (Smith, 2020) citations, composting proposal",
    expect: "speech",
    text: `Good afternoon, everyone. My name is Hannah Liu, and I'm a member of the Green Team.

I want you to think about what you threw away at lunch today. Maybe it was half a sandwich, an apple you didn't feel like eating, or a carton of milk you never opened. It doesn't seem like much. But multiply that by twelve hundred students, five days a week, and it adds up fast.

Research shows that schools in the United States throw away a large share of the food they serve, and that much of it is fruit and vegetables (Smith, 2020). At our school, the Green Team weighed the cafeteria trash for one week in September. We collected 412 pounds of food waste in five days. That's about the weight of a grand piano, every single week.

Most of that food goes to a landfill, where it breaks down without oxygen and releases methane, a greenhouse gas that traps much more heat than carbon dioxide (Nguyen & Patel, 2019). That means our lunch leftovers are actually adding to climate change.

But there's a simple fix. Schools that have started composting programs have cut their landfill waste by up to half (Smith, 2020). Instead of one trash can, we would have three bins at the end of each table: one for compost, one for recycling, and one for trash. The compost would go to the community garden on Elm Street, which has already agreed to take it.

We also want to start a share table, where you can leave unopened food like milk cartons, yogurt and whole fruit for other students to take. Other schools that tried this found that students really did use it (Garcia, 2021).

None of this costs much money. All it takes is for each of us to spend five extra seconds at the end of lunch putting things in the right bin.

So next week, when you see the new bins, please use them. And if you want to help, the Green Team meets every Thursday in Room 114.

Thank you.`,
    why: "Tricky: (Smith, 2020) APA citations pasted from a paper, but opens 'Good afternoon, everyone. My name is…', addresses 'you', ends 'Thank you.'",
  },
  {
    name: "Graduation speech",
    expect: "speech",
    text: `Good morning, everyone. Principal Davis, members of the school board, teachers, families, and most of all, my fellow graduates of the Class of 2025.

I have to be honest with you. When I sat down to write this speech, I typed "how to write a graduation speech" into a search bar, and the first piece of advice was "Start with a famous quote." So I spent an entire evening reading famous quotes. And then I realized that none of them were about us.

None of them were about the fire drill in ninth grade when it started snowing and Mr. Okafor gave his coat to a freshman he didn't even know. None of them were about the robotics team rebuilding their whole robot in a hotel room the night before the state finals. None of them were about the day the power went out during AP Bio and we finished the lecture by phone flashlight.

We started high school in a strange time. Some of us met each other first as tiny squares on a screen. We learned to unmute ourselves before we learned each other's last names. And then we came back to these hallways and had to figure out how to be in a room together again.

We did figure it out. We figured it out loudly, and sometimes badly, and with a lot of help.

To our teachers: thank you for answering emails at eleven at night, for believing we'd turn in the essay eventually, and for pretending not to notice when we were very obviously asleep.

To our families: thank you for the rides, the late dinners, and the patience. We know we didn't always say it.

And to my classmates: I don't know where we're all going. Some of you are heading to college in other states. Some of you start jobs on Monday. Some of you are joining the military, and some of you honestly have no idea yet, and that's okay too.

But wherever you go, I hope you remember that the most important things that happened to us here didn't happen in a famous quote. They happened in hallways, in bleachers, in the cafeteria, on the bus. They happened because we showed up for each other.

So keep showing up.

Congratulations, Class of 2025. Thank you.`,
    why: "Opening salutation list ('Principal Davis, … my fellow graduates'), 'To our teachers:' addresses, 'Congratulations, Class of 2025. Thank you.'",
  },
  // ───────────────────────────── news ─────────────────────────────
  {
    name: "City news story with dateline, officials and 'said' attributions",
    expect: "news",
    text: `City Council Approves Budget With First Water Rate Hike in Six Years

By Karen Holt, Staff Reporter

SPRINGFIELD, Ill. — The Springfield City Council voted 7–3 Tuesday night to approve a $412 million budget for the coming fiscal year that pays for 14 new police officers, a 3 percent raise for city employees and the first increase in residential water rates in six years.

The water rate increase, which will add about $4.50 a month to the average household bill, drew the most debate during a meeting that stretched past 11 p.m.

"Nobody up here wants to raise rates," said Ward 4 Alderman Lisa Hammond, who voted for the budget. "But some of our water mains are older than anyone in this room, and they are breaking faster than we can patch them."

City Utilities Director Mark Ellison told council members that crews repaired 212 main breaks last year, up from 140 five years ago, and that the new revenue would let the city replace about eight miles of pipe a year instead of three.

The three members who voted no said the increase would fall hardest on residents with fixed incomes. Ward 7 Alderman Gary Lund proposed delaying the rate hike for a year while the city applied for state infrastructure grants, but his amendment failed 4–6.

"I'm not against fixing pipes," Lund said after the vote. "I'm against asking a retired school bus driver to pay for forty years of the city putting it off."

More than two dozen residents spoke during public comment. Doris Whitaker, 78, said her water bill already takes a noticeable share of her monthly Social Security check. "Every four dollars matters when you're counting," she said.

Mayor James Okafor, who proposed the budget in December, said in a statement that the city would expand an existing program that lets income-qualified households apply for a 30 percent discount on their water bills.

The police hiring plan passed with little discussion. Police Chief Andrea Ruiz said the department has 19 vacant positions and has relied heavily on overtime to cover shifts.

The budget takes effect March 1.`,
    why: "Dateline 'SPRINGFIELD, Ill. — ', byline, inverted pyramid, officials with titles, every quote closed with 'said'.",
  },
  {
    name: "School newspaper article, byline, no dateline",
    expect: "news",
    text: `Robotics Team Heads to State for First Time

By Ana Ruiz, Staff Writer
The Lincoln Ledger | March 6, 2025

For the first time in school history, Lincoln High's robotics team has qualified for the state championship after placing second at the Central Valley Regional in Fresno on Saturday.

The team's robot, nicknamed "Toaster" because of its boxy shape, won 9 of its 12 qualifying matches and was picked by the top-seeded alliance for the playoffs.

"We rebuilt the entire arm on Thursday night because the old one kept jamming," said senior captain Owen Park. "We didn't know if it would even work until our first match."

It worked. In the semifinal, Toaster scored the final points with four seconds left to send Lincoln's alliance to the finals, where it lost a close series to a team from Clovis.

Physics teacher Daniel Reyes, who has advised the team since it formed in 2019, said the result reflects years of slow building. "When we started we had six kids and a borrowed drill," Reyes said. "Now we have twenty-eight members and a sponsor."

The team also won the Judges' Award for its outreach program, which brings robotics workshops to three local elementary schools.

Sophomore Isabella Cruz, the team's lead programmer, said the code that drives the robot on its own during the first fifteen seconds of each match was rewritten twice in February. "Honestly, the robot drove better in the finals than it ever did in practice," she said.

The state championship will be held March 21–22 in Sacramento. The team needs to raise about $3,000 for registration, travel and replacement parts. Donations can be dropped off at the front office, and the team will hold a car wash in the student parking lot on March 15 from 9 a.m. to 2 p.m.`,
    why: "School paper: 'By …, Staff Writer', paper name and date line, quotes from students with grade and role plus 'said'.",
  },
  {
    name: "Breaking news wildfire story, dateline, 'officials said'",
    expect: "news",
    text: `BEND, Ore. — Hundreds of residents east of Bend were ordered to leave their homes Sunday afternoon as a wind-driven wildfire grew to more than 4,000 acres in less than six hours, fire officials said.

The Dry Creek Fire was reported at about 12:40 p.m. near a gravel pit off Highway 20 and spread quickly through juniper and sagebrush as gusts reached 35 mph, according to the county sheriff's office.

"This fire is moving faster than our crews can get in front of it," incident commander Ray Delgado said at an evening briefing. "If you are told to go, please go now. Do not wait to pack."

As of 8 p.m., the fire was 0 percent contained. No injuries had been reported, but officials said at least two barns and several outbuildings had been destroyed.

About 1,100 homes were under Level 3 "go now" evacuation orders, and another 2,300 were at Level 2, meaning residents should be ready to leave at a moment's notice. The Red Cross opened an evacuation shelter at a middle school in Bend, and the county fairgrounds were accepting horses and other livestock.

Linda Park, who left her home with two dogs and a box of photographs, said she first noticed the smoke from her kitchen window. "It went from a little gray puff to a black wall in about twenty minutes," she said.

Air tankers and helicopters dropped water and retardant on the fire's eastern edge until dark, Delgado said, and about 250 firefighters were expected on the lines by Monday morning.

The cause of the fire is under investigation. Forecasters expect the wind to ease Monday, though humidity is expected to stay low through midweek.`,
    why: "No headline or byline at all; the dateline, 'officials said', 'according to', time stamps and the inverted pyramid carry it.",
  },
  {
    name: "Business news, plant closure with dateline",
    expect: "news",
    text: `Tool Maker to Close Dayton Plant, Cutting 340 Jobs

DAYTON, Ohio — Harlan Tool & Die, a manufacturer that has operated in Dayton since 1913, will close its Wayne Avenue plant by the end of next year, eliminating about 340 jobs, the company announced Wednesday.

In a statement, Harlan said it would move production of its industrial cutting tools to an existing plant in Tennessee, citing rising energy costs and a drop in orders from automakers.

"This was a painful decision, and it is not a reflection of the skill or dedication of our Dayton employees," chief executive Martin Voss said in the statement.

Workers learned of the closure at a meeting on the factory floor Wednesday morning. Several said they had heard rumors for months.

"My father worked here, and his father worked here," said Terrence Hall, 52, a machine operator who has been at the plant for 27 years. "You figure you'll retire here. Now I'm trying to figure out who hires a fifty-two-year-old machinist."

The company said employees would receive severance based on their years of service and that some would be offered positions in Tennessee. Harlan did not say how many.

The president of the union local that represents most of the plant's hourly workers said the union would ask the company to delay the closure and to fund job retraining. "We're not going to make this easy for them," she said.

The city's economic development director said Dayton would work with state officials to find a buyer for the 22-acre site. The plant is one of the largest remaining manufacturing employers on the city's east side.`,
    why: "Dateline, 'the company announced Wednesday', CEO/union/worker quotes with ages and roles; not an essay despite the figures.",
  },

  // ─────────────────────────── personal ───────────────────────────
  {
    name: "College application essay about a grandmother and dumplings",
    expect: "personal",
    text: `Every Sunday for the first fourteen years of my life, my grandmother and I folded dumplings at her kitchen table in Flushing. She did not believe in measuring. When I asked how much ginger to add, she said, "Enough." When I asked how long to knead the dough, she said, "Until it feels right." For years I thought she was being difficult on purpose.

My grandmother came to the United States when she was forty-six, speaking almost no English. She worked for twenty years in the back of a laundromat, and when she retired, cooking was the one thing she refused to give up. Her apartment was small and always too warm, and the radio played Cantonese opera so loudly that the neighbors complained. I loved it there.

The dumplings were the hardest part. Her pleats were perfect, twelve tiny folds that curved like a fan. Mine looked like crumpled tissues. She would pick one up, examine it, sigh dramatically, and then eat it first so that no one else would see it. I didn't realize until much later that this was her way of being kind.

When I was fifteen, she had a stroke. She survived, but her right hand never worked the same way again. The first Sunday after she came home from the hospital, I went over expecting that we would skip the dumplings. Instead she was sitting at the table with a bowl of filling and a stack of wrappers, waiting for me.

"You fold," she said. "I watch."

So I folded. I made the pleats too big and too few, and she corrected me, tapping the table with her good hand. "Thinner. More. Again." It took me almost two hours to make forty dumplings. When we finally ate them, she picked up one of mine, looked at it for a long time, and said, "Okay."

It was the highest praise I have ever received.

I have thought a lot about why she never gave me exact measurements. I used to think it was because she didn't know them. Now I think she wanted me to learn to pay attention: to the way the dough pulls back when it's ready, the smell of the ginger, the weight of a dumpling with just enough filling. She was teaching me to trust my hands instead of a recipe.

I approach most things this way now. In chemistry lab, I'm the one who notices when a reaction looks wrong before the numbers do. When I tutor younger kids in math, I watch their faces as much as their worksheets. I learned that some knowledge can't be written down; it has to be practiced, corrected, and practiced again.

My grandmother still can't fold dumplings. But every Sunday I fold them at her table, and every Sunday she watches, and once in a while, she says "Okay."`,
    why: "'my grandmother', 'When I was fifteen', 'I learned that'; reflective first person with real-life dialogue and no citations.",
  },
  {
    name: "Reflective narrative, 'When I was twelve' recital",
    expect: "personal",
    text: `When I was twelve, I quit piano in the middle of a recital.

I don't mean that I stopped taking lessons afterward. I mean that I was sitting at the piano in the community center, in front of maybe sixty people, halfway through a Clementi sonatina I had practiced for four months, and my hands stopped. I looked down at the keys and could not remember a single note. The silence went on for what felt like a full minute. Then I stood up, bowed because I didn't know what else to do, and walked off the stage.

My mom found me in the parking lot, sitting on the curb next to our car. She didn't say anything at first. She just sat down next to me in her nice dress and handed me a granola bar from her purse, which is what she does in every emergency.

"I'm done," I told her. "I'm never playing again."

"Okay," she said.

I think I expected her to argue. My parents had paid for six years of lessons, and my teacher had told everyone I was ready. But she just nodded, and we sat there until the recital ended and people started coming out to their cars.

For two years I kept that promise. The piano in our living room turned into a place to stack mail. Whenever someone asked if I still played, I said I had gotten bored of it, which was easier than explaining that I was afraid of my own hands.

Then in ninth grade my friend Eli started a band and needed someone to play keyboard. I told him no three times. The fourth time he showed up at my house with the chords to a song written on the back of a math worksheet, and I played them just to make him leave. They were easy. They were fun. Nobody was watching except Eli, who was terrible at drums and didn't care.

We played our first show at a school fundraiser six months later. I messed up the intro to the second song, badly, and for a second I felt my hands start to freeze. Then I heard Eli laugh behind me and keep going, so I did too.

Looking back, I don't think I was ever really afraid of making mistakes. I was afraid of making them alone, in front of people who expected me to be perfect. What I learned from that recital, and from Eli's band, is that I don't have to be perfect to keep playing. I just have to keep playing.`,
    why: "Opens 'When I was twelve', family scenes, closes 'What I learned … is that'; dialogue is remembered, not fictional.",
  },
  {
    name: "Personal essay about a first job, mentions a statistic and a book in passing",
    expect: "personal",
    text: `My first real job was bagging groceries at Harvest Market the summer after sophomore year. I applied because my older brother had worked there and because I wanted to pay for my own car insurance, which my dad had made very clear was not going to be his problem.

The first week was humiliating. I put a carton of eggs under a bag of potatoes. I packed raw chicken with someone's birthday cake. A woman in a tennis visor asked for paper instead of plastic, and when I put her groceries in plastic anyway, she repeated "paper" slowly, the way you would talk to a dog. I went home every night with sore feet and a strong feeling that I was bad at something I had assumed anyone could do.

What saved me was Mrs. Delacroix, a cashier who had worked at Harvest for nineteen years. She noticed me fumbling on my third day and, without saying anything, started bagging alongside me at her register. Heavy things on the bottom. Cold things together. Bread and eggs last, on top, always. She worked fast and never seemed to think about it, and by the end of the week, neither did I.

I later read that roughly a third of high school students work during the school year, which surprised me, because at my school it felt like I was the only one. My friends were at the lake or at summer programs. I was learning which customers wanted to talk and which ones wanted silence, and how to tell the difference before they said anything. On my fifteen-minute breaks I sat on an overturned milk crate behind the loading dock and read The Outsiders for summer English, and it felt strange to be reading about kids who worked and worried about money while I was doing exactly that.

By August I was training new baggers. I taught them Mrs. Delacroix's rules, and I added one of my own: look at the person, not just the groceries. A man buying one can of soup and a single banana every day is not in a hurry, even if the line is long. A mom with three kids and a full cart needs you to be fast and not ask questions.

I still work at Harvest on weekends. I'm a cashier now, and I'm not bad at it. But the most important thing I learned there wasn't how to run a register. It was that the people who seem to do their jobs effortlessly have usually spent years paying attention, and that most of them are willing to teach you if you're willing to be bad at something for a while.`,
    why: "Tricky: a statistic ('roughly a third of high school students work') and a book title in passing, but it is a reflective life story with no citations.",
  },
  {
    name: "Personal essay that quotes Dickinson once",
    expect: "personal",
    text: `The Bird Feeder

The winter I stopped going to school, my dad hung a bird feeder outside my bedroom window.

I was fifteen, and I had been having panic attacks for about four months. They started in chemistry, of all places, during a test I wasn't even worried about. My heart started racing and my hands went numb, and I was sure I was dying. After that they came more often, in the hallway, in the cafeteria, eventually in the car on the way to school. By January my parents and my doctor agreed that I would finish the semester online.

I spent most of that winter in my room. I didn't want to see anyone, and I didn't want to do anything, and I definitely did not want to look at birds. When my dad came in with the feeder and a bag of sunflower seeds, I told him it was pointless. He hung it anyway and left without arguing.

The first visitor was a chickadee. It landed on the perch, grabbed one seed, and flew off to a branch to crack it open, then came back for another, and another. It did this for maybe ten minutes. I watched the whole time without meaning to.

By February I knew the regulars. There were two cardinals, a nuthatch that ate upside down, and a squirrel I named Gerald who spent every morning trying and failing to get onto the feeder. I started keeping a list in the back of a notebook. My therapist asked what I had been doing that week, and I was surprised to hear myself talk for five straight minutes about Gerald.

In English the year before, we had read the Emily Dickinson poem that begins "'Hope' is the thing with feathers," and I had rolled my eyes at it. It seemed like the kind of thing printed on a mug. That winter I understood it a little better. Hope wasn't a big feeling that arrived all at once. It was small and stubborn and it kept coming back to the same spot every morning, whether I was ready or not.

I went back to school in April. The panic attacks didn't disappear, but I learned how to breathe through them, and I learned that they would end. I still keep the bird list. It has forty-one species on it now.

My dad never said why he hung the feeder. I think he knew that I wouldn't listen to anyone telling me things would get better, but that I might listen to a chickadee.`,
    why: "Tricky: one Dickinson quotation, but the essay is about the writer's own winter, therapy and family, not an analysis of the poem.",
  },

  // ───────────────────────────── email ─────────────────────────────
  {
    name: "Very short email to a coach, three lines",
    expect: "email",
    text: `Hi Coach Rivera,
I have a dentist appointment after school so I'll be about 20 min late to practice today.
Thanks, Eli`,
    why: "Three lines: 'Hi Coach …,' greeting, one-sentence body, 'Thanks, Eli' sign-off.",
  },
  {
    name: "Email asking a teacher for an extension, with grade and date",
    expect: "email",
    text: `Subject: Extension request – Unit 4 essay

Hi Ms. Lopez,

I hope you're doing well. I'm writing to ask if I could have an extension on the Unit 4 argumentative essay that is due this Friday, October 17. I was out sick Monday through Wednesday with the flu (I have a note from the nurse's office) and I missed both workshop days in class.

I know I have a B+ in the class right now and I really don't want to turn in something rushed. Would it be possible to turn it in next Tuesday, October 21, instead? I already have my outline and two body paragraphs done, and I can share them with you if that helps.

Thank you for understanding,
Jordan Kim
Period 3`,
    why: "'Subject:' line, 'Hi Ms. Lopez,', a grade (B+) and due dates that are not claims to check, 'Thank you…, Jordan Kim'.",
  },
  {
    name: "Club email with a numbered list inside",
    expect: "email",
    text: `Hello team,

Quick recap from today's meeting so everyone's on the same page before the bake sale:

1. Priya and Sam are picking up the tables from the gym at 7:15 Saturday morning.
2. Everyone needs to bring at least two dozen items (label anything with nuts!!).
3. The cash box is with Mr. Okafor. He'll bring it to the front entrance by 8.
4. Shifts are posted in the group chat. If you can't make yours, swap with someone and let me know.

We raised $430 last spring so let's try to beat that. Tell me if I missed anything.

Best,
Hannah
Key Club Secretary`,
    why: "Tricky: a numbered list like a worksheet or notes, but framed by 'Hello team,' and 'Best, Hannah'.",
  },
  {
    name: "Workplace reply email with Re: subject",
    expect: "email",
    text: `Subject: Re: Q3 inventory count

Hi Dana,

Thanks for sending the spreadsheet over. I went through the warehouse numbers this morning and most of them line up, but there are two things I want to flag before this goes to finance.

The count for the 12 oz. ceramic mugs (SKU 4471) shows 1,240 on hand, but we shipped 300 of those to the Portland store on the 28th and I don't think that transfer was entered yet. Can you double-check with receiving?

Also, the damaged-goods line is blank for September. Luis mentioned at least one pallet came in crushed, so we should probably get a number in there even if it's an estimate.

Otherwise it looks good. If you can update those two by Thursday I'll send the final version to Priya on Friday morning.

Thanks,
Marcus`,
    why: "'Subject: Re:', 'Hi Dana,', business figures that are internal facts, 'Thanks, Marcus'.",
  },

  // ─────────────────────────── coverletter ───────────────────────────
  {
    name: "Cover letter for a marketing internship",
    expect: "coverletter",
    text: `Dear Hiring Manager,

I am writing to apply for the Summer Marketing Internship at Brightline Media that I found on my university's career site. As a sophomore majoring in communications at the University of Oregon, I have been looking for an opportunity to apply what I have learned in class to real campaigns, and Brightline's work with local nonprofits is exactly the kind of marketing I hope to do.

This past year I served as social media coordinator for the Associated Students' sustainability committee. I planned and scheduled content for our Instagram and TikTok accounts, designed graphics in Canva and Adobe Express, and wrote weekly posts promoting events like our campus clothing swap. Over two terms our accounts grew from about 600 to more than 2,100 followers, and attendance at the clothing swap nearly doubled from the year before.

In my Strategic Communication course, I worked with three classmates to develop a full campaign proposal for a local animal shelter, including audience research, messaging and a small paid-ads budget. The shelter ended up using two of our ideas in its spring adoption drive. That project taught me how much research and testing go into a message that looks simple.

I am organized, comfortable with deadlines, and genuinely curious about why some content connects with people and some doesn't. I would welcome the chance to learn from your team and contribute to Brightline's campaigns this summer.

Thank you for your time and consideration. I have attached my resume and a short portfolio, and I would be glad to talk further at your convenience.

Sincerely,
Olivia Chen`,
    why: "'Dear Hiring Manager,', 'I am writing to apply for the … Internship', qualifications, 'Sincerely,'.",
  },
  {
    name: "High-school cover letter with address block for a library page job",
    expect: "coverletter",
    text: `Marcus Bell
1442 Alder Street
Fresno, CA 93711
(559) 555-0148
marcus.bell@example.com

May 2, 2025

Ms. Teresa Gomez
Branch Manager
Woodward Park Branch Library
Fresno, CA 93720

Dear Ms. Gomez,

I would like to be considered for the part-time Library Page position posted on the county's job board. I am a junior at Bullard High School, and I have been visiting the Woodward Park branch since I was in elementary school, so working there would mean a lot to me.

For the past two years I have volunteered with the branch's summer reading program, where I helped younger kids pick out books, logged their reading minutes, and set up crafts for the weekly events. I also work as a student aide in my school's library during my free period, so I am already familiar with shelving by call number and checking books in and out.

I am reliable and I pay attention to details. My teachers have trusted me with organizing classroom supplies and keeping track of equipment for the robotics club. I am available after 3:30 p.m. on weekdays and all day on Saturdays.

Thank you for considering my application. I have enclosed my resume and a reference from Mrs. Patel, the head librarian at my school. I hope to have the chance to speak with you.

Sincerely,
Marcus Bell`,
    why: "Sender and recipient address blocks, date, 'Dear Ms. Gomez,', 'I would like to be considered for the … position', 'Sincerely,'.",
  },
  {
    name: "Cover letter with sales statistics",
    expect: "coverletter",
    text: `Dear Hiring Manager,

Please accept this letter as my application for the Assistant Store Manager position at Northpeak Outfitters. For the past three years I have worked as a senior sales associate at Trailhead Sports, and I am ready to take on a leadership role with a company whose products I already use and recommend.

At Trailhead, I increased sales in the footwear department by 20% in 2024 by reorganizing our displays around activities instead of brands and by training staff to ask customers what they were planning to do before recommending a shoe. I also trained eleven new employees, created a one-page guide to our point-of-sale system that the store still uses, and covered as acting shift lead during our manager's leave, when we finished the quarter 8% above target.

I enjoy the parts of retail that other people sometimes avoid: closing out the register, solving scheduling conflicts, and talking with a frustrated customer until they leave satisfied. I believe a good store runs on clear expectations and a team that feels trusted, and that is the kind of manager I want to be.

I would welcome the opportunity to discuss how my experience could help Northpeak's new location get off to a strong start. Thank you for your time and consideration.

Sincerely,
Danielle Ortiz`,
    why: "Tricky: figures like 'increased sales … by 20%' and '8% above target' are self-reported achievements, not claims needing citation.",
  },
  // ───────────────────────────── letter ─────────────────────────────
  {
    name: "Letter to the editor about library hours",
    expect: "letter",
    text: `To the Editor:

I was disappointed to read in last week's Gazette that the county plans to close the Maple Street branch library on Saturdays beginning in January in order to save money.

I have lived in Westfield for thirty-one years, and I have used that library nearly every Saturday for most of them. But this is not about me. Every Saturday morning the children's room is full of families who cannot come during the week because the parents are working. The computer lab is full of people applying for jobs, filling out benefit forms and printing boarding passes. For many of them, Saturday is the only day they can get there.

The county says closing on Saturdays will save about $85,000 a year. That is real money, and I understand that the budget is tight. But surely there are other options. The library could close on Monday mornings instead, when it is nearly empty. The Friends of the Library have also offered to cover part of the cost through our annual book sale.

A library is not a luxury. It is one of the few places left where anyone can walk in, sit down and stay as long as they like without buying anything. I urge the county commissioners to reconsider before the January vote, and I urge readers to attend the public hearing on December 9.

Ruth Ellison
Westfield`,
    why: "'To the Editor:' salutation, names the paper, argues to readers, signed with name and town; not an email (no Hi/Thanks).",
  },
  {
    name: "Thank-you letter to a grandparent",
    expect: "letter",
    text: `Dear Grandpa Joe,

Thank you so much for the fishing rod you sent for my birthday! I couldn't believe it when I opened the box. It's the exact one we looked at in the store when I visited you in July, and I didn't even think you noticed me looking at it.

Dad took me to Miller's Pond last Saturday to try it out. I didn't catch anything for the first hour and I was starting to think the fish could tell I was a beginner, but then I caught a bluegill! It was pretty small so we let it go, but Dad took a picture, and I'm putting it in this envelope so you can see. (I'm the one smiling. The fish is the one not smiling.)

I've been practicing my casting in the backyard with a weight instead of a hook, like you showed me. I can almost hit the tree by the fence now. Mom says I'm not allowed to practice near her tomato plants anymore.

I hope your knee is feeling better and that Grandma isn't making you do too much yard work. I really miss you both. Mom says we might be able to come up for Thanksgiving, and if we do, I want to go out on the lake with you, even if it's cold.

Thank you again for the best birthday present ever.

Love,
Ellie`,
    why: "'Dear Grandpa Joe,' … 'Love, Ellie', paper-letter cues ('putting it in this envelope'); personal but addressed to one reader.",
  },
  {
    name: "Formal complaint letter, To Whom It May Concern",
    expect: "letter",
    text: `To Whom It May Concern:

I am writing to formally complain about the service I received from your company regarding a washing machine I purchased from your Riverside store on August 14 (Order #A-10482).

The machine was delivered on August 19. During installation, your delivery team scratched the hallway floor and left the old machine in my driveway instead of hauling it away, even though the $35 haul-away fee appears on my receipt. Two days later, the new washer began leaking from the bottom during every spin cycle.

I called your customer service line on August 22, August 29 and September 5. Each time I was told a technician would contact me within 48 hours. No one did. On September 12 I visited the store in person and was told by a manager that the warranty claim had been "lost in the system" and would have to be submitted again.

It has now been more than five weeks since I bought a machine that I cannot use. I have spent approximately $60 at a laundromat in that time, and I have taken two afternoons off work to wait for repair calls that never came.

I am requesting that your company either replace the washer with a new unit or issue a full refund of $749.99, and that you reimburse the $35 haul-away fee. I would also like the damage to my floor to be addressed.

I have kept copies of my receipt, the delivery confirmation and notes from each phone call. I would appreciate a written response within fourteen days.

Sincerely,
Robert Feld`,
    why: "'To Whom It May Concern:', 'I am writing to formally complain', dates and amounts that are the writer's own records, 'Sincerely,'.",
  },

  // ───────────────────────────── resume ─────────────────────────────
  {
    name: "High-school student resume with ● bullets",
    expect: "resume",
    text: `Maya Robinson
Sacramento, CA | (916) 555-0182 | maya.robinson@example.com

EDUCATION
Westbrook High School, Sacramento, CA
Expected Graduation: June 2026
GPA: 3.92 unweighted / 4.31 weighted
Relevant Coursework: AP Biology, AP Chemistry, AP Statistics, Anatomy & Physiology

EXPERIENCE
Lifeguard, Arden Community Pool
June 2024 – Present
● Monitor up to 120 swimmers per shift and enforce pool safety rules
● Performed 3 water rescues and gave first aid for minor injuries
● Teach Level 1–2 swim lessons to groups of 6–8 children
Volunteer Tutor, Sacramento Public Library – North Branch
September 2023 – Present
● Tutor 4–6 elementary students weekly in reading and math
● Created flashcard sets now used by the branch's homework help program

LEADERSHIP & ACTIVITIES
Varsity Swim Team, Captain (2025–2026)
● Organize team warm-ups and mentor 10 first-year swimmers
Science Olympiad, Member (2022 – Present)
● Placed 3rd in Anatomy & Physiology at the 2025 Regional Tournament

CERTIFICATIONS
American Red Cross Lifeguarding, CPR/AED and First Aid (exp. 2026)

SKILLS
Bilingual (English/Spanish) · Microsoft Excel · Google Workspace · Canva

AWARDS
AP Scholar with Distinction (2025)
Honor Roll, 9th–11th grade`,
    why: "Name + contact line, EDUCATION/EXPERIENCE/SKILLS caps headings, 'June 2024 – Present' ranges, ● bullets with numbers.",
  },
  {
    name: "College CS student resume with • bullets and metrics",
    expect: "resume",
    text: `DANIEL OKAFOR
Columbus, OH • (614) 555-0139 • daniel.okafor@example.edu • dokafor.example.dev

EDUCATION
The Ohio State University, Columbus, OH
B.S. in Computer Science and Engineering, Minor in Statistics — Expected May 2027
GPA: 3.7/4.0 | Dean's List (5 semesters)

EXPERIENCE
Software Engineering Intern — Meridian Health Analytics, Columbus, OH
May 2025 – August 2025
• Built a Python service that cleans and validates 2M+ patient-visit records nightly, cutting manual review time by 40%
• Wrote unit tests that raised coverage of the ingestion pipeline from 52% to 81%
• Presented a dashboard prototype (React, D3) to the product team; adopted for the Q4 roadmap
Undergraduate Teaching Assistant — CSE 2221: Software I
January 2024 – Present
• Lead two weekly lab sections of 30 students in Java fundamentals
• Hold 4 office hours per week and grade projects for 120 students

PROJECTS
CampusEats (Swift, Firebase)
• iOS app showing real-time dining hall menus; 1,500+ downloads from students
Course Planner (TypeScript, Node.js)
• Web tool that checks degree requirements and suggests schedules; piloted by 300+ students

SKILLS
Languages: Python, Java, TypeScript, Swift, SQL, C
Tools: Git, Docker, AWS (EC2, S3), PostgreSQL, Linux
Coursework: Data Structures, Algorithms, Databases, Machine Learning, Operating Systems

ACTIVITIES
Vice President, Black Engineers Society (2025 – Present)
Buckeye Hackathon 2024 — Best Use of Data award`,
    why: "All-caps name, • bullets full of percentages and counts that are achievements, not claims; PROJECTS/SKILLS sections.",
  },
  {
    name: "Mid-career professional resume with - bullets and summary",
    expect: "resume",
    text: `Jennifer L. Morales
Austin, Texas · 512-555-0117 · jmorales@example.com

PROFESSIONAL SUMMARY
Operations manager with 9 years of experience in logistics and warehouse management. Proven record of reducing costs, improving safety, and leading teams of up to 45 employees.

PROFESSIONAL EXPERIENCE
Operations Manager, Lone Star Distribution Co., Austin, TX
June 2023 – Present
- Oversee daily operations of a 220,000 sq. ft. distribution center shipping 18,000 orders per week
- Reduced order fulfillment errors by 32% by introducing barcode verification at packing stations
- Cut overtime costs by $140,000 annually through redesigned shift scheduling
- Lead a team of 6 supervisors and 45 hourly associates

Warehouse Supervisor, Pecan Freight Logistics, Round Rock, TX
March 2019 – May 2023
- Supervised inbound receiving across 3 shifts; improved dock-to-stock time from 48 to 20 hours
- Achieved 600+ consecutive days without a recordable safety incident
- Trained 70+ new hires on forklift safety and inventory software

Inventory Coordinator, Hill Country Supply, San Marcos, TX
August 2016 – February 2019
- Managed cycle counts for 12,000 SKUs with 99.4% inventory accuracy
- Worked with purchasing to reduce excess stock by 15%

EDUCATION
B.B.A., Supply Chain Management — Texas State University, 2016

CERTIFICATIONS
Certified Supply Chain Professional (CSCP) — 2021
OSHA 30-Hour General Industry — 2020

SKILLS
SAP · Oracle WMS · Lean Six Sigma (Green Belt) · Excel (pivot tables, VLOOKUP) · Bilingual English/Spanish`,
    why: "Summary paragraph is a full sentence, but PROFESSIONAL EXPERIENCE with month-year ranges and '- Reduced … by 32%' bullets dominate.",
  },

  // ───────────────────────────── notes ─────────────────────────────
  {
    name: "Essay outline with I./A. numbering",
    expect: "notes",
    text: `Outline – Argumentative Essay: Should Schools Ban Phones During Class?

I. Introduction
A. Hook: "How many times have you checked your phone today?" – avg teen gets dozens of notifications a day
B. Background: more schools + some states adopting bell-to-bell phone bans
C. Thesis: Schools should ban phones during class because they distract students, hurt mental health, and make cheating easier
II. Body Paragraph 1 – Distraction
A. Topic sentence: phones pull attention away from learning
B. Evidence: study on notifications + test scores (find source!!)
C. Explanation: even having the phone face-down on the desk = less focus
D. Example: 2nd period when someone's phone goes off
III. Body Paragraph 2 – Mental health
A. Topic sentence: constant social media during the day increases stress
B. Evidence: survey data on anxiety + social media use
C. Explanation: lunch/breaks = time to actually talk to people
IV. Body Paragraph 3 – Cheating
A. Photos of tests, group chats w/ answers
B. Teacher interview? (ask Mr. Grant)
V. Counterargument
A. Parents want to reach kids in emergencies
B. Rebuttal: office phone; phones still available at lunch from lockers/pouches
VI. Conclusion
A. Restate thesis in new words
B. Call to action – school board vote in May`,
    why: "Roman-numeral I./II. with A./B. sub-points, fragments, '=' and 'w/' shorthand; a plan for an essay, not the essay.",
  },
  {
    name: "History lecture notes with dates and bullets (● ○)",
    expect: "notes",
    text: `WWI – Causes & Outbreak (Ch. 22 notes) 10/14

Causes of WWI: militarism, alliances, imperialism, nationalism (MAIN)
● Militarism – arms race, esp. Britain vs. Germany navy (dreadnoughts after 1906)
● Alliances
○ Triple Alliance: Germany, Austria-Hungary, Italy (1882)
○ Triple Entente: Britain, France, Russia (by 1907)
● Imperialism – competition for colonies in Africa/Asia; Moroccan crises 1905 & 1911
● Nationalism – Pan-Slavism, Serbia wants to unite South Slavs; A-H afraid of losing territory
Spark: assassination of Archduke Franz Ferdinand – June 28, 1914, Sarajevo
● Gavrilo Princip – linked to the Black Hand (Serbian nationalist group)
July Crisis
● July 23 – A-H ultimatum to Serbia
● July 28 – A-H declares war on Serbia
● Russia mobilizes to support Serbia → Germany declares war on Russia Aug 1, France Aug 3
● Schlieffen Plan – Germany goes through Belgium to reach France fast
● Britain declares war on Germany Aug 4 (b/c Belgian neutrality – Treaty of London 1839)
Key terms: total war, trench warfare, stalemate, Western Front
Q for test: why did a local conflict become a world war? → alliance system = chain reaction
!! know the 4 MAIN causes + 1 example each`,
    why: "Dated lecture notes: heading with date, 'Causes of WWI:' colon list, ●/○ nested bullets, arrows, abbreviations (A-H, b/c).",
  },
  {
    name: "Biology notes that contain full sentences in places",
    expect: "notes",
    text: `Cellular Respiration – notes 11/3

Overall: C6H12O6 + 6O2 → 6CO2 + 6H2O + ATP (~36–38 ATP)
- mostly in mitochondria (glycolysis is in cytoplasm)
- aerobic = needs O2

1. Glycolysis
- glucose (6C) split into 2 pyruvate (3C)
- net 2 ATP, 2 NADH
- no oxygen needed. This is why even anaerobic organisms can do it, and it's probably the oldest pathway since early Earth had almost no oxygen.

2. Krebs cycle (citric acid cycle)
- mitochondrial matrix
- pyruvate → acetyl CoA first (releases CO2)
- per glucose: 2 ATP, 6 NADH, 2 FADH2, 4 CO2

3. Electron transport chain
- inner membrane (cristae)
- NADH + FADH2 drop off electrons → pumps H+ into intermembrane space
- H+ flows back through ATP synthase → makes most of the ATP (~32–34)
- O2 = final electron acceptor → forms water
Mrs. K said this will definitely be on the test: if there's no oxygen, the whole chain backs up and the cell has to rely on fermentation, which only makes 2 ATP per glucose.

Fermentation
- lactic acid (muscles) vs. alcoholic (yeast → ethanol + CO2)
- regenerates NAD+ so glycolysis can keep going

!! photosynthesis & respiration = basically opposites`,
    why: "Tricky: a couple of full explanatory sentences, but numbered sections, '-' fragments, arrows and '=' shorthand make it notes.",
  },
  {
    name: "Reading notes on a novel with short quotes and page numbers",
    expect: "notes",
    text: `Gatsby reading notes – Ch. 1–3
(for Socratic seminar Thurs)

Ch. 1
- narrator = Nick Carraway, from the Midwest, moves to West Egg in 1922, sells bonds
- says he's "inclined to reserve all judgments" (1) → is he actually reliable??
- Tom + Daisy Buchanan live in East Egg (old money), Jordan Baker = golfer
- Tom = aggressive, brags about a racist book he read
- end of ch: Gatsby reaching toward green light across the bay (21) – SYMBOL
Ch. 2
- valley of ashes between West Egg + NYC (23) = poverty/decay
- eyes of Doctor T. J. Eckleburg billboard → God watching?
- Tom's affair w/ Myrtle Wilson, party at the apartment in NYC
- Tom breaks Myrtle's nose when she says Daisy's name
Ch. 3
- Gatsby's parties: "men and girls came and went like moths" (39)
- Nick actually gets an invitation (most ppl just show up)
- rumors: Gatsby killed a man, German spy, etc.
- Nick meets Gatsby w/o knowing it's him
- Jordan lies about the car → dishonesty theme
Themes so far: wealth/class (old vs. new money), appearance vs. reality, careless rich people
Q's for seminar:
1. Why does Fitzgerald make Nick the narrator instead of Gatsby?
2. What does the valley of ashes say about the American Dream?`,
    why: "Tricky: quotes with page numbers and talk of symbols like a literary essay, but chapter-by-chapter '-' fragments and seminar questions make it notes.",
  },

  // ─────────────────────────── annotated ───────────────────────────
  {
    name: "MLA annotated bibliography, reference and annotation in one paragraph",
    expect: "annotated",
    text: `Lauren Pierce
Ms. Adeyemi
AP Environmental Science
18 November 2025

Annotated Bibliography: Community Solar Programs

Brennan, Kate. "Who Really Benefits from Community Solar?" Energy Policy Today, vol. 14, no. 3, 2022, pp. 45–58. This article argues that community solar programs, where several households share the output of one solar array, are often marketed to low-income families but mostly reach middle-income homeowners. Brennan analyzes enrollment data from five states and finds that fewer than one in five subscribers had household incomes below the state median. The article is useful because it gives specific numbers I can use in my section on equity, although the author is clearly critical of the programs and does not discuss states where enrollment has improved.

Harmon, Luis, and Dana Kerr. Sharing the Sun: Community Energy in America. Ridgeline Press, 2021. Harmon and Kerr trace community solar from the first small projects to the state laws that now support them. The book explains how virtual net metering works in plain language, which will help me explain the basic idea to readers. Since it was published in 2021, some of the policy information may be out of date, so I will check it against newer sources.

"Community Solar Basics." Clean Power Information Center, 2023, www.cleanpowerinfo.example.org/community-solar. This website summarizes how community solar subscriptions work, what they typically cost, and how much customers usually save on their electric bills. It is written for consumers rather than experts, so it is not very detailed, but it will be helpful for defining key terms in my introduction. The site is run by a nonprofit and does not appear to be selling anything.

Okafor, Ngozi. "Rooftops for Renters." The Midwest Review, 9 Apr. 2024, pp. 22–25. Okafor profiles three renters who joined a community solar garden and describes what they saved over one year. This source will be useful because it shows the human side of the issue and gives me a strong example for my hook. However, it is based on only three people, so I will not use it to make general claims.`,
    why: "Each paragraph opens with a full MLA entry, then 'This article argues…' / 'This source will be useful because…' evaluation.",
  },
  {
    name: "APA annotated bibliography on screen time",
    expect: "annotated",
    text: `Annotated Bibliography

Bennett, R., & Choi, M. (2020). Screen time and sleep in early adolescence: A longitudinal study. Journal of Youth Health, 12(2), 115–129. Bennett and Choi followed 1,200 middle school students for two years and found that students who used screens in the hour before bed slept an average of 34 minutes less than those who did not. The study is strong because it is longitudinal and has a large sample, though it relies on students reporting their own screen use. I will use it to support my claim that the timing of screen use matters more than total hours.

Delgado, F. (2021). Not all screen time is equal. Child Development Perspectives Now, 5(1), 8–14. This review article argues that research on screen time often lumps together very different activities, such as video chatting with family and scrolling social media. Delgado summarizes more than forty studies and concludes that passive use is more strongly linked to low mood than active or social use. This source will be useful for my counterargument section, since it complicates the idea that all screen time is harmful.

Lindqvist, H., Patel, S., & Moreno, A. (2022). Parental controls and adolescent wellbeing. Family Technology Research, 3(4), 201–219. The authors surveyed 850 families and found that strict time limits set by parents were not associated with better wellbeing, but family rules about phones at meals and at bedtime were. The article is recent and peer-reviewed, and it gives me practical recommendations for my conclusion.

Okoro, T. (2019, March 3). Why I gave my teenager a flip phone. The Weekend Paper. https://www.weekendpaper.example.com/flip-phone Okoro, a parent and journalist, describes her family's experience replacing her daughter's smartphone with a basic phone for six months. The article is personal rather than scientific, so I will use it only as an example of how some parents are responding, not as evidence.`,
    why: "APA entries (Author, I. (Year). Title. Journal, vol(issue), pages.) each followed by summary + evaluation sentences.",
  },
  {
    name: "Annotated Works Cited with the annotation on the next line",
    expect: "annotated",
    text: `Annotated Works Cited – Transcontinental Railroad Project
Reyes, Tomás. Iron Roads West: Building the Transcontinental Railroad. Mesa Books, 2018.
Reyes tells the story of the railroad's construction from both the Central Pacific and Union Pacific sides, with a focus on the workers who built it. His chapters on Chinese laborers in the Sierra Nevada are the most detailed part of the book. I will use this as my main background source since it covers the whole project from 1863 to 1869.
"The Golden Spike." National Railroad Heritage Site, 2020, www.railheritage.example.org/golden-spike.
This web page explains the ceremony at Promontory Summit on May 10, 1869, and includes photographs and a timeline. It is short and general, but it was useful for checking dates.
Liu, Grace. "Forgotten Builders: Chinese Workers and the Central Pacific." Western History Quarterly, vol. 51, no. 2, 2020, pp. 133–150.
Liu uses payroll records and letters to argue that Chinese workers were paid less than white workers and were given the most dangerous jobs, including blasting tunnels. This is a scholarly source and will be very important for my second body paragraph about labor. Its bibliography will also help me find more sources.
Whitman, Paul. "Railroads and the Plains Nations." American West Review, 12 Jan. 2021.
Whitman explains how the railroad brought settlers and hunters onto the Great Plains and contributed to the destruction of the buffalo herds that Plains nations depended on. This source will help me show that the railroad had serious costs as well as benefits. I still need a source written from a Native perspective to go with it.`,
    why: "Tricky layout: no blank lines and each annotation is its own paragraph after the reference line, so the reference-then-annotation pairing must be read across lines.",
  },

  // ───────────────────────────── homework ─────────────────────────────
  {
    name: "Physics forces problem set with numbered problems and worked answers",
    expect: "homework",
    text: `Physics – Unit 3 Homework: Forces
Name: Ethan Park   Period 5

1. Calculate the net force on a 12 kg box if one person pushes it to the right with 50 N and friction acts to the left with 14 N.
Fnet = 50 N − 14 N = 36 N to the right

2. What is the acceleration of the box in #1?
a = F/m = 36 N / 12 kg = 3.0 m/s²

3. A 1,200 kg car accelerates from rest to 24 m/s in 8.0 s.
a) Determine the acceleration of the car.
a = Δv/t = 24 / 8.0 = 3.0 m/s²
b) Determine the net force on the car.
F = ma = 1200 × 3.0 = 3,600 N

4. Explain why a passenger in a car that stops suddenly keeps moving forward.
Inertia (Newton's 1st law) – the passenger's body keeps moving at the same speed until a force (the seatbelt) stops it.

5. A 65 kg student stands on a scale in an elevator accelerating upward at 1.5 m/s². What does the scale read?
N = m(g + a) = 65(9.8 + 1.5) = 65 × 11.3 ≈ 735 N

6. Draw a free-body diagram for a book resting on a table.
(see drawing) weight down, normal force up, equal size

7. A 3.0 kg block slides across a surface with μk = 0.20. Find the friction force.
Ff = μmg = 0.20 × 3.0 × 9.8 ≈ 5.9 N

8. Two forces, 30 N east and 40 N north, act on an object. What is the magnitude of the net force?
√(30² + 40²) = 50 N`,
    why: "Numbered problems ('1. Calculate the net force…', 'a) Determine…') with one-line worked answers and units.",
  },
  {
    name: "Chemistry stoichiometry worksheet",
    expect: "homework",
    text: `Stoichiometry Practice – Worksheet 7.2
Chemistry / Ms. Abernathy
Show all work. Use correct sig figs.

1. Balance the equation: __ Al + __ O2 → __ Al2O3
4 Al + 3 O2 → 2 Al2O3

2. How many moles of O2 are needed to react completely with 5.4 mol Al?
5.4 mol Al × (3 mol O2 / 4 mol Al) = 4.1 mol O2

3. Calculate the molar mass of Al2O3.
2(26.98) + 3(16.00) = 101.96 g/mol

4. 2 H2 + O2 → 2 H2O
a) How many grams of water are produced from 4.0 g of H2?
4.0 g ÷ 2.02 g/mol = 1.98 mol H2 → 1.98 mol H2O × 18.02 g/mol = 36 g H2O
b) Identify the limiting reactant if 4.0 g H2 reacts with 16.0 g O2.
16.0 g ÷ 32.00 g/mol = 0.500 mol O2, needs 1.00 mol H2, have 1.98 mol → O2 is limiting

5. What is the percent yield if a reaction should make 25.0 g of product but only 21.3 g is collected?
21.3 / 25.0 × 100 = 85.2%

6. Explain why the actual yield is usually less than the theoretical yield.
Some product is lost when transferring or filtering, side reactions use up reactants, and some reactions don't go to completion.

7. CaCO3 → CaO + CO2. How many liters of CO2 at STP are produced from 50.0 g of CaCO3?
50.0 g ÷ 100.09 g/mol = 0.500 mol × 22.4 L/mol = 11.2 L CO2`,
    why: "Worksheet title + instructions, numbered tasks with blanks '__', a)/b) parts and short computed answers.",
  },
  {
    name: "History short-answer worksheet with numbered questions",
    expect: "homework",
    text: `Name: Brianna Ortiz
U.S. History – Ch. 22 Review Questions: The Great Depression
Due: Thurs 2/13

1. What were the main causes of the Great Depression?
Overproduction in farming and industry, people buying stocks on margin, bank failures, and an unequal distribution of wealth. The stock market crash in October 1929 started the panic.

2. What happened on Black Tuesday?
On October 29, 1929, the stock market crashed and investors traded about 16 million shares in one day as prices collapsed.

3. Why did so many banks fail between 1929 and 1933?
People panicked and tried to take their money out all at once (bank runs). Banks had loaned the money out or lost it in the market, so they couldn't pay everyone back, and there was no deposit insurance yet.

4. Describe a "Hooverville."
Shantytowns made of cardboard, scrap metal and crates where homeless people lived. They were named after President Hoover because people blamed him.

5. How did President Hoover respond to the Depression? Give two examples.
He believed in "rugged individualism" and didn't think the federal government should give direct relief. He did create the Reconstruction Finance Corporation in 1932 to lend money to banks and railroads, and he supported public works like the Hoover Dam.

6. What was the Bonus Army, and how did the government respond?
World War I veterans who marched on Washington in 1932 to ask for early payment of their bonuses. Hoover sent the army to remove them, and troops used tear gas and burned their camp.

7. Explain how the Dust Bowl made the Depression worse for farmers.
Drought and dust storms destroyed crops on the Great Plains, so farmers who were already in debt lost everything. Many moved west to California.

8. In 2–3 sentences, explain which cause you think was most important.
I think speculation in the stock market was the most important because it caused the crash that made people lose trust in banks. Once people stopped spending, businesses closed and unemployment went up.`,
    why: "Tricky: full-sentence history answers like an essay, but it is a numbered list of '1. What were the causes of…?' questions with answers under each.",
  },
  {
    name: "Algebra 2 quadratics homework",
    expect: "homework",
    text: `Algebra 2 – HW 4.3 Quadratics
Show work!!

1. Solve x² − 5x + 6 = 0.
(x − 2)(x − 3) = 0 → x = 2, x = 3

2. Find the vertex of y = 2x² − 8x + 3.
x = −b/2a = 8/4 = 2, y = 2(4) − 16 + 3 = −5 → vertex (2, −5)

3. Use the quadratic formula to solve 3x² + 2x − 4 = 0.
x = (−2 ± √(4 + 48)) / 6 = (−1 ± √13) / 3 → x ≈ 0.87, x ≈ −1.54

4. Find the discriminant of x² + 4x + 7 and state the number of real solutions.
b² − 4ac = 16 − 28 = −12 → no real solutions

5. A ball's height is h(t) = −16t² + 48t + 5.
a) When does it reach its maximum height?
t = −48 / (2 · −16) = 1.5 s
b) What is the maximum height?
h(1.5) = −16(2.25) + 72 + 5 = 41 ft
c) When does it hit the ground? Round to the nearest hundredth.
t = (48 + √2624) / 32 ≈ 3.10 s

6. Write a quadratic in standard form with roots 4 and −1.
(x − 4)(x + 1) = x² − 3x − 4

7. Solve by completing the square: x² + 6x + 2 = 0
(x + 3)² = 7 → x = −3 ± √7

8. Explain in words what the discriminant tells you about the graph.
How many times the parabola crosses the x-axis: positive = 2, zero = 1, negative = none.`,
    why: "Math problem set: numbered equations, a)/b)/c) parts, symbolic answers with arrows; almost no prose.",
  },
  // ───────────────────────────── prose ─────────────────────────────
  {
    name: "Argumentative essay with MLA citations and Works Cited",
    expect: "prose",
    text: `Tyler Nguyen
Ms. Carter
English 10
14 April 2025

Pay the Players

Every March, millions of Americans fill out brackets for the college basketball tournament, and the television deal alone is worth billions of dollars. The players who make that spectacle possible, however, have traditionally received nothing beyond scholarships. Although recent rule changes now let athletes earn money from endorsements, colleges themselves should pay their athletes directly, because the athletes generate enormous revenue, work full-time hours, and take on real physical risks.

First, college sports are a business, and the athletes are the product. Top football and basketball programs earn tens of millions of dollars a year from tickets, merchandise and media rights, and much of that money goes to coaches' salaries and new facilities (Branch 82). Meanwhile, the players cannot share in the money their games bring in. As one economist puts it, "No other industry expects its most important workers to perform for free" (Kim 14). A scholarship is valuable, but it is not the same as a share of the profits.

Second, being a college athlete is a full-time job. Division I athletes often spend more than forty hours a week on practice, travel, film study and games, which leaves little time for classes or a part-time job (Rivera). Many athletes come from low-income families and struggle to afford basic expenses that a scholarship does not cover. Paying them would let them focus on both school and sports without worrying about rent or food.

Finally, athletes risk their health for their schools. A serious injury can end a career before an athlete ever reaches the professional level, and many leave college with chronic pain or lingering concussion symptoms (Branch 90). If a school earns money from those games, it should share that money with the people taking the risk.

Critics argue that paying athletes would destroy the amateur spirit of college sports and that schools without big football programs could not afford it. These concerns are fair, but a revenue-sharing model, in which athletes in profitable sports receive a share of the money their sport brings in, would protect smaller programs while still treating athletes fairly (Kim 22). Amateurism has already changed now that players can sign endorsement deals, and fans have not stopped watching.

College athletes bring in billions of dollars, work as hard as any employee, and risk their bodies every game. It is time for colleges to stop treating them as volunteers and start paying them for the work they do.

Works Cited
Branch, Marcus. The Business of College Sports. Crestline Press, 2019.
Kim, Laura. "Amateurism and the Modern Athlete." Sports Economics Review, vol. 9, no. 1, 2021, pp. 10–25.
Rivera, Alex. "Inside the 40-Hour Week of a College Athlete." The Campus Ledger, 2 Oct. 2022, www.campusledger.example.com/athlete-hours.`,
    why: "Tricky vs research: has (Author page) citations and Works Cited, but a few citations serve a persuasive thesis, counterargument and call to action.",
  },
  {
    name: "Expository/argumentative essay with no citations at all",
    expect: "prose",
    text: `Why Every Teenager Should Learn to Cook

Most teenagers can order food from an app in under a minute, but many of them could not make a simple dinner if their lives depended on it. Cooking used to be something people learned at home or in school, and now it is often skipped entirely. Every teenager should learn to cook before they leave home, because it saves money, leads to healthier eating, and builds independence.

The most obvious benefit of cooking is the money it saves. A takeout burrito can easily cost fifteen dollars once delivery fees and tips are added, while the ingredients to make four burritos at home cost about the same. A student who learns to cook a handful of cheap, filling meals like pasta, rice and beans, or stir-fry can save hundreds of dollars a year. For young people about to pay for college, rent or a car, that money matters.

Cooking also gives people control over what they eat. Restaurant and packaged foods tend to be high in salt, sugar and fat because those are the flavors that keep customers coming back. When you cook for yourself, you decide how much of each goes in. You also tend to eat more vegetables, simply because they are sitting in your kitchen and you have to use them before they go bad.

Finally, learning to cook builds a kind of confidence that is hard to get anywhere else. Following a recipe means planning ahead, managing time, and fixing mistakes as they happen. The first time someone cooks a meal for their family or friends and watches them enjoy it, they realize they can take care of themselves and others. That feeling carries over into other parts of life.

Some people argue that cooking takes too much time for busy students, who already have homework, sports and jobs. But cooking does not have to be complicated. Many good meals take less than thirty minutes, and cooking a big batch on Sunday can provide lunches for the whole week.

Learning to cook is one of the most practical skills a teenager can have. It saves money, improves health, and makes young people more independent. Schools and families should make sure no one graduates without knowing how to make at least a few good meals.`,
    why: "Five-paragraph-style essay: thesis, body reasons, counterargument, conclusion; zero citations, no heading block.",
  },
  {
    name: "History argumentative essay, Treaty of Versailles, NOT a DBQ",
    expect: "prose",
    text: `Daniel Ortiz
Mr. Brennan
World History
2 December 2025

Did the Treaty of Versailles Cause World War II?

When the Treaty of Versailles was signed on June 28, 1919, many Germans called it a "dictated peace." Germany lost about thirteen percent of its European territory and all of its colonies, its army was limited to 100,000 men, the Rhineland was demilitarized, and Article 231 forced Germany to accept responsibility for the war. Historians have long argued that the treaty's harshness made another war almost certain. The Treaty of Versailles created the resentment that Hitler later exploited, but it did not make World War II inevitable; the Great Depression and the Allies' failure to enforce the treaty were just as important.

There is no doubt that the treaty humiliated Germany. The war guilt clause was especially resented because most Germans believed they had fought a defensive war. The reparations bill, set in 1921 at 132 billion gold marks, seemed impossible to pay. When Germany fell behind on payments in 1923, French and Belgian troops occupied the Ruhr, and the German government responded by printing money, causing hyperinflation so severe that people carried wages home in wheelbarrows. Many middle-class Germans lost their savings and blamed the treaty and the politicians who had signed it.

However, by the mid-1920s Germany had recovered. The Dawes Plan in 1924 reduced reparation payments and brought American loans into the country. In 1925 Germany signed the Locarno treaties accepting its western borders, and in 1926 it joined the League of Nations. In the 1928 elections, the Nazi Party won less than three percent of the vote. If the treaty alone had been enough to cause another war, extremism should have been growing during these years, not shrinking.

What changed everything was the Great Depression. After 1929, American loans dried up, unemployment in Germany rose to around six million, and voters turned to parties that promised radical solutions. By July 1932 the Nazis were the largest party in the Reichstag, and in January 1933 Hitler became chancellor. Hitler used the treaty as a powerful symbol in his speeches, but it was economic collapse that gave him an audience.

Finally, Britain and France chose not to enforce the treaty when it mattered. When Germany remilitarized the Rhineland in 1936, a direct violation, neither country acted. The Anschluss with Austria in 1938 and the Munich Agreement that same year showed Hitler that the Allies would rather give in than fight. A treaty that is not enforced cannot prevent a war.

The Treaty of Versailles left Germany angry and gave Hitler a grievance to build on, but it did not lead directly to war. Without the Depression and the policy of appeasement, the resentment of 1919 might have faded, as it seemed to be doing in the late 1920s.`,
    why: "Tricky vs DBQ: history thesis with dates and outside facts, but no documents referenced anywhere and no prompt; heading block.",
  },
  {
    name: "Climate policy essay that quotes a poem once in passing",
    expect: "prose",
    text: `A Price on Carbon

More than a century ago, the poet Gerard Manley Hopkins looked at the industrial landscape of England and wrote that "all is seared with trade; bleared, smeared with toil." He was describing the soot of coal-fired factories, but his line fits our own problem surprisingly well. Fossil fuels still power most of the world economy, and the carbon dioxide they release is warming the planet. The most effective way to cut those emissions is not a patchwork of rules for every industry but a simple, steadily rising tax on carbon, with the money returned to citizens.

A carbon tax works by making pollution cost something. Right now, a company that burns coal or a driver who fills up a gas tank does not pay for the damage the resulting emissions cause through heat waves, floods and crop failures. A tax on each ton of carbon dioxide adds that cost to the price. Once clean energy is cheaper than dirty energy, businesses and households switch on their own, in thousands of ways that no government agency could plan.

This approach has been tried. Sweden introduced a carbon tax in 1991 and raised it over time, and its emissions have fallen substantially while its economy has continued to grow. British Columbia adopted a carbon tax in 2008 and for years returned the revenue through cuts to other taxes; fuel use per person dropped while the province's economy kept pace with the rest of Canada.

The strongest objection is that a carbon tax hurts low-income families, who spend a larger share of their budgets on fuel and heating. This is a real problem, and the fuel-tax protests in France in 2018 showed how quickly public anger can build. The answer is to give the money back. Under a "carbon dividend," every resident receives an equal payment from the tax revenue. Because wealthy households use far more energy, most low- and middle-income families would get back more than they pay.

A second objection is that companies will simply move to countries without a carbon tax. A border adjustment, which charges imports based on the carbon used to make them, would prevent this and would encourage other countries to adopt similar policies.

Regulations, subsidies and voluntary pledges all have a role, but none of them use the power of prices the way a carbon tax does. If we want a world less seared by trade, we should start by making pollution pay its true cost.`,
    why: "Tricky vs literary: opens with one Hopkins line, but the essay argues economic policy and never analyses the poem.",
  },
  {
    name: "Blog post starting 'Hi everyone!' with no sign-off",
    expect: "prose",
    text: `Hi everyone! Welcome back to the blog.

Today I want to talk about something I've struggled with for basically my whole life: procrastination. If you've ever opened a document to start an essay and then somehow ended up forty minutes deep in videos about how cargo ships work, this post is for you.

For a long time I thought I procrastinated because I was lazy. But this year I noticed that I don't put off things I don't care about. I put off things I care about a lot, because I'm scared they won't be good enough. Once I figured that out, a few tricks started to actually work.

Tip 1: Start for two minutes.
Instead of telling myself I have to write the whole essay, I tell myself I only have to write for two minutes. Usually once I start, I keep going. And if I don't, at least I have two minutes of work done instead of zero.

Tip 2: Put your phone in another room.
Not face-down on the desk. Not on silent. In another room. I resisted this one for months and it honestly made the biggest difference.

Tip 3: Work next to someone.
My friend and I started doing "study calls" where we just keep a video call open and work quietly. Knowing someone can see me makes me way less likely to wander off.

Tip 4: Make the first draft bad on purpose.
This sounds weird, but it helps. I tell myself the first draft is supposed to be terrible, so there's no pressure. Fixing a bad draft is so much easier than staring at a blank page.

None of this has made me a perfect student. I still left half of my history project until the night before last week (sorry, Mr. Alvarez). But I'm getting better, and I'm way less stressed than I was in September.

What about you? Do you have a trick that helps you actually get started? Tell me in the comments, I read every single one!`,
    why: "Tricky vs email: 'Hi everyone!' greeting, but addressed to a readership, 'Welcome back to the blog', 'Tell me in the comments', no name sign-off.",
  },
  {
    name: "Essay with Introduction/Body/Conclusion section headings",
    expect: "prose",
    text: `Year-Round School: A Better Calendar for Students

Introduction
The traditional school calendar, with a long summer break, was designed when many families needed children at home to help with farm work. Today very few students spend their summers in the fields, yet most schools still follow the same schedule. Schools should switch to a year-round calendar with shorter, more frequent breaks, because it would reduce learning loss, lower stress for students and teachers, and make better use of school buildings.

Body
The biggest problem with a long summer break is that students forget much of what they learned. Teachers often spend the first several weeks of each school year reviewing material from the year before. This "summer slide" is especially hard on students whose families cannot afford camps, tutoring, or travel. A year-round calendar usually keeps the same 180 school days but spreads them out, with breaks of two or three weeks throughout the year. With shorter breaks, students would have less time to forget and teachers could move on to new material sooner.

Year-round school can also make the school year less exhausting. Under the traditional calendar, students and teachers push through long stretches with only a few days off, and burnout often sets in by spring. Regular breaks every nine weeks or so give everyone a chance to rest and catch up before the next term. Students who are struggling could also use part of a break for extra help instead of waiting until summer school.

Finally, school buildings sit mostly empty for nearly three months every year. In crowded districts, a year-round schedule can even let schools rotate groups of students so that the building serves more people without new construction.

There are some downsides. Families with children in different schools might have trouble if the schedules do not match, and summer jobs and camps would have to adjust. However, these problems can be solved if a whole district switches together and plans ahead.

Conclusion
The long summer break is a leftover from a time when it made sense. A year-round calendar would help students remember more, give everyone regular time to recharge, and use school buildings more efficiently. It is time for schools to update their calendars to fit how students live today.`,
    why: "Tricky vs research: 'Introduction'/'Body'/'Conclusion' headings, but no citations, no Methods/Results, and a plain argumentative thesis.",
  },
];
