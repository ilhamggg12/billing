/**
 * Routes: Rekap Pengerjaan Teknisi (/rekap-teknisi)
 * Halaman khusus rekapitulasi pengerjaan tiket teknisi (Hari Ini, Minggu Ini, Bulan Ini, & Rentang Tanggal)
 * Dapat diakses oleh Administrator maupun Teknisi.
 */

const express = require('express');
const router = express.Router();
const db = require('../database/init');
const { isAuthenticated } = require('../middleware/auth');
const { getTechnicianWorkRecap } = require('../services/technician-recap');
const moment = require('moment');

router.use(isAuthenticated);

// GET /rekap-teknisi
router.get('/', (req, res) => {
    try {
        const techRecap = getTechnicianWorkRecap(db, {
            range: req.query.recap_range || 'today',
            startDate: req.query.recap_start,
            endDate: req.query.recap_end
        });

        res.render('technician-recap', {
            title: 'Rekap Pengerjaan Teknisi',
            activePage: 'technician_recap',
            techRecap,
            moment
        });
    } catch (error) {
        console.error('[TechnicianRecap] Error loading page:', error.message);
        req.flash('error', 'Gagal memuat halaman Rekap Pengerjaan Teknisi: ' + error.message);
        res.redirect('/tickets');
    }
});

module.exports = router;
