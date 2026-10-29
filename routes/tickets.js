// Routes: Tiket Gangguan & Helpdesk Pelanggan
// Mengelola laporan gangguan, penugasan teknisi, notifikasi WhatsApp otomatis bertahap, dan arsip foto dokumentasi

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
const bcrypt = require('bcryptjs');

// Terapkan middleware autentikasi ke semua route
router.use(isAuthenticated);

// ============================================
// Konfigurasi Upload Foto Arsip Tiket Gangguan
// ============================================
const ticketUploadsDir = path.join(__dirname, '../public/uploads/tickets');
if (!fs.existsSync(ticketUploadsDir)) {
    try {
        fs.mkdirSync(ticketUploadsDir, { recursive: true });
    } catch (e) {
        console.error('[Tickets] Gagal membuat direktori upload tiket:', e.message);
    }
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
        const uniqueName = `tkt_${Date.now()}_${Math.round(Math.random() * 10000)}${safeExt}`;
        cb(null, uniqueName);
    }
});

const uploadTicketPhotos = multer({
    storage,
    limits: { fileSize: 15 * 1024 * 1024 }, // Maks 15MB per foto
    fileFilter: (req, file, cb) => {
        if (file.mimetype && file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Hanya file gambar/foto (JPG, PNG, WEBP) yang diperbolehkan'));
        }
    }
});

// ============================================
// Helper Functions
// ============================================
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

function getStatusLabel(status) {
    const map = {
        'open': 'BARU / MENUNGGU',
        'accepted': 'DITERIMA TEKNISI',
        'in_progress': 'SEDANG DITANGANI',
        'resolved': 'SELESAI'
    };
    return map[(status || '').toLowerCase()] || 'BARU';
}

/**
 * Format template pesan WhatsApp Tiket Gangguan
 */
function formatTicketMessage(templateKey, ticket, extra = {}) {
    const defaultTemplates = {
        ticket_wa_tech_template: '🚨 *LAPORAN TIKET GANGGUAN BARU*\n\nHalo Tim Teknisi ({technician_name}), terdapat laporan gangguan baru dari pelanggan:\n\n*No. Tiket:* {ticket_number}\n*Pelanggan:* {customer_name} ({customer_id})\n*No. HP:* {customer_phone}\n*Alamat:* {customer_address}\n*Lokasi Maps:* {maps_link}\n*Kategori:* {category}\n*Prioritas:* {priority}\n*Keluhan:* {description}\n*Waktu Lapor:* {created_at}\n\nMohon segera dicek dan ditindaklanjuti.\n_{company_name}_',
        ticket_wa_accepted_template: 'Yth. *{customer_name}*,\n\nLaporan gangguan layanan internet Anda telah *DITERIMA* oleh tim teknisi kami dan sedang dijadwalkan untuk penanganan:\n\n*No. Tiket:* {ticket_number}\n*Kategori:* {category}\n*Status:* DITERIMA TEKNISI 📋\n*Teknisi Bertugas:* {technician_name}\n*Kontak Teknisi:* {technician_phone}\n*Keterangan:* {note}\n\nKami akan menginformasikan kembali saat teknisi mulai melakukan pengerjaan. Mohon maaf atas ketidaknyamanannya.\n\nSalam,\n*{company_name}*',
        ticket_wa_progress_template: 'Yth. *{customer_name}*,\n\nBerikut adalah informasi *PROGRESS PENGERJAAN* tiket gangguan internet Anda:\n\n*No. Tiket:* {ticket_number}\n*Status:* SEDANG DITANGANI ⚙️\n*Teknisi:* {technician_name}\n*Update Progress:*\n{note}\n*Waktu Update:* {updated_at}\n\nTim kami sedang mengupayakan perbaikan secepat mungkin. Terima kasih atas kesabaran Anda.\n\nSalam,\n*{company_name}*',
        ticket_wa_resolved_template: 'Yth. *{customer_name}*,\n\nKabar baik! Penanganan tiket gangguan internet Anda telah *SELESAI* ✅\n\n*No. Tiket:* {ticket_number}\n*Status:* SELESAI / NORMAL KEMBALI\n*Teknisi:* {technician_name}\n*Tindakan / Solusi:*\n{note}\n*Waktu Selesai:* {resolved_at}\n\nSilakan periksa kembali koneksi internet Anda. Apabila masih terdapat kendala, jangan ragu untuk menghubungi kami kembali.\n\nTerima kasih atas kepercayaan Anda menggunakan layanan *{company_name}*.'
    };

    const template = getSetting(templateKey, defaultTemplates[templateKey] || '');
    const companyName = getSetting('company_name', 'PT. Lintas Jaringan Nusantara');
    const companyPhone = getSetting('company_phone', '');

    let customerCode = extra.customer_code || '-';
    let mapsLink = '-';
    let pppoeUser = '-';
    let ipAddress = '-';

    if (ticket.customer_id) {
        try {
            const cust = db.prepare('SELECT customer_id, latitude, longitude, pppoe_username, ip_address FROM customers WHERE id = ?').get(ticket.customer_id);
            if (cust) {
                customerCode = cust.customer_id || customerCode;
                pppoeUser = cust.pppoe_username || '-';
                ipAddress = cust.ip_address || '-';
                if (cust.latitude && cust.longitude) {
                    mapsLink = `https://www.google.com/maps?q=${cust.latitude},${cust.longitude}`;
                }
            }
        } catch (e) {}
    }

    const replacements = {
        '{ticket_number}': ticket.ticket_number || '-',
        '{no_tiket}': ticket.ticket_number || '-',
        '{customer_name}': ticket.customer_name || '-',
        '{nama_pelanggan}': ticket.customer_name || '-',
        '{customer_id}': customerCode,
        '{id_pelanggan}': customerCode,
        '{customer_phone}': ticket.customer_phone || '-',
        '{no_hp}': ticket.customer_phone || '-',
        '{customer_address}': ticket.customer_address || '-',
        '{alamat}': ticket.customer_address || '-',
        '{maps_link}': mapsLink,
        '{pppoe_username}': pppoeUser,
        '{ip_address}': ipAddress,
        '{category}': ticket.category || 'Gangguan Internet',
        '{kategori}': ticket.category || 'Gangguan Internet',
        '{priority}': getPriorityLabel(ticket.priority),
        '{prioritas}': getPriorityLabel(ticket.priority),
        '{subject}': ticket.subject || ticket.category || '-',
        '{judul}': ticket.subject || ticket.category || '-',
        '{description}': ticket.description || ticket.subject || '-',
        '{keluhan}': ticket.description || ticket.subject || '-',
        '{status}': getStatusLabel(extra.status || ticket.status),
        '{technician_name}': extra.technician_name || ticket.technician_name || 'Tim Teknisi',
        '{nama_teknisi}': extra.technician_name || ticket.technician_name || 'Tim Teknisi',
        '{technician_phone}': extra.technician_phone || ticket.technician_phone || companyPhone || '-',
        '{no_teknisi}': extra.technician_phone || ticket.technician_phone || companyPhone || '-',
        '{note}': extra.note || ticket.resolution_notes || ticket.description || '-',
        '{catatan}': extra.note || ticket.resolution_notes || ticket.description || '-',
        '{solusi}': extra.note || ticket.resolution_notes || '-',
        '{created_at}': ticket.created_at ? moment(ticket.created_at).format('DD MMMM YYYY HH:mm') + ' WIB' : moment().format('DD MMMM YYYY HH:mm') + ' WIB',
        '{updated_at}': moment().format('DD MMMM YYYY HH:mm') + ' WIB',
        '{resolved_at}': ticket.resolved_at ? moment(ticket.resolved_at).format('DD MMMM YYYY HH:mm') + ' WIB' : moment().format('DD MMMM YYYY HH:mm') + ' WIB',
        '{company_name}': companyName,
        '{nama_perusahaan}': companyName,
        '{company_phone}': companyPhone
    };

    let result = template;
    for (const [key, val] of Object.entries(replacements)) {
        result = result.split(key).join(val !== undefined && val !== null ? String(val) : '');
    }
    return result;
}

