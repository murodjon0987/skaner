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
  apiKey: "AIzaSyDEMO_REPLACE_WITH_YOUR_KEY",
  authDomain: "scanpos-demo.firebaseapp.com",
  projectId: "scanpos-demo",
  storageBucket: "scanpos-demo.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef123456"
};
