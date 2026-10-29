// Routes: Tiket PSB (Pemasangan Baru)
// Mengelola alur pemasangan pelanggan baru mulai dari pendaftaran tiket PSB,
// penerimaan oleh teknisi, update progress instalasi per tahap beserta foto dokumentasi,
// hingga notifikasi WhatsApp otomatis ke Nomor Pelanggan Baru dan Nomor Admin.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const moment = require('moment');
try { require('moment/locale/id'); moment.locale('id'); } catch (e) {}

const db = require('../database/init');
const { isAuthenticated, isAdmin } = require('../middleware/auth');
const whatsappService = require('../services/whatsapp');

router.use(isAuthenticated);

// Direktori penyimpanan foto dokumentasi PSB
const psbUploadsDir = path.join(__dirname, '../public/uploads/psb');
if (!fs.existsSync(psbUploadsDir)) {
    try { fs.mkdirSync(psbUploadsDir, { recursive: true }); } catch (e) {}
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(psbUploadsDir)) {
            fs.mkdirSync(psbUploadsDir, { recursive: true });
        }
        cb(null, psbUploadsDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
        const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
        const uniqueName = `psb_${Date.now()}_${Math.round(Math.random() * 10000)}${safeExt}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype && file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Hanya file gambar/foto yang diperbolehkan'));
        }
    }
});

function getSetting(key, defaultValue = '') {
    try {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return (row && row.value !== null && row.value !== undefined && row.value !== '') ? row.value : defaultValue;
    } catch (e) {
        return defaultValue;
    }
}

function getAdminPhones(psbTicket = null) {
    const raw = (psbTicket && psbTicket.admin_phone)
        || getSetting('psb_admin_phone', '')
        || getSetting('company_phone', '');
    return raw
        .split(/[,;/\n]+/)
        .map(p => p.trim())
        .filter(Boolean);
}

/**
 * Helper: Kirim pesan WhatsApp (beserta foto jika ada) ke daftar nomor telepon
 */
async function sendWaWithOptionalPhotos(phones, messageText, savedPhotos = []) {
    if (!phones || phones.length === 0) return false;
    let anySent = false;
    const uniquePhones = [...new Set(phones.map(p => p.trim()).filter(Boolean))];

    for (const phone of uniquePhones) {
        try {
            if (savedPhotos.length > 0) {
                const firstAbs = path.join(__dirname, '../public', savedPhotos[0].file_path);
                if (fs.existsSync(firstAbs)) {
                    await whatsappService.sendImage(phone, firstAbs, messageText);
                    anySent = true;
                    // Jika ada foto tambahan, kirim menyusul
                    for (let i = 1; i < savedPhotos.length; i++) {
                        const nextAbs = path.join(__dirname, '../public', savedPhotos[i].file_path);
                        if (fs.existsSync(nextAbs)) {
                            await whatsappService.sendImage(phone, nextAbs, savedPhotos[i].caption || `📷 Foto Dokumentasi PSB #${i + 1}`);
                        }
                    }
                    continue;
                }
            }
            await whatsappService.sendMessage(phone, messageText);
            anySent = true;
        } catch (err) {
            console.warn(`[PSB WA] Gagal mengirim WA ke ${phone}:`, err.message);
        }
    }
    return anySent;
}

/**
 * Helper: Simpan file foto yang diupload ke tabel psb_photos
 */
function saveUploadedPsbPhotos(psbId, logId, stage, files, defaultCaption, uploadedBy) {
    const saved = [];
    if (!files || files.length === 0) return saved;

    const insertStmt = db.prepare(`
        INSERT INTO psb_photos (psb_id, log_id, stage, file_path, file_name, caption, uploaded_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    `);

    for (const file of files) {
        const relPath = `/uploads/psb/${file.filename}`;
        const res = insertStmt.run(
            psbId,
            logId || null,
            stage,
            relPath,
            file.originalname || file.filename,
            defaultCaption || '',
            uploadedBy || 'Teknisi'
        );
        saved.push({
            id: res.lastInsertRowid,
            file_path: relPath,
            caption: defaultCaption || ''
        });
    }
    return saved;
}

/**
 * Helper: Daftarkan pelanggan PSB yang sudah selesai ke tabel customers otomatis
 */
