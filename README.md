# Minuman Daily Login

Backend App Proxy (`/apps/rewards/*`) untuk popup daily check-in di theme.

## Alur

```
Popup theme ──POST /apps/rewards/checkin──► backend (Vercel)
                                              │ 1. cek + tulis metafield custom.loyalty_data
                                              │    { streak, last_checkin }  ← penanda saja, TANPA poin
                                              │ 2. flowTriggerReceive "daily-checkin-completed"
                                              ▼    { customer_id, Points, Cycle day, Checkin date }
                                         Shopify Flow
                                              │ Growave: Update customer points balance (+Points)
                                              ▼
                                           Growave  ← saldo koin, earn & redeem semuanya di sini
                                              │
Header "🪙 1,050" + "Your total rewards" ◄────┘ widget Growave (gw-rd-customer-points-balance-inline-widget-placeholder)
```

- Siklus 7 hari (`REWARD_CYCLE`, default `10,10,15,15,20,20,50`). Setelah Day 7, atau kalau bolong sehari, kembali ke Day 1.
- Kalau Flow menolak trigger (handle salah, app belum di-deploy), check-in hari itu dibatalkan supaya customer bisa coba lagi.
  Kalau hasilnya tidak pasti (network/5xx), check-in tetap tercatat supaya poin tidak terkirim dua kali. Cek di Flow → Run history.

## Endpoint

| Method | Path       | Isi                                                    |
| ------ | ---------- | ------------------------------------------------------ |
| GET    | `/status`  | posisi siklus: `todayIndex`, `checkedInToday`, `cycle` |
| POST   | `/checkin` | klaim hari ini, kirim poin ke Flow                     |

`/balance` masih ada sebagai alias `/status` untuk halaman yang masih memuat script lama.

## Setup

### 1. Deploy Flow trigger extension

Extension ada di `extensions/daily-checkin-completed`. Harus di-deploy ke **app yang sama** dengan pemilik
`SHOPIFY_ADMIN_API` token dan App Proxy (custom app Flow trigger hanya jalan di store Shopify Plus, minuman sudah Plus).

```bash
cd Daily-Login-Minuman
shopify app config link   # pilih app daily login yang sudah ada -> membuat shopify.app.toml
shopify app deploy
```

Scope yang dibutuhkan sekarang: `read_customers`, `write_customers` (`write_discounts` tidak dipakai lagi).

### 2. Workflow di Shopify Flow

1. Flow → Create workflow → trigger **Daily check-in completed** (dari app ini).
2. Action **Growave → Update customer points balance**
   - Customer: `{{customer.email}}`
   - Balance delta: variable **Points** (pilih lewat "Add a variable", biasanya `{{points}}`)
   - Reason: `Daily check-in day {{cycleDay}}`
3. Turn on workflow.

Catatan: Growave mencari customer berdasarkan email/telepon. Customer tanpa email akan gagal di step ini (terlihat di Run history).

Alternatif tanpa action Growave: action **Send HTTP request** ke `POST https://api.growave.io/v2/customers/updateBalance`
(`{"customerIdentifier": "{{customer.email}}", "balanceDelta": {{points}}, "reason": "Daily check-in"}`).
Butuh Growave API (plan Plus) dan access token OAuth yang punya masa berlaku, jadi action bawaan Growave lebih sederhana.

### 3. Theme

- Growave app embed harus aktif supaya saldo tampil di header dan popup.
- Section `daily-checkin` dimuat di `layout/theme.liquid` (popup di semua halaman). Setting "Coins per day" di section
  harus sama dengan `REWARD_CYCLE` (hanya untuk preview tamu; nilai yang dikirim tetap dari backend).

## Development

```bash
npm test
npm run dev
npm run proxy -- status 1234567890    # panggil lokal dengan signature App Proxy
npm run proxy -- checkin 1234567890   # PERHATIAN: memicu Flow sungguhan -> menambah poin Growave
```
