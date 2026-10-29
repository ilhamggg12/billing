const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const moment = require('moment');
const db = require('../database/init');
const { isAuthenticated } = require('../middleware/auth');
const whatsappService = require('../services/whatsapp');
const schedulerService = require('../services/scheduler');
const mikrotikService = require('../services/mikrotik');
const genieacsService = require('../services/genieacs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');

router.use(isAuthenticated);

/**
 * Helper: Mengambil statistik ukuran dan jumlah data database SQLite
 */
function getDatabaseStats() {
    const dbPath = path.join(__dirname, '../database/isp-manager.db');
    let sizeBytes = 0;
    try {
        if (fs.existsSync(dbPath)) {
            sizeBytes = fs.statSync(dbPath).size;
        }
    } catch (e) {}

    const formatBytes = (bytes) => {
        if (!bytes) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const count = (tbl) => {
        try {
            return db.prepare(`SELECT COUNT(*) as count FROM ${tbl}`).get()?.count || 0;
        } catch (e) {
            return 0;
        }
    };

    return {
        path: dbPath,
        size: formatBytes(sizeBytes),
        sizeBytes,
        counts: {
            customers: count('customers'),
            packages: count('packages'),
            invoices: count('invoices'),
            payments: count('payments'),
            routers: count('routers'),
            activity_log: count('activity_log'),
            settings: count('settings')
        }
    };
}

/**
 * Helper: Mengambil informasi sistem proses Node.js & Server
 */
function getSystemInfo() {
    const uptimeSec = process.uptime();
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = Math.floor(uptimeSec % 60);
    const uptimeStr = `${days > 0 ? days + 'h ' : ''}${hours}j ${minutes}m ${seconds}d`;

    const mem = process.memoryUsage();
    const formatMB = (bytes) => (bytes / (1024 * 1024)).toFixed(1) + ' MB';

    return {
        nodeVersion: process.version,
        platform: `${os.type()} ${os.arch()} (${os.release()})`,
        uptime: uptimeStr,
        memory: {
            rss: formatMB(mem.rss),
            heapUsed: formatMB(mem.heapUsed),
            heapTotal: formatMB(mem.heapTotal)
        }
    };
}

/**
 * Helper: Memperbarui PORT di file .env dan runtime process.env.PORT
 */
function updateEnvPort(newPort) {
    try {
        const envPath = path.join(__dirname, '../.env');
        if (fs.existsSync(envPath)) {
            let envContent = fs.readFileSync(envPath, 'utf8');
            if (/^PORT=.*/m.test(envContent)) {
                envContent = envContent.replace(/^PORT=.*/m, `PORT=${newPort}`);
            } else {
                envContent += `\nPORT=${newPort}`;
            }
            fs.writeFileSync(envPath, envContent, 'utf8');
        } else {
            fs.writeFileSync(envPath, `PORT=${newPort}\nSESSION_SECRET=isp-secret\nNODE_ENV=production\n`, 'utf8');
        }
        process.env.PORT = String(newPort);
        return true;
    } catch (e) {
        console.warn('[Settings] Gagal update .env PORT:', e.message);
        return false;
    }
}

// =========================================================================
// 1. GET / - Tampilkan Halaman Pengaturan (Beserta Info DB & Services)
// =========================================================================
router.get('/', async (req, res) => {
    try {
        // Ambil semua setting sebagai objek key-value
        const rows = db.prepare('SELECT key, value FROM settings').all();
        const settings = {};
        rows.forEach(row => {
            settings[row.key] = row.value;
        });

        // Default port web jika belum diset di settings
        if (!settings.web_port) {
            settings.web_port = process.env.PORT || '3000';
        }

        // Status WhatsApp Gateway
        let waStatus = 'disconnected';
        let waQR = null;
        try {
            waStatus = whatsappService.getStatus();
            waQR = whatsappService.getQR();
        } catch (e) {
            console.error('[Settings] Error WhatsApp status:', e.message);
        }

        // Status Scheduler
        let schedulerStatus = { active: false, jobsCount: 0 };
        try {
            schedulerStatus = schedulerService.getStatus();
        } catch (e) {}

        // Status MikroTik
        let mikrotikStatus = { totalRouters: 0, connectedRouters: 0 };
        try {
            mikrotikStatus = mikrotikService.getStatus();
        } catch (e) {}

        // Status GenieACS
        let genieacsStatus = { online: false, devicesCount: 0 };
        try {
            const rowAcs = db.prepare("SELECT value FROM settings WHERE key = ?").get('genieacs_url');
            if (rowAcs?.value) genieacsService.configure(rowAcs.value);
            genieacsStatus = await genieacsService.getStatus();
        } catch (e) {}

        // Database & System Info
        const databaseStats = getDatabaseStats();
        const systemInfo = getSystemInfo();

        // Daftar Akun & Nomor WA Teknisi
        let technicians = [];
        try {
            technicians = db.prepare('SELECT * FROM technicians ORDER BY is_active DESC, id ASC').all();
        } catch (eTech) {}

        // Daftar Akun Administrator
        let adminUsers = [];
        try {
            adminUsers = db.prepare('SELECT id, username, name, role, created_at, updated_at FROM users ORDER BY id ASC').all();
        } catch (eAdmin) {
            console.error('[Settings] Error fetching admin users:', eAdmin.message);
        }

        res.render('settings', {
            title: 'Pengaturan',
            activePage: 'settings',
            settings,
            technicians,
            adminUsers,
            waStatus,
            waQR,
            whatsappStatus: waStatus,
            whatsappQR: waQR,
            schedulerStatus,
            mikrotikStatus,
            genieacsStatus,
            databaseStats,
            systemInfo
        });
    } catch (error) {
        console.error('[Settings] Error loading settings:', error.message);
        req.flash('error', 'Gagal memuat pengaturan: ' + error.message);
        res.render('settings', {
            title: 'Pengaturan',
            activePage: 'settings',
            settings: {},
            technicians: [],
            adminUsers: [],
            waStatus: 'disconnected',
            waQR: null,
            whatsappStatus: 'disconnected',
            whatsappQR: null,
            schedulerStatus: { active: false, jobsCount: 0 },
            mikrotikStatus: { totalRouters: 0, connectedRouters: 0 },
            genieacsStatus: { online: false, devicesCount: 0 },
            databaseStats: getDatabaseStats(),
            systemInfo: getSystemInfo()
        });
    }
});

// =========================================================================
// 2. POST / - Simpan Pengaturan
// =========================================================================
router.post('/', (req, res) => {
    try {
        const booleanFields = [
            'auto_billing_enabled',
            'auto_block_enabled',
            'auto_reset_additional_bill',
            'reminder_day_1',
            'reminder_day_5',
            'reminder_day_7',
            'welcome_wa_enabled'
        ];

        booleanFields.forEach(field => {
            if (!req.body[field]) {
                req.body[field] = 'false';
            }
        });

        // Validasi dan update file .env jika web_port diubah
        let portMsg = '';
        if (req.body.web_port) {
            const rawPort = parseInt(req.body.web_port, 10);
            if (!isNaN(rawPort) && rawPort >= 1 && rawPort <= 65535) {
                req.body.web_port = String(rawPort);
                updateEnvPort(rawPort);
                portMsg = ` Port web diatur ke ${rawPort} (restart server untuk mengaktifkan).`;
            } else {
                delete req.body.web_port;
            }
        }

        const upsertStmt = db.prepare(`
            INSERT INTO settings (key, value, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `);

        const saveAll = db.transaction(() => {
            for (const [key, value] of Object.entries(req.body)) {
                upsertStmt.run(key, value);
            }
        });

        saveAll();

        // Sinkronisasi data MikroTik ke router default di tabel routers
        if (req.body.mikrotik_host) {
            const defRouter = db.prepare('SELECT id FROM routers WHERE is_default = 1 LIMIT 1').get() || db.prepare('SELECT id FROM routers LIMIT 1').get();
            if (defRouter) {
                const pass = req.body.mikrotik_password ? req.body.mikrotik_password : null;
                if (pass) {
                    db.prepare(`
                        UPDATE routers SET host = ?, port = ?, username = ?, password = ?, isolir_address_list = ?, updated_at = datetime('now')
                        WHERE id = ?
                    `).run(
                        req.body.mikrotik_host.trim(),
                        parseInt(req.body.mikrotik_port, 10) || 8728,
                        req.body.mikrotik_username ? req.body.mikrotik_username.trim() : 'admin',
                        pass,
                        req.body.isolir_address_list ? req.body.isolir_address_list.trim() : 'Expired',
                        defRouter.id
                    );
                } else {
                    db.prepare(`
                        UPDATE routers SET host = ?, port = ?, username = ?, isolir_address_list = ?, updated_at = datetime('now')
                        WHERE id = ?
                    `).run(
                        req.body.mikrotik_host.trim(),
                        parseInt(req.body.mikrotik_port, 10) || 8728,
                        req.body.mikrotik_username ? req.body.mikrotik_username.trim() : 'admin',
                        req.body.isolir_address_list ? req.body.isolir_address_list.trim() : 'Expired',
                        defRouter.id
                    );
                }
            }
        }

        req.flash('success', 'Pengaturan berhasil disimpan.' + portMsg);
        res.redirect('/settings');
    } catch (error) {
        console.error('[Settings] Error saving settings:', error.message);
        req.flash('error', 'Gagal menyimpan pengaturan: ' + error.message);
        res.redirect('/settings');
    }
});

// =========================================================================
// 2.1 POST /settings/web-port - Ubah Port Web Server Cepat (AJAX/Modal)
// =========================================================================
router.post('/web-port', (req, res) => {
    try {
        const rawPort = parseInt(req.body.port, 10);
        if (isNaN(rawPort) || rawPort < 1 || rawPort > 65535) {
            return res.status(400).json({
                success: false,
                message: 'Nomor port harus berupa angka valid antara 1 sampai 65535.'
            });
        }

        // Simpan ke database
        db.prepare(`
            INSERT INTO settings (key, value, updated_at)
            VALUES ('web_port', ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(String(rawPort));

        // Update file .env dan runtime
        updateEnvPort(rawPort);

        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('setting_update', ?, ?, datetime('now'))
            `).run(`Ubah port web server menjadi ${rawPort}`, req.session?.user?.id || null);
        } catch (eLog) {}

        return res.json({
            success: true,
            port: rawPort,
            message: `Port web berhasil diubah menjadi ${rawPort}. Konfigurasi tersimpan di database dan file .env. Silakan mulai ulang (restart) server aplikasi agar port baru aktif sepenuhnya.`
        });
    } catch (err) {
        console.error('[Settings] Error update web port:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Gagal memperbarui port: ' + err.message
        });
    }
});

// =========================================================================
// 3. WHATSAPP GATEWAY ACTIONS
// =========================================================================
router.post('/whatsapp/initialize', (req, res) => {
    try {
        whatsappService.initialize().catch(err => {
            console.error('[WhatsApp] Background initialization error:', err.message);
        });
        req.flash('success', 'Inisialisasi WhatsApp sedang berjalan. QR Code akan muncul sesaat lagi.');
        res.redirect('/settings#tab-whatsapp');
    } catch (error) {
        console.error('[WhatsApp] Error initializing WhatsApp:', error.message);
        req.flash('error', 'Gagal menginisialisasi WhatsApp: ' + error.message);
        res.redirect('/settings#tab-whatsapp');
    }
});

