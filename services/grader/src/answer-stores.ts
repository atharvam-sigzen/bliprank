import { join } from 'node:path'
import { R2BlobStore, UpstashKV, type BlobStore, type KV } from '@bliprank/collector'
import { FileBlobStore, FileKV } from './local-store.js'

/**
 * WHERE THE RAW ANSWERS LIVE — R2 and Upstash when configured, this machine's
 * disk otherwise. MVP_PLAN B3, rule R4.
 *
 * The runner, the evidence reader and the re-scorer all open the same pair:
 * a blob store holding one object per cell (ADR-0003) and the index that
 * says which object each cell's answer is in, qualified by the adapter that
 * fetched it. They were three copies of `new FileBlobStore(...)` and `new
 * FileKV(...)`; this is the one place that decides, so a deployment cannot
 * end up writing blobs to one backend and the index to another.
 *
 * ALL SIX OR NONE. The index and the blobs are one store in two parts: an
 * index in Redis pointing at objects on a disk nobody else can read is a
 * store that serves nothing. So a partial configuration is refused loudly
 * rather than silently falling back to files, which on a serverless host is
 * a filesystem that vanishes with the instance.
 *
 * No I/O here: both constructors are inert until a method is called, and
 * `fetchImpl` is injected so the choice is testable offline.
 */
export const ANSWER_STORE_ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const

export interface AnswerStores {
  readonly blob: BlobStore
  readonly kv: KV
  readonly backend: 'r2+upstash' | 'file'
}

export function answerStores(dataDir: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): AnswerStores {
  const missing = ANSWER_STORE_ENV.filter((k) => !env[k])
  if (missing.length === 0) {
    return {
      blob: new R2BlobStore({
        accountId: env['R2_ACCOUNT_ID']!,
        accessKeyId: env['R2_ACCESS_KEY_ID']!,
        secretAccessKey: env['R2_SECRET_ACCESS_KEY']!,
        bucket: env['R2_BUCKET']!,
        fetch: fetchImpl,
      }),
      kv: new UpstashKV(env['UPSTASH_REDIS_REST_URL']!, env['UPSTASH_REDIS_REST_TOKEN']!, fetchImpl),
      backend: 'r2+upstash',
    }
  }
  if (missing.length < ANSWER_STORE_ENV.length) {
    throw new Error(`answer store: partly configured — set all of ${ANSWER_STORE_ENV.join(', ')} or none (missing ${missing.join(', ')})`)
  }
  return { blob: new FileBlobStore(join(dataDir, 'answers')), kv: new FileKV(join(dataDir, 'index.json')), backend: 'file' }
}
