# MINUMAN DAILY LOGIN BACKEND

## Backend Daily Login Minuman

Service ini adalah backend Express untuk fitur **Daily Check-in** customer Minuman. Customer bisa klaim koin satu kali per
hari dalam siklus 7 hari. Data check-in sama dengan website: kalau customer sudah check-in di website, mobile app akan
membaca status yang sama, begitu juga sebaliknya.

### Base URL (Endpoint)

- Production: `https://daily-login-minuman.vercel.app`

### Autentikasi

Semua endpoint wajib mengirim token dari tim Minuman di header:

```
Authorization: Bearer <MOBILE_API_TOKEN>
```

> Token diberikan terpisah oleh tim Minuman. Jangan di-commit ke repository publik dan jangan ditampilkan di log.

### Identitas Customer

Setiap request wajib menyertakan **salah satu** dari:

- `customerId`: Shopify Customer ID, bisa numeric (`"7712345678901"`) atau GID (`"gid://shopify/Customer/7712345678901"`)
- `email`: email customer yang terdaftar di Shopify

Kalau dua-duanya dikirim, `customerId` yang dipakai.

### Endpoint Overview

1. `GET /mobile/status`
2. `POST /mobile/checkin`

---

## 1) Check-in Status

### `GET /mobile/status`

Ambil status check-in customer hari ini: hari ke berapa dalam siklus, sudah klaim atau belum, dan koin per hari.
Endpoint ini **hanya membaca** (READ), tidak mengubah data apa pun, jadi aman dipanggil berkali-kali.

### Behavior

- Customer yang belum pernah check-in atau streak-nya putus akan mulai dari Day 1.
- Pergantian hari mengikuti jam **00:00 WIB (Asia/Jakarta)**, bukan jam di device.
- Tidak mengembalikan saldo koin. Saldo koin ada di Growave (lihat bagian **Saldo Koin**).

### Required Headers

- `Authorization: Bearer <MOBILE_API_TOKEN>`

### Optional / Recommended Headers

- `Accept: application/json`

### Query Params

| Param | Wajib | Contoh |
| --- | --- | --- |
| `customerId` | salah satu | `7712345678901` |
| `email` | salah satu | `customer@example.com` |

### Request

```
GET /mobile/status?customerId=7712345678901
GET /mobile/status?email=customer@example.com
```

### Success Response (200) — belum check-in hari ini

```json
{
  "ok": true,
  "data": {
    "streak": 0,
    "checkedInToday": false,
    "today": "2026-10-30",
    "cycle": [10, 10, 15, 15, 20, 20, 50],
    "completedInCycle": 0,
    "todayIndex": 0,
    "nextReward": 10
  }
}
```

### Success Response (200) — sudah check-in hari ini (Day 3)

```json
{
  "ok": true,
  "data": {
    "streak": 3,
    "checkedInToday": true,
    "today": "2026-10-30",
    "cycle": [10, 10, 15, 15, 20, 20, 50],
    "completedInCycle": 3,
    "todayIndex": 2,
    "nextReward": 15
  }
}
```

### Penjelasan Field `data`

| Field | Tipe | Keterangan |
| --- | --- | --- |
| `streak` | number | Hari terakhir yang sudah diklaim dalam siklus (0–7). `0` = belum ada / streak putus |
| `checkedInToday` | boolean | `true` kalau hari ini sudah klaim (dari mobile **atau** website) |
| `today` | string | Tanggal hari ini (WIB), format `YYYY-MM-DD` |
| `cycle` | number[] | Koin per hari, Day 1 sampai Day 7 |
| `completedInCycle` | number | Jumlah hari yang sudah diklaim di siklus berjalan |
| `todayIndex` | number | Index kartu hari ini di `cycle` (mulai dari 0) |
| `nextReward` | number | Belum klaim: koin yang didapat **hari ini**. Sudah klaim: koin untuk **besok** |

Cara menampilkan 7 kartu hari:

