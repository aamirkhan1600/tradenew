#!/usr/bin/env node
// Probe Kotak's scrip-master endpoint and print exactly what it says.
//
//   node scripts/diagnose-master.js
//
// A 424 from the gateway carries its reason in the response BODY, so this prints
// bodies rather than status codes. It reads the live session out of the database
// — log in on the Broker page first.

const path = require('path');
const axios = require('axios');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = require('../src/config');
const session = require('../src/broker/neoSession');
const db = require('../src/core/db');

const VARIANTS = [
  { label: 'Files + session token only', path: '/Files/1.0/masterscrip/file-paths', headers: (s) => ({ Authorization: s.sessionToken }) },
  { label: 'Files + Bearer session',     path: '/Files/1.0/masterscrip/file-paths', headers: (s) => ({ Authorization: `Bearer ${s.sessionToken}` }) },
  { label: 'Files + full trading set',   path: '/Files/1.0/masterscrip/file-paths', headers: (s) => ({ Authorization: s.sessionToken, Sid: s.sid, Auth: s.sessionToken, 'neo-fin-key': config.neo.finKey }) },
  { label: 'Files + api token',          path: '/Files/1.0/masterscrip/file-paths', headers: () => ({ Authorization: config.neo.apiToken }) },
  { label: 'script-details + session',   path: '/script-details/1.0/masterscrip/file-paths', headers: (s) => ({ Authorization: s.sessionToken }) },
  { label: 'script-details + full set',  path: '/script-details/1.0/masterscrip/file-paths', headers: (s) => ({ Authorization: s.sessionToken, Sid: s.sid, Auth: s.sessionToken, 'neo-fin-key': config.neo.finKey }) },
  { label: 'script-details + api token', path: '/script-details/1.0/masterscrip/file-paths', headers: () => ({ Authorization: config.neo.apiToken }) },
];

const short = (v, n = 400) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s == null ? '(empty)' : s.length > n ? s.slice(0, n) + '…' : s;
};

async function main() {
  await session.load();
  const s = session.session;
  if (!s?.sessionToken) {
    console.error('No Kotak session in the database. Log in at '
      + `${config.appUrl}/brokers first.`);
    process.exit(1);
  }

  const baseUrls = [...new Set([s.baseUrl, config.neo.apiBase].filter(Boolean))];
  console.log('session  :', session.meta.ucc || '(no ucc)', '·', session.meta.status);
  console.log('baseUrls :', baseUrls.join('  '));
  console.log('apiToken :', config.neo.apiToken ? config.neo.apiToken.slice(0, 8) + '…' : '(EMPTY — this alone breaks it)');
  console.log('');

  for (const base of baseUrls) {
    for (const v of VARIANTS) {
      const url = base.replace(/\/+$/, '') + v.path;
      const headers = { accept: 'application/json', ...v.headers(s) };
      let line = `${v.label.padEnd(28)} `;
      try {
        const res = await axios.get(url, { timeout: 20000, headers });
        const paths = res.data?.data?.filesPaths || res.data?.filesPaths || [];
        line += `200  files=${paths.length}`;
        console.log(line);
        if (paths.length) {
          console.log('    WORKS →', url);
          for (const p of paths.slice(0, 8)) console.log('     ', p);
          console.log('');
          return;                     // first success is the answer
        }
        console.log('      body:', short(res.data));
      } catch (err) {
        const r = err.response;
        line += r ? `${r.status}` : `no response (${err.code || err.message})`;
        console.log(line);
        if (r?.data) console.log('      body:', short(r.data));
      }
    }
    console.log('');
  }

  console.log('None of the variants returned a file list.');
  console.log('If every row says 424, the usual causes are:');
  console.log('  * NEO_API_TOKEN is wrong or belongs to a different app than the session');
  console.log('  * the Trade API subscription does not include the scrip master');
  console.log('  * the session is stale — log out and back in, then re-run this');
}

main()
  .catch(err => { console.error('diagnose failed:', err.message); process.exitCode = 1; })
  .finally(() => db.close());
