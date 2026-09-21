/**
 * Normalize `npm pack --json` output across npm majors.
 *
 * npm < 12 prints an array of records; npm >= 12 prints an object keyed by
 * package name. Both shapes carry the same record fields (`name`, `version`,
 * `filename`, `integrity`, `files`). Callers get an array or a loud error.
 */
export function normalizePackResult(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    const records = Object.values(value).filter((entry) => entry && typeof entry === "object");
    if (records.length > 0) {
      return records;
    }
  }
  throw new Error(
    "unexpected npm pack --json structure: expected an array of records or a name-keyed object",
  );
}