```js
data.cycle.forEach((coins, i) => {
  const claimed = i < data.completedInCycle; // kartu sudah diambil
  const isToday = i === data.todayIndex;     // kartu hari ini
});
const canClaim = !data.checkedInToday;       // tombol "Claim" aktif atau tidak
```

### Error Responses

- `400` jika `customerId` / `email` tidak dikirim atau formatnya salah
- `401` jika token tidak ada atau salah
- `404` jika customer tidak ditemukan di Shopify
- `500` untuk error internal

---

## 2) Claim Check-in

### `POST /mobile/checkin`

Klaim check-in hari ini. Endpoint ini **mengubah data** (UPDATE): menandai hari ini sudah diklaim lalu menambahkan koin ke
saldo Growave customer.

### Behavior

- Satu customer hanya bisa klaim **satu kali per hari**, dari mobile maupun website. Klaim kedua akan mendapat
  `409 already_checked_in`.
- Koin yang didapat sesuai hari dalam siklus: `cycle[todayIndex]`.
- Setelah Day 7, atau kalau customer bolong satu hari, siklus kembali ke Day 1.
- Koin masuk ke saldo Growave secara **asinkron**, biasanya beberapa detik setelah response 200.
- Aman di-retry: kalau request timeout lalu dikirim ulang, koin tidak akan dobel (request kedua mendapat `409`).

### Required Headers

- `Authorization: Bearer <MOBILE_API_TOKEN>`
- `Content-Type: application/json`

### Optional / Recommended Headers

- `Accept: application/json`

### Request Body

```json
{
  "customerId": "7712345678901"
}
```

atau

```json
{
  "email": "customer@example.com"
}
```

### Success Response (200)

`reward` = jumlah koin yang ditambahkan untuk check-in ini.

```json
{
  "ok": true,
  "reward": 15,
  "data": {
    "streak": 3,
    "checkedInToday": true,
    "today": "2026-10-30",
    "cycle": [10, 10, 15, 15, 20, 20, 50],
    "completedInCycle": 3,
    "todayIndex": 2,
    "nextReward": 15
  }
}
```

### Accepted Response (202) — koin sedang diproses

Check-in **sudah tercatat**, tapi konfirmasi penambahan koin belum diterima. Koin tetap akan dicek dan diproses oleh tim
Minuman. Perlakukan sebagai **sukses** dan **jangan retry**.

```json
{
  "ok": false,
  "error": "reward_pending",
  "data": {
    "streak": 3,
    "checkedInToday": true,
    "today": "2026-10-30",
    "cycle": [10, 10, 15, 15, 20, 20, 50],
    "completedInCycle": 3,
    "todayIndex": 2,
    "nextReward": 15
  }
}
```

### Already Checked In (409)

Hari ini sudah diklaim, bisa dari mobile atau dari website. Response menyertakan `data` terbaru untuk update UI. Ini
**bukan error** yang perlu ditampilkan ke customer.

```json
{
  "ok": false,
  "error": "already_checked_in",
  "data": {
    "streak": 3,
    "checkedInToday": true,
    "today": "2026-10-30",
    "cycle": [10, 10, 15, 15, 20, 20, 50],
    "completedInCycle": 3,
    "todayIndex": 2,
    "nextReward": 15
  }
}
```

### Error Responses

- `400` jika `customerId` / `email` tidak dikirim atau formatnya salah
- `401` jika token tidak ada atau salah
- `404` jika customer tidak ditemukan di Shopify
- `409` (`busy_try_again`) jika ada request klaim lain untuk customer yang sama di saat bersamaan
- `424` (`reward_failed`) jika koin gagal ditambahkan. Klaim hari ini **dibatalkan**, customer bisa klaim lagi
- `500` untuk error internal

Contoh body error (semua error memakai format yang sama):

```json
{
  "ok": false,
  "error": "reward_failed"
}
```

---

## Daftar Kode Error

