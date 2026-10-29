const express = require('express');
const router = express.Router();
const db = require('../database/init');
const { isAuthenticated } = require('../middleware/auth');
const moment = require('moment');
const whatsappService = require('../services/whatsapp');
const otpService = require('../services/otp');

router.use(isAuthenticated);

/**
 * Format currency to Indonesian Rupiah format
 */
function formatRupiah(amount) {
    return 'Rp ' + new Intl.NumberFormat('id-ID').format(amount);
}

/**
 * Ambil nomor WhatsApp admin untuk verifikasi OTP
 */
function getAdminOtpPhone() {
    try {
        const adminOtp = db.prepare("SELECT value FROM settings WHERE key = 'admin_otp_phone'").get()?.value;
        if (adminOtp && adminOtp.trim()) return adminOtp.trim();
        const psbAdmin = db.prepare("SELECT value FROM settings WHERE key = 'psb_admin_phone'").get()?.value;
        if (psbAdmin && psbAdmin.trim()) return psbAdmin.trim();
        const compPhone = db.prepare("SELECT value FROM settings WHERE key = 'company_phone'").get()?.value;
        if (compPhone && compPhone.trim()) return compPhone.trim();
    } catch (e) {}
    return '082240087489';
}

/**
 * Mask nomor telepon untuk tampilan UI yang aman (contoh: 0822-4008-****)
 */
function maskPhone(phone) {
    const clean = String(phone || '').replace(/[^0-9]/g, '');
    if (clean.length < 7) return clean;
    const prefix = clean.substring(0, 4);
    const mid = clean.substring(4, Math.min(8, clean.length - 2));
    const stars = '*'.repeat(Math.max(2, clean.length - prefix.length - mid.length));
    return `${prefix}-${mid}-${stars}`;
}

