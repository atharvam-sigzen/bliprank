import { afterEach, describe, expect, it } from 'vitest'
import {
  CUSTOM_PROMPTS_KEY_PREFIX,
  addCustomPrompt,
  readCustomPrompts,
  removeCustomPrompt,
} from './custom-prompts'

const ORIGINAL = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

function stubStorage(impl: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', { value: impl, configurable: true, writable: true })
}

/** A localStorage that throws on every access, as a private window does. */
const THROWING = {
  getItem() {
    throw new Error('The operation is insecure.')
  },
  setItem() {
    throw new Error('The operation is insecure.')
  },
}

/** Enough of the Storage surface for these helpers. */
function memoryStorage(seed: Record<string, string> = {}): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  }
}

afterEach(() => {
  if (ORIGINAL) Object.defineProperty(globalThis, 'localStorage', ORIGINAL)
  else delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('SSR and private-window safety', () => {
  it('reads as empty with no localStorage at all', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage
    expect(readCustomPrompts('a.com')).toEqual([])
  })

  it('reads as empty when every access throws', () => {
    stubStorage(THROWING)
    expect(readCustomPrompts('a.com')).toEqual([])
  })

  it('add still returns the would-be list when the write throws', () => {
    stubStorage(THROWING)
    expect(addCustomPrompt('a.com', 'best crm for smb', [])).toEqual({ list: ['best crm for smb'], added: true })
  })

  it('remove still returns the would-be list when the write throws', () => {
    stubStorage(THROWING)
    expect(removeCustomPrompt('a.com', 'anything', [])).toEqual([])
  })

  // THE REGRESSION. State is the source of truth when storage is unavailable:
  // the old signature re-read the throwing storage as [], so the second
  // distinct add was refused as a duplicate and a remove wiped every row.
  it('two sequential adds both succeed when storage throws', () => {
    stubStorage(THROWING)
    const first = addCustomPrompt('a.com', 'prompt one', [])
    expect(first).toEqual({ list: ['prompt one'], added: true })
    const second = addCustomPrompt('a.com', 'prompt two', first.list)
    expect(second).toEqual({ list: ['prompt one', 'prompt two'], added: true })
  })

  it('remove drops only its own row when storage throws', () => {
    stubStorage(THROWING)
    expect(removeCustomPrompt('a.com', 'prompt one', ['prompt one', 'prompt two'])).toEqual(['prompt two'])
  })
})

describe('validation', () => {
  it('trims the prompt before storing', () => {
    stubStorage(memoryStorage())
    expect(addCustomPrompt('a.com', '  best crm  ', [])).toEqual({ list: ['best crm'], added: true })
    expect(readCustomPrompts('a.com')).toEqual(['best crm'])
  })

  it('refuses empty and whitespace-only text', () => {
    stubStorage(memoryStorage())
    expect(addCustomPrompt('a.com', '', [])).toEqual({ list: [], added: false })
    expect(addCustomPrompt('a.com', '   ', [])).toEqual({ list: [], added: false })
    expect(readCustomPrompts('a.com')).toEqual([])
  })

  it('refuses duplicates case-insensitively, keeping the original', () => {
    stubStorage(memoryStorage())
    const { list } = addCustomPrompt('a.com', 'Best CRM', [])
    expect(addCustomPrompt('a.com', 'best crm', list)).toEqual({ list: ['Best CRM'], added: false })
    expect(addCustomPrompt('a.com', '  BEST CRM  ', list)).toEqual({ list: ['Best CRM'], added: false })
    expect(readCustomPrompts('a.com')).toEqual(['Best CRM'])
  })

  it('refuses a duplicate that lives only in storage, not in the caller state', () => {
    stubStorage(memoryStorage({ [`${CUSTOM_PROMPTS_KEY_PREFIX}a.com`]: JSON.stringify(['Best CRM']) }))
    expect(addCustomPrompt('a.com', 'best crm', [])).toEqual({ list: ['Best CRM'], added: false })
  })

  it('refuses text over 200 characters after trimming', () => {
    stubStorage(memoryStorage())
    expect(addCustomPrompt('a.com', 'x'.repeat(201), [])).toEqual({ list: [], added: false })
    const exactly200 = 'x'.repeat(200)
    expect(addCustomPrompt('a.com', ` ${exactly200} `, [])).toEqual({ list: [exactly200], added: true })
  })
})

describe('per-domain isolation', () => {
  it('keeps each domain in its own key', () => {
    const storage = memoryStorage()
    stubStorage(storage)
    addCustomPrompt('a.com', 'prompt for a', [])
    addCustomPrompt('b.com', 'prompt for b', [])
    expect(readCustomPrompts('a.com')).toEqual(['prompt for a'])
    expect(readCustomPrompts('b.com')).toEqual(['prompt for b'])
    expect(storage.getItem(`${CUSTOM_PROMPTS_KEY_PREFIX}a.com`)).toBe(JSON.stringify(['prompt for a']))
  })

  it('removal on one domain leaves the other untouched', () => {
    stubStorage(memoryStorage())
    addCustomPrompt('a.com', 'shared wording', [])
    addCustomPrompt('b.com', 'shared wording', [])
    removeCustomPrompt('a.com', 'shared wording', ['shared wording'])
    expect(readCustomPrompts('a.com')).toEqual([])
    expect(readCustomPrompts('b.com')).toEqual(['shared wording'])
  })
})

describe('remove', () => {
  it('removes case-insensitively, the same rule that refused the duplicate', () => {
    stubStorage(memoryStorage())
    const { list } = addCustomPrompt('a.com', 'Best CRM', [])
    expect(removeCustomPrompt('a.com', 'best crm', list)).toEqual([])
    expect(readCustomPrompts('a.com')).toEqual([])
  })

  it('keeps another tab\'s stored rows the caller has not seen', () => {
    stubStorage(memoryStorage({ [`${CUSTOM_PROMPTS_KEY_PREFIX}a.com`]: JSON.stringify(['from another tab', 'doomed']) }))
    expect(removeCustomPrompt('a.com', 'doomed', [])).toEqual(['from another tab'])
  })
})

describe('corrupt storage', () => {
  it('reads as empty on non-JSON and non-array payloads', () => {
    stubStorage(memoryStorage({ [`${CUSTOM_PROMPTS_KEY_PREFIX}a.com`]: 'not json' }))
    expect(readCustomPrompts('a.com')).toEqual([])
    stubStorage(memoryStorage({ [`${CUSTOM_PROMPTS_KEY_PREFIX}a.com`]: '{"a":1}' }))
    expect(readCustomPrompts('a.com')).toEqual([])
  })

  it('drops non-string and blank entries from a hand-edited array', () => {
    stubStorage(memoryStorage({ [`${CUSTOM_PROMPTS_KEY_PREFIX}a.com`]: JSON.stringify(['ok', 7, '', '  ']) }))
    expect(readCustomPrompts('a.com')).toEqual(['ok'])
  })
})