Semua response berformat `{ "ok": boolean, "error"?: string, "reward"?: number, "data"?: object }`.
**Selalu cek field `error`**, karena status `409` dipakai untuk dua kondisi berbeda.

| HTTP | `error` | Ada `data`? | Arti | Yang harus dilakukan app |
| --- | --- | --- | --- | --- |
| 200 | — | Ya | Berhasil | Tampilkan `+reward` koin, refresh saldo |
| 202 | `reward_pending` | Ya | Check-in tercatat, koin sedang diproses | Anggap sukses, tampilkan "Koin sedang diproses", jangan retry |
| 409 | `already_checked_in` | Ya | Hari ini sudah diklaim | Update UI dari `data`, tanpa pesan error |
| 409 | `busy_try_again` | Tidak | Ada klaim bersamaan | Panggil `GET /mobile/status`, retry sekali kalau `checkedInToday` masih `false` |
| 424 | `reward_failed` | Tidak | Koin gagal ditambahkan, klaim dibatalkan | Tampilkan "Gagal klaim, coba lagi", tombol klaim tetap aktif |
| 400 | `customer_required` | Tidak | `customerId` dan `email` tidak dikirim | Cek request |
| 400 | `invalid_customer` | Tidak | Format `customerId` salah | Cek request |
| 400 | `invalid_email` | Tidak | Format `email` salah | Cek request |
| 401 | `token_required` | Tidak | Header `Authorization` tidak ada | Cek konfigurasi app |
| 401 | `invalid_token` | Tidak | Token salah | Cek konfigurasi app / minta token baru |
| 404 | `customer_not_found` | Tidak | Customer tidak ada di Shopify | Minta customer login ulang |
| 500 | `server_error` | Tidak | Error internal | Tampilkan "Coba lagi nanti", panggil `GET /mobile/status` |
| 503 | `mobile_api_disabled` | Tidak | Endpoint mobile belum diaktifkan di server | Hubungi tim Minuman |

---

## Saldo Koin

Backend ini **tidak** mengembalikan saldo koin. Saldo, riwayat poin, dan redeem dikelola oleh **Growave**. Setelah
`POST /mobile/checkin` sukses, saldo di Growave bertambah beberapa detik kemudian, jadi tampilkan `+reward` terlebih
dahulu lalu refresh saldo setelahnya.

Customer harus punya **email** di akun Shopify supaya koin bisa masuk ke Growave.

---

## Best Practice Hit Semua Endpoint

1. **Selalu kirim header yang benar**
   - `Authorization: Bearer <MOBILE_API_TOKEN>` di setiap request
   - `Content-Type: application/json` untuk `POST`
2. **Gunakan identitas customer yang konsisten**
   - Disarankan pakai `customerId` (paling cepat dan pasti)
   - Pakai `email` hanya kalau `customerId` tidak tersedia
3. **Jangan hitung tanggal atau streak sendiri di app**
   - Selalu pakai `today`, `todayIndex`, `checkedInToday` dari response
   - Pergantian hari mengikuti 00:00 WIB, bukan jam device
4. **Refresh status secara berkala**
   - Panggil `GET /mobile/status` setiap layar daily check-in dibuka dan saat app kembali dari background
     (customer mungkin baru check-in di website)
   - Jangan cache response
5. **Handle error code dengan benar**
   - Bedakan `409` berdasarkan field `error`
   - `202 reward_pending` dianggap sukses
   - `400`: validasi request gagal, jangan retry
   - `404`: customer tidak ditemukan
   - `424` / `500`: tampilkan pesan, lalu sinkron ulang dengan `GET /mobile/status`
6. **Tambahkan timeout & retry policy di client**
   - Gunakan timeout request (mis. 10–15 detik)
   - Kalau `POST /mobile/checkin` timeout, panggil `GET /mobile/status` dulu. Retry hanya kalau `checkedInToday` masih `false`
   - Retry aman, koin tidak akan dobel
7. **Jaga kerahasiaan token**
   - Jangan tampilkan token di log, screenshot, atau error message
