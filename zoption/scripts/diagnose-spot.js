#!/usr/bin/env node
// Why is there no spot price?
//
//   node scripts/diagnose-spot.js
//
// The terminal's whole screen hangs off one number, and when that number is
// missing there are half a dozen distinguishable reasons. This asks the gateway
// directly and prints the RAW rows it answers with, because the failure is
// almost always in the shape of the reply rather than in an error: Kotak
// answering 200 with a row whose keys nobody recognises looks exactly like
// Kotak answering with nothing.
//
// It reads the live session out of the database — log in on the Broker page
// first.

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = require('../src/config');
const session = require('../src/broker/neoSession');
const db = require('../src/core/db');
const repo = require('../src/repositories');
const neo = require('../src/broker/neoClient');
const instrumentMaster = require('../src/market/instrumentMaster');
const { CANDIDATE_FILTERS, isGatewayError } = require('../src/market/quoteSource');

const UNDERLYING = (process.argv[2] || 'NIFTY').toUpperCase();

const short = (v, n = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s == null ? '(empty)' : s.length > n ? s.slice(0, n) + '…' : s;
};

const line = (label, value) => console.log('  ' + String(label).padEnd(26) + value);

// PACE EVERY REQUEST. This script asks the same account the engine and the
// terminal are already polling, and the quota is Kotak's, not this process's.
// Fired back to back, the first few answer and the rest come back
// "rate_limited" — which then looks like the broker refusing the instrument
// rather than this script throttling itself. The run takes half a minute
// instead of two seconds, and every row means something.
const PACE_MS = 1300;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tryQuote(label, instrument, filter) {
  await sleep(PACE_MS);
  try {
    const rows = await session.quotes([instrument], filter);
    if (!Array.isArray(rows) || !rows.length) {
      console.log(`  ${label.padEnd(38)} ${filter.padEnd(13)} 200, but zero rows`);
      return null;
    }
    const parsed = neo.readQuoteFull(rows[0]);
    const fields = Object.entries(parsed)
      .filter(([k, v]) => k !== 'ids' && v !== null)
      .map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`  ${label.padEnd(38)} ${filter.padEnd(13)} ${parsed.ltp != null ? 'PRICE' : 'no ltp'}  ${fields || '(nothing recognised)'}`);
    if (parsed.ltp == null) {
      console.log(`      raw keys: ${Object.keys(rows[0]).join(', ')}`);
      console.log(`      raw row : ${short(rows[0])}`);
    }
    return parsed;
  } catch (err) {
    // A 503 carries an HTML page in the message. Reduced to its one sentence so
    // the table stays a table.
    const gateway = isGatewayError(err);
    const detail = gateway
      ? String(err.message).replace(/<[^>]*>/g, ' ')
        .replace(/\b(?:quotes:\s*)?HTTP\s*(?:Server\s*Error\s*)?\d{3}\b/gi, ' ')
        .replace(/\s+/g, ' ').trim().slice(0, 60)
      : short(err.message, 90);
    console.log(`  ${label.padEnd(38)} ${filter.padEnd(13)} `
      + `${(gateway ? 'GATEWAY' : 'FAILED').padEnd(8)} ${detail}`);
    gatewayHits += gateway ? 1 : 0;
    return null;
  }
}

let gatewayHits = 0;

