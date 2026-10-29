// Routes: Portal Tiket Gangguan Pelanggan
// Pelanggan hanya dapat membuat tiket gangguan baru, memantau (tracking) progress pengerjaan,
// dan berkomunikasi melalui kolom chat/catatan dengan teknisi.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const moment = require('moment');
try { require('moment/locale/id'); moment.locale('id'); } catch (e) {}

const db = require('../database/init');
const { isAuthenticated } = require('../middleware/auth');
const whatsappService = require('../services/whatsapp');
const customerScoring = require('../services/customer-scoring');

router.use(isAuthenticated);

// Pastikan direktori upload tersedia
const ticketUploadsDir = path.join(__dirname, '../public/uploads/tickets');
if (!fs.existsSync(ticketUploadsDir)) {
    try { fs.mkdirSync(ticketUploadsDir, { recursive: true }); } catch (e) {}
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(ticketUploadsDir)) {
            fs.mkdirSync(ticketUploadsDir, { recursive: true });
        }
        cb(null, ticketUploadsDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
        const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
        const uniqueName = `cust_${Date.now()}_${Math.round(Math.random() * 10000)}${safeExt}`;
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

function getPriorityLabel(priority) {
    const map = {
        'low': 'Rendah (Low)',
        'medium': 'Sedang (Normal)',
        'high': 'Tinggi (Urgent)',
        'critical': 'Darurat (Critical / LOS)'
    };
    return map[(priority || '').toLowerCase()] || 'Sedang (Normal)';
}

// ============================================
// 1. GET /portal - Halaman Utama Portal Pelanggan
// (Informasi Tagihan, Riwayat Pembayaran, Scoring/Ranking & Tiket Gangguan)
// ============================================
router.get('/', (req, res) => {
    try {
        const custId = req.session.user?.customer_id || req.session.user?.id;
        const customer = db.prepare(`
            SELECT c.*, p.name as package_name, p.speed_down, p.speed_up, p.price as package_price
            FROM customers c
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE c.id = ?
        `).get(custId);

        if (!customer) {
            req.flash('error', 'Data pelanggan tidak ditemukan.');
            return res.redirect('/auth/logout');
        }

        // Ambil daftar Tiket Gangguan pelanggan
        const tickets = db.prepare(`
            SELECT t.*,
                   (SELECT COUNT(*) FROM ticket_photos tp WHERE tp.ticket_id = t.id) as photo_count,
                   (SELECT COUNT(*) FROM ticket_logs tl WHERE tl.ticket_id = t.id) as log_count,
                   (SELECT COUNT(*) FROM ticket_messages tm WHERE tm.ticket_id = t.id) as chat_count
            FROM tickets t
            WHERE t.customer_id = ?
            ORDER BY
                CASE t.status
                    WHEN 'open' THEN 1
                    WHEN 'accepted' THEN 2
                    WHEN 'in_progress' THEN 3
                    WHEN 'resolved' THEN 4
                    ELSE 5
                END ASC,
                t.created_at DESC
        `).all(customer.id);

        // Ambil daftar Tagihan (Invoices) pelanggan beserta info pembayaran terakhir
        const rawInvoices = db.prepare(`
            SELECT i.*,
                   (SELECT payment_date FROM payments pm WHERE pm.invoice_id = i.id ORDER BY pm.payment_date DESC, pm.id DESC LIMIT 1) as payment_date,
                   (SELECT payment_method FROM payments pm WHERE pm.invoice_id = i.id ORDER BY pm.payment_date DESC, pm.id DESC LIMIT 1) as payment_method,
                   (SELECT received_by FROM payments pm WHERE pm.invoice_id = i.id ORDER BY pm.payment_date DESC, pm.id DESC LIMIT 1) as received_by
            FROM invoices i
            WHERE i.customer_id = ?
            ORDER BY i.period DESC, i.created_at DESC
        `).all(customer.id);

        // Evaluasi ketepatan waktu bayar tiap invoice
        const todayMoment = moment().startOf('day');
        const invoices = rawInvoices.map(inv => ({
            ...inv,
            scoring: customerScoring.evaluateSingleInvoice(inv, todayMoment)
        }));

        // Ambil Riwayat Pembayaran (Payments) pelanggan
        const payments = db.prepare(`
            SELECT pm.*, i.invoice_number, i.period, i.due_date, i.paid_date
            FROM payments pm
            JOIN invoices i ON pm.invoice_id = i.id
            WHERE i.customer_id = ?
            ORDER BY pm.payment_date DESC, pm.id DESC
        `).all(customer.id).map(pm => ({
            ...pm,
            scoring: customerScoring.evaluateSingleInvoice({
                id: pm.invoice_id,
                invoice_number: pm.invoice_number,
                period: pm.period,
                due_date: pm.due_date,
                paid_date: pm.payment_date || pm.paid_date,
                status: 'paid'
            }, todayMoment)
        }));

        // Hitung Scoring & Ranking Pelanggan dibandingkan seluruh pelanggan
        const allRankingsData = customerScoring.getAllCustomerRankings(db);
        const myRankObj = allRankingsData.rankings.find(r => r.customerId === customer.id)
            || customerScoring.calculateCustomerScore(customer, rawInvoices);

        // Statistik Tagihan & Tiket
        const unpaidInvoicesList = invoices.filter(i => i.status === 'unpaid');
        const paidInvoicesList = invoices.filter(i => i.status === 'paid');
        const totalUnpaidAmount = unpaidInvoicesList.reduce((sum, i) => sum + Number(i.amount || 0), 0);
        const totalPaidAmount = paidInvoicesList.reduce((sum, i) => sum + Number(i.amount || 0), 0);

        const stats = {
            total: tickets.length,
            active: tickets.filter(t => t.status !== 'resolved').length,
            resolved: tickets.filter(t => t.status === 'resolved').length,
            unpaidInvoicesCount: unpaidInvoicesList.length,
            paidInvoicesCount: paidInvoicesList.length,
            totalUnpaidAmount,
            totalPaidAmount
        };

        // Pengaturan rekening pembayaran untuk ditampilkan pada info pembayaran tagihan
        const paymentSettingsRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'payment_%'").all();
        const paymentSettings = {};
        paymentSettingsRows.forEach(r => paymentSettings[r.key] = r.value);

        res.render('portal-customer', {
            title: 'Dashboard Portal Pelanggan',
            activePage: 'portal',
            customer,
            tickets,
            invoices,
            unpaidInvoicesList,
            payments,
            customerScore: myRankObj,
            totalCustomersCount: allRankingsData.summary.total,
            tierDefinitions: customerScoring.TIER_DEFINITIONS,
            paymentSettings,
            stats,
            isStaticConnection: isStaticCustomer(customer),
            routerUrl: isStaticCustomer(customer) ? buildGatewayUrl(customer) : null,
            moment
        });
    } catch (error) {
        console.error('[Portal] Error loading customer portal:', error.message);
        req.flash('error', 'Gagal memuat portal pelanggan: ' + error.message);
        res.redirect('/login');
    }
});

// ============================================
// 1B. GET /portal/invoices/:id/print - Cetak / Lihat Invoice Tagihan Milik Pelanggan
// ============================================
router.get('/invoices/:id/print', (req, res) => {
    try {
        const custId = req.session.user?.customer_id || req.session.user?.id;
        const invoice = db.prepare(`
            SELECT i.*, 
                   c.name as customer_name, c.customer_id, c.phone as customer_phone, c.address as customer_address,
                   c.connection_type, c.ip_address, c.pppoe_username,
                   p.name as package_name, p.speed_down, p.speed_up
            FROM invoices i
            JOIN customers c ON i.customer_id = c.id
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE i.id = ? AND i.customer_id = ?
        `).get(req.params.id, custId);

        if (!invoice) {
            req.flash('error', 'Invoice tidak ditemukan atau bukan milik akun Anda.');
            return res.redirect('/portal');
        }

        const payments = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY payment_date DESC').all(invoice.id);
        const companyName = getSetting('company_name', 'PT. Lintas Jaringan Nusantara');
        const companyPhone = getSetting('company_phone', '');
        const companyAddress = getSetting('company_address', '');

        const paymentSettingsRows = db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all('payment_%');
        const paymentSettings = {};
        paymentSettingsRows.forEach(r => paymentSettings[r.key] = r.value);

        res.render('invoice-print', {
            title: `Invoice - ${invoice.invoice_number}`,
            invoice,
            payments,
            companyName,
            companyPhone,
            companyAddress,
            companyLogo: '/img/logo.png',
            paymentSettings,
            moment
        });
    } catch (error) {
        console.error('[Portal] Error printing invoice:', error.message);
        req.flash('error', 'Gagal memuat dokumen invoice.');
        res.redirect('/portal');
    }
});

// ============================================
// 2. POST /portal/tickets - Pelanggan Membuat Tiket Gangguan Baru
// ============================================
router.post('/tickets', upload.array('photos', 5), async (req, res) => {
    try {
        const custId = req.session.user?.customer_id || req.session.user?.id;
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(custId);

        if (!customer) {
            req.flash('error', 'Sesi pelanggan tidak valid.');
            return res.redirect('/login?mode=pelanggan');
        }

        const { category, priority, description, photo_caption } = req.body;
        if (!description || !description.trim()) {
            req.flash('error', 'Mohon jelaskan keluhan atau kondisi gangguan internet Anda.');
            return res.redirect('/portal');
        }

        // Ambil teknisi aktif untuk ditugaskan dan dikirimi WA
        const activeTechs = db.prepare('SELECT * FROM technicians WHERE is_active = 1').all();
        const techId = activeTechs.length > 0 ? activeTechs[0].id : null;
        const techName = activeTechs.length > 0
            ? (activeTechs.length === 1 ? activeTechs[0].name : activeTechs.map(t => t.name).join(', '))
            : 'Tim Teknisi';
        const techPhone = activeTechs.map(t => t.phone).filter(Boolean).join(', ');
        const targetTechPhones = activeTechs.map(t => t.phone).filter(Boolean);

        // Buat Nomor Tiket: TKT-YYYYMM-XXXX
        const ym = moment().format('YYYYMM');
        const prefix = `TKT-${ym}-`;
        const lastTicket = db.prepare("SELECT ticket_number FROM tickets WHERE ticket_number LIKE ? ORDER BY id DESC LIMIT 1").get(`${prefix}%`);
        let nextSeq = 1;
        if (lastTicket && lastTicket.ticket_number) {
            const parts = lastTicket.ticket_number.split('-');
            const lastNum = parseInt(parts[2], 10);
            if (!isNaN(lastNum)) nextSeq = lastNum + 1;
        }
        const ticketNumber = `${prefix}${String(nextSeq).padStart(4, '0')}`;

        const ticketCategory = (category || 'Koneksi Terputus (LOS Merah)').trim();
        const ticketDesc = description.trim();
        const ticketPriority = priority || (ticketCategory.includes('LOS') ? 'critical' : 'high');

        const insertResult = db.prepare(`
            INSERT INTO tickets (
                ticket_number, customer_id, customer_name, customer_phone, customer_address,
                category, priority, subject, description, status,
                technician_id, technician_name, technician_phone,
                created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
        `).run(
            ticketNumber,
            customer.id,
            customer.name,
            customer.phone || '',
            customer.address || '',
            ticketCategory,
            ticketPriority,
            ticketCategory,
            ticketDesc,
            techId,
            techName,
            techPhone,
            `${customer.name} (Portal Pelanggan)`
        );

        const ticketId = insertResult.lastInsertRowid;

        // Catat log awal
        const logInsert = db.prepare(`
            INSERT INTO ticket_logs (ticket_id, status, title, description, actor_name, wa_sent, wa_target, created_at)
            VALUES (?, 'open', ?, ?, ?, 0, ?, datetime('now', 'localtime'))
        `).run(
            ticketId,
            'Laporan Gangguan Dibuat oleh Pelanggan',
            `Kategori: ${ticketCategory}\nKeluhan: ${ticketDesc}`,
            customer.name,
            targetTechPhones.join(', ')
        );
        const logId = logInsert.lastInsertRowid;

        // Simpan foto lampiran jika ada
        const savedPhotos = [];
        if (req.files && req.files.length > 0) {
            const insertPhoto = db.prepare(`
                INSERT INTO ticket_photos (ticket_id, log_id, stage, file_path, file_name, caption, uploaded_by, created_at)
                VALUES (?, ?, 'report', ?, ?, ?, ?, datetime('now', 'localtime'))
            `);
            for (const file of req.files) {
                const relPath = `/uploads/tickets/${file.filename}`;
                insertPhoto.run(
                    ticketId,
                    logId,
                    relPath,
                    file.originalname || file.filename,
                    photo_caption || `Foto Laporan Pelanggan (${customer.name})`,
                    customer.name
                );
                savedPhotos.push({ file_path: relPath });
            }
        }

        // Tambahkan juga pesan pertama di kolom chat agar rapi
        db.prepare(`
            INSERT INTO ticket_messages (ticket_id, sender_role, sender_name, message, photo_path, created_at)
            VALUES (?, 'customer', ?, ?, ?, datetime('now', 'localtime'))
        `).run(
            ticketId,
            customer.name,
            `[Laporan Awal - ${ticketCategory}]\n${ticketDesc}`,
            savedPhotos.length > 0 ? savedPhotos[0].file_path : null
        );

        // Kirim WhatsApp otomatis ke Nomor Teknisi
        let waSent = false;
        if (targetTechPhones.length > 0) {
            const companyName = getSetting('company_name', 'PT. Lintas Jaringan Nusantara');
            const mapsLink = (customer.latitude && customer.longitude)
                ? `https://www.google.com/maps?q=${customer.latitude},${customer.longitude}`
                : '-';

            const template = getSetting(
                'ticket_wa_tech_template',
                '🚨 *LAPORAN TIKET GANGGUAN BARU*\n\nHalo Tim Teknisi ({technician_name}), terdapat laporan gangguan baru dari pelanggan:\n\n*No. Tiket:* {ticket_number}\n*Pelanggan:* {customer_name} ({customer_id})\n*No. HP:* {customer_phone}\n*Alamat:* {customer_address}\n*Lokasi Maps:* {maps_link}\n*Kategori:* {category}\n*Prioritas:* {priority}\n*Keluhan:* {description}\n*Waktu Lapor:* {created_at}\n\nMohon segera dicek dan ditindaklanjuti.\n_{company_name}_'
            );

            const waMsg = template
                .split('{ticket_number}').join(ticketNumber)
                .split('{technician_name}').join(techName)
                .split('{customer_name}').join(customer.name)
                .split('{customer_id}').join(customer.customer_id || '-')
                .split('{customer_phone}').join(customer.phone || '-')
                .split('{customer_address}').join(customer.address || '-')
                .split('{maps_link}').join(mapsLink)
                .split('{category}').join(ticketCategory)
                .split('{priority}').join(getPriorityLabel(ticketPriority))
                .split('{description}').join(ticketDesc)
                .split('{created_at}').join(moment().format('DD MMMM YYYY HH:mm') + ' WIB')
                .split('{company_name}').join(companyName);

            for (const phone of targetTechPhones) {
                try {
                    if (savedPhotos.length > 0) {
                        const firstAbs = path.join(__dirname, '../public', savedPhotos[0].file_path);
                        if (fs.existsSync(firstAbs)) {
                            await whatsappService.sendImage(phone, firstAbs, waMsg);
                            waSent = true;
                            continue;
                        }
                    }
                    await whatsappService.sendMessage(phone, waMsg);
                    waSent = true;
                } catch (waErr) {
                    console.warn('[Portal] Gagal kirim WA ke teknisi:', waErr.message);
                }
            }

            if (waSent) {
                db.prepare('UPDATE tickets SET wa_tech_sent = 1 WHERE id = ?').run(ticketId);
                db.prepare('UPDATE ticket_logs SET wa_sent = 1 WHERE id = ?').run(logId);
            }
        }

        db.prepare('INSERT INTO activity_log (action, description, user_id) VALUES (?, ?, ?)').run(
            'customer_ticket_created',
            `Pelanggan ${customer.name} membuat tiket gangguan ${ticketNumber} via Portal Pelanggan`,
            customer.id
        );

        req.flash('success', `Laporan tiket gangguan ${ticketNumber} berhasil dikirim! Tim teknisi kami telah menerima notifikasi WhatsApp dan akan segera menangani laporan Anda.`);
        res.redirect(`/portal/tickets/${ticketId}`);
    } catch (error) {
        console.error('[Portal] Error creating customer ticket:', error.message);
        req.flash('error', 'Gagal membuat laporan tiket: ' + error.message);
        res.redirect('/portal');
    }
});

// ============================================
// 3. GET /portal/tickets/:id - Halaman Tracking Progress & Chat Teknisi
// ============================================
router.get('/tickets/:id', (req, res) => {
    try {
        const custId = req.session.user?.customer_id || req.session.user?.id;
        const ticketId = req.params.id;

        const ticket = db.prepare(`
            SELECT t.*, p.name as package_name
            FROM tickets t
            LEFT JOIN customers c ON t.customer_id = c.id
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE t.id = ? AND t.customer_id = ?
        `).get(ticketId, custId);

        if (!ticket) {
            req.flash('error', 'Tiket gangguan tidak ditemukan atau bukan milik akun Anda.');
            return res.redirect('/portal');
        }

        const logs = db.prepare(`
            SELECT * FROM ticket_logs
            WHERE ticket_id = ?
            ORDER BY created_at ASC, id ASC
        `).all(ticketId);

        const photos = db.prepare(`
            SELECT * FROM ticket_photos
            WHERE ticket_id = ?
            ORDER BY created_at ASC, id ASC
        `).all(ticketId);

        const photosByLog = {};
        for (const ph of photos) {
            if (ph.log_id) {
                if (!photosByLog[ph.log_id]) photosByLog[ph.log_id] = [];
                photosByLog[ph.log_id].push(ph);
            }
        }

        const chatMessages = db.prepare(`
            SELECT * FROM ticket_messages
            WHERE ticket_id = ?
            ORDER BY created_at ASC, id ASC
        `).all(ticketId);

        res.render('portal-ticket-detail', {
            title: `Track Tiket ${ticket.ticket_number}`,
            activePage: 'portal',
            ticket,
            logs,
            photos,
            photosByLog,
            chatMessages,
            moment
        });
    } catch (error) {
        console.error('[Portal] Error loading ticket tracking:', error.message);
        req.flash('error', 'Gagal memuat detail tiket: ' + error.message);
        res.redirect('/portal');
    }
});

// ============================================
// 4. POST /portal/tickets/:id/chat - Pelanggan Kirim Chat / Catatan ke Teknisi
// ============================================
router.post('/tickets/:id/chat', upload.single('photo'), async (req, res) => {
    const ticketId = req.params.id;
    try {
        const custId = req.session.user?.customer_id || req.session.user?.id;
        const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND customer_id = ?').get(ticketId, custId);

        if (!ticket) {
            if (req.xhr) return res.status(404).json({ error: 'Tiket tidak ditemukan' });
            req.flash('error', 'Tiket tidak ditemukan.');
            return res.redirect('/portal');
        }

        const msgText = (req.body.message || '').trim();
        const photoPath = req.file ? `/uploads/tickets/${req.file.filename}` : null;

        if (!msgText && !photoPath) {
            req.flash('warning', 'Pesan atau foto tidak boleh kosong.');
            return res.redirect(`/portal/tickets/${ticketId}#chat-section`);
        }

        const senderName = req.session.user?.name || ticket.customer_name;

        db.prepare(`
            INSERT INTO ticket_messages (ticket_id, sender_role, sender_name, message, photo_path, created_at)
            VALUES (?, 'customer', ?, ?, ?, datetime('now', 'localtime'))
        `).run(ticketId, senderName, msgText || 'Melampirkan foto pada chat', photoPath);

        // Jika ada foto yang dilampirkan di chat, simpan juga ke arsip foto tiket
        if (photoPath && req.file) {
            db.prepare(`
                INSERT INTO ticket_photos (ticket_id, stage, file_path, file_name, caption, uploaded_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
            `).run(
                ticketId,
                ticket.status === 'open' ? 'report' : 'in_progress',
                photoPath,
                req.file.originalname || req.file.filename,
                msgText || `Foto Chat Pelanggan - ${ticket.ticket_number}`,
                senderName
            );
        }

        // Kirim notifikasi WhatsApp ke Teknisi yang bertugas bahwa pelanggan mengirim pesan/catatan baru
        let techPhones = [];
        if (ticket.technician_phone) {
            techPhones = ticket.technician_phone.split(',').map(p => p.trim()).filter(Boolean);
        } else {
            const activeTechs = db.prepare('SELECT phone FROM technicians WHERE is_active = 1').all();
            techPhones = activeTechs.map(t => t.phone).filter(Boolean);
        }

        if (techPhones.length > 0) {
            const waText = `💬 *PESAN / CATATAN BARU DARI PELANGGAN*\n\n*No. Tiket:* ${ticket.ticket_number}\n*Pelanggan:* ${ticket.customer_name}\n*Pesan:*\n"${msgText || '(Melampirkan Foto)'}"\n\n_Silakan balas melalui Portal Teknisi pada detail tiket ${ticket.ticket_number}._`;
            for (const phone of techPhones) {
                try {
                    if (photoPath) {
                        const absPhoto = path.join(__dirname, '../public', photoPath);
                        if (fs.existsSync(absPhoto)) {
                            await whatsappService.sendImage(phone, absPhoto, waText);
                            continue;
                        }
                    }
                    await whatsappService.sendMessage(phone, waText);
                } catch (e) {}
            }
        }

        req.flash('success', 'Pesan / catatan berhasil dikirim ke Teknisi.');
        res.redirect(`/portal/tickets/${ticketId}#chat-section`);
    } catch (error) {
        console.error('[Portal] Error sending customer chat:', error.message);
        req.flash('error', 'Gagal mengirim pesan: ' + error.message);
        res.redirect(`/portal/tickets/${ticketId}#chat-section`);
    }
});

// ============================================
// 5. GET /portal/tickets/:id/messages - JSON Polling Chat Realtime
// ============================================
router.get('/tickets/:id/messages', (req, res) => {
    try {
        const custId = req.session.user?.customer_id || req.session.user?.id;
        const ticket = db.prepare('SELECT id, status FROM tickets WHERE id = ? AND customer_id = ?').get(req.params.id, custId);
        if (!ticket) return res.status(404).json({ error: 'Not found' });

        const messages = db.prepare(`
            SELECT * FROM ticket_messages
            WHERE ticket_id = ?
            ORDER BY created_at ASC, id ASC
        `).all(ticket.id);

        res.json({
            status: ticket.status,
            messages: messages.map(m => ({
                ...m,
                formatted_time: moment(m.created_at).format('DD/MM HH:mm')
            }))
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// WIFI SELF-SERVICE (GenieACS) & TAUTAN ROUTER (IP STATIK)
// - Pelanggan PPPoE : ganti nama WiFi (SSID) & sandi WiFi sendiri via GenieACS
// - Pelanggan IP Statik : hanya tautan menuju halaman login IP gateway router
// ============================================
const genieacsService = require('../services/genieacs');

const wifiChangeLog = new Map(); // customerId -> [timestamp, ...]
const WIFI_CHANGE_LIMIT = 5;
const WIFI_CHANGE_WINDOW_MS = 60 * 60 * 1000;

function getCurrentCustomer(req) {
    const user = req.session && req.session.user;
    if (!user || user.role !== 'customer') return null;
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(user.customer_id || user.id) || null;
}

function isStaticCustomer(customer) {
    return (customer.connection_type || 'pppoe').toLowerCase() === 'static';
}

/**
 * Bangun URL login router pelanggan IP Statik (hanya IPv4 / hostname valid, cegah injeksi URL)
 */
function buildGatewayUrl(customer) {
    let raw = String(customer.gateway_ip || customer.ip_address || '').trim().split('/')[0].trim();
    raw = raw.replace(/^https?:\/\//i, '');
    const m = raw.match(/^([A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(:\d{1,5})?$/);
    if (!m) return null;
    const host = m[1];
    if (/^[\d.]+$/.test(host)) {
        const parts = host.split('.');
        if (parts.length !== 4 || parts.some(p => p === '' || parseInt(p, 10) > 255)) return null;
    }
    return `http://${host}${m[3] || ''}`;
}

function configureGenieACSFromSettings() {
    const url = getSetting('genieacs_url', 'http://localhost:7557');
    genieacsService.configure(url);
}

// GET /portal/wifi/status - Info WiFi / router sesuai jenis koneksi pelanggan
router.get('/wifi/status', async (req, res) => {
    try {
        const customer = getCurrentCustomer(req);
        if (!customer) return res.status(403).json({ success: false, message: 'Akses ditolak.' });

        if (isStaticCustomer(customer)) {
            return res.json({ success: true, mode: 'static', routerUrl: buildGatewayUrl(customer) });
        }

        if (!customer.onu_serial && !customer.pppoe_username) {
            return res.json({ success: true, mode: 'pppoe', found: false, message: 'Perangkat WiFi Anda belum tertaut ke sistem. Hubungi admin.' });
        }

        configureGenieACSFromSettings();
        const found = await genieacsService.findDeviceForCustomer(customer);
        if (!found) {
            return res.json({ success: true, mode: 'pppoe', found: false, message: 'Perangkat WiFi (ONT) Anda belum terdeteksi di sistem. Hubungi admin.' });
        }

        const p = found.parsed;
        const bands = genieacsService.extractWifiBands(found.raw);
        return res.json({
            success: true,
            mode: 'pppoe',
            found: true,
            online: !!p.isOnline,
            lastInform: p.lastInformDate ? moment(p.lastInformDate).format('DD MMM YYYY HH:mm') : null,
            activeDevices: p.activeDevicesCount || 0,
            bands: bands.map(b => ({ index: b.index, ssid: b.ssid, band: b.band }))
        });
    } catch (error) {
        console.error('[Portal WiFi] Gagal memuat status:', error.message);
        return res.status(503).json({ success: false, message: 'Layanan pengelolaan WiFi sedang tidak dapat dihubungi. Silakan coba lagi nanti.' });
    }
});

// POST /portal/wifi/update - Ganti nama WiFi (SSID) dan/atau sandi WiFi milik sendiri
router.post('/wifi/update', async (req, res) => {
    try {
        const customer = getCurrentCustomer(req);
        if (!customer) return res.status(403).json({ success: false, message: 'Akses ditolak.' });

        if (isStaticCustomer(customer)) {
            return res.status(403).json({ success: false, message: 'Pengaturan WiFi dari portal hanya tersedia untuk pelanggan PPPoE. Gunakan tautan login router Anda.' });
        }

        const ssid = String(req.body.ssid || '').trim();
        const password = String(req.body.password || '');
        const bandParam = String(req.body.band || 'all');

        if (!ssid && !password) {
            return res.status(400).json({ success: false, message: 'Isi nama WiFi baru dan/atau sandi WiFi baru.' });
        }
        if (ssid && (ssid.length > 32 || /[\x00-\x1F\x7F]/.test(ssid))) {
            return res.status(400).json({ success: false, message: 'Nama WiFi maksimal 32 karakter dan tidak boleh mengandung karakter kontrol.' });
        }
        if (password && (password.length < 8 || password.length > 63 || !/^[\x20-\x7E]+$/.test(password))) {
            return res.status(400).json({ success: false, message: 'Sandi WiFi harus 8-63 karakter (huruf, angka, atau simbol biasa).' });
        }

        // Batasi frekuensi perubahan (cegah penyalahgunaan)
        const now = Date.now();
        const history = (wifiChangeLog.get(customer.id) || []).filter(ts => now - ts < WIFI_CHANGE_WINDOW_MS);
        if (history.length >= WIFI_CHANGE_LIMIT) {
            return res.status(429).json({ success: false, message: 'Terlalu sering mengganti WiFi. Coba lagi dalam 1 jam.' });
        }

        configureGenieACSFromSettings();
        const found = await genieacsService.findDeviceForCustomer(customer);
        if (!found) {
            return res.status(404).json({ success: false, message: 'Perangkat WiFi (ONT) Anda belum terdeteksi di sistem. Hubungi admin.' });
        }

        const bands = genieacsService.extractWifiBands(found.raw);
        if (bands.length === 0) {
            return res.status(404).json({ success: false, message: 'Pengaturan WiFi pada perangkat Anda tidak ditemukan. Hubungi admin.' });
        }

        let indexes;
        if (bandParam === 'all') {
            indexes = bands.map(b => b.index);
        } else {
            const idx = parseInt(bandParam, 10);
            if (!bands.some(b => b.index === idx)) {
                return res.status(400).json({ success: false, message: 'Band WiFi tidak valid.' });
            }
            indexes = [idx];
        }

        const result = await genieacsService.setWifiBands(found.parsed.id || found.raw._id, indexes, { ssid, password });

        history.push(now);
        wifiChangeLog.set(customer.id, history);

        try {
            const changed = [ssid ? 'nama WiFi' : null, password ? 'sandi WiFi' : null].filter(Boolean).join(' & ');
            db.prepare('INSERT INTO activity_log (action, description, user_id) VALUES (?, ?, ?)')
                .run('customer_wifi_change', `Pelanggan ${customer.name} (${customer.customer_id}) mengganti ${changed} via Portal Pelanggan`, customer.id);
        } catch (e) { /* abaikan error log */ }

        return res.json({
            success: true,
            immediate: !!result.immediate,
            message: result.immediate
                ? 'Pengaturan WiFi berhasil dikirim ke perangkat. WiFi akan terputus sesaat, silakan hubungkan ulang dengan nama/sandi baru.'
                : 'Perintah tersimpan. Perangkat sedang tidak merespons, perubahan akan diterapkan otomatis saat perangkat online kembali.'
        });
    } catch (error) {
        console.error('[Portal WiFi] Gagal mengganti WiFi:', error.message);
        return res.status(503).json({ success: false, message: 'Gagal mengirim pengaturan ke perangkat. Silakan coba lagi nanti.' });
    }
});

module.exports = router;
