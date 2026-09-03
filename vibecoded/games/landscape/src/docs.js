// The documentation overlay: the four markdown files in this directory,
// readable without leaving the demo.
//
// The list is hardcoded because a static server offers no directory
// listing, and four files did not justify a manifest. Each is fetched
// on the first visit and kept, so switching back is instant and a
// document is never fetched twice.

import { render } from './markdown.js';

const DOCS = [
    { key: 'readme',    file: 'README.md',        title: 'README' },
    { key: 'redesign',  file: 'REDESIGN.md',      title: 'REDESIGN' },
    { key: 'flight',    file: 'GLOBAL-FLIGHT.md', title: 'GLOBAL-FLIGHT' },
    { key: 'changelog', file: 'CHANGELOG.md',     title: 'CHANGELOG' },
];

const HASH = '#docs/';

export class Docs {
    // onOpen/onClose let the caller park the flight controls. Reading
    // and flying at the same time is not a thing anyone wants.
    constructor({ onOpen, onClose } = {}) {
        this.onOpen = onOpen;
        this.onClose = onClose;
        this.root = document.getElementById('docs');
        this.list = document.getElementById('docs-list');
        this.body = document.getElementById('docs-body');
        this.article = document.getElementById('docs-article');
        this.cache = new Map();      // key -> rendered HTML
        this.scroll = new Map();     // key -> scrollTop, so a doc reopens
                                     // where it was left
        this.current = null;
        this.headings = [];

        for (const doc of DOCS) {
            const li = document.createElement('li');
            const button = document.createElement('button');
            button.className = 'docs-title';
            button.textContent = doc.title;
            button.addEventListener('click', () => this.show(doc.key));
            const toc = document.createElement('ul');
            toc.className = 'docs-toc';
            li.append(button, toc);
            this.list.append(li);
            doc.el = { li, button, toc };
        }

        this.closeButton = document.getElementById('docs-close');
        this.closeButton.addEventListener('click', () => this.close());
        document.getElementById('docs-open')
            .addEventListener('click', () => this.open());

        // The overlay handles its own keys rather than relying on the
        // flight controls to do it, so it still closes when focus is on
        // a link inside it, and so Tab cannot wander out to a panel the
        // reader cannot see.
        this.root.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
            if (e.key !== 'Tab') return;
            const stops = this.focusables();
            if (!stops.length) return;
            const first = stops[0];
            const last = stops[stops.length - 1];
            const on = document.activeElement;
            if (e.shiftKey && (on === first || !stops.includes(on))) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && on === last) {
                e.preventDefault();
                first.focus();
            }
        });

        // Track the heading being read so the contents can say where you
        // are. rAF-coalesced: scroll fires far more often than the
        // highlight can usefully change.
        let pending = false;
        this.body.addEventListener('scroll', () => {
            if (this.current) this.scroll.set(this.current, this.body.scrollTop);
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => { pending = false; this.spy(); });
        });

        addEventListener('hashchange', () => this.fromHash());
    }

    get isOpen() { return !this.root.hidden; }

    // A document is linkable: #docs/redesign opens straight to it. The
    // query string is left alone -- main.js owns that, and a pinned pose
    // there must survive someone reading the docs.
    fromHash() {
        if (!location.hash.startsWith(HASH)) {
            if (this.isOpen) this.close({ hash: false });
            return;
        }
        const key = location.hash.slice(HASH.length);
        if (DOCS.some((d) => d.key === key)) this.open(key);
    }

    // Only what can actually be reached: the contents of the documents
    // you are not reading are hidden by the stylesheet, and a tab stop
    // you cannot see is worse than no tab stop at all.
    focusables() {
        const doc = DOCS.find((d) => d.key === this.current);
        return [
            this.closeButton,
            ...DOCS.map((d) => d.el.button),
            ...(doc ? [...doc.el.toc.querySelectorAll('a')] : []),
            this.body,
        ].filter(Boolean);
    }

    open(key) {
        if (!this.isOpen) {
            // Where to put focus back when this closes.
            this.opener = document.activeElement;
            this.root.hidden = false;
            // Otherwise the mouse keeps steering the camera behind the
            // overlay, and a click on a link would recapture it.
            document.exitPointerLock?.();
            this.onOpen?.();
        }
        this.show(key || this.current || DOCS[0].key);
        // The reading pane, not the first link: the first thing anyone
        // wants here is to page through the prose.
        this.body.focus?.();
    }

    close({ hash = true } = {}) {
        if (!this.isOpen) return;
        this.root.hidden = true;
        if (hash && location.hash.startsWith(HASH)) {
            history.replaceState(null, '', location.pathname + location.search);
        }
        // Focus must not be left on something now hidden, or it falls to
        // the body and the next Tab starts from the top of the page.
        this.opener?.focus?.();
        this.opener = null;
        this.onClose?.();
    }

    toggle() { this.isOpen ? this.close() : this.open(); }

    async show(key) {
        const doc = DOCS.find((d) => d.key === key);
        if (!doc || this.current === key) return;
        if (this.current) this.scroll.set(this.current, this.body.scrollTop);

        this.current = key;
        for (const d of DOCS) {
            d.el.li.classList.toggle('active', d === doc);
            // Colour alone does not say "you are here".
            if (d === doc) d.el.button.setAttribute('aria-current', 'page');
            else d.el.button.removeAttribute('aria-current');
        }
        if (location.hash !== HASH + key) {
            history.replaceState(null, '',
                                 location.pathname + location.search + HASH + key);
        }

        if (!this.cache.has(key)) {
            this.article.innerHTML = '<p class="docs-loading">Loading…</p>';
            try {
                const res = await fetch(doc.file);
                if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
                this.cache.set(key, render(await res.text()));
            } catch (e) {
                // Serving the folder is a precondition of the demo
                // itself, so this is worth naming rather than blanking.
                this.article.innerHTML =
                    `<h1>${doc.title}</h1><p class="docs-error">Could not load ` +
                    `<code>${doc.file}</code> — ${e.message}.</p>`;
                this.setToc(doc, []);
                return;
            }
            // Another document may have been picked while this one was
            // in flight; the cache keeps the work, but do not paint it.
            if (this.current !== key) return;
        }

        this.article.innerHTML = this.cache.get(key);
        // REDESIGN's tables run wider than any readable measure, so each
        // gets its own scroller rather than widening the page.
        for (const table of this.article.querySelectorAll('table')) {
            const wrap = document.createElement('div');
            wrap.className = 'docs-scroll';
            table.replaceWith(wrap);
            wrap.append(table);
        }
        this.headings = [...this.article.querySelectorAll('h2, h3')];
        this.setToc(doc, this.headings);
        this.body.scrollTop = this.scroll.get(key) || 0;
        this.spy();
    }

    setToc(doc, headings) {
        // Every list, not just this one: the outgoing document's entries
        // are only hidden by the stylesheet, and leaving REDESIGN's 77 of
        // them behind on each switch is dead weight in the tree.
        for (const d of DOCS) d.el.toc.replaceChildren();
        this.tocLinks = new Map();
        for (const h of headings) {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = `#${h.id}`;
            a.textContent = h.textContent;
            a.className = h.tagName === 'H3' ? 'sub' : '';
            a.addEventListener('click', (e) => {
                // The article scrolls inside its own box, and letting the
                // browser resolve the fragment would rewrite the hash
                // that names the open document.
                e.preventDefault();
                h.scrollIntoView({ block: 'start' });
            });
            li.append(a);
            doc.el.toc.append(li);
            this.tocLinks.set(h, a);
        }
    }

    // The heading you are under is the last one that has passed the top
    // of the reading pane.
    spy() {
        if (!this.headings.length) return;
        const top = this.body.getBoundingClientRect().top + 80;
        let active = this.headings[0];
        for (const h of this.headings) {
            if (h.getBoundingClientRect().top <= top) active = h;
            else break;
        }
        for (const [h, a] of this.tocLinks) {
            const here = h === active;
            a.classList.toggle('here', here);
            if (here) a.setAttribute('aria-current', 'location');
            else a.removeAttribute('aria-current');
        }
    }
}