async function main() {
  await session.load();
  if (!session.session?.sessionToken) {
    console.error(`No Kotak session in the database. Log in at ${config.appUrl}/brokers first.`);
    process.exit(1);
  }
  console.log(`\nSession: ${session.meta.status} (${session.meta.ucc || 'no ucc'})\n`);

  /* --------------------------------------------------- what the master holds */

  console.log('INSTRUMENT MASTER');
  const total = await repo.instruments.count();
  line('rows total', total);
  const stored = await repo.instruments.indexInstrument(UNDERLYING);
  line(`${UNDERLYING} index row`, stored ? `${stored.segment}|${stored.token}  "${stored.symbol}"` : 'MISSING');
  const resolved = await instrumentMaster.indexInstrument(UNDERLYING);
  line('resolved to', resolved
    ? `${resolved.segment}|${resolved.token}${resolved.quoteBy === 'name' ? '   (by name — the only addressing an index answers to)' : ''}`
    : 'nothing');
  const expiries = await repo.instruments.expiries(UNDERLYING);
  line('future expiries', expiries.length ? expiries.slice(0, 4).join(', ') : 'NONE');

  if (!stored) {
    console.log('\n  The NIFTY index token lives in Kotak\'s CASH master (nse_cm), not the F&O one.');
    console.log('  A sync that pulled nse_fo but failed on nse_cm leaves a full option chain and');
    console.log('  no spot — which is the confusing case, because the screen looks mostly alive.');
    console.log('  Re-sync instruments on the Broker page, then run this again.');
  }

  /* ------------------------------------------------------- quote the index -- */

  console.log('\nINDEX QUOTE — every filter, by token and by name');
  console.log('  ' + 'instrument'.padEnd(38) + 'filter'.padEnd(13) + 'result');
  const candidates = [];
  if (stored?.token) candidates.push({ label: `stored token ${stored.segment}|${stored.token}`, q: { token: String(stored.token), segment: stored.segment } });
  const meta = instrumentMaster.INDEX[UNDERLYING];
  if (meta) {
    candidates.push({ label: `by name nse_cm|${meta.quoteSymbol}`, q: { token: meta.quoteSymbol, segment: meta.segment } });
    for (const name of meta.names) {
      candidates.push({ label: `by alias nse_cm|${name}`, q: { token: name, segment: meta.segment } });
    }
  }

  // The BASELINE filter across every addressing first. Which addressing works
  // is the question that matters — an index answers to its name and not to its
  // token — and sweeping filters before establishing that burns the quota on
  // the wrong axis.
  let anyPrice = false;
  let working = null;
  for (const c of candidates) {
    const parsed = await tryQuote(c.label, c.q, CANDIDATE_FILTERS[0]);
    if (parsed && parsed.ltp != null) { anyPrice = true; working = c; break; }
  }
  // Only once something answers is it worth asking what else it will send.
  if (working) {
    for (const filter of CANDIDATE_FILTERS.slice(1)) {
      await tryQuote(working.label, working.q, filter);
    }
  }

  /* ------------------------------------------------ compare with an option -- */

  console.log('\nOPTION QUOTE — the same account, for comparison');
  if (!expiries.length) {
    console.log('  no expiries in the master, so nothing to compare against');
  } else {
    const chain = await repo.instruments.chain(UNDERLYING, expiries[0]);
    const sample = chain[Math.floor(chain.length / 2)];
    if (!sample) console.log('  the chain is empty for ' + expiries[0]);
    else {
      // One request. This exists to answer "can this account quote ANYTHING",
      // so a sweep here would only spend quota re-proving it.
      await tryQuote(`${sample.symbol}`,
        { token: String(sample.token), segment: sample.segment }, CANDIDATE_FILTERS[0]);
    }
  }

  /* ------------------------------------------------------------- verdict --- */

  console.log('\nVERDICT');
  if (gatewayHits && !anyPrice) {
    console.log(`  Every request was refused by the GATEWAY (${gatewayHits} of them), not by the`);
    console.log('  broker. HTTP 503 "No available server to handle this request" means Kotak had');
    console.log('  nothing to route the call to. Three things produce it, in order of likelihood:');
    console.log('');
    console.log('    1. THE QUOTE SERVICE IS NOT UP. Kotak takes market-data endpoints down');
    console.log('       outside trading hours and during their maintenance windows. If the rows');
    console.log('       above are all 503 including `ltp`, try again inside 09:15-15:30 IST on a');
    console.log('       weekday before changing anything.');
    console.log('');
    console.log('    2. THE FILTER IS NOT A ROUTE. The filter is a PATH SEGMENT, so an');
    console.log('       unrecognised one is a 404 wearing a 503. If `ltp` answers and the richer');
    console.log('       names 503, that is normal and nothing is wrong — the terminal keeps ltp.');
    console.log('');
    console.log('    3. THE API TOKEN IS WRONG FOR THIS ENDPOINT. The quotes path authenticates');
    console.log('       with NEO_API_TOKEN alone — no Sid, no Auth, no neo-fin-key. A stale token');
    console.log('       there fails while order placement keeps working, because they use');
    console.log('       different headers. Re-copy it from NEO App -> Trade API -> Applications.');
    console.log('');
  } else if (anyPrice) {
    console.log('  The gateway DOES quote the index. If the terminal still shows no spot,');
    console.log('  the winning instrument above is not the one the feed is using — check');
    console.log('  `index` in GET /api/terminal/status against the line marked PRICE.');
  } else if (!stored) {
    console.log('  No index price and no stored index row: sync instruments (the nse_cm file).');
  } else {
    console.log('  The account cannot quote the index on any filter. The terminal falls back');
    console.log('  to a SYNTHETIC spot derived from the option chain by put-call parity —');
    console.log('  see doc/terminal.md §"When there is no spot price". It is labelled as');
    console.log('  synthetic everywhere it appears, because it is derived from the same');
    console.log('  premiums the greeks are then computed against.');
  }
  console.log('');
}

main()
  .catch((err) => { console.error('\ndiagnose-spot failed:', err.message); process.exitCode = 1; })
  .finally(() => db.close());
