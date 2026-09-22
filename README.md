# ARUS — Traffic Intelligence

Aplikasi **Flask + HTML/CSS/JavaScript** yang menghubungkan notebook STGNN PEMS08 dengan dashboard responsif. Tidak perlu Node.js, build frontend, CDN, database eksternal, atau API key. Grafik menggunakan SVG. UI berbahasa Indonesia.

## Mulai cepat

Memerlukan Python **3.10–3.12**. Jalankan perintah dari direktori hasil ekstraksi:

```bash
python -m venv .venv
```

Aktifkan environment:

```bash
# Windows PowerShell
.venv\Scripts\Activate.ps1
# macOS / Linux
source .venv/bin/activate
```

```bash
python -m pip install -r requirements.txt
python app.py
```

Buka **http://127.0.0.1:5000**. Mode demo langsung tersedia. Jika port terpakai, set variabel lingkungan `PORT` ke port lain. Alternatif server WSGI lokal: `python serve.py` (Waitress, satu proses dengan thread).

## Yang tersedia

- Ringkasan flow, speed, occupancy, dan kelengkapan sensor pada sampel terakhir.
- Grafik historis dan forecast untuk sensor/horizon pilihan.
- Daftar sensor, pencarian, paginasi, serta ekspor prediksi per sensor ke CSV.
- Backtest eksploratif, MAE/RMSE/WAPE, serta pembanding persistence.
- Unggah dataset NPZ dan checkpoint PT dari notebook revisi.
- Tampilan desktop, tablet, dan ponsel; navigasi mobile dan fokus keyboard.
- Data dan pilihan model dipertahankan saat server dimulai ulang.

## Data demo dan model sebenarnya

Mode awal menghasilkan **data sintetis**, 24 sensor, interval 5 menit. Forecaster awal adalah **baseline tren teredam**, bukan STGNN yang sudah dilatih. Tidak ada checkpoint penelitian palsu dalam paket.

Formula baseline adalah `last_flow + slope × sum(0.82^k, k=0..h-1)`; slope dihitung dari selisih pengamatan terakhir dan tiga langkah sebelumnya. Output baseline dibatasi minimum nol. STGNN memakai output mentah tanpa clipping agar cocok dengan notebook.

Untuk memakai STGNN:

1. Jalankan notebook `notebooks/main.ipynb` yang disertakan hingga bagian **Simpan eksperimen**. Ambil `best_model.pt` yang dihasilkan.
2. Pasang dependensi model:

   ```bash
   python -m pip install -r requirements-model.txt
   ```

   Untuk wheel CPU saja, gunakan petunjuk resmi PyTorch sesuai platform. Aplikasi ini melakukan inference pada CPU.
3. Buka **Model & data**, unggah `pems08.npz`. Tentukan interval dan satuan yang benar. Default satuan unggahan adalah “skala asli” agar tidak mengasumsikan km/h atau fraksi.
4. Unggah `best_model.pt`. Jumlah sensor, jumlah fitur, dan interval diperiksa otomatis. **Urutan sensor tetap perlu dipastikan sama**; checkpoint notebook tidak menyimpan identitas geografis sensor.
5. Buka **Prediksi arus**, pilih sensor dan horizon, tekan **Jalankan prediksi**.

Jika checkpoint aktif berbeda jumlah sensor dengan dataset baru, tekan **Gunakan baseline** dahulu, unggah dataset baru, lalu hubungkan checkpoint yang cocok. Model hanya boleh berasal dari notebook revisi dalam percakapan ini, bukan notebook awal yang memakai `torch_geometric.GCNConv`.

Checkpoint demo dari notebook tetap ditandai sebagai sintetis. Training dilakukan di notebook, bukan melalui web.

## Format NPZ

```python
import numpy as np
# arr.shape = [time, nodes, 3]
# arr[..., 0] = flow; arr[..., 1] = occupancy; arr[..., 2] = speed
np.savez_compressed('pems08.npz', data=arr.astype(np.float32))
```

- Key wajib: `data`. Jenis numerik, 24–200.000 timestep, 1–2.000 sensor, tepat 3 fitur.
- Maksimum unggahan 80 MB; maksimum ukuran array setelah ekstraksi/konversi 180 MB.
- Nilai 0 tetap valid. NaN/inf tidak dipakai sebagai target evaluasi.
- Input STGNN yang hilang memakai median train tersimpan pada checkpoint. Input baseline menggunakan forward-fill dalam window, lalu nol untuk awalan yang tidak pernah teramati. Tidak memakai data target masa depan.
- Timestamp tidak dipakai. Sumbu waktu relatif terhadap sampel terakhir; interval ditentukan saat unggah. Tidak ada asumsi bahwa data baru saja direkam.
- Format `.npy` versi 1/2 di dalam NPZ didukung (format standar `np.savez_compressed`).

## Membaca metrik dengan benar