router.post('/whatsapp/disconnect', async (req, res) => {
    try {
        await whatsappService.disconnect();
        req.flash('success', 'WhatsApp berhasil diputus');
        res.redirect('/settings#tab-whatsapp');
    } catch (error) {
        console.error('[WhatsApp] Error disconnecting WhatsApp:', error.message);
        req.flash('error', 'Gagal memutus koneksi WhatsApp: ' + error.message);
        res.redirect('/settings#tab-whatsapp');
    }
});

// =========================================================================
// 4. BAGIAN DATABASE: BACKUP & MAINTENANCE
// =========================================================================

// 4.1 Backup Database Full (Binary .db SQLite asli via online backup API)
router.get('/backup/full', async (req, res) => {
    const timestamp = moment().format('YYYY-MM-DD_HHmmss');
    const backupFileName = `isp-manager-full-backup_${timestamp}.db`;
    const tempPath = path.join(__dirname, '../database', `temp_${Date.now()}_backup.db`);

    try {
        await db.backup(tempPath);

        // Catat ke log aktivitas
        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('database_backup', ?, ?, datetime('now'))
            `).run(`Download Backup Database Full (${backupFileName})`, req.user?.id || null);
        } catch (e) {}

        res.download(tempPath, backupFileName, (err) => {
            if (err) {
                console.error('[Settings] Error sending full backup:', err.message);
            }
            try {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            } catch (e) {}
        });
    } catch (err) {
        console.error('[Settings] Error creating full backup:', err.message);
        req.flash('error', 'Gagal membuat backup database: ' + err.message);
        res.redirect('/settings#tab-database-services');
    }
});

// =========================================================================
// HELPER FUNGSIONALITAS BACKUP & RESTORE SPREADSHEET (EXCEL & CSV)
// =========================================================================

/**
 * Normalisasi header kolom spreadsheet/CSV agar seragam dan case-insensitive
 */
function normalizeColumnHeader(str) {
    if (!str) return '';
    return String(str)
        .replace(/^\uFEFF/, '')
        .replace(/['"]/g, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}

/**
 * Map baris spreadsheet ke model data pelanggan
 */
function mapCustomerRow(row, packageMapByName = {}) {
    const norm = {};
    for (const [k, v] of Object.entries(row)) {
        norm[normalizeColumnHeader(k)] = v;
    }

    const name = norm.nama_pelanggan || norm.nama || norm.name || '';
    if (!name && !norm.id_pelanggan && !norm.customer_id && !norm.id) {
        return null;
    }

    // Nomor HP / WA: pertahankan string dan pastikan awalan 0
    let phone = norm.nomor_whatsapp_hp || norm.no_whatsapp || norm.no_wa || norm.no_hp || norm.telepon || norm.phone || '';
    phone = String(phone).trim();
    if (/^[1-9]\d{7,14}$/.test(phone)) {
        phone = '0' + phone;
    }

    let packageId = parseInt(norm.id_paket || norm.paket_id || norm.package_id, 10) || null;
    if (!packageId && (norm.nama_paket || norm.paket_layanan || norm.package_name)) {
        const pkgKey = String(norm.nama_paket || norm.paket_layanan || norm.package_name).trim().toLowerCase();
        if (packageMapByName[pkgKey]) {
            packageId = packageMapByName[pkgKey];
        }
    }

    const id = parseInt(norm.id, 10) || null;
    const customerId = norm.id_pelanggan || norm.kode_pelanggan || norm.customer_id || null;
    const address = norm.alamat || norm.address || '';
    const email = norm.email || '';
    const connectionType = norm.tipe_koneksi || norm.connection_type || 'pppoe';
    const pppoeUsername = norm.pppoe_username || norm.username_pppoe || norm.username || '';
    const pppoePassword = norm.pppoe_password || norm.password_pppoe || norm.password || '';
    const ipAddress = norm.alamat_ip || norm.ip_address || norm.ip || null;
    const macAddress = norm.mac_address || norm.mac || null;
    const gatewayIp = norm.ip_gateway_router || norm.gateway_ip || norm.router_gateway || null;
    const routerId = parseInt(norm.id_router || norm.router_id, 10) || null;
    const onuSerial = norm.serial_onu || norm.sn_onu || norm.onu_serial || null;
    const latitude = norm.latitude || norm.lat ? parseFloat(norm.latitude || norm.lat) : null;
    const longitude = norm.longitude || norm.lng ? parseFloat(norm.longitude || norm.lng) : null;
    const installationDate = norm.tanggal_pasang || norm.installation_date || null;
    const dueDate = parseInt(norm.jatuh_tempo_tgl || norm.jatuh_tempo || norm.tanggal_jatuh_tempo || norm.due_date, 10) || 8;
    const status = norm.status || 'active';
    const additionalBill = parseFloat(norm.tagihan_tambahan_rp || norm.tagihan_tambahan || norm.tagihan_lainnya || norm.additional_bill) || 0;
    const additionalBillDesc = norm.keterangan_tagihan_tambahan || norm.keterangan_tambahan || norm.additional_bill_desc || null;
    const notes = norm.catatan || norm.keterangan || norm.notes || '';
    const createdAt = norm.tanggal_terdaftar || norm.dibuat || norm.created_at || null;
    const updatedAt = norm.terakhir_diubah || norm.updated_at || null;

    return {
        id,
        customer_id: customerId,
        name: name || 'Pelanggan',
        address,
        phone,
        email,
        package_id: packageId,
        connection_type: connectionType,
        pppoe_username: pppoeUsername,
        pppoe_password: pppoePassword,
        ip_address: ipAddress,
        mac_address: macAddress,
        gateway_ip: gatewayIp,
        router_id: routerId,
        latitude,
        longitude,
        onu_serial: onuSerial,
        installation_date: installationDate,
        due_date: dueDate,
        status,
        notes,
        additional_bill: additionalBill,
        additional_bill_desc: additionalBillDesc,
        created_at: createdAt,
        updated_at: updatedAt
    };
}

/**
 * Map baris spreadsheet ke model data paket internet
 */
function mapPackageRow(row) {
    const norm = {};
    for (const [k, v] of Object.entries(row)) {
        norm[normalizeColumnHeader(k)] = v;
    }

    const name = norm.nama_paket || norm.nama || norm.name || '';
    if (!name) return null;

    const id = parseInt(norm.id, 10) || null;
    const speedDown = parseInt(norm.download_mbps || norm.speed_down || norm.kecepatan_down, 10) || 10;
    const speedUp = parseInt(norm.upload_mbps || norm.speed_up || norm.kecepatan_up, 10) || 10;
    const price = parseFloat(norm.harga_rp || norm.harga || norm.price) || 0;
    const description = norm.keterangan || norm.deskripsi || norm.description || '';
    const isBypass = (norm.bypass_gratis === 1 || norm.bypass_gratis === '1' || String(norm.bypass_gratis).toLowerCase() === 'ya' || norm.is_bypass === 1) ? 1 : 0;
    const isActive = (norm.status_aktif === 0 || norm.status_aktif === '0' || String(norm.status_aktif).toLowerCase() === 'nonaktif' || norm.is_active === 0) ? 0 : 1;
    const createdAt = norm.tanggal_dibuat || norm.created_at || new Date().toISOString();

    return {
        id,
        name,
        speed_down: speedDown,
        speed_up: speedUp,
        price,
        description,
        is_bypass: isBypass,
        is_active: isActive,
        created_at: createdAt
    };
}

/**
 * Map baris spreadsheet ke model data tagihan invoice
 */
function mapInvoiceRow(row, customerMap = {}) {
    const norm = {};
    for (const [k, v] of Object.entries(row)) {
        norm[normalizeColumnHeader(k)] = v;
    }

    const invoiceNumber = norm.no_invoice || norm.nomor_invoice || norm.invoice_number || '';
    if (!invoiceNumber && !norm.id && !norm.id_invoice) return null;

    const id = parseInt(norm.id_invoice || norm.id, 10) || null;
    let customerId = parseInt(norm.id_pelanggan || norm.customer_id, 10) || null;
    if (!customerId && (norm.nama_pelanggan || norm.customer_name)) {
        const custKey = String(norm.nama_pelanggan || norm.customer_name).trim().toLowerCase();
        if (customerMap[custKey]) customerId = customerMap[custKey];
    }

    const amount = parseFloat(norm.jumlah_tagihan_rp || norm.jumlah_tagihan || norm.amount || norm.total) || 0;
    const period = norm.periode || norm.period || '';
    const dueDate = norm.jatuh_tempo || norm.tanggal_jatuh_tempo || norm.due_date || '';
    const paidDate = norm.tanggal_lunas || norm.paid_date || null;
    const status = norm.status || (paidDate ? 'paid' : 'unpaid');
    const waSent = (norm.wa_terkirim === 1 || norm.wa_terkirim === '1' || String(norm.wa_terkirim).toLowerCase() === 'ya' || norm.whatsapp_sent === 1) ? 1 : 0;
    const waSentAt = norm.waktu_kirim_wa || norm.whatsapp_sent_at || null;
    const notes = norm.catatan || norm.notes || '';
    const createdAt = norm.waktu_dibuat || norm.created_at || new Date().toISOString();

    return {
        id,
        invoice_number: invoiceNumber,
        customer_id: customerId,
        amount,
        period,
        due_date: dueDate,
        paid_date: paidDate,
        status,
        whatsapp_sent: waSent,
        whatsapp_sent_at: waSentAt,
        notes,
        created_at: createdAt
    };
}

/**
 * Map baris spreadsheet ke model data pembayaran transaksi
 */
function mapPaymentRow(row, invoiceMapByNumber = {}) {
    const norm = {};
    for (const [k, v] of Object.entries(row)) {
        norm[normalizeColumnHeader(k)] = v;
    }

    const id = parseInt(norm.id_pembayaran || norm.id, 10) || null;
    let invoiceId = parseInt(norm.id_invoice || norm.invoice_id, 10) || null;
    const invNumber = norm.no_invoice || norm.nomor_invoice || norm.invoice_number || '';
    if (!invoiceId && invNumber && invoiceMapByNumber[invNumber]) {
        invoiceId = invoiceMapByNumber[invNumber];
    }

    const amount = parseFloat(norm.jumlah_pembayaran_rp || norm.jumlah_pembayaran || norm.jumlah || norm.amount) || 0;
    const paymentMethod = norm.metode_pembayaran || norm.metode || norm.payment_method || 'cash';
    const paymentDate = norm.tanggal_pembayaran || norm.payment_date || new Date().toISOString();
    const receivedBy = norm.diterima_oleh || norm.received_by || 'Admin';
    const notes = norm.catatan || norm.notes || '';
    const createdAt = norm.waktu_dicatat || norm.created_at || new Date().toISOString();

    if (!invoiceId && !amount) return null;

    return {
        id,
        invoice_id: invoiceId,
        amount,
        payment_method: paymentMethod,
        payment_date: paymentDate,
        received_by: receivedBy,
        notes,
        created_at: createdAt
    };
}

// 4.2 Backup Database Pelanggan Saja (.xlsx, .csv, atau .json)
router.get('/backup/customers', (req, res) => {
    try {
        const format = (req.query.format || 'excel').toLowerCase();
        const timestamp = moment().format('YYYY-MM-DD_HHmmss');

        const packages = db.prepare('SELECT * FROM packages ORDER BY id ASC').all();
        const customers = db.prepare(`
            SELECT c.*, p.name as package_name
            FROM customers c
            LEFT JOIN packages p ON c.package_id = p.id
            ORDER BY c.id ASC
        `).all();

        // 1. Log aktivitas
        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('database_backup', ?, ?, datetime('now'))
            `).run(`Download Backup Pelanggan (${customers.length} data, format: ${format.toUpperCase()})`, req.user?.id || null);
        } catch (e) {}

        // Format: JSON (kompatibilitas backward)
        if (format === 'json') {
            const exportData = {
                export_type: 'customers_and_packages',
                app_name: 'ISP Manager',
                exported_at: new Date().toISOString(),
                total_customers: customers.length,
                total_packages: packages.length,
                packages,
                customers
            };
            const fileName = `backup-pelanggan_${timestamp}.json`;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
            return res.send(JSON.stringify(exportData, null, 2));
        }

        // Siapkan baris data Pelanggan
        const customerRows = customers.map(c => ({
            'ID': c.id,
            'ID Pelanggan': c.customer_id || '',
            'Nama Pelanggan': c.name || '',
            'Nomor WhatsApp / HP': c.phone ? String(c.phone) : '',
            'Email': c.email || '',
            'Alamat': c.address || '',
            'ID Paket': c.package_id || '',
            'Nama Paket': c.package_name || '',
            'Tipe Koneksi': c.connection_type || 'pppoe',
            'PPPoE Username': c.pppoe_username || '',
            'PPPoE Password': c.pppoe_password || '',
            'Alamat IP': c.ip_address || '',
            'MAC Address': c.mac_address || '',
            'IP Gateway Router': c.gateway_ip || '',
            'ID Router': c.router_id || '',
            'Serial ONU': c.onu_serial || '',
            'Latitude': c.latitude ?? '',
            'Longitude': c.longitude ?? '',
            'Tanggal Pasang': c.installation_date || '',
            'Jatuh Tempo (Tgl)': c.due_date ?? 8,
            'Status': c.status || 'active',
            'Tagihan Tambahan (Rp)': c.additional_bill ?? 0,
            'Keterangan Tagihan Tambahan': c.additional_bill_desc || '',
            'Catatan': c.notes || '',
            'Tanggal Terdaftar': c.created_at || '',
            'Terakhir Diubah': c.updated_at || ''
        }));

        // Format: CSV
        if (format === 'csv') {
            const fileName = `backup-pelanggan_${timestamp}.csv`;
            const ws = XLSX.utils.json_to_sheet(customerRows);
            const csvOutput = '\uFEFF' + XLSX.utils.sheet_to_csv(ws);
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
            return res.send(Buffer.from(csvOutput, 'utf8'));
        }

        // Format: Excel (.xlsx) Default
        const packageRows = packages.map(p => ({
            'ID': p.id,
            'Nama Paket': p.name || '',
            'Download (Mbps)': p.speed_down ?? 0,
            'Upload (Mbps)': p.speed_up ?? 0,
            'Harga (Rp)': p.price ?? 0,
            'Keterangan': p.description || '',
            'Bypass / Gratis': p.is_bypass ? 'Ya' : 'Tidak',
            'Status Aktif': p.is_active ? 'Aktif' : 'Nonaktif',
            'Tanggal Dibuat': p.created_at || ''
        }));

        const wb = XLSX.utils.book_new();
        const wsCustomers = XLSX.utils.json_to_sheet(customerRows);
        const wsPackages = XLSX.utils.json_to_sheet(packageRows);

        wsCustomers['!cols'] = [
            { wch: 6 },  // ID
            { wch: 14 }, // ID Pelanggan
            { wch: 25 }, // Nama Pelanggan
            { wch: 18 }, // Nomor WhatsApp / HP
            { wch: 22 }, // Email
            { wch: 30 }, // Alamat
            { wch: 10 }, // ID Paket
            { wch: 22 }, // Nama Paket
            { wch: 14 }, // Tipe Koneksi
            { wch: 18 }, // PPPoE Username
            { wch: 18 }, // PPPoE Password
            { wch: 16 }, // Alamat IP
            { wch: 18 }, // MAC Address
            { wch: 18 }, // IP Gateway Router
            { wch: 10 }, // ID Router
            { wch: 20 }, // Serial ONU
            { wch: 12 }, // Lat
            { wch: 12 }, // Lng
            { wch: 15 }, // Tanggal Pasang
            { wch: 16 }, // Jatuh Tempo
            { wch: 12 }, // Status
            { wch: 25 }, // Catatan
            { wch: 20 }, // Tanggal Terdaftar
            { wch: 20 }  // Terakhir Diubah
        ];

        wsPackages['!cols'] = [
            { wch: 6 },  // ID
            { wch: 24 }, // Nama Paket
            { wch: 16 }, // Download
            { wch: 16 }, // Upload
            { wch: 16 }, // Harga
            { wch: 25 }, // Keterangan
            { wch: 16 }, // Bypass
            { wch: 14 }, // Status Aktif
            { wch: 20 }  // Tanggal Dibuat
        ];

        XLSX.utils.book_append_sheet(wb, wsCustomers, 'Data Pelanggan');
        XLSX.utils.book_append_sheet(wb, wsPackages, 'Paket Internet');

        const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const fileName = `backup-pelanggan_${timestamp}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.send(excelBuffer);

    } catch (err) {
        console.error('[Settings] Error backup customers:', err.message);
        req.flash('error', 'Gagal backup data pelanggan: ' + err.message);
        res.redirect('/settings#tab-database-services');
    }
});

// 4.3 Backup Database Laporan / Pemasukan Saja (.xlsx, .csv, atau .json)
router.get('/backup/reports', (req, res) => {
    try {
        const format = (req.query.format || 'excel').toLowerCase();
        const timestamp = moment().format('YYYY-MM-DD_HHmmss');

        const invoices = db.prepare(`
            SELECT i.*, c.name as customer_name, c.customer_id as customer_code
            FROM invoices i
            LEFT JOIN customers c ON i.customer_id = c.id
            ORDER BY i.id DESC
        `).all();

        const payments = db.prepare(`
            SELECT p.*, i.invoice_number, c.name as customer_name, c.customer_id as customer_code
            FROM payments p
            LEFT JOIN invoices i ON p.invoice_id = i.id
            LEFT JOIN customers c ON i.customer_id = c.id
            ORDER BY p.id DESC
        `).all();

        const totalRevenue = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);

        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('database_backup', ?, ?, datetime('now'))
            `).run(`Download Backup Laporan & Pemasukan (${payments.length} transaksi, format: ${format.toUpperCase()})`, req.user?.id || null);
        } catch (e) {}

        // Format: JSON (kompatibilitas backward)
        if (format === 'json') {
            const exportData = {
                export_type: 'financial_reports',
                app_name: 'ISP Manager',
                exported_at: new Date().toISOString(),
                total_invoices: invoices.length,
                total_payments: payments.length,
                total_revenue: totalRevenue,
                invoices,
                payments
            };
            const fileName = `backup-laporan-keuangan_${timestamp}.json`;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
            return res.send(JSON.stringify(exportData, null, 2));
        }

        const paymentRows = payments.map(p => ({
            'ID Pembayaran': p.id,
            'ID Invoice': p.invoice_id || '',
            'No Invoice': p.invoice_number || '',
            'ID Pelanggan': p.customer_code || '',
            'Nama Pelanggan': p.customer_name || '',
            'Jumlah Pembayaran (Rp)': p.amount ?? 0,
            'Metode Pembayaran': p.payment_method || 'cash',
            'Tanggal Pembayaran': p.payment_date || '',
            'Diterima Oleh': p.received_by || '',
            'Catatan': p.notes || '',
            'Waktu Dicatat': p.created_at || ''
        }));

        const invoiceRows = invoices.map(i => ({
            'ID Invoice': i.id,
            'No Invoice': i.invoice_number || '',
            'ID Pelanggan': i.customer_code || '',
            'Nama Pelanggan': i.customer_name || '',
            'Periode': i.period || '',
            'Jumlah Tagihan (Rp)': i.amount ?? 0,
            'Jatuh Tempo': i.due_date || '',
            'Tanggal Lunas': i.paid_date || '',
            'Status': i.status || 'unpaid',
            'WA Terkirim': i.whatsapp_sent ? 'Ya' : 'Tidak',
            'Waktu Kirim WA': i.whatsapp_sent_at || '',
            'Catatan': i.notes || '',
            'Waktu Dibuat': i.created_at || ''
        }));

        // Format: CSV (Default ekspor riwayat pembayaran keuangan, atau data tagihan jika belum ada pembayaran)
        if (format === 'csv') {
            const fileName = `backup-laporan-keuangan_${timestamp}.csv`;
            const exportRows = paymentRows.length > 0 ? paymentRows : invoiceRows;
            const ws = XLSX.utils.json_to_sheet(exportRows);
            const csvOutput = '\uFEFF' + XLSX.utils.sheet_to_csv(ws);
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
            return res.send(Buffer.from(csvOutput, 'utf8'));
        }

        // Format: Excel (.xlsx) Default
        const wb = XLSX.utils.book_new();
        const wsPayments = XLSX.utils.json_to_sheet(paymentRows);
        const wsInvoices = XLSX.utils.json_to_sheet(invoiceRows);

        wsPayments['!cols'] = [
            { wch: 14 }, // ID Pembayaran
            { wch: 12 }, // ID Invoice
            { wch: 20 }, // No Invoice
            { wch: 14 }, // ID Pelanggan
            { wch: 25 }, // Nama Pelanggan
            { wch: 22 }, // Jumlah Pembayaran
            { wch: 18 }, // Metode
            { wch: 20 }, // Tgl Bayar
            { wch: 18 }, // Diterima Oleh
            { wch: 25 }, // Catatan
            { wch: 20 }  // Waktu Dicatat
        ];

        wsInvoices['!cols'] = [
            { wch: 12 }, // ID Invoice
            { wch: 20 }, // No Invoice
            { wch: 14 }, // ID Pelanggan
            { wch: 25 }, // Nama Pelanggan
            { wch: 12 }, // Periode
            { wch: 20 }, // Jumlah Tagihan
            { wch: 15 }, // Jatuh Tempo
            { wch: 15 }, // Tgl Lunas
            { wch: 12 }, // Status
            { wch: 14 }, // WA Terkirim
            { wch: 20 }, // Waktu Kirim WA
            { wch: 25 }, // Catatan
            { wch: 20 }  // Waktu Dibuat
        ];

        XLSX.utils.book_append_sheet(wb, wsPayments, 'Riwayat Pembayaran');
        XLSX.utils.book_append_sheet(wb, wsInvoices, 'Data Tagihan & Invoice');

        const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const fileName = `backup-laporan-keuangan_${timestamp}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.send(excelBuffer);

    } catch (err) {
        console.error('[Settings] Error backup reports:', err.message);
        req.flash('error', 'Gagal backup data laporan: ' + err.message);
        res.redirect('/settings#tab-database-services');
    }
});

// 4.4 Backup Database Pengaturan Saja (.json)
router.get('/backup/settings', (req, res) => {
    try {
        const timestamp = moment().format('YYYY-MM-DD_HHmmss');
        const settingsRows = db.prepare('SELECT key, value FROM settings').all();
        const settingsMap = {};
        settingsRows.forEach(r => settingsMap[r.key] = r.value);

        // Jangan sertakan password sensitif dalam plain text yang tidak perlu
        const routers = db.prepare(`
            SELECT id, name, host, port, username, isolir_address_list, is_active, is_default, created_at
            FROM routers
        `).all();

        const exportData = {
            export_type: 'system_settings',
            app_name: 'ISP Manager',
            exported_at: new Date().toISOString(),
            total_settings_keys: settingsRows.length,
            settings: settingsMap,
            routers
        };

        const fileName = `backup-pengaturan_${timestamp}.json`;

        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('database_backup', ?, ?, datetime('now'))
            `).run('Download Backup Pengaturan Sistem', req.user?.id || null);
        } catch (e) {}

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.send(JSON.stringify(exportData, null, 2));
    } catch (err) {
        console.error('[Settings] Error backup settings:', err.message);
        req.flash('error', 'Gagal backup pengaturan: ' + err.message);
        res.redirect('/settings#tab-database-services');
    }
});