// GET / - List all invoices with customer info
router.get('/', (req, res) => {
    try {
        const { status, package_id, router_id, address, ip } = req.query;

        // Default ke periode bulan berjalan saat pertama kali dibuka
        let period = req.query.period;
        if (typeof period === 'undefined') {
            period = moment().format('YYYY-MM');
        }

        // Pastikan invoice bulan berjalan sudah tergenerate otomatis untuk pelanggan aktif
        const schedulerService = require('../services/scheduler');
        if (period && period !== 'all') {
            try {
                schedulerService.ensureMonthlyInvoicesGenerated(period);
            } catch (eGen) {}
        }

        const todayStr = moment().format('YYYY-MM-DD');

        let query = `
            SELECT i.*, 
                   c.name as customer_name, c.customer_id as customer_code, c.phone as customer_phone,
                   c.address as customer_address, c.status as customer_status, c.ip_address, c.pppoe_username,
                   c.router_id, r.name as router_name,
                   c.package_id, p.name as package_name, p.is_bypass, p.no_wa_billing,
                   (CASE 
                       WHEN i.status != 'paid' AND (i.status = 'overdue' OR (i.due_date IS NOT NULL AND i.due_date != '' AND i.due_date < ?) OR c.status = 'suspended') THEN 1
                       WHEN i.status != 'paid' THEN 2
                       ELSE 3
                   END) as sort_priority
            FROM invoices i
            JOIN customers c ON i.customer_id = c.id
            LEFT JOIN packages p ON c.package_id = p.id
            LEFT JOIN routers r ON c.router_id = r.id
        `;
        const conditions = [];
        const params = [todayStr];

        if (status === 'overdue') {
            conditions.push("(i.status = 'overdue' OR (i.status = 'unpaid' AND i.due_date < ?))");
            params.push(todayStr);
        } else if (status) {
            conditions.push('i.status = ?');
            params.push(status);
        }

        if (period && period !== 'all') {
            conditions.push('i.period = ?');
            params.push(period);
        }
        if (package_id) {
            conditions.push('c.package_id = ?');
            params.push(package_id);
        }
        if (router_id) {
            conditions.push('c.router_id = ?');
            params.push(router_id);
        }
        if (address && address.trim()) {
            conditions.push('c.address LIKE ?');
            params.push(`%${address.trim()}%`);
        }
        if (ip && ip.trim()) {
            conditions.push('(c.ip_address LIKE ? OR c.pppoe_username LIKE ?)');
            params.push(`%${ip.trim()}%`, `%${ip.trim()}%`);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        // Urutan: 1) Tagihan tersuspend / isolir, 2) Belum bayar lainnya, 3) Lunas
        query += " ORDER BY sort_priority ASC, CASE WHEN i.status != 'paid' THEN i.due_date END ASC, i.id DESC";

        const invoices = db.prepare(query).all(...params);

        // Get available periods, packages, and routers for filter
        const periods = db.prepare('SELECT DISTINCT period FROM invoices ORDER BY period DESC').all();
        const packages = db.prepare('SELECT id, name FROM packages WHERE is_active = 1 ORDER BY name ASC').all();
        const routers = db.prepare('SELECT id, name FROM routers WHERE is_active = 1 ORDER BY is_default DESC, name ASC').all();

        res.render('billing', {
            title: 'Tagihan',
            activePage: 'billing',
            invoices,
            periods,
            packages,
            routers,
            currentPeriod: period === 'all' ? '' : period,
            currentStatus: status || '',
            filters: { status: status || '', period: period === 'all' ? '' : period, package_id: package_id || '', router_id: router_id || '', address: address || '', ip: ip || '' },
            todayDate: todayStr,
            moment,
            formatRupiah
        });
    } catch (error) {
        console.error('Error loading invoices:', error.message);
        req.flash('error', 'Gagal memuat data tagihan');
        res.render('billing', {
            title: 'Tagihan',
            activePage: 'billing',
            invoices: [],
            periods: [],
            packages: [],
            routers: [],
            currentPeriod: '',
            currentStatus: '',
            filters: {},
            todayDate: moment().format('YYYY-MM-DD'),
            moment,
            formatRupiah
        });
    }
});

// POST /generate - Generate monthly invoices for all active customers
router.post('/generate', (req, res) => {
    try {
        const { period } = req.body; // format: YYYY-MM
        if (!period || !/^\d{4}-\d{2}$/.test(period)) {
            req.flash('error', 'Format periode tidak valid. Gunakan format YYYY-MM');
            return res.redirect('/billing');
        }

        const activeCustomers = db.prepare(`
            SELECT c.*, p.price as package_price
            FROM customers c
            JOIN packages p ON c.package_id = p.id
            WHERE c.status IN ('active', 'suspended')
            AND c.package_id IS NOT NULL
            AND (p.is_bypass = 0 OR p.is_bypass IS NULL)
            AND p.price > 0
        `).all();

        let generatedCount = 0;
        let skippedCount = 0;

        // Get the last invoice number for this period to continue sequence
        const lastInvoice = db.prepare(
            "SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY invoice_number DESC LIMIT 1"
        ).get(`INV-${period.replace('-', '')}-%`);

        let nextSeq = 1;
        if (lastInvoice) {
            const parts = lastInvoice.invoice_number.split('-');
            const lastSeq = parseInt(parts[parts.length - 1], 10);
            if (!isNaN(lastSeq)) nextSeq = lastSeq + 1;
        }

        const insertStmt = db.prepare(`
            INSERT INTO invoices (invoice_number, customer_id, amount, period, due_date, status, whatsapp_sent, notes, additional_bill, additional_bill_desc, created_at)
            VALUES (?, ?, ?, ?, ?, 'unpaid', 0, ?, ?, ?, datetime('now'))
        `);

        const checkStmt = db.prepare(
            'SELECT id FROM invoices WHERE customer_id = ? AND period = ?'
        );

        const generateAll = db.transaction(() => {
            for (const customer of activeCustomers) {
                // Skip if invoice already exists for this customer+period
                const existing = checkStmt.get(customer.id, period);
                if (existing) {
                    skippedCount++;
                    continue;
                }

                const invoiceNumber = `INV-${period.replace('-', '')}-${String(nextSeq).padStart(4, '0')}`;

                // Calculate due_date based on customer's due_date field (day of month, default tanggal 8)
                let dueDay = parseInt(customer.due_date, 10);
                if (isNaN(dueDay) || dueDay < 1 || dueDay > 28) dueDay = 8; // default tanggal 8 setiap bulan
                const dueDate = `${period}-${String(dueDay).padStart(2, '0')}`;

                const basePrice = parseFloat(customer.package_price) || 0;
                const additional = parseFloat(customer.additional_bill) || 0;
                let invoiceAmount = basePrice + additional;
                if (invoiceAmount < 0) invoiceAmount = 0;

                let invoiceNotes = null;
                if (additional !== 0) {
                    const descStr = customer.additional_bill_desc ? ` (${customer.additional_bill_desc.trim()})` : '';
                    if (additional > 0) {
                        invoiceNotes = `Tagihan Tambahan: +Rp ${Number(additional).toLocaleString('id-ID')}${descStr}`;
                    } else {
                        invoiceNotes = `Potongan Tagihan: -Rp ${Number(Math.abs(additional)).toLocaleString('id-ID')}${descStr}`;
                    }
                }

                insertStmt.run(
                    invoiceNumber,
                    customer.id,
                    invoiceAmount,
                    period,
                    dueDate,
                    invoiceNotes,
                    additional,
                    customer.additional_bill_desc ? customer.additional_bill_desc.trim() : null
                );

                nextSeq++;
                generatedCount++;
            }
        });

        generateAll();

        // Log activity
        db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
            .run('invoice_generate', `${generatedCount} tagihan berhasil dibuat untuk periode ${period} (${skippedCount} dilewati)`, req.user?.id || null);

        req.flash('success', `${generatedCount} tagihan berhasil dibuat untuk periode ${period}${skippedCount > 0 ? ` (${skippedCount} sudah ada, dilewati)` : ''}`);
        res.redirect('/billing');
    } catch (error) {
        console.error('Error generating invoices:', error.message);
        req.flash('error', 'Gagal membuat tagihan: ' + error.message);
        res.redirect('/billing');
    }
});

// =========================================================================
// FITUR LUNASI SEMUA TAGIHAN DENGAN OTP WHATSAPP KE ADMIN
// =========================================================================

// GET /billing/pay-all/info - Ambil ringkasan tagihan belum lunas & masked admin phone
router.get('/pay-all/info', (req, res) => {
    try {
        const { period } = req.query;
        let sql = `
            SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total_amount 
            FROM invoices 
            WHERE status = 'unpaid'
        `;
        const params = [];
        if (period && period !== 'all') {
            sql += ' AND period = ?';
            params.push(period);
        }
        const summary = db.prepare(sql).get(...params);

        const adminPhone = getAdminOtpPhone();
        const maskedPhone = maskPhone(adminPhone);

        res.json({
            success: true,
            count: summary.count || 0,
            total_amount: summary.total_amount || 0,
            formatted_amount: formatRupiah(summary.total_amount || 0),
            admin_phone_masked: maskedPhone,
            period: period || 'all'
        });
    } catch (err) {
        console.error('[Billing] Error get pay-all info:', err.message);
        res.status(500).json({ success: false, message: 'Gagal memuat ringkasan tagihan: ' + err.message });
    }
});

// POST /billing/pay-all/request-otp - Kirim kode OTP WhatsApp ke Admin
router.post('/pay-all/request-otp', async (req, res) => {
    try {
        // Pastikan WhatsApp service terhubung
        const isReady = await whatsappService.waitForReady(3000);
        if (!isReady && whatsappService.getStatus() !== 'connected') {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp Gateway belum terhubung. Pastikan WhatsApp sudah aktif di menu Pengaturan.'
            });
        }

        const adminPhone = getAdminOtpPhone();
        if (!adminPhone) {
            return res.status(400).json({
                success: false,
                message: 'Nomor WhatsApp Admin belum dikonfigurasi di Pengaturan.'
            });
        }

        const clientIp = req.ip || req.connection?.remoteAddress || '127.0.0.1';
        const otpRes = otpService.createOtp(adminPhone, clientIp);
        if (!otpRes.ok) {
            return res.status(429).json({
                success: false,
                message: otpRes.error,
                retryAfterSec: otpRes.retryAfterSec || 60
            });
        }

        const companyName = db.prepare("SELECT value FROM settings WHERE key = 'company_name'").get()?.value || 'ISP Manager';
        const nowStr = moment().locale('id').format('DD MMMM YYYY HH:mm [WIB]');

        const message = `🔐 *KODE VERIFIKASI OTP ADMIN*

Halo Admin,
Berikut adalah kode OTP untuk persetujuan aksi *Lunasi Semua Tagihan* di sistem ISP:

Kode OTP: *${otpRes.code}*

⚠️ *PENTING:*
- Kode verifikasi ini berlaku selama 5 menit.
- Bersifat rahasia, jangan berikan kepada siapa pun demi keamanan transaksi finansial.

Waktu: ${nowStr}
_${companyName}_`;

        try {
            await whatsappService.sendMessage(adminPhone, message);
            console.log(`[Billing OTP] Kode OTP berhasil dikirimkan via WhatsApp ke nomor Admin (${adminPhone})`);
            return res.json({
                success: true,
                message: `Kode OTP 6-digit berhasil dikirim ke nomor WhatsApp Admin (${maskPhone(adminPhone)}).`,
                expiresInSec: otpRes.expiresInSec,
                cooldownSec: otpRes.cooldownSec
            });
        } catch (sendErr) {
            console.error('[Billing OTP] Gagal mengirim WhatsApp OTP ke admin:', sendErr.message);
            otpService.discardOtp(adminPhone);
            return res.status(500).json({
                success: false,
                message: 'Gagal mengirim pesan WhatsApp ke Admin: ' + sendErr.message
            });
        }
    } catch (err) {
        console.error('[Billing OTP] Request error:', err.message);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan sistem saat meminta OTP: ' + err.message });
    }
});

