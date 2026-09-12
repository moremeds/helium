/** JSON identities shared by configuration producers and consumers. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1 ||
        Object.keys(value).length !== value.length)
      throw new Error("JSON arrays must be dense and have no extra properties");
    return `[${Array.from({ length: value.length }, (_, i) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !("value" in descriptor)) throw new Error("JSON cannot contain accessors");
      return canonicalJson(descriptor.value);
    }).join(",")}]`;
  }
  if (typeof value !== "object" || value === null ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error("Expected finite plain JSON data");
  const record = value as Record<string, unknown>;
  if (Reflect.ownKeys(record).length !== Object.keys(record).length)
    throw new Error("JSON cannot contain hidden or symbol properties");
  return `{${Object.keys(record).sort().map((key) => {
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw new Error(`Forbidden JSON key: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(record, key)!;
    if (!("value" in descriptor)) throw new Error("JSON cannot contain accessors");
    return `${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`;
  }).join(",")}}`;
}

/** Validate syntax first, then check decoded object keys before trusting parse output. */
export function parseStrictJson(raw: string): unknown {
  const value: unknown = JSON.parse(raw);
  const objects: Array<Set<string> | null> = [];
  for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/gu)) {
    const token = match[0];
    if (token === "{") objects.push(new Set());
    else if (token === "[") objects.push(null);
    else if (token === "}" || token === "]") objects.pop();
    else if (/^\s*:/u.test(raw.slice(match.index + token.length))) {
      const key = JSON.parse(token) as string;
      const keys = objects.at(-1)!;
      if (keys!.has(key)) throw new Error(`Duplicate JSON key: ${key}`);
      keys!.add(key);
    }
  }
  canonicalJson(value);
  return value;
}
