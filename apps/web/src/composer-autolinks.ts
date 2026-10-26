export interface ComposerAutolinkRange {
  readonly from: number;
  readonly to: number;
}

// GFM autolink literals, which is how the sent message renders: an http(s) URL
// not glued to a preceding letter, or `www.` after a space, start of line, or
// one of `(*_~[]`. Inline chips and math reach the parser as U+FFFC or
// private-use sentinels, so a URL stops at them.
const AUTOLINK_PATTERN = new RegExp(
  String.raw`(?:(?<![A-Za-z])https?:\/\/|(?<=^|[\s(*_~[\]])www\.)[^\s<\uFFFC\uE000-\uF8FF]+`,
  "giu",
);
const TRAILING_PUNCTUATION = new Set(["!", '"', "'", "*", ",", ".", ":", ";", "?", "]", "_", "~"]);

function trimmedLinkLength(url: string): number {
  let unbalancedCloses = 0;
  for (const character of url) {
    if (character === "(") unbalancedCloses -= 1;
    else if (character === ")") unbalancedCloses += 1;
  }
  let end = url.length;
  while (end > 0) {
    const character = url[end - 1]!;
    if (character === ";") {
      // GFM drops an entity-like `&name;` suffix whole, not just its `;`.
      let nameStart = end - 1;
      while (nameStart > 0 && /[A-Za-z]/.test(url[nameStart - 1]!)) nameStart -= 1;
      if (nameStart < end - 1 && url[nameStart - 1] === "&") {
        end = nameStart - 1;
        continue;
      }
    }
    if (character === ")" && unbalancedCloses > 0) unbalancedCloses -= 1;
    else if (!TRAILING_PUNCTUATION.has(character)) break;
    end -= 1;
  }
  return end;
}

/**
 * Source ranges of URLs in one line of composer markdown, in order. Markdown
 * markers inside them are part of the address, as they are in the rendered
 * message, so `https://example.com/_name_/` must not turn `name` italic.
 */
export function findComposerAutolinks(text: string): ComposerAutolinkRange[] {
  const ranges: ComposerAutolinkRange[] = [];
  const pattern = new RegExp(AUTOLINK_PATTERN);
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const from = match.index;
    // `<https://…>` ends at its bracket and keeps any trailing punctuation.
    const bracketEnd = text[from - 1] === "<" ? match[0].indexOf(">") : -1;
    const length = bracketEnd >= 0 ? bracketEnd : trimmedLinkLength(match[0]);
    if (length > 0) ranges.push({ from, to: from + length });
    // Text after a closing bracket can hold the next URL.
    if (bracketEnd >= 0) pattern.lastIndex = from + bracketEnd;
  }
  return ranges;
}
