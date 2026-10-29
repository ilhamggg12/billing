const express = require('express');
const router = express.Router();
const db = require('../database/init');
const { isAuthenticated } = require('../middleware/auth');
const mikrotikService = require('../services/mikrotik');

router.use(isAuthenticated);

// GET / - Halaman Manajemen MikroTik (Mendukung Multi-MikroTik)
router.get('/', async (req, res) => {
    try {
        const routers = db.prepare('SELECT * FROM routers ORDER BY is_default DESC, id ASC').all();

        // Tentukan router yang sedang dipilih
        const requestedId = req.query.router_id ? parseInt(req.query.router_id, 10) : null;
        let currentRouter = null;

        if (requestedId) {
            currentRouter = routers.find(r => r.id === requestedId);
        }
        if (!currentRouter) {
            currentRouter = routers.find(r => r.is_default === 1 && r.is_active === 1) || routers[0] || null;
        }

        // Hitung jumlah pelanggan per router
        const counts = db.prepare('SELECT router_id, COUNT(*) as count FROM customers GROUP BY router_id').all();
        const customerCountMap = {};
        for (const c of counts) {
            customerCountMap[c.router_id || 0] = c.count;
        }

        let connected = false;
        let secrets = [];
        let activeConnections = [];
        let systemResource = {};
        let profiles = [];
        let addressLists = [];
        let error = null;

        if (currentRouter) {
            // Coba pastikan koneksi ke router terpilih aktif
            if (!mikrotikService.isConnected(currentRouter.id)) {
                try {
                    await mikrotikService.ensureConnection(false, currentRouter.id);
                } catch (e) {
                    console.warn(`[Auto-connect Router #${currentRouter.id}]:`, e.message);
                }
            }

            connected = mikrotikService.isConnected(currentRouter.id);

            if (connected) {
                try {
                    const targetListName = currentRouter.isolir_address_list || 'Expired';
                    const [resSecrets, resActive, resResource, resProfiles, resLists] = await Promise.all([
                        mikrotikService.getPPPoESecrets(currentRouter.id).catch(() => []),
                        mikrotikService.getActiveConnections(currentRouter.id).catch(() => []),
                        mikrotikService.getSystemResource(currentRouter.id).catch(() => ({})),
                        mikrotikService.getProfiles(currentRouter.id).catch(() => []),
                        mikrotikService.getAddressList(targetListName, currentRouter.id).catch(() => [])
                    ]);

                    secrets = resSecrets;
                    activeConnections = resActive;
                    systemResource = resResource;
                    profiles = resProfiles;
                    addressLists = resLists || [];
                } catch (errData) {
                    console.error(`Error loading data for Router #${currentRouter.id}:`, errData.message);
                    error = 'Gagal memuat data dari router: ' + errData.message;
                }
            }
        }

        // Status koneksi live per router di tabel router
        const routerStatusMap = {};
        for (const r of routers) {
            routerStatusMap[r.id] = mikrotikService.isConnected(r.id);
        }

        res.render('mikrotik', {
            title: 'MikroTik',
            activePage: 'mikrotik',
            routers,
            currentRouter,
            connected,
            secrets,
            activeConnections,
            systemResource,
            profiles,
            addressLists,
            customerCountMap,
            routerStatusMap,
            error
        });
    } catch (err) {
        console.error('Error on GET /mikrotik:', err.message);
        req.flash('error', 'Gagal memuat halaman MikroTik: ' + err.message);
        res.render('mikrotik', {
            title: 'MikroTik',
            activePage: 'mikrotik',
            routers: [],
            currentRouter: null,
            connected: false,
            secrets: [],
            activeConnections: [],
            systemResource: {},
            profiles: [],
            addressLists: [],
            customerCountMap: {},
            routerStatusMap: {},
            error: err.message
        });
    }
});

// ============================================
// Manajemen Router (CRUD Multi-MikroTik)
// ============================================

