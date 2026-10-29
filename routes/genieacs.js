const express = require('express');
const router = express.Router();
const db = require('../database/init');
const { isAuthenticated } = require('../middleware/auth');
const genieacsService = require('../services/genieacs');

router.use(isAuthenticated);

/**
 * Konfigurasi URL GenieACS dari database settings
 */
function configureGenieACS() {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get('genieacs_url');
    const url = row?.value || 'http://localhost:7557';
    genieacsService.configure(url);
    return url;
}

/**
 * Helper: Ambil data pelanggan dari database dan petakan berdasarkan serial atau PPPoE username
 */
function getCustomersMapping() {
    const customers = db.prepare(`
        SELECT c.id, c.customer_id, c.name, c.phone, c.address, c.onu_serial, c.pppoe_username, c.status,
               p.name as package_name, p.speed_down, p.speed_up
        FROM customers c
        LEFT JOIN packages p ON c.package_id = p.id
    `).all();

    const bySerial = {};
    const byPppoe = {};

    customers.forEach(cust => {
        if (cust.onu_serial) {
            bySerial[cust.onu_serial.trim().toUpperCase()] = cust;
        }
        if (cust.pppoe_username) {
            byPppoe[cust.pppoe_username.trim().toLowerCase()] = cust;
        }
    });

    return { customers, bySerial, byPppoe };
}

// =========================================================================
// 1. GET / - Daftar Perangkat GenieACS
// =========================================================================
router.get('/', async (req, res) => {
    let devices = [];
    let error = null;
    let customers = [];

    try {
        configureGenieACS();
        const { customers: custList, bySerial, byPppoe } = getCustomersMapping();
        customers = custList;

        devices = await genieacsService.getDevices();

        // Tautkan info pelanggan jika ada kecocokan serial atau username PPPoE
        devices.forEach(dev => {
            const snKey = (dev.serial || '').trim().toUpperCase();
            const pppKey = (dev.wan?.username || '').trim().toLowerCase();

            dev.customer = (snKey && bySerial[snKey]) || (pppKey && byPppoe[pppKey]) || null;
        });
    } catch (err) {
        console.error('[GenieACS] Error fetching devices:', err.message);
        error = `Gagal terhubung ke GenieACS (${err.message}). Pastikan GenieACS berjalan dan URL di Pengaturan sudah benar.`;
    }

    // Statistik Ringkasan
    const stats = {
        total: devices.length,
        online: devices.filter(d => d.isOnline).length,
        linked: devices.filter(d => d.customer).length,
        criticalOptical: devices.filter(d => d.optical?.opticalStatus === 'critical').length
    };

    res.render('genieacs', {
        title: 'GenieACS - Manajemen CPE & Remote ONT',
        activePage: 'genieacs',
        devices,
        stats,
        customers,
        error
    });
});

// =========================================================================
// 2. GET /device/:id & /devices/:id - Remote Control & Detail ONT
// =========================================================================
const renderDeviceDetail = async (req, res) => {
    const rawId = req.params.id;
    try {
        configureGenieACS();
        const deviceData = await genieacsService.getDevice(rawId);
        const { customers, bySerial, byPppoe } = getCustomersMapping();

        const parsed = deviceData.parsed;
        const snKey = (parsed.serial || '').trim().toUpperCase();
        const pppKey = (parsed.wan?.username || '').trim().toLowerCase();

        const linkedCustomer = (snKey && bySerial[snKey]) || (pppKey && byPppoe[pppKey]) || null;

        res.render('genieacs-device', {
            title: `Remote ONT - ${parsed.serial || parsed.id}`,
            activePage: 'genieacs',
            device: parsed,
            rawDevice: deviceData.raw,
            linkedCustomer,
            customers,
            deviceId: rawId
        });
    } catch (error) {
        console.error('[GenieACS] Error fetching device details:', error.message);
        req.flash('error', `Gagal membuka remote perangkat: ${error.message}`);
        res.redirect('/genieacs');
    }
};

router.get('/device/:id', renderDeviceDetail);
router.get('/devices/:id', renderDeviceDetail);

