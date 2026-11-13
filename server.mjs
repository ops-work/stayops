import http from 'node:http';
import {readFile, writeFile, mkdir, rename} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {lookup} from 'node:dns/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import {randomUUID} from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const stateFile = path.join(dataDir, 'state.json');
const port = Number(process.env.PORT || 3000);
const maxStateBytes = 8 * 1024 * 1024;
const maxIcalBytes = 5 * 1024 * 1024;
const syncIntervalMs = Number(process.env.ICAL_SYNC_INTERVAL_MS || 10 * 60 * 1000);
let syncRunning = false;
let syncTimer = null;
let lastSync = null;

await mkdir(dataDir, {recursive:true});

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(body);
}

async function readState() {
  try { return JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function saveState(value) {
  const temp = stateFile + '.tmp';
  await writeFile(temp, JSON.stringify(value), {encoding:'utf8',mode:0o600});
  await rename(temp, stateFile);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxStateBytes) throw Object.assign(new Error('payload too large'), {status:413});
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function privateAddress(address) {
  if (net.isIPv4(address)) {
    const [a,b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const value = address.toLowerCase();
  return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:') || value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.');
}

async function validateRemoteUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw Object.assign(new Error('only https iCal links are allowed'), {status:400});
  if (url.username || url.password || url.port) throw Object.assign(new Error('invalid iCal URL'), {status:400});
  const addresses = await lookup(url.hostname, {all:true});
  if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw Object.assign(new Error('private network address is not allowed'), {status:400});
  return url;
}

async function fetchIcal(raw) {
  let url = await validateRemoteUrl(raw);
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try { response = await fetch(url, {signal:controller.signal,redirect:'manual',headers:{'user-agent':'StayOps-Calendar-Sync/1.0','accept':'text/calendar,text/plain;q=0.9,*/*;q=0.1'}}); }
    finally { clearTimeout(timer); }
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw Object.assign(new Error('invalid redirect'), {status:502});
      url = await validateRemoteUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw Object.assign(new Error('calendar server returned ' + response.status), {status:502});
    const length = Number(response.headers.get('content-length') || 0);
    if (length > maxIcalBytes) throw Object.assign(new Error('calendar is too large'), {status:413});
    const text = await response.text();
    if (Buffer.byteLength(text) > maxIcalBytes) throw Object.assign(new Error('calendar is too large'), {status:413});
    if (!text.includes('BEGIN:VCALENDAR')) throw Object.assign(new Error('URL did not return an iCalendar file'), {status:422});
    return text;
  }
  throw Object.assign(new Error('too many redirects'), {status:502});
}

function parseIcalDate(value = '') {
  const digits = String(value).replace(/[^0-9]/g, '');
  return digits.length >= 8 ? `${digits.slice(0,4)}-${digits.slice(4,6)}-${digits.slice(6,8)}` : '';
}

function parseIcal(text, roomId, source, existingByUid) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') current = {};
    else if (line === 'END:VEVENT' && current) { blocks.push(current); current = null; }
    else if (current) {
      const index = line.indexOf(':');
      if (index > 0) current[line.slice(0,index).split(';')[0].toUpperCase()] = line.slice(index + 1).trim();
    }
  }
  return blocks.map(block => {
    const checkIn = parseIcalDate(block.DTSTART);
    const checkOut = parseIcalDate(block.DTEND);
    if (!checkIn || !checkOut || checkIn >= checkOut) return null;
    const uid = block.UID || `${roomId}-${source}-${checkIn}-${checkOut}`;
    const previous = existingByUid.get(uid);
    return {id:previous?.id || `stay-${randomUUID()}`,roomId,source,guest:'',checkIn,checkOut,uid};
  }).filter(Boolean);
}

async function syncAllCalendars() {
  if (syncRunning) return;
  syncRunning = true;
  let successful = 0;
  let failed = 0;
  try {
    const state = await readState();
    if (!state?.rooms || !Array.isArray(state.reservations)) return;
    const today = new Date().toISOString().slice(0,10);
    const existingByUid = new Map(state.reservations.map(stay => [stay.uid, stay]));
    let reservations = [...state.reservations];
    for (const room of state.rooms) {
      const calendars = Array.isArray(room.calendars) ? room.calendars : [];
      for (const calendar of calendars) {
        const source = calendar.id || calendar.name;
        const calendarUrl = calendar.ical || calendar.url;
        if (!source || !calendarUrl) continue;
        try {
          const imported = parseIcal(await fetchIcal(calendarUrl), room.id, source, existingByUid);
          reservations = reservations.filter(stay => !(stay.roomId === room.id && stay.source === source && stay.checkOut >= today));
          reservations.push(...imported.filter(stay => stay.checkOut >= today));
          imported.forEach(stay => existingByUid.set(stay.uid, stay));
          successful += 1;
        } catch (error) {
          failed += 1;
          console.warn(`iCal sync failed for ${room.name || room.id}/${calendar.name || source}: ${error.message}`);
        }
      }
    }
    state.reservations = reservations;
    await saveState(state);
    lastSync = {at:new Date().toISOString(),successful,failed};
  } finally {
    syncRunning = false;
  }
}

function scheduleSync(delay = 1000) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncAllCalendars().catch(console.error), delay);
  syncTimer.unref?.();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/health' && req.method === 'GET') return send(res, 200, JSON.stringify({ok:true,syncRunning,lastSync}));
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, JSON.stringify(await readState()));
    if (url.pathname === '/api/state' && req.method === 'PUT') {
      const body = await readJson(req);
      if (!body || !Array.isArray(body.rooms) || !Array.isArray(body.reservations)) return send(res, 400, JSON.stringify({error:'invalid state'}));
      await saveState(body);
      scheduleSync();
      return send(res, 200, JSON.stringify({ok:true,savedAt:new Date().toISOString()}));
    }
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      await syncAllCalendars();
      return send(res, 200, JSON.stringify({ok:true,lastSync}));
    }
    if (url.pathname === '/api/ical' && req.method === 'GET') {
      const source = url.searchParams.get('url');
      if (!source) return send(res, 400, JSON.stringify({error:'missing url'}));
      return send(res, 200, await fetchIcal(source), 'text/calendar; charset=utf-8');
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-cache'});
      return createReadStream(path.join(root, 'index.html')).pipe(res);
    }
    return send(res, 404, JSON.stringify({error:'not found'}));
  } catch (error) {
    const status = Number(error.status || 500);
    send(res, status, JSON.stringify({error:status === 500 ? 'server error' : error.message}));
    if (status === 500) console.error(error);
  }
});

server.listen(port, '0.0.0.0', () => console.log(`StayOps listening on http://0.0.0.0:${port}`));
const periodicSync = setInterval(() => syncAllCalendars().catch(console.error), syncIntervalMs);
periodicSync.unref?.();
scheduleSync(1500);