// POST /mikrotik/routers - Tambah Router Baru
router.post('/routers', async (req, res) => {
    try {
        const { name, host, port, username, password, isolir_address_list, description, is_default } = req.body;

        if (!name || !host || !username) {
            req.flash('error', 'Nama Router, IP Host, dan Username API wajib diisi');
            return res.redirect('/mikrotik');
        }

        const effectivePort = parseInt(port, 10) || 8728;
        const effectiveList = isolir_address_list ? isolir_address_list.trim() : 'Expired';
        const makeDefault = is_default === '1' || is_default === 'on' || is_default === true ? 1 : 0;

        // Jika router ini dijadikan default, reset status default router lain
        if (makeDefault === 1) {
            db.prepare('UPDATE routers SET is_default = 0').run();
        }

        const stmt = db.prepare(`
            INSERT INTO routers (name, host, port, username, password, isolir_address_list, description, is_active, is_default, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))
        `);

        const result = stmt.run(
            name.trim(),
            host.trim(),
            effectivePort,
            username.trim(),
            password || '',
            effectiveList,
            description ? description.trim() : null,
            makeDefault
        );

        const newRouterId = result.lastInsertRowid;

        // Coba lakukan uji koneksi pertama kali
        const testRes = await mikrotikService.testRouter({
            host: host.trim(),
            port: effectivePort,
            username: username.trim(),
            password: password || ''
        });

        db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
            .run('router_create', `Router MikroTik baru ditambahkan: ${name.trim()} (${host.trim()}:${effectivePort})`, req.user?.id || null);

        if (testRes.success) {
            req.flash('success', `Router "${name.trim()}" berhasil ditambahkan dan terverifikasi online!`);
        } else {
            req.flash('warning', `Router "${name.trim()}" berhasil disimpan, tetapi belum dapat terhubung: ${testRes.message}`);
        }

        res.redirect(`/mikrotik?router_id=${newRouterId}`);
    } catch (error) {
        console.error('Error creating router:', error.message);
        req.flash('error', 'Gagal menambahkan router: ' + error.message);
        res.redirect('/mikrotik');
    }
});

// POST /mikrotik/routers/:id/edit - Update Router
router.post('/routers/:id/edit', async (req, res) => {
    try {
        const routerId = parseInt(req.params.id, 10);
        const existing = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId);
        if (!existing) {
            req.flash('error', 'Router tidak ditemukan');
            return res.redirect('/mikrotik');
        }

        const { name, host, port, username, password, isolir_address_list, description, is_default, is_active } = req.body;

        if (!name || !host || !username) {
            req.flash('error', 'Nama Router, IP Host, dan Username API wajib diisi');
            return res.redirect(`/mikrotik?router_id=${routerId}`);
        }

        const effectivePort = parseInt(port, 10) || 8728;
        const effectiveList = isolir_address_list ? isolir_address_list.trim() : 'Expired';
        const makeDefault = is_default === '1' || is_default === 'on' || is_default === true ? 1 : 0;
        const activeState = is_active === '0' ? 0 : 1;

        if (makeDefault === 1) {
            db.prepare('UPDATE routers SET is_default = 0 WHERE id != ?').run(routerId);
        }

        // Password: jika kosong, gunakan password lama
        const effectivePass = typeof password !== 'undefined' && password !== '' ? password : existing.password;

        db.prepare(`
            UPDATE routers SET
                name = ?, host = ?, port = ?, username = ?, password = ?,
                isolir_address_list = ?, description = ?, is_active = ?, is_default = ?,
                updated_at = datetime('now')
            WHERE id = ?
        `).run(
            name.trim(),
            host.trim(),
            effectivePort,
            username.trim(),
            effectivePass,
            effectiveList,
            description ? description.trim() : null,
            activeState,
            makeDefault,
            routerId
        );

        // Putus koneksi lama di cache agar terkoneksi ulang dengan data baru
        await mikrotikService.disconnect(routerId);

        db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
            .run('router_update', `Router MikroTik diperbarui: ${name.trim()} (${host.trim()}:${effectivePort})`, req.user?.id || null);

        req.flash('success', `Router "${name.trim()}" berhasil diperbarui`);
        res.redirect(`/mikrotik?router_id=${routerId}`);
    } catch (error) {
        console.error('Error updating router:', error.message);
        req.flash('error', 'Gagal memperbarui router: ' + error.message);
        res.redirect('/mikrotik');
    }
});