/**
 * Kirim notifikasi WhatsApp beserta foto (jika ada & diaktifkan)
 */
async function sendTicketWhatsApp(phones, message, savedPhotos = [], sendPhotoToWa = true) {
    const targetPhones = (Array.isArray(phones) ? phones : [phones])
        .map(p => (p || '').trim())
        .filter(p => p.length >= 8);

    if (targetPhones.length === 0) {
        return { sent: false, count: 0, error: 'Nomor WhatsApp tujuan kosong atau tidak valid' };
    }

    let successCount = 0;
    let lastError = null;

    for (const phone of targetPhones) {
        try {
            if (sendPhotoToWa && Array.isArray(savedPhotos) && savedPhotos.length > 0) {
                const firstPhotoAbs = path.join(__dirname, '../public', savedPhotos[0].file_path);
                if (fs.existsSync(firstPhotoAbs)) {
                    try {
                        await whatsappService.sendImage(phone, firstPhotoAbs, message);
                        // Jika ada foto ke-2 dst, kirim juga sebagai lampiran foto
                        for (let i = 1; i < savedPhotos.length; i++) {
                            const nextAbs = path.join(__dirname, '../public', savedPhotos[i].file_path);
                            if (fs.existsSync(nextAbs)) {
                                await whatsappService.sendImage(phone, nextAbs, savedPhotos[i].caption || `Lampiran Foto #${i + 1}`);
                            }
                        }
                        successCount++;
                        continue;
                    } catch (imgErr) {
                        console.warn('[Tickets] Gagal kirim gambar WA, fallback ke pesan teks:', imgErr.message);
                    }
                }
            }
            await whatsappService.sendMessage(phone, message);
            successCount++;
        } catch (err) {
            console.error(`[Tickets] Gagal kirim WA ke ${phone}:`, err.message);
            lastError = err.message;
        }
    }

    return {
        sent: successCount > 0,
        count: successCount,
        targets: targetPhones.join(', '),
        error: lastError
    };
}

/**
 * Simpan berkas foto yang diupload ke tabel ticket_photos
 */
function saveUploadedPhotos(files, ticketId, logId, stage, caption, uploadedBy) {
    if (!files || !Array.isArray(files) || files.length === 0) return [];
    const insertPhoto = db.prepare(`
        INSERT INTO ticket_photos (ticket_id, log_id, stage, file_path, file_name, caption, uploaded_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    `);

    const saved = [];
    for (const file of files) {
        const relPath = `/uploads/tickets/${file.filename}`;
        const info = insertPhoto.run(
            ticketId,
            logId || null,
            stage || 'report',
            relPath,
            file.originalname || file.filename,
            caption || '',
            uploadedBy || 'Admin'
        );
        saved.push({
            id: info.lastInsertRowid,
            file_path: relPath,
            file_name: file.originalname || file.filename,
            caption: caption || ''
        });
    }
    return saved;
}

// ============================================
// 1. GET / - Halaman Utama Tiket Gangguan
// ============================================
router.get('/', (req, res) => {
    try {
        const { status, priority, technician } = req.query;

        let sql = `
            SELECT t.*,
                   c.customer_id as customer_code,
                   c.pppoe_username,
                   c.ip_address,
                   c.latitude,
                   c.longitude,
                   c.onu_serial,
                   p.name as package_name,
                   (SELECT COUNT(*) FROM ticket_photos tp WHERE tp.ticket_id = t.id) as photo_count,
                   (SELECT COUNT(*) FROM ticket_logs tl WHERE tl.ticket_id = t.id) as log_count
            FROM tickets t
            LEFT JOIN customers c ON t.customer_id = c.id
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE 1=1
        `;
        const params = [];

        if (status && status !== 'all') {
            sql += ' AND t.status = ?';
            params.push(status);
        }
        if (priority && priority !== 'all') {
            sql += ' AND t.priority = ?';
            params.push(priority);
        }
        if (technician && technician !== 'all') {
            sql += ' AND t.technician_id = ?';
            params.push(technician);
        }

        sql += `
            ORDER BY
                CASE t.status
                    WHEN 'open' THEN 1
                    WHEN 'accepted' THEN 2
                    WHEN 'in_progress' THEN 3
                    WHEN 'resolved' THEN 4
                    ELSE 5
                END ASC,
                t.created_at DESC
        `;

        const tickets = db.prepare(sql).all(...params);

        // Ambil foto pertama/terbaru untuk tiap tiket guna pratinjau cepat
        const photosByTicket = {};
        const allTicketPhotos = db.prepare(`
            SELECT tp.*, t.ticket_number, t.customer_name, t.category, t.status as ticket_status
            FROM ticket_photos tp
            JOIN tickets t ON tp.ticket_id = t.id
            ORDER BY tp.created_at DESC
        `).all();

        for (const ph of allTicketPhotos) {
            if (!photosByTicket[ph.ticket_id]) {
                photosByTicket[ph.ticket_id] = [];
            }
            photosByTicket[ph.ticket_id].push(ph);
        }

        // Statistik tiket
        const stats = {
            total: db.prepare('SELECT COUNT(*) as c FROM tickets').get()?.c || 0,
            open: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'open'").get()?.c || 0,
            accepted: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'accepted'").get()?.c || 0,
            in_progress: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'in_progress'").get()?.c || 0,
            resolved: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'resolved'").get()?.c || 0,
            totalPhotos: allTicketPhotos.length
        };

        // Daftar pelanggan untuk dropdown form buat tiket
        const customers = db.prepare(`
            SELECT c.id, c.customer_id, c.name, c.phone, c.address, c.pppoe_username, c.ip_address, p.name as package_name
            FROM customers c
            LEFT JOIN packages p ON c.package_id = p.id
            ORDER BY c.name ASC
        `).all();

        // Daftar teknisi
        const technicians = db.prepare('SELECT * FROM technicians ORDER BY is_active DESC, name ASC').all();

        // Rekap Pengerjaan Teknisi (Hari Ini, Minggu Ini, Bulan Ini, Custom)
        const { getTechnicianWorkRecap } = require('../services/technician-recap');
        const techRecap = getTechnicianWorkRecap(db, {
            range: req.query.recap_range || 'today',
            startDate: req.query.recap_start,
            endDate: req.query.recap_end
        });

        // Template WA Tiket
        const templates = {
            ticket_wa_tech_template: getSetting('ticket_wa_tech_template'),
            ticket_wa_accepted_template: getSetting('ticket_wa_accepted_template'),
            ticket_wa_progress_template: getSetting('ticket_wa_progress_template'),
            ticket_wa_resolved_template: getSetting('ticket_wa_resolved_template')
        };

        res.render('tickets', {
            title: 'Tiket Gangguan',
            activePage: 'tickets',
            tickets,
            photosByTicket,
            allTicketPhotos,
            stats,
            customers,
            technicians,
            techRecap,
            templates,
            filters: {
                status: status || 'all',
                priority: priority || 'all',
                technician: technician || 'all'
            },
            moment
        });
    } catch (error) {
        console.error('[Tickets] Error loading tickets page:', error.message);
        req.flash('error', 'Gagal memuat daftar tiket gangguan: ' + error.message);
        res.redirect('/dashboard');
    }
});

