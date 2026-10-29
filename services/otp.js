/**
 * Service OTP (One-Time Password) via WhatsApp untuk Login Portal Pelanggan.
 * - Kode 6 digit, berlaku 5 menit, disimpan dalam bentuk hash (SHA-256 + salt)
 * - Maksimal 5x salah input per kode, jeda kirim ulang 60 detik
 * - Batas permintaan: 5 kode / jam per nomor, 10 kode / jam per IP
 */

const crypto = require('crypto');

const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
const MAX_REQUEST_PER_PHONE_HOUR = 5;
const MAX_REQUEST_PER_IP_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

const otpStore = new Map();      // phone -> { hash, salt, expiresAt, attempts, lastSentAt }
const phoneRequests = new Map(); // phone -> [timestamp, ...]
const ipRequests = new Map();    // ip -> [timestamp, ...]

/**
 * Normalisasi nomor telepon ke format 62xxxxxxxxxx
 */
function normalizePhone(phone) {
    let p = String(phone || '').replace(/[^0-9]/g, '');
    if (!p) return '';
    if (p.startsWith('0')) p = '62' + p.substring(1);
    else if (p.startsWith('8')) p = '62' + p;
    return p;
}

function hashOtp(code, salt) {
    return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

function pruneWindow(list) {
    const now = Date.now();
    return (list || []).filter(ts => now - ts < HOUR_MS);
}

function generateCode() {
    return String(crypto.randomInt(0, Math.pow(10, OTP_LENGTH))).padStart(OTP_LENGTH, '0');
}

/**
 * Buat OTP baru untuk nomor tertentu. Mengembalikan { ok, code?, error?, retryAfterSec? }
 */
function createOtp(phone, ip) {
    const key = normalizePhone(phone);
    const now = Date.now();

    const existing = otpStore.get(key);
    if (existing && now - existing.lastSentAt < RESEND_COOLDOWN_MS) {
        const retryAfterSec = Math.ceil((RESEND_COOLDOWN_MS - (now - existing.lastSentAt)) / 1000);
        return { ok: false, error: `Mohon tunggu ${retryAfterSec} detik sebelum meminta kode baru.`, retryAfterSec };
    }

    const phoneList = pruneWindow(phoneRequests.get(key));
    if (phoneList.length >= MAX_REQUEST_PER_PHONE_HOUR) {
        return { ok: false, error: 'Terlalu banyak permintaan kode OTP untuk nomor ini. Coba lagi dalam 1 jam.' };
    }
    const ipKey = ip || 'unknown';
    const ipList = pruneWindow(ipRequests.get(ipKey));
    if (ipList.length >= MAX_REQUEST_PER_IP_HOUR) {
        return { ok: false, error: 'Terlalu banyak permintaan kode OTP dari perangkat ini. Coba lagi dalam 1 jam.' };
    }

    const code = generateCode();
    const salt = crypto.randomBytes(8).toString('hex');
    otpStore.set(key, {
        hash: hashOtp(code, salt),
        salt,
        expiresAt: now + OTP_TTL_MS,
        attempts: 0,
        lastSentAt: now
    });

    phoneList.push(now);
    phoneRequests.set(key, phoneList);
    ipList.push(now);
    ipRequests.set(ipKey, ipList);

    return { ok: true, code, expiresInSec: OTP_TTL_MS / 1000, cooldownSec: RESEND_COOLDOWN_MS / 1000 };
}

/**
 * Batalkan OTP (misal pengiriman WhatsApp gagal) agar tidak menghitung cooldown
 */
function discardOtp(phone) {
    otpStore.delete(normalizePhone(phone));
}

/**
 * Verifikasi kode OTP. Mengembalikan { ok, error? }
 */
function verifyOtp(phone, code) {
    const key = normalizePhone(phone);
    const entry = otpStore.get(key);
    const input = String(code || '').replace(/[^0-9]/g, '');

    if (!entry) {
        return { ok: false, error: 'Kode OTP tidak ditemukan atau sudah kedaluwarsa. Silakan minta kode baru.' };
    }
    if (Date.now() > entry.expiresAt) {
        otpStore.delete(key);
        return { ok: false, error: 'Kode OTP sudah kedaluwarsa. Silakan minta kode baru.' };
    }
    if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
        otpStore.delete(key);
        return { ok: false, error: 'Terlalu banyak percobaan salah. Silakan minta kode OTP baru.' };
    }

    entry.attempts += 1;

    const expected = Buffer.from(entry.hash, 'hex');
    const actual = Buffer.from(hashOtp(input, entry.salt), 'hex');
    const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

    if (!match) {
        const left = MAX_VERIFY_ATTEMPTS - entry.attempts;
        if (left <= 0) {
            otpStore.delete(key);
            return { ok: false, error: 'Kode OTP salah. Batas percobaan habis, silakan minta kode baru.' };
        }
        return { ok: false, error: `Kode OTP salah. Sisa percobaan: ${left}x.` };
    }

    otpStore.delete(key); // sekali pakai
    return { ok: true };
}

// Bersihkan data kedaluwarsa secara berkala
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of otpStore.entries()) {
        if (now > v.expiresAt + 60 * 1000) otpStore.delete(k);
    }
    for (const [k, list] of phoneRequests.entries()) {
        const l = pruneWindow(list);
        if (l.length === 0) phoneRequests.delete(k); else phoneRequests.set(k, l);
    }
    for (const [k, list] of ipRequests.entries()) {
        const l = pruneWindow(list);
        if (l.length === 0) ipRequests.delete(k); else ipRequests.set(k, l);
    }
}, 10 * 60 * 1000).unref();

module.exports = {
    normalizePhone,
    createOtp,
    discardOtp,
    verifyOtp,
    OTP_TTL_MS,
    RESEND_COOLDOWN_MS
};
