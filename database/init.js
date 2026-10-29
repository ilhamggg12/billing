// Inisialisasi Database SQLite
// Membuat tabel dan data default saat pertama kali dijalankan

const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

// Buat koneksi database
const dbPath = path.join(__dirname, 'isp-manager.db');
const db = new Database(dbPath);

// Aktifkan WAL mode untuk performa lebih baik
db.pragma('journal_mode = WAL');

// ============================================
// Pembuatan Tabel
// ============================================

// Tabel pengguna sistem
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Tabel paket layanan internet
db.exec(`
    CREATE TABLE IF NOT EXISTS packages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        speed_down INTEGER NOT NULL,
        speed_up INTEGER NOT NULL,
        price REAL NOT NULL,
        description TEXT,
        is_bypass INTEGER DEFAULT 0, -- 1: Bebas tagihan & kebal isolir otomatis
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Tabel pelanggan
db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id TEXT UNIQUE,
        name TEXT NOT NULL,
        address TEXT,
        phone TEXT,
        email TEXT,
        package_id INTEGER REFERENCES packages(id),
        connection_type TEXT DEFAULT 'pppoe', -- 'pppoe' atau 'static'
        pppoe_username TEXT,
        pppoe_password TEXT,
        ip_address TEXT,
        mac_address TEXT,
        latitude REAL,
        longitude REAL,
        onu_serial TEXT,
        installation_date DATE,
        due_date INTEGER DEFAULT 8,
        status TEXT DEFAULT 'active',
        is_auto_isolated INTEGER DEFAULT 0,
        notes TEXT,
        additional_bill REAL DEFAULT 0,
        additional_bill_desc TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Migration jika kolom belum ada pada database yang sudah terbentuk
try {
    const tableInfo = db.prepare("PRAGMA table_info(customers)").all();
    const columns = tableInfo.map(col => col.name);
    if (!columns.includes('connection_type')) {
        db.exec("ALTER TABLE customers ADD COLUMN connection_type TEXT DEFAULT 'pppoe'");
    }
    if (!columns.includes('ip_address')) {
        db.exec("ALTER TABLE customers ADD COLUMN ip_address TEXT");
    }
    if (!columns.includes('mac_address')) {
        db.exec("ALTER TABLE customers ADD COLUMN mac_address TEXT");
    }
    // Migration kolom gateway_ip: alamat IP gateway/router pelanggan IP Statik (tautan login router di Portal Pelanggan)
    if (!columns.includes('gateway_ip')) {
        db.exec("ALTER TABLE customers ADD COLUMN gateway_ip TEXT");
    }

    // Migration tabel customers untuk kolom router_id
    if (!columns.includes('router_id')) {
        db.exec("ALTER TABLE customers ADD COLUMN router_id INTEGER REFERENCES routers(id)");
    }

    // Migration tabel customers untuk kolom portal_password (login portal tiket pelanggan)
    if (!columns.includes('portal_password')) {
        db.exec("ALTER TABLE customers ADD COLUMN portal_password TEXT DEFAULT '123456'");
        db.exec("UPDATE customers SET portal_password = '123456' WHERE portal_password IS NULL OR portal_password = ''");
    }

    // Migration tabel customers untuk kolom additional_bill dan additional_bill_desc (Tagihan Tambahan / Lainnya)
    if (!columns.includes('additional_bill')) {
        db.exec("ALTER TABLE customers ADD COLUMN additional_bill REAL DEFAULT 0");
    }
    if (!columns.includes('additional_bill_desc')) {
        db.exec("ALTER TABLE customers ADD COLUMN additional_bill_desc TEXT");
    }
    // Migration kolom auto_reset_additional_bill (1: otomatis kosong saat lunas, 0: tetap ada / berulang)
    if (!columns.includes('auto_reset_additional_bill')) {
        db.exec("ALTER TABLE customers ADD COLUMN auto_reset_additional_bill INTEGER DEFAULT 1");
    }

    // Migration kolom is_auto_isolated (1: diisolir otomatis oleh scheduler karena jatuh tempo, 0: diisolir manual oleh admin)
    if (!columns.includes('is_auto_isolated')) {
        db.exec("ALTER TABLE customers ADD COLUMN is_auto_isolated INTEGER DEFAULT 0");
    }

    // Migration tabel users untuk kolom updated_at
    const userTableInfo = db.prepare("PRAGMA table_info(users)").all();
    const userColumns = userTableInfo.map(col => col.name);
    if (!userColumns.includes('updated_at')) {
        db.exec("ALTER TABLE users ADD COLUMN updated_at DATETIME");
    }

    // Migration tabel invoices untuk kolom additional_bill & additional_bill_desc
    const invTableInfo = db.prepare("PRAGMA table_info(invoices)").all();
    const invColumns = invTableInfo.map(col => col.name);
    if (!invColumns.includes('additional_bill')) {
        db.exec("ALTER TABLE invoices ADD COLUMN additional_bill REAL DEFAULT 0");
    }
    if (!invColumns.includes('additional_bill_desc')) {
        db.exec("ALTER TABLE invoices ADD COLUMN additional_bill_desc TEXT");
    }

    // Backfill kolom additional_bill dan additional_bill_desc di invoices dari kolom notes jika ada
    try {
        const invsWithNotes = db.prepare("SELECT id, notes FROM invoices WHERE (additional_bill IS NULL OR additional_bill = 0) AND notes IS NOT NULL").all();
        for (const inv of invsWithNotes) {
            const matchPlus = inv.notes.match(/Tagihan Tambahan:\s*\+Rp\s*([0-9.,]+)(?:\s*\((.*?)\))?/i);
            const matchMinus = inv.notes.match(/Potongan Tagihan:\s*-Rp\s*([0-9.,]+)(?:\s*\((.*?)\))?/i);
            if (matchPlus) {
                const rawNum = matchPlus[1].replace(/\./g, '').replace(/,/g, '.');
                const amt = parseFloat(rawNum) || 0;
                const dsc = matchPlus[2] ? matchPlus[2].trim() : null;
                db.prepare("UPDATE invoices SET additional_bill = ?, additional_bill_desc = ? WHERE id = ?").run(amt, dsc, inv.id);
            } else if (matchMinus) {
                const rawNum = matchMinus[1].replace(/\./g, '').replace(/,/g, '.');
                const amt = -(parseFloat(rawNum) || 0);
                const dsc = matchMinus[2] ? matchMinus[2].trim() : null;
                db.prepare("UPDATE invoices SET additional_bill = ?, additional_bill_desc = ? WHERE id = ?").run(amt, dsc, inv.id);
            }
        }
    } catch (eBackfill) {
        console.warn('[Database] Peringatan backfill additional_bill invoices:', eBackfill.message);
    }

    // Migration tabel packages untuk kolom is_bypass & no_wa_billing
    const pkgTableInfo = db.prepare("PRAGMA table_info(packages)").all();
    const pkgColumns = pkgTableInfo.map(col => col.name);
    if (!pkgColumns.includes('is_bypass')) {
        db.exec("ALTER TABLE packages ADD COLUMN is_bypass INTEGER DEFAULT 0");
    }
    if (!pkgColumns.includes('no_wa_billing')) {
        db.exec("ALTER TABLE packages ADD COLUMN no_wa_billing INTEGER DEFAULT 0");
    }

    // Seed paket default Gratis / Bypass jika belum ada
    const bypassPkg = db.prepare("SELECT id FROM packages WHERE is_bypass = 1").get();
    if (!bypassPkg) {
        db.prepare(`
            INSERT INTO packages (name, speed_down, speed_up, price, description, is_bypass, is_active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
            'Paket Gratis / Bypass',
            50,
            50,
            0,
            'Paket khusus gratis/bypass untuk staff, keluarga, atau kantor. Bebas tagihan bulanan dan kebal dari isolir otomatis.',
            1,
            1
        );
        console.log('[Database] Seeded default Paket Gratis / Bypass');
    }

    // Seed / Pastikan paket 'exiting (pararel)' ada dan tersetting no_wa_billing = 1, is_bypass = 0
    const existingPararel = db.prepare("SELECT id FROM packages WHERE LOWER(name) LIKE '%exiting%pararel%' OR LOWER(name) LIKE '%existing%pararel%' OR LOWER(name) LIKE '%existing%paralel%'").get();
    if (!existingPararel) {
        db.prepare(`
            INSERT INTO packages (name, speed_down, speed_up, price, description, is_bypass, no_wa_billing, is_active, created_at)
            VALUES (?, ?, ?, ?, ?, 0, 1, 1, datetime('now'))
        `).run(
            'exiting (pararel)',
            10,
            10,
            0,
            'Paket internet jalur paralel/existing. Bisa terisolir secara normal, namun tidak akan mendapatkan informasi tagihan via WhatsApp.'
        );
        console.log('[Database] Seeded paket baru: exiting (pararel)');
    } else {
        db.prepare("UPDATE packages SET no_wa_billing = 1, is_bypass = 0 WHERE id = ?").run(existingPararel.id);
    }

    // Pastikan juga paket 'HSI - Add On' (Paket Pararel) tersetting no_wa_billing = 1 jika ada
    try {
        db.prepare("UPDATE packages SET no_wa_billing = 1, is_bypass = 0 WHERE LOWER(description) LIKE '%paket pararel%'").run();
    } catch (e) {}

    // Tabel routers untuk multi-koneksi MikroTik
    db.exec(`
        CREATE TABLE IF NOT EXISTS routers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER DEFAULT 8728,
            username TEXT NOT NULL,
            password TEXT,
            isolir_address_list TEXT DEFAULT 'Expired',
            description TEXT,
            is_active INTEGER DEFAULT 1,
            is_default INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Migrasi konfigurasi router lama dari tabel settings jika routers masih kosong
    const routerCount = db.prepare("SELECT COUNT(*) as count FROM routers").get();
    if (routerCount.count === 0) {
        const getSetting = (k) => {
            try {
                return db.prepare("SELECT value FROM settings WHERE key = ?").get(k)?.value || '';
            } catch (e) {
                return '';
            }
        };

        const oldHost = getSetting('mikrotik_host') || '172.16.0.1';
        const oldPort = parseInt(getSetting('mikrotik_port'), 10) || 8788;
        const oldUser = getSetting('mikrotik_username') || 'owners';
        const oldPass = getSetting('mikrotik_password') || '';
        const oldList = getSetting('isolir_address_list') || 'Expired';

        const insertRouter = db.prepare(`
            INSERT INTO routers (name, host, port, username, password, isolir_address_list, description, is_active, is_default, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, datetime('now'), datetime('now'))
        `);
        const rResult = insertRouter.run(
            'MikroTik Utama',
            oldHost,
            oldPort,
            oldUser,
            oldPass,
            oldList,
            'Router MikroTik utama'
        );

        // Update semua pelanggan yang ada agar terhubung ke router default ini
        db.prepare("UPDATE customers SET router_id = ? WHERE router_id IS NULL OR router_id = 0").run(rResult.lastInsertRowid);
        console.log('[Database] Migrasi multi-MikroTik: Router utama dibuat dengan ID:', rResult.lastInsertRowid);
    }
} catch (e) {
    console.error('Migration error:', e.message);
}

// Tabel tagihan/invoice
db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_number TEXT UNIQUE NOT NULL,
        customer_id INTEGER REFERENCES customers(id),
        amount REAL NOT NULL,
        period TEXT NOT NULL,
        due_date DATE NOT NULL,
        paid_date DATE,
        status TEXT DEFAULT 'unpaid',
        whatsapp_sent INTEGER DEFAULT 0,
        whatsapp_sent_at DATETIME,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Tabel pembayaran
db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id INTEGER REFERENCES invoices(id),
        amount REAL NOT NULL,
        payment_method TEXT DEFAULT 'cash',
        payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        received_by TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Tabel pengaturan sistem
db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Tabel log aktivitas
db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        description TEXT,
        user_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Tabel perangkat jaringan FTTH (ODP, ODC, OLT, Switch, ONT)
db.exec(`
    CREATE TABLE IF NOT EXISTS network_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL, -- 'ODP', 'ODC', 'OLT', 'Switch', 'ONT'
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        capacity INTEGER DEFAULT 8,
        used_capacity INTEGER DEFAULT 0,
        customer_id INTEGER REFERENCES customers(id),
        address TEXT,
        notes TEXT,
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Tabel kabel jaringan fiber optic (Backbone, Feeder, Distribusi, Dropcore)
db.exec(`
    CREATE TABLE IF NOT EXISTS network_cables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        cable_type TEXT DEFAULT 'distribution', -- 'backbone', 'feeder', 'distribution', 'dropcore'
        core_count INTEGER DEFAULT 12,
        color TEXT DEFAULT '#3b82f6',
        coordinates TEXT NOT NULL, -- JSON string array of [[lat, lng], [lat, lng], ...]
        length_meters REAL DEFAULT 0,
        from_node_id INTEGER REFERENCES network_nodes(id),
        to_node_id INTEGER REFERENCES network_nodes(id),
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Seed data infrastruktur default jika masih kosong (Area Solokanjeruk)
try {
    const nodeCount = db.prepare("SELECT COUNT(*) as count FROM network_nodes").get();
    if (nodeCount.count === 0) {
        const insertNode = db.prepare(`
            INSERT INTO network_nodes (name, type, latitude, longitude, capacity, used_capacity, address, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const rOlt = insertNode.run('OLT NOC Pusat', 'OLT', -7.020450, 107.727400, 16, 4, 'Kantor NOC LJN Solokanjeruk', 'OLT Utama EPON/GPON 16 PON Port');
        const rOdc = insertNode.run('ODC-01 Solokanjeruk', 'ODC', -7.020720, 107.727650, 48, 12, 'Jl. Raya Solokanjeruk', 'ODC Feeder 48 Core');
        const rOdp1 = insertNode.run('ODP-SLK-01 Sagra', 'ODP', -7.020920, 107.727810, 8, 3, 'Tiang Telkom No. 12 Sagra', 'Splitter 1:8');
        const rOdp2 = insertNode.run('ODP-SLK-02 Citoke', 'ODP', -7.018900, 107.727950, 8, 2, 'Tiang Masuk Gang Citoke', 'Splitter 1:8');
        const rSw = insertNode.run('SW-Dist-01', 'Switch', -7.020550, 107.727480, 24, 8, 'Rack Server Lt. 2', 'Manageable Switch Gigabit');

        // Kabel Feeder OLT -> ODC
        const insertCable = db.prepare(`
            INSERT INTO network_cables (name, cable_type, core_count, color, coordinates, length_meters, from_node_id, to_node_id, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertCable.run(
            'Feeder OLT ke ODC-01',
            'feeder',
            24,
            '#ef4444',
            JSON.stringify([
                [-7.020450, 107.727400],
                [-7.020580, 107.727520],
                [-7.020720, 107.727650]
            ]),
            42,
            rOlt.lastInsertRowid,
            rOdc.lastInsertRowid,
            'Kabel Udara ADSS 24 Core'
        );

        // Kabel Distribusi ODC -> ODP-SLK-01
        insertCable.run(
            'Distribusi ODC-01 ke ODP-SLK-01',
            'distribution',
            12,
            '#3b82f6',
            JSON.stringify([
                [-7.020720, 107.727650],
                [-7.020810, 107.727730],
                [-7.020920, 107.727810]
            ]),
            31,
            rOdc.lastInsertRowid,
            rOdp1.lastInsertRowid,
            'Kabel Distribusi 12 Core'
        );
        console.log('[Database] Seeded data infrastruktur awal (OLT, ODC, ODP, Switch, & Kabel)');
    }
} catch (eInitInfra) {
    console.error('Error init network infrastructure:', eInitInfra.message);
}

// ============================================
// Tabel Tiket Gangguan & Teknisi
// ============================================

// Tabel teknisi lapangan (dilengkapi akun login portal teknisi)
db.exec(`
    CREATE TABLE IF NOT EXISTS technicians (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        role TEXT DEFAULT 'Teknisi Lapangan',
        is_active INTEGER DEFAULT 1,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Migrasi kolom username & password pada tabel technicians jika belum ada
try {
    const techCols = db.prepare("PRAGMA table_info(technicians)").all().map(c => c.name);
    if (!techCols.includes('username')) {
        db.exec("ALTER TABLE technicians ADD COLUMN username TEXT");
    }
    if (!techCols.includes('password')) {
        db.exec("ALTER TABLE technicians ADD COLUMN password TEXT");
    }

    // Pastikan teknisi yang sudah ada namun belum memiliki password mendapat password default 'teknisi123'
    const noPassTechs = db.prepare("SELECT id, name, phone FROM technicians WHERE password IS NULL OR password = ''").all();
    for (const t of noPassTechs) {
        const defaultUser = t.name ? t.name.toLowerCase().replace(/[^a-z0-9]/g, '') : ('teknisi' + t.id);
        db.prepare("UPDATE technicians SET username = COALESCE(username, ?), password = ? WHERE id = ?")
            .run(defaultUser, bcrypt.hashSync('teknisi123', 10), t.id);
    }

    // Seed akun teknisi default jika tabel technicians masih kosong
    const techCount = db.prepare("SELECT COUNT(*) as c FROM technicians").get()?.c || 0;
    if (techCount === 0) {
        const defaultTechHash = bcrypt.hashSync('teknisi123', 10);
        db.prepare(`
            INSERT INTO technicians (username, password, name, phone, role, is_active, notes, created_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now', 'localtime'))
        `).run(
            'teknisi',
            defaultTechHash,
            'Teknisi Lapangan',
            '085179994008',
            'Teknisi Lapangan / Splicer',
            'Akun teknisi default (Login: teknisi / teknisi123)'
        );
        console.log('[Database] Seeded akun teknisi default (username: teknisi)');
    }
} catch (eTechMig) {
    console.error('[Database] Migration technicians error:', eTechMig.message);
}

// Tabel tiket gangguan pelanggan
db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_number TEXT UNIQUE NOT NULL,
        customer_id INTEGER REFERENCES customers(id),
        customer_name TEXT NOT NULL,
        customer_phone TEXT,
        customer_address TEXT,
        category TEXT DEFAULT 'Koneksi Terputus (LOS)',
        priority TEXT DEFAULT 'medium', -- 'low', 'medium', 'high', 'critical'
        subject TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'open', -- 'open', 'accepted', 'in_progress', 'resolved'
        technician_id INTEGER REFERENCES technicians(id),
        technician_name TEXT,
        technician_phone TEXT,
        resolution_notes TEXT,
        wa_tech_sent INTEGER DEFAULT 0,
        wa_accepted_sent INTEGER DEFAULT 0,
        wa_progress_sent INTEGER DEFAULT 0,
        wa_resolved_sent INTEGER DEFAULT 0,
        accepted_at DATETIME,
        in_progress_at DATETIME,
        resolved_at DATETIME,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Tabel riwayat progress & log tiket gangguan
db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        status TEXT NOT NULL, -- 'open', 'accepted', 'in_progress', 'resolved', 'note'
        title TEXT NOT NULL,
        description TEXT,
        actor_name TEXT,
        wa_sent INTEGER DEFAULT 0,
        wa_target TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Tabel arsip foto lampiran tiket gangguan
db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        log_id INTEGER REFERENCES ticket_logs(id) ON DELETE SET NULL,
        stage TEXT DEFAULT 'report', -- 'report', 'accepted', 'in_progress', 'resolved'
        file_path TEXT NOT NULL,
        file_name TEXT,
        caption TEXT,
        uploaded_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Tabel pesan chat / catatan komunikasi antara Pelanggan dan Teknisi pada Tiket Gangguan
db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        sender_role TEXT NOT NULL, -- 'customer', 'technician', 'admin'
        sender_name TEXT NOT NULL,
        message TEXT,
        photo_path TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// ============================================
// Tabel Tiket PSB (Pemasangan Baru)
// ============================================
db.exec(`
    CREATE TABLE IF NOT EXISTS psb_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        psb_number TEXT UNIQUE NOT NULL,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        customer_address TEXT,
        latitude REAL,
        longitude REAL,
        package_id INTEGER REFERENCES packages(id),
        package_name TEXT,
        connection_type TEXT DEFAULT 'pppoe',
        pppoe_username TEXT,
        pppoe_password TEXT,
        ip_address TEXT,
        onu_serial TEXT,
        odp_info TEXT,
        installation_fee REAL DEFAULT 0,
        scheduled_date DATE,
        notes TEXT,
        status TEXT DEFAULT 'open', -- 'open', 'accepted', 'in_progress', 'completed'
        technician_id INTEGER REFERENCES technicians(id),
        technician_name TEXT,
        technician_phone TEXT,
        admin_phone TEXT,
        customer_db_id INTEGER REFERENCES customers(id),
        accepted_at DATETIME,
        in_progress_at DATETIME,
        completed_at DATETIME,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS psb_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        psb_id INTEGER NOT NULL REFERENCES psb_tickets(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        actor_name TEXT,
        wa_customer_sent INTEGER DEFAULT 0,
        wa_admin_sent INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS psb_photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        psb_id INTEGER NOT NULL REFERENCES psb_tickets(id) ON DELETE CASCADE,
        log_id INTEGER REFERENCES psb_logs(id) ON DELETE SET NULL,
        stage TEXT DEFAULT 'initial', -- 'initial', 'accepted', 'in_progress', 'completed'
        file_path TEXT NOT NULL,
        file_name TEXT,
        caption TEXT,
        uploaded_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// ============================================
// Data Default
// ============================================

// Buat user admin default (username: admin, password: admin123)
const adminPassword = bcrypt.hashSync('admin123', 10);
const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (username, password, name, role)
    VALUES (?, ?, ?, ?)
`);
insertUser.run('admin', adminPassword, 'Administrator', 'admin');

// Pengaturan default
const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value)
    VALUES (?, ?)
`);

const defaultSettings = [
    ['web_port', '3000'],
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
    ['auto_reset_additional_bill', 'true'],
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
    ['payment_qris_image', ''],
    ['ticket_wa_tech_template', '🚨 *LAPORAN TIKET GANGGUAN BARU*\n\nHalo Tim Teknisi ({technician_name}), terdapat laporan gangguan baru dari pelanggan:\n\n*No. Tiket:* {ticket_number}\n*Pelanggan:* {customer_name} ({customer_id})\n*No. HP:* {customer_phone}\n*Alamat:* {customer_address}\n*Lokasi Maps:* {maps_link}\n*Kategori:* {category}\n*Prioritas:* {priority}\n*Keluhan:* {description}\n*Waktu Lapor:* {created_at}\n\nMohon segera dicek dan ditindaklanjuti.\n_{company_name}_'],
    ['ticket_wa_accepted_template', 'Yth. *{customer_name}*,\n\nLaporan gangguan layanan internet Anda telah *DITERIMA* oleh tim teknisi kami dan sedang dijadwalkan untuk penanganan:\n\n*No. Tiket:* {ticket_number}\n*Kategori:* {category}\n*Status:* DITERIMA TEKNISI 📋\n*Teknisi Bertugas:* {technician_name}\n*Kontak Teknisi:* {technician_phone}\n*Keterangan:* {note}\n\nKami akan menginformasikan kembali saat teknisi mulai melakukan pengerjaan. Mohon maaf atas ketidaknyamanannya.\n\nSalam,\n*{company_name}*'],
    ['ticket_wa_progress_template', 'Yth. *{customer_name}*,\n\nBerikut adalah informasi *PROGRESS PENGERJAAN* tiket gangguan internet Anda:\n\n*No. Tiket:* {ticket_number}\n*Status:* SEDANG DITANGANI ⚙️\n*Teknisi:* {technician_name}\n*Update Progress:*\n{note}\n*Waktu Update:* {updated_at}\n\nTim kami sedang mengupayakan perbaikan secepat mungkin. Terima kasih atas kesabaran Anda.\n\nSalam,\n*{company_name}*'],
    ['admin_otp_phone', '082240087489'],
    ['welcome_wa_enabled', 'true'],
    ['welcome_message_template', 'Yth. {customer_name},\n\nSelamat bergabung bersama {company_name}! 🎉\nLayanan internet Anda telah aktif dengan rincian sebagai berikut:\n\n*ID Pelanggan:* {customer_id}\n*Nama:* {customer_name}\n*Paket Internet:* {package_name} ({package_speed})\n*Biaya Langganan:* Rp {package_price}/bulan\n*Jatuh Tempo Pembayaran:* {due_date}\n\n*Informasi Akun:* \nUsername: {pppoe_username}\nPassword: {pppoe_password}\n\nSimpan pesan ini dan nomor ID Pelanggan Anda untuk mempermudah pengecekan tagihan serta layanan bantuan.\n\nBantuan Layanan Pelanggan: {company_phone}\n\nTerima kasih telah mempercayakan kebutuhan internet Anda kepada {company_name}!'],
    ['ticket_wa_resolved_template', 'Yth. *{customer_name}*,\n\nKabar baik! Penanganan tiket gangguan internet Anda telah *SELESAI* ✅\n\n*No. Tiket:* {ticket_number}\n*Status:* SELESAI / NORMAL KEMBALI\n*Teknisi:* {technician_name}\n*Tindakan / Solusi:*\n{note}\n*Waktu Selesai:* {resolved_at}\n\nSilakan periksa kembali koneksi internet Anda. Apabila masih terdapat kendala, jangan ragu untuk menghubungi kami kembali.\n\nTerima kasih atas kepercayaan Anda menggunakan layanan *{company_name}*.']
];

// Masukkan semua pengaturan default dalam satu transaksi
const insertDefaults = db.transaction(() => {
    for (const [key, value] of defaultSettings) {
        insertSetting.run(key, value);
    }
});
insertDefaults();

try {
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('web_port', '3000')").run();
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('welcome_wa_enabled', 'true')").run();
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('welcome_message_template', 'Yth. {customer_name},\\n\\nSelamat bergabung bersama {company_name}! 🎉\\nLayanan internet Anda telah aktif dengan rincian sebagai berikut:\\n\\n*ID Pelanggan:* {customer_id}\\n*Nama:* {customer_name}\\n*Paket Internet:* {package_name} ({package_speed})\\n*Biaya Langganan:* Rp {package_price}/bulan\\n*Jatuh Tempo Pembayaran:* {due_date}\\n\\n*Informasi Akun:* \\nUsername: {pppoe_username}\\nPassword: {pppoe_password}\\n\\nSimpan pesan ini dan nomor ID Pelanggan Anda untuk mempermudah pengecekan tagihan serta layanan bantuan.\\n\\nBantuan Layanan Pelanggan: {company_phone}\\n\\nTerima kasih telah mempercayakan kebutuhan internet Anda kepada {company_name}!')").run();
} catch (e) {}

console.log('[Database] Inisialisasi database berhasil');

module.exports = db;
