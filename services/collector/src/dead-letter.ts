/**
 * Dead-letter store for jobs that exhausted their retry policy — PHASES.md 1.1/1.6.
 * Interface + two implementations: JSONL on disk (the pilot's failures.jsonl,
 * same format) and in-memory (tests). The QStash-backed runner (P1.1) gets a
 * third implementation behind the same interface.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'

export interface DeadLetterEntry {
  readonly engine: string
  readonly cellKey: string
  readonly prompt: string
  readonly run: number
  /** AdapterErrorKind of the final failure. */
  readonly kind: string
  readonly message: string
  /** Attempts consumed, first try included. */
  readonly attempts: number
  /** ISO 8601. */
  readonly at: string
}

export interface DeadLetter {
  record(entry: DeadLetterEntry): void
  list(engine?: string): DeadLetterEntry[]
  count(engine?: string, kind?: string): number
}

export class MemoryDeadLetter implements DeadLetter {
  private readonly entries: DeadLetterEntry[] = []
  record(entry: DeadLetterEntry): void {
    this.entries.push(entry)
  }
  list(engine?: string): DeadLetterEntry[] {
    return this.entries.filter((e) => !engine || e.engine === engine)
  }
  count(engine?: string, kind?: string): number {
    return this.entries.filter((e) => (!engine || e.engine === engine) && (!kind || e.kind === kind)).length
  }
}

/** One JSON object per line; append-only; unreadable lines are skipped, never lost. */
export class JsonlDeadLetter implements DeadLetter {
  constructor(private readonly file: string) {}
  record(entry: DeadLetterEntry): void {
    appendFileSync(this.file, JSON.stringify(entry) + '\n')
  }
  list(engine?: string): DeadLetterEntry[] {
    if (!existsSync(this.file)) return []
    const out: DeadLetterEntry[] = []
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as DeadLetterEntry
        if (!engine || e.engine === engine) out.push(e)
      } catch {
        /* torn line from a crash — the entry it replaced is re-attemptable anyway */
      }
    }
    return out
  }
  count(engine?: string, kind?: string): number {
    return this.list(engine).filter((e) => !kind || e.kind === kind).length
  }
}
