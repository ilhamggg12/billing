// Routes Autentikasi - Pemisahan Ketat Login Pelanggan, Login Admin, dan Login Teknisi
// 1. /login atau /pelanggan       -> Khusus Pelanggan (Nomor WhatsApp + OTP WhatsApp, tanpa password)
// 2. /admin atau /login-admin     -> Khusus Administrator
// 3. /teknisi atau /login-teknisi -> Khusus Teknisi Lapangan

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database/init');
const whatsappService = require('../services/whatsapp');
const otpService = require('../services/otp');

// ============================================
// GET /login, /pelanggan, /admin, /login-admin, /teknisi - Halaman Login
// ============================================
router.get(['/login', '/pelanggan', '/login-pelanggan', '/admin', '/login-admin', '/admin-login', '/teknisi', '/login-teknisi'], (req, res) => {
    // Jika sudah login, arahkan sesuai role aktif
    if (req.session && req.session.user) {
        if (req.session.user.role === 'customer') {
            return res.redirect('/portal');
        }
        if (req.session.user.role === 'technician') {
            return res.redirect('/tickets');
        }
        return res.redirect('/dashboard');
    }

    // Default tampilan awal (/login) adalah Portal Pelanggan
    let loginMode = 'pelanggan';
    if (req.path.includes('teknisi') || req.query.mode === 'teknisi') {
        loginMode = 'teknisi';
    } else if (req.path.includes('admin') || req.query.mode === 'admin') {
        loginMode = 'admin';
    }

    const titleMap = {
        admin: 'Login Administrator - LJN Billing',
        teknisi: 'Portal Login Teknisi - LJN Billing',
        pelanggan: 'Portal Login Pelanggan - LJN Billing'
    };

    res.render('login', {
        title: titleMap[loginMode] || 'Portal Login Pelanggan - LJN Billing',
        loginMode
    });
});

