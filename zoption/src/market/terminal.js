// The one terminal feed this process owns.
//
// A singleton for the same reason the broker session is one: the HTTP handlers
// and the socket server must be looking at the same subscriptions, the same
// filter probe and the same viewer count. Two feeds would open two market-data
// sockets and poll the chain twice against a rate limit shared with order
// placement.
//
// Kept in its own file so `TerminalFeed` itself stays constructible in a test
// without dragging in a live broker session.

const session = require('../broker/neoSession');
const { TerminalFeed } = require('./terminalFeed');

module.exports = new TerminalFeed({ session });