// POST /mikrotik/routers/:id/delete - Hapus Router
router.post('/routers/:id/delete', async (req, res) => {
    try {
        const routerId = parseInt(req.params.id, 10);
        const existing = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId);
        if (!existing) {
            req.flash('error', 'Router tidak ditemukan');
            return res.redirect('/mikrotik');
        }

        const totalRouters = db.prepare('SELECT COUNT(*) as count FROM routers').get().count;
        if (totalRouters <= 1) {
            req.flash('error', 'Tidak dapat menghapus router. Minimal harus ada 1 router terdaftar.');
            return res.redirect('/mikrotik');
        }

        // Putus koneksi
        await mikrotikService.disconnect(routerId);

        // Cari router pengganti (default selain yang dihapus)
        const fallbackRouter = db.prepare('SELECT id FROM routers WHERE id != ? ORDER BY is_default DESC, id ASC LIMIT 1').get(routerId);

        if (fallbackRouter) {
            // Alihkan semua pelanggan yang tadinya terhubung ke router ini ke router pengganti
            db.prepare('UPDATE customers SET router_id = ? WHERE router_id = ?').run(fallbackRouter.id, routerId);
            if (existing.is_default === 1) {
                db.prepare('UPDATE routers SET is_default = 1 WHERE id = ?').run(fallbackRouter.id);
            }
        }

        db.prepare('DELETE FROM routers WHERE id = ?').run(routerId);

        db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
            .run('router_delete', `Router MikroTik dihapus: ${existing.name} (${existing.host})`, req.user?.id || null);

        req.flash('success', `Router "${existing.name}" berhasil dihapus.`);
        res.redirect(`/mikrotik?router_id=${fallbackRouter ? fallbackRouter.id : ''}`);
    } catch (error) {
        console.error('Error deleting router:', error.message);
        req.flash('error', 'Gagal menghapus router: ' + error.message);
        res.redirect('/mikrotik');
    }
});

// POST /mikrotik/routers/:id/set-default - Jadikan Router Default
router.post('/routers/:id/set-default', (req, res) => {
    try {
        const routerId = parseInt(req.params.id, 10);
        db.prepare('UPDATE routers SET is_default = 0').run();
        db.prepare('UPDATE routers SET is_default = 1 WHERE id = ?').run(routerId);

        req.flash('success', 'Router utama (default) berhasil diubah');
        res.redirect(`/mikrotik?router_id=${routerId}`);
    } catch (error) {
        console.error('Error setting default router:', error.message);
        req.flash('error', 'Gagal mengubah router default: ' + error.message);
        res.redirect('/mikrotik');
    }
});

// POST /mikrotik/routers/:id/test - Uji Koneksi Router (AJAX / Form)
router.post('/routers/:id/test', async (req, res) => {
    try {
        const routerId = parseInt(req.params.id, 10);
        const r = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId);
        if (!r) {
            return res.status(404).json({ success: false, message: 'Router tidak ditemukan' });
        }

        const result = await mikrotikService.testRouter(r);
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.json(result);
        }

        if (result.success) {
            req.flash('success', result.message);
        } else {
            req.flash('error', `Koneksi gagal: ${result.message}`);
        }
        res.redirect(`/mikrotik?router_id=${routerId}`);
    } catch (err) {
        console.error('Error testing router connection:', err.message);
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(500).json({ success: false, message: err.message });
        }
        req.flash('error', 'Gagal menguji koneksi: ' + err.message);
        res.redirect('/mikrotik');
    }
});

// ============================================
// Koneksi & Kontrol Router Terpilih
// ============================================

// POST /mikrotik/connect - Hubungkan router yang dipilih
router.post('/connect', async (req, res) => {
    try {
        const routerId = req.body.router_id ? parseInt(req.body.router_id, 10) : null;
        const targetRouter = mikrotikService.getRouterConfig(routerId);

        if (!targetRouter) {
            req.flash('error', 'Router tidak ditemukan');
            return res.redirect('/mikrotik');
        }

        await mikrotikService.connect(
            targetRouter.host,
            targetRouter.port,
            targetRouter.username,
            targetRouter.password,
            targetRouter.id
        );

        req.flash('success', `Berhasil terhubung ke ${targetRouter.name} (${targetRouter.host}:${targetRouter.port})`);
        res.redirect(`/mikrotik?router_id=${targetRouter.id}`);
    } catch (error) {
        console.error('Error connecting to MikroTik:', error.message);
        req.flash('error', `Gagal terhubung ke MikroTik: ${error.message}`);
        res.redirect('/mikrotik');
    }
});

// POST /mikrotik/disconnect - Putuskan router yang dipilih
router.post('/disconnect', async (req, res) => {
    try {
        const routerId = req.body.router_id ? parseInt(req.body.router_id, 10) : null;
        await mikrotikService.disconnect(routerId);
        req.flash('success', 'Koneksi MikroTik berhasil diputuskan');
        res.redirect(routerId ? `/mikrotik?router_id=${routerId}` : '/mikrotik');
    } catch (error) {
        console.error('Error disconnecting MikroTik:', error.message);
        req.flash('error', 'Gagal memutus koneksi: ' + error.message);
        res.redirect('/mikrotik');
    }
});