// POST /billing/pay-all/confirm - Verifikasi OTP & Eksekusi Pelunasan Massal (TANPA WA ke pelanggan)
router.post('/pay-all/confirm', async (req, res) => {
    try {
        const { otp, period, payment_method, notes } = req.body;
        const adminPhone = getAdminOtpPhone();

        // 1. Validasi input OTP
        if (!otp || String(otp).trim().length !== 6) {
            return res.status(400).json({ success: false, message: 'Harap masukkan 6 digit kode OTP verifikasi dengan lengkap.' });
        }

        const verifyRes = otpService.verifyOtp(adminPhone, otp);
        if (!verifyRes.ok) {
            return res.status(400).json({ success: false, message: verifyRes.error || 'Kode OTP tidak valid atau sudah kedaluwarsa.' });
        }

        // 2. Query seluruh tagihan unpaid sesuai lingkup periode
        let sql = `
            SELECT i.*, 
                   c.name as customer_name, c.customer_id as cust_code, c.phone, c.router_id, c.ip_address, c.pppoe_username,
                   c.additional_bill as cust_additional_bill, c.additional_bill_desc as cust_additional_desc,
                   c.auto_reset_additional_bill as cust_auto_reset
            FROM invoices i
            JOIN customers c ON i.customer_id = c.id
            WHERE i.status = 'unpaid'
        `;
        const params = [];
        if (period && period !== 'all') {
            sql += ' AND i.period = ?';
            params.push(period);
        }
        sql += ' ORDER BY i.id ASC';

        const unpaidInvoices = db.prepare(sql).all(...params);

        if (!unpaidInvoices || unpaidInvoices.length === 0) {
            return res.status(400).json({ success: false, message: 'Tidak ditemukan tagihan belum lunas pada periode yang dipilih.' });
        }

        const globalResetSetting = db.prepare("SELECT value FROM settings WHERE key = 'auto_reset_additional_bill'").get()?.value;
        const isAutoResetGlobal = (globalResetSetting !== 'false');

        const paymentDate = moment().format('YYYY-MM-DD');
        const receivedBy = req.user?.username || req.user?.name || 'admin';
        const method = payment_method || 'BCA';
        const finalNotes = notes || 'Pelunasan massal oleh Admin (OTP Terverifikasi)';

        let totalAmount = 0;
        const affectedCustomerIds = new Set();

        const insertPaymentStmt = db.prepare(`
            INSERT INTO payments (invoice_id, amount, payment_method, payment_date, received_by, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `);
        const updateInvoiceStmt = db.prepare(`
            UPDATE invoices 
            SET status = 'paid', paid_date = ?
            WHERE id = ?
        `);
        const snapshotInvoiceAddBillStmt = db.prepare(`
            UPDATE invoices 
            SET additional_bill = ?, additional_bill_desc = ?
            WHERE id = ?
        `);
        const resetCustAddBillStmt = db.prepare(`
            UPDATE customers 
            SET additional_bill = 0, additional_bill_desc = NULL, updated_at = datetime('now')
            WHERE id = ?
        `);

        // Eksekusi seluruh tagihan dalam transaksi database
        const executeBulkSettlement = db.transaction(() => {
            for (const inv of unpaidInvoices) {
                totalAmount += (parseFloat(inv.amount) || 0);
                affectedCustomerIds.add(inv.customer_id);

                // Insert data payment
                insertPaymentStmt.run(inv.id, inv.amount, method, paymentDate, receivedBy, finalNotes);

                // Update invoice menjadi lunas
                updateInvoiceStmt.run(paymentDate, inv.id);

                // Snapshot additional_bill ke invoice jika invoice belum menyimpannya
                if ((inv.additional_bill === undefined || inv.additional_bill === null || inv.additional_bill === 0) &&
                    (inv.cust_additional_bill || inv.cust_additional_desc)) {
                    snapshotInvoiceAddBillStmt.run(
                        parseFloat(inv.cust_additional_bill) || 0,
                        inv.cust_additional_desc || null,
                        inv.id
                    );
                }

                // Reset tagihan tambahan pelanggan ke 0 jika fitur auto-reset aktif
                const isAutoReset = isAutoResetGlobal && (inv.cust_auto_reset !== 0);
                if (isAutoReset && ((parseFloat(inv.cust_additional_bill) || 0) !== 0 || inv.cust_additional_desc)) {
                    resetCustAddBillStmt.run(inv.customer_id);
                }
            }
        });

        executeBulkSettlement();

        // 3. Buka isolir di MikroTik & pulihkan status pelanggan menjadi 'active'
        const todayStr = moment().format('YYYY-MM-DD');
        let unIsolatedCount = 0;
        const mikrotikService = require('../services/mikrotik');

        for (const custId of affectedCustomerIds) {
            // Cek apakah pelanggan masih memiliki invoice unpaid yang jatuh tempo sebelum hari ini
            const remainingOverdue = db.prepare(`
                SELECT COUNT(*) as count 
                FROM invoices 
                WHERE customer_id = ? 
                AND status = 'unpaid' 
                AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                AND due_date < ?
            `).get(custId, todayStr);

            if (!remainingOverdue || remainingOverdue.count === 0) {
                const currentCust = db.prepare('SELECT status, is_auto_isolated FROM customers WHERE id = ?').get(custId);
                if (currentCust && currentCust.status === 'suspended') {
                    db.prepare("UPDATE customers SET status = 'active', is_auto_isolated = 0, updated_at = datetime('now') WHERE id = ?").run(custId);

                    const custRow = db.prepare(`
                        SELECT c.*, p.name as package_name, p.speed_down, p.speed_up
                        FROM customers c
                        LEFT JOIN packages p ON c.package_id = p.id
                        WHERE c.id = ?
                    `).get(custId);

                    if (custRow) {
                        try {
                            await mikrotikService.unIsolateCustomer(custRow);
                            unIsolatedCount++;
                        } catch (mkErr) {
                            console.warn(`[MikroTik] Gagal melepas isolir pelanggan ${custRow.name}:`, mkErr.message);
                        }
                    }
                }
            }
        }

        // 4. Log aksi ke activity_log
        const logDesc = `Pelunasan massal ${unpaidInvoices.length} tagihan senilai ${formatRupiah(totalAmount)} via ${method} (OTP WhatsApp Admin Terverifikasi)`;
        db.prepare(`
            INSERT INTO activity_log (action, description, user_id, created_at)
            VALUES ('bulk_payment', ?, ?, datetime('now'))
        `).run(logDesc, req.user?.id || null);

        console.log(`[Billing] ${logDesc}. Pelanggan dipulihkan aktif/un-isolir: ${unIsolatedCount}. TANPA notifikasi WA ke pelanggan.`);

        // PENTING: Sesuai instruksi, TANPA ADA NOTIFIKASI WA KE PELANGGAN!
        return res.json({
            success: true,
            paid_count: unpaidInvoices.length,
            total_amount: totalAmount,
            formatted_total: formatRupiah(totalAmount),
            unisolated_count: unIsolatedCount,
            message: `Berhasil melunasi ${unpaidInvoices.length} tagihan dengan total ${formatRupiah(totalAmount)} tanpa notifikasi WA ke pelanggan.`
        });

    } catch (err) {
        console.error('[Billing] Error executing pay-all:', err.message);
        res.status(500).json({ success: false, message: 'Gagal memproses pelunasan massal: ' + err.message });
    }
});

