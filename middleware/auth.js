// Middleware autentikasi & kontrol akses berbasis peran (Admin vs Teknisi vs Pelanggan)

/**
 * Memeriksa apakah pengguna sudah terautentikasi.
 * - Jika role === 'customer': HANYA boleh mengakses /portal dan /auth/logout.
 * - Jika role === 'technician': HANYA boleh mengakses /tickets dan /auth/logout.
 * - Jika role === 'admin': Boleh mengakses seluruh menu.
 */
function isAuthenticated(req, res, next) {
    if (req.session && req.session.user) {
        const role = (req.session.user.role || 'admin').toLowerCase();
        const baseUrl = req.baseUrl || '';
        const fullPath = req.originalUrl || req.path || '';

        // 1. Pembatasan khusus Akun Pelanggan: HANYA boleh mengakses /portal dan /auth
        if (role === 'customer' || role === 'pelanggan') {
            const isAllowedCustomer =
                baseUrl.startsWith('/portal') ||
                baseUrl.startsWith('/auth') ||
                fullPath.startsWith('/portal') ||
                fullPath.startsWith('/auth') ||
                fullPath.startsWith('/logout');

            if (!isAllowedCustomer) {
                if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
                    return res.status(403).json({ error: 'Akses ditolak. Pelanggan hanya dapat mengakses Portal Tiket Gangguan Pelanggan.' });
                }
                return res.redirect('/portal');
            }
            return next();
        }

        // 2. Pembatasan khusus Akun Teknisi: HANYA boleh mengakses /tickets, /psb, /rekap-teknisi, dan /auth
        if (role === 'technician' || role === 'teknisi') {
            const isAllowedTech =
                baseUrl.startsWith('/tickets') ||
                baseUrl.startsWith('/psb') ||
                baseUrl.startsWith('/rekap-teknisi') ||
                baseUrl.startsWith('/auth') ||
                fullPath.startsWith('/tickets') ||
                fullPath.startsWith('/psb') ||
                fullPath.startsWith('/rekap-teknisi') ||
                fullPath.startsWith('/auth') ||
                fullPath.startsWith('/logout');

            if (!isAllowedTech) {
                if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
                    return res.status(403).json({ error: 'Akses ditolak. Akun Teknisi hanya dapat mengakses menu Tiket Gangguan dan Tiket PSB.' });
                }
                req.flash('warning', 'Portal Teknisi hanya memiliki akses ke menu Tiket Gangguan dan Tiket PSB.');
                return res.redirect('/tickets');
            }
            return next();
        }

        return next();
    }

    req.flash('error', 'Silakan login terlebih dahulu');
    res.redirect('/login');
}

/**
 * Memastikan hanya Administrator yang dapat mengakses aksi sensitif
 */
function isAdmin(req, res, next) {
    if (req.session && req.session.user) {
        const role = (req.session.user.role || 'admin').toLowerCase();
        if (role === 'admin' || role === 'administrator') {
            return next();
        }
    }
    req.flash('error', 'Aksi ini hanya dapat dilakukan oleh Administrator.');
    return res.redirect(req.session?.user?.role === 'customer' ? '/portal' : '/tickets');
}

module.exports = { isAuthenticated, isAdmin };