function registerPsbToActiveCustomers(psbTicket) {
    if (psbTicket.customer_db_id) {
        const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(psbTicket.customer_db_id);
        if (existing) return existing;
    }

    // Generate kode ID Pelanggan baru (CUST-XXXX)
    const lastCust = db.prepare("SELECT customer_id FROM customers WHERE customer_id LIKE 'CUST-%' ORDER BY id DESC LIMIT 1").get();
    let nextNum = 1;
    if (lastCust && lastCust.customer_id) {
        const numPart = parseInt(lastCust.customer_id.replace('CUST-', ''), 10);
        if (!isNaN(numPart)) nextNum = numPart + 1;
    }
    // Pastikan unik
    let newCustCode = `CUST-${String(nextNum).padStart(4, '0')}`;
    while (db.prepare('SELECT id FROM customers WHERE customer_id = ?').get(newCustCode)) {
        nextNum++;
        newCustCode = `CUST-${String(nextNum).padStart(4, '0')}`;
    }

    const defaultRouter = db.prepare('SELECT id FROM routers ORDER BY is_default DESC, id ASC LIMIT 1').get();
    const routerId = defaultRouter ? defaultRouter.id : 1;

    const insertCust = db.prepare(`
        INSERT INTO customers (
            customer_id, name, address, phone, package_id,
            connection_type, pppoe_username, pppoe_password, ip_address,
            latitude, longitude, onu_serial, installation_date, due_date,
            status, router_id, portal_password, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, date('now', 'localtime'), 8, 'active', ?, '123456', ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
    `).run(
        newCustCode,
        psbTicket.customer_name,
        psbTicket.customer_address || '',
        psbTicket.customer_phone || '',
        psbTicket.package_id || null,
        psbTicket.connection_type || 'pppoe',
        psbTicket.pppoe_username || '',
        psbTicket.pppoe_password || '',
        psbTicket.ip_address || '',
        psbTicket.latitude || null,
        psbTicket.longitude || null,
        psbTicket.onu_serial || '',
        routerId,
        `Terdaftar otomatis dari Tiket PSB ${psbTicket.psb_number}${psbTicket.odp_info ? ' | ODP: ' + psbTicket.odp_info : ''}`
    );

    const newCustomerId = insertCust.lastInsertRowid;
    db.prepare('UPDATE psb_tickets SET customer_db_id = ? WHERE id = ?').run(newCustomerId, psbTicket.id);

    const newCust = db.prepare(`
        SELECT c.*, p.name as package_name, p.speed_down, p.speed_up, p.price as package_price
        FROM customers c
        LEFT JOIN packages p ON c.package_id = p.id
        WHERE c.id = ?
    `).get(newCustomerId);

    if (newCust && newCust.phone) {
        try {
            const whatsappService = require('../services/whatsapp');
            whatsappService.sendWelcomeCustomer(newCust).catch(err => {
                console.warn('[PSB] Gagal kirim WA welcome:', err.message);
            });
        } catch (eWa) {}
    }

    return newCust;
}

