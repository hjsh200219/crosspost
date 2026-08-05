/**
 * One rule for every stats table: **a total is the sum of what was measured.**
 *
 * `null` means "could not read it", `0` means "read it, and it was zero". Adding them together
 * erases the difference at exactly the moment it matters — a run where every request failed
 * prints `0` and reads as "nobody saw any of it". So unmeasured cells stay out of the sum, and
 * a column that lost any cell says how many rows its number covers.
 */

/** Sum of the measured cells in `key`, with a coverage suffix when any cell is missing. */
export function measuredTotal(rows, key) {
  const measured = rows.filter((r) => r[key] != null);
  const sum = measured.reduce((a, r) => a + Number(r[key]), 0);
  return measured.length === rows.length ? `${sum}` : `${sum} (${measured.length}/${rows.length} measured)`;
}
