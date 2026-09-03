// Tests for the markdown renderer. Runs in node -- no browser, no DOM --
// because render() is a pure string-to-string function, which is the
// whole reason it was written that way.
//
// Two halves. The first pins the individual rules on small literals.
// The second turns the four real documents on the renderer and checks
// that the structure survives: the docs are the only input this thing
// has to handle, so they are the fixture. A renderer that scores well
// on invented snippets and drops a table out of REDESIGN.md is a
// renderer that failed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render } from '../src/markdown.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = ['README.md', 'REDESIGN.md', 'GLOBAL-FLIGHT.md', 'CHANGELOG.md'];

let fails = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); }
    else console.log(`  ok   ${name} ${detail}`);
};
const has = (name, html, needle) =>
    ok(name, html.includes(needle), needle);
const count = (html, re) => (html.match(re) || []).length;

console.log('escaping:');
{
    // Everything is escaped before any rule runs, so no document can
    // put markup into the page.
    const html = render('a < b & c > d');
    has('angle brackets and ampersands become entities', html,
        'a &lt; b &amp; c &gt; d');
    ok('no raw tag survives from the source',
       !render('<script>alert(1)</script>').includes('<script'));
    ok('a quote in a link target cannot break out of the attribute',
       !render('[x](" onmouseover=")').includes('" onmouseover='));
}

console.log('\ninline:');
{
    has('bold', render('**bold**'), '<strong>bold</strong>');
    has('italic', render('*slanted*'), '<em>slanted</em>');
    has('code', render('`code`'), '<code>code</code>');
    has('link', render('[text](http://x)'), '<a href="http://x">text</a>');
    // README writes its URLs as <http://...>, twice.
    has('autolink', render('<http://x/>'), '<a href="http://x/">http://x/</a>');
    // The rule that catches the most bugs: code spans are literal.
    has('markup inside a code span is not interpreted',
        render('`**not bold**`'), '<code>**not bold**</code>');
    ok('an underscore inside a word is not emphasis',
       !render('terrain_window_zoom').includes('<em>'));
}

console.log('\nblocks:');
{
    has('heading', render('## Ray march'), '<h2');
    // The table of contents links to these, so they must be stable.
    has('heading carries a slug id', render('## Ray march'), 'id="ray-march"');
    has('heading slug survives punctuation',
        render('## 3. The step size, revisited'),
        'id="3-the-step-size-revisited"');
    has('unordered list', render('- a\n- b'), '<ul>');
    has('ordered list', render('1. a\n2. b'), '<ol>');
    ok('a list makes one item per line', count(render('- a\n- b'), /<li>/g) === 2);
    has('blockquote', render('> quoted'), '<blockquote>');
    has('horizontal rule', render('---'), '<hr>');
    has('paragraph', render('just words'), '<p>just words</p>');
    ok('two blank-line-separated paragraphs stay separate',
       count(render('one\n\ntwo'), /<p>/g) === 2);
}

console.log('\nfenced code:');
{
    const html = render('```c\nif (a < b) *p = 1;\n```');
    has('becomes a pre block', html, '<pre>');
    has('its content is escaped, not parsed', html, 'if (a &lt; b) *p = 1;');
    ok('no emphasis is applied inside it', !html.includes('<em>'));
    ok('a language tag is not printed as text', !html.includes('>c\n'));
    // A heading-looking line inside a fence is code, not a heading.
    ok('a # line inside a fence is not a heading',
       !render('```\n# not a heading\n```').includes('<h1'));
}

console.log('\ntables:');
{
    const html = render('| A | B |\n|---|---|\n| 1 | 2 |');
    has('becomes a table', html, '<table>');
    ok('the header row becomes th cells', count(html, /<th>/g) === 2);
    ok('the body row becomes td cells', count(html, /<td>/g) === 2);
    ok('the alignment row is not rendered as a body row',
       !html.includes('---'));
    has('cell contents are still inline-rendered',
        render('| A |\n|---|\n| `x` |'), '<code>x</code>');
}

// --- the real documents ------------------------------------------
//
// The oracle is a second, deliberately dumb scan of the source: track
// fence state, and count the headings, fences and table blocks that a
// reader would see. If the renderer and this scan disagree about how
// many of a thing there are, one of them is wrong, and that is worth
// stopping for.
function survey(src) {
    const lines = src.split('\n');
    let inFence = false;
    const out = { headings: 0, fences: 0, tables: 0, columns: [] };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('```')) {
            if (!inFence) out.fences++;
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        if (/^#{1,6} /.test(line)) out.headings++;
        // A table is a header row followed by an alignment row.
        if (line.startsWith('|') && /^\|[ :|-]+\|\s*$/.test(lines[i + 1] || '')) {
            out.tables++;
            out.columns.push(line.replace(/^\||\|\s*$/g, '').split('|').length);
        }
    }
    out.openFence = inFence;
    return out;
}

console.log('\nthe real documents:');
for (const name of DOCS) {
    const src = readFileSync(join(HERE, '..', name), 'utf8');
    const want = survey(src);
    const html = render(src);

    ok(`${name}: every fence is closed`, !want.openFence);
    ok(`${name}: headings`,
       count(html, /<h[1-6][ >]/g) === want.headings,
       `${count(html, /<h[1-6][ >]/g)} of ${want.headings}`);
    ok(`${name}: code blocks`,
       count(html, /<pre>/g) === want.fences,
       `${count(html, /<pre>/g)} of ${want.fences}`);
    ok(`${name}: tables`,
       count(html, /<table>/g) === want.tables,
       `${count(html, /<table>/g)} of ${want.tables}`);
    ok(`${name}: header cells across all tables`,
       count(html, /<th>/g) === want.columns.reduce((a, b) => a + b, 0),
       `${count(html, /<th>/g)} of ${want.columns.reduce((a, b) => a + b, 0)}`);
    // Nothing may leak: no unclosed fence spilling as text, no stray
    // pipe left where a table should have been.
    ok(`${name}: no fence markers survive as text`, !html.includes('```'));
    ok(`${name}: every heading has an id`,
       count(html, /<h[1-6] id="/g) === want.headings);
    // Ids are what the table of contents navigates to, so duplicates
    // would silently send two entries to the same place.
    const ids = [...html.matchAll(/<h[1-6] id="([^"]*)"/g)].map((m) => m[1]);
    ok(`${name}: heading ids are unique`,
       new Set(ids).size === ids.length,
       `${new Set(ids).size} of ${ids.length}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
