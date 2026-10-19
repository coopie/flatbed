/**
 * A small Markdown renderer for the agent's replies: paragraphs, headings, lists, quotes, bold,
 * italics, code and links. It escapes the whole text before it adds any tag of its own, so raw HTML
 * in a reply shows as text and never reaches the page as markup, and a link is kept only when it
 * goes to an http or https address.
 */

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Inline marks, on text that is already escaped. Code spans and link addresses are set aside first,
 * so marks inside them stay as typed.
 */
function inline(escaped: string): string {
  const kept: string[] = [];
  const keep = (html: string) => `\u0000${kept.push(html) - 1}\u0000`;
  return escaped
    .replace(/`([^`\n]+)`/g, (_, inner: string) => keep(`<code>${inner}</code>`))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, href: string) =>
      `${keep(`<a href="${href}" target="_blank" rel="noopener noreferrer">`)}${label}${keep('</a>')}`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]!);
}

type Block = { kind: 'p' | 'ul' | 'ol' | 'quote' | 'h'; level?: number; lines: string[] };

/** The reply as HTML, safe to put in the page with `{@html}`. */
export function markdown(text: string): string {
  const blocks: Block[] = [];
  let current: Block | undefined;
  const start = (block: Block) => {
    blocks.push(block);
    current = block;
  };
  for (const raw of escape(text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '')).split('\n')) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const quote = line.match(/^&gt;\s?(.*)$/);
    if (line.trim() === '') current = undefined;
    else if (heading) {
      start({ kind: 'h', level: heading[1]!.length, lines: [heading[2]!] });
      current = undefined;
    } else if (bullet) (current?.kind === 'ul' ? current : (start({ kind: 'ul', lines: [] }), current!)).lines.push(bullet[1]!);
    else if (numbered) (current?.kind === 'ol' ? current : (start({ kind: 'ol', lines: [] }), current!)).lines.push(numbered[1]!);
    else if (quote) (current?.kind === 'quote' ? current : (start({ kind: 'quote', lines: [] }), current!)).lines.push(quote[1]!);
    else if (current?.kind === 'ul' || current?.kind === 'ol') current.lines[current.lines.length - 1] += ` ${line.trim()}`;
    else (current?.kind === 'p' ? current : (start({ kind: 'p', lines: [] }), current!)).lines.push(line);
  }
  return blocks
    .map((b) => {
      if (b.kind === 'h') {
        // Headings in a chat reply sit inside the page's own headings, so they start at h4.
        const level = Math.min(6, 3 + b.level!);
        return `<h${level}>${inline(b.lines[0]!)}</h${level}>`;
      }
      if (b.kind === 'ul' || b.kind === 'ol') return `<${b.kind}>${b.lines.map((l) => `<li>${inline(l)}</li>`).join('')}</${b.kind}>`;
      const body = b.lines.map(inline).join('<br>');
      return b.kind === 'quote' ? `<blockquote><p>${body}</p></blockquote>` : `<p>${body}</p>`;
    })
    .join('\n');
}
