# ScanPOS — Deploy qo'llanmasi

Bu ilova **statik PWA** (build talab qilmaydi). Backend — Firebase (Auth + Firestore).

---

## 1. Firebase (bir marta sozlanadi)

1. https://console.firebase.google.com → loyiha: `skanere-a797c`
2. **Authentication → Sign-in method**: `Google` va `Email/Password` yoqilgan.
3. **Authentication → Settings → Authorized domains**:
   - `localhost` (lokal test uchun, default bor)
   - Vercel domeni (deploydan keyin qo'shiladi)
4. **Firestore Database** yaratilgan (production mode).
5. **Firestore → Rules**: `firestore.rules` mazmunini joylab **Publish** qiling.

Kalitlar `firebase-config.js` faylida (maxfiy emas — ochiq bo'lishi normal).

---

## 2. Firestore Rules'ni deploy qilish

### A) Console orqali (eng oson)
Firestore → **Rules** → kod maydoniga `firestore.rules` mazmunini qo'yib **Publish**.

### B) CLI orqali
```bash
npx firebase-tools login
npm run deploy:rules
```

---

## 3. Vercel'ga deploy (GitHub ulangan)

1. https://vercel.com → **Add New → Project** → `murodjon0987/skaner` repo'ni Import.
2. Sozlamalar:
   - **Framework Preset**: `Other`
   - **Build Command**: bo'sh
   - **Output Directory**: `.`
   - **Install Command**: bo'sh
3. **Deploy**.
4. Deploy URL'ni oling: masalan `https://skaner-xxxx.vercel.app`.

> GitHub'ga har push qilganda Vercel avtomatik qayta deploy qiladi.

---

## 4. Authorized domain qo'shish (majburiy!)

Vercel URL'ni **https://siz**siz nusxalab:
- Firebase Console → **Authentication → Settings → Authorized domains → Add domain** → `skaner-xxxx.vercel.app`

Aks holda Google bilan kirishda `auth/unauthorized-domain` xatosi chiqadi.

---

## 5. Sozlash

### `firebase-config.js`
- `window.firebaseConfig` — Firebase kalitlari.
- `window.SCANPOS_PAYMENT` — to'lov ma'lumotlari (shaxsiy ma'lumotlar **app.js** da emas, shu faylda):
  - `paymeLink` / `clickLink` — haqiqiy merchant to'lov havolalari. Bo'sh qoldirilsa, ilova avtomatik faqat
    karta orqali o'tkazma + chek yuborish oqimini ko'rsatadi. Payme: `https://payme.uz/{merchant_id}`,
    Click: `https://my.click.uz/services/pay?service_id=...&merchant_id=...`.
  - `cardNumber` / `cardHolder` — pul o'tkaziladigan karta.
  - `supportTelegram` — foydalanuvchi uchun Telegram yordam havolasi (Paywall, Sozlamalar, pricing.html).

### `app.js` (faqat umumiy sozlamalar)
- `ADMIN_EMAILS` — admin panel shu emaillarga bog'langan. **Kodli admin backdoor olib tashlangan.**
- `PLANS` — tariflar (Bepul / Standart / Biznes).

### Firestore Rules
- `admins/{uid}` allowlist'ni faqat mavjud admin boshqaradi (kod orqali o'zini admin qilish mumkin emas).
- Rules'ni `npm run deploy:rules` bilan qayta deploy qiling.

---

## 6. Sinash

- Deploy URL'ni oching → Google/email bilan kiring.
- **Admin**: `ADMIN_EMAIL` bilan kirib → avatar menyu → **Admin panel**.
- Obuna: Sozlamalar → Obuna → tarif → chek yuklash → admin tasdiqlaydi.

---

## Lokal ishga tushirish

```bash
npm start        # http://localhost:3000
npm test         # smoke testlar
```
