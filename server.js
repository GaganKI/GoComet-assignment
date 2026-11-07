const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, 'auction.db'));
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TRIGGERS = ['BID_RECEIVED', 'ANY_RANK_CHANGE', 'L1_CHANGE'];
const iso = d => new Date(d).toISOString();
const valid = d => !isNaN(new Date(d).getTime());
const num = v => (v !== '' && v !== null && !isNaN(Number(v)) && Number(v) >= 0) ? Number(v) : null;

// Latest bid per carrier, sorted by price (index 0 = L1)
function ranking(rfqId) {
  return db.prepare(`
    SELECT b.* FROM bids b
    WHERE b.rfq_id = ? AND b.id = (SELECT MAX(id) FROM bids WHERE rfq_id = b.rfq_id AND carrier = b.carrier)
    ORDER BY b.total ASC, b.id ASC`).all(rfqId)
    .map((b, i) => ({ ...b, rank: 'L' + (i + 1) }));
}

function status(r, now = new Date()) {
  if (now < new Date(r.bid_start)) return 'Upcoming';
  if (now < new Date(r.bid_close)) return 'Active';
  return r.bid_close === r.forced_close ? 'Force Closed' : 'Closed';
}

const log = (rfqId, type, message, oldC = null, newC = null) =>
  db.prepare('INSERT INTO activity_log (rfq_id,type,message,old_close,new_close,created_at) VALUES (?,?,?,?,?,?)')
    .run(rfqId, type, message, oldC, newC, iso(new Date()));

// ---- Create RFQ
app.post('/api/rfqs', (req, res) => {
  const b = req.body, errs = [];
  if (!b.reference?.trim()) errs.push('RFQ reference is required');
  if (!b.name?.trim()) errs.push('RFQ name is required');
  for (const f of ['bid_start', 'bid_close', 'forced_close', 'pickup_date'])
    if (!b[f] || !valid(b[f])) errs.push(`${f} is invalid`);
  if (!errs.length) {
    if (new Date(b.bid_close) <= new Date(b.bid_start)) errs.push('Bid close must be after bid start');
    if (new Date(b.forced_close) <= new Date(b.bid_close)) errs.push('Forced close must be later than bid close');
  }
  const X = parseInt(b.trigger_window_min), Y = parseInt(b.extension_min);
  if (!(X > 0)) errs.push('Trigger window (X) must be a positive number');
  if (!(Y > 0)) errs.push('Extension duration (Y) must be a positive number');
  if (!TRIGGERS.includes(b.trigger_type)) errs.push('Invalid extension trigger');
  if (errs.length) return res.status(400).json({ errors: errs });
  try {
    const info = db.prepare(`INSERT INTO rfqs (reference,name,bid_start,original_close,bid_close,forced_close,pickup_date,trigger_window_min,extension_min,trigger_type)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(b.reference.trim(), b.name.trim(), iso(b.bid_start), iso(b.bid_close), iso(b.bid_close),
      iso(b.forced_close), iso(b.pickup_date), X, Y, b.trigger_type);
    log(info.lastInsertRowid, 'RFQ_CREATED', `RFQ created (${b.trigger_type}, X=${X}m, Y=${Y}m)`);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ errors: [e.message.includes('UNIQUE') ? 'Reference ID already exists' : e.message] });
  }
});

// ---- List
app.get('/api/rfqs', (req, res) => {
  const rows = db.prepare('SELECT * FROM rfqs ORDER BY id DESC').all().map(r => {
    const l1 = ranking(r.id)[0];
    return { ...r, lowest_bid: l1 ? l1.total : null, status: status(r) };
  });
  res.json(rows);
});

// ---- Details
app.get('/api/rfqs/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM rfqs WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ errors: ['RFQ not found'] });
  res.json({
    rfq: { ...r, status: status(r) },
    ranking: ranking(r.id),
    bids: db.prepare('SELECT * FROM bids WHERE rfq_id=? ORDER BY total ASC, id ASC').all(r.id),
    activity: db.prepare('SELECT * FROM activity_log WHERE rfq_id=? ORDER BY id DESC').all(r.id),
    server_time: iso(new Date())
  });
});

// ---- Submit bid (atomic: validate -> insert -> evaluate extension)
const submitBid = db.transaction((id, b) => {
  const r = db.prepare('SELECT * FROM rfqs WHERE id=?').get(id);
  if (!r) throw { code: 404, errors: ['RFQ not found'] };
  const now = new Date();
  const st = status(r, now);
  if (st !== 'Active') throw { code: 400, errors: [`Bidding is not open (status: ${st})`] };

  const f = num(b.freight), o = num(b.origin_charges), d = num(b.destination_charges), t = parseInt(b.transit_days);
  const errs = [];
  if (!b.carrier?.trim()) errs.push('Carrier name is required');
  if (f === null || o === null || d === null) errs.push('Freight, origin and destination charges must be non-negative numbers');
  if (!(t > 0)) errs.push('Transit time (days) must be positive');
  if (!b.quote_validity || !valid(b.quote_validity)) errs.push('Quote validity date is invalid');
  if (errs.length) throw { code: 400, errors: errs };

  const total = f + o + d, carrier = b.carrier.trim();
  const mine = ranking(id).find(x => x.carrier.toLowerCase() === carrier.toLowerCase());
  if (mine && total >= mine.total) throw { code: 400, errors: [`New total (${total}) must be lower than your current bid (${mine.total})`] };

  const before = ranking(id);
  db.prepare(`INSERT INTO bids (rfq_id,carrier,freight,origin_charges,destination_charges,total,transit_days,quote_validity,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, carrier, f, o, d, total, t, iso(b.quote_validity), iso(now));
  const after = ranking(id);
  log(id, 'BID', `${carrier} bid ${total.toFixed(2)} (now ${after.find(x => x.carrier === carrier).rank})`);

  // --- Extension logic
  const closeMs = new Date(r.bid_close).getTime();
  const inWindow = now.getTime() >= closeMs - r.trigger_window_min * 60000;
  let reason = null;
  if (inWindow) {
    const order = a => a.map(x => x.carrier).join('>');
    if (r.trigger_type === 'BID_RECEIVED') reason = `Bid received in last ${r.trigger_window_min} min`;
    else if (r.trigger_type === 'ANY_RANK_CHANGE' && order(before) !== order(after))
      reason = `Supplier rank changed in last ${r.trigger_window_min} min`;
    else if (r.trigger_type === 'L1_CHANGE' && before[0]?.carrier !== after[0].carrier)
      reason = `L1 changed to ${after[0].carrier} in last ${r.trigger_window_min} min`;
  }
  if (reason) {
    const forcedMs = new Date(r.forced_close).getTime();
    const newMs = Math.min(closeMs + r.extension_min * 60000, forcedMs); // never beyond forced close
    if (newMs > closeMs) {
      const newClose = iso(newMs);
      db.prepare('UPDATE rfqs SET bid_close=? WHERE id=?').run(newClose, id);
      log(id, 'EXTENSION', `${reason}. Extended by ${(newMs - closeMs) / 60000} min` +
        (newMs === forcedMs ? ' (capped at forced close)' : ''), r.bid_close, newClose);
    }
  }
  return { ranking: after };
});

app.post('/api/rfqs/:id/bids', (req, res) => {
  try { res.status(201).json(submitBid(req.params.id, req.body)); }
  catch (e) {
  const code = Number.isInteger(e.code) ? e.code : 500;
  res.status(code).json({ errors: e.errors || [e.message] });
}
});

app.listen(3000, () => console.log('http://localhost:3000'));
