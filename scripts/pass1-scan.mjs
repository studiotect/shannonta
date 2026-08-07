// Pass 1 scan — bulk EOD pull + cheap filters (price vs MAs, RVOL, ADX-lite).
// Runs server-side in GitHub Actions, so no CORS concerns here.
//
// Data model kept intentionally simple:
//   data/history.json  -> { "AAPL": [{d:"2026-01-02",o,h,l,c,v}, ...], ... }  (rolling ~260 sessions/ticker)
//   data/pass1.json    -> { asOf, universe, survivors: ["AAPL", ...], meta: {...} }
//
// LOOKBACK controls how far back to backfill on first run (need ~200+ sessions for 200 SMA).
// RATE_LIMIT_MS spaces calls to respect Polygon's free-tier 5 req/min.

import fs from 'node:fs/promises';

const API_KEY = process.env.POLYGON_API_KEY;
if (!API_KEY) throw new Error('POLYGON_API_KEY not set — add it as a repo secret.');

const BASE = 'https://api.polygon.io';
const LOOKBACK_DAYS = 260;          // calendar days to look back on first run
const RATE_LIMIT_MS = 13000;        // ~4.6 req/min, safely under the 5/min cap
const HISTORY_PATH = 'data/history.json';
const OUTPUT_PATH  = 'data/pass1.json';
const EXCLUDED_PATH = 'data/universe-excluded.json';
const MAX_HISTORY_PER_TICKER = 260; // prune old sessions to keep file size sane
const EXCLUDE_RETRY_DAYS = 7;       // re-attempt an excluded ticker at most this often
const CHECKPOINT_EVERY = 20;        // save history.json every N days during a backfill

