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
