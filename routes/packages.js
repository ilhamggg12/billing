const express = require('express');
const router = express.Router();
const db = require('../database/init');
const { isAuthenticated } = require('../middleware/auth');

router.use(isAuthenticated);

// GET / - List all packages
router.get('/', (req, res) => {
    try {
        const packages = db.prepare('SELECT * FROM packages ORDER BY price ASC').all();

        // Get customer count per package
        const packageCounts = db.prepare(`
            SELECT package_id, COUNT(*) as customer_count
            FROM customers
            WHERE package_id IS NOT NULL
            GROUP BY package_id
        `).all();

        const countMap = {};
        packageCounts.forEach(pc => {
            countMap[pc.package_id] = pc.customer_count;
        });

        packages.forEach(pkg => {
            pkg.customer_count = countMap[pkg.id] || 0;
        });

        res.render('packages', {
            title: 'Paket Layanan',
            activePage: 'packages',
            packages
        });
    } catch (error) {
        console.error('Error loading packages:', error.message);
        req.flash('error', 'Gagal memuat data paket');
        res.render('packages', {
            title: 'Paket Layanan',
            activePage: 'packages',
            packages: []
        });
    }
});

// POST / - Create new package
router.post('/', (req, res) => {
    try {
        const { name, speed_down, speed_up, price, description, is_bypass, no_wa_billing, is_active } = req.body;

        if (!name || !name.trim()) {
            req.flash('error', 'Nama paket wajib diisi');
            return res.redirect('/packages');
        }

        const isBypassVal = (is_bypass === '1' || is_bypass === 'on') ? 1 : 0;
        const noWaVal = (no_wa_billing === '1' || no_wa_billing === 'on') ? 1 : 0;
        const finalPrice = isBypassVal ? 0 : (parseFloat(price) || 0);

        db.prepare(`
            INSERT INTO packages (name, speed_down, speed_up, price, description, is_bypass, no_wa_billing, is_active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
            name.trim(),
            parseInt(speed_down) || 0,
            parseInt(speed_up) || 0,
            finalPrice,
            description || null,
            isBypassVal,
            noWaVal,
            is_active !== undefined ? (is_active === 'on' || is_active === '1' ? 1 : 0) : 1
        );

        req.flash('success', `Paket ${name.trim()} berhasil ditambahkan`);
        res.redirect('/packages');
    } catch (error) {
        console.error('Error creating package:', error.message);
        req.flash('error', 'Gagal menambahkan paket: ' + error.message);
        res.redirect('/packages');
    }
});

// POST /:id - Update package
router.post('/:id', (req, res) => {
    try {
        const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id);
        if (!pkg) {
            req.flash('error', 'Paket tidak ditemukan');
            return res.redirect('/packages');
        }

        const { name, speed_down, speed_up, price, description, is_bypass, no_wa_billing, is_active } = req.body;

        if (!name || !name.trim()) {
            req.flash('error', 'Nama paket wajib diisi');
            return res.redirect('/packages');
        }

        const isBypassVal = (is_bypass === '1' || is_bypass === 'on') ? 1 : 0;
        const noWaVal = (no_wa_billing === '1' || no_wa_billing === 'on') ? 1 : 0;
        const finalPrice = isBypassVal ? 0 : (parseFloat(price) || 0);

        db.prepare(`
            UPDATE packages SET
                name = ?, speed_down = ?, speed_up = ?, price = ?,
                description = ?, is_bypass = ?, no_wa_billing = ?, is_active = ?
            WHERE id = ?
        `).run(
            name.trim(),
            parseInt(speed_down) || 0,
            parseInt(speed_up) || 0,
            finalPrice,
            description || null,
            isBypassVal,
            noWaVal,
            is_active !== undefined ? (is_active === 'on' || is_active === '1' ? 1 : 0) : 1,
            req.params.id
        );

        req.flash('success', `Paket ${name.trim()} berhasil diperbarui`);
        res.redirect('/packages');
    } catch (error) {
        console.error('Error updating package:', error.message);
        req.flash('error', 'Gagal memperbarui paket: ' + error.message);
        res.redirect('/packages');
    }
});

// POST /:id/delete - Delete package (check for customers first)
router.post('/:id/delete', (req, res) => {
    try {
        const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id);
        if (!pkg) {
            req.flash('error', 'Paket tidak ditemukan');
            return res.redirect('/packages');
        }

        // Check if any customers use this package
        const customerCount = db.prepare('SELECT COUNT(*) as count FROM customers WHERE package_id = ?').get(req.params.id);
        if (customerCount.count > 0) {
            req.flash('error', `Paket ${pkg.name} tidak dapat dihapus karena masih digunakan oleh ${customerCount.count} pelanggan`);
            return res.redirect('/packages');
        }

        db.prepare('DELETE FROM packages WHERE id = ?').run(req.params.id);

        req.flash('success', `Paket ${pkg.name} berhasil dihapus`);
        res.redirect('/packages');
    } catch (error) {
        console.error('Error deleting package:', error.message);
        req.flash('error', 'Gagal menghapus paket: ' + error.message);
        res.redirect('/packages');
    }
});

module.exports = router;
