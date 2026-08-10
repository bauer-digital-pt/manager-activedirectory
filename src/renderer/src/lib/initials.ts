// Derive up-to-2-letter initials from a display name or username.
// "Afonso Queiroz" → "AQ", "BMAP\afonso" → "AF", "" → "".
// Strips a DOMAIN\ prefix, drops accents, and ignores non-letters.
export function initials(name?: string): string {
  if (!name) return "";
  const cleaned = name
    .replace(/^.*\\/, "")            // DOMAIN\user → user
    .replace(/@.*$/, "")             // user@domain → user
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents
    .replace(/[^A-Za-z0-9]+/g, " ")  // separators → space
    .trim();
  if (!cleaned) return "";
  const words = cleaned.split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }
  return words[0].slice(0, 2).toUpperCase();
}
