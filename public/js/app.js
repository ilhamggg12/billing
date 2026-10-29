// ISP Manager Global Script
$(document).ready(function() {
    // ----------------------------------------------------
    // Sidebar & Navigation Bar Toggle (Desktop & Mobile)
    // ----------------------------------------------------
    const isMobile = () => window.innerWidth < 992;

    // Restore desktop collapsed preference safely
    try {
        if (!isMobile() && localStorage.getItem('sidebar-collapsed') === 'true') {
            $('body').addClass('sidebar-collapsed');
            $('#sidebar').addClass('collapsed');
            $('.wrapper').addClass('sidebar-toggled');
            $('.content-wrapper').addClass('expanded');
        }
    } catch (e) {}

    // Delegated click handler as backup to onclick
    $(document).on('click', '#sidebarToggle', function(e) {
        if (typeof toggleSidebar === 'function') {
            toggleSidebar(e);
        }
    });

    $(document).on('click', '#sidebarOverlay', function() {
        $('#sidebar').removeClass('show');
        $('#sidebarOverlay').removeClass('show');
        $('body').removeClass('sidebar-mobile-open overflow-hidden');
    });

    // Close mobile sidebar on nav-link click
    $(document).on('click', '.sidebar-nav .nav-link', function() {
        if (isMobile()) {
            $('#sidebar').removeClass('show');
            $('#sidebarOverlay').removeClass('show');
            $('body').removeClass('sidebar-mobile-open overflow-hidden');
        }
    });

    // Handle window resize cleanly
    $(window).on('resize', function() {
        if (!isMobile()) {
            $('#sidebar').removeClass('show');
            $('#sidebarOverlay').removeClass('show');
            $('body').removeClass('sidebar-mobile-open overflow-hidden');
            try {
                if (localStorage.getItem('sidebar-collapsed') === 'true') {
                    $('body').addClass('sidebar-collapsed');
                    $('#sidebar').addClass('collapsed');
                    $('.wrapper').addClass('sidebar-toggled');
                    $('.content-wrapper').addClass('expanded');
                } else {
                    $('body').removeClass('sidebar-collapsed');
                    $('#sidebar').removeClass('collapsed');
                    $('.wrapper').removeClass('sidebar-toggled');
                    $('.content-wrapper').removeClass('expanded');
                }
            } catch (e) {}
        }
    });

    // ----------------------------------------------------
    // Live Real-Time Clock in Top Navbar
    // ----------------------------------------------------
    function updateClock() {
        const timeEl = $('#currentTime');
        if (timeEl.length) {
            const now = new Date();
            const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
            const dayName = days[now.getDay()];
            const dayNum = now.getDate();
            const monthName = months[now.getMonth()];
            const year = now.getFullYear();
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            const seconds = String(now.getSeconds()).padStart(2, '0');
            timeEl.text(`${dayName}, ${dayNum} ${monthName} ${year} - ${hours}:${minutes}:${seconds} WIB`);
        }
    }
    updateClock();
    setInterval(updateClock, 1000);

    // DataTables Default Setup with Offline-First Indonesian Translation
    if ($.fn.DataTable) {
        const indonesianLang = {
            emptyTable: "Tidak ada data yang tersedia pada tabel ini",
            info: "Menampilkan _START_ sampai _END_ dari _TOTAL_ entri",
            infoEmpty: "Menampilkan 0 sampai 0 dari 0 entri",
            infoFiltered: "(disaring dari _MAX_ total entri)",
            lengthMenu: "Tampilkan _MENU_ entri",
            loadingRecords: "Sedang memuat data...",
            processing: "Sedang memproses...",
            search: "Cari:",
            searchPlaceholder: "Cari data...",
            zeroRecords: "Tidak ditemukan data yang sesuai",
            paginate: {
                first: '<i class="fas fa-angle-double-left"></i>',
                last: '<i class="fas fa-angle-double-right"></i>',
                next: '<i class="fas fa-chevron-right"></i>',
                previous: '<i class="fas fa-chevron-left"></i>'
            },
            aria: {
                sortAscending: ": aktifkan untuk mengurutkan kolom ke atas",
                sortDescending: ": aktifkan untuk mengurutkan kolom ke bawah"
            }
        };

        window.dataTablesIndonesianLang = indonesianLang;

        $.extend(true, $.fn.dataTable.defaults, {
            language: indonesianLang,
            responsive: true,
            autoWidth: false,
            pageLength: 10,
            lengthMenu: [[10, 25, 50, -1], [10, 25, 50, "Semua"]],
            order: []
        });

        // Initialize all tables with class 'datatable' safely
        $('.datatable').each(function() {
            if (!$.fn.DataTable.isDataTable(this)) {
                $(this).DataTable({
                    language: indonesianLang
                });
            }
        });

        // Auto adjust table columns on window resize
        let resizeTimer;
        $(window).on('resize', function() {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function() {
                $.fn.dataTable.tables({ visible: true, api: true }).columns.adjust().responsive.recalc();
            }, 200);
        });

        // Initialize tooltips on table draw
        $(document).on('draw.dt', function() {
            if (typeof bootstrap !== 'undefined' && bootstrap.Tooltip) {
                document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(function(el) {
                    if (!bootstrap.Tooltip.getInstance(el)) {
                        new bootstrap.Tooltip(el);
                    }
                });
            }
        });
    }

    // Initialize Bootstrap tooltips globally on load
    if (typeof bootstrap !== 'undefined' && bootstrap.Tooltip) {
        document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(function(el) {
            if (!bootstrap.Tooltip.getInstance(el)) {
                new bootstrap.Tooltip(el);
            }
        });
    }

    // Delete confirmation with SweetAlert2
    $(document).on('click', '.btn-delete', function(e) {
        e.preventDefault();
        const form = $(this).closest('form');
        Swal.fire({
            title: 'Apakah Anda yakin?',
            text: 'Data yang dihapus tidak dapat dikembalikan!',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            cancelButtonColor: '#6b7280',
            confirmButtonText: 'Ya, Hapus!',
            cancelButtonText: 'Batal'
        }).then((result) => {
            if (result.isConfirmed) {
                form.submit();
            }
        });
    });
});

// Format Currency Utility
function formatRupiah(amount) {
    return 'Rp ' + new Intl.NumberFormat('id-ID').format(amount);
}
