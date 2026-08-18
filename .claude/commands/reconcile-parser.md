---
description: Turn a competitor export sample into a reconciliation parser plus fixtures
argument-hint: <vendor> <path-to-sample-export>
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

Add reconciliation support for vendor **$1** using the sample at **$2**.

Delegate to the `reconciliation-builder` subagent.

1. Read the sample. Infer the schema — do not guess from the vendor's marketing docs.
2. Write `services/reconcile/parsers/$1.ts` normalising into `ReconcileRecord`.
3. Capture the sample (redacted of any customer identifiers) into
   `services/reconcile/parsers/__fixtures__/$1/`.
4. Write tests covering: happy path, missing `n`, undisclosed engine mix,
   percentage-vs-count ambiguity, locale-formatted numbers, and a truncated file.
5. Register the format in the ingest catalogue with the vendor name and the export
   version tested.
6. Extend the variance decomposition so this vendor's disclosed and undisclosed
   fields map correctly onto the six factors.

Explicitly list which of the six variance factors this vendor **does not disclose** —
that list is what the report shows as "unexplained", and understating it is a
correctness bug.
