// Slug derivation, validation, and collision suggestion for namecards.
//
// A slug is the URL segment of a public namecard: admin.singaporewomenassociation.org/c/{slug}.
// Rules (see docs/NAMECARD.md §4.1 and §17.1):
//   - lowercase
//   - kebab-case (words separated by single hyphens)
//   - ASCII letters, digits, hyphens only
//   - 1-64 chars; no leading/trailing/double hyphens
//   - derived from members.name on creation, editable thereafter

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX_LEN = 64;

/**
 * Derive a candidate slug from a member's display name.
 *
 * - Lowercases.
 * - Folds common Malay/Chinese/Indian accented characters toward ASCII.
 * - Drops any character that is not ASCII alphanumeric or whitespace.
 * - Collapses runs of whitespace into a single hyphen.
 * - Trims leading/trailing hyphens.
 * - Truncates at the last complete word within SLUG_MAX_LEN.
 * - Returns null if the name contains no usable characters (the admin must
 *   type a slug manually).
 *
 * Examples:
 *   "Sarah Chen"            -> "sarah-chen"
 *   "Lee Li Hua"            -> "lee-li-hua"
 *   "Mária Núñez"           -> "maria-nunez"
 *   "Aishwarya R."          -> "aishwarya-r"
 *   "李小龙"                  -> null  (no ASCII alphanumerics)
 *   "  -- !! --  "          -> null
 */
export function deriveSlug(name: string): string | null {
  if (!name) return null;
  const folded = foldAccents(name.toLowerCase());
  // Keep ASCII letters, digits, spaces, hyphens; drop everything else.
  const cleaned = folded.replace(/[^a-z0-9 -]/g, ' ').trim();
  if (!cleaned) return null;
  const kebab = cleaned
    .replace(/[-\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!kebab) return null;
  return truncateAtWord(kebab, SLUG_MAX_LEN);
}

/**
 * Validate a slug string. Returns true if it is well-formed (regex match and
 * within length). Does NOT check uniqueness — that is a DB concern.
 */
export function validateSlug(slug: string): boolean {
  if (!slug || slug.length > SLUG_MAX_LEN) return false;
  return SLUG_REGEX.test(slug);
}

/**
 * Suggest the next-free alternative slug when a desired slug is taken.
 *
 * Given a desired `slug` and a set of already-taken slugs, returns the first
 * available `slug`, `slug-2`, `slug-3`, ... If `slug` itself is free, returns
 * it unchanged. Suggestion count is capped to avoid pathological loops.
 *
 * Example: suggestAlternatives('sarah-chen', new Set(['sarah-chen', 'sarah-chen-2']))
 *          -> 'sarah-chen-3'
 */
export function suggestAlternatives(slug: string, taken: Set<string>): string {
  if (!taken.has(slug)) return slug;
  // If the desired slug already ends in -N, start from N+1; otherwise start at 2.
  const match = slug.match(/^(.*?)-(\d+)$/);
  const base = match ? match[1] : slug;
  const startN = match ? Number(match[2]) + 1 : 2;
  for (let n = startN; n < startN + 100; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Extremely unlikely (100 collisions); return something unique-ish.
  return `${base}-${Date.now()}`;
}

/**
 * Fold common accented Latin characters toward their ASCII equivalents.
 * Covers the characters most likely to appear in SWA's Singaporean membership
 * (Malay, Hokkien, Tamil, common European). Not full Unicode normalisation —
 * names with characters outside this map are dropped by deriveSlug, which is
 * the intended fallback for mononyms in non-Latin scripts.
 */
function foldAccents(s: string): string {
  const map: Record<string, string> = {
    à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a',
    ç: 'c',
    è: 'e', é: 'e', ê: 'e', ë: 'e',
    ì: 'i', í: 'i', î: 'i', ï: 'i',
    ñ: 'n',
    ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o',
    ù: 'u', ú: 'u', û: 'u', ü: 'u',
    ý: 'y', ÿ: 'y',
  };
  return s.replace(/[àáâãäåçèéêëìíîïñòóôõöùúûüýÿ]/g, (c) => map[c] ?? c);
}

/**
 * Truncate `slug` to `maxLen` chars on the last hyphen boundary within the
 * limit, so we never cut a word in half. If the first word itself exceeds
 * `maxLen`, hard-cut it.
 */
function truncateAtWord(slug: string, maxLen: number): string {
  if (slug.length <= maxLen) return slug;
  const cut = slug.slice(0, maxLen);
  const lastHyphen = cut.lastIndexOf('-');
  const truncated = lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut;
  return truncated.replace(/-+$/g, '');
}
