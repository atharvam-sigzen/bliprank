import { describe, expect, it } from 'vitest'
import { byIntent, type PromptBreakdown } from './prompt-breakdown'
const line = (prompt: string, intent: string | undefined, answers: number, mentionedIn: number) =>
  ({ prompt, ...(intent ? { intent } : {}), cells: [], answers, mentionedIn }) as unknown as PromptBreakdown['prompts'][number]
const b = (prompts: PromptBreakdown['prompts']) => ({ prompts, engines: [], answers: 0, mentionedIn: 0, competitors: [] }) as unknown as PromptBreakdown
describe('byIntent', () => {
  it('groups, counts questions and answers, and orders by name', () => {
    const r = byIntent(b([line('a', 'problem-led', 5, 1), line('b', 'discovery', 5, 4), line('c', 'discovery', 5, 0)]))
    expect(r.groups.map((g) => g.intent)).toEqual(['discovery', 'problem-led'])
    expect(r.groups[0]).toEqual({ intent: 'discovery', questions: 2, questionsNamedIn: 1, answers: 10, mentionedIn: 4 })
    expect(r.unclassified).toBeNull()
  })
  it('returns unclassified SEPARATELY and never as a group', () => {
    const r = byIntent(b([line('a', 'discovery', 5, 2), line('b', undefined, 5, 1)]))
    expect(r.groups.map((g) => g.intent)).toEqual(['discovery'])
    expect(r.unclassified).toEqual({ intent: '', questions: 1, questionsNamedIn: 1, answers: 5, mentionedIn: 1 })
  })
  it('with nothing classified there are no groups at all', () => {
    const r = byIntent(b([line('a', undefined, 5, 2)]))
    expect(r.groups).toEqual([])
    expect(r.unclassified?.questions).toBe(1)
  })
  it('a question with zero mentions counts toward questions, not questionsNamedIn', () => {
    const r = byIntent(b([line('a', 'discovery', 5, 0)]))
    expect(r.groups[0]).toMatchObject({ questions: 1, questionsNamedIn: 0, mentionedIn: 0 })
  })
})