// POST /:id/pay - Record payment for an invoice
router.post('/:id/pay', async (req, res) => {
    try {
        const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
        if (!invoice) {
            req.flash('error', 'Tagihan tidak ditemukan');
            return res.redirect('/billing');
        }

        if (invoice.status === 'paid') {
            req.flash('error', 'Tagihan sudah dibayar');
            return res.redirect('/billing');
        }

        const { payment_method, notes } = req.body;
        const paymentDate = moment().format('YYYY-MM-DD');

        // Create payment record
        db.prepare(`
            INSERT INTO payments (invoice_id, amount, payment_method, payment_date, received_by, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
            invoice.id,
            invoice.amount,
            payment_method || 'cash',
            paymentDate,
            req.user?.username || req.user?.name || 'admin',
            notes || null
        );

        // Update invoice status
        db.prepare(`
            UPDATE invoices SET status = 'paid', paid_date = ? WHERE id = ?
        `).run(paymentDate, invoice.id);

        // Cek pengaturan enable/disable fitur kosongkan tagihan tambahan saat lunas
        const custSetting = db.prepare('SELECT id, name, additional_bill, additional_bill_desc, auto_reset_additional_bill FROM customers WHERE id = ?').get(invoice.customer_id);
        const globalResetSetting = db.prepare("SELECT value FROM settings WHERE key = 'auto_reset_additional_bill'").get()?.value;
        const isAutoResetEnabled = (globalResetSetting !== 'false') && (!custSetting || custSetting.auto_reset_additional_bill !== 0);

        // Pastikan nilai tagihan tambahan tersimpan di invoice sebelum dikosongkan dari pelanggan
        if ((invoice.additional_bill === undefined || invoice.additional_bill === null || invoice.additional_bill === 0) && custSetting) {
            const curAddBill = parseFloat(custSetting.additional_bill) || 0;
            const curAddDesc = custSetting.additional_bill_desc || null;
            if (curAddBill !== 0 || curAddDesc) {
                db.prepare(`
                    UPDATE invoices 
                    SET additional_bill = ?, additional_bill_desc = ?
                    WHERE id = ?
                `).run(curAddBill, curAddDesc, invoice.id);
            }
        }

        if (isAutoResetEnabled) {
            // Kosongkan kembali kolom tagihan tambahan pelanggan saat tagihan dilunasi berbarengan dengan tagihan internet
            db.prepare(`
                UPDATE customers 
                SET additional_bill = 0, additional_bill_desc = NULL, updated_at = datetime('now')
                WHERE id = ?
            `).run(invoice.customer_id);
            console.log(`[Billing] Tagihan tambahan pelanggan ${custSetting?.name || invoice.customer_id} otomatis dikosongkan kembali setelah lunas.`);
        } else {
            console.log(`[Billing] Tagihan tambahan pelanggan ${custSetting?.name || invoice.customer_id} tetap dipertahankan (fitur auto-reset dinonaktifkan).`);
        }

        // Get customer info for log and unblock MikroTik
        const customer = db.prepare(`
            SELECT c.*, p.name as package_name, p.speed_down, p.speed_up
            FROM customers c
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE c.id = ?
        `).get(invoice.customer_id);

        // Cek apakah pelanggan masih memiliki tagihan unpaid yang jatuh tempo
        const todayStr = moment().format('YYYY-MM-DD');
        const remainingOverdue = db.prepare(`
            SELECT COUNT(*) as count 
            FROM invoices 
            WHERE customer_id = ? 
            AND status = 'unpaid' 
            AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
            AND due_date < ?
        `).get(invoice.customer_id, todayStr);

        // Jika tidak ada tagihan jatuh tempo yang tersisa, pulihkan status pelanggan menjadi 'active'
        // dan buka isolir di MikroTik secara langsung
        if (!remainingOverdue || remainingOverdue.count === 0) {
            const currentCust = db.prepare('SELECT status, is_auto_isolated FROM customers WHERE id = ?').get(invoice.customer_id);
            if (currentCust && currentCust.status === 'suspended') {
                db.prepare("UPDATE customers SET status = 'active', is_auto_isolated = 0, updated_at = datetime('now') WHERE id = ?").run(invoice.customer_id);
                if (customer) {
                    customer.status = 'active';
                    customer.is_auto_isolated = 0;
                }

                if (customer) {
                    try {
                        const mikrotikService = require('../services/mikrotik');
                        await mikrotikService.unIsolateCustomer(customer);
                        console.log(`[MikroTik Router #${customer.router_id || 'default'}] Isolir pelanggan ${customer.name} (${customer.customer_id}) berhasil dibuka setelah pembayaran`);
                    } catch (errMk) {
                        console.warn('[MikroTik] Gagal melepas isolir:', errMk.message);
                    }
                }
            }
        }

        // Log activity
        db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
            .run('payment_received', `Pembayaran diterima: ${invoice.invoice_number} - ${customer?.name || 'Unknown'} (${formatRupiah(invoice.amount)})`, req.user?.id || null);

        // --- Kirim Notifikasi WhatsApp Bukti Pembayaran / Terima Kasih Beserta Lampiran Invoice PDF ---
        let waSentNotice = false;
        let pdfAttachedNotice = false;
        if (customer && customer.phone) {
            try {
                const whatsappService = require('../services/whatsapp');
                const isWaReady = await whatsappService.waitForReady(5000);
                if (isWaReady || whatsappService.getStatus() === 'connected') {
                    const receiptTplRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('payment_receipt_template');
                    const defaultReceiptTpl = 'Yth. {customer_name},\n\nTerima kasih, pembayaran tagihan internet Anda telah berhasil kami terima:\n\n*No. Invoice:* {invoice_number}\n*Periode:* {period}\n*Paket:* {paket_internet}\n*Jumlah:* Rp {amount}\n*Metode:* {payment_method}\n*Tanggal:* {payment_date}\n*Status:* LUNAS\n\nLayanan internet Anda tetap aktif. Terlampir invoice resmi pembayaran Anda dalam format PDF.\n\nTerima kasih atas kerja sama dan kepercayaan Anda.\n\nSalam,\n{company_name}';
                    const template = receiptTplRow?.value || defaultReceiptTpl;

                    const companyRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_name');
                    const companyPhoneRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_phone');
                    const companyAddressRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_address');

                    // Ambil invoice dengan status dan tanggal bayar terupdate
                    const updatedInvoice = db.prepare(`
                        SELECT i.*, 
                               c.name as customer_name, c.customer_id, c.phone as customer_phone, c.address as customer_address,
                               c.connection_type, c.ip_address, c.pppoe_username,
                               p.name as package_name, p.speed_down, p.speed_up
                        FROM invoices i
                        JOIN customers c ON i.customer_id = c.id
                        LEFT JOIN packages p ON c.package_id = p.id
                        WHERE i.id = ?
                    `).get(invoice.id);

                    const waMsg = whatsappService.formatTemplate(template, {
                        customer,
                        invoice: updatedInvoice || invoice,
                        package: {
                            name: customer.package_name,
                            speed_down: customer.speed_down,
                            speed_up: customer.speed_up
                        },
                        payment: {
                            payment_method,
                            payment_date: paymentDate
                        },
                        company: {
                            company_name: companyRow?.value || 'ISP Manager',
                            company_phone: companyPhoneRow?.value || '',
                            company_address: companyAddressRow?.value || ''
                        }
                    });

                    // 1. Kirim pesan ringkasan pembayaran WhatsApp
                    await whatsappService.sendMessage(customer.phone, waMsg);
                    waSentNotice = true;

                    // 2. Generate PDF Invoice & kirim sebagai attachment
                    try {
                        const pdfService = require('../services/pdf');
                        const pdfBuffer = await pdfService.generateInvoicePdf(updatedInvoice || invoice);
                        const fileName = `Invoice-${invoice.invoice_number}.pdf`;
                        await whatsappService.sendDocument(
                            customer.phone,
                            pdfBuffer,
                            fileName,
                            `📄 *Lampiran Invoice Resmi:* ${invoice.invoice_number}`
                        );
                        pdfAttachedNotice = true;
                        console.log(`[WhatsApp] Lampiran PDF ${fileName} berhasil dikirim ke ${customer.name}`);
                    } catch (pdfErr) {
                        console.error('[WhatsApp] Gagal membuat/mengirim lampiran PDF invoice:', pdfErr.message);
                    }

                    db.prepare('INSERT INTO activity_log (action, description, created_at) VALUES (?, ?, datetime(\'now\'))')
                        .run('whatsapp_sent', `Bukti bayar & PDF ${invoice.invoice_number} terkirim ke WhatsApp ${customer.name}`);
                    console.log(`[WhatsApp] Bukti bayar terkirim ke ${customer.name} (${customer.phone})`);
                } else {
                    console.log('[WhatsApp] WhatsApp tidak terhubung, bukti bayar dilewati.');
                }
            } catch (errWa) {
                console.warn('[WhatsApp] Gagal mengirim pesan bukti bayar:', errWa.message);
            }
        }

        if (waSentNotice && pdfAttachedNotice) {
            req.flash('success', `Pembayaran tagihan ${invoice.invoice_number} berhasil dicatat & lampiran Invoice PDF terkirim ke WhatsApp ${customer.name}.`);
        } else if (waSentNotice) {
            req.flash('success', `Pembayaran tagihan ${invoice.invoice_number} berhasil dicatat & bukti bayar terkirim ke WhatsApp ${customer.name}.`);
        } else {
            req.flash('success', `Pembayaran untuk tagihan ${invoice.invoice_number} berhasil dicatat.`);
        }
        const backUrl = req.headers.referer || '/billing';
        res.redirect(backUrl);
    } catch (error) {
        console.error('Error recording payment:', error.message);
        req.flash('error', 'Gagal mencatat pembayaran: ' + error.message);
        res.redirect('/billing');
    }
});