// ============================================
// POST /login - Proses Autentikasi Ketat Sesuai Halaman Portal
// ============================================
router.post('/login', async (req, res) => {
    const { username, password, login_mode } = req.body;
    const mode = (login_mode || 'pelanggan').toLowerCase();

    if (mode === 'pelanggan') {
        req.flash('error', 'Login pelanggan kini menggunakan Nomor WhatsApp dan kode OTP. Silakan masukkan nomor WhatsApp Anda.');
        return res.redirect('/login');
    }

    const redirectFail = mode === 'teknisi'
        ? '/teknisi'
        : (mode === 'admin' ? '/login-admin' : '/login');

    if (!username || !password) {
        req.flash('error', 'ID / Username dan Password wajib diisi.');
        return res.redirect(redirectFail);
    }

    const cleanInput = username.trim();
    const cleanPass = password.trim();

    try {
        // =========================================================================
        // 1. HALAMAN LOGIN PELANGGAN (mode === 'pelanggan')
        // HANYA menerima ID Pelanggan terdaftar. Admin & Teknisi DITOLAK!
        // =========================================================================
        if (mode === 'pelanggan') {
            // Login pelanggan TIDAK lagi memakai ID/password. Wajib via Nomor WhatsApp + OTP.
            req.flash('error', 'Login pelanggan kini menggunakan Nomor WhatsApp dan kode OTP. Silakan masukkan nomor WhatsApp Anda.');
            return res.redirect('/login');
        }

        // =========================================================================
        // 2. HALAMAN LOGIN ADMIN (mode === 'admin')
        // HANYA menerima user dengan role 'admin'. Teknisi & Pelanggan DITOLAK!
        // =========================================================================
        if (mode === 'admin') {
            const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(cleanInput);

            if (!user) {
                req.flash('error', 'Akses ditolak! Akun Administrator tidak ditemukan.');
                return res.redirect('/login-admin');
            }

            const userRole = (user.role || 'admin').toLowerCase();
            if (userRole !== 'admin' && userRole !== 'administrator') {
                req.flash('error', 'Akses ditolak! Halaman login ini khusus untuk Administrator.');
                return res.redirect('/login-admin');
            }

            const isMatch = bcrypt.compareSync(cleanPass, user.password);
            if (!isMatch) {
                req.flash('error', 'Password Administrator salah.');
                return res.redirect('/login-admin');
            }

            req.session.user = {
                id: user.id,
                username: user.username,
                name: user.name,
                role: 'admin'
            };

            db.prepare('INSERT INTO activity_log (action, description, user_id) VALUES (?, ?, ?)')
                .run('login', `Administrator ${user.name} berhasil login`, user.id);

            req.flash('success', `Selamat datang kembali, ${user.name}!`);
            return req.session.save((err) => {
                if (err) console.error('Session save error:', err);
                res.redirect('/dashboard');
            });
        }

        // =========================================================================
        // 3. HALAMAN LOGIN TEKNISI (mode === 'teknisi')
        // HANYA menerima akun Teknisi. Admin & Pelanggan DITOLAK!
        // =========================================================================
        if (mode === 'teknisi') {
            // Cek di tabel technicians berdasarkan username atau nomor WA
            const tech = db.prepare(`
                SELECT * FROM technicians
                WHERE LOWER(username) = LOWER(?) OR phone = ?
                LIMIT 1
            `).get(cleanInput, cleanInput);

            if (tech && tech.password) {
                if (!tech.is_active) {
                    req.flash('error', 'Akun teknisi Anda sedang dinonaktifkan oleh Administrator.');
                    return res.redirect('/teknisi');
                }

                let isTechMatch = false;
                if (tech.password.startsWith('$2a$') || tech.password.startsWith('$2b$')) {
                    isTechMatch = bcrypt.compareSync(cleanPass, tech.password);
                } else {
                    isTechMatch = (cleanPass === tech.password);
                }

                if (!isTechMatch) {
                    req.flash('error', 'Password Teknisi salah.');
                    return res.redirect('/teknisi');
                }

                req.session.user = {
                    id: tech.id,
                    technician_id: tech.id,
                    username: tech.username || tech.phone,
                    name: tech.name,
                    phone: tech.phone,
                    job_title: tech.role || 'Teknisi Lapangan',
                    role: 'technician'
                };

                db.prepare('INSERT INTO activity_log (action, description, user_id) VALUES (?, ?, ?)')
                    .run('login_technician', `Teknisi ${tech.name} berhasil masuk ke Portal Teknisi`, tech.id);

                req.flash('success', `Selamat bertugas, ${tech.name}!`);
                return req.session.save((err) => {
                    if (err) console.error('Session save error:', err);
                    res.redirect('/tickets');
                });
            }

            // Cek juga apakah ada user di tabel users yang khusus ber-role 'technician'
            const techUser = db.prepare("SELECT * FROM users WHERE LOWER(username) = LOWER(?) AND LOWER(role) = 'technician'").get(cleanInput);
            if (techUser) {
                const isMatch = bcrypt.compareSync(cleanPass, techUser.password);
                if (!isMatch) {
                    req.flash('error', 'Password Teknisi salah.');
                    return res.redirect('/teknisi');
                }

                req.session.user = {
                    id: techUser.id,
                    username: techUser.username,
                    name: techUser.name,
                    job_title: 'Teknisi Lapangan',
                    role: 'technician'
                };

                db.prepare('INSERT INTO activity_log (action, description, user_id) VALUES (?, ?, ?)')
                    .run('login_technician', `Teknisi ${techUser.name} berhasil masuk ke Portal Teknisi`, techUser.id);

                req.flash('success', `Selamat bertugas, ${techUser.name}!`);
                return req.session.save((err) => {
                    if (err) console.error('Session save error:', err);
                    res.redirect('/tickets');
                });
            }

            req.flash('error', 'Akses ditolak! Halaman ini khusus untuk Login Teknisi Lapangan.');
            return res.redirect('/teknisi');
        }

        req.flash('error', 'Mode login tidak valid.');
        return res.redirect('/login');

    } catch (error) {
        console.error('[Auth] Error saat login:', error.message);
        req.flash('error', 'Terjadi kesalahan saat proses login');
        return res.redirect(redirectFail);
    }
});

// ============================================
// LOGIN PELANGGAN VIA NOMOR WHATSAPP + OTP
// ============================================

/**
 * Cari semua pelanggan yang terdaftar dengan nomor WhatsApp tertentu
 * (mencocokkan format 08xx / 628xx / +628xx)
 */
function findCustomersByPhone(phone) {
    const target = otpService.normalizePhone(phone);
    if (!target) return [];
    const rows = db.prepare("SELECT * FROM customers WHERE phone IS NOT NULL AND phone != ''").all();
    return rows.filter(c => otpService.normalizePhone(c.phone) === target);
}

