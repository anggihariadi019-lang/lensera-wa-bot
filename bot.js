const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fetch = require('node-fetch');

// ─── KONFIGURASI ─────────────────────────────────────────────────────────────
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const ALLOWED_ADMINS = (process.env.ALLOWED_ADMINS || '').split(',').filter(Boolean);

// ─── SUPABASE HELPER ─────────────────────────────────────────────────────────
const SB_HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SB_KEY,
  'Authorization': 'Bearer ' + SB_KEY,
};

async function insertBooking(data) {
  const res = await fetch(`${SB_URL}/rest/v1/bookings`, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Prefer': 'return=representation' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function addLog(msg) {
  try {
    await fetch(`${SB_URL}/rest/v1/activity_logs`, {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Prefer': 'return=representation' },
      body: JSON.stringify({ message: msg }),
    });
  } catch (e) {}
}

// ─── PARSER FORM WA ──────────────────────────────────────────────────────────
function parseFormBooking(text) {
  const get = (pattern) => {
    const m = text.match(new RegExp(pattern + '\\s*:\\s*(.+)', 'i'));
    return m ? m[1].trim() : null;
  };

  const nama       = get('Nama(?!\\s+Instagram)');
  const noWa       = get('No\\.?\\s*WA');
  const paket      = get('Paket\\s*Foto');
  const tglFoto    = get('Tanggal\\s*Foto');
  const jenisAcara = get('Jenis\\s*acara');
  const lokasi     = get('Lokasi\\s*acara');
  const instagram  = get('Nama\\s*Instagram');
  const dp         = get('Jumlah\\s*DP\\/LUNAS');

  if (!nama || !noWa) return null;

  return {
    name:         nama,
    phone:        noWa.replace(/[^0-9+]/g, ''),
    session_type: jenisAcara || 'Lainnya',
    package:      paket || '-',
    shoot_date:   parseIndonesianDate(tglFoto),
    notes:        [
      lokasi    ? `Lokasi: ${lokasi}`       : null,
      instagram ? `Instagram: ${instagram}` : null,
      dp        ? `DP/Lunas: ${dp}`         : null,
    ].filter(Boolean).join(' | ') || null,
    stage_index:  0,
    created_at:   new Date().toISOString(),
  };
}

function parseIndonesianDate(str) {
  if (!str) return null;
  const bulan = {
    januari:1,februari:2,maret:3,april:4,mei:5,juni:6,
    juli:7,agustus:8,september:9,oktober:10,november:11,desember:12
  };
  const m = str.trim().match(/(\d{1,2})\s+(\w+)\s+(\d{4})/i);
  if (!m) return null;
  const mon = bulan[m[2].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
}

function isBookingForm(text) {
  return /Form\s*Booking/i.test(text) &&
         /Nama\s*:/i.test(text) &&
         /No\.?\s*WA\s*:/i.test(text);
}

// ─── BOT UTAMA ───────────────────────────────────────────────────────────────
function createClient() {
  return new Client({
    authStrategy: new LocalAuth({ dataPath: './auth_data' }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
      ],
    },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
  });
}

let client = createClient();
let isRestarting = false;

function attachEvents(c) {

  c.on('qr', (qr) => {
    console.log('\n📱 QR CODE — Scan pakai WhatsApp kamu:\n');
    qrcode.generate(qr, { small: true });
    console.log('\n(Buka WA → titik tiga → Linked Devices → Link a Device)\n');
  });

  c.on('authenticated', () => {
    console.log('🔐 Autentikasi berhasil!');
  });

  c.on('auth_failure', (msg) => {
    console.error('❌ Autentikasi gagal:', msg);
    scheduleRestart();
  });

  c.on('ready', () => {
    isRestarting = false;
    console.log('✅ LensEra Bot siap! Menunggu form booking...');
  });

  c.on('disconnected', (reason) => {
    console.log('⚠️  Bot disconnect:', reason);
    scheduleRestart();
  });

  c.on('message', async (msg) => {
    const text = msg.body || '';
    if (!isBookingForm(text)) return;

    const senderNum = msg.from.replace('@c.us', '').replace('@g.us', '');
    if (ALLOWED_ADMINS.length > 0 && !ALLOWED_ADMINS.includes(senderNum)) return;

    console.log(`📩 Form booking diterima dari ${senderNum}`);

    const booking = parseFormBooking(text);

    if (!booking) {
      await msg.reply(
        '❌ *Gagal parse form booking.*\n\n' +
        'Pastikan format lengkap:\n' +
        '- Nama :\n- No. WA :\n- Paket Foto :\n- Tanggal Foto :\n- Jenis acara :'
      );
      return;
    }

    try {
      await insertBooking(booking);
      await addLog(`[BOT] Booking baru via WA: ${booking.name} (${booking.phone})`);

      const tglRaw = text.match(/Tanggal\s*Foto\s*:\s*(.+)/i)?.[1]?.trim() || '-';

      await msg.reply(
        `✅ *Booking berhasil disimpan ke LensEra!*\n\n` +
        `👤 *Client:* ${booking.name}\n` +
        `📱 *WA:* ${booking.phone}\n` +
        `📦 *Paket:* ${booking.package}\n` +
        `📅 *Tanggal Foto:* ${tglRaw}\n` +
        `🎭 *Jenis:* ${booking.session_type}\n\n` +
        `_Data sudah masuk ke workflow LensEra Studio_ 🎉`
      );

      console.log(`✅ Booking "${booking.name}" berhasil disimpan`);

    } catch (err) {
      console.error('❌ Error:', err.message);
      await msg.reply(`❌ *Gagal simpan ke database.*\n\nError: ${err.message}`);
    }
  });
}

function scheduleRestart() {
  if (isRestarting) return;
  isRestarting = true;
  console.log('🔄 Restart dalam 10 detik...');
  setTimeout(async () => {
    try { await client.destroy(); } catch(e) {}
    client = createClient();
    attachEvents(client);
    await client.initialize();
  }, 10000);
}

console.log('🚀 Memulai LensEra WA Bot...');
attachEvents(client);
client.initialize().catch(err => {
  console.error('❌ Init error:', err.message);
  scheduleRestart();
});