// =========================================================================
// 3. POST /devices/:id/wifi - Remote Ganti Nama WiFi (SSID) & Password
// =========================================================================
const handleWifiUpdate = async (req, res) => {
    const rawId = req.params.id;
    const { ssid, password, enable, channel } = req.body;
    const backUrl = req.headers.referer || `/genieacs/devices/${encodeURIComponent(rawId)}`;

    try {
        configureGenieACS();
        const result = await genieacsService.setWifi(rawId, { ssid, password, enable, channel });

        // Catat ke log aktivitas
        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('genieacs_wifi', ?, ?, datetime('now'))
            `).run(
                `Ubah WiFi ONT ${rawId}: SSID="${ssid || 'tetap'}"${password ? ', Password diperbarui' : ''}`,
                req.user?.id || null
            );
        } catch (e) {}

        const msg = result.immediate
            ? `Perubahan WiFi (SSID: "${ssid || 'tetap'}") berhasil diterapkan langsung ke ONT.`
            : `Perubahan WiFi berhasil diantrekan ke GenieACS dan akan diterapkan otomatis saat ONT tersambung.`;

        req.flash('success', msg);
    } catch (error) {
        console.error('[GenieACS] Ganti WiFi error:', error.message);
        req.flash('error', `Gagal mengubah pengaturan WiFi: ${error.message}`);
    }

    res.redirect(backUrl);
};

router.post('/devices/:id/wifi', handleWifiUpdate);
router.post('/wifi/:id', handleWifiUpdate);

// =========================================================================
// 4. POST /devices/:id/wifi-toggle - On / Off WiFi
// =========================================================================
const handleWifiToggle = async (req, res) => {
    const rawId = req.params.id;
    const enable = req.body.enable === 'true' || req.body.enable === true || req.body.enable === '1';
    const backUrl = req.headers.referer || `/genieacs/devices/${encodeURIComponent(rawId)}`;

    try {
        configureGenieACS();
        await genieacsService.setWifiEnable(rawId, enable);
        req.flash('success', `Perintah ${enable ? 'mengaktifkan' : 'menonaktifkan'} radio WiFi berhasil dikirim ke ONT.`);
    } catch (error) {
        console.error('[GenieACS] WiFi toggle error:', error.message);
        req.flash('error', `Gagal mengubah status WiFi: ${error.message}`);
    }

    res.redirect(backUrl);
};

router.post('/devices/:id/wifi-toggle', handleWifiToggle);
router.post('/wifi-toggle/:id', handleWifiToggle);

// =========================================================================
// 5. POST /devices/:id/reboot - Remote Reboot ONT
// =========================================================================
const handleReboot = async (req, res) => {
    const rawId = req.params.id;
    const backUrl = req.headers.referer || '/genieacs';

    try {
        configureGenieACS();
        const result = await genieacsService.rebootDevice(rawId);

        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('genieacs_reboot', ?, ?, datetime('now'))
            `).run(`Reboot ONT ${rawId}`, req.user?.id || null);
        } catch (e) {}

        const msg = result.immediate
            ? 'Perintah reboot berhasil diterima ONT. Perangkat sedang memulai ulang...'
            : 'Perintah reboot telah dimasukkan ke antrean tugas GenieACS.';

        req.flash('success', msg);
    } catch (error) {
        console.error('[GenieACS] Reboot error:', error.message);
        req.flash('error', `Gagal mengirim perintah reboot: ${error.message}`);
    }

    res.redirect(backUrl);
};

router.post('/devices/:id/reboot', handleReboot);
router.post('/reboot/:id', handleReboot);

// =========================================================================
// 6. POST /devices/:id/factory-reset - Reset Pabrik ONT
// =========================================================================
const handleFactoryReset = async (req, res) => {
    const rawId = req.params.id;
    const backUrl = req.headers.referer || `/genieacs/devices/${encodeURIComponent(rawId)}`;

    try {
        configureGenieACS();
        await genieacsService.factoryResetDevice(rawId);

        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('genieacs_factory_reset', ?, ?, datetime('now'))
            `).run(`Factory reset ONT ${rawId}`, req.user?.id || null);
        } catch (e) {}

        req.flash('warning', 'Perintah Reset Pabrik (Factory Reset) berhasil dikirim. Seluruh pengaturan ONT akan kembali ke bawaan pabrik.');
    } catch (error) {
        console.error('[GenieACS] Factory reset error:', error.message);
        req.flash('error', `Gagal mengirim perintah reset pabrik: ${error.message}`);
    }

    res.redirect(backUrl);
};

router.post('/devices/:id/factory-reset', handleFactoryReset);
router.post('/factory-reset/:id', handleFactoryReset);

// =========================================================================
// 7. POST /devices/:id/refresh - Tarik Parameter Terbaru (GetParameterValues)
// =========================================================================
const handleRefresh = async (req, res) => {
    const rawId = req.params.id;
    const backUrl = req.headers.referer || '/genieacs';

    try {
        configureGenieACS();
        await genieacsService.refreshDevice(rawId);
        req.flash('success', 'Perintah sinkronisasi parameter berhasil dikirim ke ONT.');
    } catch (error) {
        console.error('[GenieACS] Refresh error:', error.message);
        req.flash('error', `Gagal mengirim perintah refresh: ${error.message}`);
    }

    res.redirect(backUrl);
};

router.post('/devices/:id/refresh', handleRefresh);
router.post('/refresh/:id', handleRefresh);

// =========================================================================
// 8. POST /devices/:id/wan - Ubah Akun PPPoE pada WAN ONT
// =========================================================================
const handleWanUpdate = async (req, res) => {
    const rawId = req.params.id;
    const { username, password } = req.body;
    const backUrl = req.headers.referer || `/genieacs/devices/${encodeURIComponent(rawId)}`;

    try {
        configureGenieACS();
        await genieacsService.setWanPppoe(rawId, { username, password });

        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('genieacs_wan', ?, ?, datetime('now'))
            `).run(`Ubah PPPoE ONT ${rawId}: User="${username}"`, req.user?.id || null);
        } catch (e) {}

        req.flash('success', `Pengaturan PPPoE ONT berhasil diperbarui (Username: ${username}).`);
    } catch (error) {
        console.error('[GenieACS] WAN update error:', error.message);
        req.flash('error', `Gagal mengubah pengaturan WAN PPPoE: ${error.message}`);
    }

    res.redirect(backUrl);
};

