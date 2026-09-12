/** ISO 8601 timestamp with the local offset (DESIGN.md 5.1). */
export function localIsoTimestamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * UUID v4 for comment / reply / batch ids.
 *
 * `crypto.randomUUID` is available in every secure context, and the app only
 * ever runs on https or on localhost (the local host layer binds to loopback),
 * so there is no fallback: a Math.random id would silently weaken the ids that
 * DESIGN.md 7.3 relies on for duplicate detection.
 */
export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (!c || typeof c.randomUUID !== "function") {
    throw new Error(
      "この環境では ID を生成できません（crypto.randomUUID がありません）。https か localhost で開いてください。",
    );
  }
  return c.randomUUID();
}
