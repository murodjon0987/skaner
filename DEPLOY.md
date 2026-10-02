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

## 5. Sozlash (app.js)

`app.js` boshidagi konfiguratsiyalar:
- `ADMIN_EMAIL` — admin panel shu emailga bog'langan.
- `PLANS` — tariflar (Bepul / Standart / Biznes).
- `PAYMENT_INFO` — qabul qiluvchi karta, Payme/Click havolalari.

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
