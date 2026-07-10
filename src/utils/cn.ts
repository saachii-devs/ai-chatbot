// Joins class names, dropping falsy ones. Deliberately not tailwind-merge:
// primitives expose props for overrides, so no two competing utilities collide.
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