// 4.5 Database Maintenance (VACUUM & Optimize)
router.post('/database/vacuum', (req, res) => {
    try {
        db.exec('VACUUM');
        db.exec('PRAGMA optimize');

        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('database_vacuum', 'Optimasi Database SQLite (VACUUM & PRAGMA optimize)', ?, datetime('now'))
            `).run(req.user?.id || null);
        } catch (e) {}

        req.flash('success', 'Database SQLite berhasil dioptimalkan (VACUUM & PRAGMA optimize).');
    } catch (err) {
        console.error('[Settings] Vacuum error:', err.message);
        req.flash('error', 'Gagal mengoptimalkan database: ' + err.message);
    }
    res.redirect('/settings#tab-database-services');
});

// =========================================================================
// 4.6 BAGIAN RESTORE: PEMULIHAN DATABASE DARI BACKUP
// =========================================================================

const uploadDir = path.join(__dirname, '../database/uploads');
if (!fs.existsSync(uploadDir)) {
    try { fs.mkdirSync(uploadDir, { recursive: true }); } catch (e) {}
}

const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 50 * 1024 * 1024 } // Maksimal 50 MB
});

// 4.6.1 Restore Full Database (.db)
router.post('/restore/full', upload.single('backup_file'), async (req, res) => {
    if (!req.file) {
        req.flash('error', 'Silakan pilih berkas file database (.db) yang akan direstore.');
        return res.redirect('/settings#tab-database-services');
    }

    const uploadedPath = req.file.path;
    const originalName = req.file.originalname;

    try {
        if (!originalName.toLowerCase().endsWith('.db') && !originalName.toLowerCase().endsWith('.sqlite') && !originalName.toLowerCase().endsWith('.sqlite3')) {
            throw new Error('Format berkas tidak valid. Harap pilih berkas dengan ekstensi .db atau .sqlite.');
        }

        // Validasi header SQLite (16 byte pertama: "SQLite format 3\0")
        const fd = fs.openSync(uploadedPath, 'r');
        const headerBuf = Buffer.alloc(16);
        fs.readSync(fd, headerBuf, 0, 16, 0);
        fs.closeSync(fd);
        if (headerBuf.toString('utf8', 0, 15) !== 'SQLite format 3') {
            throw new Error('Berkas yang diunggah bukan database SQLite yang valid.');
        }

        // 1. Buat cadangan keselamatan otomatis (Pre-Restore Safety Backup)
        const timestamp = moment().format('YYYY-MM-DD_HHmmss');
        const safetyBackupName = `pre-restore-safety-backup_${timestamp}.db`;
        const safetyBackupPath = path.join(__dirname, '../database', safetyBackupName);
        await db.backup(safetyBackupPath);

        // 2. Attach uploaded database dan periksa struktur tabel
        const safePath = uploadedPath.replace(/\\/g, '/');
        db.exec(`ATTACH DATABASE '${safePath}' AS uploaded_db`);

        let tablesToRestore = [];
        try {
            const tables = db.prepare("SELECT name FROM uploaded_db.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
            tablesToRestore = tables.map(t => t.name);

            // Validasi keberadaan tabel penting
            const requiredTables = ['users', 'settings', 'customers'];
            const missingTables = requiredTables.filter(t => !tablesToRestore.includes(t));
            if (missingTables.length > 0) {
                throw new Error(`Berkas database tidak sesuai atau tidak lengkap (kurang tabel: ${missingTables.join(', ')}).`);
            }
        } catch (checkErr) {
            try { db.exec('DETACH DATABASE uploaded_db'); } catch (e) {}
            throw checkErr;
        }

        // 3. Eksekusi Restore Transaksional
        db.pragma('foreign_keys = OFF');
        try {
            const restoreTx = db.transaction(() => {
                for (const tbl of tablesToRestore) {
                    db.exec(`DELETE FROM main."${tbl}"`);
                    db.exec(`INSERT INTO main."${tbl}" SELECT * FROM uploaded_db."${tbl}"`);
                }
            });
            restoreTx();
        } finally {
            db.pragma('foreign_keys = ON');
            try { db.exec('DETACH DATABASE uploaded_db'); } catch (e) {}
        }

        // Catat ke log aktivitas
        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('database_restore', ?, ?, datetime('now'))
            `).run(`Restore Full Database dari berkas ${originalName} (Safety backup: ${safetyBackupName})`, req.user?.id || null);
        } catch (e) {}

        req.flash('success', `Database full berhasil dipulihkan dari "${originalName}". Cadangan keselamatan tersimpan sebagai "${safetyBackupName}".`);
    } catch (err) {
        console.error('[Settings] Error restore full database:', err.message);
        req.flash('error', 'Gagal memulihkan database: ' + err.message);
    } finally {
        try {
            if (fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
        } catch (e) {}
    }

    res.redirect('/settings#tab-database-services');
});

