/**
 * The owner's spot-check sheet: written for a person, read back for the
 * harness. MVP_PLAN E4.
 *
 * An agent's label is a second instrument, not a referee (see golden.ts). What
 * lets it referee is a PERSON reading a random sample of the labels and saying
 * whether they are right. This module is the two ends of that loop that touch
 * Markdown, both pure:
 *
 *   renderSpotCheckSheet   one file a non-developer edits in any editor
 *   parseSpotCheckSheet    that file, read back exactly as the person left it
 *
 * ⚠️ NOTHING HERE DECIDES ANYTHING. Which cases are sampled, whether a sheet is
 * the seeded sample, whether a label changed after it was checked, how many
 * ticks there are and whether that is enough are all the harness's
 * (`runGoldenSet` in golden.ts). The first build judged the sheet here and
 * handed the harness a conclusion, which meant the gate could be given a
 * conclusion nobody had reached (E4 review, B1).
 *
 * The person runs nothing. They tick boxes in the file and save it; the test
 * suite and the report read the file as it stands.
 */

import { GOLDEN_SET_TARGET, SPOT_CHECK_SEED, labelFingerprint, spotCheckMinAgree, spotCheckPopulation, spotCheckSample, type GoldenCase, type SpotCheckSheet } from './golden.js'

// ── the sheet ────────────────────────────────────────────────────────────────

const ENGINE_NAMES: Readonly<Record<string, string>> = {
  chatgpt: 'ChatGPT',
  copilot: 'Microsoft Copilot',
  gemini: 'Google Gemini',
  'google-ai-mode': 'Google AI Mode',
  'google-ai-overviews': 'Google AI Overviews',
}

const CLASS_WORDS: Readonly<Record<string, string>> = {
  owned: "the brand's own website",
  competitor: "a competitor's website",
  video: 'a video platform',
  community: 'a community or forum thread',
  review: 'a review site',
  earned_media: 'a news or editorial publisher on our approved list',
  reference: 'a reference source (encyclopaedia, standards body or government)',
  other: 'something else, or a site we do not recognise',
}

