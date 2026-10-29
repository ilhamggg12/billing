const express = require('express');
const router = express.Router();
const db = require('../database/init');
const { isAuthenticated } = require('../middleware/auth');
const whatsappService = require('../services/whatsapp');
const moment = require('moment');

const path = require('path');

// GET /system/status - Return live monitoring status of Scheduler, WhatsApp, MikroTik, GenieACS
router.get('/system/status', async (req, res) => {
    try {
        const schedulerService = require('../services/scheduler');
        const mikrotikService = require('../services/mikrotik');
        const genieacsService = require('../services/genieacs');
        const axios = require('axios');

        // 1. Cron / Scheduler
        const schedulerActive = schedulerService.isRunning();

        // 2. WhatsApp
        const waStatus = whatsappService.getStatus();
        const whatsappConnected = waStatus === 'connected';

        // 3. MikroTik (Cek keterjangkauan socket TCP tanpa login credential agar 0% log spam di RouterOS)
        let mikrotikConnected = mikrotikService.isConnected();
        if (!mikrotikConnected) {
            mikrotikConnected = await mikrotikService.testReachability();
        }

        // 4. GenieACS
        let genieacsConnected = false;
        try {
            const row = db.prepare("SELECT value FROM settings WHERE key = ?").get('genieacs_url');
            const gUrl = (row?.value || 'http://localhost:7557').replace(/\/$/, '');
            await axios.get(`${gUrl}/devices?projection=_id`, { timeout: 3000 });
            genieacsConnected = true;
        } catch (eG) {
            genieacsConnected = false;
        }

        res.json({
            scheduler: {
                active: schedulerActive,
                statusText: schedulerActive ? 'Aktif' : 'Nonaktif'
            },
            whatsapp: {
                connected: whatsappConnected,
                status: waStatus,
                statusText: whatsappConnected ? 'Terhubung' : (waStatus === 'connecting' ? 'Menghubungkan' : 'Terputus')
            },
            mikrotik: {
                connected: mikrotikConnected,
                statusText: mikrotikConnected ? 'Terhubung' : 'Terputus'
            },
            genieacs: {
                connected: genieacsConnected,
                statusText: genieacsConnected ? 'Terhubung' : 'Terputus'
            }
        });
    } catch (err) {
        console.error('Error fetching system status:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /whatsapp/status - Return WhatsApp connection status (public read for polling)
router.get('/whatsapp/status', (req, res) => {
    try {
        const status = whatsappService.getStatus();
        const qr = whatsappService.getQR();
        const error = whatsappService.getError();
        const authenticated = whatsappService.authenticated || false;
        const syncProgress = whatsappService.syncProgress || null;
        res.json({ status, qr, error, authenticated, syncProgress });
    } catch (error) {
        console.error('Error getting WhatsApp status:', error.message);
        res.json({ status: 'disconnected', qr: null, error: error.message });
    }
});

// GET /whatsapp/debug - Return detailed diagnostics and screenshot
router.get('/whatsapp/debug', async (req, res) => {
    try {
        let debugInfo = {
            status: whatsappService.getStatus(),
            authenticated: whatsappService.authenticated || false,
            isInitializing: whatsappService.isInitializing,
            hasClient: !!whatsappService.client,
            hasPupPage: !!(whatsappService.client && whatsappService.client.pupPage)
        };
        if (whatsappService.client && whatsappService.client.pupPage) {
            try {
                debugInfo.title = await whatsappService.client.pupPage.title();
                debugInfo.url = whatsappService.client.pupPage.url();
                const screenshotPath = path.join(__dirname, '../public/wa-debug.png');
                await whatsappService.client.pupPage.screenshot({ path: screenshotPath });
                debugInfo.screenshot = '/wa-debug.png';
            } catch (err) {
                debugInfo.pupError = err.message;
            }
        }
        res.json(debugInfo);
    } catch (e) {
        res.json({ error: e.message });
    }
});

router.use(isAuthenticated);

// GET /whatsapp/qr - Return WhatsApp QR code
router.get('/whatsapp/qr', (req, res) => {
    try {
        const qr = whatsappService.getQR();
        res.json({ qr: qr || null });
    } catch (error) {
        console.error('Error getting WhatsApp QR:', error.message);
        res.json({ qr: null });
    }
});

// POST /whatsapp/initialize - Trigger WhatsApp initialization via API
router.post('/whatsapp/initialize', (req, res) => {
    try {
        whatsappService.initialize().catch(err => {
            console.error('[WhatsApp API] Initialization error:', err.message);
        });
        res.json({ success: true, message: 'Inisialisasi WhatsApp dimulai...' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /whatsapp/disconnect - Disconnect WhatsApp via API
router.post('/whatsapp/disconnect', async (req, res) => {
    try {
        await whatsappService.disconnect();
        res.json({ success: true, message: 'WhatsApp diputus' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /dashboard/stats - Return dashboard statistics
router.get('/dashboard/stats', (req, res) => {
    try {
        // Total customers
        const totalCustomers = db.prepare('SELECT COUNT(*) as count FROM customers').get().count;
        const activeCustomers = db.prepare("SELECT COUNT(*) as count FROM customers WHERE status = 'active'").get().count;
        const inactiveCustomers = db.prepare("SELECT COUNT(*) as count FROM customers WHERE status != 'active'").get().count;

        // Current period
        const currentPeriod = moment().format('YYYY-MM');

        // Invoice stats for current period
        const totalInvoices = db.prepare('SELECT COUNT(*) as count FROM invoices WHERE period = ?').get(currentPeriod).count;
        const paidInvoices = db.prepare("SELECT COUNT(*) as count FROM invoices WHERE period = ? AND status = 'paid'").get(currentPeriod).count;
        const unpaidInvoices = db.prepare("SELECT COUNT(*) as count FROM invoices WHERE period = ? AND status = 'unpaid'").get(currentPeriod).count;

        // Revenue for current period
        const revenueResult = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM invoices WHERE period = ? AND status = 'paid'").get(currentPeriod);
        const revenue = revenueResult.total;

        // Outstanding for current period
        const outstandingResult = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM invoices WHERE period = ? AND status = 'unpaid'").get(currentPeriod);
        const outstanding = outstandingResult.total;

        // Total revenue all time
        const totalRevenueResult = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM invoices WHERE status = 'paid'").get();
        const totalRevenue = totalRevenueResult.total;

        // Packages count
        const totalPackages = db.prepare('SELECT COUNT(*) as count FROM packages WHERE is_active = 1').get().count;

        // Recent activity
        const recentActivity = db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 10').all();

        // Monthly revenue for chart (last 6 months)
        const monthlyRevenue = [];
        for (let i = 5; i >= 0; i--) {
            const month = moment().subtract(i, 'months').format('YYYY-MM');
            const monthRevenue = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM invoices WHERE period = ? AND status = 'paid'").get(month);
            monthlyRevenue.push({
                period: month,
                label: moment(month, 'YYYY-MM').format('MMM YYYY'),
                total: monthRevenue.total
            });
        }

        res.json({
            totalCustomers,
            activeCustomers,
            inactiveCustomers,
            currentPeriod,
            totalInvoices,
            paidInvoices,
            unpaidInvoices,
            revenue,
            outstanding,
            totalRevenue,
            totalPackages,
            recentActivity,
            monthlyRevenue
        });
    } catch (error) {
        console.error('Error fetching dashboard stats:', error.message);
        res.status(500).json({ error: 'Gagal memuat statistik dashboard' });
    }
});

// ============================================
// Network Infrastructure & Customer Map APIs
// ============================================

// GET /customers/locations - Return all customer GPS locations
router.get('/customers/locations', (req, res) => {
    try {
        const customers = db.prepare(`
            SELECT c.id, c.customer_id, c.name, c.address, c.phone, c.latitude, c.longitude, c.status,
                   c.connection_type, c.ip_address, c.pppoe_username,
                   p.name as package_name
            FROM customers c
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE c.latitude IS NOT NULL AND c.longitude IS NOT NULL
        `).all();

        res.json({ success: true, data: customers });
    } catch (error) {
        console.error('Error fetching customer locations:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /network/data - Return all network nodes, cables, and customers
router.get('/network/data', (req, res) => {
    try {
        const nodes = db.prepare(`
            SELECT n.*, c.name as customer_name, c.phone as customer_phone
            FROM network_nodes n
            LEFT JOIN customers c ON n.customer_id = c.id
            ORDER BY n.id ASC
        `).all();

        const cables = db.prepare(`
            SELECT * FROM network_cables ORDER BY id ASC
        `).all();

        const customers = db.prepare(`
            SELECT c.id, c.customer_id, c.name, c.address, c.phone, c.latitude, c.longitude, c.status,
                   c.connection_type, c.ip_address, c.pppoe_username,
                   p.name as package_name
            FROM customers c
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE c.latitude IS NOT NULL AND c.longitude IS NOT NULL
        `).all();

        res.json({
            success: true,
            nodes,
            cables,
            customers
        });
    } catch (error) {
        console.error('Error fetching network data:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /network/nodes - Create network node (ODP, ODC, OLT, Switch, ONT)
router.post('/network/nodes', (req, res) => {
    try {
        const { name, type, latitude, longitude, capacity, used_capacity, address, notes, customer_id } = req.body;
        if (!name || !type || !latitude || !longitude) {
            return res.status(400).json({ success: false, message: 'Nama, tipe, dan koordinat wajib diisi' });
        }

        const stmt = db.prepare(`
            INSERT INTO network_nodes (name, type, latitude, longitude, capacity, used_capacity, address, notes, customer_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `);
        const result = stmt.run(
            name.trim(),
            type.trim(),
            parseFloat(latitude),
            parseFloat(longitude),
            parseInt(capacity, 10) || 8,
            parseInt(used_capacity, 10) || 0,
            address ? address.trim() : null,
            notes ? notes.trim() : null,
            customer_id ? parseInt(customer_id, 10) : null
        );

        res.json({ success: true, id: result.lastInsertRowid, message: 'Perangkat berhasil ditambahkan' });
    } catch (error) {
        console.error('Error adding network node:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT & POST /network/nodes/:id - Update network node
const handleUpdateNode = (req, res) => {
    try {
        const { name, type, latitude, longitude, capacity, used_capacity, address, notes } = req.body;
        db.prepare(`
            UPDATE network_nodes SET
                name = COALESCE(?, name),
                type = COALESCE(?, type),
                latitude = COALESCE(?, latitude),
                longitude = COALESCE(?, longitude),
                capacity = COALESCE(?, capacity),
                used_capacity = COALESCE(?, used_capacity),
                address = COALESCE(?, address),
                notes = COALESCE(?, notes),
                updated_at = datetime('now')
            WHERE id = ?
        `).run(
            name ? name.trim() : null,
            type ? type.trim() : null,
            latitude !== undefined && latitude !== null && latitude !== '' ? parseFloat(latitude) : null,
            longitude !== undefined && longitude !== null && longitude !== '' ? parseFloat(longitude) : null,
            capacity !== undefined && capacity !== '' ? parseInt(capacity, 10) : null,
            used_capacity !== undefined && used_capacity !== '' ? parseInt(used_capacity, 10) : null,
            address !== undefined ? address : null,
            notes !== undefined ? notes : null,
            req.params.id
        );

        res.json({ success: true, message: 'Data perangkat berhasil diperbarui' });
    } catch (error) {
        console.error('Error updating network node:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
};

router.put('/network/nodes/:id', handleUpdateNode);
router.post('/network/nodes/:id', handleUpdateNode);

// POST /network/nodes/:id/move - Update node coordinates
router.post('/network/nodes/:id/move', (req, res) => {
    try {
        const { latitude, longitude } = req.body;
        if (latitude === undefined || longitude === undefined) {
            return res.status(400).json({ success: false, message: 'Koordinat latitude dan longitude wajib dikirim' });
        }
        db.prepare('UPDATE network_nodes SET latitude = ?, longitude = ?, updated_at = datetime("now") WHERE id = ?')
          .run(parseFloat(latitude), parseFloat(longitude), req.params.id);
        res.json({ success: true, message: 'Posisi perangkat berhasil dipindahkan' });
    } catch (error) {
        console.error('Error moving node:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /network/nodes/:id/delete - Hapus network node
router.post('/network/nodes/:id/delete', (req, res) => {
    try {
        db.prepare('DELETE FROM network_nodes WHERE id = ?').run(req.params.id);
        res.json({ success: true, message: 'Perangkat berhasil dihapus' });
    } catch (error) {
        console.error('Error deleting network node:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /network/cables - Simpan kabel jaringan
router.post('/network/cables', (req, res) => {
    try {
        const { name, cable_type, core_count, color, coordinates, length_meters, from_node_id, to_node_id, notes } = req.body;
        if (!name || !coordinates) {
            return res.status(400).json({ success: false, message: 'Nama kabel dan jalur koordinat wajib ada' });
        }

        const coordsJson = typeof coordinates === 'string' ? coordinates : JSON.stringify(coordinates);

        const stmt = db.prepare(`
            INSERT INTO network_cables (name, cable_type, core_count, color, coordinates, length_meters, from_node_id, to_node_id, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `);
        const result = stmt.run(
            name.trim(),
            cable_type || 'distribution',
            parseInt(core_count, 10) || 12,
            color || '#3b82f6',
            coordsJson,
            parseFloat(length_meters) || 0,
            from_node_id ? parseInt(from_node_id, 10) : null,
            to_node_id ? parseInt(to_node_id, 10) : null,
            notes ? notes.trim() : null
        );

        res.json({ success: true, id: result.lastInsertRowid, message: 'Kabel jaringan berhasil disimpan' });
    } catch (error) {
        console.error('Error saving cable:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /network/cables/:id/delete - Hapus kabel jaringan
router.post('/network/cables/:id/delete', (req, res) => {
    try {
        db.prepare('DELETE FROM network_cables WHERE id = ?').run(req.params.id);
        res.json({ success: true, message: 'Kabel jaringan berhasil dihapus' });
    } catch (error) {
        console.error('Error deleting cable:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /network/pin-customer - Tandai lokasi rumah pelanggan pada peta
router.post('/network/pin-customer', (req, res) => {
    try {
        const { customer_id, latitude, longitude, address } = req.body;
        if (!customer_id || !latitude || !longitude) {
            return res.status(400).json({ success: false, message: 'Pelanggan dan koordinat wajib ditentukan' });
        }

        const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id);
        if (!cust) {
            return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
        }

        db.prepare(`
            UPDATE customers SET
                latitude = ?,
                longitude = ?,
                address = COALESCE(?, address),
                updated_at = datetime('now')
            WHERE id = ?
        `).run(parseFloat(latitude), parseFloat(longitude), address ? address.trim() : null, customer_id);

        res.json({ success: true, message: `Lokasi rumah pelanggan ${cust.name} berhasil ditandai pada peta` });
    } catch (error) {
        console.error('Error pinning customer:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /network/customers/:id/move - Update customer coordinates when dragged
router.post('/network/customers/:id/move', (req, res) => {
    try {
        const { latitude, longitude } = req.body;
        if (latitude === undefined || longitude === undefined) {
            return res.status(400).json({ success: false, message: 'Koordinat tidak valid' });
        }
        db.prepare('UPDATE customers SET latitude = ?, longitude = ?, updated_at = datetime("now") WHERE id = ?')
          .run(parseFloat(latitude), parseFloat(longitude), req.params.id);
        res.json({ success: true, message: 'Posisi rumah pelanggan berhasil dipindahkan' });
    } catch (error) {
        console.error('Error moving customer pin:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /network/customers/:id/unpin - Hapus pin lokasi rumah pelanggan
router.post('/network/customers/:id/unpin', (req, res) => {
    try {
        db.prepare('UPDATE customers SET latitude = NULL, longitude = NULL, updated_at = datetime("now") WHERE id = ?')
          .run(req.params.id);
        res.json({ success: true, message: 'Pin lokasi rumah pelanggan berhasil dihapus' });
    } catch (error) {
        console.error('Error unpinning customer:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