Backtest memakai **maksimal 64 origin terakhir** yang memiliki seluruh horizon, semua sensor dan horizon yang dipilih. Pengamatan terbaru diberikan pada setiap origin (*rolling-origin*). MAE, RMSE, dan WAPE menghitung seluruh target valid; window dapat overlap. WAPE kosong jika jumlah nilai absolut target adalah nol.

Perbaikan MAE = `100 × (1 − MAE_model / MAE_persistence)`. Positif berarti lebih baik; negatif berarti lebih buruk. Tidak ada interval keyakinan yang diklaim.

Ini **backtest eksploratif, bukan skor test independen**. Identitas dataset dan periode training tidak dapat diverifikasi dari checkpoint notebook; data yang diunggah mungkin overlap dengan training. Untuk angka laporan penelitian, gunakan evaluasi split kronologis di notebook. Skor web tidak boleh disebut bukti generalisasi tanpa validasi tersebut.

Status sensor “Lengkap” hanya menyatakan tiga fitur pada sampel terakhir finite. Bukan status koneksi hardware. Flow tinggi belum tentu macet. Aplikasi belum mencakup klasifikasi kemacetan, alert otomatis, peta geografis, atau feed real-time.

## Struktur proyek

```text
arus_flask/
  app.py                    # Routes, validasi request, CSRF, app factory
  serve.py                  # Waitress lokal
  service.py                # Dataset, baseline, backtest, persistence
  model.py                  # GCN + GRU kompatibel dengan checkpoint notebook
  requirements.txt          # Dependensi demo
  requirements-model.txt    # Tambahan PyTorch
  templates/index.html
  static/app.js
  static/style.css
  static/favicon.svg
  tests/test_app.py
  notebooks/main.ipynb       # Notebook training yang kompatibel
  instance/                 # Dibuat otomatis; data/model aktif serta session key
```

## API

| Endpoint | Fungsi |
|---|---|
| `GET /api/health` | Status aplikasi |
| `GET /api/dashboard?sensor=0&horizon=12` | Ringkasan, forecast, sensor, dan metrik; horizon dalam langkah |
| `GET /api/forecast.csv?sensor=0&horizon=12` | Forecast sensor terpilih; mencantumkan engine dan sumber |
| `GET /api/sample.npz` | Unduh dataset demo |
| `POST /api/data` | Multipart: `file`, `interval`, `speed_unit`, `occupancy_unit` |
| `POST /api/model` | Multipart: `file` (`.pt`) |
| `DELETE /api/model` | Lepas model; gunakan baseline dengan dataset yang sama |
| `POST /api/reset` | Aktifkan ulang demo |

Operasi perubahan memerlukan cookie sesi dan header `X-CSRF-Token`, diperoleh dari meta tag di halaman `/`. Respons error berbentuk `{"error":"pesan"}`. Checkpoint dimuat memakai `weights_only=True`, pada CPU, dan divalidasi.

## Penyimpanan dan deployment

Aplikasi ditujukan untuk **satu workspace lokal**; semua pengguna proses server yang sama memakai data/model yang sama. Endpoint perubahan diserialisasikan dengan lock. Jangan menjalankan beberapa worker proses terhadap folder data yang sama. `instance/` menyimpan dataset dan model aktif; `ARUS_DATA_DIR` dapat mengubah lokasi. `ARUS_SECRET_KEY` dapat mengatur kunci sesi.

Tidak ada autentikasi pengguna. Server default hanya mendengarkan `127.0.0.1` dan debug dimatikan. Untuk layanan publik/multiuser, tambahkan autentikasi, penyimpanan per pengguna, pembatasan sumber daya, HTTPS, dan job queue sebelum membuka akses.

## Pengujian

```bash
python -m pip install pytest
python -m pytest -q
```

Pengujian model otomatis dilewati jika PyTorch belum terpasang. Pengujian mencakup upload valid/rusak, batas bentuk array, prediksi, ekspor, CSRF, persistence saat restart, masking metrik, serta inferensi dari checkpoint sintetis yang kompatibel (bukan evaluasi PEMS08).

Dokumentasi resmi yang dirujuk saat implementasi:
- Flask uploads: https://flask.palletsprojects.com/en/stable/patterns/fileuploads/
- PyTorch loading: https://docs.pytorch.org/docs/stable/generated/torch.load

## Validasi paket ini

- 18 pengujian backend lolos.
- Adapter Flask menghasilkan output yang sama dengan kelas model notebook pada checkpoint demo hasil training sebelumnya.
- Interaksi browser diuji pada desktop 1440 px, tablet 768 px, dan ponsel 390/360 px tanpa overflow halaman. Tabel lebar memiliki scroll sendiri.
- Pemilihan sensor/horizon, CSV, pencarian, paginasi, unggah data, dan reset telah diuji tanpa error JavaScript.
- Dataset PEMS08 asli tidak disertakan; tidak ada klaim akurasi PEMS08 dari pengujian ini.
