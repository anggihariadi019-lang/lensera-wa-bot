const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

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
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Supabase error: ' + err);
  }
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

  const shootDate = parseIndonesianDate(tglFoto);

  return {
    name:         nama,
    phone:        noWa.replace(/[^0-9+]/g, ''),
    session_type: jenisAcara || 'Lainnya',
    package:      paket || '-',
    shoot_date:   shootDate || null,
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
let retryCount = 0;

async function startBot() {
  console.log('🚀 Memulai LensEra WA Bot...');

  const authDir = path.join(process.cwd(), 'auth_info');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
    console.log('📦 Baileys version:', version.join('.'));
  } catch(e) {
    version = [2, 3000, 1015901307];
    console.log('📦 Menggunakan versi fallback Baileys');
  }

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: true,
    browser: ['LensEra Bot', 'Chrome', '1.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    retryRequestDelayMs: 2000,
    maxMsgRetryCount: 3,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('📱 QR CODE MUNCUL — Scan dengan WhatsApp kamu sekarang!');
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`⚠️  Koneksi terputus. Kode: ${statusCode}`);

      if (isLoggedOut) {
        console.log('🔴 Logged out! Menghapus sesi lama...');
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
        setTimeout(startBot, 3000);
      } else {
        retryCount++;
        const delay = Math.min(retryCount * 3000, 30000);
        console.log(`🔄 Reconnect ke-${retryCount} dalam ${delay/1000} detik...`);
        setTimeout(startBot, delay);
      }
    }

    if (connection === 'open') {
      retryCount = 0;
      console.log('✅ LensEra Bot terhubung ke WhatsApp!');
      console.log('👂 Menunggu form booking...');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const from      = msg.key.remoteJid;
      const sender    = msg.key.participant || from;
      const senderNum = sender.replace('@s.whatsapp.net', '').replace('@g.us', '');

      if (ALLOWED_ADMINS.length > 0 && !ALLOWED_ADMINS.includes(senderNum)) continue;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '';

      if (!text || !isBookingForm(text)) continue;

      console.log(`📩 Form booking diterima dari ${senderNum}`);

      const booking = parseFormBooking(text);

      if (!booking) {
        await sock.sendMessage(from, {
          text: '❌ *Gagal parse form booking.*\n\nPastikan format lengkap:\n- Nama :\n- No. WA :\n- Paket Foto :\n- Tanggal Foto :\n- Jenis acara :'
        }, { quoted: msg });
        continue;
      }

      try {
        await insertBooking(booking);
        await addLog(`[BOT] Booking baru via WA: ${booking.name} (${booking.phone})`);

        const tglRaw = text.match(/Tanggal\s*Foto\s*:\s*(.+)/i)?.[1]?.trim() || '-';

        await sock.sendMessage(from, {
          text:
            `✅ *Booking berhasil disimpan ke LensEra!*\n\n` +
            `👤 *Client:* ${booking.name}\n` +
            `📱 *WA:* ${booking.phone}\n` +
            `📦 *Paket:* ${booking.package}\n` +
            `📅 *Tanggal Foto:* ${tglRaw}\n` +
            `🎭 *Jenis:* ${booking.session_type}\n\n` +
            `_Data sudah masuk ke workflow LensEra Studio_ 🎉`
        }, { quoted: msg });

        console.log(`✅ Booking "${booking.name}" berhasil disimpan`);

      } catch (err) {
        console.error('❌ Error Supabase:', err.message);
        await sock.sendMessage(from, {
          text: `❌ *Gagal simpan ke database.*\n\nError: ${err.message}`
        }, { quoted: msg });
      }
    }
  });
}

startBot().catch(err => {
  console.error('❌ Fatal error:', err);
  setTimeout(startBot, 5000);
});
