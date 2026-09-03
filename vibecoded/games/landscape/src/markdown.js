// Markdown to HTML, for the four documents in this directory.
//
// Deliberately not a CommonMark parser. It handles what those files
// actually contain -- ATX headings, fenced code, GFM tables, simple
// lists with wrapped continuation lines, blockquotes, rules, and the
// inline run of code/emphasis/links -- and nothing else. Reference
// links, nested lists, setext headings, images and raw HTML are not
// supported, because none of them appear. `tools/test-markdown.mjs`
// checks the renderer against the real documents, so the day one of
// them grows a construct this does not know, the test says so.
//
// Everything is escaped up front, before any rule runs. That ordering
// is the whole safety story: no document, and nothing a document
// links to, can put markup into the page.

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ESCAPE[c]);
}

// Headings become anchors for the table of contents, so the slug has to
// survive the punctuation real headings carry: "11.1 Keyboard and mouse
// (`input.js`)" and the like.
function slugify(text) {
    return text
        .toLowerCase()
        .replace(/&[a-z]+;/g, ' ')
        .replace(/[`*[\]()]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// A character no document can contain: it is stripped from the source
// before parsing, so a code span standing in as one cannot be forged.
const MARK = '\u0000';

// Code spans are pulled out before anything else and put back last, so
// `**not bold**` stays literal.
function inline(text) {
    const spans = [];
    let s = text.replace(/`([^`]+)`/g, (_, code) => {
        spans.push(code);
        return `${MARK}${spans.length - 1}${MARK}`;
    });
    // <http://...>, which the README uses -- already escaped by now.
    s = s.replace(/&lt;((?:https?|mailto):[^\s&]+)&gt;/g,
                  '<a href="$1">$1</a>');
    // A target containing a space is not a link; leaving it as text is
    // what keeps a quote from breaking out of the attribute.
    s = s.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, '<a href="$2">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    return s.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'),
                     (_, n) => `<code>${spans[n]}</code>`);
}

const RE = {
    fence:   /^```/,
    heading: /^(#{1,6}) +(.*)$/,
    rule:    /^(-{3,}|\*{3,}|_{3,})\s*$/,
    bullet:  /^ *([-*]) +(.*)$/,
    number:  /^ *\d+\. +(.*)$/,
    // Escaping runs before the block rules, so a blockquote's marker
    // reaches them as an entity, not as the character it was written as.
    quote:   /^ *&gt; ?(.*)$/,
    align:   /^\|[ :|-]+\|\s*$/,
};

// Where a paragraph or a list item has to stop.
function startsBlock(line, next) {
    return RE.fence.test(line) || RE.heading.test(line) ||
           RE.rule.test(line) || RE.bullet.test(line) ||
           RE.number.test(line) || RE.quote.test(line) ||
           (line.startsWith('|') && RE.align.test(next || ''));
}

function cells(row) {
    return row.replace(/^\|/, '').replace(/\|\s*$/, '').split('|')
              .map((c) => c.trim());
}

export function render(md) {
    const lines = escapeHtml(md.replace(/\r\n?/g, '\n').split(MARK).join(''))
        .split('\n');
    const out = [];
    const seen = new Map();
    let i = 0;

    // Two headings can share a slug -- "Notes" under different sections
    // -- and the table of contents would then send both entries to the
    // first one. Numbering the repeats keeps every anchor reachable.
    const uniqueId = (text) => {
        const base = slugify(text) || 'section';
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        return n === 1 ? base : `${base}-${n}`;
    };

    while (i < lines.length) {
        const line = lines[i];

        if (!line.trim()) { i++; continue; }

        if (RE.fence.test(line)) {
            // The opening fence's language tag is dropped: it names a
            // highlighter this viewer does not have.
            const body = [];
            i++;
            while (i < lines.length && !RE.fence.test(lines[i])) {
                body.push(lines[i]);
                i++;
            }
            i++;                       // the closing fence
            out.push(`<pre><code>${body.join('\n')}</code></pre>`);
            continue;
        }

        const heading = line.match(RE.heading);
        if (heading) {
            const level = heading[1].length;
            const text = heading[2].trim();
            out.push(`<h${level} id="${uniqueId(text)}">${inline(text)}` +
                     `</h${level}>`);
            i++;
            continue;
        }

        if (RE.rule.test(line)) { out.push('<hr>'); i++; continue; }

        if (line.startsWith('|') && RE.align.test(lines[i + 1] || '')) {
            const head = cells(line);
            i += 2;                    // header and alignment rows
            const body = [];
            while (i < lines.length && lines[i].startsWith('|')) {
                body.push(cells(lines[i]));
                i++;
            }
            const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
            const rows = body.map(
                (r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}` +
                       '</tr>').join('');
            out.push(`<table><thead><tr>${th}</tr></thead>` +
                     `<tbody>${rows}</tbody></table>`);
            continue;
        }

        if (RE.bullet.test(line) || RE.number.test(line)) {
            const ordered = RE.number.test(line);
            const items = [];
            while (i < lines.length) {
                const cur = lines[i];
                if (!cur.trim()) {
                    // A blank line ends the list unless another item of
                    // the same kind follows it.
                    let j = i + 1;
                    while (j < lines.length && !lines[j].trim()) j++;
                    const same = j < lines.length &&
                        (ordered ? RE.number : RE.bullet).test(lines[j]);
                    if (!same) break;
                    i = j;
                    continue;
                }
                const b = cur.match(ordered ? RE.number : RE.bullet);
                if (b) {
                    items.push(ordered ? b[1] : b[2]);
                } else if (items.length && !startsBlock(cur, lines[i + 1])) {
                    // A wrapped item: the docs indent the rest of a
                    // sentence under its bullet.
                    items[items.length - 1] += ` ${cur.trim()}`;
                } else break;
                i++;
            }
            const tag = ordered ? 'ol' : 'ul';
            out.push(`<${tag}>` +
                     items.map((t) => `<li>${inline(t)}</li>`).join('') +
                     `</${tag}>`);
            continue;
        }

        if (RE.quote.test(line)) {
            const body = [];
            while (i < lines.length && RE.quote.test(lines[i])) {
                body.push(lines[i].match(RE.quote)[1]);
                i++;
            }
            out.push(`<blockquote><p>${inline(body.join('\n'))}</p>` +
                     '</blockquote>');
            continue;
        }

        const para = [];
        while (i < lines.length && lines[i].trim() &&
               !startsBlock(lines[i], lines[i + 1])) {
            para.push(lines[i]);
            i++;
        }
        // A line that only a block rule could have claimed, claimed by
        // nothing: emit it rather than loop forever on it.
        if (!para.length) { para.push(lines[i]); i++; }
        out.push(`<p>${inline(para.join('\n'))}</p>`);
    }

    return out.join('\n');
}
