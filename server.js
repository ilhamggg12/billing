// ISP Manager - Server Utama
// Sistem Manajemen Pelanggan Internet

require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const flash = require('connect-flash');
const helmet = require('helmet');
const compression = require('compression');

// Inisialisasi Database
const db = require('./database/init');

const app = express();

// Menentukan Port Web (Prioritas: Database Settings -> Environment Variable .env -> Default 3000)
function getWebPort() {
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'web_port'").get();
        if (row && row.value) {
            const p = parseInt(row.value, 10);
            if (!isNaN(p) && p > 0 && p <= 65535) {
                return p;
            }
        }
    } catch (e) {}
    if (process.env.PORT) {
        const envP = parseInt(process.env.PORT, 10);
        if (!isNaN(envP) && envP > 0 && envP <= 65535) {
            return envP;
        }
    }
    return 3000;
}

const PORT = getWebPort();

// Tangkal error tak terduga agar server tetap hidup
process.on('uncaughtException', (err) => {
    console.error('[Process Uncaught Exception]:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Process Unhandled Rejection]:', reason?.message || reason);
});

// ============================================
// Konfigurasi View Engine
// ============================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('view cache', false);

// ============================================
// Middleware
// ============================================

// Keamanan HTTP headers - CSP permisif untuk CDN
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'",
                "https://cdn.jsdelivr.net",
                "https://cdnjs.cloudflare.com",
                "https://unpkg.com",
                "https://code.jquery.com",
                "https://cdn.datatables.net"
            ],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'",
                "https://cdn.jsdelivr.net",
                "https://cdnjs.cloudflare.com",
                "https://unpkg.com",
                "https://fonts.googleapis.com",
                "https://cdn.datatables.net"
            ],
            fontSrc: ["'self'",
                "https://cdn.jsdelivr.net",
                "https://cdnjs.cloudflare.com",
                "https://fonts.gstatic.com"
            ],
            imgSrc: ["'self'", "data:", "blob:",
                "https://*.tile.openstreetmap.org",
                "https://server.arcgisonline.com",
                "https://*.arcgisonline.com",
                "https://*.google.com",
                "https://*.googleapis.com",
                "https://*.basemaps.cartocdn.com",
                "https://basemaps.cartocdn.com",
                "https://unpkg.com"
            ],
            connectSrc: ["'self'", "https:", "ws:", "wss:"]
        }
    }
}));

// Kompresi response
app.use(compression());

// Parsing body request (limit 10mb untuk mendukung upload gambar QRIS)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// File statis
app.use(express.static(path.join(__dirname, 'public')));

// Konfigurasi session
app.use(session({
    secret: process.env.SESSION_SECRET || 'isp-manager-default-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set true jika menggunakan HTTPS
        maxAge: 24 * 60 * 60 * 1000 // 24 jam
    }
}));

// Flash messages
app.use(flash());

// ============================================
// Inisialisasi Database
// ============================================
// Database instance db sudah diinisialisasi di atas saat penentuan PORT

// Variabel global untuk views - flash messages, data user, dan jumlah tiket gangguan aktif
app.use((req, res, next) => {
    res.locals.messages = {
        success: req.flash('success'),
        error: req.flash('error'),
        warning: req.flash('warning')
    };
    res.locals.user = req.session.user || null;
    try {
        const activeTicketsRow = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status != 'resolved'").get();
        res.locals.activeTicketCount = activeTicketsRow ? activeTicketsRow.c : 0;
        const activePsbRow = db.prepare("SELECT COUNT(*) as c FROM psb_tickets WHERE status != 'completed'").get();
        res.locals.activePsbCount = activePsbRow ? activePsbRow.c : 0;
    } catch (e) {
        res.locals.activeTicketCount = 0;
        res.locals.activePsbCount = 0;
    }
    next();
});

// ============================================
// Routes
// ============================================
app.use('/', require('./routes/auth'));
app.use('/auth', require('./routes/auth'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/customers', require('./routes/customers'));
app.use('/packages', require('./routes/packages'));
app.use('/billing', require('./routes/billing'));
app.use('/tickets', require('./routes/tickets'));
app.use('/psb', require('./routes/psb'));
app.use('/rekap-teknisi', require('./routes/technician-recap'));
app.use('/portal', require('./routes/portal'));
app.use('/reports', require('./routes/reports'));
app.use('/map', require('./routes/map'));
app.use('/mikrotik', require('./routes/mikrotik'));
app.use('/genieacs', require('./routes/genieacs'));
app.use('/settings', require('./routes/settings'));
app.use('/api', require('./routes/api'));

// Redirect root sesuai role pengguna
app.get('/', (req, res) => {
    if (req.session && req.session.user) {
        if (req.session.user.role === 'customer') {
            return res.redirect('/portal');
        }
        if (req.session.user.role === 'technician') {
            return res.redirect('/tickets');
        }
    }
    res.redirect('/dashboard');
});

// ============================================
// Handler Error
// ============================================

// 404 - Halaman tidak ditemukan
app.use((req, res) => {
    res.status(404).render('errors/404', {
        title: 'Halaman Tidak Ditemukan'
    });
});

// 500 - Error handler umum
app.use((err, req, res, next) => {
    console.error('Server Error:', err.stack || err);
    res.status(500).render('errors/500', {
        title: 'Terjadi Kesalahan Server',
        error: err
    });
});

// ============================================
// Jalankan Server
// ============================================
app.listen(PORT, () => {
    console.log(`================================================`);
    console.log(`  ISP Manager - Sistem Manajemen ISP`);
    console.log(`  Server berjalan di http://localhost:${PORT}`);
    console.log(`  Mode: ${process.env.NODE_ENV || 'development'}`);
    console.log(`================================================`);

    // Inisialisasi layanan WhatsApp
    try {
        const fs = require('fs');
        const path = require('path');
        const whatsappService = require('./services/whatsapp');
        const sessionPath = path.join(__dirname, 'whatsapp-session');
        if (fs.existsSync(sessionPath)) {
            console.log('[WhatsApp] Sesi tersimpan ditemukan. Menghubungkan WhatsApp di latar belakang...');
            whatsappService.initialize().catch(err => {
                console.log('[WhatsApp] Gagal inisialisasi sesi:', err.message);
            });
        } else {
            console.log('[WhatsApp] Layanan WhatsApp siap (menunggu inisialisasi di menu Pengaturan)');
        }
    } catch (error) {
        console.log('[WhatsApp] Gagal memuat layanan WhatsApp:', error.message);
    }

    // Inisialisasi layanan scheduler (penjadwal tugas)
    try {
        const schedulerService = require('./services/scheduler');
        schedulerService.initialize();
        console.log('[Scheduler] Layanan penjadwal tugas (Cron) berhasil diaktifkan');
    } catch (error) {
        console.log('[Scheduler] Gagal memuat layanan penjadwal:', error.message);
    }
});
