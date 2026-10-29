const express = require('express');
const router = express.Router();
const db = require('../database/init');
const { isAuthenticated } = require('../middleware/auth');
const moment = require('moment');
const path = require('path');
const fs = require('fs');

// Set locale moment ke Indonesia
moment.locale('id');

router.use(isAuthenticated);

// Format rupiah helper
const formatRupiah = (num) => 'Rp ' + Number(num || 0).toLocaleString('id-ID');

// Helper untuk mengambil setting perusahaan
function getCompanyInfo() {
    const companyName = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_name')?.value || 'PT. Lintas Jaringan Nusantara';
    const companyPhone = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_phone')?.value || '';
    const companyAddress = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_address')?.value || '';
    
    let companyLogo = null;
    try {
        const logoPath = path.join(__dirname, '../public/img/logo.png');
        const logoJpgPath = path.join(__dirname, '../public/img/logo.jpg');
        if (fs.existsSync(logoPath)) {
            const buf = fs.readFileSync(logoPath);
            companyLogo = `data:image/png;base64,${buf.toString('base64')}`;
        } else if (fs.existsSync(logoJpgPath)) {
            const buf = fs.readFileSync(logoJpgPath);
            companyLogo = `data:image/jpeg;base64,${buf.toString('base64')}`;
        }
    } catch (e) {}

    return { companyName, companyPhone, companyAddress, companyLogo };
}

// Helper untuk build data rekapan pembayaran
function getPaymentReportData(query) {
    let { start_date, end_date, payment_method, quick_filter } = query;

    // Default ke bulan berjalan jika tidak ada filter tanggal
    if (quick_filter === 'today') {
        start_date = moment().format('YYYY-MM-DD');
        end_date = moment().format('YYYY-MM-DD');
    } else if (quick_filter === 'this_month') {
        start_date = moment().startOf('month').format('YYYY-MM-DD');
        end_date = moment().endOf('month').format('YYYY-MM-DD');
    } else if (quick_filter === 'last_month') {
        start_date = moment().subtract(1, 'month').startOf('month').format('YYYY-MM-DD');
        end_date = moment().subtract(1, 'month').endOf('month').format('YYYY-MM-DD');
    } else if (quick_filter === 'this_year') {
        start_date = moment().startOf('year').format('YYYY-MM-DD');
        end_date = moment().endOf('year').format('YYYY-MM-DD');
    } else if (quick_filter === 'all_time') {
        start_date = '2020-01-01';
        end_date = moment().add(1, 'year').format('YYYY-MM-DD');
    } else {
        if (!start_date) {
            start_date = moment().startOf('month').format('YYYY-MM-DD');
        }
        if (!end_date) {
            end_date = moment().endOf('month').format('YYYY-MM-DD');
        }
    }

    const selectedMethod = payment_method || 'all';

    // Query Payments
    let sql = `
        SELECT p.id as payment_id, p.amount, p.payment_method, p.payment_date, p.received_by, p.notes as payment_notes, p.created_at as payment_created_at,
               i.id as invoice_id, i.invoice_number, i.period as invoice_period, i.due_date as invoice_due_date, i.status as invoice_status,
               c.id as customer_id, c.customer_id as customer_code, c.name as customer_name, c.phone as customer_phone, c.address as customer_address,
               pkg.name as package_name, pkg.price as package_price
        FROM payments p
        JOIN invoices i ON p.invoice_id = i.id
        JOIN customers c ON i.customer_id = c.id
        LEFT JOIN packages pkg ON c.package_id = pkg.id
        WHERE substr(p.payment_date, 1, 10) >= ? AND substr(p.payment_date, 1, 10) <= ?
    `;

    const params = [start_date, end_date];

    if (selectedMethod && selectedMethod !== 'all') {
        if (selectedMethod === 'Cash (Tunai)' || selectedMethod === 'cash') {
            sql += ` AND (p.payment_method = 'Cash (Tunai)' OR LOWER(p.payment_method) LIKE '%cash%' OR LOWER(p.payment_method) LIKE '%tunai%')`;
        } else {
            sql += ` AND (p.payment_method = ? OR LOWER(p.payment_method) = LOWER(?))`;
            params.push(selectedMethod, selectedMethod);
        }
    }

    sql += ` ORDER BY p.payment_date DESC, p.id DESC`;

    const payments = db.prepare(sql).all(...params);

    // Total penerimaan & jumlah transaksi pada filter yang aktif
    const totalRevenue = payments.reduce((acc, curr) => acc + (Number(curr.amount) || 0), 0);
    const totalTransactions = payments.length;
    const averagePayment = totalTransactions > 0 ? Math.round(totalRevenue / totalTransactions) : 0;

    // Breakdown per Metode Pembayaran untuk seluruh rentang tanggal yang dipilih (tanpa filter method)
    const methodBreakdownSql = `
        SELECT p.payment_method, p.amount
        FROM payments p
        WHERE substr(p.payment_date, 1, 10) >= ? AND substr(p.payment_date, 1, 10) <= ?
    `;
    const allRangePayments = db.prepare(methodBreakdownSql).all(start_date, end_date);

    const validMethods = ['BCA', 'BRI', 'DANA', 'QRIS', 'SPay', 'Cash (Tunai)'];
    const methodBreakdown = {};
    validMethods.forEach(m => {
        methodBreakdown[m] = { count: 0, total: 0 };
    });

    allRangePayments.forEach(p => {
        const pm = (p.payment_method || '').trim();
        const lower = pm.toLowerCase();
        let targetKey = 'Cash (Tunai)';

        if (lower.includes('bca')) targetKey = 'BCA';
        else if (lower.includes('bri')) targetKey = 'BRI';
        else if (lower.includes('dana')) targetKey = 'DANA';
        else if (lower.includes('qris')) targetKey = 'QRIS';
        else if (lower.includes('spay') || lower.includes('shopee')) targetKey = 'SPay';
        else if (lower.includes('cash') || lower.includes('tunai')) targetKey = 'Cash (Tunai)';
        else {
            if (!methodBreakdown[pm]) methodBreakdown[pm] = { count: 0, total: 0 };
            targetKey = pm;
        }

        if (methodBreakdown[targetKey]) {
            methodBreakdown[targetKey].count += 1;
            methodBreakdown[targetKey].total += (Number(p.amount) || 0);
        }
    });

    // Breakdown per Paket Internet
    const packageBreakdown = {};
    payments.forEach(p => {
        const pkgName = p.package_name || 'Lainnya / Tanpa Paket';
        if (!packageBreakdown[pkgName]) {
            packageBreakdown[pkgName] = { count: 0, total: 0 };
        }
        packageBreakdown[pkgName].count += 1;
        packageBreakdown[pkgName].total += (Number(p.amount) || 0);
    });

    return {
        payments,
        stats: {
            totalRevenue,
            totalTransactions,
            averagePayment
        },
        methodBreakdown,
        packageBreakdown,
        filters: {
            startDate: start_date,
            endDate: end_date,
            selectedMethod,
            quickFilter: quick_filter || ''
        }
    };
}

