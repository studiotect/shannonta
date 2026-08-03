// scripts/fetch-universe-sec.mjs
//
// Pulls IWV (iShares Russell 3000 ETF) holdings from SEC EDGAR's N-PORT
// filings via the EDGAR Full-Text Search API (efts.sec.gov) — the same
// endpoint EDGAR's own search page calls. This avoids the bot detection on
// ishares.com entirely and avoids the ticker-lookup quirks of browse-edgar,
// which doesn't reliably resolve fund *series* tickers (only company-level
// tickers).
//
// Trade-off: N-PORT holdings are as of month-end, filed ~30-45 days later.
// Fine for tracking index *membership* (changes rarely); not a substitute
// for daily price data.
//
// Requires: npm install fast-xml-parser
//
// Run manually: node scripts/fetch-universe-sec.mjs

import fs from 'fs';
import { XMLParser } from 'fast-xml-parser';

// SEC requires a real identifying User-Agent (name + contact email) on every request.
const SEC_USER_AGENT = 'ShannonTA jaytriemert@gmail.com';

// Confirmed identifiers for IWV (iShares Russell 3000 ETF), found directly
// from a live N-PORT filing's primary_doc.xml:
const IWV_CIK = '0001100663';        // iShares Trust (parent entity — hosts hundreds of series)
const IWV_SERIES_ID = 'S000004341';  // the specific series ID for IWV

async function secFetch(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': SEC_USER_AGENT,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`SEC fetch failed (${url}): HTTP ${res.status}`);
  return res;
}

async function findLatestNportFiling() {
  const url = `https://efts.sec.gov/LATEST/search-index?q=%22${IWV_SERIES_ID}%22&forms=NPORT-P&ciks=${IWV_CIK}&sort=desc`;
  const res = await secFetch(url);
  const json = await res.json();

  const hits = json?.hits?.hits;
  if (!hits || hits.length === 0) {
    console.error('--- Raw response for diagnosis ---');
    console.error(JSON.stringify(json, null, 2).slice(0, 1500));
    console.error('--- End raw response ---');
    throw new Error(`No NPORT-P filings found for series ${IWV_SERIES_ID}. See raw response above.`);
  }

  // _id format is "{accession-no-with-dashes}:{filename}"
  const topHit = hits[0];
  const id = topHit._id;
  const [accessionNoDashed] = id.split(':');
  const accessionNoPlain = accessionNoDashed.replace(/-/g, '');

  const cikPlain = IWV_CIK.replace(/^0+/, '');
  const primaryDocUrl = `https://www.sec.gov/Archives/edgar/data/${cikPlain}/${accessionNoPlain}/primary_doc.xml`;

  return { primaryDocUrl, accessionNoDashed, source: topHit._source };
}

async function parseNportHoldings(xmlUrl) {
  const res = await secFetch(xmlUrl);
  const xmlText = await res.text();

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xmlText);

  const invstOrSecs = doc?.edgarSubmission?.formData?.invstOrSecs?.invstOrSec;
  if (!invstOrSecs) {
    console.error('--- Top-level XML keys for diagnosis ---');
    console.error(Object.keys(doc?.edgarSubmission?.formData || {}));
    console.error('--- End diagnostic ---');
    throw new Error('Could not find invstOrSecs holdings array in primary_doc.xml — SEC may have changed the N-PORT schema.');
  }

  const holdings = Array.isArray(invstOrSecs) ? invstOrSecs : [invstOrSecs];
  return holdings;
}

function extractTicker(holding) {
  const tickerNode = holding?.identifiers?.ticker;
  if (!tickerNode) return null;
  const val = tickerNode['@_value'] || tickerNode;
  return typeof val === 'string' ? val.trim() : null;
}

function normalizeTicker(raw) {
  return raw.replace(/\./g, '-'); // BRK.B -> BRK-B for Polygon
}

async function main() {
  console.log('Looking up latest IWV N-PORT-P filing via EDGAR full-text search...');
  const { primaryDocUrl, accessionNoDashed, source } = await findLatestNportFiling();
  console.log('Found filing:', accessionNoDashed, '| filed:', source?.file_date || source?.filedAt || '(date unknown)');
  console.log('primary_doc.xml:', primaryDocUrl);

  const holdings = await parseNportHoldings(primaryDocUrl);
  console.log(`Total positions in filing: ${holdings.length}`);

  const equities = holdings.filter(h => h.assetCat === 'EC'); // EC = Equity - Common Stock

  const universe = [];
  const seen = new Set();
  for (const h of equities) {
    const rawTicker = extractTicker(h);
    if (!rawTicker) continue;
    const ticker = normalizeTicker(rawTicker);
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    universe.push({
      ticker,
      name: h.name || h.title || '',
      cusip: h.cusip || '',
    });
  }

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/universe.json', JSON.stringify(universe.map(u => u.ticker), null, 2));
  fs.writeFileSync('data/universe-meta.json', JSON.stringify(universe, null, 2));

  console.log(`Equity positions with tickers: ${universe.length}`);
  if (universe.length < 2000 || universe.length > 3200) {
    console.warn(`WARNING: universe size (${universe.length}) is outside the expected ~2500-2600 range. Some holdings may lack ticker data in the filing, or the assetCat filter needs adjusting.`);
  }
}

main().catch(err => {
  console.error('fetch-universe-sec.mjs failed:', err);
  process.exit(1);
});