// ============================================
// 1. GET /psb - Daftar Tiket PSB (Pemasangan Baru)
// ============================================
router.get('/', (req, res) => {
    try {
        const { status, search } = req.query;

        let query = `
            SELECT p.*,
                   pkg.speed_down, pkg.speed_up, pkg.price as package_price,
                   c.customer_id as registered_customer_code,
                   (SELECT COUNT(*) FROM psb_photos pp WHERE pp.psb_id = p.id) as photo_count,
                   (SELECT COUNT(*) FROM psb_logs pl WHERE pl.psb_id = p.id) as log_count
            FROM psb_tickets p
            LEFT JOIN packages pkg ON p.package_id = pkg.id
            LEFT JOIN customers c ON p.customer_db_id = c.id
        `;

        const conditions = [];
        const params = [];

        if (status && status !== 'all') {
            conditions.push('p.status = ?');
            params.push(status);
        }
        if (search && search.trim() !== '') {
            const q = `%${search.trim()}%`;
            conditions.push('(p.psb_number LIKE ? OR p.customer_name LIKE ? OR p.customer_phone LIKE ? OR p.customer_address LIKE ? OR p.technician_name LIKE ?)');
            params.push(q, q, q, q, q);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        query += `
            ORDER BY
                CASE p.status
                    WHEN 'open' THEN 1
                    WHEN 'accepted' THEN 2
                    WHEN 'in_progress' THEN 3
                    WHEN 'completed' THEN 4
                    ELSE 5
                END ASC,
                p.created_at DESC
        `;

        const psbTickets = db.prepare(query).all(...params);

        const statsRow = db.prepare(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
                SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted_count,
                SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as progress_count,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count
            FROM psb_tickets
        `).get();

        const packages = db.prepare('SELECT * FROM packages WHERE is_active = 1 ORDER BY price ASC').all();
        const technicians = db.prepare('SELECT * FROM technicians WHERE is_active = 1 ORDER BY name ASC').all();

        const recentPhotos = db.prepare(`
            SELECT pp.*, p.psb_number, p.customer_name, p.status as psb_status
            FROM psb_photos pp
            JOIN psb_tickets p ON pp.psb_id = p.id
            ORDER BY pp.created_at DESC
            LIMIT 60
        `).all();

        const adminPhoneSetting = getSetting('psb_admin_phone', getSetting('company_phone', ''));

        // Rekap Pengerjaan Teknisi (Hari Ini, Minggu Ini, Bulan Ini, Custom)
        const { getTechnicianWorkRecap } = require('../services/technician-recap');
        const techRecap = getTechnicianWorkRecap(db, {
            range: req.query.recap_range || 'today',
            startDate: req.query.recap_start,
            endDate: req.query.recap_end
        });

        res.render('psb', {
            title: 'Tiket PSB (Pemasangan Baru)',
            activePage: 'psb',
            psbTickets,
            stats: {
                total: statsRow?.total || 0,
                open: statsRow?.open_count || 0,
                accepted: statsRow?.accepted_count || 0,
                in_progress: statsRow?.progress_count || 0,
                completed: statsRow?.completed_count || 0
            },
            packages,
            technicians,
            techRecap,
            recentPhotos,
            adminPhoneSetting,
            filters: {
                status: status || 'all',
                search: search || ''
            },
            moment
        });
    } catch (error) {
        console.error('[PSB] Error loading PSB tickets:', error.message);
        req.flash('error', 'Gagal memuat halaman Tiket PSB: ' + error.message);
        res.redirect('/tickets');
    }
});

// ============================================
// 2. POST /psb - Buat Tiket PSB (Pemasangan Baru)
// ============================================
router.post('/', upload.array('photos', 6), async (req, res) => {
    try {
        const {
            customer_name,
            customer_phone,
            customer_address,
            latitude,
            longitude,
            package_id,
            connection_type,
            pppoe_username,
            pppoe_password,
            ip_address,
            installation_fee,
            scheduled_date,
            technician_id,
            admin_phone,
            notes,
            photo_caption
        } = req.body;

        if (!customer_name || !customer_phone) {
            req.flash('error', 'Nama calon pelanggan baru dan Nomor WhatsApp wajib diisi.');
            return res.redirect('/psb');
        }

        // Ambil info paket
        let pkgName = 'Internet Fiber';
        if (package_id) {
            const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(package_id);
            if (pkg) pkgName = `${pkg.name} (${pkg.speed_down}/${pkg.speed_up} Mbps)`;
        }

        // Ambil info teknisi yang ditugaskan
        let techId = null;
        let techName = 'Tim Teknisi PSB';
        let techPhone = '';
        let targetTechPhones = [];

        if (technician_id && technician_id !== 'all') {
            const tech = db.prepare('SELECT * FROM technicians WHERE id = ?').get(technician_id);
            if (tech) {
                techId = tech.id;
                techName = tech.name;
                techPhone = tech.phone;
                targetTechPhones = [tech.phone];
            }
        } else {
            const activeTechs = db.prepare('SELECT * FROM technicians WHERE is_active = 1').all();
            if (activeTechs.length > 0) {
                techId = activeTechs[0].id;
                techName = activeTechs.length === 1 ? activeTechs[0].name : activeTechs.map(t => t.name).join(', ');
                techPhone = activeTechs.map(t => t.phone).filter(Boolean).join(', ');
                targetTechPhones = activeTechs.map(t => t.phone).filter(Boolean);
            }
        }

        // Generate Nomor Tiket PSB: PSB-YYYYMM-XXXX
        const ym = moment().format('YYYYMM');
        const prefix = `PSB-${ym}-`;
        const lastPsb = db.prepare("SELECT psb_number FROM psb_tickets WHERE psb_number LIKE ? ORDER BY id DESC LIMIT 1").get(`${prefix}%`);
        let nextSeq = 1;
        if (lastPsb && lastPsb.psb_number) {
            const parts = lastPsb.psb_number.split('-');
            const lastNum = parseInt(parts[2], 10);
            if (!isNaN(lastNum)) nextSeq = lastNum + 1;
        }
        const psbNumber = `${prefix}${String(nextSeq).padStart(4, '0')}`;

        const finalAdminPhone = (admin_phone || '').trim() || getSetting('psb_admin_phone', getSetting('company_phone', ''));
        if (admin_phone && admin_phone.trim()) {
            db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('psb_admin_phone', ?, datetime('now'))")
                .run(admin_phone.trim());
        }

        const actorName = req.session?.user?.name || req.session?.user?.username || 'Admin';

        const insertResult = db.prepare(`
            INSERT INTO psb_tickets (
                psb_number, customer_name, customer_phone, customer_address,
                latitude, longitude, package_id, package_name,
                connection_type, pppoe_username, pppoe_password, ip_address,
                installation_fee, scheduled_date, notes, status,
                technician_id, technician_name, technician_phone, admin_phone,
                created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
        `).run(
            psbNumber,
            customer_name.trim(),
            customer_phone.trim(),
            (customer_address || '').trim(),
            latitude ? parseFloat(latitude) : null,
            longitude ? parseFloat(longitude) : null,
            package_id || null,
            pkgName,
            connection_type || 'pppoe',
            (pppoe_username || '').trim(),
            (pppoe_password || '').trim(),
            (ip_address || '').trim(),
            parseFloat(installation_fee) || 0,
            scheduled_date || moment().format('YYYY-MM-DD'),
            (notes || '').trim(),
            techId,
            techName,
            techPhone,
            finalAdminPhone,
            actorName
        );

        const psbId = insertResult.lastInsertRowid;

        // Catat log pertama
        const logInsert = db.prepare(`
            INSERT INTO psb_logs (psb_id, status, title, description, actor_name, wa_customer_sent, wa_admin_sent, created_at)
            VALUES (?, 'open', ?, ?, ?, 0, 0, datetime('now', 'localtime'))
        `).run(
            psbId,
            'Tiket Pemasangan Baru (PSB) Dibuat',
            `Paket: ${pkgName}\nJadwal Pasang: ${scheduled_date || moment().format('YYYY-MM-DD')}\nTeknisi: ${techName}\nCatatan: ${(notes || '-').trim()}`,
            actorName
        );
        const logId = logInsert.lastInsertRowid;

        // Simpan foto awal (jika ada, misal foto KTP / foto titik rumah / ODP)
        const savedPhotos = saveUploadedPsbPhotos(
            psbId,
            logId,
            'initial',
            req.files,
            photo_caption || `Foto Pendaftaran Awal PSB - ${psbNumber}`,
            actorName
        );

        const companyName = getSetting('company_name', 'PT. Lintas Jaringan Nusantara');
        const mapsLink = (latitude && longitude)
            ? `https://www.google.com/maps?q=${latitude},${longitude}`
            : '-';

        // 1. Kirim WA ke Teknisi yang ditugaskan
        if (targetTechPhones.length > 0) {
            const techMsg =
                `📡 *TIKET PEMASANGAN BARU (PSB)*\n\n` +
                `Halo Tim Teknisi (*${techName}*), terdapat tugas pemasangan baru (PSB):\n\n` +
                `*No. PSB:* ${psbNumber}\n` +
                `*Calon Pelanggan:* ${customer_name.trim()}\n` +
                `*No. WhatsApp:* ${customer_phone.trim()}\n` +
                `*Alamat Pasang:* ${(customer_address || '-').trim()}\n` +
                `*Lokasi Maps:* ${mapsLink}\n` +
                `*Paket Internet:* ${pkgName}\n` +
                `*Jadwal Pasang:* ${scheduled_date ? moment(scheduled_date).format('DD MMMM YYYY') : 'Segera'}\n` +
                `*Catatan:* ${(notes || '-').trim()}\n\n` +
                `Silakan buka menu *Tiket PSB* di Portal Teknisi untuk menerima tiket dan mengupdate foto progres pemasangan.\n_${companyName}_`;

            await sendWaWithOptionalPhotos(targetTechPhones, techMsg, savedPhotos);
        }

        // 2. Kirim WA ke Nomor Pelanggan Baru
        let waCustSent = false;
        if (customer_phone && customer_phone.trim()) {
            const custMsg =
                `🎉 *KONFIRMASI TIKET PEMASANGAN BARU (PSB)*\n\n` +
                `Yth. Bapak/Ibu *${customer_name.trim()}*,\n` +
                `Terima kasih telah mendaftar layanan internet *${companyName}*. Tiket pemasangan baru Anda telah kami proses:\n\n` +
                `*No. Tiket PSB:* ${psbNumber}\n` +
                `*Paket Layanan:* ${pkgName}\n` +
                `*Alamat Pasang:* ${(customer_address || '-').trim()}\n` +
                `*Jadwal Rencana Pasang:* ${scheduled_date ? moment(scheduled_date).format('DD MMMM YYYY') : 'Segera'}\n` +
                `*Teknisi Bertugas:* ${techName} (${techPhone || '-'})\n` +
                `*Status Saat Ini:* 1. MENUNGGU KONFIRMASI TEKNISI 📋\n\n` +
                `Kami akan mengirimkan notifikasi WhatsApp otomatis beserta foto dokumentasi di setiap tahapan pemasangan.\n\n` +
                `Salam,\n*${companyName}*`;

            waCustSent = await sendWaWithOptionalPhotos([customer_phone.trim()], custMsg, savedPhotos);
        }

        // 3. Kirim WA ke Nomor Admin
        let waAdminSent = false;
        const adminPhones = getAdminPhones({ admin_phone: finalAdminPhone });
        if (adminPhones.length > 0) {
            const adminMsg =
                `📋 *[MONITORING ADMIN] TIKET PSB BARU DIBUAT*\n\n` +
                `*No. PSB:* ${psbNumber}\n` +
                `*Pelanggan Baru:* ${customer_name.trim()} (${customer_phone.trim()})\n` +
                `*Alamat:* ${(customer_address || '-').trim()}\n` +
                `*Paket:* ${pkgName}\n` +
                `*Teknisi Ditugaskan:* ${techName}\n` +
                `*Dibuat Oleh:* ${actorName}\n` +
                `*Waktu:* ${moment().format('DD MMM YYYY HH:mm')} WIB`;

            waAdminSent = await sendWaWithOptionalPhotos(adminPhones, adminMsg, savedPhotos);
        }

        db.prepare('UPDATE psb_logs SET wa_customer_sent = ?, wa_admin_sent = ? WHERE id = ?')
            .run(waCustSent ? 1 : 0, waAdminSent ? 1 : 0, logId);

        db.prepare('INSERT INTO activity_log (action, description, user_id) VALUES (?, ?, ?)').run(
            'psb_created',
            `Tiket PSB baru ${psbNumber} dibuat untuk pelanggan ${customer_name.trim()} (${pkgName})`,
            req.session?.user?.id || null
        );

        req.flash('success', `Tiket PSB ${psbNumber} untuk ${customer_name.trim()} berhasil dibuat dan notifikasi WhatsApp telah dikirim!`);
        res.redirect(`/psb/${psbId}`);
    } catch (error) {
        console.error('[PSB] Error creating PSB ticket:', error.message);
        req.flash('error', 'Gagal membuat tiket PSB: ' + error.message);
        res.redirect('/psb');
    }
});

// ============================================
// 3. POST /psb/settings - Simpan Nomor WA Admin untuk Monitoring PSB
// ============================================
router.post('/settings', isAdmin, (req, res) => {
    try {
        const { psb_admin_phone } = req.body;
        db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('psb_admin_phone', ?, datetime('now'))")
            .run((psb_admin_phone || '').trim());
        req.flash('success', 'Nomor WhatsApp Admin untuk notifikasi progres PSB berhasil disimpan.');
        res.redirect('/psb');
    } catch (error) {
        req.flash('error', 'Gagal menyimpan pengaturan PSB: ' + error.message);
        res.redirect('/psb');
    }
});

// ============================================
// 4. GET /psb/:id - Detail Tiket PSB & Pantauan Progres + Foto per Tahap
// ============================================
router.get('/:id', (req, res) => {
    try {
        const psbId = req.params.id;
        const psb = db.prepare(`
            SELECT p.*,
                   pkg.speed_down, pkg.speed_up, pkg.price as package_price,
                   c.customer_id as registered_customer_code
            FROM psb_tickets p
            LEFT JOIN packages pkg ON p.package_id = pkg.id
            LEFT JOIN customers c ON p.customer_db_id = c.id
            WHERE p.id = ?
        `).get(psbId);

        if (!psb) {
            req.flash('error', 'Tiket PSB tidak ditemukan.');
            return res.redirect('/psb');
        }

        const logs = db.prepare(`
            SELECT * FROM psb_logs
            WHERE psb_id = ?
            ORDER BY created_at ASC, id ASC
        `).all(psbId);

        const photos = db.prepare(`
            SELECT * FROM psb_photos
            WHERE psb_id = ?
            ORDER BY created_at ASC, id ASC
        `).all(psbId);

        const photosByLog = {};
        for (const ph of photos) {
            if (ph.log_id) {
                if (!photosByLog[ph.log_id]) photosByLog[ph.log_id] = [];
                photosByLog[ph.log_id].push(ph);
            }
        }

        const technicians = db.prepare('SELECT * FROM technicians WHERE is_active = 1 ORDER BY name ASC').all();
        const packages = db.prepare('SELECT * FROM packages WHERE is_active = 1 ORDER BY price ASC').all();

        res.render('psb-detail', {
            title: `Detail PSB ${psb.psb_number} - ${psb.customer_name}`,
            activePage: 'psb',
            psb,
            logs,
            photos,
            photosByLog,
            technicians,
            packages,
            moment
        });
    } catch (error) {
        console.error('[PSB] Error loading PSB detail:', error.message);
        req.flash('error', 'Gagal memuat detail tiket PSB: ' + error.message);
        res.redirect('/psb');
    }
});

// ============================================
// 5. POST /psb/:id/accept - Teknisi Menerima Tiket PSB (Progres 2)
// Mengirim Notifikasi WA (+ Foto) ke Nomor Pelanggan Baru & Nomor Admin
// ============================================
router.post('/:id/accept', upload.array('photos', 5), async (req, res) => {
    const psbId = req.params.id;
    try {
        const psb = db.prepare('SELECT * FROM psb_tickets WHERE id = ?').get(psbId);
        if (!psb) {
            req.flash('error', 'Tiket PSB tidak ditemukan.');
            return res.redirect('/psb');
        }

        const { technician_id, technician_name_custom, note, photo_caption } = req.body;

        let techId = psb.technician_id;
        let techName = psb.technician_name || 'Teknisi Lapangan';
        let techPhone = psb.technician_phone || '';

        if (req.session?.user?.role === 'technician') {
            techId = req.session.user.technician_id || techId;
            techName = req.session.user.name || techName;
            techPhone = req.session.user.phone || techPhone;
        } else if (technician_id) {
            const t = db.prepare('SELECT * FROM technicians WHERE id = ?').get(technician_id);
            if (t) {
                techId = t.id;
                techName = t.name;
                techPhone = t.phone;
            }
        }
        if (technician_name_custom && technician_name_custom.trim()) {
            techName = technician_name_custom.trim();
        }

        const acceptNote = (note && note.trim())
            ? note.trim()
            : `Teknisi (${techName}) telah menerima tiket PSB dan sedang menuju lokasi pemasangan untuk survey / penarikan kabel.`;

        db.prepare(`
            UPDATE psb_tickets
            SET status = 'accepted',
                technician_id = ?,
                technician_name = ?,
                technician_phone = ?,
                accepted_at = COALESCE(accepted_at, datetime('now', 'localtime')),
                updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(techId, techName, techPhone, psbId);

        const logInsert = db.prepare(`
            INSERT INTO psb_logs (psb_id, status, title, description, actor_name, wa_customer_sent, wa_admin_sent, created_at)
            VALUES (?, 'accepted', ?, ?, ?, 0, 0, datetime('now', 'localtime'))
        `).run(
            psbId,
            `Tiket PSB Diterima oleh Teknisi (${techName})`,
            acceptNote,
            techName
        );
        const logId = logInsert.lastInsertRowid;

        const savedPhotos = saveUploadedPsbPhotos(
            psbId,
            logId,
            'accepted',
            req.files,
            photo_caption || `Foto Penerimaan / Persiapan PSB - ${psb.psb_number}`,
            techName
        );

        const companyName = getSetting('company_name', 'PT. Lintas Jaringan Nusantara');

        // 1. Kirim WA ke Nomor Pelanggan Baru
        let waCustSent = false;
        if (psb.customer_phone) {
            const custMsg =
                `👷 *UPDATE PROGRES PSB: DITERIMA TEKNISI*\n\n` +
                `Yth. Bapak/Ibu *${psb.customer_name}*,\n` +
                `Tiket pemasangan internet baru Anda telah *DITERIMA* oleh tim teknisi kami:\n\n` +
                `*No. Tiket PSB:* ${psb.psb_number}\n` +
                `*Paket:* ${psb.package_name || '-'}\n` +
                `*Status Progres:* 2. DITERIMA TEKNISI (MENUJU LOKASI) 🚗\n` +
                `*Teknisi Bertugas:* ${techName}\n` +
                `*Kontak Teknisi:* ${techPhone || '-'}\n` +
                `*Catatan Teknisi:*\n${acceptNote}\n\n` +
                `Mohon pastikan nomor telepon aktif dan lokasi siap untuk proses instalasi.\n\n` +
                `Salam,\n*${companyName}*`;

            waCustSent = await sendWaWithOptionalPhotos([psb.customer_phone], custMsg, savedPhotos);
        }

        // 2. Kirim WA ke Nomor Admin
        let waAdminSent = false;
        const adminPhones = getAdminPhones(psb);
        if (adminPhones.length > 0) {
            const adminMsg =
                `🔔 *[MONITORING ADMIN] PROGRES PSB: DITERIMA TEKNISI*\n\n` +
                `*No. PSB:* ${psb.psb_number}\n` +
                `*Pelanggan Baru:* ${psb.customer_name} (${psb.customer_phone})\n` +
                `*Alamat:* ${psb.customer_address || '-'}\n` +
                `*Status:* 2. DITERIMA TEKNISI 📋\n` +
                `*Teknisi:* ${techName} (${techPhone || '-'})\n` +
                `*Keterangan:* ${acceptNote}\n` +
                `*Waktu:* ${moment().format('DD MMM YYYY HH:mm')} WIB`;

            waAdminSent = await sendWaWithOptionalPhotos(adminPhones, adminMsg, savedPhotos);
        }

        db.prepare('UPDATE psb_logs SET wa_customer_sent = ?, wa_admin_sent = ? WHERE id = ?')
            .run(waCustSent ? 1 : 0, waAdminSent ? 1 : 0, logId);

        db.prepare('INSERT INTO activity_log (action, description, user_id) VALUES (?, ?, ?)').run(
            'psb_accepted',
            `Tiket PSB ${psb.psb_number} (${psb.customer_name}) diterima oleh teknisi ${techName}`,
            req.session?.user?.id || null
        );

        req.flash('success', `Tiket PSB ${psb.psb_number} berhasil diterima! Notifikasi WhatsApp telah dikirim ke Pelanggan Baru dan Admin.`);
        res.redirect(`/psb/${psbId}`);
    } catch (error) {
        console.error('[PSB] Error accepting PSB ticket:', error.message);
        req.flash('error', 'Gagal memproses penerimaan PSB: ' + error.message);
        res.redirect(`/psb/${psbId}`);
    }
});

// ============================================
// 6. POST /psb/:id/progress - Update Progres Instalasi PSB (Progres 3)
// Mengirim Notifikasi WA (+ Foto Progres) ke Nomor Pelanggan Baru & Nomor Admin
// ============================================
router.post('/:id/progress', upload.array('photos', 6), async (req, res) => {
    const psbId = req.params.id;
    try {
        const psb = db.prepare('SELECT * FROM psb_tickets WHERE id = ?').get(psbId);
        if (!psb) {
            req.flash('error', 'Tiket PSB tidak ditemukan.');
            return res.redirect('/psb');
        }

        const {
            progress_stage_title,
            note,
            odp_info,
            onu_serial,
            pppoe_username,
            pppoe_password,
            ip_address,
            photo_caption
        } = req.body;

        const stageTitle = (progress_stage_title || 'Proses Instalasi & Penarikan Kabel').trim();
        const progressNote = (note || '').trim() || `Tim teknisi sedang melakukan: ${stageTitle}.`;
        const actorName = req.session?.user?.name || psb.technician_name || 'Teknisi Lapangan';

        db.prepare(`
            UPDATE psb_tickets
            SET status = 'in_progress',
                odp_info = COALESCE(NULLIF(?, ''), odp_info),
                onu_serial = COALESCE(NULLIF(?, ''), onu_serial),
                pppoe_username = COALESCE(NULLIF(?, ''), pppoe_username),
                pppoe_password = COALESCE(NULLIF(?, ''), pppoe_password),
                ip_address = COALESCE(NULLIF(?, ''), ip_address),
                in_progress_at = COALESCE(in_progress_at, datetime('now', 'localtime')),
                updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(
            (odp_info || '').trim(),
            (onu_serial || '').trim(),
            (pppoe_username || '').trim(),
            (pppoe_password || '').trim(),
            (ip_address || '').trim(),
            psbId
        );

        let fullDesc = progressNote;
        if (odp_info && odp_info.trim()) fullDesc += `\nInfo ODP / Redaman: ${odp_info.trim()}`;
        if (onu_serial && onu_serial.trim()) fullDesc += `\nSN ONT/Modem: ${onu_serial.trim()}`;

        const logInsert = db.prepare(`
            INSERT INTO psb_logs (psb_id, status, title, description, actor_name, wa_customer_sent, wa_admin_sent, created_at)
            VALUES (?, 'in_progress', ?, ?, ?, 0, 0, datetime('now', 'localtime'))
        `).run(
            psbId,
            `Update Progres: ${stageTitle}`,
            fullDesc,
            actorName
        );
        const logId = logInsert.lastInsertRowid;

        const savedPhotos = saveUploadedPsbPhotos(
            psbId,
            logId,
            'in_progress',
            req.files,
            photo_caption || `Foto Progres (${stageTitle}) - ${psb.psb_number}`,
            actorName
        );

        const companyName = getSetting('company_name', 'PT. Lintas Jaringan Nusantara');

        // 1. Kirim WA (+ Foto Progres) ke Nomor Pelanggan Baru
        let waCustSent = false;
        if (psb.customer_phone) {
            const custMsg =
                `⚙️ *UPDATE PROGRES PEMASANGAN INTERNET (PSB)*\n\n` +
                `Yth. Bapak/Ibu *${psb.customer_name}*,\n` +
                `Berikut adalah perkembangan terbaru proses instalasi internet Anda:\n\n` +
                `*No. Tiket PSB:* ${psb.psb_number}\n` +
                `*Tahap Pengerjaan:* ${stageTitle}\n` +
                `*Status:* 3. SEDANG PROSES INSTALASI 🔧\n` +
                `*Teknisi:* ${actorName}\n` +
                `*Detail Progres:*\n${fullDesc}\n` +
                `*Waktu Update:* ${moment().format('DD MMM YYYY HH:mm')} WIB\n\n` +
                `Terima kasih atas kerja samanya.\n*${companyName}*`;

            waCustSent = await sendWaWithOptionalPhotos([psb.customer_phone], custMsg, savedPhotos);
        }

        // 2. Kirim WA (+ Foto Progres) ke Nomor Admin
        let waAdminSent = false;
        const adminPhones = getAdminPhones(psb);
        if (adminPhones.length > 0) {
            const adminMsg =
                `🔧 *[MONITORING ADMIN] UPDATE PROGRES PSB*\n\n` +
                `*No. PSB:* ${psb.psb_number}\n` +
                `*Pelanggan Baru:* ${psb.customer_name} (${psb.customer_phone})\n` +
                `*Alamat:* ${psb.customer_address || '-'}\n` +
                `*Tahap Progres:* ${stageTitle}\n` +
                `*Teknisi:* ${actorName}\n` +
                `*Detail:*\n${fullDesc}\n` +
                `*Lampiran Foto:* ${savedPhotos.length} Foto\n` +
                `*Waktu:* ${moment().format('DD MMM YYYY HH:mm')} WIB`;

            waAdminSent = await sendWaWithOptionalPhotos(adminPhones, adminMsg, savedPhotos);
        }

        db.prepare('UPDATE psb_logs SET wa_customer_sent = ?, wa_admin_sent = ? WHERE id = ?')
            .run(waCustSent ? 1 : 0, waAdminSent ? 1 : 0, logId);

        db.prepare('INSERT INTO activity_log (action, description, user_id) VALUES (?, ?, ?)').run(
            'psb_progress',
            `Update progres PSB ${psb.psb_number} (${psb.customer_name}): ${stageTitle}`,
            req.session?.user?.id || null
        );

        req.flash('success', `Progres PSB (${stageTitle}) berhasil disimpan & notifikasi WhatsApp beserta foto telah dikirim ke Pelanggan Baru dan Admin!`);
        res.redirect(`/psb/${psbId}`);
    } catch (error) {
        console.error('[PSB] Error updating PSB progress:', error.message);
        req.flash('error', 'Gagal mengupdate progres PSB: ' + error.message);
        res.redirect(`/psb/${psbId}`);
    }
});

// ============================================
// 7. POST /psb/:id/complete - Selesaikan Pemasangan Baru (Progres 4 - Completed)
// Mengirim Notifikasi WA (+ Foto Bukti Selesai) ke Pelanggan Baru & Admin
// serta opsional mendaftarkan otomatis ke Data Pelanggan Aktif
// ============================================
router.post('/:id/complete', upload.array('photos', 6), async (req, res) => {
    const psbId = req.params.id;
    try {
        const psb = db.prepare('SELECT * FROM psb_tickets WHERE id = ?').get(psbId);
        if (!psb) {
            req.flash('error', 'Tiket PSB tidak ditemukan.');
            return res.redirect('/psb');
        }

        const {
            note,
            odp_info,
            onu_serial,
            pppoe_username,
            pppoe_password,
            ip_address,
            latitude,
            longitude,
            register_to_customers,
            photo_caption
        } = req.body;

        const actorName = req.session?.user?.name || psb.technician_name || 'Teknisi Lapangan';
        const completeNote = (note || '').trim() || 'Pemasangan perangkat ONT/Modem telah selesai, koneksi internet sudah aktif dan normal.';

        db.prepare(`
            UPDATE psb_tickets
            SET status = 'completed',
                odp_info = COALESCE(NULLIF(?, ''), odp_info),
                onu_serial = COALESCE(NULLIF(?, ''), onu_serial),
                pppoe_username = COALESCE(NULLIF(?, ''), pppoe_username),
                pppoe_password = COALESCE(NULLIF(?, ''), pppoe_password),
                ip_address = COALESCE(NULLIF(?, ''), ip_address),
                latitude = COALESCE(?, latitude),
                longitude = COALESCE(?, longitude),
                completed_at = datetime('now', 'localtime'),
                updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(
            (odp_info || '').trim(),
            (onu_serial || '').trim(),
            (pppoe_username || '').trim(),
            (pppoe_password || '').trim(),
            (ip_address || '').trim(),
            latitude ? parseFloat(latitude) : null,
            longitude ? parseFloat(longitude) : null,
            psbId
        );

        const updatedPsb = db.prepare('SELECT * FROM psb_tickets WHERE id = ?').get(psbId);

        // Jika dicentang otomatis masuk ke Data Pelanggan Aktif
        let registeredCustomer = null;
        if (register_to_customers === '1' || register_to_customers === 'on') {
            try {
                registeredCustomer = registerPsbToActiveCustomers(updatedPsb);
            } catch (regErr) {
                console.warn('[PSB] Gagal auto-register customer:', regErr.message);
            }
        }

        let fullDesc = completeNote;
        if (updatedPsb.odp_info) fullDesc += `\nODP / Redaman: ${updatedPsb.odp_info}`;
        if (updatedPsb.onu_serial) fullDesc += `\nSN ONT/Modem: ${updatedPsb.onu_serial}`;
        if (registeredCustomer) fullDesc += `\nID Pelanggan Aktif: ${registeredCustomer.customer_id}`;

        const logInsert = db.prepare(`
            INSERT INTO psb_logs (psb_id, status, title, description, actor_name, wa_customer_sent, wa_admin_sent, created_at)
            VALUES (?, 'completed', ?, ?, ?, 0, 0, datetime('now', 'localtime'))
        `).run(
            psbId,
            'Pemasangan Baru (PSB) Selesai & Internet Aktif',
            fullDesc,
            actorName
        );
        const logId = logInsert.lastInsertRowid;

        const savedPhotos = saveUploadedPsbPhotos(
            psbId,
            logId,
            'completed',
            req.files,
            photo_caption || `Foto Selesai Pemasangan PSB - ${psb.psb_number}`,
            actorName
        );

        const companyName = getSetting('company_name', 'PT. Lintas Jaringan Nusantara');

        // 1. Kirim WA Selesai Pasang (+ Foto Bukti) ke Nomor Pelanggan Baru
        let waCustSent = false;
        if (updatedPsb.customer_phone) {
            const custIdInfo = registeredCustomer
                ? `\n*ID Pelanggan Anda:* ${registeredCustomer.customer_id}\n*PIN Portal Pelanggan:* 123456`
                : '';

            const custMsg =
                `✅ *PEMASANGAN INTERNET BARU (PSB) SELESAI*\n\n` +
                `Yth. Bapak/Ibu *${updatedPsb.customer_name}*,\n` +
                `Selamat! Proses pemasangan layanan internet *${companyName}* di lokasi Anda telah *SELESAI* dan siap digunakan:\n\n` +
                `*No. Tiket PSB:* ${updatedPsb.psb_number}\n` +
                `*Paket Layanan:* ${updatedPsb.package_name || '-'}${custIdInfo}\n` +
                `*Status:* 4. PEMASANGAN SELESAI & AKTIF 🌐\n` +
                `*Teknisi:* ${actorName}\n` +
                `*Keterangan:*\n${completeNote}\n` +
                `*Waktu Selesai:* ${moment().format('DD MMMM YYYY HH:mm')} WIB\n\n` +
                `Terima kasih telah memilih layanan *${companyName}*. Selamat menikmati koneksi internet kami!`;

            waCustSent = await sendWaWithOptionalPhotos([updatedPsb.customer_phone], custMsg, savedPhotos);
        }

        // 2. Kirim WA Selesai Pasang (+ Foto Bukti) ke Nomor Admin
        let waAdminSent = false;
        const adminPhones = getAdminPhones(updatedPsb);
        if (adminPhones.length > 0) {
            const adminMsg =
                `✅ *[MONITORING ADMIN] PEMASANGAN BARU (PSB) SELESAI*\n\n` +
                `*No. PSB:* ${updatedPsb.psb_number}\n` +
                `*Pelanggan Baru:* ${updatedPsb.customer_name} (${updatedPsb.customer_phone})\n` +
                `*ID Pelanggan:* ${registeredCustomer ? registeredCustomer.customer_id : '-'}\n` +
                `*Alamat:* ${updatedPsb.customer_address || '-'}\n` +
                `*Paket:* ${updatedPsb.package_name || '-'}\n` +
                `*ODP / Redaman:* ${updatedPsb.odp_info || '-'}\n` +
                `*SN Modem:* ${updatedPsb.onu_serial || '-'}\n` +
                `*Teknisi:* ${actorName}\n` +
                `*Catatan Selesai:*\n${completeNote}\n` +
                `*Waktu Selesai:* ${moment().format('DD MMM YYYY HH:mm')} WIB`;

            waAdminSent = await sendWaWithOptionalPhotos(adminPhones, adminMsg, savedPhotos);
        }

        db.prepare('UPDATE psb_logs SET wa_customer_sent = ?, wa_admin_sent = ? WHERE id = ?')
            .run(waCustSent ? 1 : 0, waAdminSent ? 1 : 0, logId);

        db.prepare('INSERT INTO activity_log (action, description, user_id) VALUES (?, ?, ?)').run(
            'psb_completed',
            `Pemasangan PSB ${updatedPsb.psb_number} (${updatedPsb.customer_name}) selesai oleh ${actorName}`,
            req.session?.user?.id || null
        );

        req.flash('success', `Selamat! Pemasangan PSB ${updatedPsb.psb_number} telah selesai${registeredCustomer ? ` dan terdaftar sebagai pelanggan aktif (${registeredCustomer.customer_id})` : ''}. Notifikasi WhatsApp telah dikirim ke Pelanggan & Admin.`);
        res.redirect(`/psb/${psbId}`);
    } catch (error) {
        console.error('[PSB] Error completing PSB ticket:', error.message);
        req.flash('error', 'Gagal menyelesaikan tiket PSB: ' + error.message);
        res.redirect(`/psb/${psbId}`);
    }
});

// ============================================
// 8. POST /psb/:id/delete - Hapus Tiket PSB (Khusus Admin)
// ============================================
router.post('/:id/delete', isAdmin, (req, res) => {
    try {
        const psb = db.prepare('SELECT * FROM psb_tickets WHERE id = ?').get(req.params.id);
        if (!psb) {
            req.flash('error', 'Tiket PSB tidak ditemukan.');
            return res.redirect('/psb');
        }

        const photos = db.prepare('SELECT file_path FROM psb_photos WHERE psb_id = ?').all(psb.id);
        for (const ph of photos) {
            if (ph.file_path) {
                const abs = path.join(__dirname, '../public', ph.file_path);
                if (fs.existsSync(abs)) {
                    try { fs.unlinkSync(abs); } catch (e) {}
                }
            }
        }

        db.prepare('DELETE FROM psb_photos WHERE psb_id = ?').run(psb.id);
        db.prepare('DELETE FROM psb_logs WHERE psb_id = ?').run(psb.id);
        db.prepare('DELETE FROM psb_tickets WHERE id = ?').run(psb.id);

        req.flash('success', `Tiket PSB ${psb.psb_number} berhasil dihapus.`);
        res.redirect('/psb');
    } catch (error) {
        req.flash('error', 'Gagal menghapus tiket PSB: ' + error.message);
        res.redirect('/psb');
    }
});

module.exports = router;
