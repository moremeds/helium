/**
 * The last JSON object in a step's text, fenced or bare.
 *
 * Its own module so that `quality/` can parse a step without importing the
 * renderer: `render/index.ts` imports `quality/index.ts`, and a module that
 * imported back would be a cycle. Nothing here knows what a brief IS.
 * @module dsh-plugin-tenant-option-wizard/render/json
 */
export function extractJson(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    candidates.push((match[1] ?? "").trim());
  }
  // Last resort: the widest brace span. A reviewer that forgets the fence still
  // gets read rather than costing the reader the whole brief.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first)
    candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates.reverse()) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}
