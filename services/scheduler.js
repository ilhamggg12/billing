const cron = require('node-cron');
const moment = require('moment');
try { require('moment/locale/id'); moment.locale('id'); } catch (e) {}

class SchedulerService {
    constructor() {
        this.jobs = [];
        this.initialized = false;
    }

    initialize() {
        if (this.initialized) return;

        // 1. Cron harian pukul 00:01 WIB untuk pengiriman tagihan otomatis (Tanggal 1, 5, 7)
        const billingJob = cron.schedule('1 0 * * *', async () => {
            console.log('[Scheduler] Menjalankan pengecekan pengingat tagihan otomatis (00:01 WIB)...');
            await this.processScheduledReminders();
        }, { scheduled: true, timezone: 'Asia/Jakarta' });

        // 2. Run every hour to check for overdue customers and isolate their IP in MikroTik
        const isolirJob = cron.schedule('0 * * * *', async () => {
            console.log('[Scheduler] Memeriksa pelanggan jatuh tempo untuk isolir MikroTik...');
            await this.blockOverdueCustomers();
        }, { scheduled: true, timezone: 'Asia/Jakarta' });

        this.jobs.push(billingJob, isolirJob);
        this.initialized = true;
        console.log('[Scheduler] Initialized - WA Reminders (00:01 WIB: Tgl 1, 5, 7) & Auto Isolir MikroTik aktif');

        // Jalankan pengecekan isolir langsung saat startup
        setTimeout(() => this.blockOverdueCustomers(), 5000);
    }

    // Pengecekan jadwal pengingat tagihan harian
    async processScheduledReminders() {
        try {
            const db = require('../database/init');
            const whatsappService = require('./whatsapp');

            // Cek apakah fitur global notifikasi WhatsApp aktif
            const autoEnabled = db.prepare('SELECT value FROM settings WHERE key = ?').get('auto_billing_enabled');
            if (!autoEnabled || autoEnabled.value !== 'true') {
                console.log('[Scheduler] Notifikasi WhatsApp otomatis dinonaktifkan di Pengaturan.');
                return;
            }

            if (whatsappService.getStatus() !== 'connected') {
                console.log('[Scheduler] WhatsApp tidak terhubung, pengiriman pengingat otomatis dilewati.');
                return;
            }

            const today = moment();
            const dayOfMonth = today.date(); // 1 - 31
            const currentPeriod = today.format('YYYY-MM');

            console.log(`[Scheduler] Memproses pengingat hari ini: Tanggal ${dayOfMonth} (${currentPeriod})`);

            // Cek konfigurasi switch per tanggal
            const rowDay1 = db.prepare('SELECT value FROM settings WHERE key = ?').get('reminder_day_1');
            const rowDay5 = db.prepare('SELECT value FROM settings WHERE key = ?').get('reminder_day_5');
            const rowDay7 = db.prepare('SELECT value FROM settings WHERE key = ?').get('reminder_day_7');

            const enabledDay1 = !rowDay1 || rowDay1.value === 'true';
            const enabledDay5 = !rowDay5 || rowDay5.value === 'true';
            const enabledDay7 = !rowDay7 || rowDay7.value === 'true';

            // 1. Tanggal 1: Tagihan Awal Bulan
            if (dayOfMonth === 1 && enabledDay1) {
                console.log('[Scheduler Tgl 1] Menjalankan pengiriman tagihan baru awal bulan...');
                await this.ensureMonthlyInvoicesGenerated(currentPeriod);
                await this.sendBatchInvoices(currentPeriod, false, 'Tagihan Awal Bulan (Tgl 1)');
                return;
            }

            // 2. Tanggal 5: Pengingat Tagihan Kedua
            if (dayOfMonth === 5 && enabledDay5) {
                console.log('[Scheduler Tgl 5] Menjalankan pengingat tagihan kedua...');
                await this.sendBatchInvoices(currentPeriod, false, 'Pengingat Tagihan (Tgl 5)');
                return;
            }

            // 3. Tanggal 7: Peringatan Jatuh Tempo Besok (Tanggal 8)
            if (dayOfMonth === 7 && enabledDay7) {
                console.log('[Scheduler Tgl 7] Menjalankan peringatan jatuh tempo H-1 (besok tgl 8)...');
                await this.sendBatchInvoices(currentPeriod, true, 'Peringatan Jatuh Tempo Besok (Tgl 7)');
                return;
            }

            // 4. Hari lainnya
            console.log('[Scheduler] Hari ini bukan tanggal 1, 5, atau 7. Tidak ada pengiriman WhatsApp tagihan hari ini.');
        } catch (error) {
            console.error('[Scheduler] Error pada processScheduledReminders:', error.message);
        }
    }