/**
 * Buat sesi login pelanggan (regenerate session untuk mencegah session fixation)
 */
function startCustomerSession(req, customer, remember, done) {
    req.session.regenerate((err) => {
        if (err) return done(err);
        req.session.user = {
            id: customer.id,
            customer_id: customer.id,
            customer_code: customer.customer_id,
            username: customer.customer_id,
            name: customer.name,
            phone: customer.phone,
            address: customer.address,
            role: 'customer',
            login_method: 'whatsapp_otp'
        };
        if (remember) {
            req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 hari
        }
        try {
            db.prepare('INSERT INTO activity_log (action, description, user_id) VALUES (?, ?, ?)')
                .run('login_customer', `Pelanggan ${customer.name} (${customer.customer_id}) masuk via OTP WhatsApp`, customer.id);
        } catch (e) { /* abaikan error log */ }
        req.flash('success', `Halo ${customer.name}, selamat datang di Portal Pelanggan!`);
        req.session.save(done);
    });
}

// POST /otp/request - Kirim kode OTP ke WhatsApp pelanggan terdaftar
router.post('/otp/request', async (req, res) => {
    try {
        const phoneInput = (req.body.phone || '').trim();
        const normalized = otpService.normalizePhone(phoneInput);

        if (!normalized || normalized.length < 10 || normalized.length > 15) {
            return res.status(400).json({ success: false, message: 'Nomor WhatsApp tidak valid. Contoh: 081234567890' });
        }

        const customers = findCustomersByPhone(normalized);
        if (customers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Nomor WhatsApp ini tidak terdaftar sebagai pelanggan. Hubungi admin untuk mendaftarkan nomor Anda.'
            });
        }

        if (whatsappService.getStatus() !== 'connected') {
            return res.status(503).json({
                success: false,
                message: 'Layanan WhatsApp sedang tidak tersedia, kode OTP belum dapat dikirim. Silakan coba beberapa saat lagi atau hubungi admin.'
            });
        }

        const otp = otpService.createOtp(normalized, req.ip);
        if (!otp.ok) {
            return res.status(429).json({ success: false, message: otp.error, retryAfterSec: otp.retryAfterSec || null });
        }

        let companyName = 'LJN Billing';
        try {
            const row = db.prepare("SELECT value FROM settings WHERE key = 'company_name'").get();
            if (row && row.value) companyName = row.value;
        } catch (e) { /* default */ }

        const message =
            `🔐 *Kode OTP Login Portal Pelanggan*\n\n` +
            `Kode OTP Anda: *${otp.code}*\n\n` +
            `Berlaku selama ${Math.floor(otp.expiresInSec / 60)} menit.\n` +
            `⚠️ *JANGAN BAGIKAN* kode ini kepada siapa pun, termasuk pihak yang mengaku dari ${companyName}.\n\n` +
            `_${companyName}_`;

        try {
            await whatsappService.sendMessage(normalized, message);
        } catch (sendErr) {
            otpService.discardOtp(normalized);
            console.error('[Auth] Gagal mengirim OTP WhatsApp:', sendErr.message);
            return res.status(502).json({ success: false, message: 'Gagal mengirim kode OTP ke WhatsApp. Pastikan nomor aktif lalu coba lagi.' });
        }

        req.session.pendingOtpPhone = normalized;
        const masked = normalized.length > 7
            ? normalized.substring(0, 4) + '*'.repeat(normalized.length - 7) + normalized.slice(-3)
            : normalized;

        return res.json({
            success: true,
            message: `Kode OTP telah dikirim ke WhatsApp ${masked}`,
            maskedPhone: masked,
            expiresInSec: otp.expiresInSec,
            cooldownSec: otp.cooldownSec
        });
    } catch (error) {
        console.error('[Auth] Error OTP request:', error.message);
        return res.status(500).json({ success: false, message: 'Terjadi kesalahan saat meminta kode OTP.' });
    }
});