// ============================================
// 2. POST / - Buat Tiket Gangguan Baru (+ WA Teknisi + Foto Laporan)
// ============================================
router.post('/', uploadTicketPhotos.array('photos', 10), async (req, res) => {
    try {
        const {
            customer_id,
            manual_customer_name,
            manual_customer_phone,
            manual_customer_address,
            category,
            priority,
            subject,
            description,
            technician_select,
            custom_tech_name,
            custom_tech_phone,
            photo_caption,
            send_wa_tech,
            send_photo_wa
        } = req.body;

        // Ambil informasi pelanggan
        let custId = customer_id ? parseInt(customer_id, 10) : null;
        let custName = (manual_customer_name || '').trim();
        let custPhone = (manual_customer_phone || '').trim();
        let custAddress = (manual_customer_address || '').trim();
        let custCode = '-';

        if (custId) {
            const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(custId);
            if (cust) {
                custName = cust.name;
                custPhone = custPhone || cust.phone || '';
                custAddress = custAddress || cust.address || '';
                custCode = cust.customer_id || '-';
            }
        }

        if (!custName) {
            req.flash('error', 'Nama pelanggan wajib dipilih atau diisi.');
            return res.redirect('/tickets');
        }

        // Ambil informasi teknisi yang ditugaskan
        let techId = null;
        let techName = 'Tim Teknisi';
        let techPhone = '';
        let targetTechPhones = [];

        if (technician_select === 'custom') {
            techName = (custom_tech_name || 'Teknisi Lapangan').trim();
            techPhone = (custom_tech_phone || '').trim();
            if (techPhone) targetTechPhones.push(techPhone);
        } else if (technician_select === 'all') {
            const activeTechs = db.prepare('SELECT * FROM technicians WHERE is_active = 1').all();
            techName = activeTechs.length > 0 ? activeTechs.map(t => t.name).join(', ') : 'Semua Teknisi';
            techPhone = activeTechs.map(t => t.phone).filter(Boolean).join(', ');
            targetTechPhones = activeTechs.map(t => t.phone).filter(Boolean);
        } else if (technician_select && !isNaN(parseInt(technician_select, 10))) {
            techId = parseInt(technician_select, 10);
            const tech = db.prepare('SELECT * FROM technicians WHERE id = ?').get(techId);
            if (tech) {
                techName = tech.name;
                techPhone = tech.phone;
                if (tech.phone) targetTechPhones.push(tech.phone);
            }
        } else {
            // Jika belum memilih tapi ada teknisi aktif, ambil semua teknisi aktif
            const activeTechs = db.prepare('SELECT * FROM technicians WHERE is_active = 1').all();
            if (activeTechs.length > 0) {
                techId = activeTechs[0].id;
                techName = activeTechs.length === 1 ? activeTechs[0].name : activeTechs.map(t => t.name).join(', ');
                techPhone = activeTechs[0].phone;
                targetTechPhones = activeTechs.map(t => t.phone).filter(Boolean);
            }
        }

        // Buat Nomor Tiket Otomatis: TKT-YYYYMM-0001
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

        const ticketSubject = (subject || category || 'Laporan Gangguan Internet').trim();
        const ticketDesc = (description || ticketSubject).trim();
        const actorName = req.session?.user?.name || req.session?.user?.username || 'Admin';

        // Simpan tiket ke database
        const insertResult = db.prepare(`
            INSERT INTO tickets (
                ticket_number, customer_id, customer_name, customer_phone, customer_address,
                category, priority, subject, description, status,
                technician_id, technician_name, technician_phone,
                created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
        `).run(
            ticketNumber,
            custId,
            custName,
            custPhone,
            custAddress,
            category || 'Koneksi Terputus (LOS)',
            priority || 'medium',
            ticketSubject,
            ticketDesc,
            techId,
            techName,
            techPhone,
            actorName
        );

        const ticketId = insertResult.lastInsertRowid;

        // Buat log awal di ticket_logs
        const logInsert = db.prepare(`
            INSERT INTO ticket_logs (ticket_id, status, title, description, actor_name, wa_sent, wa_target, created_at)
            VALUES (?, 'open', ?, ?, ?, 0, ?, datetime('now', 'localtime'))
        `).run(
            ticketId,
            'Laporan Gangguan Dibuat',
            `Keluhan: ${ticketDesc}${techName ? ' | Ditugaskan ke: ' + techName : ''}`,
            actorName,
            targetTechPhones.join(', ')
        );
        const logId = logInsert.lastInsertRowid;

        // Simpan foto-foto lampiran laporan awal (jika ada)
        const savedPhotos = saveUploadedPhotos(
            req.files,
            ticketId,
            logId,
            'report',
            photo_caption || `Foto Laporan Awal - ${ticketNumber}`,
            actorName
        );

        // Ambil data tiket lengkap untuk format pesan WA
        const createdTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);

        // Kirim notifikasi WhatsApp ke Teknisi
        let waResult = { sent: false, count: 0 };
        if (send_wa_tech !== 'false' && targetTechPhones.length > 0) {
            const waMsg = formatTicketMessage('ticket_wa_tech_template', createdTicket, {
                customer_code: custCode,
                technician_name: techName
            });
            waResult = await sendTicketWhatsApp(
                targetTechPhones,
                waMsg,
                savedPhotos,
                send_photo_wa !== 'false'
            );

            if (waResult.sent) {
                db.prepare('UPDATE tickets SET wa_tech_sent = 1 WHERE id = ?').run(ticketId);
                db.prepare('UPDATE ticket_logs SET wa_sent = 1, wa_target = ? WHERE id = ?').run(waResult.targets, logId);
            }
        }

        // Catat di activity_log
        db.prepare('INSERT INTO activity_log (action, description, user_id) VALUES (?, ?, ?)').run(
            'ticket_created',
            `Tiket gangguan ${ticketNumber} (${custName}) dibuat. WA Teknisi: ${waResult.sent ? 'Terkirim' : 'Tidak/Gagal'}`,
            req.session?.user?.id || null
        );

        if (waResult.sent) {
            req.flash('success', `Tiket gangguan ${ticketNumber} berhasil dibuat dan notifikasi WhatsApp telah dikirim ke Teknisi (${techName}).`);
        } else if (targetTechPhones.length === 0) {
            req.flash('warning', `Tiket gangguan ${ticketNumber} berhasil dibuat, namun belum ada nomor WhatsApp Teknisi yang diatur.`);
        } else {
            req.flash('warning', `Tiket gangguan ${ticketNumber} berhasil dibuat, namun gagal mengirim WA ke Teknisi: ${waResult.error || 'WhatsApp belum terhubung'}`);
        }

        res.redirect('/tickets');
    } catch (error) {
        console.error('[Tickets] Error creating ticket:', error.message);
        req.flash('error', 'Gagal membuat tiket gangguan: ' + error.message);
        res.redirect('/tickets');
    }
});

