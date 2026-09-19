/**
 * Next calls `register` once when the server process starts. It starts the
 * in-app daily scheduler (MVP_PLAN P1; `lib/scheduler.ts`), and nothing else.
 *
 * Node runtime only: the scheduler reads the machine's files, and the edge
 * runtime has none. The import is dynamic so the edge bundle never sees it.
 *
 * Starting the timer spends nothing and decides nothing. It fires only when
 * the clock crosses the tick time while this process is alive, never on
 * start; and whether a run may then spend is `localArming`'s and `runTick`'s
 * decision, refused with a fixed sentence unless the owner has set the daily
 * cap and the live flag and is tracking a domain. On a deployment (identity
 * on, a fleet) every poll ends at "not this machine" and nothing runs.
 *
 * ⚠️ THE SHAPE OF THE CONDITION IS LOAD-BEARING. Next builds this file for the
 * edge runtime too, and drops the import from that bundle only when it sits
 * INSIDE `if (process.env.NEXT_RUNTIME === 'nodejs')`, written exactly so. An
 * early `return` on the negated test reads the same to a person and not to
 * the bundler: the first draft did that, the edge bundle then reached
 * `node:crypto`, and `next build` failed while typecheck and the suite stayed
 * green. The build leg of the gate is what caught it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startLocalScheduler } = await import('./lib/scheduler')
    startLocalScheduler()
  }
}