// POST /otp/verify - Verifikasi kode OTP lalu masuk ke portal
router.post('/otp/verify', (req, res) => {
    try {
        const phone = req.session.pendingOtpPhone;
        const code = (req.body.code || '').trim();

        if (!phone) {
            return res.status(400).json({ success: false, expired: true, message: 'Sesi OTP tidak ditemukan. Silakan masukkan nomor WhatsApp kembali.' });
        }
        if (!/^\d{6}$/.test(code)) {
            return res.status(400).json({ success: false, message: 'Kode OTP harus 6 digit angka.' });
        }

        const result = otpService.verifyOtp(phone, code);
        if (!result.ok) {
            return res.status(401).json({ success: false, message: result.error });
        }

        const customers = findCustomersByPhone(phone);
        if (customers.length === 0) {
            return res.status(404).json({ success: false, message: 'Data pelanggan tidak ditemukan.' });
        }

        const remember = req.body.remember === true || req.body.remember === 'true' || req.body.remember === 'on';

        if (customers.length === 1) {
            return startCustomerSession(req, customers[0], remember, (err) => {
                if (err) return res.status(500).json({ success: false, message: 'Gagal membuat sesi login.' });
                return res.json({ success: true, redirect: '/portal' });
            });
        }

        // Satu nomor WA terdaftar di beberapa akun pelanggan -> pilih akun (OTP sudah terverifikasi)
        req.session.otpVerifiedPhone = phone;
        req.session.otpVerifiedRemember = remember;
        delete req.session.pendingOtpPhone;
        return res.json({
            success: true,
            chooseAccount: true,
            accounts: customers.map(c => ({
                id: c.id,
                customer_id: c.customer_id,
                name: c.name,
                address: c.address || ''
            }))
        });
    } catch (error) {
        console.error('[Auth] Error OTP verify:', error.message);
        return res.status(500).json({ success: false, message: 'Terjadi kesalahan saat verifikasi OTP.' });
    }
});

// POST /otp/select-account - Pilih akun jika nomor WA dipakai beberapa pelanggan
router.post('/otp/select-account', (req, res) => {
    const phone = req.session.otpVerifiedPhone;
    if (!phone) {
        return res.status(401).json({ success: false, expired: true, message: 'Sesi verifikasi berakhir. Silakan ulangi login.' });
    }
    const id = parseInt(req.body.customer_id, 10);
    const customer = findCustomersByPhone(phone).find(c => c.id === id);
    if (!customer) {
        return res.status(404).json({ success: false, message: 'Akun pelanggan tidak valid.' });
    }
    const remember = !!req.session.otpVerifiedRemember;
    startCustomerSession(req, customer, remember, (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Gagal membuat sesi login.' });
        return res.json({ success: true, redirect: '/portal' });
    });
});

// ============================================
// RESET KATA SANDI ADMIN VIA WHATSAPP OTP
// ============================================

// POST /auth/admin/request-reset-otp atau /admin/request-reset-otp
router.post(['/auth/admin/request-reset-otp', '/admin/request-reset-otp'], async (req, res) => {
    try {
        if (whatsappService.getStatus() !== 'connected') {
            return res.status(503).json({
                success: false,
                message: 'Layanan WhatsApp Gateway saat ini sedang offline. Silakan pastikan server WhatsApp terhubung atau hubungi pengelola server.'
            });
        }

        const phoneRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('admin_otp_phone')
            || db.prepare("SELECT value FROM settings WHERE key = ?").get('psb_admin_phone');
        const adminPhone = phoneRow?.value ? phoneRow.value.trim() : '082240087489';

        if (!adminPhone) {
            return res.status(400).json({
                success: false,
                message: 'Nomor WhatsApp Admin belum dikonfigurasi di Pengaturan.'
            });
        }

        const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
        const otpRes = otpService.createOtp(adminPhone, clientIp);

        if (!otpRes.ok) {
            return res.status(429).json({
                success: false,
                message: otpRes.error || 'Terlalu banyak permintaan OTP. Mohon tunggu beberapa saat.'
            });
        }

        const companyRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_name');
        const companyName = companyRow?.value || 'ISP Manager';

        const otpMsg = `🔐 *KODE OTP RESET KATA SANDI ADMIN*\n\n`
            + `Halo Administrator ${companyName},\n\n`
            + `Kode OTP untuk mereset kata sandi login Admin Anda adalah:\n`
            + `👉 *${otpRes.code}*\n\n`
            + `_Kode ini berlaku selama 5 menit. Jangan pernah membagikan kode OTP ini kepada siapapun demi keamanan server ISP._`;

        try {
            await whatsappService.sendMessage(adminPhone, otpMsg);
        } catch (waErr) {
            console.error('[Auth Admin OTP] Gagal mengirim pesan WA:', waErr.message);
            otpService.discardOtp(adminPhone);
            return res.status(500).json({
                success: false,
                message: 'Gagal mengirimkan kode OTP ke WhatsApp: ' + waErr.message
            });
        }

        // Mask phone untuk privasi (contoh: 0822****7489)
        const cleanPhone = adminPhone.replace(/[^0-9]/g, '');
        const maskedPhone = cleanPhone.length > 7
            ? cleanPhone.substring(0, 4) + '****' + cleanPhone.substring(cleanPhone.length - 4)
            : cleanPhone;

        return res.json({
            success: true,
            message: `Kode OTP verifikasi berhasil dikirim ke WhatsApp Admin (${maskedPhone})`,
            phone: maskedPhone
        });
    } catch (err) {
        console.error('[Auth Admin OTP] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Terjadi kesalahan sistem: ' + err.message });
    }
});