// ============================================
// 3. GET /:id - Halaman Detail Tiket, Timeline & Arsip Foto
// ============================================
router.get('/:id', (req, res) => {
    try {
        const ticketId = req.params.id;
        const ticket = db.prepare(`
            SELECT t.*,
                   c.customer_id as customer_code,
                   c.pppoe_username,
                   c.ip_address,
                   c.latitude,
                   c.longitude,
                   c.onu_serial,
                   c.status as customer_status,
                   p.name as package_name,
                   p.speed_down,
                   p.speed_up
            FROM tickets t
            LEFT JOIN customers c ON t.customer_id = c.id
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE t.id = ?
        `).get(ticketId);

        if (!ticket) {
            req.flash('error', 'Data tiket gangguan tidak ditemukan.');
            return res.redirect('/tickets');
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

        // Kelompokkan foto berdasarkan log_id
        const photosByLog = {};
        for (const ph of photos) {
            if (ph.log_id) {
                if (!photosByLog[ph.log_id]) photosByLog[ph.log_id] = [];
                photosByLog[ph.log_id].push(ph);
            }
        }

        const technicians = db.prepare('SELECT * FROM technicians WHERE is_active = 1 ORDER BY name ASC').all();

        const chatMessages = db.prepare(`
            SELECT * FROM ticket_messages
            WHERE ticket_id = ?
            ORDER BY created_at ASC, id ASC
        `).all(ticketId);

        res.render('ticket-detail', {
            title: `Detail Tiket ${ticket.ticket_number}`,
            activePage: 'tickets',
            ticket,
            logs,
            photos,
            photosByLog,
            chatMessages,
            technicians,
            moment
        });
    } catch (error) {
        console.error('[Tickets] Error loading ticket detail:', error.message);
        req.flash('error', 'Gagal memuat detail tiket: ' + error.message);
        res.redirect('/tickets');
    }
});

// ============================================
// 4. POST /:id/accept - Teknisi Menerima Tiket (-> WA ke Pelanggan)
// ============================================
router.post('/:id/accept', uploadTicketPhotos.array('photos', 10), async (req, res) => {
    const ticketId = req.params.id;
    const redirectUrl = req.body.redirect_to || `/tickets/${ticketId}`;

    try {
        const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
        if (!ticket) {
            req.flash('error', 'Tiket tidak ditemukan.');
            return res.redirect('/tickets');
        }

        const {
            technician_select,
            custom_tech_name,
            custom_tech_phone,
            note,
            photo_caption,
            send_wa_customer,
            send_photo_wa
        } = req.body;

        let techId = ticket.technician_id;
        let techName = ticket.technician_name || 'Tim Teknisi';
        let techPhone = ticket.technician_phone || '';

        if (technician_select === 'custom') {
            techName = (custom_tech_name || techName).trim();
            techPhone = (custom_tech_phone || techPhone).trim();
            techId = null;
        } else if (technician_select && !isNaN(parseInt(technician_select, 10))) {
            techId = parseInt(technician_select, 10);
            const tech = db.prepare('SELECT * FROM technicians WHERE id = ?').get(techId);
            if (tech) {
                techName = tech.name;
                techPhone = tech.phone;
            }
        }

        const acceptNote = (note || `Tiket telah diterima oleh teknisi ${techName} dan sedang dalam persiapan menuju lokasi / pengecekan sistem.`).trim();

        // Update status tiket menjadi 'accepted'
        db.prepare(`
            UPDATE tickets
            SET status = 'accepted',
                technician_id = ?,
                technician_name = ?,
                technician_phone = ?,
                accepted_at = COALESCE(accepted_at, datetime('now', 'localtime')),
                updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(techId, techName, techPhone, ticketId);

        // Tambah log riwayat
        const logRes = db.prepare(`
            INSERT INTO ticket_logs (ticket_id, status, title, description, actor_name, wa_sent, wa_target, created_at)
            VALUES (?, 'accepted', ?, ?, ?, 0, ?, datetime('now', 'localtime'))
        `).run(
            ticketId,
            `Tiket Diterima oleh Teknisi (${techName})`,
            acceptNote,
            techName,
            ticket.customer_phone || ''
        );
        const logId = logRes.lastInsertRowid;

        // Simpan lampiran foto (jika ada)
        const savedPhotos = saveUploadedPhotos(
            req.files,
            ticketId,
            logId,
            'accepted',
            photo_caption || `Foto Penerimaan Tiket - ${ticket.ticket_number}`,
            techName
        );

        // Catat ke kolom chat komunikasi tiket
        try {
            db.prepare(`
                INSERT INTO ticket_messages (ticket_id, sender_role, sender_name, message, photo_path, created_at)
                VALUES (?, 'technician', ?, ?, ?, datetime('now', 'localtime'))
            `).run(
                ticketId,
                techName,
                `[Tiket Diterima Teknisi]\n${acceptNote}`,
                savedPhotos.length > 0 ? savedPhotos[0].file_path : null
            );
        } catch (e) {}

        // Kirim notifikasi WhatsApp ke Pelanggan
        const updatedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
        let waResult = { sent: false };

        if (send_wa_customer !== 'false' && ticket.customer_phone) {
            const waMsg = formatTicketMessage('ticket_wa_accepted_template', updatedTicket, {
                status: 'accepted',
                technician_name: techName,
                technician_phone: techPhone,
                note: acceptNote
            });

            waResult = await sendTicketWhatsApp(
                ticket.customer_phone,
                waMsg,
                savedPhotos,
                send_photo_wa !== 'false'
            );

            if (waResult.sent) {
                db.prepare('UPDATE tickets SET wa_accepted_sent = 1 WHERE id = ?').run(ticketId);
                db.prepare('UPDATE ticket_logs SET wa_sent = 1 WHERE id = ?').run(logId);
            }
        }

        db.prepare('INSERT INTO activity_log (action, description, user_id) VALUES (?, ?, ?)').run(
            'ticket_accepted',
            `Tiket ${ticket.ticket_number} diterima oleh teknisi ${techName}. WA Pelanggan: ${waResult.sent ? 'Terkirim' : 'Tidak/Gagal'}`,
            req.session?.user?.id || null
        );

        if (waResult.sent) {
            req.flash('success', `Tiket ${ticket.ticket_number} diterima oleh ${techName}. Notifikasi WhatsApp telah dikirim ke pelanggan (${ticket.customer_name}).`);
        } else {
            req.flash('warning', `Tiket ${ticket.ticket_number} diterima oleh ${techName}, namun notifikasi WA ke pelanggan belum terkirim (${waResult.error || 'Nomor HP kosong / WA belum terhubung'}).`);
        }

        res.redirect(redirectUrl);
    } catch (error) {
        console.error('[Tickets] Error accepting ticket:', error.message);
        req.flash('error', 'Gagal memproses penerimaan tiket: ' + error.message);
        res.redirect(redirectUrl);
    }
});

// ============================================
// 5. POST /:id/progress - Update Progress Penanganan (-> WA Progress ke Pelanggan + Arsip Foto)
// ============================================
router.post('/:id/progress', uploadTicketPhotos.array('photos', 10), async (req, res) => {
    const ticketId = req.params.id;
    const redirectUrl = req.body.redirect_to || `/tickets/${ticketId}`;

    try {
        const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
        if (!ticket) {
            req.flash('error', 'Tiket tidak ditemukan.');
            return res.redirect('/tickets');
        }

        const {
            progress_title,
            note,
            technician_name,
            photo_caption,
            send_wa_customer,
            send_photo_wa
        } = req.body;

        const techName = (technician_name || ticket.technician_name || 'Tim Teknisi').trim();
        const title = (progress_title || 'Update Progress Pengerjaan').trim();
        const progressNote = (note || 'Teknisi sedang melakukan pengecekan dan perbaikan jaringan di lapangan.').trim();

        // Update status tiket menjadi 'in_progress'
        db.prepare(`
            UPDATE tickets
            SET status = 'in_progress',
                technician_name = ?,
                accepted_at = COALESCE(accepted_at, datetime('now', 'localtime')),
                in_progress_at = COALESCE(in_progress_at, datetime('now', 'localtime')),
                updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(techName, ticketId);

        // Tambah log riwayat progress
        const logRes = db.prepare(`
            INSERT INTO ticket_logs (ticket_id, status, title, description, actor_name, wa_sent, wa_target, created_at)
            VALUES (?, 'in_progress', ?, ?, ?, 0, ?, datetime('now', 'localtime'))
        `).run(
            ticketId,
            title,
            progressNote,
            techName,
            ticket.customer_phone || ''
        );
        const logId = logRes.lastInsertRowid;

        // Simpan foto-foto dokumentasi progress pengerjaan
        const savedPhotos = saveUploadedPhotos(
            req.files,
            ticketId,
            logId,
            'in_progress',
            photo_caption || `${title} - ${ticket.ticket_number}`,
            techName
        );

        // Catat ke kolom chat komunikasi tiket
        try {
            db.prepare(`
                INSERT INTO ticket_messages (ticket_id, sender_role, sender_name, message, photo_path, created_at)
                VALUES (?, 'technician', ?, ?, ?, datetime('now', 'localtime'))
            `).run(
                ticketId,
                techName,
                `[Update Progress: ${title}]\n${progressNote}`,
                savedPhotos.length > 0 ? savedPhotos[0].file_path : null
            );
        } catch (e) {}

        // Kirim notifikasi WhatsApp Progress ke Pelanggan
        const updatedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
        let waResult = { sent: false };

        if (send_wa_customer !== 'false' && ticket.customer_phone) {
            const fullNote = progress_title ? `*${title}*\n${progressNote}` : progressNote;
            const waMsg = formatTicketMessage('ticket_wa_progress_template', updatedTicket, {
                status: 'in_progress',
                technician_name: techName,
                note: fullNote
            });

            waResult = await sendTicketWhatsApp(
                ticket.customer_phone,
                waMsg,
                savedPhotos,
                send_photo_wa !== 'false'
            );

            if (waResult.sent) {
                db.prepare('UPDATE tickets SET wa_progress_sent = wa_progress_sent + 1 WHERE id = ?').run(ticketId);
                db.prepare('UPDATE ticket_logs SET wa_sent = 1 WHERE id = ?').run(logId);
            }
        }

        db.prepare('INSERT INTO activity_log (action, description, user_id) VALUES (?, ?, ?)').run(
            'ticket_progress',
            `Update progress tiket ${ticket.ticket_number} (${title}). Foto: ${savedPhotos.length}. WA Pelanggan: ${waResult.sent ? 'Terkirim' : 'Tidak/Gagal'}`,
            req.session?.user?.id || null
        );

        if (waResult.sent) {
            req.flash('success', `Progress pengerjaan tiket ${ticket.ticket_number} berhasil disimpan${savedPhotos.length > 0 ? ` beserta ${savedPhotos.length} foto arsip` : ''} dan notifikasi WhatsApp terkirim ke pelanggan.`);
        } else {
            req.flash('warning', `Progress tiket ${ticket.ticket_number} tersimpan, namun WA ke pelanggan tidak terkirim (${waResult.error || 'Dinonaktifkan / WA belum siap'}).`);
        }

        res.redirect(redirectUrl);
    } catch (error) {
        console.error('[Tickets] Error updating progress:', error.message);
        req.flash('error', 'Gagal memperbarui progress tiket: ' + error.message);
        res.redirect(redirectUrl);
    }
});

// ============================================
// 6. POST /:id/resolve - Selesaikan Tiket Gangguan (-> WA Selesai ke Pelanggan + Foto Bukti)
// ============================================
router.post('/:id/resolve', uploadTicketPhotos.array('photos', 10), async (req, res) => {
    const ticketId = req.params.id;
    const redirectUrl = req.body.redirect_to || `/tickets/${ticketId}`;

    try {
        const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
        if (!ticket) {
            req.flash('error', 'Tiket tidak ditemukan.');
            return res.redirect('/tickets');
        }

        const {
            note,
            technician_name,
            photo_caption,
            send_wa_customer,
            send_photo_wa
        } = req.body;

        const techName = (technician_name || ticket.technician_name || 'Tim Teknisi').trim();
        const resolutionNote = (note || 'Perbaikan jaringan telah selesai dilakukan dan koneksi internet pelanggan kembali normal.').trim();

        // Update status tiket menjadi 'resolved'
        db.prepare(`
            UPDATE tickets
            SET status = 'resolved',
                technician_name = ?,
                resolution_notes = ?,
                accepted_at = COALESCE(accepted_at, datetime('now', 'localtime')),
                in_progress_at = COALESCE(in_progress_at, datetime('now', 'localtime')),
                resolved_at = datetime('now', 'localtime'),
                updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(techName, resolutionNote, ticketId);

        // Tambah log riwayat selesai
        const logRes = db.prepare(`
            INSERT INTO ticket_logs (ticket_id, status, title, description, actor_name, wa_sent, wa_target, created_at)
            VALUES (?, 'resolved', ?, ?, ?, 0, ?, datetime('now', 'localtime'))
        `).run(
            ticketId,
            'Gangguan Selesai Ditangani (Resolved)',
            resolutionNote,
            techName,
            ticket.customer_phone || ''
        );
        const logId = logRes.lastInsertRowid;

        // Simpan foto bukti penyelesaian
        const savedPhotos = saveUploadedPhotos(
            req.files,
            ticketId,
            logId,
            'resolved',
            photo_caption || `Foto Bukti Selesai - ${ticket.ticket_number}`,
            techName
        );

        // Catat ke kolom chat komunikasi tiket
        try {
            db.prepare(`
                INSERT INTO ticket_messages (ticket_id, sender_role, sender_name, message, photo_path, created_at)
                VALUES (?, 'technician', ?, ?, ?, datetime('now', 'localtime'))
            `).run(
                ticketId,
                techName,
                `[Gangguan Selesai ✅]\n${resolutionNote}`,
                savedPhotos.length > 0 ? savedPhotos[0].file_path : null
            );
        } catch (e) {}

        // Kirim notifikasi WhatsApp Selesai ke Pelanggan
        const updatedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
        let waResult = { sent: false };

        if (send_wa_customer !== 'false' && ticket.customer_phone) {
            const waMsg = formatTicketMessage('ticket_wa_resolved_template', updatedTicket, {
                status: 'resolved',
                technician_name: techName,
                note: resolutionNote
            });

            waResult = await sendTicketWhatsApp(
                ticket.customer_phone,
                waMsg,
                savedPhotos,
                send_photo_wa !== 'false'
            );

            if (waResult.sent) {
                db.prepare('UPDATE tickets SET wa_resolved_sent = 1 WHERE id = ?').run(ticketId);
                db.prepare('UPDATE ticket_logs SET wa_sent = 1 WHERE id = ?').run(logId);
            }
        }

        db.prepare('INSERT INTO activity_log (action, description, user_id) VALUES (?, ?, ?)').run(
            'ticket_resolved',
            `Tiket gangguan ${ticket.ticket_number} (${ticket.customer_name}) SELESAI. WA Pelanggan: ${waResult.sent ? 'Terkirim' : 'Tidak/Gagal'}`,
            req.session?.user?.id || null
        );

        if (waResult.sent) {
            req.flash('success', `Tiket ${ticket.ticket_number} telah diselesaikan! Notifikasi selesai beserta dokumentasi telah dikirim ke WhatsApp pelanggan.`);
        } else {
            req.flash('warning', `Tiket ${ticket.ticket_number} telah ditandai Selesai, namun WA ke pelanggan tidak terkirim (${waResult.error || 'Dinonaktifkan / WA belum siap'}).`);
        }

        res.redirect(redirectUrl);
    } catch (error) {
        console.error('[Tickets] Error resolving ticket:', error.message);
        req.flash('error', 'Gagal menyelesaikan tiket: ' + error.message);
        res.redirect(redirectUrl);
    }
});

// ============================================
// 7. POST /:id/upload-photos - Tambah Arsip Foto ke Tiket Kapan Saja
// ============================================
router.post('/:id/upload-photos', uploadTicketPhotos.array('photos', 10), (req, res) => {
    const ticketId = req.params.id;
    try {
        const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
        if (!ticket) {
            req.flash('error', 'Tiket tidak ditemukan.');
            return res.redirect('/tickets');
        }

        if (!req.files || req.files.length === 0) {
            req.flash('error', 'Silakan pilih minimal 1 foto untuk diunggah.');
            return res.redirect(`/tickets/${ticketId}`);
        }

        const { stage, caption } = req.body;
        const uploader = req.session?.user?.name || ticket.technician_name || 'Admin';

        const logRes = db.prepare(`
            INSERT INTO ticket_logs (ticket_id, status, title, description, actor_name, wa_sent, created_at)
            VALUES (?, 'note', ?, ?, ?, 0, datetime('now', 'localtime'))
        `).run(
            ticketId,
            `Penambahan Arsip Foto Dokumentasi (${req.files.length} Foto)`,
            caption || 'Lampiran foto arsip dokumentasi tiket gangguan',
            uploader
        );

        saveUploadedPhotos(
            req.files,
            ticketId,
            logRes.lastInsertRowid,
            stage || ticket.status || 'in_progress',
            caption || `Arsip Dokumentasi - ${ticket.ticket_number}`,
            uploader
        );

        req.flash('success', `${req.files.length} foto dokumentasi berhasil ditambahkan ke arsip tiket ${ticket.ticket_number}.`);
        res.redirect(`/tickets/${ticketId}`);
    } catch (error) {
        console.error('[Tickets] Error uploading extra photos:', error.message);
        req.flash('error', 'Gagal mengunggah foto arsip: ' + error.message);
        res.redirect(`/tickets/${ticketId}`);
    }
});

// ============================================
// 8. POST /:id/resend-wa - Kirim Ulang Notifikasi WA (Teknisi / Pelanggan)
// ============================================
router.post('/:id/resend-wa', async (req, res) => {
    const ticketId = req.params.id;
    const { target_type } = req.body; // 'tech', 'accepted', 'progress', 'resolved'
    const redirectUrl = req.body.redirect_to || `/tickets/${ticketId}`;

    try {
        const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
        if (!ticket) {
            req.flash('error', 'Tiket tidak ditemukan.');
            return res.redirect('/tickets');
        }

        const photos = db.prepare('SELECT * FROM ticket_photos WHERE ticket_id = ? ORDER BY id DESC LIMIT 2').all(ticketId);

        if (target_type === 'tech') {
            let phones = [];
            if (ticket.technician_phone) {
                phones = ticket.technician_phone.split(',').map(p => p.trim()).filter(Boolean);
            } else {
                const activeTechs = db.prepare('SELECT phone FROM technicians WHERE is_active = 1').all();
                phones = activeTechs.map(t => t.phone).filter(Boolean);
            }

            if (phones.length === 0) {
                req.flash('error', 'Nomor WhatsApp teknisi belum diatur pada tiket ini.');
                return res.redirect(redirectUrl);
            }

            const msg = formatTicketMessage('ticket_wa_tech_template', ticket);
            const result = await sendTicketWhatsApp(phones, msg, photos, true);
            if (result.sent) {
                db.prepare('UPDATE tickets SET wa_tech_sent = 1 WHERE id = ?').run(ticketId);
                req.flash('success', `Notifikasi WhatsApp berhasil dikirim ulang ke Teknisi (${result.targets}).`);
            } else {
                req.flash('error', 'Gagal mengirim WA ke Teknisi: ' + (result.error || 'Koneksi belum siap'));
            }
        } else {
            if (!ticket.customer_phone) {
                req.flash('error', 'Pelanggan ini tidak memiliki nomor WhatsApp.');
                return res.redirect(redirectUrl);
            }

            let templateKey = 'ticket_wa_accepted_template';
            if (target_type === 'progress') templateKey = 'ticket_wa_progress_template';
            if (target_type === 'resolved') templateKey = 'ticket_wa_resolved_template';

            const lastLog = db.prepare('SELECT * FROM ticket_logs WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(ticketId);
            const msg = formatTicketMessage(templateKey, ticket, {
                note: ticket.resolution_notes || lastLog?.description || ticket.description
            });

            const result = await sendTicketWhatsApp(ticket.customer_phone, msg, photos, true);
            if (result.sent) {
                req.flash('success', `Notifikasi WhatsApp berhasil dikirim ke pelanggan (${ticket.customer_name}).`);
            } else {
                req.flash('error', 'Gagal mengirim WA ke pelanggan: ' + (result.error || 'Koneksi belum siap'));
            }
        }

        res.redirect(redirectUrl);
    } catch (error) {
        console.error('[Tickets] Error resending WA:', error.message);
        req.flash('error', 'Gagal mengirim ulang WhatsApp: ' + error.message);
        res.redirect(redirectUrl);
    }
});

// ============================================
// 8.5 POST /:id/chat & GET /:id/messages - Kolom Chat Komunikasi Teknisi <-> Pelanggan
// ============================================
router.post('/:id/chat', uploadTicketPhotos.single('photo'), async (req, res) => {
    const ticketId = req.params.id;
    try {
        const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
        if (!ticket) {
            req.flash('error', 'Tiket tidak ditemukan.');
            return res.redirect('/tickets');
        }

        const msgText = (req.body.message || '').trim();
        const sendWa = req.body.send_wa_chat !== 'false';
        const photoPath = req.file ? `/uploads/tickets/${req.file.filename}` : null;

        if (!msgText && !photoPath) {
            req.flash('warning', 'Pesan atau foto tidak boleh kosong.');
            return res.redirect(`/tickets/${ticketId}#chat-section`);
        }

        const senderRole = req.session.user?.role === 'technician' ? 'technician' : 'admin';
        const senderName = req.session.user?.name || ticket.technician_name || 'Tim Teknisi';

        db.prepare(`
            INSERT INTO ticket_messages (ticket_id, sender_role, sender_name, message, photo_path, created_at)
            VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))
        `).run(ticketId, senderRole, senderName, msgText || 'Melampirkan foto pada chat', photoPath);

        if (photoPath && req.file) {
            db.prepare(`
                INSERT INTO ticket_photos (ticket_id, stage, file_path, file_name, caption, uploaded_by, created_at)
                VALUES (?, 'in_progress', ?, ?, ?, ?, datetime('now', 'localtime'))
            `).run(
                ticketId,
                photoPath,
                req.file.originalname || req.file.filename,
                msgText || `Foto Chat Teknisi - ${ticket.ticket_number}`,
                senderName
            );
        }

        // Kirim juga ke WhatsApp Pelanggan jika diaktifkan
        if (sendWa && ticket.customer_phone) {
            const waText = `💬 *PESAN DARI TEKNISI (${senderName})*\n*No. Tiket:* ${ticket.ticket_number}\n\n"${msgText || '(Melampirkan Foto)'}"\n\n_Anda juga dapat membalas pesan ini melalui Portal Tiket Pelanggan._`;
            try {
                if (photoPath) {
                    const absPhoto = path.join(__dirname, '../public', photoPath);
                    if (fs.existsSync(absPhoto)) {
                        await whatsappService.sendImage(ticket.customer_phone, absPhoto, waText);
                    } else {
                        await whatsappService.sendMessage(ticket.customer_phone, waText);
                    }
                } else {
                    await whatsappService.sendMessage(ticket.customer_phone, waText);
                }
            } catch (waErr) {
                console.warn('[Tickets] Gagal kirim WA chat ke pelanggan:', waErr.message);
            }
        }

        req.flash('success', 'Pesan / catatan berhasil dikirim ke Pelanggan.');
        res.redirect(`/tickets/${ticketId}#chat-section`);
    } catch (error) {
        console.error('[Tickets] Error sending technician chat:', error.message);
        req.flash('error', 'Gagal mengirim pesan: ' + error.message);
        res.redirect(`/tickets/${ticketId}#chat-section`);
    }
});

router.get('/:id/messages', (req, res) => {
    try {
        const ticket = db.prepare('SELECT id, status FROM tickets WHERE id = ?').get(req.params.id);
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
// 9. POST /:id/delete & POST /photos/:photoId/delete (Khusus Admin)
// ============================================
router.post('/:id/delete', isAdmin, (req, res) => {
    const ticketId = req.params.id;
    try {
        const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
        if (!ticket) {
            req.flash('error', 'Tiket tidak ditemukan.');
            return res.redirect('/tickets');
        }

        // Hapus file fisik foto dari disk
        const photos = db.prepare('SELECT file_path FROM ticket_photos WHERE ticket_id = ?').all(ticketId);
        for (const ph of photos) {
            try {
                const absPath = path.join(__dirname, '../public', ph.file_path);
                if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
            } catch (e) {}
        }

        db.prepare('DELETE FROM ticket_photos WHERE ticket_id = ?').run(ticketId);
        db.prepare('DELETE FROM ticket_logs WHERE ticket_id = ?').run(ticketId);
        db.prepare('DELETE FROM tickets WHERE id = ?').run(ticketId);

        db.prepare('INSERT INTO activity_log (action, description, user_id) VALUES (?, ?, ?)').run(
            'ticket_deleted',
            `Menghapus tiket gangguan ${ticket.ticket_number} (${ticket.customer_name})`,
            req.session?.user?.id || null
        );

        req.flash('success', `Tiket gangguan ${ticket.ticket_number} beserta arsip fotonya berhasil dihapus.`);
        res.redirect('/tickets');
    } catch (error) {
        console.error('[Tickets] Error deleting ticket:', error.message);
        req.flash('error', 'Gagal menghapus tiket: ' + error.message);
        res.redirect('/tickets');
    }
});

router.post('/photos/:photoId/delete', isAdmin, (req, res) => {
    const photoId = req.params.photoId;
    const redirectUrl = req.body.redirect_to || '/tickets';
    try {
        const photo = db.prepare('SELECT * FROM ticket_photos WHERE id = ?').get(photoId);
        if (photo) {
            try {
                const absPath = path.join(__dirname, '../public', photo.file_path);
                if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
            } catch (e) {}
            db.prepare('DELETE FROM ticket_photos WHERE id = ?').run(photoId);
            req.flash('success', 'Foto arsip berhasil dihapus.');
        }
        res.redirect(redirectUrl);
    } catch (error) {
        req.flash('error', 'Gagal menghapus foto: ' + error.message);
        res.redirect(redirectUrl);
    }
});

// ============================================
// 10. Manajemen Data Teknisi, Akun Login & Template WA Tiket (Khusus Admin)
// ============================================
router.post('/technicians/add', isAdmin, (req, res) => {
    try {
        const { username, password, name, phone, role, notes } = req.body;
        if (!name || !phone) {
            req.flash('error', 'Nama teknisi dan nomor WhatsApp wajib diisi.');
            return res.redirect('/tickets#tab-technicians');
        }

        const cleanUsername = (username || '').trim() || phone.replace(/[^0-9]/g, '');
        const rawPassword = (password || '').trim() || 'teknisi123';
        const hashedPassword = bcrypt.hashSync(rawPassword, 10);

        db.prepare(`
            INSERT INTO technicians (username, password, name, phone, role, is_active, notes, created_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now', 'localtime'))
        `).run(
            cleanUsername,
            hashedPassword,
            name.trim(),
            phone.trim(),
            (role || 'Teknisi Lapangan').trim(),
            (notes || '').trim()
        );

        req.flash('success', `Teknisi ${name} berhasil ditambahkan! Akun Login Portal Teknisi: Username "${cleanUsername}".`);
        res.redirect('/tickets#tab-technicians');
    } catch (error) {
        req.flash('error', 'Gagal menambahkan teknisi: ' + error.message);
        res.redirect('/tickets#tab-technicians');
    }
});

router.post('/technicians/:techId/edit', isAdmin, (req, res) => {
    try {
        const { username, password, name, phone, role, is_active, notes } = req.body;
        const cleanUsername = (username || '').trim() || (phone || '').replace(/[^0-9]/g, '');

        if (password && password.trim() !== '') {
            const hashedPassword = bcrypt.hashSync(password.trim(), 10);
            db.prepare(`
                UPDATE technicians
                SET username = ?, password = ?, name = ?, phone = ?, role = ?, is_active = ?, notes = ?
                WHERE id = ?
            `).run(
                cleanUsername,
                hashedPassword,
                (name || '').trim(),
                (phone || '').trim(),
                (role || 'Teknisi Lapangan').trim(),
                is_active === '1' || is_active === 'true' ? 1 : 0,
                (notes || '').trim(),
                req.params.techId
            );
        } else {
            db.prepare(`
                UPDATE technicians
                SET username = ?, name = ?, phone = ?, role = ?, is_active = ?, notes = ?
                WHERE id = ?
            `).run(
                cleanUsername,
                (name || '').trim(),
                (phone || '').trim(),
                (role || 'Teknisi Lapangan').trim(),
                is_active === '1' || is_active === 'true' ? 1 : 0,
                (notes || '').trim(),
                req.params.techId
            );
        }

        req.flash('success', `Data & akun login teknisi ${name} berhasil diperbarui.`);
        res.redirect('/tickets#tab-technicians');
    } catch (error) {
        req.flash('error', 'Gagal memperbarui teknisi: ' + error.message);
        res.redirect('/tickets#tab-technicians');
    }
});

router.post('/technicians/:techId/delete', isAdmin, (req, res) => {
    try {
        db.prepare('DELETE FROM technicians WHERE id = ?').run(req.params.techId);
        req.flash('success', 'Data teknisi berhasil dihapus.');
        res.redirect('/tickets#tab-technicians');
    } catch (error) {
        req.flash('error', 'Gagal menghapus teknisi: ' + error.message);
        res.redirect('/tickets#tab-technicians');
    }
});

router.post('/templates/save', isAdmin, (req, res) => {
    try {
        const keys = [
            'ticket_wa_tech_template',
            'ticket_wa_accepted_template',
            'ticket_wa_progress_template',
            'ticket_wa_resolved_template'
        ];
        const upsert = db.prepare(`
            INSERT INTO settings (key, value, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `);

        const tx = db.transaction(() => {
            for (const k of keys) {
                if (req.body[k] !== undefined) {
                    upsert.run(k, req.body[k]);
                }
            }
        });
        tx();

        req.flash('success', 'Template notifikasi WhatsApp Tiket Gangguan berhasil disimpan.');
        res.redirect('/tickets#tab-templates');
    } catch (error) {
        req.flash('error', 'Gagal menyimpan template: ' + error.message);
        res.redirect('/tickets#tab-templates');
    }
});

module.exports = router;