// GET /reports - Halaman Utama Laporan Rekapitulasi Pembayaran
router.get('/', (req, res) => {
    try {
        const reportData = getPaymentReportData(req.query);

        res.render('reports', {
            title: 'Laporan Rekapitulasi Pembayaran',
            activePage: 'reports',
            ...reportData,
            moment,
            formatRupiah
        });
    } catch (error) {
        console.error('Error loading reports page:', error);
        req.flash('error', 'Gagal memuat laporan: ' + error.message);
        res.redirect('/dashboard');
    }
});

// GET /reports/print - Halaman Cetak Laporan (Stand-alone print view)
router.get('/print', (req, res) => {
    try {
        const reportData = getPaymentReportData(req.query);
        const companyInfo = getCompanyInfo();

        res.render('report-print', {
            title: 'Cetak Laporan Rekapitulasi Pembayaran',
            ...reportData,
            ...companyInfo,
            printedBy: req.user?.name || req.user?.username || 'Administrator',
            printedAt: moment().format('DD MMMM YYYY, HH:mm:ss') + ' WIB',
            isPdf: false,
            moment,
            formatRupiah
        });
    } catch (error) {
        console.error('Error rendering print view:', error);
        req.flash('error', 'Gagal membuka halaman cetak: ' + error.message);
        res.redirect('/reports');
    }
});

// GET /reports/pdf - Download Langsung Laporan Berupa File PDF
router.get('/pdf', async (req, res) => {
    try {
        const pdfService = require('../services/pdf');
        const reportData = getPaymentReportData(req.query);
        const companyInfo = getCompanyInfo();

        const fullData = {
            title: 'Laporan Rekapitulasi Pembayaran',
            ...reportData,
            ...companyInfo,
            printedBy: req.user?.name || req.user?.username || 'Administrator',
            printedAt: moment().format('DD MMMM YYYY, HH:mm:ss') + ' WIB',
            moment,
            formatRupiah
        };

        const pdfBuffer = await pdfService.generateReportPdf(fullData);

        const fileName = `Laporan-Pembayaran_${reportData.filters.startDate}_sd_${reportData.filters.endDate}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        return res.end(pdfBuffer);
    } catch (error) {
        console.error('Error generating report PDF:', error);
        req.flash('error', 'Gagal membuat file PDF laporan: ' + error.message);
        res.redirect('/reports');
    }
});

// GET /reports/export-csv - Download Rekapan Data sebagai File CSV (Excel Compatible)
router.get('/export-csv', (req, res) => {
    try {
        const { payments, filters } = getPaymentReportData(req.query);

        // Header CSV dengan UTF-8 BOM untuk kompatibilitas Excel
        let csv = '\uFEFF';
        csv += 'No;No Invoice;Periode;Tanggal Bayar;ID Pelanggan;Nama Pelanggan;No Telepon;Paket Internet;Metode Pembayaran;Jumlah (Rp);Diterima Oleh;Catatan\n';

        payments.forEach((p, index) => {
            const clean = (str) => `"${String(str || '').replace(/"/g, '""')}"`;
            const dateStr = moment(p.payment_date).format('YYYY-MM-DD HH:mm');
            const row = [
                index + 1,
                clean(p.invoice_number),
                clean(p.invoice_period),
                clean(dateStr),
                clean(p.customer_code),
                clean(p.customer_name),
                clean(p.customer_phone),
                clean(p.package_name),
                clean(p.payment_method),
                p.amount,
                clean(p.received_by),
                clean(p.payment_notes)
            ];
            csv += row.join(';') + '\n';
        });

        const fileName = `Rekap-Pembayaran_${filters.startDate}_sd_${filters.endDate}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.send(csv);
    } catch (error) {
        console.error('Error exporting CSV report:', error);
        req.flash('error', 'Gagal mengunduh CSV: ' + error.message);
        res.redirect('/reports');
    }
});

module.exports = router;