// POST /auth/admin/verify-reset-password atau /admin/verify-reset-password
router.post(['/auth/admin/verify-reset-password', '/admin/verify-reset-password'], async (req, res) => {
    try {
        const { otp, new_password, target_username } = req.body;

        if (!otp || !otp.trim()) {
            return res.status(400).json({ success: false, message: 'Kode OTP wajib diisi.' });
        }

        const phoneRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('admin_otp_phone')
            || db.prepare("SELECT value FROM settings WHERE key = ?").get('psb_admin_phone');
        const adminPhone = phoneRow?.value ? phoneRow.value.trim() : '082240087489';

        const verifyRes = otpService.verifyOtp(adminPhone, otp.trim());
        if (!verifyRes.ok) {
            return res.status(400).json({
                success: false,
                message: verifyRes.error || 'Kode OTP salah atau telah kadaluarsa.'
            });
        }

        // Cari akun admin yang ingin direset
        let targetUser = null;
        if (target_username && target_username.trim()) {
            targetUser = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(target_username.trim());
        }
        if (!targetUser) {
            // Default ke admin id 1 atau user pertama
            targetUser = db.prepare('SELECT * FROM users WHERE role = ? ORDER BY id ASC LIMIT 1').get('admin')
                || db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT 1').get();
        }

        if (!targetUser) {
            return res.status(404).json({ success: false, message: 'Akun administrator tidak ditemukan di database.' });
        }

        // Tentukan kata sandi baru (jika diisi, minimal 4 karakter; jika kosong, reset ke default admin123)
        let passToSet = 'admin123';
        if (new_password && new_password.trim()) {
            if (new_password.trim().length < 4) {
                return res.status(400).json({ success: false, message: 'Kata sandi baru minimal 4 karakter.' });
            }
            passToSet = new_password.trim();
        }

        const hashed = bcrypt.hashSync(passToSet, 10);
        db.prepare("UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?").run(hashed, targetUser.id);

        otpService.discardOtp(adminPhone);

        db.prepare(`
            INSERT INTO activity_log (action, description, created_at)
            VALUES ('admin_password_reset_otp', ?, datetime('now'))
        `).run(`Kata sandi akun admin ${targetUser.name} (${targetUser.username}) berhasil direset via verifikasi OTP WhatsApp`);

        return res.json({
            success: true,
            username: targetUser.username,
            isDefault: passToSet === 'admin123',
            message: `Kata sandi akun admin "${targetUser.username}" berhasil direset! ${passToSet === 'admin123' ? 'Kata sandi sekarang: admin123' : 'Silakan login dengan kata sandi baru Anda.'}`
        });
    } catch (err) {
        console.error('[Auth Admin Reset Verify] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Terjadi kesalahan sistem: ' + err.message });
    }
});

// ============================================
// GET /logout - Proses Logout (Kembali ke halaman login sesuai role)
// ============================================
router.get('/logout', (req, res) => {
    const prevRole = req.session?.user?.role;
    if (req.session && req.session.user) {
        try {
            db.prepare('INSERT INTO activity_log (action, description, user_id) VALUES (?, ?, ?)')
                .run('logout', `Pengguna ${req.session.user.name} logout`, req.session.user.id);
        } catch (error) {
            console.error('Error mencatat logout:', error);
        }
    }

    req.session.destroy((err) => {
        if (err) {
            console.error('Error saat menghapus session:', err);
        }
        if (prevRole === 'admin') return res.redirect('/login-admin');
        if (prevRole === 'technician') return res.redirect('/teknisi');
        res.redirect('/login');
    });
});

module.exports = router;
