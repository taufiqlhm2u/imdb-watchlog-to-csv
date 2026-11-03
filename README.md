# IMDb Watchlog → CSV

A userscript that exports your IMDb **Watch History** to a **CSV** file. Everything runs in your own browser: no third-party server and no API key.

## Features

- Loads your entire history automatically (auto-scroll and "See more" clicking), so there is no manual scrolling.
- Optional **extra details** per title: runtime, genres, vote count, release date, and directors.
- A small floating panel in the bottom-right corner (built with Shadow DOM, so it will not clash with IMDb's CSS), with a progress bar and a **Stop & save** button.
- Title details are cached for 7 days, so re-running the export is much faster.
- Detail requests are throttled (small parallelism, short pauses, automatic retry on 429/5xx) to stay gentle on IMDb.
- Rewatches (the same title on different dates) are kept as separate rows.
- The panel only appears on the Watch History page, including when you navigate there without a full page reload.

## Installation

1. Install a userscript manager in your browser:
   - [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox, Safari), or
   - [Violentmonkey](https://violentmonkey.github.io/) (Chrome, Edge, Firefox).
2. Create a new script in the extension dashboard, delete the default content, paste the entire contents of `imdb-watchlog-to-csv.user.js`, and save (`Ctrl + S`). Alternatively, open the `.user.js` file directly in your browser and the extension will offer to install it.
3. Make sure the script is **enabled**.

> On recent versions of Chrome, userscript managers sometimes do not run until you enable **Developer mode** on `chrome://extensions`, or the **Allow User Scripts** option on the extension's details page. If the panel does not show up, check these first.

## Usage

1. Log in to IMDb.
2. Open your Watch History page: `https://www.imdb.com/user/urXXXXXXXX/watchhistory/` (replace `urXXXXXXXX` with your own account ID).
3. The **Watchlog → CSV** panel appears in the bottom-right corner.
4. Tick or untick **Fetch extra details**:
   - **Ticked**: runtime, genres, directors, and similar columns are filled in, but it takes longer (one request per title).
   - **Unticked**: fast, and limited to what is visible on the list page.
5. Click **Start**. Keep the tab open and in the foreground, because the script scrolls the page for you.
6. Wait for the **Done** message. The file `imdb-watchlog-YYYY-MM-DD.csv` downloads automatically.
7. To stop early, click **Stop & save**. Whatever has been collected so far is still exported.

## CSV columns

| Column | Description |
| --- | --- |
| `Const` | IMDb ID (for example `tt0111161`) |
| `Your Rating` | Your own rating, if any |
| `Date Rated` | Watch date detected on the page |
| `Title` | Title as shown on your account |
| `URL` | Link to the title page |
| `Title Type` | `movie`, `tvSeries`, `tvEpisode`, etc. |
| `IMDb Rating` | IMDb rating |
| `Runtime (mins)` | Runtime in minutes |
| `Year` | Release year |
| `Genres` | Genres, comma-separated |
| `Num Votes` | Number of votes |
| `Release Date` | Release date |
| `Directors` | Directors, comma-separated |

The file is UTF-8 with a BOM, so it opens correctly in both Excel and Google Sheets.

## Configuration

Edit the values in the `CFG` block at the top of the script:

| Option | Default | Purpose |
| --- | --- | --- |
| `dateStyle` | `'iso'` | `'iso'` gives `2026-03-05`, `'mdy'` gives `3/5/2026` |
| `parallel` | `2` | Number of simultaneous detail requests |
| `pauseMs` | `350` | Pause (ms) after each detail request |
| `attempts` | `3` | Retries per title |
| `quietRounds` | `3` | Rounds without new items before the list counts as fully loaded |
| `cacheTtlDays` | `7` | How long title details stay cached |

## Troubleshooting

**The panel does not appear**
Make sure the URL matches `/user/.../watchhistory`, the script is enabled, and (on Chrome) user scripts are allowed.

**"No entries could be read"**
IMDb may have changed its page structure. Open the console (`F12`) and look for logs prefixed with `[Watchlog→CSV]`. Then inspect the list item's classes in the Elements tab and update the `ENTRY_SELECTOR` constant near the top of the script.

**The date column is empty**
The script reports how many entries have no date. Copy the HTML of one list item (right-click, Inspect, Copy outerHTML) and adjust the `dateOf` function inside `Reader`.

**Many detail fetches fail**
Increase `pauseMs` (for example to `800`) or lower `parallel` to `1`, then run again. Titles that already succeeded are cached and will not be fetched again.

**Very large history takes too long**
Untick **Fetch extra details** for a quick export.

## Privacy

- Your data is processed only in your browser.
- The only network requests go to `www.imdb.com` (title pages, for the extra details), using your own logged-in session.
- Cached title details are stored locally through your userscript manager's storage.

## Notes

- This project is not affiliated with IMDb. Use it only to export your own account data, and respect IMDb's terms of service.
- IMDb can change its page structure at any time, so selectors may need updating.

## Credits

Inspired by the *IMDB Watch History Exporter* userscript by **lemonade**. Check the original repository's license before redistributing, and keep attribution if it requires it.

## License

Choose your own license (for example MIT) by adding a `LICENSE` file to the repository.
