// The binary tick parser reads prices straight out of a byte buffer, so a
// framing mistake does not throw — it silently produces a WRONG price and the
// strategy acts on it. These tests pin the wire format.

const test = require('node:test');
const assert = require('node:assert/strict');

const { KiteTicker, divisorFor } = require('../src/brokers/zerodha/kiteTicker');

// Build a Kite LTP frame: int16 packetCount, then per packet int16 length,
// int32 token, int32 price-in-paise.
function frame(packets) {
  const chunks = [Buffer.alloc(2)];
  chunks[0].writeInt16BE(packets.length, 0);
  for (const { token, paise } of packets) {
    const b = Buffer.alloc(2 + 8);
    b.writeInt16BE(8, 0);
    b.writeInt32BE(token, 2);
    b.writeInt32BE(paise, 6);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function ticker() {
  const t = new KiteTicker({ apiKey: 'k', accessToken: 'a', label: 'test' });
  t.closed = true;   // never open a socket or start the poller in a test
  return t;
}

test('NFO tokens divide paise by 100', () => {
  assert.equal(divisorFor(12345 * 256 + 2), 100);      // NFO segment
});

test('currency segments use their own divisors', () => {
  assert.equal(divisorFor((1 << 8) | 3), 10000000);    // CDS
  assert.equal(divisorFor((1 << 8) | 6), 10000);       // BCD
});

test('parses a single LTP packet', () => {
  const t = ticker();
  t._onBinary(frame([{ token: 12345 * 256 + 2, paise: 4050 }]));
  assert.equal(t.ltp(String(12345 * 256 + 2)), 40.5);
});

test('parses several packets in one frame', () => {
  const t = ticker();
  const a = 100 * 256 + 2;
  const b = 200 * 256 + 2;
  t._onBinary(frame([{ token: a, paise: 4100 }, { token: b, paise: 1000 }]));
  assert.equal(t.ltp(String(a)), 41);
  assert.equal(t.ltp(String(b)), 10);
});

test('a heartbeat frame is ignored, not misread as a price', () => {
  const t = ticker();
  t._onBinary(Buffer.alloc(1));
  assert.equal(t.prices.size, 0);
});

test('a truncated frame stops parsing instead of reading past the buffer', () => {
  const t = ticker();
  const good = frame([{ token: 100 * 256 + 2, paise: 4100 }]);
  // Claim two packets but supply one.
  const lying = Buffer.concat([Buffer.from([0, 2]), good.subarray(2)]);
  assert.doesNotThrow(() => t._onBinary(lying));
  assert.equal(t.prices.size, 1, 'the one complete packet is still read');
});

test('a packet shorter than 8 bytes is discarded', () => {
  const t = ticker();
  const b = Buffer.alloc(2 + 2 + 4);
  b.writeInt16BE(1, 0);
  b.writeInt16BE(4, 2);          // impossible length for an LTP packet
  b.writeInt32BE(999, 4);
  t._onBinary(b);
  assert.equal(t.prices.size, 0);
});

test('quotes carry an age so callers can refuse stale prices', () => {
  const t = ticker();
  const token = 100 * 256 + 2;
  t._onBinary(frame([{ token, paise: 4100 }]));
  const q = t.quote(String(token));
  assert.equal(q.ltp, 41);
  assert.ok(q.ageMs >= 0 && q.ageMs < 1000);
  assert.equal(q.source, 'ws');
});

test('an unseen token quotes as null rather than zero', () => {
  const t = ticker();
  assert.equal(t.ltp('404'), null);
  assert.equal(t.quote('404'), null);
});

test('a tick event fires only when the price actually changes', () => {
  const t = ticker();
  const token = 100 * 256 + 2;
  let events = 0;
  t.on('tick', () => { events += 1; });

  t._onBinary(frame([{ token, paise: 4100 }]));
  t._onBinary(frame([{ token, paise: 4100 }]));   // same price
  t._onBinary(frame([{ token, paise: 4150 }]));   // changed
  assert.equal(events, 2);
});

test('setSubscriptions diffs rather than resubscribing everything', () => {
  const t = ticker();
  t.subscribe(['1', '2', '3']);
  const r = t.setSubscriptions(['2', '3', '4']);
  assert.deepEqual(r, { added: 1, removed: 1, total: 3 });
  assert.deepEqual([...t.subscriptions].sort(), ['2', '3', '4']);
});

test('dropping a subscription drops its cached price too', () => {
  const t = ticker();
  const token = 100 * 256 + 2;
  t.subscribe([String(token)]);
  t._onBinary(frame([{ token, paise: 4100 }]));
  t.unsubscribe([String(token)]);
  assert.equal(t.ltp(String(token)), null, 'a stale price must not outlive its subscription');
});

test('a feed with no frames is not healthy', () => {
  assert.equal(ticker().isHealthy(), false);
});
