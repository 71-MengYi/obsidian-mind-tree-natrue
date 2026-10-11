/**
 * The only URL shape a mind tree may persist or open: absolute http(s).
 *
 * The parsed URL is returned (not just a boolean) so callers that must store a
 * normalized form — clipboard payloads keep the trailing slash — share exactly
 * one parser with callers that only need the validation gate.
 */
export function parseSafeHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function isSafeHttpUrl(value: string): boolean {
  return parseSafeHttpUrl(value) !== undefined;
}
