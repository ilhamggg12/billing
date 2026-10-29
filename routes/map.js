// Routes Peta Jaringan & Pelanggan (FTTH Infrastructure Map)
const express = require('express');
const router = express.Router();
const db = require('../database/init');
const { isAuthenticated } = require('../middleware/auth');

router.use(isAuthenticated);

// GET /map - Halaman Peta Infrastruktur Jaringan & Pelanggan
router.get('/', (req, res) => {
    try {
        const getSetting = (k, def) => {
            try {
                return db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || def;
            } catch (e) {
                return def;
            }
        };

        const mapCenter = {
            lat: parseFloat(getSetting('map_center_lat', '-7.020892')) || -7.020892,
            lng: parseFloat(getSetting('map_center_lng', '107.72796')) || 107.72796,
            zoom: parseInt(getSetting('map_zoom', '14'), 10) || 14
        };

        // Ambil daftar pelanggan untuk fitur "Tandai Rumah Pelanggan"
        const customers = db.prepare(`
            SELECT c.id, c.customer_id, c.name, c.phone, c.address, c.latitude, c.longitude, c.status,
                   c.connection_type, c.ip_address, c.pppoe_username,
                   p.name as package_name
            FROM customers c
            LEFT JOIN packages p ON c.package_id = p.id
            ORDER BY c.name ASC
        `).all();

        res.render('map', {
            title: 'Peta Jaringan & Pelanggan',
            activePage: 'map',
            mapCenter,
            customers
        });
    } catch (err) {
        console.error('Error rendering map page:', err.message);
        req.flash('error', 'Gagal memuat halaman peta: ' + err.message);
        res.redirect('/dashboard');
    }
});

module.exports = router;
