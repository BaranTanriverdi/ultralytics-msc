export function isWithinAllowedPrefixes(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

export function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
