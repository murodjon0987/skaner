/**
 * ScanPOS – auth.js
 * =================
 * Firebase Authentication qatlami:
 *  - Google bilan kirish / ro'yxatdan o'tish (popup + mobil uchun redirect)
 *  - Email / parol bilan kirish va ro'yxatdan o'tish
 *  - Parolni tiklash (reset email)
 *  - onAuthStateChanged orqali sessiyani boshqarish
 *
 * app.js bilan integratsiya:
 *  - window.scanposOnLogin(user)   → app.js ichida (sessiya boshlanadi)
 *  - window.scanposOnLogout()      → app.js ichida (sessiya tugaydi)
 */

'use strict';

(function () {
  const cfg = window.firebaseConfig || {};
  window.isFirebaseConfigured = Boolean(
    cfg &&
    cfg.apiKey &&
    !String(cfg.apiKey).includes('REPLACE') &&
    cfg.projectId &&
    !String(cfg.projectId).includes('demo')
  );

  let firebaseApp = null;
  let firestoreMod = null;
  let authMod = null;
  let auth = null;

  const FIREBASE_VERSION = '10.12.0';
  const SDK_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

  // ── UI helpers ──
  function qs(id) { return document.getElementById(id); }

  function showAuthScreen() {
    const splash = qs('splash');
    if (splash) { splash.classList.add('out'); splash.style.display = 'none'; }
    const appEl = qs('app');
    if (appEl) appEl.classList.add('hidden');
    const screen = qs('authScreen');
    if (screen) screen.classList.remove('hidden');
  }

  function hideAuthScreen() {
    const screen = qs('authScreen');
    if (screen) screen.classList.add('hidden');
  }

  function showAuthError(msg) {
    const el = qs('authError');
    if (!el) { console.warn('[Auth]', msg); return; }
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function clearAuthError() {
    const el = qs('authError');
    if (el) { el.textContent = ''; el.classList.add('hidden'); }
  }

  function showDemoNotice(msg) {
    const box = qs('authDemoNotice');
    if (!box) return;
    if (msg) {
      const p = box.querySelector('p');
      if (p) p.textContent = msg;
    }
    box.classList.remove('hidden');
  }

  window.handleDemoContinue = function () {
    hideAuthScreen();
    window.useDemo = true;
    window.firebaseReady = true;
    window.triggerAppInit();
  };

  function setBusy(busy) {
    const btn = qs('authSubmitBtn');
    const google = qs('btnGoogle');
    const form = qs('authForm');
    if (btn) { btn.disabled = busy; btn.textContent = busy ? 'Yuklanmoqda...' : (authTab === 'register' ? "Ro'yxatdan o'tish" : 'Kirish'); }
    if (google) google.disabled = busy;
    if (form) form.querySelectorAll('input').forEach(i => { i.disabled = busy; });
  }

  function authErrorMessage(code) {
    switch (code) {
      case 'auth/invalid-email': return "Email manzil noto'g'ri kiritilgan.";
      case 'auth/missing-password': return 'Parolni kiriting.';
      case 'auth/weak-password': return "Parol juda kuchsiz (kamida 6 belgi).";
      case 'auth/email-already-in-use': return "Bu email allaqachon ro'yxatdan o'tgan. Kirish bo'limidan foydalaning.";
      case 'auth/user-not-found': return "Bunday foydalanuvchi topilmadi. Avval ro'yxatdan o'ting.";
      case 'auth/wrong-password':
      case 'auth/invalid-credential': return "Email yoki parol noto'g'ri.";
      case 'auth/too-many-requests': return "Juda ko'p urinish. Birozdan so'ng qayta urinib ko'ring.";
      case 'auth/network-request-failed': return 'Tarmoq xatosi. Internetni tekshiring.';
      case 'auth/popup-blocked': return 'Popup bloklandi. Qayta urinib ko\'ring yoki brauzer ruxsatini bering.';
      case 'auth/account-exists-with-different-credential': return "Bu email boshqa usulda ro'yxatdan o'tgan. Boshqa usulda kirib ko'ring.";
      case 'auth/operation-not-allowed': return "Bu kirish usuli Firebase'da yoqilmagan (Authentication → Sign-in method).";
      case 'auth/unauthorized-domain': {
        const host = (typeof window !== 'undefined' && window.location) ? window.location.hostname : '';
        const proto = (typeof window !== 'undefined' && window.location) ? window.location.protocol : '';
        if (proto === 'file:') {
          return "Ilova file:// orqali ochilgan. Login ishlashi uchun uni localhost orqali oching: terminalda `npm start` yoki `npx serve -l 3000 .`.";
        }
        return `Bu domen ("${host}") Firebase'da ruxsat etilmagan. Konsol → Authentication → Settings → Authorized domains ga "${host}" ni qo'shing.`;
      }
      case 'auth/invalid-api-key': return "Firebase API kaliti noto'g'ri. firebase-config.js ni tekshiring.";
      case 'auth/configuration-not-found': return "Autentifikatsiya sozlanmagan. Firebase'da Authentication → Get started va Sign-in method ni yoqing.";
      default: return (code ? String(code) : 'Xatolik yuz berdi. Qayta urinib ko\'ring.');
    }
  }

  // ── Tab (Kirish / Ro'yxatdan o'tish) ──
  let authTab = 'login';

  window.switchAuthTab = function (tab) {
    authTab = tab === 'register' ? 'register' : 'login';
    clearAuthError();
    const tabLogin = qs('tabLogin');
    const tabRegister = qs('tabRegister');
    const nameGroup = qs('authNameGroup');
    const submitBtn = qs('authSubmitBtn');
    const forgot = qs('btnForgot');
    if (tabLogin) tabLogin.classList.toggle('active', authTab === 'login');
    if (tabRegister) tabRegister.classList.toggle('active', authTab === 'register');
    if (nameGroup) nameGroup.style.display = authTab === 'register' ? '' : 'none';
    if (submitBtn) submitBtn.textContent = authTab === 'register' ? "Ro'yxatdan o'tish" : 'Kirish';
    if (forgot) forgot.style.display = authTab === 'login' ? '' : 'none';
    const pwd = qs('authPassword');
    if (pwd) pwd.setAttribute('autocomplete', authTab === 'register' ? 'new-password' : 'current-password');
  };

  // ── Google ──
  window.handleGoogleLogin = async function () {
    if (!auth) { showAuthError("Firebase ulanmagan. Sahifani yangilab qayta urinib ko'ring."); return; }
    clearAuthError();
    setBusy(true);
    try {
      const provider = new authMod.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await authMod.signInWithPopup(auth, provider);
      // Muvaffaqiyatda onAuthStateChanged ishlaydi
    } catch (e) {
      const code = e && e.code;
      const fallback = code === 'auth/popup-blocked' ||
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request' ||
        code === 'auth/operation-not-supported-in-this-environment' ||
        code === 'auth/web-storage-unsupported';
      if (fallback) {
        try {
          await authMod.signInWithRedirect(auth, provider);
          return;
        } catch (e2) {
          showAuthError(authErrorMessage(e2 && e2.code));
        }
      } else {
        showAuthError(authErrorMessage(code));
      }
    } finally {
      setBusy(false);
    }
  };

  // ── Email / parol formasi ──
  window.handleAuthSubmit = async function (event) {
    if (event) event.preventDefault();
    if (!auth) { showAuthError("Firebase ulanmagan. Sahifani yangilab qayta urinib ko'ring."); return false; }
    clearAuthError();

    const email = qs('authEmail') ? qs('authEmail').value.trim() : '';
    const password = qs('authPassword') ? qs('authPassword').value : '';
    const name = qs('authName') ? qs('authName').value.trim() : '';

    if (!email || !password) { showAuthError('Email va parolni kiriting.'); return false; }
    if (password.length < 6) { showAuthError("Parol kamida 6 belgidan iborat bo'lishi kerak."); return false; }

    setBusy(true);
    try {
      if (authTab === 'register') {
        const cred = await authMod.createUserWithEmailAndPassword(auth, email, password);
        if (name && cred.user) {
          try { await authMod.updateProfile(cred.user, { displayName: name }); } catch (e) {}
        }
      } else {
        await authMod.signInWithEmailAndPassword(auth, email, password);
      }
    } catch (e) {
      showAuthError(authErrorMessage(e && e.code));
    } finally {
      setBusy(false);
    }
    return false;
  };

  // ── Parolni tiklash ──
  window.handlePasswordReset = async function () {
    if (!auth) return;
    clearAuthError();
    const email = qs('authEmail') ? qs('authEmail').value.trim() : '';
    if (!email) { showAuthError("Avval email manzilingizni kiriting, so'ng \"Parolni tiklash\"ni bosing."); return; }
    try {
      await authMod.sendPasswordResetEmail(auth, email);
      if (typeof window.showToast === 'function') {
        window.showToast(`Parolni tiklash havolasi yuborildi: ${email}`, 'success');
      } else {
        showAuthError(`Parolni tiklash havolasi yuborildi: ${email}`);
      }
    } catch (e) {
      showAuthError(authErrorMessage(e && e.code));
    }
  };

  window.handleSignOut = async function () {
    if (!auth) return;
    if (!confirm('Hisobdan chiqishni tasdiqlaysizmi?')) return;
    try {
      await authMod.signOut(auth);
    } catch (e) {
      console.warn('Chiqish xatosi:', e);
    }
  };

  // ── Firebase init ──
  async function initAuth() {
    if (!window.isFirebaseConfigured) {
      console.log("ℹ️ Demo rejim (Firebase kaliti kiritilmagan)");
      window.useDemo = true;
      window.firebaseReady = true;
      showDemoNotice("Firebase hali sozlanmagan. firebase-config.js fayliga loyihangiz kalitlarini kiriting — shundan so'ng Google va email orqali kirish ishlaydi.");
      showAuthScreen();
      return;
    }

    try {
      const appMod = await import(`${SDK_BASE}/firebase-app.js`);
      firestoreMod = await import(`${SDK_BASE}/firebase-firestore.js`);
      authMod = await import(`${SDK_BASE}/firebase-auth.js`);

      firebaseApp = appMod.initializeApp(cfg);
      const db = firestoreMod.getFirestore(firebaseApp);
      auth = authMod.getAuth(firebaseApp);

      // Sessiya saqlanishi (tab yopilsa ham)
      try { await authMod.setPersistence(auth, authMod.browserLocalPersistence); } catch (e) {}

      window.firebaseAuth = auth;
      window.firebaseDB = db;
      window.firebaseFns = {
        collection: firestoreMod.collection,
        doc: firestoreMod.doc,
        getDoc: firestoreMod.getDoc,
        getDocs: firestoreMod.getDocs,
        setDoc: firestoreMod.setDoc,
        addDoc: firestoreMod.addDoc,
        updateDoc: firestoreMod.updateDoc,
        deleteDoc: firestoreMod.deleteDoc,
        onSnapshot: firestoreMod.onSnapshot,
        serverTimestamp: firestoreMod.serverTimestamp,
        writeBatch: firestoreMod.writeBatch,
        increment: firestoreMod.increment
      };

      // Mobil redirect natijasini qayta ishlash
      try { await authMod.getRedirectResult(auth); } catch (e) {}

      authMod.onAuthStateChanged(auth, async (user) => {
        if (user) {
          hideAuthScreen();
          if (typeof window.scanposOnLogin === 'function') {
            await window.scanposOnLogin(user);
          }
        } else {
          if (typeof window.scanposOnLogout === 'function') {
            window.scanposOnLogout();
          }
          showAuthScreen();
          if (window.location.protocol === 'file:') {
            showAuthError('Ilova file:// orqali ochilgan. Login ishlashi uchun `npm start` buyrug\'i bilan ochib, brauzerda http://localhost:3000 manziliga o\'ting.');
          }
        }
      });
    } catch (e) {
      console.warn('[Auth] Firebase yuklanmadi, demo rejimga o\'tildi:', e);
      window.useDemo = true;
      window.firebaseReady = true;
      showDemoNotice("Firebase'ga ulanib bo'lmadi (tarmoq yoki kalit xatosi). Demo rejimda davom etishingiz mumkin.");
      showAuthScreen();
    }
  }

  window.scanposAuth = {
    init: initAuth,
    signOut: window.handleSignOut,
    get user() { return auth && auth.currentUser; },
    get isPasswordProvider() {
      const u = auth && auth.currentUser;
      if (!u || !u.providerData) return false;
      return u.providerData.some(p => p.providerId === 'password');
    },
    async updateDisplayName(name) {
      if (!auth || !auth.currentUser || !name) return;
      await authMod.updateProfile(auth.currentUser, { displayName: name });
    },
    async updatePhotoURL(url) {
      if (!auth || !auth.currentUser) return;
      await authMod.updateProfile(auth.currentUser, { photoURL: url || null });
    },
    async changePassword(currentPassword, newPassword) {
      const u = auth && auth.currentUser;
      if (!u || !u.email) throw new Error('no-user');
      const cred = authMod.EmailAuthProvider.credential(u.email, currentPassword);
      await authMod.reauthenticateWithCredential(u, cred);
      await authMod.updatePassword(u, newPassword);
    }
  };

  // app.js yuklangach ishga tushamiz (window.initApp mavjud bo'lishi uchun)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuth, { once: true });
  } else {
    initAuth();
  }
})();