// POST /mikrotik/sync-customer/:id - Buat secret PPPoE di MikroTik pada router pelanggan
router.post('/sync-customer/:id', async (req, res) => {
    try {
        const customer = db.prepare(`
            SELECT c.*, p.name as package_name, p.speed_down, p.speed_up, r.name as router_name
            FROM customers c
            LEFT JOIN packages p ON c.package_id = p.id
            LEFT JOIN routers r ON c.router_id = r.id
            WHERE c.id = ?
        `).get(req.params.id);

        if (!customer) {
            req.flash('error', 'Pelanggan tidak ditemukan');
            return res.redirect('/mikrotik');
        }

        const routerId = customer.router_id || null;

        try {
            await mikrotikService.ensureConnection(true, routerId);
        } catch (eMk) {
            req.flash('error', `MikroTik (${customer.router_name || 'Utama'}) tidak dapat dihubungi: ${eMk.message}`);
            return res.redirect(routerId ? `/mikrotik?router_id=${routerId}` : '/mikrotik');
        }

        if (!customer.pppoe_username || !customer.pppoe_password) {
            req.flash('error', 'Username dan password PPPoE pelanggan belum lengkap');
            return res.redirect(routerId ? `/mikrotik?router_id=${routerId}` : '/mikrotik');
        }

        const profileName = customer.package_name
            ? `${customer.package_name}-${customer.speed_down}M/${customer.speed_up}M`
            : 'default';

        if (customer.package_name) {
            const profiles = await mikrotikService.getProfiles(routerId);
            const existingProfile = profiles.find(p => p.name === profileName);

            if (!existingProfile) {
                const rateLimit = `${customer.speed_up}M/${customer.speed_down}M`;
                await mikrotikService.addProfile(profileName, rateLimit, routerId);
            }
        }

        const existingSecret = await mikrotikService.findSecretByName(customer.pppoe_username, routerId);
        if (existingSecret) {
            req.flash('error', `PPPoE secret "${customer.pppoe_username}" sudah ada di MikroTik`);
            return res.redirect(routerId ? `/mikrotik?router_id=${routerId}` : '/mikrotik');
        }

        await mikrotikService.addPPPoESecret(
            customer.pppoe_username,
            customer.pppoe_password,
            profileName,
            'pppoe',
            routerId
        );

        req.flash('success', `PPPoE secret "${customer.pppoe_username}" berhasil ditambahkan ke ${customer.router_name || 'MikroTik'}`);
        res.redirect(routerId ? `/mikrotik?router_id=${routerId}` : '/mikrotik');
    } catch (error) {
        console.error('Error syncing customer to MikroTik:', error.message);
        req.flash('error', 'Gagal sinkronisasi ke MikroTik: ' + error.message);
        res.redirect('/mikrotik');
    }
});

// POST /mikrotik/disable-customer/:id - Isolir Pelanggan di MikroTik
router.post('/disable-customer/:id', async (req, res) => {
    try {
        const customer = db.prepare(`
            SELECT c.*, r.isolir_address_list as router_list, r.name as router_name
            FROM customers c
            LEFT JOIN routers r ON c.router_id = r.id
            WHERE c.id = ?
        `).get(req.params.id);

        if (!customer) {
            req.flash('error', 'Pelanggan tidak ditemukan');
            return res.redirect('/mikrotik');
        }

        const routerId = customer.router_id || null;
        db.prepare("UPDATE customers SET status = 'suspended', is_auto_isolated = 0, updated_at = datetime('now') WHERE id = ?").run(customer.id);
        customer.status = 'suspended';
        customer.is_auto_isolated = 0;

        const isoRes = await mikrotikService.isolateCustomer(customer, `Isolir: ${customer.name} (${customer.customer_id})`);

        db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
            .run('customer_suspend', `Pelanggan diisolir di ${customer.router_name || 'MikroTik'}: ${customer.name} (${customer.customer_id})`, req.user?.id || null);

        if (isoRes && isoRes.success) {
            req.flash('success', `Pelanggan "${customer.name}" berhasil diisolir pada router "${customer.router_name || 'MikroTik'}" (IP: ${isoRes.ip})`);
        } else {
            req.flash('warning', `Pelanggan disuspend, namun peringatan MikroTik: ${(isoRes && isoRes.message) || 'IP belum terdeteksi'}`);
        }
        res.redirect(routerId ? `/mikrotik?router_id=${routerId}` : '/mikrotik');
    } catch (error) {
        console.error('Error disabling customer:', error.message);
        req.flash('error', 'Gagal mengisolir pelanggan: ' + error.message);
        res.redirect('/mikrotik');
    }
});