// 4.6.2 Restore / Impor Pelanggan Saja (.xlsx, .csv, atau .json)
router.post('/restore/customers', upload.single('backup_file'), (req, res) => {
    if (!req.file) {
        req.flash('error', 'Silakan pilih berkas backup pelanggan (.xlsx, .csv, atau .json) yang akan diimpor.');
        return res.redirect('/settings#tab-database-services');
    }

    const uploadedPath = req.file.path;
    const originalName = (req.file.originalname || '').toLowerCase();

    try {
        let customersRawList = [];
        let packagesRawList = [];

        if (originalName.endsWith('.json')) {
            const fileContent = fs.readFileSync(uploadedPath, 'utf8');
            const data = JSON.parse(fileContent);

            if (!data || (!data.customers && !Array.isArray(data))) {
                throw new Error('Format JSON berkas pelanggan tidak valid.');
            }

            customersRawList = Array.isArray(data) ? data : (data.customers || []);
            packagesRawList = data.packages || [];
        } else {
            // Excel (.xlsx, .xls) atau CSV (.csv)
            const workbook = XLSX.readFile(uploadedPath, { raw: false, defval: '' });
            const sheetNames = workbook.SheetNames;
            if (!sheetNames || sheetNames.length === 0) {
                throw new Error('Berkas spreadsheet kosong atau tidak dapat dibaca.');
            }

            // Cari sheet Pelanggan
            let customerSheetName = sheetNames.find(n => /pelanggan|customer/i.test(n)) || sheetNames[0];
            const custSheet = workbook.Sheets[customerSheetName];
            customersRawList = XLSX.utils.sheet_to_json(custSheet, { raw: false, defval: '' });

            // Cari sheet Paket jika ada
            let packageSheetName = sheetNames.find(n => /paket|package/i.test(n) && n !== customerSheetName);
            if (packageSheetName) {
                const pkgSheet = workbook.Sheets[packageSheetName];
                packagesRawList = XLSX.utils.sheet_to_json(pkgSheet, { raw: false, defval: '' });
            }
        }

        if (customersRawList.length === 0 && packagesRawList.length === 0) {
            throw new Error('Tidak ditemukan data pelanggan atau paket dalam berkas yang diunggah.');
        }

        // Cache paket yang sudah ada di database untuk lookup by name
        const existingPackages = db.prepare('SELECT id, LOWER(name) as name_lower FROM packages').all();
        const packageMapByName = {};
        existingPackages.forEach(p => { packageMapByName[p.name_lower] = p.id; });

        let importedPackages = 0;
        let importedCustomers = 0;

        const importTx = db.transaction(() => {
            // 1. Impor / perbarui packages
            if (Array.isArray(packagesRawList) && packagesRawList.length > 0) {
                const checkPkgById = db.prepare('SELECT id FROM packages WHERE id = ?');
                const checkPkgByName = db.prepare('SELECT id FROM packages WHERE LOWER(name) = ?');
                const updatePkg = db.prepare(`
                    UPDATE packages SET
                        name = ?, speed_down = ?, speed_up = ?, price = ?,
                        description = ?, is_bypass = ?, is_active = ?
                    WHERE id = ?
                `);
                const insertPkgWithId = db.prepare(`
                    INSERT INTO packages (id, name, speed_down, speed_up, price, description, is_bypass, is_active, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                const insertPkgNoId = db.prepare(`
                    INSERT INTO packages (name, speed_down, speed_up, price, description, is_bypass, is_active, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `);

                for (const rawPkg of packagesRawList) {
                    const pkg = mapPackageRow(rawPkg);
                    if (!pkg || !pkg.name) continue;

                    let existingId = null;
                    if (pkg.id && checkPkgById.get(pkg.id)) {
                        existingId = pkg.id;
                    } else {
                        const byName = checkPkgByName.get(pkg.name.toLowerCase());
                        if (byName) existingId = byName.id;
                    }

                    if (existingId) {
                        updatePkg.run(pkg.name, pkg.speed_down, pkg.speed_up, pkg.price, pkg.description, pkg.is_bypass, pkg.is_active, existingId);
                        packageMapByName[pkg.name.toLowerCase()] = existingId;
                    } else {
                        if (pkg.id) {
                            insertPkgWithId.run(pkg.id, pkg.name, pkg.speed_down, pkg.speed_up, pkg.price, pkg.description, pkg.is_bypass, pkg.is_active, pkg.created_at);
                            packageMapByName[pkg.name.toLowerCase()] = pkg.id;
                        } else {
                            const resPkg = insertPkgNoId.run(pkg.name, pkg.speed_down, pkg.speed_up, pkg.price, pkg.description, pkg.is_bypass, pkg.is_active, pkg.created_at);
                            packageMapByName[pkg.name.toLowerCase()] = resPkg.lastInsertRowid;
                        }
                    }
                    importedPackages++;
                }
            }

            // 2. Impor / perbarui customers
            const checkCustById = db.prepare('SELECT id, customer_id FROM customers WHERE id = ?');
            const checkCustByCode = db.prepare('SELECT id, customer_id FROM customers WHERE customer_id = ?');
            const checkCustByPhone = db.prepare("SELECT id, customer_id FROM customers WHERE phone = ? AND phone != ''");

            const updateCust = db.prepare(`
                UPDATE customers SET
                    customer_id = ?, name = ?, address = ?, phone = ?, email = ?,
                    package_id = ?, connection_type = ?, pppoe_username = ?, pppoe_password = ?,
                    ip_address = ?, mac_address = ?, gateway_ip = ?, router_id = ?,
                    latitude = ?, longitude = ?, onu_serial = ?, installation_date = ?,
                    due_date = ?, status = ?, notes = ?,
                    additional_bill = ?, additional_bill_desc = ?,
                    updated_at = datetime('now')
                WHERE id = ?
            `);

            const insertCustWithId = db.prepare(`
                INSERT INTO customers (
                    id, customer_id, name, address, phone, email,
                    package_id, connection_type, pppoe_username, pppoe_password,
                    ip_address, mac_address, gateway_ip, router_id,
                    latitude, longitude, onu_serial, installation_date,
                    due_date, status, notes,
                    additional_bill, additional_bill_desc,
                    created_at, updated_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?,
                    ?, datetime('now')
                )
            `);

            const insertCustNoId = db.prepare(`
                INSERT INTO customers (
                    customer_id, name, address, phone, email,
                    package_id, connection_type, pppoe_username, pppoe_password,
                    ip_address, mac_address, gateway_ip, router_id,
                    latitude, longitude, onu_serial, installation_date,
                    due_date, status, notes,
                    additional_bill, additional_bill_desc,
                    created_at, updated_at
                ) VALUES (
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?,
                    ?, datetime('now')
                )
            `);

            const getLastCustId = () => {
                const row = db.prepare("SELECT customer_id FROM customers WHERE customer_id LIKE 'CUST-%' ORDER BY id DESC LIMIT 1").get();
                let nextNum = 1;
                if (row && row.customer_id) {
                    const m = row.customer_id.match(/CUST-(\d+)/);
                    if (m) nextNum = parseInt(m[1], 10) + 1;
                }
                return `CUST-${String(nextNum).padStart(4, '0')}`;
            };

            for (const rawCust of customersRawList) {
                const cust = mapCustomerRow(rawCust, packageMapByName);
                if (!cust || !cust.name) continue;

                let existing = null;
                if (cust.id && checkCustById.get(cust.id)) {
                    existing = checkCustById.get(cust.id);
                } else if (cust.customer_id && checkCustByCode.get(cust.customer_id)) {
                    existing = checkCustByCode.get(cust.customer_id);
                } else if (cust.phone && checkCustByPhone.get(cust.phone)) {
                    existing = checkCustByPhone.get(cust.phone);
                }

                const effectiveCustCode = cust.customer_id || (existing ? existing.customer_id : getLastCustId());

                if (existing) {
                    updateCust.run(
                        effectiveCustCode,
                        cust.name,
                        cust.address,
                        cust.phone,
                        cust.email,
                        cust.package_id,
                        cust.connection_type,
                        cust.pppoe_username,
                        cust.pppoe_password,
                        cust.ip_address,
                        cust.mac_address,
                        cust.gateway_ip,
                        cust.router_id,
                        cust.latitude,
                        cust.longitude,
                        cust.onu_serial,
                        cust.installation_date,
                        cust.due_date,
                        cust.status,
                        cust.notes,
                        cust.additional_bill || 0,
                        cust.additional_bill_desc || null,
                        existing.id
                    );
                } else {
                    if (cust.id) {
                        insertCustWithId.run(
                            cust.id,
                            effectiveCustCode,
                            cust.name,
                            cust.address,
                            cust.phone,
                            cust.email,
                            cust.package_id,
                            cust.connection_type,
                            cust.pppoe_username,
                            cust.pppoe_password,
                            cust.ip_address,
                            cust.mac_address,
                            cust.gateway_ip,
                            cust.router_id,
                            cust.latitude,
                            cust.longitude,
                            cust.onu_serial,
                            cust.installation_date,
                            cust.due_date,
                            cust.status,
                            cust.notes,
                            cust.additional_bill || 0,
                            cust.additional_bill_desc || null,
                            cust.created_at || new Date().toISOString()
                        );
                    } else {
                        insertCustNoId.run(
                            effectiveCustCode,
                            cust.name,
                            cust.address,
                            cust.phone,
                            cust.email,
                            cust.package_id,
                            cust.connection_type,
                            cust.pppoe_username,
                            cust.pppoe_password,
                            cust.ip_address,
                            cust.mac_address,
                            cust.gateway_ip,
                            cust.router_id,
                            cust.latitude,
                            cust.longitude,
                            cust.onu_serial,
                            cust.installation_date,
                            cust.due_date,
                            cust.status,
                            cust.notes,
                            cust.additional_bill || 0,
                            cust.additional_bill_desc || null,
                            cust.created_at || new Date().toISOString()
                        );
                    }
                }
                importedCustomers++;
            }
        });

        importTx();

        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('database_restore', ?, ?, datetime('now'))
            `).run(`Impor / Restore ${importedCustomers} data pelanggan dan ${importedPackages} paket internet (Berkas: ${req.file.originalname})`, req.user?.id || null);
        } catch (e) {}

        req.flash('success', `Berhasil memulihkan ${importedCustomers} data pelanggan dan ${importedPackages} paket internet.`);
    } catch (err) {
        console.error('[Settings] Error restore customers:', err.message);
        req.flash('error', 'Gagal memulihkan data pelanggan: ' + err.message);
    } finally {
        try { if (fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); } catch (e) {}
    }

    res.redirect('/settings#tab-database-services');
});

// 4.6.3 Restore / Impor Laporan & Transaksi (.xlsx, .csv, atau .json)
router.post('/restore/reports', upload.single('backup_file'), (req, res) => {
    if (!req.file) {
        req.flash('error', 'Silakan pilih berkas backup laporan keuangan (.xlsx, .csv, atau .json) yang akan diimpor.');
        return res.redirect('/settings#tab-database-services');
    }

    const uploadedPath = req.file.path;
    const originalName = (req.file.originalname || '').toLowerCase();

    try {
        let invoicesRawList = [];
        let paymentsRawList = [];

        if (originalName.endsWith('.json')) {
            const fileContent = fs.readFileSync(uploadedPath, 'utf8');
            const data = JSON.parse(fileContent);

            if (!data || (!data.invoices && !data.payments)) {
                throw new Error('Format JSON berkas laporan keuangan tidak valid (harus memiliki data invoices/payments).');
            }

            invoicesRawList = data.invoices || [];
            paymentsRawList = data.payments || [];
        } else {
            // Excel (.xlsx, .xls) atau CSV (.csv)
            const workbook = XLSX.readFile(uploadedPath, { raw: false, defval: '' });
            const sheetNames = workbook.SheetNames;
            if (!sheetNames || sheetNames.length === 0) {
                throw new Error('Berkas spreadsheet kosong atau tidak dapat dibaca.');
            }

            // Cari sheet Pembayaran
            let paySheetName = sheetNames.find(n => /bayar|payment|pembayaran/i.test(n));
            // Cari sheet Invoice / Tagihan
            let invSheetName = sheetNames.find(n => /tagihan|invoice|faktur/i.test(n));

            if (paySheetName) {
                paymentsRawList = XLSX.utils.sheet_to_json(workbook.Sheets[paySheetName], { raw: false, defval: '' });
            }
            if (invSheetName) {
                invoicesRawList = XLSX.utils.sheet_to_json(workbook.Sheets[invSheetName], { raw: false, defval: '' });
            }

            // Jika hanya ada 1 sheet (seperti file CSV)
            if (!paySheetName && !invSheetName && sheetNames.length > 0) {
                const singleSheet = workbook.Sheets[sheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(singleSheet, { raw: false, defval: '' });
                if (rows.length > 0) {
                    const firstRow = rows[0];
                    const firstKeys = Object.keys(firstRow).map(k => normalizeColumnHeader(k));
                    if (firstKeys.some(k => k.includes('bayar') || k.includes('metode') || k.includes('payment'))) {
                        paymentsRawList = rows;
                    } else {
                        invoicesRawList = rows;
                    }
                }
            }
        }

        if (invoicesRawList.length === 0 && paymentsRawList.length === 0) {
            throw new Error('Tidak ditemukan data tagihan atau pembayaran dalam berkas yang diunggah.');
        }

        // Cache customer mapping untuk lookup customer_id
        const customers = db.prepare('SELECT id, customer_id, LOWER(name) as name_lower FROM customers').all();
        const customerMap = {};
        customers.forEach(c => {
            if (c.customer_id) customerMap[c.customer_id.toLowerCase()] = c.id;
            if (c.name_lower) customerMap[c.name_lower] = c.id;
        });

        // Cache invoice mapping
        const existingInvoices = db.prepare('SELECT id, invoice_number FROM invoices').all();
        const invoiceMapByNumber = {};
        existingInvoices.forEach(i => {
            if (i.invoice_number) invoiceMapByNumber[i.invoice_number] = i.id;
        });

        let countInvoices = 0;
        let countPayments = 0;

        const importTx = db.transaction(() => {
            // 1. Impor Invoices
            const checkInvById = db.prepare('SELECT id FROM invoices WHERE id = ?');
            const checkInvByNumber = db.prepare('SELECT id FROM invoices WHERE invoice_number = ?');

            const updateInv = db.prepare(`
                UPDATE invoices SET
                    invoice_number = ?, customer_id = ?, amount = ?, period = ?,
                    due_date = ?, paid_date = ?, status = ?, whatsapp_sent = ?,
                    whatsapp_sent_at = ?, notes = ?
                WHERE id = ?
            `);

            const insertInvWithId = db.prepare(`
                INSERT INTO invoices (id, invoice_number, customer_id, amount, period, due_date, paid_date, status, whatsapp_sent, whatsapp_sent_at, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const insertInvNoId = db.prepare(`
                INSERT INTO invoices (invoice_number, customer_id, amount, period, due_date, paid_date, status, whatsapp_sent, whatsapp_sent_at, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (const rawInv of invoicesRawList) {
                const inv = mapInvoiceRow(rawInv, customerMap);
                if (!inv || !inv.invoice_number) continue;

                let existingId = null;
                if (inv.id && checkInvById.get(inv.id)) {
                    existingId = inv.id;
                } else if (inv.invoice_number && checkInvByNumber.get(inv.invoice_number)) {
                    existingId = checkInvByNumber.get(inv.invoice_number).id;
                }

                if (existingId) {
                    updateInv.run(
                        inv.invoice_number, inv.customer_id, inv.amount, inv.period,
                        inv.due_date, inv.paid_date, inv.status, inv.whatsapp_sent,
                        inv.whatsapp_sent_at, inv.notes, existingId
                    );
                    invoiceMapByNumber[inv.invoice_number] = existingId;
                } else {
                    if (inv.id) {
                        insertInvWithId.run(
                            inv.id, inv.invoice_number, inv.customer_id, inv.amount, inv.period,
                            inv.due_date, inv.paid_date, inv.status, inv.whatsapp_sent,
                            inv.whatsapp_sent_at, inv.notes, inv.created_at
                        );
                        invoiceMapByNumber[inv.invoice_number] = inv.id;
                    } else {
                        const resInv = insertInvNoId.run(
                            inv.invoice_number, inv.customer_id, inv.amount, inv.period,
                            inv.due_date, inv.paid_date, inv.status, inv.whatsapp_sent,
                            inv.whatsapp_sent_at, inv.notes, inv.created_at
                        );
                        invoiceMapByNumber[inv.invoice_number] = resInv.lastInsertRowid;
                    }
                }
                countInvoices++;
            }

            // 2. Impor Payments
            const checkPayById = db.prepare('SELECT id FROM payments WHERE id = ?');
            const updatePay = db.prepare(`
                UPDATE payments SET
                    invoice_id = ?, amount = ?, payment_method = ?,
                    payment_date = ?, received_by = ?, notes = ?
                WHERE id = ?
            `);
            const insertPayWithId = db.prepare(`
                INSERT INTO payments (id, invoice_id, amount, payment_method, payment_date, received_by, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const insertPayNoId = db.prepare(`
                INSERT INTO payments (invoice_id, amount, payment_method, payment_date, received_by, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);

            for (const rawPay of paymentsRawList) {
                const pay = mapPaymentRow(rawPay, invoiceMapByNumber);
                if (!pay || !pay.invoice_id) continue;

                let existingId = null;
                if (pay.id && checkPayById.get(pay.id)) {
                    existingId = pay.id;
                }

                if (existingId) {
                    updatePay.run(
                        pay.invoice_id, pay.amount, pay.payment_method,
                        pay.payment_date, pay.received_by, pay.notes, existingId
                    );
                } else {
                    if (pay.id) {
                        insertPayWithId.run(
                            pay.id, pay.invoice_id, pay.amount, pay.payment_method,
                            pay.payment_date, pay.received_by, pay.notes, pay.created_at
                        );
                    } else {
                        insertPayNoId.run(
                            pay.invoice_id, pay.amount, pay.payment_method,
                            pay.payment_date, pay.received_by, pay.notes, pay.created_at
                        );
                    }
                }
                countPayments++;
            }
        });

        importTx();

        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('database_restore', ?, ?, datetime('now'))
            `).run(`Impor / Restore ${countInvoices} invoice dan ${countPayments} catatan pembayaran (Berkas: ${req.file.originalname})`, req.user?.id || null);
        } catch (e) {}

        req.flash('success', `Berhasil memulihkan ${countInvoices} invoice dan ${countPayments} riwayat pembayaran.`);
    } catch (err) {
        console.error('[Settings] Error restore reports:', err.message);
        req.flash('error', 'Gagal memulihkan data laporan keuangan: ' + err.message);
    } finally {
        try { if (fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); } catch (e) {}
    }

    res.redirect('/settings#tab-database-services');
});

// 4.6.4 Restore / Impor Pengaturan Saja (.json)
router.post('/restore/settings', upload.single('backup_file'), (req, res) => {
    if (!req.file) {
        req.flash('error', 'Silakan pilih berkas backup pengaturan (.json) yang akan diimpor.');
        return res.redirect('/settings#tab-database-services');
    }

    const uploadedPath = req.file.path;
    try {
        const fileContent = fs.readFileSync(uploadedPath, 'utf8');
        const data = JSON.parse(fileContent);

        if (!data || (!data.settings && typeof data !== 'object')) {
            throw new Error('Format JSON berkas pengaturan tidak valid.');
        }

        const settingsMap = data.settings || data;
        const routersList = data.routers || [];

        let countSettings = 0;
        let countRouters = 0;

        const importTx = db.transaction(() => {
            const upsertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime("now"))');

            for (const [k, v] of Object.entries(settingsMap)) {
                if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                    upsertSetting.run(k, String(v));
                    countSettings++;
                }
            }

            if (Array.isArray(routersList) && routersList.length > 0) {
                const upsertRouter = db.prepare(`
                    INSERT INTO routers (id, name, host, port, username, password, isolir_address_list, description, is_active, is_default, created_at, updated_at)
                    VALUES (@id, @name, @host, @port, @username, @password, @isolir_address_list, @description, @is_active, @is_default, @created_at, @updated_at)
                    ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        host = excluded.host,
                        port = excluded.port,
                        username = excluded.username,
                        isolir_address_list = excluded.isolir_address_list,
                        description = excluded.description,
                        is_active = excluded.is_active,
                        is_default = excluded.is_default,
                        updated_at = datetime('now')
                `);

                for (const r of routersList) {
                    upsertRouter.run({
                        id: r.id || null,
                        name: r.name || 'Router',
                        host: r.host || '127.0.0.1',
                        port: r.port || 8728,
                        username: r.username || 'admin',
                        password: r.password || '',
                        isolir_address_list: r.isolir_address_list || 'Expired',
                        description: r.description || '',
                        is_active: r.is_active !== undefined ? r.is_active : 1,
                        is_default: r.is_default !== undefined ? r.is_default : 0,
                        created_at: r.created_at || new Date().toISOString(),
                        updated_at: r.updated_at || new Date().toISOString()
                    });
                    countRouters++;
                }
            }
        });

        importTx();

        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('database_restore', ?, ?, datetime('now'))
            `).run(`Impor / Restore ${countSettings} parameter pengaturan sistem dan ${countRouters} data router`, req.user?.id || null);
        } catch (e) {}

        req.flash('success', `Berhasil memulihkan ${countSettings} parameter pengaturan dan ${countRouters} data router.`);
    } catch (err) {
        console.error('[Settings] Error restore settings:', err.message);
        req.flash('error', 'Gagal memulihkan pengaturan sistem: ' + err.message);
    } finally {
        try { if (fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); } catch (e) {}
    }

    res.redirect('/settings#tab-database-services');
});

// =========================================================================
// 4.7 BAGIAN RESET: PENGOSONGAN DATABASE
// =========================================================================
router.post('/database/reset', async (req, res) => {
    const { reset_type, confirm_text } = req.body;

    if (confirm_text !== 'RESET') {
        req.flash('error', 'Konfirmasi gagal. Anda harus mengetik kata "RESET" dengan huruf kapital.');
        return res.redirect('/settings#tab-database-services');
    }

    try {
        // 1. Otomatis buat safety backup sebelum data dihapus
        const timestamp = moment().format('YYYY-MM-DD_HHmmss');
        const safetyBackupName = `pre-reset-safety-backup_${timestamp}.db`;
        const safetyBackupPath = path.join(__dirname, '../database', safetyBackupName);
        await db.backup(safetyBackupPath);
        console.log(`[Settings] Safety pre-reset backup created at ${safetyBackupPath}`);

        db.pragma('foreign_keys = OFF');

        if (reset_type === 'logs') {
            // Bersihkan hanya activity_log
            db.exec('DELETE FROM activity_log');
            try { db.exec("DELETE FROM sqlite_sequence WHERE name = 'activity_log'"); } catch (e) {}

            db.pragma('foreign_keys = ON');
            db.exec('VACUUM');

            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('database_reset', ?, ?, datetime('now'))
            `).run(`Pembersihan seluruh riwayat log aktivitas sistem. (Safety backup: ${safetyBackupName})`, req.user?.id || null);

            req.flash('success', `Riwayat log aktivitas berhasil dibersihkan. Cadangan keselamatan tersimpan sebagai "${safetyBackupName}".`);

        } else if (reset_type === 'operational') {
            // Kosongkan: customers, invoices, payments, activity_log
            const resetOpTx = db.transaction(() => {
                db.exec('DELETE FROM payments');
                db.exec('DELETE FROM invoices');
                db.exec('DELETE FROM customers');
                db.exec('DELETE FROM activity_log');
                
                // Reset auto-increment sequence
                try {
                    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('payments', 'invoices', 'customers', 'activity_log')");
                } catch (e) {}
            });
            resetOpTx();

            db.pragma('foreign_keys = ON');
            db.exec('VACUUM');
            db.exec('PRAGMA optimize');

            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('database_reset', ?, ?, datetime('now'))
            `).run(`Pengosongan data operasional (Pelanggan, Tagihan, Pembayaran). (Safety backup: ${safetyBackupName})`, req.user?.id || null);

            req.flash('success', `Data operasional (Pelanggan, Tagihan, & Pembayaran) berhasil dikosongkan. Pengaturan & router tetap aman. Cadangan keselamatan tersimpan sebagai "${safetyBackupName}".`);

        } else if (reset_type === 'factory') {
            // Factory Reset Total
            const factoryTx = db.transaction(() => {
                // Hapus seluruh tabel
                db.exec('DELETE FROM payments');
                db.exec('DELETE FROM invoices');
                db.exec('DELETE FROM customers');
                db.exec('DELETE FROM packages');
                db.exec('DELETE FROM activity_log');
                db.exec('DELETE FROM routers');
                db.exec('DELETE FROM network_cables');
                db.exec('DELETE FROM network_nodes');
                db.exec('DELETE FROM users');
                db.exec('DELETE FROM settings');
                try { db.exec('DELETE FROM sqlite_sequence'); } catch (e) {}

                // Seed user admin default
                const defaultPass = bcrypt.hashSync('admin123', 10);
                db.prepare(`
                    INSERT INTO users (id, username, password, name, role, created_at)
                    VALUES (1, 'admin', ?, 'Administrator', 'admin', datetime('now'))
                `).run(defaultPass);

                // Seed paket default Gratis / Bypass
                db.prepare(`
                    INSERT INTO packages (id, name, speed_down, speed_up, price, description, is_bypass, is_active, created_at)
                    VALUES (1, 'Paket Gratis / Bypass', 50, 50, 0, 'Paket khusus gratis/bypass untuk staff, keluarga, atau kantor. Bebas tagihan bulanan dan kebal dari isolir otomatis.', 1, 1, datetime('now'))
                `).run();

                // Seed default settings
                const defaultSettings = [
                    ['mikrotik_host', ''],
                    ['mikrotik_port', '8728'],
                    ['mikrotik_username', 'admin'],
                    ['mikrotik_password', ''],
                    ['genieacs_url', 'http://localhost:7557'],
                    ['company_name', 'ISP Manager'],
                    ['company_phone', ''],
                    ['company_address', ''],
                    ['billing_message_template', 'Yth. {customer_name},\n\nTagihan internet Anda untuk periode {period} sebesar Rp {amount} akan jatuh tempo pada tanggal {due_date}.\n\nSilakan lakukan pembayaran sebelum tanggal jatuh tempo untuk menghindari pemutusan layanan.\n\nTerima kasih,\n{company_name}'],
                    ['due_date_warning_template', 'Yth. {customer_name},\n\n*PERINGATAN JATUH TEMPO BESOK (TANGGAL 8)*\n\nTagihan internet Anda untuk periode {period} sebesar Rp {amount} akan jatuh tempo besok pada tanggal 8.\n\nMohon segera melakukan pembayaran hari ini untuk menghindari pemutusan / isolir layanan internet otomatis pada tanggal 8.\n\nTerima kasih,\n{company_name}'],
                    ['payment_receipt_template', 'Yth. {customer_name},\n\nTerima kasih, pembayaran tagihan internet Anda telah berhasil kami terima:\n\n*No. Invoice:* {invoice_number}\n*Periode:* {period}\n*Jumlah:* Rp {amount}\n*Metode:* {payment_method}\n*Tanggal:* {payment_date}\n*Status:* LUNAS\n\nLayanan internet Anda tetap aktif. Terima kasih atas kerja sama dan kepercayaan Anda.\n\nSalam,\n{company_name}'],
                    ['auto_billing_enabled', 'false'],
                    ['reminder_day_1', 'true'],
                    ['reminder_day_5', 'true'],
                    ['reminder_day_7', 'true'],
                    ['auto_billing_days_before', '3'],
                    ['auto_block_enabled', 'true'],
                    ['isolir_address_list', 'ISOLIR'],
                    ['map_center_lat', '-6.200000'],
                    ['map_center_lng', '106.816666'],
                    ['map_zoom', '13'],
                    ['payment_bank_info', 'BCA: 1234567890 a.n ISP Manager\nMandiri: 9876543210 a.n ISP Manager'],
                    ['payment_ewallet_info', 'DANA / OVO / GoPay / ShopeePay:\n0812-3456-7890 a.n ISP Manager'],
                    ['payment_cash_info', 'Bayar tunai di Kantor ISP atau melalui Petugas Penagih resmi.'],
                    ['payment_qris_info', 'Scan QRIS via Mobile Banking atau Semua e-Wallet'],
                    ['payment_qris_image', '']
                ];

                const insertSetting = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime("now"))');
                for (const [k, v] of defaultSettings) {
                    insertSetting.run(k, v);
                }
            });
            factoryTx();

            db.pragma('foreign_keys = ON');
            db.exec('VACUUM');
            db.exec('PRAGMA optimize');

            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('database_reset', ?, 1, datetime('now'))
            `).run(`Factory Reset Database Total. Sistem kembali ke instalasi baru. (Safety backup: ${safetyBackupName})`);

            // Update user session agar admin tetap login
            req.session.user = {
                id: 1,
                username: 'admin',
                name: 'Administrator',
                role: 'admin'
            };

            req.flash('success', `Factory Reset berhasil. Seluruh database telah kembali ke setelan awal pabrik (Login: admin / admin123). Cadangan keselamatan tersimpan sebagai "${safetyBackupName}".`);
        } else {
            db.pragma('foreign_keys = ON');
            req.flash('error', 'Tipe reset database tidak dikenal.');
        }

    } catch (err) {
        db.pragma('foreign_keys = ON');
        console.error('[Settings] Error resetting database:', err.message);
        req.flash('error', 'Gagal mereset database: ' + err.message);
    }

    res.redirect('/settings#tab-database-services');
});

// =========================================================================
// 5. BAGIAN SERVICES: RESTART & MONITORING
// =========================================================================

// 5.1 Restart Semua Services (WhatsApp, Scheduler, MikroTik, GenieACS)
router.post('/services/restart-all', async (req, res) => {
    try {
        console.log('[Services] Memulai restart seluruh layanan sistem...');

        // 1. Restart Scheduler
        try {
            schedulerService.stopAll();
            schedulerService.initialize();
            console.log('[Services] Scheduler berhasil direstart.');
        } catch (e) {
            console.error('[Services] Scheduler restart error:', e.message);
        }

        // 2. Disconnect & Refresh MikroTik
        try {
            await mikrotikService.disconnectAll();
            console.log('[Services] MikroTik connection pool disegarkan.');
        } catch (e) {
            console.error('[Services] MikroTik disconnect error:', e.message);
        }

        // 3. Refresh GenieACS config
        try {
            const rowAcs = db.prepare("SELECT value FROM settings WHERE key = ?").get('genieacs_url');
            if (rowAcs?.value) genieacsService.configure(rowAcs.value);
            console.log('[Services] GenieACS client dikonfigurasi ulang.');
        } catch (e) {}

        // 4. Restart WhatsApp Gateway
        try {
            await whatsappService.restart();
            console.log('[Services] WhatsApp service restart dipicu.');
        } catch (e) {
            console.error('[Services] WhatsApp restart error:', e.message);
        }

        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('service_restart', 'Restart Seluruh Services Sistem (WA, Scheduler, MikroTik, GenieACS)', ?, datetime('now'))
            `).run(req.user?.id || null);
        } catch (e) {}

        req.flash('success', 'Seluruh Services sistem (WhatsApp Gateway, Cron Scheduler, MikroTik API, dan GenieACS) berhasil dimulai ulang.');
    } catch (err) {
        console.error('[Services] Error restart all services:', err.message);
        req.flash('error', 'Gagal merestart semua services: ' + err.message);
    }
    res.redirect('/settings#tab-database-services');
});

// 5.2 Restart WhatsApp Service Saja
router.post('/services/restart-whatsapp', async (req, res) => {
    try {
        await whatsappService.restart();

        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('service_restart', 'Restart WhatsApp Gateway Service', ?, datetime('now'))
            `).run(req.user?.id || null);
        } catch (e) {}

        req.flash('success', 'Service WhatsApp Gateway berhasil dimulai ulang. Sesi akan terhubung kembali otomatis.');
    } catch (err) {
        console.error('[Services] Error restart WhatsApp:', err.message);
        req.flash('error', 'Gagal merestart WhatsApp Service: ' + err.message);
    }
    res.redirect('/settings#tab-database-services');
});

// 5.3 Restart Scheduler Service Saja
router.post('/services/restart-scheduler', (req, res) => {
    try {
        schedulerService.stopAll();
        schedulerService.initialize();

        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('service_restart', 'Restart Auto-Billing Cron Scheduler', ?, datetime('now'))
            `).run(req.user?.id || null);
        } catch (e) {}

        req.flash('success', 'Service Auto-Billing & Auto-Isolir Scheduler berhasil dimulai ulang.');
    } catch (err) {
        console.error('[Services] Error restart scheduler:', err.message);
        req.flash('error', 'Gagal merestart Scheduler: ' + err.message);
    }
    res.redirect('/settings#tab-database-services');
});

