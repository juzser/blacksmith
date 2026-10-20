Show how many notes and tags exist, on the page.

Back end: `GET /api/stats` answers 200 with a JSON object `{ "notes": <count>,
"tags": <count> }`.

Front end:
- Add a module `public/summary.js` that exports a function `describeStats(stats)`.
  Given `{ notes, tags }` it returns text such as `3 notes, 1 tag`, using the
  singular for exactly one (`1 note`, `1 tag`) and the plural otherwise, zero
  included (`0 notes, 0 tags`). Importing the module must not touch the page.
- Add an element with the id `stats` to `public/index.html`, and make the page
  script fill it with that text, fetched from the new endpoint on load and
  refreshed after a note is added or deleted.

Keep the existing page and endpoints working.