// POST /:id/reset-payment - Reset status pembayaran invoice kembali ke unpaid (Belum Lunas)
router.post('/:id/reset-payment', async (req, res) => {
    try {
        const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
        if (!invoice) {
            req.flash('error', 'Tagihan tidak ditemukan');
            return res.redirect('/billing');
        }

        // Hapus record pembayaran yang terkait dengan tagihan ini agar rekapan & status invoice sinkron
        db.prepare('DELETE FROM payments WHERE invoice_id = ?').run(invoice.id);

        // Update status invoice menjadi 'unpaid' dan kosongkan paid_date
        db.prepare("UPDATE invoices SET status = 'unpaid', paid_date = NULL WHERE id = ?").run(invoice.id);

        // --- KEMBALIKAN NOMINAL TAGIHAN TAMBAHAN PELANGGAN JIKA INVOICE INI MEMILIKI TAGIHAN TAMBAHAN ---
        let addAmountToRestore = 0;
        let addDescToRestore = null;

        if (invoice.additional_bill !== undefined && invoice.additional_bill !== null && Number(invoice.additional_bill) !== 0) {
            addAmountToRestore = parseFloat(invoice.additional_bill) || 0;
            addDescToRestore = invoice.additional_bill_desc || null;
        } else if (invoice.notes) {
            // Coba ambil dari catatan invoice jika kolom additional_bill belum terisi
            const matchPlus = invoice.notes.match(/Tagihan Tambahan:\s*\+Rp\s*([0-9.,]+)(?:\s*\((.*?)\))?/i);
            const matchMinus = invoice.notes.match(/Potongan Tagihan:\s*-Rp\s*([0-9.,]+)(?:\s*\((.*?)\))?/i);
            if (matchPlus) {
                const rawNum = matchPlus[1].replace(/\./g, '').replace(/,/g, '.');
                addAmountToRestore = parseFloat(rawNum) || 0;
                addDescToRestore = matchPlus[2] ? matchPlus[2].trim() : null;
            } else if (matchMinus) {
                const rawNum = matchMinus[1].replace(/\./g, '').replace(/,/g, '.');
                addAmountToRestore = -(parseFloat(rawNum) || 0);
                addDescToRestore = matchMinus[2] ? matchMinus[2].trim() : null;
            }
        }

        let restoredAdditionalMsg = '';
        if (addAmountToRestore !== 0 || addDescToRestore) {
            db.prepare(`
                UPDATE customers 
                SET additional_bill = ?, additional_bill_desc = ?, updated_at = datetime('now')
                WHERE id = ?
            `).run(addAmountToRestore, addDescToRestore, invoice.customer_id);

            const sign = addAmountToRestore > 0 ? '+Rp ' : '-Rp ';
            restoredAdditionalMsg = ` & tagihan tambahan (${sign}${Math.abs(addAmountToRestore).toLocaleString('id-ID')}) dikembalikan ke data pelanggan`;
            console.log(`[Billing Reset] Tagihan tambahan pelanggan ID ${invoice.customer_id} berhasil dikembalikan: ${addAmountToRestore} (${addDescToRestore})`);
        }

        // Ambil data pelanggan dan paket untuk cek jatuh tempo & isolir MikroTik
        const customer = db.prepare(`
            SELECT c.*, p.is_bypass
            FROM customers c
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE c.id = ?
        `).get(invoice.customer_id);

        let isolirStatusMsg = '';

        // Saat status tagihan direset ke Belum Lunas, pelanggan langsung disuspend
        // dan IP address-nya dimasukkan ke firewall address-list MikroTik (kecuali paket bypass/gratis)
        if (customer && customer.is_bypass !== 1) {
            try {
                // Update status pelanggan di database menjadi 'suspended' dan tandai is_auto_isolated = 1
                db.prepare("UPDATE customers SET status = 'suspended', is_auto_isolated = 1, updated_at = datetime('now') WHERE id = ?").run(customer.id);
                customer.status = 'suspended';
                customer.is_auto_isolated = 1;

                const mikrotikService = require('../services/mikrotik');
                const isoRes = await mikrotikService.isolateCustomer(
                    customer,
                    `Tagihan ${invoice.invoice_number} (Reset Belum Lunas)`
                );
                if (isoRes && isoRes.success) {
                    isolirStatusMsg = ` & IP ${isoRes.ip} berhasil ditambahkan ke firewall address-list "${isoRes.listName}" di MikroTik`;
                } else {
                    isolirStatusMsg = ` & Pelanggan disuspend (Peringatan MikroTik: ${isoRes ? (isoRes.message || isoRes.error) : 'IP belum terdeteksi'})`;
                }
            } catch (errMk) {
                console.error('[MikroTik Reset Isolir Error]:', errMk.message);
                isolirStatusMsg = ` (Peringatan MikroTik: ${errMk.message})`;
            }
        }

        // Catat ke activity_log
        db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
            .run('payment_reset', `Status tagihan ${invoice.invoice_number} direset menjadi Belum Lunas (Unpaid)${restoredAdditionalMsg}${isolirStatusMsg}`, req.user?.id || null);

        req.flash('success', `Status tagihan ${invoice.invoice_number} berhasil direset menjadi Belum Lunas${restoredAdditionalMsg}${isolirStatusMsg}`);

        const backUrl = req.headers.referer || '/billing';
        res.redirect(backUrl);
    } catch (error) {
        console.error('Error resetting payment status:', error.message);
        req.flash('error', 'Gagal mereset status pembayaran: ' + error.message);
        res.redirect('/billing');
    }
});

