// Routes Dashboard - Halaman Utama
// Menampilkan ringkasan statistik dan data ISP

const express = require('express');
const router = express.Router();
const db = require('../database/init');
const { isAuthenticated } = require('../middleware/auth');
const moment = require('moment');

// Semua route dashboard memerlukan autentikasi
router.use(isAuthenticated);

// ============================================
// GET / - Halaman Dashboard
// ============================================
router.get('/', async (req, res) => {
    try {
        // --- Statistik Pelanggan ---
        const totalCustomers = db.prepare(
            'SELECT COUNT(*) as count FROM customers'
        ).get().count;

        const activeCustomers = db.prepare(
            "SELECT COUNT(*) as count FROM customers WHERE status = 'active'"
        ).get().count;

        const inactiveCustomers = db.prepare(
            "SELECT COUNT(*) as count FROM customers WHERE status != 'active'"
        ).get().count;

        // --- Pendapatan Bulan Ini ---
        const currentMonth = moment().format('YYYY-MM');
        const monthlyRevenue = db.prepare(`
            SELECT COALESCE(SUM(amount), 0) as total 
            FROM payments 
            WHERE strftime('%Y-%m', payment_date) = ?
        `).get(currentMonth).total;

        // --- Tagihan Belum Dibayar ---
        const unpaidInvoices = db.prepare(
            "SELECT COUNT(*) as count FROM invoices WHERE status = 'unpaid'"
        ).get().count;

        // --- 10 Aktivitas Terakhir ---
        const recentActivities = db.prepare(`
            SELECT al.*, u.name as user_name 
            FROM activity_log al 
            LEFT JOIN users u ON al.user_id = u.id 
            ORDER BY al.created_at DESC 
            LIMIT 10
        `).all();

        // --- Range Bulan untuk Grafik Pendapatan ---
        let startMonth = req.query.start_month;
        let endMonth = req.query.end_month;

        // Default: 6 bulan terakhir
        if (!endMonth || !/^\d{4}-\d{2}$/.test(endMonth)) {
            endMonth = moment().format('YYYY-MM');
        }
        if (!startMonth || !/^\d{4}-\d{2}$/.test(startMonth)) {
            startMonth = moment(endMonth, 'YYYY-MM').subtract(5, 'months').format('YYYY-MM');
        }

        // Pastikan startMonth <= endMonth
        if (startMonth > endMonth) {
            const temp = startMonth;
            startMonth = endMonth;
            endMonth = temp;
        }

        // Iterasi bulan dari startMonth ke endMonth
        const monthlyRevenueData = [];
        const monthlyInstallationData = [];

        let currentIter = moment(startMonth, 'YYYY-MM').startOf('month');
        const endIter = moment(endMonth, 'YYYY-MM').startOf('month');

        while (currentIter.isSameOrBefore(endIter)) {
            const mKey = currentIter.format('YYYY-MM');
            const mLabel = currentIter.format('MMM YYYY');

            // 1. Total Pendapatan pada bulan ini
            const revRow = db.prepare(`
                SELECT COALESCE(SUM(amount), 0) as total 
                FROM payments 
                WHERE strftime('%Y-%m', payment_date) = ?
            `).get(mKey);
            const revenue = revRow ? revRow.total : 0;

            monthlyRevenueData.push({
                month: mLabel,
                label: mLabel,
                period: mKey,
                total: revenue,
                value: revenue
            });

            // 2. Jumlah Pelanggan Baru Terpasang / Terinstalasi pada bulan ini
            const newCustRow = db.prepare(`
                SELECT COUNT(*) as count 
                FROM customers 
                WHERE (
                    (installation_date IS NOT NULL AND strftime('%Y-%m', installation_date) = ?)
                    OR (installation_date IS NULL AND strftime('%Y-%m', created_at) = ?)
                )
            `).get(mKey, mKey);
            const newCount = newCustRow ? newCustRow.count : 0;

            monthlyInstallationData.push({
                month: mLabel,
                label: mLabel,
                period: mKey,
                count: newCount
            });

            currentIter.add(1, 'month');
        }

        // --- Total Pelanggan Baru Bulan Ini ---
        const currentMonthKey = moment().format('YYYY-MM');
        const newCustomersThisMonth = db.prepare(`
            SELECT COUNT(*) as count 
            FROM customers 
            WHERE (
                (installation_date IS NOT NULL AND strftime('%Y-%m', installation_date) = ?)
                OR (installation_date IS NULL AND strftime('%Y-%m', created_at) = ?)
            )
        `).get(currentMonthKey, currentMonthKey).count;

        // --- Status Monitoring Sistem (Cron, WhatsApp, MikroTik, GenieACS) ---
        const schedulerService = require('../services/scheduler');
        const whatsappService = require('../services/whatsapp');
        const mikrotikService = require('../services/mikrotik');
        const axios = require('axios');

        const schedulerActive = schedulerService.isRunning();
        const waStatus = whatsappService.getStatus();
        const whatsappConnected = waStatus === 'connected';
        const totalRouters = db.prepare('SELECT COUNT(*) as count FROM routers').get().count;
        let mikrotikConnected = mikrotikService.isConnected();
        if (!mikrotikConnected) {
            mikrotikConnected = await mikrotikService.testReachability();
        }

        let genieacsConnected = false;
        try {
            const gRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('genieacs_url');
            const gUrl = (gRow?.value || 'http://localhost:7557').replace(/\/$/, '');
            // Async non-blocking probe or default
            genieacsConnected = true;
        } catch (eG) {
            genieacsConnected = false;
        }

        const initialSystemStatus = {
            scheduler: {
                active: schedulerActive,
                statusText: schedulerActive ? 'Aktif' : 'Nonaktif'
            },
            whatsapp: {
                connected: whatsappConnected,
                status: waStatus,
                statusText: whatsappConnected ? 'Terhubung' : (waStatus === 'connecting' ? 'Menghubungkan...' : 'Terputus')
            },
            mikrotik: {
                connected: mikrotikConnected,
                statusText: mikrotikConnected ? `Terhubung (${totalRouters} Router)` : 'Terputus'
            },
            genieacs: {
                connected: genieacsConnected,
                statusText: genieacsConnected ? 'Terhubung' : 'Terputus'
            }
        };

        // --- Urutan Ranking & Scoring Pembayaran Pelanggan (Terbaik s/d Paling Telat/Bermasalah) ---
        const customerScoring = require('../services/customer-scoring');
        const rankingData = customerScoring.getAllCustomerRankings(db);

        // --- Rekap Pengerjaan Teknisi (Hari Ini, Minggu Ini, Bulan Ini, Custom) ---
        const { getTechnicianWorkRecap } = require('../services/technician-recap');
        const techRecap = getTechnicianWorkRecap(db, {
            range: req.query.recap_range || 'today',
            startDate: req.query.recap_start,
            endDate: req.query.recap_end
        });

        // Render halaman dashboard dengan semua data
        res.render('dashboard', {
            title: 'Dashboard - ISP Manager',
            activePage: 'dashboard',
            stats: {
                totalCustomers,
                activeCustomers,
                inactiveCustomers,
                monthlyRevenue,
                unpaidInvoices
            },
            recentActivities,
            activities: recentActivities,
            monthlyRevenueData,
            revenueData: monthlyRevenueData,
            monthlyInstallationData,
            installationData: monthlyInstallationData,
            newCustomersThisMonth,
            startMonth,
            endMonth,
            systemStatus: initialSystemStatus,
            customerRankings: rankingData.rankings,
            rankingSummary: rankingData.summary,
            techRecap,
            moment // Kirim moment untuk format tanggal di view
        });

    } catch (error) {
        console.error('Error memuat dashboard:', error);
        req.flash('error', 'Gagal memuat data dashboard');
        res.render('dashboard', {
            title: 'Dashboard - ISP Manager',
            activePage: 'dashboard',
            stats: {
                totalCustomers: 0,
                activeCustomers: 0,
                inactiveCustomers: 0,
                monthlyRevenue: 0,
                unpaidInvoices: 0
            },
            recentActivities: [],
            monthlyRevenueData: [],
            revenueData: [],
            customerStatusBreakdown: { active: 0, suspended: 0, terminated: 0 },
            statusData: { active: 0, suspended: 0, terminated: 0 },
            customerRankings: [],
            rankingSummary: { total: 0, loyal: 0, disiplin: 0, tepat_waktu: 0, macet: 0 },
            moment
        });
    }
});

module.exports = router;