    // Generate otomatis invoice awal bulan jika belum dibuat
    async ensureMonthlyInvoicesGenerated(period) {
        try {
            const db = require('../database/init');
            const targetCustomers = db.prepare(`
                SELECT c.*, p.price as package_price
                FROM customers c
                JOIN packages p ON c.package_id = p.id
                WHERE c.status IN ('active', 'suspended')
                AND (p.is_bypass = 0 OR p.is_bypass IS NULL)
                AND p.price > 0
            `).all();

            for (const customer of targetCustomers) {
                const existing = db.prepare('SELECT id FROM invoices WHERE customer_id = ? AND period = ?')
                    .get(customer.id, period);

                if (!existing) {
                    const countResult = db.prepare('SELECT COUNT(*) as count FROM invoices WHERE period = ?').get(period);
                    const seq = String(countResult.count + 1).padStart(4, '0');
                    const invoiceNumber = `INV-${period.replace('-', '')}-${seq}`;

                    const dueDay = Math.min(Math.max(customer.due_date || 8, 1), 28);
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

                    db.prepare(`
                        INSERT INTO invoices (invoice_number, customer_id, amount, period, due_date, status, notes, additional_bill, additional_bill_desc, created_at)
                        VALUES (?, ?, ?, ?, ?, 'unpaid', ?, ?, ?, datetime('now'))
                    `).run(
                        invoiceNumber,
                        customer.id,
                        invoiceAmount,
                        period,
                        dueDate,
                        invoiceNotes,
                        additional,
                        customer.additional_bill_desc ? customer.additional_bill_desc.trim() : null
                    );
                }
            }
        } catch (err) {
            console.error('[Scheduler] Error generate invoice awal bulan:', err.message);
        }
    }

