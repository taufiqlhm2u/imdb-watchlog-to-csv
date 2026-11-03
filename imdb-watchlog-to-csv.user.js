// ==UserScript==
// @name         IMDb Watchlog → CSV
// @namespace    imdb-watchlog-csv
// @version      1.0.0
// @description  Export your IMDb watch history to a CSV file, including extra title details.
// @match        https://www.imdb.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  /* ====================================================================
   * Settings
   * ==================================================================== */
  const CFG = Object.freeze({
    dateStyle: 'iso',        // 'iso' => 2026-03-05  |  'mdy' => 3/5/2026
    parallel: 2,             // number of detail requests running at the same time
    pauseMs: 350,            // pause after each detail request
    attempts: 3,             // retries per title
    quietRounds: 3,          // rounds without new items before the list counts as fully loaded
    clickTimeoutMs: 5000,    // max wait for new items after clicking "See more"
    cacheTtlDays: 7,
    cacheKey: 'wl2csv:title-cache',
    prefKey: 'wl2csv:prefs',
  });

  const HISTORY_PATH = /\/user\/[^/]+\/watch-?history/i;
  const ENTRY_SELECTOR = 'li.ipc-metadata-list-summary-item, .lister-item';

  const delay = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

  /* ====================================================================
   * Dates
   * ==================================================================== */
  const Dates = (() => {
    const abbr = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const monthNo = (word) => abbr.indexOf(word.slice(0, 3).toLowerCase()) + 1;

    const format = (y, m, d) => {
      if (!(y && m && d)) return '';
      if (CFG.dateStyle === 'mdy') return `${m}/${d}/${y}`;
      return [y, String(m).padStart(2, '0'), String(d).padStart(2, '0')].join('-');
    };

    // Each pattern pairs a regex with a builder that returns a formatted date (or a falsy value).
    const patterns = [
      [/(\d{4})-(\d{1,2})-(\d{1,2})/, (m) => format(+m[1], +m[2], +m[3])],
      [/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/, (m) => monthNo(m[1]) && format(+m[3], monthNo(m[1]), +m[2])],
      [/(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/, (m) => monthNo(m[2]) && format(+m[3], monthNo(m[2]), +m[1])],
      [/(\d{1,2})\/(\d{1,2})\/(\d{4})/, (m) => format(+m[3], +m[1], +m[2])],
    ];

    const parse = (text) => {
      const s = clean(text);
      for (const [re, build] of patterns) {
        const hit = s.match(re);
        const out = hit && build(hit);
        if (out) return out;
      }
      return '';
    };

    return { format, parse };
  })();

  /* ====================================================================
   * Page: detection, item counting, expanding the full list
   * ==================================================================== */
  const Page = {
    onHistory: () => HISTORY_PATH.test(location.pathname),

    root: () => document.querySelector('main') ?? document.body,

    size() {
      const r = this.root();
      return r.querySelectorAll(ENTRY_SELECTOR).length || r.querySelectorAll('a[href*="/title/tt"]').length;
    },

    moreButton() {
      const r = this.root();
      const known = r.querySelector('.ipc-see-more__button, .ipc-see-more button');
      if (known && !known.disabled) return known;
      // Fallback: match by button text in case the class names change.
      return (
        [...r.querySelectorAll('button')].find(
          (b) => !b.disabled && /^(see|show|load)\s+(\d+\s+)?more/i.test(clean(b.textContent)),
        ) ?? null
      );
    },

    async expandAll(isStopped, onTick) {
      let quiet = 0;
      while (quiet < CFG.quietRounds && !isStopped()) {
        const before = this.size();
        window.scrollTo(0, document.body.scrollHeight);

        const btn = this.moreButton();
        if (btn) {
          btn.scrollIntoView({ block: 'center' });
          btn.click();
        }

        // Wait until the item count grows, or give up after a short timeout.
        const deadline = Date.now() + (btn ? CFG.clickTimeoutMs : 900);
        while (Date.now() < deadline && this.size() === before && !isStopped()) await delay(150);

        const after = this.size();
        quiet = after > before ? 0 : quiet + 1;
        onTick(after);
      }
      window.scrollTo(0, 0);
    },
  };

  /* ====================================================================
   * Reader: extracts what is visible on the list page
   * ==================================================================== */
  const Reader = (() => {
    const KINDS = new Map([
      ['movie', 'movie'],
      ['tv series', 'tvSeries'],
      ['tv mini series', 'tvMiniSeries'],
      ['tv mini-series', 'tvMiniSeries'],
      ['tv movie', 'tvMovie'],
      ['tv special', 'tvSpecial'],
      ['tv short', 'tvShort'],
      ['tv episode', 'tvEpisode'],
      ['short', 'short'],
      ['video', 'video'],
      ['video game', 'videoGame'],
      ['podcast series', 'podcastSeries'],
      ['podcast episode', 'podcastEpisode'],
    ]);

    // Returns the first non-empty text found among the given selectors.
    const firstText = (node, selectors) => {
      for (const s of selectors) {
        const t = clean(node.querySelector(s)?.textContent);
        if (t) return t;
      }
      return '';
    };

    const digits = (s) => s.match(/\d+(?:[.,]\d+)?/)?.[0].replace(',', '.') ?? '';

    // Best-effort watch date: <time> element, then date-like hints, then short leaf text.
    const dateOf = (node) => {
      const stamp = node.querySelector('time');
      const fromStamp = stamp && Dates.parse(stamp.getAttribute('datetime') || stamp.textContent);
      if (fromStamp) return fromStamp;

      const hinted = node.querySelector('[data-testid*="date" i], [class*="date" i]');
      const fromHint = hinted && Dates.parse(hinted.textContent);
      if (fromHint) return fromHint;

      for (const leaf of node.querySelectorAll('span, div, li')) {
        if (leaf.childElementCount) continue;
        const txt = clean(leaf.textContent);
        if (txt && txt.length < 40) {
          const d = Dates.parse(txt);
          if (d) return d;
        }
      }
      return '';
    };

    const toEntry = (node, groupDay) => {
      try {
        const anchor =
          node.querySelector('a.ipc-title-link-wrapper[href*="/title/tt"]') ??
          node.querySelector('a[href*="/title/tt"]');
        const id = node.dataset?.tconst || anchor?.getAttribute('href')?.match(/\/title\/(tt\d+)/)?.[1];
        if (!id) return null;

        const label = firstText(node, ['.ipc-title__text', '.lister-item-header a']) || clean(anchor?.textContent);

        const mine = digits(
          firstText(node, [
            '[data-testid="ratingGroup--user-rating"] .ipc-rating-star--rating',
            '.ipc-rating-star--rate .ipc-rating-star--rating',
            '.ipc-rating-star--user-rate',
            '.userratingssummary span',
          ]),
        );

        const site = digits(
          firstText(node, [
            '[data-testid="ratingGroup--imdb-rating"] .ipc-rating-star--rating',
            '.ipc-rating-star--imdb .ipc-rating-star--rating',
            '.ipc-rating-star--base .ipc-rating-star--rating',
            '.imdb-rating strong',
          ]),
        );

        const year =
          [...node.querySelectorAll('.dli-title-metadata-item, .lister-item-year')]
            .map((n) => clean(n.textContent).replace(/[()]/g, '').match(/^(\d{4})/)?.[1])
            .find(Boolean) ?? '';

        const kindText = firstText(node, ['.dli-title-type-data', '[class*="TitleType"]']);

        return {
          id,
          yourRating: mine,
          watchedOn: dateOf(node) || groupDay || '',
          title: label.replace(/^\d+\.\s*/, ''),
          url: `https://www.imdb.com/title/${id}/`,
          kind: KINDS.get(kindText.toLowerCase()) ?? '',
          imdbRating: site,
          year,
        };
      } catch (err) {
        console.warn('[Watchlog→CSV] failed to read one entry', err);
        return null;
      }
    };

    const readAll = () => {
      const root = Page.root();
      const out = [];
      const seen = new Set();
      let currentDay = '';

      const keep = (entry) => {
        if (!entry) return;
        const key = `${entry.id}|${entry.watchedOn}`; // a rewatch on a different date stays a separate row
        if (seen.has(key)) return;
        seen.add(key);
        out.push(entry);
      };

      // Single pass in document order, remembering the most recent date heading
      // (in case the list is grouped by day).
      for (const n of root.querySelectorAll(`${ENTRY_SELECTOR}, h1, h2, h3, h4, h5`)) {
        if (n.matches(ENTRY_SELECTOR)) {
          if (!n.parentElement?.closest(ENTRY_SELECTOR)) keep(toEntry(n, currentDay));
        } else if (!n.closest(ENTRY_SELECTOR)) {
          const t = clean(n.textContent);
          if (t.length < 40) currentDay = Dates.parse(t) || currentDay;
        }
      }

      // Fallback if the class names changed completely: walk up from title links instead.
      if (!out.length) {
        const used = new Set();
        for (const a of root.querySelectorAll('a[href*="/title/tt"]')) {
          const box = a.closest('li') ?? a.parentElement;
          if (box && !used.has(box)) {
            used.add(box);
            keep(toEntry(box, ''));
          }
        }
      }
      return out;
    };

    return { readAll };
  })();

  /* ====================================================================
   * Title details (from each title page) + cache
   * ==================================================================== */
  const TitleInfo = (() => {
    const blank = () => ({
      runtime: '',
      genres: '',
      votes: '',
      released: '',
      directors: '',
      kind: '',
      rating: '',
    });

    const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

    const unescape = (s) =>
      s && s.includes('&') ? new DOMParser().parseFromString(s, 'text/html').documentElement.textContent : s || '';

    // Prefers the embedded Next.js data; falls back to JSON-LD.
    const extract = (html) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const json = (sel) => {
        try {
          return JSON.parse(doc.querySelector(sel)?.textContent ?? '');
        } catch {
          return null;
        }
      };

      const next = json('#__NEXT_DATA__')?.props?.pageProps?.aboveTheFoldData ?? null;
      const ld = json('script[type="application/ld+json"]');
      if (!next && !ld) return null; // likely an error page or a captcha

      const info = blank();

      let minutes = next?.runtime?.seconds ? Math.round(next.runtime.seconds / 60) : 0;
      if (!minutes && ld?.duration) {
        const [, h = 0, m = 0] = ld.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/) ?? [];
        minutes = h * 60 + +m;
      }
      info.runtime = minutes > 0 ? String(minutes) : '';

      const genreNext = next?.genres?.genres?.map((g) => g.text) ?? [];
      info.genres = (genreNext.length ? genreNext : asList(ld?.genre)).filter(Boolean).join(', ');

      info.votes = String(next?.ratingsSummary?.voteCount ?? ld?.aggregateRating?.ratingCount ?? '');
      info.rating = String(next?.ratingsSummary?.aggregateRating ?? ld?.aggregateRating?.ratingValue ?? '');

      const rd = next?.releaseDate;
      info.released =
        rd?.year && rd?.month && rd?.day ? Dates.format(rd.year, rd.month, rd.day) : Dates.parse(ld?.datePublished);

      info.kind = next?.titleType?.id ?? '';

      const dirNext = next?.directorsPageTitle?.[0]?.credits?.map((c) => c?.name?.nameText?.text) ?? [];
      const dirLd = asList(ld?.director).map((d) => unescape(d?.name));
      info.directors = (dirNext.length ? dirNext : dirLd).filter(Boolean).join(', ');

      return info;
    };

    const cache = {
      load() {
        try {
          const stored = GM_getValue(CFG.cacheKey, {}) || {};
          const ttl = CFG.cacheTtlDays * 86_400_000;
          const now = Date.now();
          // Drop expired entries.
          for (const k of Object.keys(stored)) {
            if (!stored[k]?._at || now - stored[k]._at > ttl) delete stored[k];
          }
          return stored;
        } catch {
          return {};
        }
      },
      save(data) {
        try {
          GM_setValue(CFG.cacheKey, data);
        } catch {
          /* ignore storage errors */
        }
      },
    };

    const download = async (id) => {
      for (let n = 1; n <= CFG.attempts; n++) {
        try {
          const res = await fetch(`/title/${id}/`, {
            credentials: 'include',
            headers: { 'Accept-Language': 'en-US,en;q=0.9' },
          });
          if (res.ok) {
            const info = extract(await res.text());
            if (info) return info;
          } else if (res.status !== 429 && res.status < 500) {
            return null; // 403/404 etc.: retrying will not help
          }
        } catch {
          /* network error: retry */
        }
        await delay(1500 * n); // back off a little more on each attempt
      }
      return null;
    };

    const enrichAll = async (entries, { isStopped, onProgress }) => {
      const store = cache.load();
      let cursor = 0;
      let done = 0;
      let failures = 0;

      const merge = (entry, info) =>
        Object.assign(entry, {
          runtime: info.runtime,
          genres: info.genres,
          votes: info.votes,
          released: info.released,
          directors: info.directors,
          kind: info.kind || entry.kind,
          imdbRating: entry.imdbRating || info.rating,
        });

      // Each "lane" pulls the next unprocessed entry until none are left.
      const lane = async () => {
        while (!isStopped()) {
          const entry = entries[cursor++];
          if (!entry) return;

          let info = store[entry.id];
          if (!info) {
            info = await download(entry.id);
            if (info) store[entry.id] = { ...info, _at: Date.now() };
            else failures++;
            await delay(CFG.pauseMs);
          }
          if (info) merge(entry, info);

          onProgress(++done, entries.length, failures);
          if (done % 25 === 0) cache.save(store); // checkpoint so progress survives a reload
        }
      };

      await Promise.all(Array.from({ length: CFG.parallel }, lane));
      cache.save(store);
      return failures;
    };

    return { enrichAll };
  })();

  /* ====================================================================
   * CSV
   * ==================================================================== */
  const Csv = (() => {
    // [column header, entry property]
    const COLUMNS = [
      ['Const', 'id'],
      ['Your Rating', 'yourRating'],
      ['Date Rated', 'watchedOn'],
      ['Title', 'title'],
      ['URL', 'url'],
      ['Title Type', 'kind'],
      ['IMDb Rating', 'imdbRating'],
      ['Runtime (mins)', 'runtime'],
      ['Year', 'year'],
      ['Genres', 'genres'],
      ['Num Votes', 'votes'],
      ['Release Date', 'released'],
      ['Directors', 'directors'],
    ];

    const cell = (v) => {
      const s = String(v ?? '');
      return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };

    const render = (rows) =>
      [COLUMNS.map(([head]) => head), ...rows.map((r) => COLUMNS.map(([, key]) => r[key]))]
        .map((line) => line.map(cell).join(','))
        .join('\r\n');

    const save = (text, filename) => {
      // The BOM makes Excel read the file as UTF-8.
      const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/csv;charset=utf-8' }));
      const link = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    };

    return { render, save };
  })();

  /* ====================================================================
   * Panel (Shadow DOM so IMDb's CSS cannot interfere)
   * ==================================================================== */
  const Panel = (() => {
    const prefs = (() => {
      try {
        return { withDetails: true, ...(GM_getValue(CFG.prefKey, {}) || {}) };
      } catch {
        return { withDetails: true };
      }
    })();

    const el = (tag, props = {}, ...kids) => {
      const node = Object.assign(document.createElement(tag), props);
      node.append(...kids);
      return node;
    };

    const host = el('div');
    host.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483000;display:none;';
    const shadow = host.attachShadow({ mode: 'open' });

    const css = el('style', {
      textContent: `
        .card { width: 270px; box-sizing: border-box; padding: 14px; border-radius: 10px;
                background: #1b1b1b; color: #eee; font: 13px/1.45 system-ui, Arial, sans-serif;
                box-shadow: 0 6px 22px rgba(0,0,0,.45); }
        h4   { margin: 0 0 10px; font-size: 14px; color: #f5c518; }
        label { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 10px; cursor: pointer; }
        .msg { min-height: 36px; margin-bottom: 8px; white-space: pre-line; color: #cfcfcf; }
        .bar { height: 4px; background: #444; border-radius: 2px; overflow: hidden; margin-bottom: 10px; visibility: hidden; }
        .bar > i { display: block; height: 100%; width: 0; background: #f5c518; transition: width .2s; }
        .row { display: flex; gap: 8px; }
        button { flex: 1; padding: 9px 0; border: 0; border-radius: 6px; font-weight: 700; cursor: pointer; }
        .go   { background: #f5c518; color: #111; }
        .stop { background: #3a3a3a; color: #f5c518; }
        button:disabled { opacity: .45; cursor: not-allowed; }
      `,
    });

    const checkbox = el('input', { type: 'checkbox', checked: prefs.withDetails });
    const message = el('div', { className: 'msg', textContent: 'Ready. Click Start to export.' });
    const fill = el('i');
    const bar = el('div', { className: 'bar' }, fill);
    const goBtn = el('button', { className: 'go', textContent: 'Start' });
    const stopBtn = el('button', { className: 'stop', textContent: 'Stop & save', disabled: true });

    shadow.append(
      css,
      el(
        'div',
        { className: 'card' },
        el('h4', { textContent: 'Watchlog → CSV' }),
        el('label', {}, checkbox, el('span', { textContent: 'Fetch extra details (runtime, genres, directors, etc.): slower' })),
        message,
        bar,
        el('div', { className: 'row' }, goBtn, stopBtn),
      ),
    );

    // Remember the checkbox choice between sessions.
    checkbox.addEventListener('change', () => {
      prefs.withDetails = checkbox.checked;
      try {
        GM_setValue(CFG.prefKey, prefs);
      } catch {
        /* ignore storage errors */
      }
    });

    document.body.append(host);

    // IMDb is a single-page app, so poll the URL instead of relying on page loads.
    setInterval(() => {
      host.style.display = Page.onHistory() ? 'block' : 'none';
    }, 800);

    return {
      wantsDetails: () => checkbox.checked,
      say: (text) => (message.textContent = text),
      progress(done, total) {
        bar.style.visibility = 'visible';
        fill.style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
      },
      busy(on) {
        goBtn.disabled = on;
        stopBtn.disabled = !on;
        checkbox.disabled = on;
        if (!on) setTimeout(() => (bar.style.visibility = 'hidden'), 900);
      },
      onStart: (fn) => goBtn.addEventListener('click', fn),
      onStop: (fn) => stopBtn.addEventListener('click', fn),
    };
  })();

  /* ====================================================================
   * Main flow
   * ==================================================================== */
  const job = { running: false, stop: false };
  const isStopped = () => job.stop;

  async function execute() {
    if (job.running) return;
    if (!Page.onHistory()) {
      Panel.say('Open your Watch History page first.');
      return;
    }

    job.running = true;
    job.stop = false;
    Panel.busy(true);

    try {
      Panel.say('Loading the full list…');
      await Page.expandAll(isStopped, (n) => Panel.say(`Loading the full list…\n${n} entries found`));

      const entries = Reader.readAll();
      console.log('[Watchlog→CSV] entries read:', entries.length, entries.slice(0, 3));
      if (!entries.length) {
        Panel.say('No entries could be read. Open the console (F12) for details.');
        return;
      }

      let failures = 0;
      if (Panel.wantsDetails()) {
        failures = await TitleInfo.enrichAll(entries, {
          isStopped,
          onProgress(done, total, failed) {
            Panel.say(`Fetching details…\n${done} / ${total}${failed ? ` (failed: ${failed})` : ''}`);
            Panel.progress(done, total);
          },
        });
      }

      const missingDate = entries.filter((e) => !e.watchedOn).length;
      Csv.save(Csv.render(entries), `imdb-watchlog-${new Date().toISOString().slice(0, 10)}.csv`);

      const notes = [`Done: ${entries.length} entries exported.`];
      if (failures) notes.push(`${failures} detail fetches failed. Run again; the successful ones are cached.`);
      if (missingDate) notes.push(`${missingDate} entries have no watch date.`);
      Panel.say(notes.join('\n'));
    } catch (err) {
      console.error('[Watchlog→CSV]', err);
      Panel.say(`Error: ${err.message}`);
    } finally {
      job.running = false;
      job.stop = false;
      Panel.busy(false);
    }
  }

  Panel.onStart(execute);
  Panel.onStop(() => {
    job.stop = true;
    Panel.say('Stopping… whatever was collected so far will be saved.');
  });
})();
