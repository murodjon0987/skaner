// =============================================================
// ScanPOS – Firebase konfiguratsiyasi
// =============================================================
// BU FAYLNI TO'LDIRISH TARTIBI:
// 1. https://console.firebase.google.com → loyihangizni oching
// 2. Project settings (⚙️) → General → "Your apps" → Web app (</>)
// 3. U yerdagi `firebaseConfig` qiymatlarini quyidagilarga qo'ying.
// 4. Authentication → Sign-in method:
//      - Google ni YOQING
//      - Email/Password ni YOQING
// 5. Authentication → Settings → Authorized domains:
//      - `localhost` va hosting domeningizni qo'shing
//
// ESLATMA: Firebase web config MAXFIY EMAS — u brauzerda ochiq turadi.
// Xavfsizlik Firestore Security Rules (firestore.rules) bilan ta'minlanadi.

window.firebaseConfig = {
  apiKey: "AIzaSyAsRH8on0BrXoZ63mIMz1nEL-CQ9iJAfxs",
  authDomain: "skanere-a797c.firebaseapp.com",
  projectId: "skanere-a797c",
  storageBucket: "skanere-a797c.firebasestorage.app",
  messagingSenderId: "83280010517",
  appId: "1:83280010517:web:247dc789c8cb199e4b1d1c"
};

// =============================================================
// TO'LOV MA'LUMOTLARI (shaxsiy ma'lumotlar app.js dan tashqarida)
// =============================================================
// - paymeLink / clickLink: haqiqiy merchant to'lov havolasini qo'ying.
//   Bo'sh qoldirilsa, ilova avtomatik ravishda faqat karta orqali
//   o'tkazma + chek yuborish oqimini ko'rsatadi.
//   Payme:  https://payme.uz/{merchant_id}
//   Click:  https://my.click.uz/services/pay?service_id=...&merchant_id=...
// - cardNumber / cardHolder: pul o'tkaziladigan karta.
// - supportTelegram: foydalanuvchi murojaat qiladigan Telegram havolasi.
window.SCANPOS_PAYMENT = {
  paymeLink: "",
  clickLink: "",
  cardNumber: "4067 0700 0861 0359",
  cardHolder: "SH. Murodjon",
  supportTelegram: "https://t.me/wenzone72"
};