// POST /mikrotik/enable-customer/:id - Buka Isolir Pelanggan di MikroTik
router.post('/enable-customer/:id', async (req, res) => {
    try {
        const customer = db.prepare(`
            SELECT c.*, r.isolir_address_list as router_list, r.name as router_name
            FROM customers c
            LEFT JOIN routers r ON c.router_id = r.id
            WHERE c.id = ?
        `).get(req.params.id);

        if (!customer) {
            req.flash('error', 'Pelanggan tidak ditemukan');
            return res.redirect('/mikrotik');
        }

        const routerId = customer.router_id || null;
        db.prepare("UPDATE customers SET status = 'active', is_auto_isolated = 0, updated_at = datetime('now') WHERE id = ?").run(customer.id);
        customer.status = 'active';
        customer.is_auto_isolated = 0;

        await mikrotikService.unIsolateCustomer(customer);

        db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
            .run('customer_activate', `Isolir dibuka di ${customer.router_name || 'MikroTik'}: ${customer.name} (${customer.customer_id})`, req.user?.id || null);

        req.flash('success', `Akses pelanggan "${customer.name}" berhasil diaktifkan kembali`);
        res.redirect(routerId ? `/mikrotik?router_id=${routerId}` : '/mikrotik');
    } catch (error) {
        console.error('Error enabling customer:', error.message);
        req.flash('error', 'Gagal mengaktifkan pelanggan: ' + error.message);
        res.redirect('/mikrotik');
    }
});

// POST /mikrotik/remove-secret/:name - Hapus PPPoE secret pada router terpilih
router.post('/remove-secret/:name', async (req, res) => {
    const routerId = req.body.router_id ? parseInt(req.body.router_id, 10) : null;
    try {
        await mikrotikService.ensureConnection(true, routerId);

        const secret = await mikrotikService.findSecretByName(req.params.name, routerId);
        if (!secret) {
            req.flash('error', `PPPoE secret "${req.params.name}" tidak ditemukan`);
            return res.redirect(routerId ? `/mikrotik?router_id=${routerId}` : '/mikrotik');
        }

        await mikrotikService.removePPPoESecret(secret['.id'], routerId);

        req.flash('success', `PPPoE secret "${req.params.name}" berhasil dihapus`);
        res.redirect(routerId ? `/mikrotik?router_id=${routerId}` : '/mikrotik');
    } catch (error) {
        console.error('Error removing PPPoE secret:', error.message);
        req.flash('error', 'Gagal menghapus PPPoE secret: ' + error.message);
        res.redirect(routerId ? `/mikrotik?router_id=${routerId}` : '/mikrotik');
    }
});

// POST /mikrotik/remove-address-list - Hapus IP dari Address List MikroTik (Buka Isolir Manual)
router.post('/remove-address-list', async (req, res) => {
    const routerId = req.body.router_id ? parseInt(req.body.router_id, 10) : null;
    const address = req.body.address ? String(req.body.address).trim() : null;
    const list = req.body.list ? String(req.body.list).trim() : 'Expired';

    try {
        if (!address) {
            req.flash('error', 'IP Address wajib ditentukan');
            return res.redirect(routerId ? `/mikrotik?router_id=${routerId}` : '/mikrotik');
        }

        await mikrotikService.removeAddressList(address, list, null, routerId);

        // Jika IP terdaftar pada customer di database dan customer berstatus suspended, buka isolir customer juga
        const customer = db.prepare('SELECT id, name FROM customers WHERE ip_address = ? AND status = ?').get(address, 'suspended');
        if (customer) {
            db.prepare("UPDATE customers SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(customer.id);
            db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
                .run('customer_activate', `Isolir dibuka via Address List MikroTik: ${customer.name} (${address})`, req.user?.id || null);
        }

        req.flash('success', `IP ${address} berhasil dihapus dari address-list ${list}`);
        res.redirect(routerId ? `/mikrotik?router_id=${routerId}` : '/mikrotik');
    } catch (error) {
        console.error('Error removing from address list:', error.message);
        req.flash('error', 'Gagal menghapus dari address list: ' + error.message);
        res.redirect(routerId ? `/mikrotik?router_id=${routerId}` : '/mikrotik');
    }
});

module.exports = router;
