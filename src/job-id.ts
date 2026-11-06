/*
 * A job id becomes a filename, so it has to be constrained like one.
 *
 * `spoolPath` joins the id straight onto the spool directory, and `join` resolves `..` — so an
 * id of `../../../../tmp/x` wrote a caller-influenced JSON file outside the state directory and
 * then deleted that path when the job settled. Printer ids have been validated this way from the
 * start (`ID_PATTERN` in registry.ts); job ids arrived from `POST /jobs` and from the relay with
 * no check at all. Even an innocent `a/b` broke spooling with ENOENT.
 *
 * Deliberately wider than the registry's pattern: these ids are not ours. They are UUIDs from
 * this process, and opaque server-side identifiers from the relay, so uppercase and `.` are
 * allowed. What is not allowed is any kind of separator, and any leading dot — which is what
 * stops `..` matching at all.
 *
 * Lives in its own module so the queue and the result outbox can both use it without importing
 * each other.
 */
export const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeJobId(value: string): boolean {
  return SAFE_JOB_ID.test(value);
}