// 5.4 Refresh Koneksi MikroTik API
router.post('/services/restart-mikrotik', async (req, res) => {
    try {
        await mikrotikService.disconnectAll();

        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('service_restart', 'Refresh MikroTik RouterOS API Connections', ?, datetime('now'))
            `).run(req.user?.id || null);
        } catch (e) {}

        req.flash('success', 'Koneksi API MikroTik berhasil diputus dan disegarkan.');
    } catch (err) {
        console.error('[Services] Error restart MikroTik:', err.message);
        req.flash('error', 'Gagal merestart MikroTik Service: ' + err.message);
    }
    res.redirect('/settings#tab-database-services');
});

// 5.5 Refresh GenieACS Service
router.post('/services/restart-genieacs', async (req, res) => {
    try {
        const rowAcs = db.prepare("SELECT value FROM settings WHERE key = ?").get('genieacs_url');
        if (rowAcs?.value) {
            genieacsService.configure(rowAcs.value);
        }
        const status = await genieacsService.getStatus();

        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('service_restart', 'Refresh GenieACS TR-069 Service', ?, datetime('now'))
            `).run(req.user?.id || null);
        } catch (e) {}

        if (status.online) {
            req.flash('success', `Service GenieACS berhasil disegarkan. Terhubung ke server (${status.devicesCount} ONT).`);
        } else {
            req.flash('warning', 'GenieACS dikonfigurasi ulang namun server belum merespon.');
        }
    } catch (err) {
        console.error('[Services] Error restart GenieACS:', err.message);
        req.flash('error', 'Gagal merestart GenieACS: ' + err.message);
    }
    res.redirect('/settings#tab-database-services');
});

