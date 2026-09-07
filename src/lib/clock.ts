// Shared time formatting - `toLocaleTimeString([], { hour: "2-digit",
// minute: "2-digit" })` was hand-repeated across 11 sites / 8 files.
// Isomorphic + dependency-free.

/** "14:32" (locale-aware) from an ISO string, Date or epoch ms. */
export function formatClock(at: string | number | Date | null | undefined): string {
  if (at == null) return "";
  const d = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * "12 Aug" from a plain `YYYY-MM-DD` rental date.
 *
 * PARSED AS LOCAL, NOT UTC, and that is the whole reason this exists rather
 * than `new Date(s)`. `new Date("2026-08-12")` is specified to parse a
 * date-only string as UTC MIDNIGHT, so every traveller west of Greenwich sees
 * the day before the one they picked - a rental starting "11 Aug" on a form
 * where they chose the 12th. Splitting the parts and using the local-time
 * constructor keeps the label the same day the picker showed.
 *
 * Returns "" for anything unparseable, so a caller can `&&` it away rather than
 * render "Invalid Date".
 */
export function formatRentalDate(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((ymd ?? "").trim());
  if (!m) return "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * The rental window as one phrase: "12 Aug - 15 Aug", or just the start when
 * the end is unknown or identical.
 *
 * One function so the summary header, the wizard recap and any future surface
 * cannot disagree about how a window is written - the class of drift that gave
 * this app four different shop counters.
 */
export function formatDateRange(
  start: string | null | undefined,
  end?: string | null
): string {
  const a = formatRentalDate(start);
  if (!a) return "";
  const b = formatRentalDate(end);
  return b && b !== a ? `${a} - ${b}` : a;
}

/**
 * "20 Sep · 10:00" from a SHOP-LOCAL wall clock (audit F108).
 *
 * `bookings.scheduled_at` is the shop's own wall clock - the booking sheet
 * posts "2026-09-20T10:00:00" with no offset by design, and `scheduled_tz` says
 * "shop-local" - but the column is `timestamptz`, so PostgREST hands it back
 * wearing a "+00:00" tail it never earned. Feeding that to `new Date(...)` and
 * a locale format re-reads the tail in the DEVICE's zone, which moved a Bangkok
 * traveller's 10:00 pickup to 17:00 on the profile card while the Trips card
 * printed the same row raw. Two screens disagreeing about one booking, and one
 * of them sending the traveller to the shop seven hours late.
 *
 * So: read the digits, drop any offset tail, and never construct a Date for the
 * time - the same reason formatRentalDate splits the date parts by hand. "" for
 * anything that is not a full date AND time, so a caller can `&&` it away.
 */
export function formatShopWallClock(at: string | null | undefined): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec((at ?? "").trim());
  if (!m) return "";
  const day = formatRentalDate(m[1]);
  if (!day) return "";
  return `${day} · ${m[2]}:${m[3]}`;
}
