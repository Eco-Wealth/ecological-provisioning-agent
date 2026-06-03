export function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "item";
}

export function makeId(prefix: string, seed: string): string {
  return `${prefix}_${slug(seed)}_${Math.abs(hash(seed)).toString(36).slice(0, 6)}`;
}

function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = Math.imul(31, h) + input.charCodeAt(i) | 0;
  }
  return h;
}

export function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean).map((item) => item.trim()).filter(Boolean))];
}

export function includesAny(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}
