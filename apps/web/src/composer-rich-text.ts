import { findComposerAutolinks } from "~/composer-autolinks";

export type RichTextMark = "bold" | "italic" | "strike" | "code";

/** Delimiters other than the default that wrote a span's marks, such as `_` for italic. */
export type RichTextDelimiters = Partial<Record<RichTextMark, string>>;

interface RichTextSpan {
  text: string;
  marks: RichTextMark[];
  delimiters?: RichTextDelimiters;
}

export const RICH_TEXT_DELIMITERS: Record<RichTextMark, string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
  code: "`",
};

function sameDelimiters(left: RichTextDelimiters = {}, right: RichTextDelimiters = {}): boolean {
  return left.bold === right.bold && left.italic === right.italic;
}

function pushSpan(
  spans: RichTextSpan[],
  text: string,
  marks: RichTextMark[],
  delimiters?: RichTextDelimiters,
): void {
  if (!text) return;
  const last = spans[spans.length - 1];
  if (
    last &&
    last.marks.length === marks.length &&
    last.marks.every((mark, index) => mark === marks[index]) &&
    sameDelimiters(last.delimiters, delimiters)
  ) {
    last.text += text;
  } else {
    spans.push(delimiters ? { text, marks, delimiters } : { text, marks });
  }
}

export function parseInlineMarkdown(text: string): RichTextSpan[] {
  const root: RichTextSpan[] = [];
  const stack: { delimiter: string; mark: RichTextMark; spans: RichTextSpan[] }[] = [];
  const current = () => stack.at(-1)?.spans ?? root;
  const links = findComposerAutolinks(text);
  let linkIndex = 0;
  let index = 0;
  while (index < text.length) {
    // A URL is literal text inside whatever styles surround it. One that starts
    // inside a code span or escape stays with that span.
    while (linkIndex < links.length && links[linkIndex]!.from < index) linkIndex += 1;
    const link = links[linkIndex];
    if (link?.from === index) {
      pushSpan(current(), text.slice(link.from, link.to), []);
      index = link.to;
      linkIndex += 1;
      continue;
    }
    const char = text[index]!;
    if (char === "\\") {
      pushSpan(current(), text.slice(index, index + 2), []);
      index += 2;
      continue;
    }
    if (char === "`") {
      const run = text.slice(index).match(/^`+/)![0];
      const close = text.indexOf(run, index + run.length);
      if (
        run.length === 1 &&
        close > index + 1 &&
        !text.slice(index, close).includes("\n") &&
        text[close + 1] !== "`"
      ) {
        pushSpan(current(), text.slice(index + 1, close), ["code"]);
        index = close + 1;
      } else {
        pushSpan(current(), run, []);
        index += run.length;
      }
      continue;
    }
    if (char !== "*" && char !== "_" && char !== "~") {
      pushSpan(current(), char, []);
      index += 1;
      continue;
    }
    let end = index;
    while (text[end] === char) end += 1;
    const before = text[index - 1] ?? "";
    const after = text[end] ?? "";
    const canClose = before !== "" && !/\s/.test(before) && (char !== "_" || !/\w/.test(after));
    const canOpen = after !== "" && !/\s/.test(after) && (char !== "_" || !/\w/.test(before));
    while (index < end) {
      const top = stack.at(-1);
      const opensNestedBold =
        top?.mark === "italic" &&
        end - index === 2 &&
        canOpen &&
        (char === "*" || char === "_") &&
        !stack.some((frame) => frame.mark === "bold");
      if (
        !opensNestedBold &&
        canClose &&
        top &&
        text.startsWith(top.delimiter, index) &&
        index + top.delimiter.length <= end
      ) {
        stack.pop();
        // Keep `_` and `__` so the serializer writes back exactly what was parsed.
        const outer: RichTextDelimiters | undefined =
          top.delimiter === RICH_TEXT_DELIMITERS[top.mark]
            ? undefined
            : { [top.mark]: top.delimiter };
        for (const span of top.spans) {
          const delimiters =
            outer || span.delimiters ? { ...span.delimiters, ...outer } : undefined;
          pushSpan(current(), span.text, [top.mark, ...span.marks], delimiters);
        }
        index += top.delimiter.length;
      } else if (canOpen && (char !== "~" || end - index >= 2)) {
        const length = char === "~" || end - index >= 2 ? 2 : 1;
        const mark = char === "~" ? "strike" : length === 2 ? "bold" : "italic";
        // Prevent self-nesting, including alternate delimiters, to bound the stack by supported styles.
        if (stack.some((frame) => frame.mark === mark)) {
          pushSpan(current(), text.slice(index, end), []);
          index = end;
          continue;
        }
        stack.push({
          delimiter: char.repeat(length),
          mark,
          spans: [],
        });
        index += length;
      } else {
        pushSpan(current(), text.slice(index, end), []);
        index = end;
      }
    }
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    pushSpan(current(), frame.delimiter, []);
    for (const span of frame.spans) pushSpan(current(), span.text, span.marks, span.delimiters);
  }
  return root;
}
