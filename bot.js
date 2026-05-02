const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fetch = require('node-fetch');
const fs = require('fs');

// ─── KONFIGURASI ─────────────────────────────────────────────────────────────
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

// Nomor WA admin yang boleh forward form (format: 628xxx@s.whatsapp.net)
// Kosongkan array untuk allow semua nomor
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
// Format yang diharapkan (case-insensitive, spasi fleksibel di sekitar ':'):
//   Nama : xxx
//   No. WA : xxx
//   Paket Foto : xxx
//   Tanggal Foto : xxx
//   Jenis acara : xxx
//   Lokasi acara : xxx
//   Nama Instagram: xxx
//   Jumlah DP/LUNAS : xxx

function parseFormBooking(text) {
  const get = (pattern) => {
    const m = text.match(new RegExp(pattern + '\\s*:\\s*(.+)', 'i'));
    return m ? m[1].trim() : null;
  };

  const nama        = get('Nama(?!\\s+Instagram)');
  const noWa        = get('No\\.?\\s*WA');
  const paket       = get('Paket\\s*Foto');
  const tglFoto     = get('Tanggal\\s*Foto');
  const jenisAcara  = get('Jenis\\s*acara');
  const lokasi      = get('Lokasi\\s*acara');
  const instagram   = get('Nama\\s*Instagram');
  const dp          = get('Jumlah\\s*DP\\/LUNAS');

  // Wajib minimal: nama dan nomor WA
  if (!nama || !noWa) return null;

  // Konversi tanggal Indonesia ke format YYYY-MM-DD
  const shootDate = parseIndonesianDate(tglFoto);

  return {
    name:        nama,
    phone:       noWa.replace(/[^0-9+]/g, ''),
    session_type: jenisAcara || 'Wisuda',
    package:     paket || '-',
    shoot_date:  shootDate || null,
    notes:       [
      lokasi    ? `Lokasi: ${lokasi}`       : null,
      instagram ? `Instagram: ${instagram}` : null,
      dp        ? `DP/Lunas: ${dp}`         : null,
    ].filter(Boolean).join(' | ') || null,
    stage_index: 0,
    created_at:  new Date().toISOString(),
  };
}

// Konversi "20 mei 2026" → "2026-05-20"
function parseIndonesianDate(str) {
  if (!str) return null;
  const bulan = {
    januari:1, februari:2, maret:3, april:4, mei:5, juni:6,
    juli:7, agustus:8, september:9, oktober:10, november:11, desember:12
  };
  const m = str.trim().match(/(\d{1,2})\s+(\w+)\s+(\d{4})/i);
  if (!m) return null;
  const day  = m[1].padStart(2, '0');
  const mon  = bulan[m[2].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2,'0')}-${day}`;
}

// Cek apakah pesan berisi form booking
function isBookingForm(text) {
  return /Form\s*Booking/i.test(text) &&
         /Nama\s*:/i.test(text) &&
         /No\.?\s*WA\s*:/i.test(text);
}

// ─── BOT UTAMA ───────────────────────────────────────────────────────────────
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }), // ganti 'info' untuk debug lengkap
    printQRInTerminal: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('⚠️  Koneksi terputus, kode:', code, '— reconnect:', shouldReconnect);
      if (shouldReconnect) setTimeout(startBot, 5000);
    } else if (connection === 'open') {
      console.log('✅ LensEra Bot terhubung ke WhatsApp!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Skip pesan dari diri sendiri
      if (msg.key.fromMe) continue;

      const from    = msg.key.remoteJid;
      const sender  = msg.key.participant || from; // participant untuk grup
      const senderNum = sender.replace('@s.whatsapp.net', '');

      // Cek apakah pengirim adalah admin yang diizinkan
      if (ALLOWED_ADMINS.length > 0 && !ALLOWED_ADMINS.includes(senderNum)) {
        continue;
      }

      // Ambil teks pesan (support teks biasa dan caption gambar)
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '';

      if (!text) continue;

      // Cek apakah ini form booking
      if (!isBookingForm(text)) continue;

      console.log(`📩 Form booking diterima dari ${senderNum}`);

      // Parse form
      const booking = parseFormBooking(text);

      if (!booking) {
        await sock.sendMessage(from, {
          text: '❌ *Gagal parse form booking.*\n\nPastikan format lengkap:\n- Nama :\n- No. WA :\n- Paket Foto :\n- Tanggal Foto :\n- Jenis acara :'
        }, { quoted: msg });
        continue;
      }

      // Insert ke Supabase
      try {
        const result = await insertBooking(booking);
        await addLog(`[BOT] Booking baru via WA: ${booking.name} (${booking.phone})`);

        const replyText =
          `✅ *Booking berhasil disimpan ke LensEra!*\n\n` +
          `👤 *Client:* ${booking.name}\n` +
          `📱 *WA:* ${booking.phone}\n` +
          `📦 *Paket:* ${booking.package}\n` +
          `📅 *Tanggal Foto:* ${booking.shoot_date || tglFotoRaw(text)}\n` +
          `🎭 *Jenis:* ${booking.session_type}\n\n` +
          `_Data sudah masuk ke workflow LensEra Studio_ 🎉`;

        await sock.sendMessage(from, { text: replyText }, { quoted: msg });
        console.log(`✅ Booking ${booking.name} berhasil disimpan`);

      } catch (err) {
        console.error('❌ Error Supabase:', err.message);
        await sock.sendMessage(from, {
          text: `❌ *Gagal simpan ke database.*\n\nError: ${err.message}\n\nCek koneksi Supabase atau hubungi developer.`
        }, { quoted: msg });
      }
    }
  });
}

function tglFotoRaw(text) {
  const m = text.match(/Tanggal\s*Foto\s*:\s*(.+)/i);
  return m ? m[1].trim() : '-';
}

startBot().catch(console.error);