// =========================================================================
// 6. MANAJEMEN AKUN LOGIN & NOMOR WHATSAPP TEKNISI DI PENGATURAN
// =========================================================================

// 6.1 Tambah Teknisi Baru
router.post('/technicians', (req, res) => {
    try {
        const { name, phone, username, password, role, notes } = req.body;
        if (!name || !phone || !username || !password) {
            req.flash('error', 'Nama Teknisi, Nomor WhatsApp, Username Login, dan Password wajib diisi.');
            return res.redirect('/settings?tab=technicians#tab-technicians');
        }

        const cleanUser = username.trim().toLowerCase().replace(/\s+/g, '');
        const existingUser = db.prepare('SELECT id FROM technicians WHERE LOWER(username) = LOWER(?)').get(cleanUser);
        if (existingUser) {
            req.flash('error', `Username teknisi "${cleanUser}" sudah digunakan. Silakan pilih username lain.`);
            return res.redirect('/settings?tab=technicians#tab-technicians');
        }

        const hashedPass = bcrypt.hashSync(password.trim(), 10);

        db.prepare(`
            INSERT INTO technicians (username, password, name, phone, role, is_active, notes, created_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now', 'localtime'))
        `).run(
            cleanUser,
            hashedPass,
            name.trim(),
            phone.trim(),
            (role || 'Teknisi Lapangan').trim(),
            (notes || '').trim()
        );

        db.prepare(`
            INSERT INTO activity_log (action, description, user_id, created_at)
            VALUES ('technician_added', ?, ?, datetime('now'))
        `).run(`Menambahkan akun teknisi baru: ${name.trim()} (WA: ${phone.trim()}, User: ${cleanUser})`, req.session?.user?.id || null);

        req.flash('success', `Akun teknisi "${name.trim()}" berhasil ditambahkan! Dapat login di /teknisi menggunakan username "${cleanUser}".`);
        res.redirect('/settings?tab=technicians#tab-technicians');
    } catch (error) {
        console.error('[Settings] Error adding technician:', error.message);
        req.flash('error', 'Gagal menambahkan teknisi: ' + error.message);
        res.redirect('/settings?tab=technicians#tab-technicians');
    }
});