    // Kirim pesan tagihan massal untuk periode berjalan (dengan jeda 5 detik)
    async sendBatchInvoices(period, isWarningDay7, logLabel) {
        const db = require('../database/init');
        const whatsappService = require('./whatsapp');

        // Ambil template yang sesuai
        let templateKey = isWarningDay7 ? 'due_date_warning_template' : 'billing_message_template';
        const templateRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(templateKey);
        
        let template = templateRow?.value;
        if (!template) {
            if (isWarningDay7) {
                template = 'Yth. {customer_name},\n\n*PERINGATAN JATUH TEMPO BESOK (TANGGAL 8)*\n\nTagihan internet Anda untuk periode {period} sebesar Rp {amount} akan jatuh tempo besok pada tanggal 8.\n\nMohon segera melakukan pembayaran hari ini untuk menghindari pemutusan / isolir layanan internet otomatis pada tanggal 8.\n\nTerima kasih,\n{company_name}';
            } else {
                template = 'Yth. {customer_name},\n\nTagihan internet Anda untuk periode {period} sebesar Rp {amount} akan jatuh tempo pada tanggal {due_date}.\n\nSilakan lakukan pembayaran sebelum tanggal jatuh tempo untuk menghindari pemutusan layanan.\n\nTerima kasih,\n{company_name}';
            }
        }

        const companyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('company_name');
        const companyName = companyRow?.value || 'ISP Manager';

        // Ambil semua invoice belum bayar pada periode ini (kecuali paket bypass/gratis dan paket paralel/tanpa WA tagihan)
        const invoices = db.prepare(`
            SELECT i.*, 
                   c.name as customer_name, c.customer_id as customer_code, c.phone as customer_phone, c.address as customer_address,
                   c.pppoe_username, c.ip_address,
                   p.name as package_name, p.speed_down, p.speed_up, p.no_wa_billing
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
            console.log(`[Scheduler] [${logLabel}] Tidak ada tagihan unpaid untuk periode ${period}`);
            return;
        }

        console.log(`[Scheduler] [${logLabel}] Memulai pengiriman pesan ke ${invoices.length} pelanggan (jeda 5 detik per nomor)...`);

        let count = 0;
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
                    invoice: {
                        invoice_number: invoice.invoice_number,
                        period: invoice.period,
                        amount: invoice.amount,
                        due_date: invoice.due_date,
                        status: invoice.status
                    },
                    package: {
                        name: invoice.package_name,
                        speed_down: invoice.speed_down,
                        speed_up: invoice.speed_up
                    },
                    company: {
                        company_name: companyName
                    }
                });

                // 1. Kirim pesan teks pengingat tagihan
                await whatsappService.sendMessage(invoice.customer_phone, message);

                // 2. Generate PDF Invoice Tagihan & kirim sebagai dokumen lampiran
                try {
                    const pdfService = require('./pdf');
                    const pdfBuffer = await pdfService.generateInvoicePdf(invoice.id);
                    const fileName = `Invoice-${invoice.invoice_number}.pdf`;
                    await whatsappService.sendDocument(
                        invoice.customer_phone,
                        pdfBuffer,
                        fileName,
                        `📄 *Lampiran Invoice Tagihan:* ${invoice.invoice_number} (${invoice.customer_name})`
                    );
                } catch (pdfErr) {
                    console.error(`[Scheduler] [${logLabel}] Gagal kirim PDF ke ${invoice.customer_name}:`, pdfErr.message);
                }

                db.prepare(`UPDATE invoices SET whatsapp_sent = 1, whatsapp_sent_at = datetime('now') WHERE id = ?`).run(invoice.id);

                db.prepare(`INSERT INTO activity_log (action, description, created_at) VALUES (?, ?, datetime('now'))`)
                    .run('whatsapp_sent', `${logLabel}: Tagihan & PDF ${invoice.invoice_number} terkirim ke ${invoice.customer_name}`);

                count++;
                console.log(`[Scheduler] [${logLabel}] (${count}/${invoices.length}) Terkirim ke ${invoice.customer_name}. Jeda 5 detik...`);

                // Jeda 5 detik per pesan untuk keamanan anti-spam WhatsApp
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (err) {
                console.error(`[Scheduler] [${logLabel}] Gagal kirim ke ${invoice.customer_name}:`, err.message);
            }
        }

        console.log(`[Scheduler] [${logLabel}] Selesai mengirim ${count} pesan tagihan.`);
    }

    async blockOverdueCustomers() {
        try {
            const db = require('../database/init');
            const mikrotikService = require('./mikrotik');

            // Cek apakah fitur auto isolir diaktifkan
            const blockSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('auto_block_enabled');
            if (blockSetting && blockSetting.value === 'false') {
                return;
            }

            const listNameRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('isolir_address_list');
            const listName = listNameRow?.value || 'Expired';

            const today = moment().format('YYYY-MM-DD');

            // 1. Ambil semua tagihan yang belum dibayar dan sudah melewati tanggal jatuh tempo
            // Hanya periksa format tanggal ISO yang valid (YYYY-MM-DD)
            const overdueInvoices = db.prepare(`
                SELECT i.*, c.name as customer_name, c.customer_id as cust_code, c.ip_address, c.pppoe_username, c.connection_type, c.status as customer_status, c.id as cust_id, c.router_id
                FROM invoices i
                JOIN customers c ON i.customer_id = c.id
                LEFT JOIN packages p ON c.package_id = p.id
                WHERE i.status = 'unpaid'
                AND (p.is_bypass = 0 OR p.is_bypass IS NULL)
                AND (p.price > 0 OR p.price IS NULL)
                AND i.due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                AND i.due_date < ?
                AND i.due_date >= '2020-01-01'
            `).all(today);

            // Set ID pelanggan yang benar-benar menunggak jatuh tempo
            const overdueCustIds = new Set(overdueInvoices.map(item => item.cust_id));

            // 2. Auto-Recovery: Pulihkan pelanggan yang berstatus 'suspended' HANYA jika sebelumnya
            // diisolir otomatis oleh sistem (is_auto_isolated = 1) dan sekarang tagihannya sudah lunas
            // (Pelanggan yang diisolir manual oleh admin tidak akan dipulihkan otomatis oleh scheduler)
            const suspendedCustomers = db.prepare(`
                SELECT c.id as cust_id, c.customer_id as cust_code, c.name as customer_name, c.ip_address, c.pppoe_username, c.connection_type, c.status as customer_status, c.router_id
                FROM customers c
                LEFT JOIN packages p ON c.package_id = p.id
                WHERE c.status = 'suspended'
                AND c.is_auto_isolated = 1
                AND (p.is_bypass = 0 OR p.is_bypass IS NULL)
            `).all();

            for (const item of suspendedCustomers) {
                if (!overdueCustIds.has(item.cust_id)) {
                    // Cek apakah ada invoice lunas untuk pelanggan ini atau tidak ada tagihan overdue sama sekali
                    const hasPaidInvoice = db.prepare("SELECT id FROM invoices WHERE customer_id = ? AND status = 'paid' LIMIT 1").get(item.cust_id);
                    if (hasPaidInvoice) {
                        console.log(`[Scheduler Auto-Restore] Pelanggan auto-isolir ${item.customer_name} (${item.cust_code}) tagihan sudah lunas. Memulihkan status ke Aktif...`);
                        db.prepare("UPDATE customers SET status = 'active', is_auto_isolated = 0, updated_at = datetime('now') WHERE id = ?").run(item.cust_id);

                        const custObj = {
                            id: item.cust_id,
                            customer_id: item.cust_code,
                            name: item.customer_name,
                            ip_address: item.ip_address,
                            pppoe_username: item.pppoe_username,
                            connection_type: item.connection_type,
                            router_id: item.router_id,
                            status: 'active'
                        };
                        try {
                            await mikrotikService.unIsolateCustomer(custObj);
                            console.log(`[Scheduler Auto-Restore] Berhasil membuka isolir MikroTik ${item.customer_name} (${item.ip_address || 'No IP'})`);
                        } catch (eRestore) {
                            console.warn(`[Scheduler Auto-Restore] Peringatan MikroTik:`, eRestore.message);
                        }

                        db.prepare("INSERT INTO activity_log (action, description, created_at) VALUES (?, ?, datetime('now'))")
                            .run('auto_restore', `Status pelanggan ${item.customer_name} dipulihkan ke Aktif dan isolir dibuka otomatis karena tagihan sudah lunas`);
                    }
                }
            }

            // 3. Kumpulkan target isolir hanya bagi pelanggan yang benar-benar menunggak jatuh tempo
            const targetsMap = new Map();
            for (const item of overdueInvoices) {
                if (!targetsMap.has(item.cust_id)) {
                    targetsMap.set(item.cust_id, {
                        ...item,
                        reason: `Jatuh Tempo: ${item.invoice_number} (${item.customer_name})`,
                        invoice_id: item.id
                    });
                }
            }

            const targets = Array.from(targetsMap.values());
            if (targets.length === 0) {
                return;
            }

            console.log(`[Scheduler] Ditemukan ${targets.length} pelanggan yang perlu diisolir (jatuh tempo)`);

            for (const item of targets) {
                try {
                    const custObj = {
                        id: item.cust_id,
                        customer_id: item.cust_code,
                        name: item.customer_name,
                        ip_address: item.ip_address,
                        pppoe_username: item.pppoe_username,
                        connection_type: item.connection_type,
                        router_id: item.router_id,
                        status: item.customer_status
                    };

                    const isoRes = await mikrotikService.isolateCustomer(custObj, item.reason || `Isolir: ${item.customer_name}`);
                    if (isoRes && isoRes.success) {
                        console.log(`[Scheduler Router #${item.router_id || 'default'}] Berhasil isolir ${item.customer_name} (${isoRes.ip})`);
                    } else {
                        console.warn(`[Scheduler] Gagal isolir ${item.customer_name}:`, isoRes ? isoRes.message : 'Unknown');
                    }

                    db.prepare("UPDATE customers SET status = 'suspended', is_auto_isolated = 1, updated_at = datetime('now') WHERE id = ?").run(item.cust_id);

                    if (item.customer_status !== 'suspended') {
                        db.prepare('INSERT INTO activity_log (action, description, created_at) VALUES (?, ?, datetime(\'now\'))')
                            .run('auto_isolir', `Internet pelanggan ${item.customer_name} diisolir otomatis (${(isoRes && isoRes.ip) || item.ip_address || 'No IP'}) karena ${item.reason}`);
                    }
                } catch (errMk) {
                    console.error(`[Scheduler] Gagal isolir ${item.customer_name}:`, errMk.message);
                }
            }
        } catch (error) {
            console.error('[Scheduler] Error blockOverdueCustomers:', error.message);
        }
    }

    isRunning() {
        return this.initialized && Array.isArray(this.jobs) && this.jobs.length > 0;
    }

    getStatus() {
        return {
            active: this.isRunning(),
            jobsCount: this.jobs ? this.jobs.length : 0
        };
    }

    stopAll() {
        this.jobs.forEach(job => job.stop());
        this.jobs = [];
        this.initialized = false;
    }
}

module.exports = new SchedulerService();