/** One line of the answer around a span, with the span marked, safe inside a Markdown code span. */
function excerpt(text: string, offset: number, length: number, around = 70): string {
  const flat = (s: string) => s.replace(/\s+/g, ' ').replace(/`/g, "'")
  const before = flat(text.slice(Math.max(0, offset - around), offset))
  const after = flat(text.slice(offset + length, offset + length + around))
  return `\`${offset - around > 0 ? '…' : ''}${before}>>>${flat(text.slice(offset, offset + length))}<<<${after}${offset + length + around < text.length ? '…' : ''}\``
}

const shortUrl = (url: string): string => {
  const bare = url.replace(/^https?:\/\//, '').replace(/`/g, '')
  return bare.length > 90 ? `${bare.slice(0, 87)}…` : bare
}

function entryBlock(c: GoldenCase, n: number, of: number): string {
  const ev = c.evidence
  const subject = (ev?.mentions ?? []).filter((m) => m.brand === c.brand.id).sort((a, b) => a.offset - b.offset)
  const lines: string[] = []
  lines.push(`## ${n} of ${of}`, '')
  lines.push(`<!-- case: ${c.id} fingerprint: ${labelFingerprint(c)} -->`, '')
  lines.push(`**Question asked:** ${c.source.prompt ?? '(not recorded)'}`)
  lines.push(`**Answered by:** ${ENGINE_NAMES[c.source.engine] ?? c.source.engine}`)
  lines.push(`**Brand being measured:** ${c.brand.name} (website: ${c.brand.domains.join(', ') || 'none recorded'})`)
  const rivals = (c.competitors ?? []).filter((b) => b.id !== c.brand.id).map((b) => b.name)
  lines.push(`**Competitors we look for:** ${rivals.length ? rivals.join(', ') : 'none for this brand, so only the brand itself is counted'}`, '')

  lines.push('### What the label says', '')
  if (c.answer.text.trim() === '') lines.push('- **The engine returned no answer text at all.** So nothing can be mentioned.')
  if (c.label.mentioned) {
    lines.push(`- **Mentioned:** yes, ${c.label.mentionCount} time${c.label.mentionCount === 1 ? '' : 's'}. Each place it is named (the name sits between \`>>>\` and \`<<<\`):`)
    subject.forEach((m, i) => lines.push(`    ${i + 1}. ${excerpt(c.answer.text, m.offset, m.span.length)}`))
  } else {
    lines.push(`- **Mentioned:** no. The label says ${c.brand.name} is not named anywhere in the wording of this answer.`)
  }
  if (c.label.brandsDetected > 0) {
    lines.push(`- **Brands found, in the order they first appear:** ${(ev?.order ?? []).map((name, i) => `${i + 1}. ${name}`).join(', ')}.` + (c.label.position !== null ? ` So ${c.brand.name} is in **position ${c.label.position} of ${c.label.brandsDetected}**.` : ` ${c.brand.name} is not among them, so it has no position.`))
    const nameOf = new Map((c.competitors ?? []).map((b) => [b.id, b.name]))
    const firsts = new Map<string, { span: string; offset: number }>()
    for (const m of ev?.mentions ?? []) {
      if (m.brand === c.brand.id) continue
      const had = firsts.get(m.brand)
      if (!had || m.offset < had.offset) firsts.set(m.brand, m)
    }
    for (const [id, m] of [...firsts].sort((a, b) => a[1].offset - b[1].offset)) lines.push(`    - ${nameOf.get(id) ?? id} first appears: ${excerpt(c.answer.text, m.offset, m.span.length, 50)}`)
  } else {
    lines.push('- **Brands found:** none of the brand or its listed competitors.')
  }
  lines.push(`- **The brand's own website is cited as a source:** ${c.label.cited ? 'yes' : 'no'}`)
  if (c.answer.citations.length === 0) lines.push('- **Sources cited:** none.')
  else {
    lines.push(`- **Sources cited (${c.answer.citations.length}), and what kind of site the label says each one is:**`)
    for (const k of c.answer.citations) {
      const cls = c.label.citationClasses[String(k.position)] ?? 'other'
      lines.push(`    ${k.position + 1}. \`${shortUrl(k.url)}\` is ${CLASS_WORDS[cls] ?? cls}. Why: ${(ev?.citations[String(k.position)] ?? '').replace(/\s+/g, ' ')}`)
    }
  }
  if (ev?.notes) lines.push(`- **Labeller's notes:** ${ev.notes.replace(/\s+/g, ' ')}`)
  lines.push('')
  lines.push('### Your check (put an x in ONE box)', '')
  lines.push('- [ ] AGREE: everything above is right')
  lines.push('- [ ] DISAGREE: something above is wrong', '')
  lines.push('Note: ', '')
  if (c.answer.text.trim() !== '') {
    lines.push('<details><summary>The full answer, exactly as the engine wrote it (open this if the excerpts are not enough)</summary>', '')
    for (const l of c.answer.text.split('\n')) lines.push(`> ${l}`)
    lines.push('', '</details>', '')
  }
  lines.push('---', '')
  return lines.join('\n')
}

/** The sheet for the current set. Deterministic: the same cases always render the same file. */
export function renderSpotCheckSheet(cases: readonly GoldenCase[], seed: string = SPOT_CHECK_SEED): string {
  const sample = spotCheckSample(cases, seed)
  const population = spotCheckPopulation(cases)
  const proposed = population.count
  const need = spotCheckMinAgree(sample.length)
  // Say only what the harness will do. Below the target size it gives no verdict however the check goes.
  const consequence =
    cases.length >= GOLDEN_SET_TARGET
      ? 'The accuracy gate (G2) can then give its verdict.'
      : `That does not produce a verdict yet: the accuracy gate (G2) needs ${GOLDEN_SET_TARGET} answers and the set holds ${cases.length}, so your check settles whether these labels can be trusted, and the verdict follows when the set is complete.`
  const head = [
    '# Golden set spot-check',
    '',
    `**${sample.length} answers for a person to check by hand.** You do not need to run anything. Open this file in any text editor, fill it in, save it, and hand it back (commit it, or send the file to whoever asked you).`,
    '',
    '## Why you are being asked',
    '',
    'BlipRank has a scorer. For every AI answer it decides whether a brand was mentioned, how many times, where it stands among its competitors, and what kind of website each cited source is. Every number a customer sees is built from those decisions, so we have to know the scorer gets them right.',
    '',
    `To find out, ${proposed} real stored answers were read one at a time and labelled with what is actually in them. The labels were proposed by an AI agent READING each answer. They were not produced by the scorer, and the scorer was never shown to the agent. Before those labels are allowed to judge the scorer, a person has to check a sample of them. That is this sheet: ${sample.length} of the ${proposed}, drawn at random with a recorded seed, so nobody chose which ones you see.`,
    '',
    `If you agree with at least ${need} of the ${sample.length}, the labels are accepted. ${consequence} If you disagree more often than that, the labels are not trusted and get redone. Either result is useful. Please do not agree to be kind.`,
    '',
    '## What to do',
    '',
    '1. Write your name and the date on the two lines under "Sign here".',
    '2. For each answer below, read "What the label says" and compare it with the excerpts. The full answer is folded underneath each one if you need it.',
    '3. Put an `x` between the square brackets of exactly ONE box, like this: `- [x] AGREE`.',
    '4. If you disagree, write what is wrong after `Note:`. A few words is enough.',
    '',
    'It takes about an hour. You can stop and come back: a half-finished sheet simply counts as not finished yet.',
    '',
    '## How to judge',
    '',
    '- A brand is **mentioned** when its name is written in the wording of the answer. A name that only appears inside a web link (something starting with `https://` or `www.`) does not count.',
    '- A short or differently spaced form counts when a reader would know it names the brand: "Cosmic Byte" for thecosmicbyte, "Zoho" for Zoho CRM in a list of CRMs. A different product from the same company does not ("Zoho Books" is not Zoho CRM).',
    '- Part of a longer word does not count: "HubSpotters" is not HubSpot. An ordinary word does not count: "close the deal" is not the CRM called Close.',
    '- **Count every time it is named.** "Zoho CRM Plus" is one mention, not two.',
    '- **Position** is the brand\'s place in the order the brands FIRST appear. Only the brand being measured and the competitors listed for it are counted. Every other brand is ignored, however famous.',
    "- For **sources**: \"the brand's own website\" means exactly that and nothing else. A site is a news or editorial publisher only if it is on our approved list, so a well-known outlet that is not on the list is correctly \"something else\".",
    '- **AGREE only if everything listed for that answer is right.** If one thing is wrong, tick DISAGREE and say which.',
    '',
    '## Four rules that were judgement calls',
    '',
    'The written labelling rules did not settle these, so every label applies one reading of each, the same way throughout. Please judge each answer BY these rules. If you would rather have a different rule, say so in any Note. That is a welcome answer: the labels get redone under your rule, which is better than a sheet ticked against a rule you do not hold.',
    '',
    '1. A bare web address written into a sentence without `https://` (for example "monday.com") counts as naming the brand.',
    '2. A short form counts only when it plainly names that product in that sentence: "Zoho" or "Dynamics" in a list of CRMs does. A company name or a sister product does not: "Bigin by Zoho" is not Zoho CRM, and "SAP" alone is not SAP Business One.',
    '3. Follow-up suggestions the engine wrote at the end of an answer (they look like `<Elicitation label="...">`) count as part of the answer.',
    '4. A source whose link is a hidden Google redirect (it looks like `/goto?url=...`) is "something else", even when the card beside it says YouTube or Reddit, because in these stored answers the card and the link do not always belong together.',
    '',
    '## Sign here',
    '',
    '**Checked by:** ',
    '**Date:** ',
    '',
    'Please leave the lines that look like `<!-- ... -->` alone. They tell the software which answer is which, and that the label you checked is the label still on file.',
    '',
    `<!-- spot-check seed: ${seed} -->`,
    `<!-- spot-check population: ${population.fingerprint} (${population.count} agent-proposed labels) -->`,
    '',
    '---',
    '',
  ]
  return head.join('\n') + sample.map((c, i) => entryBlock(c, i + 1, sample.length)).join('\n')
}

const signed = (md: string, label: string): string => {
  // Spaces and tabs only, never `\s`: a blank "Checked by:" line must not read the next line as the name.
  const m = new RegExp(`^[ \\t]*\\**[ \\t]*${label}[ \\t]*:?[ \\t]*\\**[ \\t]*:?(.*)$`, 'mi').exec(md)
  return (m?.[1] ?? '').replace(/[*_`]/g, '').trim()
}

/**
 * Read the sheet back. Forgiving about how a person types (`[x]`, `[X]`,
 * `[ x ]`, a tick character, bold left on or off) and strict about what it
 * means: a box is ticked or it is not, and two ticked boxes is `both`, which
 * the judge refuses. Only a list line is a box, so a quoted answer that
 * happens to contain "[x] AGREE" cannot vote.
 */
export function parseSpotCheckSheet(md: string): SpotCheckSheet {
  const text = md.replace(/\r\n/g, '\n')
  const marker = /<!--\s*case:\s*(\S+)\s+fingerprint:\s*([0-9a-f]+)\s*-->/g
  const marks = [...text.matchAll(marker)]
  const headEnd = marks[0]?.index ?? text.length
  const head = text.slice(0, headEnd)
  const entries = marks.map((m, i) => {
    const block = text.slice(m.index! + m[0].length, marks[i + 1]?.index ?? text.length)
    const ticked = (word: string): boolean => {
      const box = new RegExp(`^[ \\t]*[-*+][ \\t]*\\[([^\\]\\n]*)\\][ \\t]*\\**${word}\\b`, 'm').exec(block)
      return !!box && box[1]!.trim() !== ''
    }
    const agree = ticked('AGREE')
    const disagree = ticked('DISAGREE')
    const noteMatch = /^[ \t]*\**Note\**[ \t]*:\**(.*(?:\n(?![ \t]*(?:<details>|---|##|- \[)).*)*)/m.exec(block)
    const note = (noteMatch?.[1] ?? '').replace(/\s+/g, ' ').trim()
    return { id: m[1]!, fingerprint: m[2]!, verdict: agree && disagree ? ('both' as const) : agree ? ('agree' as const) : disagree ? ('disagree' as const) : ('unanswered' as const), note }
  })
  return { checkedBy: signed(head, 'Checked by'), checkedOn: signed(head, 'Date'), seed: /<!--\s*spot-check seed:\s*(\S+)\s*-->/.exec(head)?.[1] ?? null, population: /<!--\s*spot-check population:\s*([0-9a-f]+)\b/.exec(head)?.[1] ?? null, entries }
}
