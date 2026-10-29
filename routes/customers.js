const express = require('express');
const router = express.Router();
const db = require('../database/init');
const { isAuthenticated } = require('../middleware/auth');
const moment = require('moment');
const whatsappService = require('../services/whatsapp');

router.use(isAuthenticated);

// GET / - List all customers with package info
router.get('/', (req, res) => {
    try {
        const { package_id, router_id, address, ip, status } = req.query;

        let query = `
            SELECT c.*, p.name as package_name, p.speed_down, p.speed_up, p.price, p.is_bypass, p.no_wa_billing,
                   r.name as router_name, r.host as router_host
            FROM customers c
            LEFT JOIN packages p ON c.package_id = p.id
            LEFT JOIN routers r ON c.router_id = r.id
        `;
        const conditions = [];
        const params = [];

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
        if (status) {
            conditions.push('c.status = ?');
            params.push(status);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        query += ' ORDER BY c.created_at DESC';

        const customers = db.prepare(query).all(...params);
        const packages = db.prepare('SELECT id, name FROM packages WHERE is_active = 1 ORDER BY name ASC').all();
        const routers = db.prepare('SELECT id, name FROM routers WHERE is_active = 1 ORDER BY is_default DESC, name ASC').all();

        res.render('customers', {
            title: 'Pelanggan',
            activePage: 'customers',
            customers,
            packages,
            routers,
            filters: { package_id: package_id || '', router_id: router_id || '', address: address || '', ip: ip || '', status: status || '' },
            moment
        });
    } catch (error) {
        console.error('Error loading customers:', error.message);
        req.flash('error', 'Gagal memuat data pelanggan');
        res.render('customers', {
            title: 'Pelanggan',
            activePage: 'customers',
            customers: [],
            packages: [],
            routers: [],
            filters: {},
            moment
        });
    }
});

// GET /create - Render customer creation form
router.get('/create', (req, res) => {
    try {
        const packages = db.prepare('SELECT * FROM packages WHERE is_active = 1 ORDER BY name').all();
        const routers = db.prepare('SELECT * FROM routers WHERE is_active = 1 ORDER BY is_default DESC, name ASC').all();

        res.render('customer-form', {
            title: 'Tambah Pelanggan',
            activePage: 'customers',
            mode: 'create',
            customer: {},
            packages,
            routers
        });
    } catch (error) {
        console.error('Error loading create form:', error.message);
        req.flash('error', 'Gagal memuat form pelanggan');
        res.redirect('/customers');
    }
});

// POST / - Create new customer
router.post('/', async (req, res) => {
    try {
        const {
            name, address, phone, email, package_id,
            pppoe_username, pppoe_password,
            latitude, longitude, onu_serial,
            installation_date, due_date, status, notes
        } = req.body;

        // Validate required fields
        if (!name || !name.trim()) {
            req.flash('error', 'Nama pelanggan wajib diisi');
            return res.redirect('/customers/create');
        }
        if (!phone || !phone.trim()) {
            req.flash('error', 'Nomor telepon wajib diisi');
            return res.redirect('/customers/create');
        }

        // Auto-generate customer_id (CUST-0001 format)
        const lastCustomer = db.prepare(
            "SELECT customer_id FROM customers WHERE customer_id LIKE 'CUST-%' ORDER BY customer_id DESC LIMIT 1"
        ).get();

        let nextNum = 1;
        if (lastCustomer) {
            const lastNum = parseInt(lastCustomer.customer_id.replace('CUST-', ''), 10);
            if (!isNaN(lastNum)) nextNum = lastNum + 1;
        }
        const customer_id = `CUST-${String(nextNum).padStart(4, '0')}`;

        let router_id = req.body.router_id ? parseInt(req.body.router_id, 10) : null;
        if (!router_id) {
            const defR = db.prepare('SELECT id FROM routers WHERE is_default = 1 LIMIT 1').get() || db.prepare('SELECT id FROM routers LIMIT 1').get();
            router_id = defR ? defR.id : null;
        }

        const rawIp = (req.body.connection_type === 'pppoe' ? (req.body.pppoe_ip_address || req.body.ip_address) : req.body.ip_address) || null;
        const additional_bill = (req.body.additional_bill !== undefined && req.body.additional_bill !== '' && !isNaN(parseFloat(req.body.additional_bill))) ? parseFloat(req.body.additional_bill) : 0;
        const additional_bill_desc = (req.body.additional_bill_desc || '').trim() || null;
        const auto_reset_additional_bill = (req.body.auto_reset_additional_bill === '0' || req.body.auto_reset_additional_bill === 'false') ? 0 : 1;

        const stmt = db.prepare(`
            INSERT INTO customers (
                customer_id, name, address, phone, email, package_id, router_id,
                connection_type, pppoe_username, pppoe_password, ip_address, mac_address,
                latitude, longitude, onu_serial, installation_date, due_date, status, notes,
                additional_bill, additional_bill_desc, auto_reset_additional_bill,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `);

        const result = stmt.run(
            customer_id,
            name.trim(),
            address || null,
            phone.trim(),
            email || null,
            package_id || null,
            router_id,
            req.body.connection_type || 'pppoe',
            req.body.pppoe_username || null,
            req.body.pppoe_password || null,
            rawIp ? rawIp.trim() : null,
            req.body.mac_address || null,
            latitude || null,
            longitude || null,
            onu_serial || null,
            installation_date || null,
            due_date ? parseInt(due_date, 10) : 8,
            status || 'active',
            notes || null,
            additional_bill,
            additional_bill_desc,
            auto_reset_additional_bill
        );

        // Simpan IP Gateway Router (khusus pelanggan IP Statik) untuk tautan login router di Portal Pelanggan
        try {
            db.prepare('UPDATE customers SET gateway_ip = ? WHERE id = ?')
                .run((req.body.gateway_ip || '').trim() || null, result.lastInsertRowid);
        } catch (e) { console.warn('[Customers] Gagal menyimpan gateway_ip:', e.message); }

        if (status === 'suspended') {
            await syncCustomerMikrotikIsolir({
                id: result.lastInsertRowid,
                customer_id,
                name: name.trim(),
                router_id,
                connection_type: req.body.connection_type || 'pppoe',
                pppoe_username: req.body.pppoe_username || null,
                ip_address: rawIp ? rawIp.trim() : null
            }, 'suspended');
        }

        // Kirim WhatsApp Selamat Bergabung jika aktif dan nomor telepon terisi
        let waNotice = '';
        const sendWelcome = req.body.send_welcome_wa !== '0' && req.body.send_welcome_wa !== 'false';
        if (sendWelcome && phone && phone.trim()) {
            try {
                const newCustomerId = result.lastInsertRowid;
                const newCustData = db.prepare(`
                    SELECT c.*, p.name as package_name, p.speed_down, p.speed_up, p.price as package_price
                    FROM customers c
                    LEFT JOIN packages p ON c.package_id = p.id
                    WHERE c.id = ?
                `).get(newCustomerId);

                if (newCustData) {
                    whatsappService.sendWelcomeCustomer(newCustData).then(waRes => {
                        if (waRes.success) {
                            console.log(`[Customers] Pesan selamat bergabung berhasil dikirim ke ${newCustData.name}`);
                        }
                    }).catch(errWa => {
                        console.warn(`[Customers] Gagal kirim WA selamat bergabung ke ${newCustData.name}:`, errWa.message);
                    });
                    waNotice = ' & pesan WhatsApp selamat bergabung sedang dikirimkan';
                }
            } catch (eWa) {
                console.warn('[Customers] Error trigger welcome WhatsApp:', eWa.message);
            }
        }

        // Log activity
        db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
            .run('customer_create', `Pelanggan baru ditambahkan: ${name.trim()} (${customer_id})`, req.user?.id || null);

        req.flash('success', `Pelanggan ${name.trim()} berhasil ditambahkan dengan ID ${customer_id}${waNotice ? waNotice : '.'}`);
        res.redirect('/customers');
    } catch (error) {
        console.error('Error creating customer:', error.message);
        req.flash('error', 'Gagal menambahkan pelanggan: ' + error.message);
        res.redirect('/customers/create');
    }
});

// POST /:id/send-welcome - Kirim Ulang Pesan WhatsApp Selamat Bergabung
router.post('/:id/send-welcome', async (req, res) => {
    try {
        const customer = db.prepare(`
            SELECT c.*, p.name as package_name, p.speed_down, p.speed_up, p.price as package_price
            FROM customers c
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE c.id = ?
        `).get(req.params.id);

        if (!customer) {
            req.flash('error', 'Pelanggan tidak ditemukan.');
            return res.redirect('/customers');
        }

        if (!customer.phone || !customer.phone.trim()) {
            req.flash('error', `Nomor WhatsApp pelanggan ${customer.name} belum terisi.`);
            return res.redirect('/customers');
        }

        const result = await whatsappService.sendWelcomeCustomer(customer);
        if (result.success) {
            req.flash('success', `Pesan selamat bergabung berhasil dikirim ke WhatsApp ${customer.name} (${customer.phone}).`);
        } else {
            req.flash('error', result.message || 'Gagal mengirim pesan selamat bergabung.');
        }
    } catch (err) {
        console.error('[Customers] Error send-welcome:', err.message);
        req.flash('error', 'Gagal mengirim WhatsApp: ' + err.message);
    }
    res.redirect(req.get('Referrer') || '/customers');
});

// GET /:id/edit - Render customer edit form
router.get('/:id/edit', (req, res) => {
    try {
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
        if (!customer) {
            req.flash('error', 'Pelanggan tidak ditemukan');
            return res.redirect('/customers');
        }

        const packages = db.prepare('SELECT * FROM packages WHERE is_active = 1 ORDER BY name').all();
        const routers = db.prepare('SELECT * FROM routers WHERE is_active = 1 ORDER BY is_default DESC, name ASC').all();

        res.render('customer-form', {
            title: 'Edit Pelanggan',
            activePage: 'customers',
            mode: 'edit',
            customer,
            packages,
            routers
        });
    } catch (error) {
        console.error('Error loading edit form:', error.message);
        req.flash('error', 'Gagal memuat data pelanggan');
        res.redirect('/customers');
    }
});

// POST /:id - Update customer
router.post('/:id', async (req, res) => {
    try {
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
        if (!customer) {
            req.flash('error', 'Pelanggan tidak ditemukan');
            return res.redirect('/customers');
        }

        const {
            name, address, phone, email, package_id, router_id,
            connection_type, pppoe_username, pppoe_password, ip_address, mac_address,
            latitude, longitude, onu_serial,
            installation_date, due_date, status, notes
        } = req.body;

        // Validate required fields
        if (!name || !name.trim()) {
            req.flash('error', 'Nama pelanggan wajib diisi');
            return res.redirect(`/customers/${req.params.id}/edit`);
        }
        if (!phone || !phone.trim()) {
            req.flash('error', 'Nomor telepon wajib diisi');
            return res.redirect(`/customers/${req.params.id}/edit`);
        }

        const effectiveRouterId = router_id ? parseInt(router_id, 10) : customer.router_id;
        const effectiveIp = (connection_type === 'pppoe' ? (req.body.pppoe_ip_address || ip_address) : ip_address) || null;
        const cleanEffectiveIp = effectiveIp ? effectiveIp.trim() : null;
        const additional_bill = (req.body.additional_bill !== undefined && req.body.additional_bill !== '' && !isNaN(parseFloat(req.body.additional_bill))) ? parseFloat(req.body.additional_bill) : 0;
        const additional_bill_desc = (req.body.additional_bill_desc || '').trim() || null;
        const auto_reset_additional_bill = (req.body.auto_reset_additional_bill === '1' || req.body.auto_reset_additional_bill === 'on' || req.body.auto_reset_additional_bill === 'true') ? 1 : 0;

        db.prepare(`
            UPDATE customers SET
                name = ?, address = ?, phone = ?, email = ?, package_id = ?, router_id = ?,
                connection_type = ?, pppoe_username = ?, pppoe_password = ?,
                ip_address = ?, mac_address = ?,
                latitude = ?, longitude = ?, onu_serial = ?,
                installation_date = ?, due_date = ?, status = ?, is_auto_isolated = 0, notes = ?,
                additional_bill = ?, additional_bill_desc = ?, auto_reset_additional_bill = ?,
                updated_at = datetime('now')
            WHERE id = ?
        `).run(
            name.trim(),
            address || null,
            phone.trim(),
            email || null,
            package_id || null,
            effectiveRouterId,
            connection_type || 'pppoe',
            pppoe_username || null,
            pppoe_password || null,
            cleanEffectiveIp,
            mac_address || null,
            latitude || null,
            longitude || null,
            onu_serial || null,
            installation_date || null,
            due_date ? parseInt(due_date, 10) : 8,
            status || 'active',
            notes || null,
            additional_bill,
            additional_bill_desc,
            auto_reset_additional_bill,
            req.params.id
        );

        // Sinkronisasi nominal tagihan unpaid yang ada jika ada tagihan tambahan
        try {
            const unpaidInvoice = db.prepare("SELECT * FROM invoices WHERE customer_id = ? AND status = 'unpaid' ORDER BY id DESC LIMIT 1").get(req.params.id);
            if (unpaidInvoice) {
                const targetPkgId = package_id || customer.package_id;
                const pkgRow = db.prepare('SELECT price FROM packages WHERE id = ?').get(targetPkgId);
                const basePrice = pkgRow ? (parseFloat(pkgRow.price) || 0) : unpaidInvoice.amount;
                let newInvoiceAmount = basePrice + additional_bill;
                if (newInvoiceAmount < 0) newInvoiceAmount = 0;

                let newInvoiceNotes = null;
                if (additional_bill !== 0) {
                    const descStr = additional_bill_desc ? ` (${additional_bill_desc})` : '';
                    if (additional_bill > 0) {
                        newInvoiceNotes = `Tagihan Tambahan: +Rp ${Number(additional_bill).toLocaleString('id-ID')}${descStr}`;
                    } else {
                        newInvoiceNotes = `Potongan Tagihan: -Rp ${Number(Math.abs(additional_bill)).toLocaleString('id-ID')}${descStr}`;
                    }
                }
                db.prepare("UPDATE invoices SET amount = ?, notes = ? WHERE id = ?").run(newInvoiceAmount, newInvoiceNotes, unpaidInvoice.id);
            }
        } catch (eInv) {
            console.warn('[Customers] Gagal sinkronisasi invoice unpaid:', eInv.message);
        }

        // Simpan IP Gateway Router (khusus pelanggan IP Statik)
        try {
            db.prepare('UPDATE customers SET gateway_ip = ? WHERE id = ?')
                .run((req.body.gateway_ip || '').trim() || null, req.params.id);
        } catch (e) { console.warn('[Customers] Gagal menyimpan gateway_ip:', e.message); }

        // Sinkronisasi status isolir ke MikroTik
        const updatedCustomerData = {
            id: req.params.id,
            customer_id: customer.customer_id,
            name: name.trim(),
            router_id: effectiveRouterId,
            connection_type: connection_type || 'pppoe',
            pppoe_username: pppoe_username || null,
            ip_address: cleanEffectiveIp
        };

        // Jika pelanggan menggunakan paket bypass/gratis, pastikan bebas dari isolir MikroTik
        let isBypass = false;
        if (package_id) {
            try {
                const pkgInfo = db.prepare('SELECT is_bypass FROM packages WHERE id = ?').get(package_id);
                if (pkgInfo && pkgInfo.is_bypass === 1) isBypass = true;
            } catch (errPkg) {}
        }

        if (isBypass) {
            await syncCustomerMikrotikIsolir(updatedCustomerData, 'active');
        } else if (status === 'suspended') {
            await syncCustomerMikrotikIsolir(updatedCustomerData, 'suspended');
        } else if (status === 'active') {
            await syncCustomerMikrotikIsolir(updatedCustomerData, 'active');
        }

        // Log activity
        db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
            .run('customer_update', `Pelanggan diperbarui: ${name.trim()} (${customer.customer_id})`, req.user?.id || null);

        req.flash('success', `Pelanggan ${name.trim()} berhasil diperbarui`);
        res.redirect('/customers');
    } catch (error) {
        console.error('Error updating customer:', error.message);
        req.flash('error', 'Gagal memperbarui pelanggan: ' + error.message);
        res.redirect(`/customers/${req.params.id}/edit`);
    }
});

// POST /:id/suspend - Quick Isolir customer
router.post('/:id/suspend', async (req, res) => {
    try {
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
        if (!customer) {
            req.flash('error', 'Pelanggan tidak ditemukan');
            return res.redirect('/customers');
        }

        // Set status 'suspended' dan is_auto_isolated = 0 (manual isolir oleh admin)
        db.prepare("UPDATE customers SET status = 'suspended', is_auto_isolated = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
        customer.status = 'suspended';
        customer.is_auto_isolated = 0;

        const syncResult = await syncCustomerMikrotikIsolir(customer, 'suspended');

        db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
            .run('customer_suspend', `Pelanggan diisolir manual: ${customer.name} (${customer.customer_id})`, req.user?.id || null);

        if (syncResult && syncResult.success) {
            req.flash('success', `Pelanggan ${customer.name} berhasil diisolir (status: Suspend) dan IP ${syncResult.ip} dimasukkan ke address-list ${syncResult.listName || 'Expired'}`);
        } else {
            req.flash('warning', `Status pelanggan diset ke Suspend, namun peringatan MikroTik: ${(syncResult && syncResult.message) || 'IP belum terdeteksi'}`);
        }
        res.redirect('/customers');
    } catch (error) {
        console.error('Error suspending customer:', error.message);
        req.flash('error', 'Gagal mengisolir pelanggan: ' + error.message);
        res.redirect('/customers');
    }
});

// POST /:id/activate - Quick Buka Isolir customer
router.post('/:id/activate', async (req, res) => {
    try {
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
        if (!customer) {
            req.flash('error', 'Pelanggan tidak ditemukan');
            return res.redirect('/customers');
        }

        // Set status 'active' dan is_auto_isolated = 0
        db.prepare("UPDATE customers SET status = 'active', is_auto_isolated = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
        customer.status = 'active';
        customer.is_auto_isolated = 0;

        const syncResult = await syncCustomerMikrotikIsolir(customer, 'active');

        db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
            .run('customer_activate', `Isolir dibuka: ${customer.name} (${customer.customer_id})`, req.user?.id || null);

        if (syncResult && syncResult.success) {
            req.flash('success', `Isolir pelanggan ${customer.name} berhasil dibuka (status: Aktif) dan dihapus dari address-list MikroTik`);
        } else {
            req.flash('warning', `Status diubah ke Aktif, namun peringatan MikroTik: ${(syncResult && syncResult.message) || 'Gagal sinkron'}`);
        }
        res.redirect('/customers');
    } catch (error) {
        console.error('Error activating customer:', error.message);
        req.flash('error', 'Gagal membuka isolir pelanggan: ' + error.message);
        res.redirect('/customers');
    }
});

// POST /:id/additional-bill - Atur atau kosongkan tagihan tambahan / tagihan lainnya
router.post('/:id/additional-bill', (req, res) => {
    try {
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
        if (!customer) {
            req.flash('error', 'Pelanggan tidak ditemukan');
            return res.redirect('/customers');
        }

        const additional_bill = (req.body.additional_bill !== undefined && req.body.additional_bill !== '' && !isNaN(parseFloat(req.body.additional_bill))) ? parseFloat(req.body.additional_bill) : 0;
        const additional_bill_desc = (req.body.additional_bill_desc || '').trim() || null;
        const auto_reset_additional_bill = (req.body.auto_reset_additional_bill === '1' || req.body.auto_reset_additional_bill === 'on' || req.body.auto_reset_additional_bill === 'true') ? 1 : 0;

        db.prepare(`
            UPDATE customers 
            SET additional_bill = ?, additional_bill_desc = ?, auto_reset_additional_bill = ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(additional_bill, additional_bill_desc, auto_reset_additional_bill, customer.id);

        // Jika pelanggan memiliki tagihan yang berstatus 'unpaid', sinkronkan nominal tagihan
        try {
            const unpaidInvoice = db.prepare("SELECT * FROM invoices WHERE customer_id = ? AND status = 'unpaid' ORDER BY id DESC LIMIT 1").get(customer.id);
            if (unpaidInvoice) {
                const pkgRow = db.prepare('SELECT price FROM packages WHERE id = ?').get(customer.package_id);
                const basePrice = pkgRow ? (parseFloat(pkgRow.price) || 0) : unpaidInvoice.amount;
                let newAmount = basePrice + additional_bill;
                if (newAmount < 0) newAmount = 0;

                let newNotes = null;
                if (additional_bill !== 0) {
                    const descStr = additional_bill_desc ? ` (${additional_bill_desc})` : '';
                    if (additional_bill > 0) {
                        newNotes = `Tagihan Tambahan: +Rp ${Number(additional_bill).toLocaleString('id-ID')}${descStr}`;
                    } else {
                        newNotes = `Potongan Tagihan: -Rp ${Number(Math.abs(additional_bill)).toLocaleString('id-ID')}${descStr}`;
                    }
                }
                db.prepare("UPDATE invoices SET amount = ?, notes = ? WHERE id = ?").run(newAmount, newNotes, unpaidInvoice.id);
            }
        } catch (eInv) {
            console.warn('[Customers] Gagal sinkronisasi invoice unpaid:', eInv.message);
        }

        const logDesc = additional_bill !== 0
            ? `Atur tagihan lainnya ${customer.name}: ${additional_bill > 0 ? '+' : ''}Rp ${Number(additional_bill).toLocaleString('id-ID')} (${additional_bill_desc || 'Tanpa keterangan'})`
            : `Hapus / Bersihkan tagihan tambahan untuk ${customer.name}`;

        try {
            db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
                .run('customer_update', logDesc, req.user?.id || null);
        } catch (e) {}

        req.flash('success', additional_bill !== 0
            ? `Tagihan lainnya untuk ${customer.name} berhasil disimpan (${additional_bill > 0 ? '+' : ''}Rp ${Number(additional_bill).toLocaleString('id-ID')})`
            : `Tagihan tambahan untuk ${customer.name} berhasil dikosongkan.`);

        res.redirect(req.headers.referer || '/customers');
    } catch (err) {
        console.error('[Customers] Error updating additional bill:', err.message);
        req.flash('error', 'Gagal memperbarui tagihan tambahan: ' + err.message);
        res.redirect('/customers');
    }
});

// POST /:id/delete - Delete customer and related data
router.post('/:id/delete', async (req, res) => {
    try {
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
        if (!customer) {
            req.flash('error', 'Pelanggan tidak ditemukan');
            return res.redirect('/customers');
        }

        // Lepas isolir di MikroTik sebelum menghapus
        await syncCustomerMikrotikIsolir(customer, 'active');

        // Delete related payments (via invoices)
        const invoiceIds = db.prepare('SELECT id FROM invoices WHERE customer_id = ?').all(req.params.id);
        if (invoiceIds.length > 0) {
            const placeholders = invoiceIds.map(() => '?').join(',');
            db.prepare(`DELETE FROM payments WHERE invoice_id IN (${placeholders})`)
                .run(...invoiceIds.map(i => i.id));
        }

        // Delete invoices
        db.prepare('DELETE FROM invoices WHERE customer_id = ?').run(req.params.id);

        // Delete customer
        db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);

        // Log activity
        db.prepare('INSERT INTO activity_log (action, description, user_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
            .run('customer_delete', `Pelanggan dihapus: ${customer.name} (${customer.customer_id})`, req.user?.id || null);

        req.flash('success', `Pelanggan ${customer.name} berhasil dihapus`);
        res.redirect('/customers');
    } catch (error) {
        console.error('Error deleting customer:', error.message);
        req.flash('error', 'Gagal menghapus pelanggan: ' + error.message);
        res.redirect('/customers');
    }
});

// Helper sinkronisasi isolir MikroTik
async function syncCustomerMikrotikIsolir(customerData, targetStatus) {
    try {
        const mikrotikService = require('../services/mikrotik');
        if (targetStatus === 'suspended') {
            return await mikrotikService.isolateCustomer(customerData, `Suspend: ${customerData.name} (${customerData.customer_id})`);
        } else if (targetStatus === 'active') {
            return await mikrotikService.unIsolateCustomer(customerData);
        }
        return { success: true };
    } catch (err) {
        console.warn(`[MikroTik] Gagal sinkronisasi isolir status ${targetStatus} untuk ${customerData.name}:`, err.message);
        return { success: false, message: err.message };
    }
}

module.exports = router;