router.post('/devices/:id/wan', handleWanUpdate);
router.post('/wan/:id', handleWanUpdate);

// =========================================================================
// 9. POST /devices/:id/ping - Diagnostik Ping dari ONT
// =========================================================================
const handlePing = async (req, res) => {
    const rawId = req.params.id;
    const host = req.body.host || '8.8.8.8';
    const backUrl = req.headers.referer || `/genieacs/devices/${encodeURIComponent(rawId)}`;

    try {
        configureGenieACS();
        await genieacsService.runPingDiagnostics(rawId, host);
        req.flash('success', `Perintah diagnostik ping ke ${host} berhasil dikirim ke ONT.`);
    } catch (error) {
        console.error('[GenieACS] Ping error:', error.message);
        req.flash('error', `Gagal menjalankan diagnostik ping: ${error.message}`);
    }

    res.redirect(backUrl);
};

router.post('/devices/:id/ping', handlePing);
router.post('/ping/:id', handlePing);

// =========================================================================
// 10. POST /devices/:id/link-customer - Tautkan Serial ONT ke Pelanggan
// =========================================================================
const handleLinkCustomer = (req, res) => {
    const rawId = req.params.id;
    const { customer_id, serial } = req.body;
    const backUrl = req.headers.referer || `/genieacs/devices/${encodeURIComponent(rawId)}`;

    try {
        if (!customer_id) {
            throw new Error('Pilih pelanggan yang ingin ditautkan');
        }
        if (!serial) {
            throw new Error('Serial number ONT tidak valid');
        }

        db.prepare('UPDATE customers SET onu_serial = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(serial.trim(), customer_id);

        const cust = db.prepare('SELECT name FROM customers WHERE id = ?').get(customer_id);

        req.flash('success', `ONT dengan serial ${serial} berhasil ditautkan ke pelanggan "${cust?.name || customer_id}".`);
    } catch (error) {
        console.error('[GenieACS] Link customer error:', error.message);
        req.flash('error', `Gagal menautkan perangkat: ${error.message}`);
    }

    res.redirect(backUrl);
};

router.post('/devices/:id/link-customer', handleLinkCustomer);
router.post('/link-customer/:id', handleLinkCustomer);

// =========================================================================
// 11. POST /devices/:id/unlink-customer - Lepas Tautan Pelanggan
// =========================================================================
const handleUnlinkCustomer = (req, res) => {
    const rawId = req.params.id;
    const { customer_id } = req.body;
    const backUrl = req.headers.referer || `/genieacs/devices/${encodeURIComponent(rawId)}`;

    try {
        if (!customer_id) {
            throw new Error('Data pelanggan tidak valid');
        }

        db.prepare('UPDATE customers SET onu_serial = NULL, updated_at = datetime(\'now\') WHERE id = ?')
            .run(customer_id);

        req.flash('success', 'Tautan ONT dengan data pelanggan berhasil dilepas.');
    } catch (error) {
        console.error('[GenieACS] Unlink customer error:', error.message);
        req.flash('error', `Gagal melepas tautan: ${error.message}`);
    }

    res.redirect(backUrl);
};

router.post('/devices/:id/unlink-customer', handleUnlinkCustomer);
router.post('/unlink-customer/:id', handleUnlinkCustomer);

// =========================================================================
// 12. POST /devices/:id/delete - Hapus Perangkat dari GenieACS
// =========================================================================
const handleDelete = async (req, res) => {
    const rawId = req.params.id;

    try {
        configureGenieACS();
        await genieacsService.deleteDevice(rawId);

        try {
            db.prepare(`
                INSERT INTO activity_log (action, description, user_id, created_at)
                VALUES ('genieacs_delete', ?, ?, datetime('now'))
            `).run(`Hapus ONT ${rawId} dari GenieACS`, req.user?.id || null);
        } catch (e) {}

        req.flash('success', 'Perangkat berhasil dihapus dari GenieACS.');
    } catch (error) {
        console.error('[GenieACS] Delete error:', error.message);
        req.flash('error', `Gagal menghapus perangkat: ${error.message}`);
    }

    res.redirect('/genieacs');
};

router.post('/devices/:id/delete', handleDelete);
router.post('/delete/:id', handleDelete);

module.exports = router;
