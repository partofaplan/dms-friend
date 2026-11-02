/*
 * Length-capping for user-entered text that is fed into the assistant's
 * prompt. Shared by the chat context and the combat-state summary so both
 * clip and mark truncation the same way.
 */

export const TRUNCATION_MARK = "…";

/** Collapses whitespace (so data can't break the prompt layout) and caps length. */
export function clip(value: string, maxLength: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1).trimEnd()}${TRUNCATION_MARK}` : flat;
}

/** Marker line ending a block that had whole lines dropped to fit. */
export const TRUNCATED_LINE = `- ${TRUNCATION_MARK}(truncated)`;

/**
 * Keeps whole lines of `text` within `maxLength`, ending with `marker` on its
 * own line when any were dropped. Returns "" when not even the first line and
 * the marker fit. Never exceeds `maxLength`.
 */
export function fitLines(text: string, maxLength: number, marker = TRUNCATED_LINE): string {
  if (text.length <= maxLength) return text;
  const budget = maxLength - marker.length - 1;
  const kept: string[] = [];
  let length = 0;
  for (const line of text.split("\n")) {
    const added = kept.length === 0 ? line.length : line.length + 1;
    if (length + added > budget) break;
    kept.push(line);
    length += added;
  }
  return kept.length === 0 ? "" : `${kept.join("\n")}\n${marker}`;
}