// TODO: replace with your actual universe (e.g. a static Russell 3000 ticker
// list committed to the repo). Grouped-daily returns EVERYTHING (incl. OTC/
// micro-caps) — you want to filter to your universe before running filters,
// both for signal quality and to keep data/history.json from ballooning.
async function loadUniverse() {
  try {
    const raw = await fs.readFile('data/universe.json', 'utf8');
    return new Set(JSON.parse(raw));
  } catch {
    console.warn('No data/universe.json found — using every ticker in the response. Add a universe file to scope this down.');
    return null;
  }
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const fmtDate = d => d.toISOString().slice(0, 10);

function isWeekday(d) {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

async function fetchGroupedDay(dateStr, attempt = 1) {
  const url = `${BASE}/v2/aggs/grouped/locale/us/market/stocks/${dateStr}?adjusted=true&apiKey=${API_KEY}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    // Transient network error (DNS blip, socket reset, timeout) — worth a
    // few retries rather than losing an entire long-running backfill.
    if (attempt >= 3) throw e;
    console.log(`Fetch error for ${dateStr} (attempt ${attempt}): ${e.message} — retrying in 15s...`);
    await wait(15000);
    return fetchGroupedDay(dateStr, attempt + 1);
  }
  if (res.status === 429) {
    console.log('Rate limited — backing off 60s...');
    await wait(60000);
    return fetchGroupedDay(dateStr, attempt);
  }
  if (!res.ok) {
    if (res.status >= 500 && attempt < 3) {
      console.log(`HTTP ${res.status} for ${dateStr} (attempt ${attempt}) — retrying in 15s...`);
      await wait(15000);
      return fetchGroupedDay(dateStr, attempt + 1);
    }
    throw new Error(`HTTP ${res.status} for ${dateStr}`);
  }
  const j = await res.json();
  // Polygon returns resultsCount:0 for weekends/holidays — treat as "no session"
  if (!j.results?.length) return null;
  return j.results; // [{T:ticker, o,h,l,c,v,...}, ...]
}

async function loadHistory() {
  try {
    return JSON.parse(await fs.readFile(HISTORY_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function lastDateInHistory(history) {
  let max = null;
  for (const rows of Object.values(history)) {
    const last = rows[rows.length - 1]?.d;
    if (last && (!max || last > max)) max = last;
  }
  return max;
}

function datesToBackfill(history) {
  const last = lastDateInHistory(history);
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - LOOKBACK_DAYS);
  const from = last ? new Date(last) : start;
  if (last) from.setUTCDate(from.getUTCDate() + 1); // day after last stored session

  const dates = [];
  const cursor = new Date(Math.max(from, start));
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  while (cursor <= yesterday) {
    if (isWeekday(cursor)) dates.push(fmtDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function appendDay(history, dateStr, rows, universe) {
  for (const r of rows) {
    if (universe && !universe.has(r.T)) continue;
    if (!history[r.T]) history[r.T] = [];
    history[r.T].push({ d: dateStr, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
  }
}

function pruneHistory(history) {
  for (const t of Object.keys(history)) {
    if (history[t].length > MAX_HISTORY_PER_TICKER) {
      history[t] = history[t].slice(-MAX_HISTORY_PER_TICKER);
    }
  }
}

// ── Cheap Pass 1 filters ──────────────────────────────────
function sma(rows, p) {
  if (rows.length < p) return null;
  const slice = rows.slice(-p);
  return slice.reduce((a, r) => a + r.c, 0) / p;
}
function avgVol(rows, p) {
  if (rows.length < p) return null;
  const slice = rows.slice(-p);
  return slice.reduce((a, r) => a + r.v, 0) / p;
}
// Simplified ADX-lite: uses average true range trend as a stand-in proxy.
// Swap in a real Wilder's ADX if you want the precise indicator.
function trendStrengthProxy(rows, p = 14) {
  if (rows.length < p + 1) return null;
  const slice = rows.slice(-p - 1);
  let sumTR = 0, netMove = 0;
  for (let i = 1; i < slice.length; i++) {
    const tr = Math.max(
      slice[i].h - slice[i].l,
      Math.abs(slice[i].h - slice[i - 1].c),
      Math.abs(slice[i].l - slice[i - 1].c)
    );
    sumTR += tr;
    netMove += slice[i].c - slice[i - 1].c;
  }
  return sumTR ? Math.abs(netMove) / sumTR : 0; // 0-1, higher = more directional
}

function runFilters(history) {
  const survivors = [];
  for (const [ticker, rows] of Object.entries(history)) {
    if (rows.length < 55) continue; // need enough bars for 50 SMA
    const close = rows[rows.length - 1].c;
    const ma20 = sma(rows, 20), ma50 = sma(rows, 50);
    const vol20 = avgVol(rows, 20), volToday = rows[rows.length - 1].v;
    const rvol = vol20 ? volToday / vol20 : null;
    const trend = trendStrengthProxy(rows, 14);

    const priceVsMA = ma20 && ma50 ? close > ma20 && ma20 > ma50 || close < ma20 && ma20 < ma50 : false;
    const rvolOk = rvol != null && rvol > 1.2;
    const trendOk = trend != null && trend > 0.25;

    // Require all 3 conditions — 2-of-3 let too much through against the full
    // 2500+ universe (546 survivors vs. the ~100-300 target).
    const passCount = [priceVsMA, rvolOk, trendOk].filter(Boolean).length;
    if (passCount === 3) {
      survivors.push({ t: ticker, close, ma20, ma50, rvol, trend });
    }
  }
  return survivors;
}

async function loadExcluded() {
  try {
    return JSON.parse(await fs.readFile(EXCLUDED_PATH, 'utf8'));
  } catch {
    return {}; // { TICKER: "YYYY-MM-DD" (date of last failed backfill attempt) }
  }
}

async function saveExcluded(excluded) {
  await fs.writeFile(EXCLUDED_PATH, JSON.stringify(excluded, null, 2));
}

// Find universe tickers that don't have enough history yet — e.g. tickers
// added when the universe was expanded. datesToBackfill() only looks at the
// *latest* date across existing history and won't catch this: if the rest
// of the universe is already caught up to yesterday, it'll compute an empty
// catch-up range and these new tickers get silently skipped forever.
//
// Tickers that Polygon will never return data for (delisted/merged, a
// ticker-format mismatch, an N-PORT filing quirk) would otherwise re-trigger
// the full ~40-minute backfill loop every single run forever. Once a ticker
// fails a backfill attempt it's recorded in data/universe-excluded.json and
// skipped for EXCLUDE_RETRY_DAYS before being tried again.
function tickersNeedingBackfill(universe, history, minBars, excluded, today) {
  const needs = new Set();
  if (!universe) return needs;
  for (const t of universe) {
    const rows = history[t];
    if (rows && rows.length >= minBars) continue;
    const lastAttempt = excluded[t];
    if (lastAttempt) {
      const daysSince = (today - new Date(lastAttempt)) / 86400000;
      if (daysSince < EXCLUDE_RETRY_DAYS) continue;
    }
    needs.add(t);
  }
  return needs;
}

async function backfillNewTickers(needBackfill, history) {
  console.log(`${needBackfill.size} ticker(s) missing sufficient history — running a full ${LOOKBACK_DAYS}-day backfill for just these (one-time cost; ~${Math.round(LOOKBACK_DAYS * 5 / 7 * RATE_LIMIT_MS / 60000)} min at current rate limit).`);

  const start = new Date();
  start.setUTCDate(start.getUTCDate() - LOOKBACK_DAYS);
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  const cursor = new Date(start);
  let daysFetched = 0;
  while (cursor <= yesterday) {
    if (isWeekday(cursor)) {
      const dateStr = fmtDate(cursor);
      console.log(`Backfill fetch ${dateStr} (new tickers only)...`);
      const rows = await fetchGroupedDay(dateStr);
      if (rows) {
        for (const r of rows) {
          if (!needBackfill.has(r.T)) continue;
          if (!history[r.T]) history[r.T] = [];
          if (history[r.T].some(row => row.d === dateStr)) continue; // avoid dupes on re-run
          history[r.T].push({ d: dateStr, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
        }
      } else {
        console.log(`  (no session — market closed)`);
      }
      daysFetched++;
      // Checkpoint periodically — a backfill can take ~40min across ~180
      // requests, and a late transient failure shouldn't lose all of it.
      if (daysFetched % CHECKPOINT_EVERY === 0) {
        await fs.mkdir('data', { recursive: true });
        await fs.writeFile(HISTORY_PATH, JSON.stringify(history));
        console.log(`  (checkpoint saved after ${daysFetched} day(s))`);
      }
      await wait(RATE_LIMIT_MS);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // Grouped-daily calls above are already chronological, but sort defensively.
  for (const t of needBackfill) {
    if (history[t]) history[t].sort((a, b) => a.d.localeCompare(b.d));
  }
}

async function main() {
  const universe = await loadUniverse();
  const history = await loadHistory();
  const excluded = await loadExcluded();
  const today = new Date();

  const needBackfill = tickersNeedingBackfill(universe, history, 55, excluded, today);
  if (needBackfill.size > 0) {
    await backfillNewTickers(needBackfill, history);
    // Save progress immediately — this pass can take a while, and we don't
    // want to lose a near-complete backfill if the incremental step below fails.
    await fs.mkdir('data', { recursive: true });
    await fs.writeFile(HISTORY_PATH, JSON.stringify(history));

    // Anything that still doesn't have enough bars after a full lookback
    // attempt isn't going to resolve itself tomorrow (delisted, merged, a
    // ticker Polygon doesn't recognize) — record it so it stops forcing a
    // ~40-minute backfill on every future run.
    const todayStr = fmtDate(today);
    for (const t of needBackfill) {
      const rows = history[t];
      if (!rows || rows.length < 55) excluded[t] = todayStr;
      else delete excluded[t];
    }
    await saveExcluded(excluded);
  }

  const dates = datesToBackfill(history);

  console.log(`Backfilling ${dates.length} session(s)...`);
  for (const dateStr of dates) {
    console.log(`Fetching ${dateStr}...`);
    const rows = await fetchGroupedDay(dateStr);
    if (rows) appendDay(history, dateStr, rows, universe);
    else console.log(`  (no session — market closed)`);
    if (dateStr !== dates[dates.length - 1]) await wait(RATE_LIMIT_MS);
  }

  pruneHistory(history);
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history));

  const survivors = runFilters(history);
  const output = {
    asOf: new Date().toISOString(),
    universeSize: Object.keys(history).length,
    survivorCount: survivors.length,
    survivors,
  };
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Done. ${survivors.length} survivors written to ${OUTPUT_PATH}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
