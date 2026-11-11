# LOKASI — Colokan Vokasi

Direktori fasilitas dengan database bersama Supabase, autentikasi admin, penyimpanan foto, dan pembaruan realtime.

## Status data awal

`supabase/schema.sql` mengisi delapan lokasi contoh sebagai seed awal. Data itu belum diverifikasi di lapangan dan harus diperiksa, diperbarui, atau dihapus sebelum direktori dipakai sebagai informasi operasional.

## Menyiapkan backend Supabase

1. Buat proyek Supabase untuk lingkungan pengembangan/produksi.
2. Jalankan seluruh isi `supabase/schema.sql` melalui SQL Editor proyek. Skrip membuat tabel, kebijakan Row Level Security, bucket foto, fungsi transaksi admin, sinkronisasi realtime, serta data seed.
3. Buat akun admin melalui Supabase Authentication (undang/buat pengguna; jangan mengaktifkan pendaftaran publik).
4. Berikan hak admin kepada pengguna tersebut melalui SQL Editor:

   ```sql
   insert into public.admin_users (user_id)
   select id from auth.users where email = 'admin@example.com';
   ```

   Gunakan email admin yang benar. Akun tanpa baris di `admin_users` tidak dapat mengakses dashboard.
5. Buat situs Cloudflare Turnstile untuk domain aplikasi, lalu catat site key dan secret key.
6. Isi `supabase-config.js` dengan Project URL, publishable/anon key, dan Turnstile site key. Publishable/anon key memang dipakai di browser; **jangan pernah** memasukkan service-role key atau Turnstile secret ke file frontend.
7. Deploy Edge Function `submit-report` dari folder `supabase/functions/submit-report` ke proyek tersebut (CLI membaca `supabase/config.toml`):

   ```powershell
   supabase login
   supabase link --project-ref your-project-ref
   supabase functions deploy submit-report
   supabase secrets set TURNSTILE_SECRET="replace-with-secret" TURNSTILE_EXPECTED_HOSTNAME="lokasi.example.id" ALLOWED_ORIGIN="https://lokasi.example.id" RATE_LIMIT_SALT="replace-with-random-secret"
   ```

   Karena function mematikan pemeriksaan JWT gateway, function sendiri wajib memvalidasi Turnstile, origin, dan rate limit seperti pada kode. Jangan menghapus validasi tersebut.

   - `TURNSTILE_SECRET`: Turnstile secret key.
   - `TURNSTILE_EXPECTED_HOSTNAME`: hostname produksi, tanpa protokol (misalnya `lokasi.example.id`).
   - `ALLOWED_ORIGIN`: origin situs yang tepat, misalnya `https://lokasi.example.id`.
   - `RATE_LIMIT_SALT`: nilai acak rahasia untuk meng-hash alamat IP sebelum disimpan sebagai penghitung rate limit.

   `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` disediakan oleh lingkungan Supabase Edge Functions. Pastikan function hanya mengizinkan origin situs yang benar. Aktifkan MFA untuk akun admin sebelum penggunaan produksi.
8. Host `index.html`, `app.js`, `styles.css`, dan `supabase-config.js` di layanan hosting HTTPS apa pun. Tambahkan domain produksi ke pengaturan URL/redirect Supabase Auth. Untuk lokal, jalankan server statis:

   ```powershell
   python -m http.server 8000
   ```

   Untuk pengujian lokal, sesuaikan sementara `ALLOWED_ORIGIN` dan hostname Turnstile dengan domain lokal yang didaftarkan.

## Akses dan sinkronisasi

- Pengunjung dapat membaca direktori; perubahan lokasi tersimpan di Supabase dan dikirim ke halaman lain melalui Supabase Realtime.
- Pengiriman laporan melewati Edge Function yang memvalidasi Turnstile, membatasi hingga lima laporan per jam per alamat IP, memvalidasi data, lalu menyimpan laporan/foto.
- Foto laporan berada di bucket privat dan hanya dapat dibuka admin. Foto lokasi dapat dibaca publik, tetapi hanya admin yang dapat mengubahnya.
- Hanya akun yang terdaftar di `admin_users` yang dapat membaca laporan/riwayat dan mengelola lokasi. Persetujuan/penolakan laporan dilakukan dalam transaksi database.
- Jangan berikan service-role key kepada browser. Pertahankan RLS dan Auth; uji kebijakan dengan akun publik dan admin sebelum membuka situs.
- Tetapkan kebijakan privasi dan masa retensi laporan/foto sebelum operasional. Form menjelaskan bahwa foto/laporan hanya terlihat oleh admin dan alamat IP di-hash untuk pembatasan spam.

## Menjalankan lokal

Situs memerlukan URL/key Supabase dan Edge Function yang sudah dideploy; tidak ada lagi fallback data lokal. Bila konfigurasi belum lengkap, fungsi backend tidak tersedia. Perubahan data tersimpan di database bersama, bukan `localStorage`.