// 6.2 Edit / Update Data, Nomor WA, Username & Password Teknisi
router.post('/technicians/:id/update', (req, res) => {
    try {
        const techId = req.params.id;
        const { name, phone, username, password, role, is_active, notes } = req.body;

        const tech = db.prepare('SELECT * FROM technicians WHERE id = ?').get(techId);
        if (!tech) {
            req.flash('error', 'Data teknisi tidak ditemukan.');
            return res.redirect('/settings?tab=technicians#tab-technicians');
        }

        if (!name || !phone || !username) {
            req.flash('error', 'Nama Teknisi, Nomor WhatsApp, dan Username Login tidak boleh kosong.');
            return res.redirect('/settings?tab=technicians#tab-technicians');
        }

        const cleanUser = username.trim().toLowerCase().replace(/\s+/g, '');
        const duplicateUser = db.prepare('SELECT id FROM technicians WHERE LOWER(username) = LOWER(?) AND id != ?').get(cleanUser, techId);
        if (duplicateUser) {
            req.flash('error', `Username "${cleanUser}" sudah dipakai oleh teknisi lain.`);
            return res.redirect('/settings?tab=technicians#tab-technicians');
        }

        const finalPass = (password && password.trim() !== '')
            ? bcrypt.hashSync(password.trim(), 10)
            : tech.password;

        const activeFlag = (is_active === '1' || is_active === 'true' || is_active === 'on') ? 1 : 0;

        db.prepare(`
            UPDATE technicians
            SET name = ?,
                phone = ?,
                username = ?,
                password = ?,
                role = ?,
                is_active = ?,
                notes = ?
            WHERE id = ?
        `).run(
            name.trim(),
            phone.trim(),
            cleanUser,
            finalPass,
            (role || 'Teknisi Lapangan').trim(),
            activeFlag,
            (notes || '').trim(),
            techId
        );

        db.prepare(`
            INSERT INTO activity_log (action, description, user_id, created_at)
            VALUES ('technician_updated', ?, ?, datetime('now'))
        `).run(`Memperbarui data teknisi: ${name.trim()} (WA: ${phone.trim()}, User: ${cleanUser})`, req.session?.user?.id || null);

        req.flash('success', `Data & akun login teknisi "${name.trim()}" berhasil diperbarui.`);
        res.redirect('/settings?tab=technicians#tab-technicians');
    } catch (error) {
        console.error('[Settings] Error updating technician:', error.message);
        req.flash('error', 'Gagal memperbarui teknisi: ' + error.message);
        res.redirect('/settings?tab=technicians#tab-technicians');
    }
});