// GET /customer/:customerId - Redirect langsung ke halaman Detail Tagihan pelanggan terbaru
router.get('/customer/:customerId', (req, res) => {
    try {
        const custId = req.params.customerId;
        const latestInv = db.prepare(`
            SELECT id FROM invoices
            WHERE customer_id = ?
            ORDER BY CASE WHEN status = 'unpaid' THEN 0 ELSE 1 END ASC, period DESC, id DESC
            LIMIT 1
        `).get(custId);

        if (latestInv) {
            return res.redirect(`/billing/${latestInv.id}`);
        }
        req.flash('warning', 'Pelanggan ini belum memiliki data tagihan.');
        return res.redirect('/billing');
    } catch (error) {
        return res.redirect('/billing');
    }
});

// GET /:id - Detail Tagihan Invoice
router.get('/:id', (req, res) => {
    try {
        const invoice = db.prepare(`
            SELECT i.*, 
                   c.name as customer_name, c.customer_id, c.phone as customer_phone, c.address as customer_address,
                   c.connection_type, c.ip_address, c.pppoe_username,
                   p.name as package_name, p.speed_down, p.speed_up
            FROM invoices i
            JOIN customers c ON i.customer_id = c.id
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE i.id = ?
        `).get(req.params.id);

        if (!invoice) {
            req.flash('error', 'Tagihan tidak ditemukan');
            return res.redirect('/billing');
        }

        const payments = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY payment_date DESC').all(invoice.id);
        const companyName = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_name')?.value || 'ISP Manager';
        const companyPhone = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_phone')?.value || '';

        res.render('billing-detail', {
            title: `Detail Tagihan - ${invoice.invoice_number}`,
            activePage: 'billing',
            invoice,
            payments,
            companyName,
            companyPhone,
            moment
        });
    } catch (error) {
        console.error('Error loading invoice detail:', error.message);
        req.flash('error', 'Gagal memuat detail tagihan');
        res.redirect('/billing');
    }
});

