const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');

class WhatsAppService {
    constructor() {
        this.client = null;
        this.qrCodeData = null;
        this.status = 'disconnected'; // disconnected, connecting, connected
        this.authenticated = false;
        this.initialized = false;
        this.isInitializing = false;
        this.lastError = null;
        this.syncProgress = null;
    }

    async initialize() {
        if (this.status === 'connected') {
            console.log('[WhatsApp] Sudah terhubung');
            return;
        }
        if (this.isInitializing) {
            console.log('[WhatsApp] Sedang dalam proses inisialisasi...');
            return;
        }

        this.isInitializing = true;
        this.status = 'connecting';
        this.qrCodeData = null;
        this.lastError = null;
        this.syncProgress = null;

        try {
            if (this.client) {
                try { await this.client.destroy(); } catch (e) {}
                this.client = null;
            }

            // Bersihkan file lock usang jika ada dari crash sebelumnya
            try {
                const fs = require('fs');
                const lockFilePath = path.join(__dirname, '../whatsapp-session/session/lockfile');
                if (fs.existsSync(lockFilePath)) {
                    fs.unlinkSync(lockFilePath);
                }
            } catch (lockErr) {}

            const puppeteerOptions = {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-first-run',
                    '--no-zygote',
                    '--no-proxy-server',
                    '--dns-prefetch-disable',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--disable-extensions',
                    '--disable-accelerated-2d-canvas'
                ]
            };

            try {
                const puppeteer = require('puppeteer');
                if (typeof puppeteer.executablePath === 'function') {
                    const execPath = puppeteer.executablePath();
                    if (execPath) puppeteerOptions.executablePath = execPath;
                }
            } catch (pErr) {}

            this.client = new Client({
                authStrategy: new LocalAuth({
                    dataPath: path.join(__dirname, '../whatsapp-session')
                }),
                puppeteer: puppeteerOptions,
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                authTimeoutMs: 60000,
                qrMaxRetries: 5
            });

            this.client.on('qr', async (qr) => {
                try {
                    this.qrCodeData = await qrcode.toDataURL(qr, { width: 280, margin: 2 });
                    this.status = 'connecting';
                    this.authenticated = false;
                    console.log('[WhatsApp] QR Code berhasil dibuat, silakan scan.');
                } catch (qrErr) {
                    console.error('[WhatsApp] Gagal membuat gambar QR:', qrErr.message);
                }
            });

            this.client.on('loading_screen', (percent, message) => {
                this.syncProgress = { percent, message };
                console.log(`[WhatsApp] Sinkronisasi: ${percent}% - ${message || 'Memuat data...'}`);
                if (percent === 100 && this.status !== 'connected') {
                    setTimeout(async () => {
                        if (this.status !== 'connected' && this.client && this.client.pupPage) {
                            try {
                                await this.client.pupPage.evaluate(() => {
                                    if (typeof window.onAppStateHasSyncedEvent === 'function') {
                                        window.onAppStateHasSyncedEvent();
                                    }
                                });
                            } catch (e) {}
                        }
                    }, 1000);
                }
            });

            this.client.on('authenticated', () => {
                this.authenticated = true;
                this.qrCodeData = null;
                console.log('[WhatsApp] Kredensial berhasil diverifikasi. Sedang menyiapkan koneksi dan sinkronisasi chat...');
            });

            this.client.on('ready', () => {
                this.status = 'connected';
                this.qrCodeData = null;
                this.authenticated = true;
                this.initialized = true;
                this.isInitializing = false;
                this.syncProgress = null;
                this.retryCount = 0;
                if (this._syncWatchdog) {
                    clearInterval(this._syncWatchdog);
                    this._syncWatchdog = null;
                }
                console.log('[WhatsApp] Berhasil terhubung dan siap digunakan!');
            });

            this.client.on('disconnected', (reason) => {
                this.status = 'disconnected';
                this.qrCodeData = null;
                this.authenticated = false;
                this.initialized = false;
                this.isInitializing = false;
                this.syncProgress = null;
                console.log('[WhatsApp] Terputus:', reason);
            });

            this.client.on('auth_failure', (msg) => {
                this.status = 'disconnected';
                this.qrCodeData = null;
                this.authenticated = false;
                this.initialized = false;
                this.isInitializing = false;
                this.lastError = 'Autentikasi gagal: ' + msg;
                console.log('[WhatsApp] Autentikasi gagal:', msg);
            });

            await this.client.initialize();
            this.initialized = true;
            this.isInitializing = false;
            this.retryCount = 0;

            // Watchdog untuk memastikan transisi dari loading_screen 100% ke ready tidak macet
            if (this._syncWatchdog) clearInterval(this._syncWatchdog);
            this._syncWatchdog = setInterval(async () => {
                if (this.status === 'connected') {
                    clearInterval(this._syncWatchdog);
                    this._syncWatchdog = null;
                    return;
                }
                if (this.authenticated && this.client && this.client.pupPage) {
                    try {
                        await this.client.pupPage.evaluate(() => {
                            if (typeof window.onAppStateHasSyncedEvent === 'function') {
                                const socket = window.require?.('WAWebSocketModel')?.Socket;
                                if (!socket || socket.hasSynced) {
                                    window.onAppStateHasSyncedEvent();
                                }
                            }
                        });
                    } catch (e) {}
                }
            }, 3000);
        } catch (error) {
            this.status = 'disconnected';
            this.initialized = false;
            this.isInitializing = false;
            this.lastError = error.message;
            console.error('[WhatsApp] Kesalahan inisialisasi:', error.message);

            // Auto-retry jika terjadi kesalahan timeout jaringan atau koneksi terputus
            const isNetworkError = /ERR_CONNECTION_TIMED_OUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|timeout|closed/i.test(error.message);
            if (isNetworkError) {
                this.retryCount = (this.retryCount || 0) + 1;
                if (this.retryCount <= 5) {
                    const delaySec = 6;
                    console.log(`[WhatsApp] Koneksi ke WhatsApp Web terputus/timeout. Mencoba menghubungkan kembali otomatis dalam ${delaySec} detik (Percobaan ${this.retryCount}/5)...`);
                    setTimeout(() => {
                        this.initialize().catch(err => console.error('[WhatsApp] Auto-reconnect error:', err.message));
                    }, delaySec * 1000);
                } else {
                    console.warn('[WhatsApp] Batas percobaan auto-reconnect tercapai. Anda dapat klik tombol inisialisasi ulang di menu Pengaturan.');
                    this.retryCount = 0;
                }
            }
        }
    }

    getStatus() {
        return this.status;
    }

    getQR() {
        return this.qrCodeData;
    }

    getError() {
        return this.lastError;
    }

    async waitForReady(timeoutMs = 15000) {
        if (this.status === 'connected' && this.client) {
            return true;
        }

        if (this.client && this.client.pupPage) {
            try {
                await this.client.pupPage.evaluate(() => {
                    if (typeof window.onAppStateHasSyncedEvent === 'function') {
                        window.onAppStateHasSyncedEvent();
                    }
                });
            } catch (e) {}
        }

        return new Promise((resolve) => {
            const checkInterval = 500;
            let elapsed = 0;
            const timer = setInterval(async () => {
                elapsed += checkInterval;
                if (this.status === 'connected' && this.client) {
                    clearInterval(timer);
                    resolve(true);
                } else if (elapsed >= timeoutMs) {
                    clearInterval(timer);
                    if (this.client && this.client.pupPage) {
                        try {
                            const isReady = await this.client.pupPage.evaluate(() => {
                                return typeof window.WWebJS !== 'undefined' || !!document.querySelector('#pane-side, div[data-testid="chat-list"]');
                            });
                            if (isReady) {
                                this.status = 'connected';
                                this.authenticated = true;
                                this.initialized = true;
                                resolve(true);
                                return;
                            }
                        } catch (e) {}
                    }
                    resolve(false);
                }
            }, checkInterval);
        });
    }

    async sendMessage(phone, message) {
        if (!phone) throw new Error('Nomor telepon tidak valid');

        // Jika status belum connected, tunggu jika sedang connecting atau sudah authenticated
        if (this.status !== 'connected') {
            if (this.status === 'connecting' || this.isInitializing || this.authenticated) {
                console.log('[WhatsApp] Menunggu sinkronisasi chat selesai...');
                const ready = await this.waitForReady(30000);
                if (!ready) {
                    throw new Error('WhatsApp masih dalam proses sinkronisasi dengan ponsel. Mohon tunggu beberapa detik lagi dan coba kembali.');
                }
            } else {
                // Cek apakah sesi tersimpan ada di disk
                const fs = require('fs');
                const sessionDir = path.join(__dirname, '../whatsapp-session');
                if (fs.existsSync(sessionDir)) {
                    console.log('[WhatsApp] Sesi tersimpan ditemukan, menghubungkan otomatis...');
                    this.initialize().catch(err => console.error('[WhatsApp] Auto-init error:', err.message));
                    const ready = await this.waitForReady(30000);
                    if (!ready) {
                        throw new Error('WhatsApp sedang menghubungkan ke ponsel. Mohon tunggu sebentar lalu coba kirim kembali.');
                    }
                } else {
                    throw new Error('WhatsApp belum terhubung. Silakan scan QR code di menu Pengaturan terlebih dahulu.');
                }
            }
        }

        if (!this.client) {
            throw new Error('Klien WhatsApp belum siap.');
        }

        // Format phone: remove +, leading 0, add 62 for Indonesia
        let formatted = String(phone).replace(/[^0-9]/g, '');
        if (formatted.startsWith('0')) formatted = '62' + formatted.substring(1);
        if (!formatted.startsWith('62')) formatted = '62' + formatted;

        if (formatted.length < 8) {
            throw new Error(`Nomor telepon tidak valid (${phone})`);
        }

        const chatId = formatted + '@c.us';
        await this.client.sendMessage(chatId, message);
        return true;
    }

    /**
     * Kirim dokumen / file lampiran (PDF, dll) ke nomor WhatsApp
     * @param {string} phone - Nomor telepon tujuan
     * @param {Buffer|string} bufferOrBase64 - Binary buffer atau Base64 string dokumen
     * @param {string} filename - Nama file lampiran (misal: 'Invoice-INV-202610-0002.pdf')
     * @param {string} caption - Pesan teks / keterangan lampiran (opsional)
     * @param {string} mimetype - MIME type file (default: 'application/pdf')
     * @returns {Promise<boolean>}
     */
    async sendDocument(phone, bufferOrBase64, filename, caption = '', mimetype = 'application/pdf') {
        if (!phone) throw new Error('Nomor telepon tidak valid');

        // Pastikan koneksi WhatsApp siap
        if (this.status !== 'connected') {
            if (this.status === 'connecting' || this.isInitializing || this.authenticated) {
                console.log('[WhatsApp] Menunggu sinkronisasi chat selesai sebelum kirim dokumen...');
                const ready = await this.waitForReady(30000);
                if (!ready) {
                    throw new Error('WhatsApp masih dalam proses sinkronisasi dengan ponsel.');
                }
            } else {
                const fs = require('fs');
                const sessionDir = path.join(__dirname, '../whatsapp-session');
                if (fs.existsSync(sessionDir)) {
                    this.initialize().catch(err => console.error('[WhatsApp] Auto-init error:', err.message));
                    const ready = await this.waitForReady(30000);
                    if (!ready) {
                        throw new Error('WhatsApp sedang menghubungkan ke ponsel.');
                    }
                } else {
                    throw new Error('WhatsApp belum terhubung. Silakan hubungkan di menu Pengaturan.');
                }
            }
        }

        if (!this.client) {
            throw new Error('Klien WhatsApp belum siap.');
        }

        let formatted = String(phone).replace(/[^0-9]/g, '');
        if (formatted.startsWith('0')) formatted = '62' + formatted.substring(1);
        if (!formatted.startsWith('62')) formatted = '62' + formatted;

        if (formatted.length < 8) {
            throw new Error(`Nomor telepon tidak valid (${phone})`);
        }

        const chatId = formatted + '@c.us';
        let base64Data;
        let fileSize = null;
        if (Buffer.isBuffer(bufferOrBase64)) {
            base64Data = bufferOrBase64.toString('base64');
            fileSize = bufferOrBase64.length;
        } else if (bufferOrBase64 instanceof Uint8Array) {
            const buf = Buffer.from(bufferOrBase64);
            base64Data = buf.toString('base64');
            fileSize = buf.length;
        } else if (typeof bufferOrBase64 === 'string') {
            base64Data = bufferOrBase64.replace(/^data:.*?;base64,/, '').trim();
            fileSize = Buffer.byteLength(base64Data, 'base64');
        } else {
            const buf = Buffer.from(bufferOrBase64);
            base64Data = buf.toString('base64');
            fileSize = buf.length;
        }

        const media = new MessageMedia(mimetype, base64Data, filename, fileSize);

        // Pastikan LoadUtils terbaru & getMessageModel disuntikkan ke runtime WhatsApp Web
        try {
            if (this.client.pupPage) {
                const utilsPath = require.resolve('whatsapp-web.js/src/util/Injected/Utils');
                delete require.cache[utilsPath];
                const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');
                await this.client.pupPage.evaluate(LoadUtils);

                await this.client.pupPage.evaluate(() => {
                    if (window.WWebJS) {
                        const origGetMsgModel = window.WWebJS.getMessageModel;
                        window.WWebJS.getMessageModel = (message) => {
                            try {
                                return origGetMsgModel(message);
                            } catch (err) {
                                return {
                                    id: message && message.id ? (message.id._serialized || message.id) : { _serialized: 'sent' },
                                    ack: (message && message.ack) || 1,
                                    body: (message && message.body) || '',
                                    type: (message && message.type) || 'document'
                                };
                            }
                        };
                    }
                });
            }
        } catch (patchErr) {
            console.warn('[WhatsApp] Patch runtime warning:', patchErr.message);
        }

        const sentMsg = await this.client.sendMessage(chatId, media, {
            caption: caption || undefined,
            sendMediaAsDocument: true
        });

        console.log(`[WhatsApp] Dokumen PDF (${filename}) berhasil dikirim ke ${chatId}. Message ID:`, sentMsg?.id?._serialized || 'ok');
        return true;
    }

    /**
     * Kirim foto / gambar ke nomor WhatsApp dengan caption
     * @param {string} phone - Nomor telepon tujuan
     * @param {string} filePath - Path absolut berkas gambar di disk
     * @param {string} caption - Keterangan teks pada gambar
     * @returns {Promise<boolean>}
     */
    async sendImage(phone, filePath, caption = '') {
        if (!phone) throw new Error('Nomor telepon tidak valid');

        const fs = require('fs');
        if (!filePath || !fs.existsSync(filePath)) {
            throw new Error('Berkas foto tidak ditemukan');
        }

        // Pastikan koneksi WhatsApp siap
        if (this.status !== 'connected') {
            if (this.status === 'connecting' || this.isInitializing || this.authenticated) {
                const ready = await this.waitForReady(30000);
                if (!ready) {
                    throw new Error('WhatsApp masih dalam proses sinkronisasi dengan ponsel.');
                }
            } else {
                const sessionDir = path.join(__dirname, '../whatsapp-session');
                if (fs.existsSync(sessionDir)) {
                    this.initialize().catch(err => console.error('[WhatsApp] Auto-init error:', err.message));
                    const ready = await this.waitForReady(30000);
                    if (!ready) {
                        throw new Error('WhatsApp sedang menghubungkan ke ponsel.');
                    }
                } else {
                    throw new Error('WhatsApp belum terhubung. Silakan hubungkan di menu Pengaturan.');
                }
            }
        }

        if (!this.client) {
            throw new Error('Klien WhatsApp belum siap.');
        }

        let formatted = String(phone).replace(/[^0-9]/g, '');
        if (formatted.startsWith('0')) formatted = '62' + formatted.substring(1);
        if (!formatted.startsWith('62')) formatted = '62' + formatted;

        if (formatted.length < 8) {
            throw new Error(`Nomor telepon tidak valid (${phone})`);
        }

        const chatId = formatted + '@c.us';
        const media = MessageMedia.fromFilePath(filePath);

        try {
            if (this.client.pupPage) {
                await this.client.pupPage.evaluate(() => {
                    if (window.WWebJS) {
                        const origGetMsgModel = window.WWebJS.getMessageModel;
                        window.WWebJS.getMessageModel = (message) => {
                            try {
                                return origGetMsgModel(message);
                            } catch (err) {
                                return {
                                    id: message && message.id ? (message.id._serialized || message.id) : { _serialized: 'sent' },
                                    ack: (message && message.ack) || 1,
                                    body: (message && message.body) || '',
                                    type: (message && message.type) || 'image'
                                };
                            }
                        };
                    }
                });
            }
        } catch (patchErr) {}

        await this.client.sendMessage(chatId, media, {
            caption: caption || undefined
        });
        console.log(`[WhatsApp] Foto (${path.basename(filePath)}) berhasil dikirim ke ${chatId}`);
        return true;
    }

    /**
     * Kirim pesan WhatsApp Selamat Bergabung ke pelanggan baru yang didaftarkan
     * @param {object} customer - Objek customer (id, customer_id, name, phone, package_id, etc.)
     * @returns {Promise<{ success: boolean, message: string }>}
     */
    async sendWelcomeCustomer(customer) {
        if (!customer || !customer.phone) {
            return { success: false, message: 'Nomor WhatsApp pelanggan tidak tersedia' };
        }

        const db = require('../database/init');

        // Cek apakah fitur welcome message aktif di pengaturan
        try {
            const enabledRow = db.prepare("SELECT value FROM settings WHERE key = 'welcome_wa_enabled'").get();
            if (enabledRow && (enabledRow.value === 'false' || enabledRow.value === '0')) {
                console.log('[WhatsApp] Fitur pesan selamat bergabung dinonaktifkan di pengaturan.');
                return { success: false, message: 'Fitur pesan selamat bergabung dinonaktifkan di pengaturan.' };
            }
        } catch (eCheck) {}

        // Ambil template pesan dari settings
        let template = '';
        try {
            const templateRow = db.prepare("SELECT value FROM settings WHERE key = 'welcome_message_template'").get();
            if (templateRow && templateRow.value && templateRow.value.trim()) {
                template = templateRow.value.trim();
            }
        } catch (eTpl) {}

        if (!template) {
            template = `Yth. {customer_name},

Selamat bergabung bersama {company_name}! 🎉
Layanan internet Anda telah aktif dengan rincian sebagai berikut:

*ID Pelanggan:* {customer_id}
*Nama:* {customer_name}
*Paket Internet:* {package_name} ({package_speed})
*Biaya Langganan:* Rp {package_price}/bulan
*Jatuh Tempo Pembayaran:* {due_date}

*Informasi Akun:* 
Username: {pppoe_username}
Password: {pppoe_password}

Simpan pesan ini dan nomor ID Pelanggan Anda untuk mempermudah pengecekan tagihan serta layanan bantuan.

Bantuan Layanan Pelanggan: {company_phone}

Terima kasih telah mempercayakan kebutuhan internet Anda kepada {company_name}!`;
        }

        // Ambil data paket jika package_id ada
        let pkg = {};
        if (customer.package_id) {
            try {
                pkg = db.prepare("SELECT * FROM packages WHERE id = ?").get(customer.package_id) || {};
            } catch (ePkg) {}
        }

        // Ambil info perusahaan
        const getSetting = (k) => {
            try {
                return db.prepare("SELECT value FROM settings WHERE key = ?").get(k)?.value || '';
            } catch (e) {
                return '';
            }
        };

        const company = {
            company_name: getSetting('company_name') || 'ISP Manager',
            company_phone: getSetting('company_phone') || '',
            company_address: getSetting('company_address') || ''
        };

        const message = this.formatTemplate(template, {
            customer,
            package: pkg,
            company,
            due_date: customer.due_date ? `Tanggal ${customer.due_date} setiap bulan` : 'Tanggal 8 setiap bulan'
        });

        // Kirim WhatsApp
        try {
            await this.sendMessage(customer.phone, message);
            console.log(`[WhatsApp] Pesan selamat bergabung berhasil dikirim ke ${customer.name} (${customer.phone})`);

            // Catat ke activity_log
            try {
                db.prepare(`
                    INSERT INTO activity_log (action, description, created_at)
                    VALUES ('whatsapp_welcome_sent', ?, datetime('now'))
                `).run(`Pesan Selamat Bergabung terkirim ke ${customer.name} (${customer.customer_id || '-'})`);
            } catch (eLog) {}

            return { success: true, message: 'Pesan selamat bergabung berhasil dikirim via WhatsApp.' };
        } catch (err) {
            console.error(`[WhatsApp] Gagal mengirim pesan selamat bergabung ke ${customer.name}:`, err.message);
            return { success: false, message: 'Gagal mengirim WhatsApp: ' + err.message };
        }
    }

    /**
     * Format template pesan WhatsApp dengan mengganti semua placeholder / kode referensi
     * @param {string} template - Teks template pesan
     * @param {object} data - Data kontekstual (customer, invoice, package, payment, company)
     * @returns {string} - Pesan yang sudah diisi nilai sebenarnya
     */
    formatTemplate(template, data = {}) {
        if (!template) return '';
        const moment = require('moment');
        try { require('moment/locale/id'); moment.locale('id'); } catch (e) {}

        const { customer = {}, invoice = {}, package: pkg = {}, payment = {}, company = {} } = data;

        const custName = customer.name || data.customer_name || '';
        const custId = customer.customer_id || data.customer_id || '';
        const custPhone = customer.phone || data.customer_phone || '';
        const custAddress = customer.address || data.customer_address || '-';
        const pppoeUser = customer.pppoe_username || data.pppoe_username || '-';
        const pppoePass = customer.pppoe_password || data.pppoe_password || '-';
        const ipAddr = customer.ip_address || data.ip_address || '-';

        const pkgName = pkg.name || customer.package_name || data.package_name || '-';
        const speedDown = pkg.speed_down || customer.speed_down || data.speed_down || '';
        const speedUp = pkg.speed_up || customer.speed_up || data.speed_up || '';
        const pkgSpeed = speedDown ? (speedUp ? `${speedDown}/${speedUp} Mbps` : `${speedDown} Mbps`) : '-';
        const pkgPriceRaw = pkg.price !== undefined ? pkg.price : (customer.package_price !== undefined ? customer.package_price : data.package_price);
        const pkgPriceFormatted = pkgPriceRaw !== undefined && pkgPriceRaw !== null ? new Intl.NumberFormat('id-ID').format(pkgPriceRaw) : '0';

        const installDateRaw = customer.installation_date || data.installation_date;
        const installDateFormatted = installDateRaw ? moment(installDateRaw).format('DD MMMM YYYY') : '-';
        const customerDueDate = customer.due_date ? `Tanggal ${customer.due_date} setiap bulan` : (data.due_date || 'Tanggal 8 setiap bulan');

        const invNum = invoice.invoice_number || data.invoice_number || '';
        const period = invoice.period || data.period || '';
        const amountRaw = invoice.amount !== undefined ? invoice.amount : data.amount;
        const amountFormatted = amountRaw !== undefined && amountRaw !== null ? new Intl.NumberFormat('id-ID').format(amountRaw) : '0';

        let dueDate = customerDueDate;
        if (invoice.due_date) {
            const mDueDate = moment(invoice.due_date);
            if (mDueDate.isValid()) {
                dueDate = `${mDueDate.format('DD MMMM YYYY')} pukul 23:59 WIB`;
            }
        } else if (data.due_date) {
            dueDate = String(data.due_date);
        }

        const invStatus = invoice.status || data.status || 'UNPAID';

        const payMethod = payment.payment_method || data.payment_method || '';
        const methodMap = {
            'cash': 'Cash (Tunai)',
            'cash (tunai)': 'Cash (Tunai)',
            'tunai': 'Cash (Tunai)',
            'bca': 'BCA',
            'bri': 'BRI',
            'dana': 'DANA',
            'qris': 'QRIS',
            'spay': 'SPay',
            'transfer': 'Transfer Bank'
        };
        const readablePayMethod = methodMap[payMethod.toLowerCase()] || payMethod || 'Cash (Tunai)';
        const payDate = payment.payment_date || data.payment_date ? moment(payment.payment_date || data.payment_date).format('DD MMMM YYYY') : moment().format('DD MMMM YYYY');

        const compName = company.company_name || data.company_name || 'ISP Manager';
        const compPhone = company.company_phone || data.company_phone || '';
        const compAddress = company.company_address || data.company_address || '';

        let result = template;

        const replacements = {
            // Pelanggan
            '{customer_name}': custName,
            '{nama_pelanggan}': custName,
            '{nama}': custName,
            '{customer_id}': custId,
            '{id_pelanggan}': custId,
            '{customer_phone}': custPhone,
            '{telepon}': custPhone,
            '{no_hp}': custPhone,
            '{customer_address}': custAddress,
            '{alamat}': custAddress,

            // Paket Internet & Koneksi
            '{paket_internet}': pkgName,
            '{package_name}': pkgName,
            '{paket}': pkgName,
            '{kecepatan}': pkgSpeed,
            '{package_speed}': pkgSpeed,
            '{package_price}': pkgPriceFormatted,
            '{harga_paket}': pkgPriceFormatted,
            '{pppoe_username}': pppoeUser,
            '{username_pppoe}': pppoeUser,
            '{pppoe_password}': pppoePass,
            '{password_pppoe}': pppoePass,
            '{password}': pppoePass,
            '{ip_address}': ipAddr,
            '{alamat_ip}': ipAddr,
            '{installation_date}': installDateFormatted,
            '{tanggal_pemasangan}': installDateFormatted,

            // Tagihan / Invoice
            '{invoice_number}': invNum,
            '{no_invoice}': invNum,
            '{no_tagihan}': invNum,
            '{period}': period,
            '{periode}': period,
            '{amount}': amountFormatted,
            '{jumlah_tagihan}': amountFormatted,
            '{nominal}': amountFormatted,
            '{due_date}': dueDate,
            '{jatuh_tempo}': dueDate,
            '{due_time}': '23:59 WIB',
            '{jam_jatuh_tempo}': '23:59 WIB',
            '{status}': invStatus.toUpperCase(),

            // Pembayaran
            '{payment_method}': readablePayMethod,
            '{metode_bayar}': readablePayMethod,
            '{payment_date}': payDate,
            '{tanggal_bayar}': payDate,

            // Perusahaan
            '{company_name}': compName,
            '{nama_perusahaan}': compName,
            '{company_phone}': compPhone,
            '{kontak_perusahaan}': compPhone,
            '{cs}': compPhone,
            '{company_address}': compAddress,
            '{alamat_perusahaan}': compAddress
        };

        for (const [placeholder, value] of Object.entries(replacements)) {
            result = result.split(placeholder).join(value !== undefined && value !== null ? value : '');
        }

        return result;
    }

    async disconnect() {
        try {
            if (this.client) {
                await this.client.destroy();
            }
        } catch (e) {
            console.error('[WhatsApp] Error saat disconnect:', e.message);
        } finally {
            this.client = null;
            this.status = 'disconnected';
            this.qrCodeData = null;
            this.authenticated = false;
            this.initialized = false;
            this.isInitializing = false;
            this.syncProgress = null;
            this.lastError = null;
        }
    }

    async restart() {
        await this.disconnect();
        await new Promise(r => setTimeout(r, 1500));
        this.initialize().catch(err => {
            console.error('[WhatsApp] Restart initialization error:', err.message);
        });
        return true;
    }
}

module.exports = new WhatsAppService();