// 6.3 Toggle Status Aktif / Nonaktif Teknisi
router.post('/technicians/:id/toggle', (req, res) => {
    try {
        const tech = db.prepare('SELECT * FROM technicians WHERE id = ?').get(req.params.id);
        if (!tech) {
            req.flash('error', 'Data teknisi tidak ditemukan.');
            return res.redirect('/settings?tab=technicians#tab-technicians');
        }

        const newStatus = tech.is_active ? 0 : 1;
        db.prepare('UPDATE technicians SET is_active = ? WHERE id = ?').run(newStatus, tech.id);

        req.flash('success', `Status teknisi "${tech.name}" diubah menjadi ${newStatus ? 'Aktif' : 'Nonaktif'}.`);
        res.redirect('/settings?tab=technicians#tab-technicians');
    } catch (error) {
        req.flash('error', 'Gagal mengubah status teknisi: ' + error.message);
        res.redirect('/settings?tab=technicians#tab-technicians');
    }
});

// 6.4 Hapus Teknisi
router.post('/technicians/:id/delete', (req, res) => {
    try {
        const tech = db.prepare('SELECT * FROM technicians WHERE id = ?').get(req.params.id);
        if (!tech) {
            req.flash('error', 'Data teknisi tidak ditemukan.');
            return res.redirect('/settings?tab=technicians#tab-technicians');
        }

        db.prepare('DELETE FROM technicians WHERE id = ?').run(tech.id);

        db.prepare(`
            INSERT INTO activity_log (action, description, user_id, created_at)
            VALUES ('technician_deleted', ?, ?, datetime('now'))
        `).run(`Menghapus akun teknisi: ${tech.name} (${tech.phone})`, req.session?.user?.id || null);

        req.flash('success', `Akun teknisi "${tech.name}" berhasil dihapus.`);
        res.redirect('/settings?tab=technicians#tab-technicians');
    } catch (error) {
        req.flash('error', 'Gagal menghapus teknisi: ' + error.message);
        res.redirect('/settings?tab=technicians#tab-technicians');
    }
});

// =========================================================================
// 7. MANAJEMEN AKUN, USERNAME & SANDI ADMINISTRATOR
// =========================================================================

// 7.1 Ubah Kredensial Admin (Nama, Username, Sandi)
router.post('/admin/update', (req, res) => {
    try {
        const { user_id, name, username, current_password, new_password, confirm_password, reset_to_default } = req.body;
        
        const targetId = parseInt(user_id, 10) || req.session?.user?.id;
        if (!targetId) {
            req.flash('error', 'ID akun administrator tidak valid.');
            return res.redirect('/settings?tab=admin-account#tab-admin-account');
        }

        const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
        if (!targetUser) {
            req.flash('error', 'Akun administrator tidak ditemukan.');
            return res.redirect('/settings?tab=admin-account#tab-admin-account');
        }

        const newName = (name || '').trim();
        if (!newName) {
            req.flash('error', 'Nama lengkap administrator tidak boleh kosong.');
            return res.redirect('/settings?tab=admin-account#tab-admin-account');
        }

        const newUsername = (username || '').trim();
        if (!newUsername) {
            req.flash('error', 'Username login administrator tidak boleh kosong.');
            return res.redirect('/settings?tab=admin-account#tab-admin-account');
        }

        // Cek keunikan username
        const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?').get(newUsername, targetId);
        if (existing) {
            req.flash('error', `Username "${newUsername}" sudah dipakai oleh akun lain. Silakan pilih username yang berbeda.`);
            return res.redirect('/settings?tab=admin-account#tab-admin-account');
        }

        // Cek password saat ini untuk verifikasi keamanan
        const currentPass = (current_password || '').trim();
        if (!currentPass) {
            req.flash('error', 'Kata sandi saat ini wajib diisi untuk verifikasi keamanan.');
            return res.redirect('/settings?tab=admin-account#tab-admin-account');
        }

        const isMatch = bcrypt.compareSync(currentPass, targetUser.password);
        if (!isMatch) {
            req.flash('error', 'Kata sandi saat ini salah! Perubahan kredensial dibatalkan.');
            return res.redirect('/settings?tab=admin-account#tab-admin-account');
        }

        let passwordHash = targetUser.password;
        let passwordMsg = '';

        if (reset_to_default === '1' || reset_to_default === 'true') {
            passwordHash = bcrypt.hashSync('admin123', 10);
            passwordMsg = ' Kata sandi direset ke default: admin123.';
        } else if (new_password && new_password.trim()) {
            const newPass = new_password.trim();
            const confirmPass = (confirm_password || '').trim();

            if (newPass.length < 4) {
                req.flash('error', 'Kata sandi baru minimal 4 karakter.');
                return res.redirect('/settings?tab=admin-account#tab-admin-account');
            }

            if (newPass !== confirmPass) {
                req.flash('error', 'Konfirmasi kata sandi baru tidak cocok.');
                return res.redirect('/settings?tab=admin-account#tab-admin-account');
            }

            passwordHash = bcrypt.hashSync(newPass, 10);
            passwordMsg = ' Kata sandi baru telah aktif.';
        }

        db.prepare(`
            UPDATE users
            SET name = ?, username = ?, password = ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(newName, newUsername, passwordHash, targetId);

        // Update session jika akun yang diubah adalah akun yang sedang login
        if (req.session?.user?.id === targetId) {
            req.session.user.name = newName;
            req.session.user.username = newUsername;
        }

        db.prepare(`
            INSERT INTO activity_log (action, description, user_id, created_at)
            VALUES ('admin_update', ?, ?, datetime('now'))
        `).run(`Kredensial admin diperbarui: ${newName} (Username: ${newUsername})${passwordMsg}`, req.session?.user?.id || targetId);

        req.flash('success', `Kredensial akun admin "${newName}" (Username: ${newUsername}) berhasil diperbarui!${passwordMsg}`);
        res.redirect('/settings?tab=admin-account#tab-admin-account');
    } catch (err) {
        console.error('[Settings] Error update admin:', err.message);
        req.flash('error', 'Gagal memperbarui kredensial admin: ' + err.message);
        res.redirect('/settings?tab=admin-account#tab-admin-account');
    }
});

// 7.2 Reset Kata Sandi Admin ke Default (admin123)
router.post('/admin/reset-password', (req, res) => {
    try {
        const { user_id } = req.body;
        const targetId = parseInt(user_id, 10) || req.session?.user?.id;

        const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
        if (!targetUser) {
            req.flash('error', 'Akun administrator tidak ditemukan.');
            return res.redirect('/settings?tab=admin-account#tab-admin-account');
        }

        const defaultHash = bcrypt.hashSync('admin123', 10);
        db.prepare(`
            UPDATE users
            SET password = ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(defaultHash, targetId);

        db.prepare(`
            INSERT INTO activity_log (action, description, user_id, created_at)
            VALUES ('admin_reset_password', ?, ?, datetime('now'))
        `).run(`Kata sandi akun admin ${targetUser.name} (${targetUser.username}) direset ke default: admin123`, req.session?.user?.id || targetId);

        req.flash('success', `Kata sandi akun admin "${targetUser.username}" berhasil direset ke default: admin123`);
        res.redirect('/settings?tab=admin-account#tab-admin-account');
    } catch (err) {
        console.error('[Settings] Error reset admin password:', err.message);
        req.flash('error', 'Gagal mereset kata sandi: ' + err.message);
        res.redirect('/settings?tab=admin-account#tab-admin-account');
    }
});

// 7.3 Tambah Akun Administrator Baru
router.post('/admin/create', (req, res) => {
    try {
        const { name, username, password, confirm_password } = req.body;
        const cleanName = (name || '').trim();
        const cleanUsername = (username || '').trim();
        const cleanPass = (password || '').trim();
        const cleanConfirm = (confirm_password || '').trim();

        if (!cleanName || !cleanUsername || !cleanPass) {
            req.flash('error', 'Nama lengkap, username, dan password wajib diisi.');
            return res.redirect('/settings?tab=admin-account#tab-admin-account');
        }

        if (cleanPass.length < 4) {
            req.flash('error', 'Kata sandi minimal 4 karakter.');
            return res.redirect('/settings?tab=admin-account#tab-admin-account');
        }

        if (cleanPass !== cleanConfirm) {
            req.flash('error', 'Konfirmasi kata sandi tidak cocok.');
            return res.redirect('/settings?tab=admin-account#tab-admin-account');
        }

        const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(cleanUsername);
        if (existing) {
            req.flash('error', `Username "${cleanUsername}" sudah digunakan oleh akun lain.`);
            return res.redirect('/settings?tab=admin-account#tab-admin-account');
        }

        const hashed = bcrypt.hashSync(cleanPass, 10);
        db.prepare(`
            INSERT INTO users (name, username, password, role, created_at, updated_at)
            VALUES (?, ?, ?, 'admin', datetime('now'), datetime('now'))
        `).run(cleanName, cleanUsername, hashed);

        db.prepare(`
            INSERT INTO activity_log (action, description, user_id, created_at)
            VALUES ('admin_create', ?, ?, datetime('now'))
        `).run(`Akun administrator baru dibuat: ${cleanName} (${cleanUsername})`, req.session?.user?.id || null);

        req.flash('success', `Akun administrator baru "${cleanName}" (${cleanUsername}) berhasil dibuat.`);
        res.redirect('/settings?tab=admin-account#tab-admin-account');
    } catch (err) {
        console.error('[Settings] Error create admin:', err.message);
        req.flash('error', 'Gagal membuat akun admin: ' + err.message);
        res.redirect('/settings?tab=admin-account#tab-admin-account');
    }
});

// 7.4 Hapus Akun Administrator
router.post('/admin/:id/delete', (req, res) => {
    try {
        const targetId = parseInt(req.params.id, 10);
        const adminCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('admin')?.count || 0;

        if (adminCount <= 1) {
            req.flash('error', 'Tidak dapat menghapus! Sistem harus memiliki minimal satu akun administrator aktif.');
            return res.redirect('/settings?tab=admin-account#tab-admin-account');
        }

        if (req.session?.user?.id === targetId) {
            req.flash('error', 'Anda tidak dapat menghapus akun administrator yang sedang Anda gunakan saat ini.');
            return res.redirect('/settings?tab=admin-account#tab-admin-account');
        }

        const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
        if (!targetUser) {
            req.flash('error', 'Akun administrator tidak ditemukan.');
            return res.redirect('/settings?tab=admin-account#tab-admin-account');
        }

        db.prepare('DELETE FROM users WHERE id = ?').run(targetId);

        db.prepare(`
            INSERT INTO activity_log (action, description, user_id, created_at)
            VALUES ('admin_delete', ?, ?, datetime('now'))
        `).run(`Akun administrator dihapus: ${targetUser.name} (${targetUser.username})`, req.session?.user?.id || null);

        req.flash('success', `Akun administrator "${targetUser.name}" (${targetUser.username}) berhasil dihapus.`);
        res.redirect('/settings?tab=admin-account#tab-admin-account');
    } catch (err) {
        console.error('[Settings] Error delete admin:', err.message);
        req.flash('error', 'Gagal menghapus akun admin: ' + err.message);
        res.redirect('/settings?tab=admin-account#tab-admin-account');
    }
});

module.exports = router;