// GET /:id/print - Cetak Invoice Standalone (PDF / Print-friendly view)
router.get('/:id/print', (req, res) => {
    try {
        const invoice = db.prepare(`
            SELECT i.*, 
                   c.name as customer_name, c.customer_id, c.phone as customer_phone, c.address as customer_address,
                   c.connection_type, c.ip_address, c.pppoe_username,
                   p.name as package_name, p.speed_down, p.speed_up
            FROM invoices i
            JOIN customers c ON i.customer_id = c.id
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE i.id = ?
        `).get(req.params.id);

        if (!invoice) {
            req.flash('error', 'Tagihan tidak ditemukan');
            return res.redirect('/billing');
        }

        const payments = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY payment_date DESC').all(invoice.id);
        const companyName = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_name')?.value || 'ISP Manager';
        const companyPhone = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_phone')?.value || '';
        const companyAddress = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_address')?.value || '';

        // Ambil pengaturan metode pembayaran
        const paymentSettingsRows = db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all('payment_%');
        const paymentSettings = {};
        paymentSettingsRows.forEach(r => paymentSettings[r.key] = r.value);

        res.render('invoice-print', {
            title: `Cetak Invoice - ${invoice.invoice_number}`,
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
        console.error('Error printing invoice:', error.message);
        req.flash('error', 'Gagal memuat invoice untuk dicetak');
        res.redirect(`/billing/${req.params.id}`);
    }
});

// POST /:id/send-whatsapp - Send WhatsApp reminder & PDF invoice for an invoice
router.post('/:id/send-whatsapp', async (req, res) => {
    const backUrl = req.headers.referer || '/billing';
    try {
        const invoice = db.prepare(`
            SELECT i.*, 
                   c.name as customer_name, c.customer_id as customer_code, c.phone as customer_phone, c.address as customer_address,
                   c.connection_type, c.pppoe_username, c.ip_address,
                   p.name as package_name, p.speed_down, p.speed_up, p.is_bypass, p.no_wa_billing
            FROM invoices i
            JOIN customers c ON i.customer_id = c.id
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE i.id = ?
        `).get(req.params.id);

        if (!invoice) {
            req.flash('error', 'Tagihan tidak ditemukan');
            return res.redirect(backUrl);
        }

        const isNoWaBilling = invoice.no_wa_billing === 1 || 
            /exiting|existing|pararel|paralel/i.test(invoice.package_name || '');
        if (isNoWaBilling) {
            req.flash('warning', `Pelanggan ${invoice.customer_name} menggunakan paket ${invoice.package_name || 'Paralel'} (Tanpa WA Tagihan). Informasi tagihan via WhatsApp dinonaktifkan untuk paket ini.`);
            return res.redirect(backUrl);
        }

        if (!invoice.customer_phone) {
            req.flash('error', 'Nomor telepon pelanggan tidak tersedia');
            return res.redirect(backUrl);
        }

        if (invoice.status === 'paid') {
            req.flash('warning', 'Tagihan sudah lunas, pengingat tagihan tidak dikirimkan');
            return res.redirect(backUrl);
        }

        const isWaReady = await whatsappService.waitForReady(5000);
        if (!isWaReady && whatsappService.getStatus() !== 'connected') {
            req.flash('error', 'WhatsApp belum terhubung. Silakan hubungkan WhatsApp di menu Pengaturan terlebih dahulu.');
            return res.redirect(backUrl);
        }

        // Get message template from settings
        const templateRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('billing_message_template');
        const template = templateRow?.value || 
            'Yth. {customer_name},\n\nTagihan internet Anda untuk periode {period} sebesar Rp {amount} akan jatuh tempo pada {due_date}.\n\nTerlampir dokumen invoice tagihan Anda dalam format PDF.\n\nTerima kasih,\n{company_name}';

        const companyRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_name');
        const companyPhoneRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_phone');
        const companyAddressRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_address');

        // Replace placeholders with centralized formatter
        const message = whatsappService.formatTemplate(template, {
            customer: {
                name: invoice.customer_name,
                customer_id: invoice.customer_code,
                phone: invoice.customer_phone,
                address: invoice.customer_address,
                pppoe_username: invoice.pppoe_username,
                ip_address: invoice.ip_address
            },
            invoice,
            package: {
                name: invoice.package_name,
                speed_down: invoice.speed_down,
                speed_up: invoice.speed_up
            },
            company: {
                company_name: companyRow?.value || 'ISP Manager',
                company_phone: companyPhoneRow?.value || '',
                company_address: companyAddressRow?.value || ''
            }
        });

        // 1. Kirim pesan teks tagihan ke WhatsApp pelanggan
        await whatsappService.sendMessage(invoice.customer_phone, message);

        // 2. Generate PDF Invoice Tagihan & kirim sebagai dokumen lampiran
        let pdfSent = false;
        let pdfErrorDetails = '';
        try {
            const pdfService = require('../services/pdf');
            const pdfBuffer = await pdfService.generateInvoicePdf(invoice.id);
            const fileName = `Invoice-${invoice.invoice_number}.pdf`;
            await whatsappService.sendDocument(
                invoice.customer_phone,
                pdfBuffer,
                fileName,
                `📄 *Lampiran Invoice Tagihan:* ${invoice.invoice_number} (${invoice.customer_name})`
            );
            pdfSent = true;
            console.log(`[WhatsApp] Lampiran PDF Tagihan ${fileName} berhasil dikirim ke ${invoice.customer_name}`);
        } catch (pdfErr) {
            pdfErrorDetails = pdfErr.message || String(pdfErr);
            console.error('[WhatsApp] Gagal membuat/mengirim lampiran PDF tagihan:', pdfErr);
            try {
                db.prepare('INSERT INTO activity_log (action, description, created_at) VALUES (?, ?, datetime(\'now\'))')
                    .run('pdf_error', `Error PDF Tagihan ${invoice.invoice_number}: ${pdfErrorDetails}`);
            } catch (eLog) {}
        }

        // Update whatsapp status on invoice
        db.prepare(`
            UPDATE invoices SET whatsapp_sent = 1, whatsapp_sent_at = datetime('now') WHERE id = ?
        `).run(req.params.id);

        // Log activity
        db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
            .run('whatsapp_sent', `Tagihan & PDF ${invoice.invoice_number} terkirim ke WhatsApp ${invoice.customer_name}`, req.user?.id || null);

        if (pdfSent) {
            req.flash('success', `Tagihan & lampiran Invoice PDF (${invoice.invoice_number}) berhasil dikirim ke WhatsApp ${invoice.customer_name}`);
        } else {
            req.flash('warning', `Pesan teks tagihan terkirim ke ${invoice.customer_name}, namun lampiran PDF terkendala: ${pdfErrorDetails}`);
        }
        res.redirect(backUrl);
    } catch (error) {
        console.error('Error sending WhatsApp:', error.message);
        req.flash('error', 'Gagal mengirim WhatsApp: ' + error.message);
        res.redirect(backUrl);
    }
});

// POST /:id/send-receipt - Kirim bukti bayar & lampiran invoice PDF ke WhatsApp pelanggan
router.post('/:id/send-receipt', async (req, res) => {
    const backUrl = req.headers.referer || `/billing/${req.params.id}`;
    try {
        const invoice = db.prepare(`
            SELECT i.*, 
                   c.name as customer_name, c.customer_id as customer_code, c.phone as customer_phone, c.address as customer_address,
                   c.connection_type, c.ip_address, c.pppoe_username,
                   p.name as package_name, p.speed_down, p.speed_up
            FROM invoices i
            JOIN customers c ON i.customer_id = c.id
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE i.id = ?
        `).get(req.params.id);

        if (!invoice) {
            req.flash('error', 'Tagihan tidak ditemukan');
            return res.redirect(backUrl);
        }

        if (!invoice.customer_phone) {
            req.flash('error', 'Nomor telepon pelanggan tidak tersedia');
            return res.redirect(backUrl);
        }

        if (invoice.status !== 'paid') {
            req.flash('warning', 'Tagihan ini belum lunas. Gunakan tombol Kirim Pengingat WhatsApp untuk tagihan belum lunas.');
            return res.redirect(backUrl);
        }

        const whatsappService = require('../services/whatsapp');
        const isWaReady = await whatsappService.waitForReady(5000);
        if (!isWaReady && whatsappService.getStatus() !== 'connected') {
            req.flash('error', 'WhatsApp belum terhubung. Silakan hubungkan WhatsApp di menu Pengaturan terlebih dahulu.');
            return res.redirect(backUrl);
        }

        const latestPayment = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY payment_date DESC, id DESC LIMIT 1').get(invoice.id);
        const receiptTplRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('payment_receipt_template');
        const defaultReceiptTpl = 'Yth. {customer_name},\n\nTerima kasih, pembayaran tagihan internet Anda telah berhasil kami terima:\n\n*No. Invoice:* {invoice_number}\n*Periode:* {period}\n*Paket:* {paket_internet}\n*Jumlah:* Rp {amount}\n*Metode:* {payment_method}\n*Tanggal:* {payment_date}\n*Status:* LUNAS\n\nLayanan internet Anda tetap aktif. Terlampir invoice resmi pembayaran Anda dalam format PDF.\n\nTerima kasih atas kerja sama dan kepercayaan Anda.\n\nSalam,\n{company_name}';
        const template = receiptTplRow?.value || defaultReceiptTpl;

        const companyRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_name');
        const companyPhoneRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_phone');
        const companyAddressRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_address');

        const waMsg = whatsappService.formatTemplate(template, {
            customer: invoice,
            invoice,
            package: {
                name: invoice.package_name,
                speed_down: invoice.speed_down,
                speed_up: invoice.speed_up
            },
            payment: {
                payment_method: latestPayment?.payment_method || 'cash',
                payment_date: invoice.paid_date || moment().format('YYYY-MM-DD')
            },
            company: {
                company_name: companyRow?.value || 'ISP Manager',
                company_phone: companyPhoneRow?.value || '',
                company_address: companyAddressRow?.value || ''
            }
        });

        // 1. Kirim pesan ringkasan bukti bayar
        await whatsappService.sendMessage(invoice.customer_phone, waMsg);

        // 2. Generate PDF Invoice dan kirim dokumen lampiran
        let pdfSent = false;
        let pdfErrorDetails = '';
        try {
            const pdfService = require('../services/pdf');
            const pdfBuffer = await pdfService.generateInvoicePdf(invoice);
            const fileName = `Invoice-${invoice.invoice_number}.pdf`;
            await whatsappService.sendDocument(
                invoice.customer_phone,
                pdfBuffer,
                fileName,
                `📄 *Lampiran Invoice Resmi:* ${invoice.invoice_number}`
            );
            pdfSent = true;
        } catch (pdfErr) {
            pdfErrorDetails = pdfErr.message || String(pdfErr);
            console.error('[WhatsApp] Gagal membuat/mengirim lampiran PDF invoice:', pdfErr);
            try {
                db.prepare('INSERT INTO activity_log (action, description, created_at) VALUES (?, ?, datetime(\'now\'))')
                    .run('pdf_error', `Error PDF ${invoice.invoice_number}: ${pdfErrorDetails}`);
            } catch (eLog) {}
        }

        db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
            .run('whatsapp_sent', `Bukti bayar ${invoice.invoice_number} dikirim ke ${invoice.customer_name}`, req.user?.id || null);

        if (pdfSent) {
            req.flash('success', `Bukti bayar & lampiran Invoice PDF berhasil dikirim ke WhatsApp ${invoice.customer_name} (${invoice.customer_phone})`);
        } else {
            req.flash('warning', `Pesan teks terkirim ke WhatsApp ${invoice.customer_name}, namun lampiran PDF terkendala: ${pdfErrorDetails}`);
        }

        res.redirect(backUrl);
    } catch (error) {
        console.error('Error sending receipt to WhatsApp:', error.message);
        req.flash('error', 'Gagal mengirim bukti bayar ke WhatsApp: ' + error.message);
        res.redirect(backUrl);
    }
});

// POST /send-bulk-whatsapp & /send-wa-bulk - Send WhatsApp to all unpaid invoices for selected period
router.post(['/send-bulk-whatsapp', '/send-wa-bulk'], async (req, res) => {
    try {
        let { period } = req.body;
        if (!period) {
            period = moment().format('YYYY-MM');
        }

        const invoices = db.prepare(`
            SELECT i.*, 
                   c.name as customer_name, c.customer_id as customer_code, c.phone as customer_phone, c.address as customer_address,
                   c.pppoe_username, c.ip_address,
                   p.name as package_name, p.speed_down, p.speed_up
            FROM invoices i
            JOIN customers c ON i.customer_id = c.id
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE i.status = 'unpaid'
            AND i.period = ?
            AND (p.is_bypass = 0 OR p.is_bypass IS NULL)
            AND (p.no_wa_billing = 0 OR p.no_wa_billing IS NULL)
            AND LOWER(COALESCE(p.name, '')) NOT LIKE '%exiting%'
            AND LOWER(COALESCE(p.name, '')) NOT LIKE '%existing%'
            AND LOWER(COALESCE(p.name, '')) NOT LIKE '%pararel%'
            AND LOWER(COALESCE(p.name, '')) NOT LIKE '%paralel%'
            AND (p.price > 0 OR p.price IS NULL)
            AND c.phone IS NOT NULL
            AND c.phone != ''
            AND c.status = 'active'
        `).all(period);

        if (invoices.length === 0) {
            req.flash('error', 'Tidak ada tagihan yang perlu dikirim untuk periode tersebut');
            return res.redirect('/billing');
        }

        // Get message template from settings
        const templateRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('billing_message_template');
        const template = templateRow?.value ||
            'Yth. {customer_name},\n\nTagihan internet Anda untuk periode {period} sebesar Rp {amount} jatuh tempo pada {due_date}.\n\nTerima kasih,\n{company_name}';

        const companyRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_name');
        const companyPhoneRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_phone');
        const companyAddressRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_address');
        const companyObj = {
            company_name: companyRow?.value || 'ISP Manager',
            company_phone: companyPhoneRow?.value || '',
            company_address: companyAddressRow?.value || ''
        };

        let sentCount = 0;
        let failCount = 0;

        for (const invoice of invoices) {
            try {
                const message = whatsappService.formatTemplate(template, {
                    customer: {
                        name: invoice.customer_name,
                        customer_id: invoice.customer_code,
                        phone: invoice.customer_phone,
                        address: invoice.customer_address,
                        pppoe_username: invoice.pppoe_username,
                        ip_address: invoice.ip_address
                    },
                    invoice,
                    package: {
                        name: invoice.package_name,
                        speed_down: invoice.speed_down,
                        speed_up: invoice.speed_up
                    },
                    company: companyObj
                });

                // 1. Kirim pesan teks tagihan
                await whatsappService.sendMessage(invoice.customer_phone, message);

                // 2. Generate PDF Invoice Tagihan & kirim sebagai dokumen lampiran
                try {
                    const pdfService = require('../services/pdf');
                    const pdfBuffer = await pdfService.generateInvoicePdf(invoice.id);
                    const fileName = `Invoice-${invoice.invoice_number}.pdf`;
                    await whatsappService.sendDocument(
                        invoice.customer_phone,
                        pdfBuffer,
                        fileName,
                        `📄 *Lampiran Invoice Tagihan:* ${invoice.invoice_number} (${invoice.customer_name})`
                    );
                } catch (pdfErr) {
                    console.error(`[WhatsApp Massal] Gagal kirim PDF ke ${invoice.customer_name}:`, pdfErr.message);
                }

                db.prepare(`
                    UPDATE invoices SET whatsapp_sent = 1, whatsapp_sent_at = datetime('now') WHERE id = ?
                `).run(invoice.id);

                sentCount++;
                console.log(`[WhatsApp Massal] Tagihan & PDF terkirim ke ${invoice.customer_name} (${invoice.customer_phone}). Jeda 5 detik sebelum nomor berikutnya...`);

                // Jeda 5 detik antar pesan untuk keamanan anti-spam WhatsApp
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (err) {
                console.error(`[WhatsApp Massal] Gagal kirim ke ${invoice.customer_name}:`, err.message);
                failCount++;
            }
        }

        // Log activity
        db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
            .run('whatsapp_bulk_sent', `WhatsApp massal: ${sentCount} terkirim, ${failCount} gagal untuk periode ${period}`, req.user?.id || null);

        if (failCount > 0) {
            req.flash('success', `${sentCount} pesan WhatsApp berhasil dikirim, ${failCount} gagal`);
        } else {
            req.flash('success', `${sentCount} pesan WhatsApp berhasil dikirim untuk periode ${period}`);
        }
        res.redirect('/billing');
    } catch (error) {
        console.error('Error sending bulk WhatsApp:', error.message);
        req.flash('error', 'Gagal mengirim WhatsApp massal: ' + error.message);
        res.redirect('/billing');
    }
});

module.exports = router;
