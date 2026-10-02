/**
 * ScanPOS – app.js
 * ================
 * Texnologiyalar:
 * - BarcodeDetector API (native Chrome/Android) — 100% aniq skaner
 * - ZXing (@zxing/browser) — BarcodeDetector yo'q bo'lsa fallback
 * - Firebase Firestore — real vaqt ma'lumotlar bazasi
 * - Web Speech API (SpeechSynthesis) — ovozli e'lon
 * - localStorage — offline/demo rejim
 */

'use strict';

// ─────────────────────────────────────────────
// GLOBAL STATE
// ─────────────────────────────────────────────
const APP = {
 cart: [], // { id, barcode, barcodes:[], name, price, qty, category }
 products: [], // barcha mahsulotlar
 bills: [], // cheklar tarixi
 settings: {}, // sozlamalar
 categoryPrices: {}, // toifalar bo‘yicha standart narxlar (avtomatik eslab qolish)
 debtors: [], // { id, name, phone, note, createdAt }
 debts: [], // { id, debtorId, amount, paidAmount, description, dueDate, createdAt, payments:[] }
 currentPage: 'scanner',
 cameraStream: null,
 scanning: false,
 scannerLoop: null,
 barcodeDetector: null,
 lastScanned: '',
 lastScannedTime: 0,
 scanCooldown: 2000, // ms — bir xil kodni qayta o‘qimaslik
 voiceOn: true,
 selectedPayment: 'cash',
 editingProductId: null,
 foundProduct: null,
 torchOn: false, // Kamera fonari (torch)
 quickItems: [], // Tezkor kodsiz tovarlar ro‘yxati
 currentBillForPrint: null,
 _currentLinkTargetId: null,
 heldCarts: [], // Kutishdagi savatlar
 supplies: [], // Tovar kirimlari jurnali
 auditItems: [], // Ombor sanog'i (reviziya) ro'yxati
 activeAuditProduct: null,
 activeSupplyProduct: null,
 expenses: [], // Do'kon xarajatlari { id, title, category, amount, date, note }
 _filterExpiringStock: false, // Muddati tugayotgan tovarlarni filtrlash holati
 subscriptionData: null, // Firestore'dagi obuna profili (users/{uid})
};

// ─────────────────────────────────────────────
// USER-SCOPED STORAGE NAMESPACE
// ─────────────────────────────────────────────
// Har bir foydalanuvchi ma'lumotlari (local) bir-biridan ajratiladi.
// Kirgan foydalanuvchi uchun window.storageNs = 'u_<uid>'.
// Demo rejimda namespace bo'sh bo'ladi (eski xatti-harakat saqlanadi).
function nsKey(key) {
 if (typeof window !== 'undefined' && window.storageNs) {
  return 'scanpos_ns_' + window.storageNs + '__' + key;
 }
 return key;
}

// ─────────────────────────────────────────────
// FIRESTORE USER-SCOPED PATHS (multi-tenant)
// ─────────────────────────────────────────────
function userCol(name) {
 if (!window.firebaseDB || !window.firebaseFns) return null;
 if (window.currentUser && window.currentUser.uid) {
  return window.firebaseFns.collection(window.firebaseDB, 'users', window.currentUser.uid, name);
 }
 // Demo/legacy fallback (foydalanuvchi yo'q) — global kolleksiya
 return window.firebaseFns.collection(window.firebaseDB, name);
}

function userDoc(name, id) {
 if (!window.firebaseDB || !window.firebaseFns) return null;
 if (window.currentUser && window.currentUser.uid) {
  return window.firebaseFns.doc(window.firebaseDB, 'users', window.currentUser.uid, name, id);
 }
 // Demo/legacy fallback (foydalanuvchi yo'q) — global hujjat
 return window.firebaseFns.doc(window.firebaseDB, name, id);
}

async function cloudSet(name, id, data) {
 if (window.useDemo || !window.firebaseDB || !window.firebaseFns || !window.currentUser) return;
 try {
  await window.firebaseFns.setDoc(userDoc(name, id), data);
 } catch (e) {
  console.warn(`cloudSet(${name}) xato:`, e);
 }
}

async function cloudDelete(name, id) {
 if (window.useDemo || !window.firebaseDB || !window.firebaseFns || !window.currentUser) return;
 try {
  await window.firebaseFns.deleteDoc(userDoc(name, id));
 } catch (e) {
  console.warn(`cloudDelete(${name}) xato:`, e);
 }
}

// ─────────────────────────────────────────────
// INDEXED DB WRAPPER (ScanDB)
// ─────────────────────────────────────────────
const ScanDB = {
 dbName: 'scanpos_idb',
 storeName: 'keyval',
 _db: null,
 _opQueue: Promise.resolve(),
 async getDb() {
 if (this._db) return this._db;
 if (typeof indexedDB === 'undefined') return null;
 return new Promise((resolve) => {
 try {
 const req = indexedDB.open(this.dbName, 1);
 req.onupgradeneeded = (e) => {
 const db = e.target.result;
 if (!db.objectStoreNames.contains(this.storeName)) {
 db.createObjectStore(this.storeName);
 }
 };
 req.onsuccess = () => { this._db = req.result; resolve(this._db); };
 req.onerror = () => resolve(null);
 } catch (err) {
 resolve(null);
 }
 });
 },
 async get(key, defaultVal = null) {
 key = nsKey(key);
 try {
  const db = await this.getDb();
  if (!db) {
  const v = localStorage.getItem('idb_' + key);
 return v ? JSON.parse(v) : defaultVal;
 }
 return new Promise((resolve) => {
 try {
 const tx = db.transaction(this.storeName, 'readonly');
 const req = tx.objectStore(this.storeName).get(key);
 req.onsuccess = () => resolve(req.result !== undefined ? req.result : defaultVal);
 req.onerror = () => resolve(defaultVal);
 } catch (e) {
 resolve(defaultVal);
 }
 });
 } catch (e) {
 return defaultVal;
 }
 },
 async set(key, value) {
 key = nsKey(key);
 const run = async () => {
 try {
 const db = await this.getDb();
 if (!db) {
 try {
 localStorage.setItem('idb_' + key, JSON.stringify(value));
 return true;
 } catch (e) {
 return false;
 }
 }
 return new Promise((resolve) => {
 try {
 const tx = db.transaction(this.storeName, 'readwrite');
 tx.oncomplete = () => resolve(true);
 tx.onabort = () => resolve(false);
 tx.onerror = () => resolve(false);
 const req = tx.objectStore(this.storeName).put(value, key);
 req.onerror = () => resolve(false);
 } catch (err) {
 resolve(false);
 }
 });
 } catch (e) {
 return false;
 }
 };
 this._opQueue = this._opQueue.catch(() => {}).then(run);
 return this._opQueue;
 },
 async delete(key) {
 key = nsKey(key);
 const run = async () => {
 try {
 const db = await this.getDb();
 if (!db) {
 try {
 localStorage.removeItem('idb_' + key);
 return true;
 } catch (e) {
 return false;
 }
 }
 return new Promise((resolve) => {
 try {
 const tx = db.transaction(this.storeName, 'readwrite');
 tx.oncomplete = () => resolve(true);
 tx.onabort = () => resolve(false);
 tx.onerror = () => resolve(false);
 const req = tx.objectStore(this.storeName).delete(key);
 req.onerror = () => resolve(false);
 } catch (err) {
 resolve(false);
 }
 });
 } catch (e) {
 return false;
 }
 };
 this._opQueue = this._opQueue.catch(() => {}).then(run);
 return this._opQueue;
 }
};

// ─────────────────────────────────────────────
// UTILS & HELPERS (Timeout, Product, Phone)
// ─────────────────────────────────────────────
function withTimeout(promise, ms = 10000) {
 return Promise.race([
 promise,
 new Promise((_, reject) => setTimeout(() => reject(new Error('Firestore timeout')), ms))
 ]);
}

// ─────────────────────────────────────────────
// SUBSCRIPTION / PLANS (Obuna va tariflar)
// ─────────────────────────────────────────────
const ADMIN_EMAIL = 'syodgorov47@gmail.com';
const TRIAL_DAYS = 14;

const PLANS = {
 free: {
  key: 'free', name: 'Bepul', price: 0, priceLabel: "0 so'm",
  productLimit: 100, userLimit: 1,
  features: ['100 tagacha mahsulot', '1 foydalanuvchi', 'Asosiy hisobot', 'Skaner va savat']
 },
 standard: {
  key: 'standard', name: 'Standart', price: 49000, priceLabel: "49 000 so'm/oy",
  productLimit: Infinity, userLimit: 2,
  features: ["Cheksiz mahsulot", "To'liq analitika", 'Nasiya daftar', '2 foydalanuvchi', 'Ustuvor qo\'llab-quvvatlash']
 },
 business: {
  key: 'business', name: 'Biznes', price: 149000, priceLabel: "149 000 so'm/oy",
  productLimit: Infinity, userLimit: 50,
  features: ["Standart'dagi hammasi", "Ko'p filial (tez orada)", 'Rollar va audit', 'Eksport (PDF/Excel)', 'Shaxsiy menejer']
 }
};
const YEARLY_MONTHS_PAID = 10;

// DIQQAT: TO'LOV MA'LUMOTLARI — bularni o'zingiznikiga almashtiring!
const PAYMENT_INFO = {
 paymeLink: 'https://payme.uz/',
 clickLink: 'https://click.uz/',
 cardNumber: '8600 0000 0000 0000',
 cardHolder: 'S. Yodgorov',
 supportTelegram: 'https://t.me/'
};

function planByKey(key) { return PLANS[key] || PLANS.free; }

function isAdminUser(user) {
 const u = user || (typeof window !== 'undefined' ? window.currentUser : null);
 if (!u) return false;
 return String(u.email || '').toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

function _toDate(v) {
 if (!v) return null;
 const d = new Date(v);
 return isNaN(d.getTime()) ? null : d;
}

// Foydalanuvchining amaldagi obuna holati
function getAccessState() {
 // Demo/lokal rejim (hisob yo'q) — to'liq imkoniyat
 if (typeof window !== 'undefined' && !window.currentUser) {
  return {
   status: 'demo', planKey: 'business', plan: PLANS.business,
   isActive: true, isAdmin: false, daysLeft: 0,
   productLimit: Infinity, trialEndsAt: null, subscription: {}
  };
 }
 const data = (APP.subscriptionData) || {};
 const sub = data.subscription || {};
 const now = Date.now();
 const trialEnd = _toDate(data.trialEndsAt);
 const subEnd = _toDate(sub.expiresAt);

 let status = 'free';
 let activePlan = 'free';
 if (sub && sub.status === 'active' && subEnd && subEnd.getTime() > now) {
  status = 'active';
  activePlan = sub.plan || data.plan || 'standard';
 } else if (trialEnd && trialEnd.getTime() > now) {
  status = 'trial';
  activePlan = 'business'; // sinov davrida to'liq imkoniyat
 } else if ((subEnd && subEnd.getTime() <= now) || (trialEnd && trialEnd.getTime() <= now)) {
  status = 'expired';
  activePlan = 'free';
 } else {
  status = 'free';
  activePlan = 'free';
 }
 const plan = planByKey(activePlan);
 const daysLeft = trialEnd ? Math.max(0, Math.ceil((trialEnd.getTime() - now) / 86400000)) : 0;
 return {
  status, planKey: activePlan, plan,
  isActive: status === 'active' || status === 'trial',
  isAdmin: isAdminUser(),
  trialEndsAt: data.trialEndsAt || null,
  subscription: sub,
  productLimit: plan.productLimit,
  daysLeft
 };
}

function canAddProduct() {
 const acc = getAccessState();
 if (acc.productLimit === Infinity) return true;
 return (APP.products ? APP.products.length : 0) < acc.productLimit;
}

function planStatusLabel(acc) {
 if (!acc) acc = getAccessState();
 if (acc.status === 'trial') return `Sinov: ${acc.daysLeft} kun qoldi`;
 if (acc.status === 'active') return `${acc.plan.name} tarif faol`;
 if (acc.status === 'expired') return "Obuna muddati tugagan";
 if (acc.status === 'demo') return 'Demo rejim';
 return "Bepul tarif";
}

function normalizeProduct(p) {
 if (!p || typeof p !== 'object') return p;
 if (p.trackStock === undefined) {
 const s = Number(p.stock);
 p.trackStock = (!isNaN(s) && s > 0);
 } else {
 p.trackStock = Boolean(p.trackStock);
 }
 if (p.stock === 999 && !p.isQuick) {
 p.isQuick = true;
 p.trackStock = false;
 }
 if (!p.unit) p.unit = 'dona';
 return p;
}

function isTracked(p) {
 if (!p) return false;
 return Boolean(!p.isQuick && p.trackStock === true);
}

function sanitizePhone(phone) {
 if (!phone) return '';
 return String(phone).replace(/[^0-9+\s]/g, '');
}

// ─────────────────────────────────────────────
// OFFLINE OUTBOX QUEUE (scanpos_outbox)
// ─────────────────────────────────────────────
let outboxBusy = false;
let outboxEnqueueChain = Promise.resolve();

async function getOutboxQueue() {
 try {
 const raw = await ScanDB.get('scanpos_outbox', []);
 return Array.isArray(raw) ? raw : [];
 } catch (e) {
 return [];
 }
}

async function enqueueOutbox(item) {
 outboxEnqueueChain = outboxEnqueueChain.catch(() => {}).then(async () => {
 const q = await getOutboxQueue();
 const entry = { id: generateId(), timestamp: Date.now(), ...item };
 q.push(entry);
 await ScanDB.set('scanpos_outbox', q);
 updateOutboxUI();
 return entry;
 });
 return outboxEnqueueChain;
}

async function updateOutboxUI() {
 const badge = document.getElementById('outboxStatusBadge');
 if (!badge) return;
 const q = await getOutboxQueue();
 if (q.length > 0) {
 badge.classList.remove('hidden');
 badge.style.display = 'inline-flex';
 badge.textContent = `Navbatda: ${q.length}`;
 } else {
 badge.classList.add('hidden');
 badge.style.display = 'none';
 }
}

async function processOutbox() {
 if (outboxBusy) return;
 if (!window.firebaseDB || !window.firebaseFns || !navigator.onLine) {
  return;
 }
 if (window.useDemo && !window.isFirebaseConfigured) {
  return;
 }

 outboxBusy = true;
 try {
 const currentQueue = await getOutboxQueue();
 if (currentQueue.length === 0) return;

 const successfulIds = new Set();
 const { setDoc, deleteDoc, writeBatch: wb, increment } = window.firebaseFns;

 for (const task of currentQueue) {
 try {
  if (task.action === 'saveProduct' || task.action === 'product') {
  await withTimeout(setDoc(userDoc('products', task.data.id), task.data));
  successfulIds.add(task.id);
  } else if (task.action === 'deleteProduct') {
  await withTimeout(deleteDoc(userDoc('products', task.id)));
  successfulIds.add(task.id);
  } else if (task.action === 'saveBill' || task.action === 'bill') {
  await withTimeout(setDoc(userDoc('bills', task.data.id), task.data));
  successfulIds.add(task.id);
  } else if (task.action === 'saveDebtor' || task.action === 'debtor') {
  await withTimeout(setDoc(userDoc('debtors', task.data.id), task.data));
  successfulIds.add(task.id);
  } else if (task.action === 'deleteDebtor') {
  await withTimeout(deleteDoc(userDoc('debtors', task.id)));
  successfulIds.add(task.id);
  } else if (task.action === 'saveDebt' || task.action === 'debt') {
  await withTimeout(setDoc(userDoc('debts', task.data.id), task.data));
  successfulIds.add(task.id);
  } else if (task.action === 'deleteDebt') {
  await withTimeout(deleteDoc(userDoc('debts', task.id)));
  successfulIds.add(task.id);
  } else if (task.action === 'saleBatch' || task.action === 'refundBatch') {
  const batch = wb(window.firebaseDB);
  if (task.products && Array.isArray(task.products)) {
  for (const pUpdate of task.products) {
  const pRef = userDoc('products', pUpdate.id);
 if (typeof increment === 'function' && pUpdate.qtyChange !== undefined) {
 batch.update(pRef, {
 stock: increment(pUpdate.qtyChange),
 updatedAt: new Date().toISOString()
 });
 } else if (pUpdate.stock !== undefined) {
 batch.update(pRef, {
 stock: pUpdate.stock,
 updatedAt: new Date().toISOString()
 });
 }
 }
 }
  if (task.bill) {
  batch.set(userDoc('bills', task.bill.id), task.bill);
    }
    if (task.debt) {
     batch.set(userDoc('debts', task.debt.id), task.debt);
  }
 await withTimeout(batch.commit());
 successfulIds.add(task.id);
 }
 } catch (e) {
 console.warn('Outbox yuborishda xato:', task, e);
 }
 }

 if (successfulIds.size > 0) {
 outboxEnqueueChain = outboxEnqueueChain.catch(() => {}).then(async () => {
 const freshQueue = await getOutboxQueue();
 const remaining = freshQueue.filter(item => !successfulIds.has(item.id));
 await ScanDB.set('scanpos_outbox', remaining);
 updateOutboxUI();
 });
 await outboxEnqueueChain;
 }
 } finally {
 outboxBusy = false;
 }
}

function updateNetworkStatus() {
 const badge = document.getElementById('networkStatusBadge');
 if (!badge) return;
 if (navigator.onLine) {
 badge.className = 'network-badge online';
 badge.innerHTML = '<span class="debtor-status-dot dot-green" style="margin:0 4px 0 0;"></span> Onlayn';
 } else {
 badge.className = 'network-badge offline';
 badge.innerHTML = '<span class="debtor-status-dot dot-red" style="margin:0 4px 0 0;"></span> Oflayn';
 }
}
if (typeof window !== 'undefined') {
 window.addEventListener('online', () => {
 updateNetworkStatus();
 showToast('Internet ulandi. Oflayn navbat sinxronlanmoqda...', 'success');
 processOutbox();
 });
 window.addEventListener('offline', () => {
 updateNetworkStatus();
 showToast('Internet uzildi. Oflayn rejimga o\'tildi.', 'warning');
 });
 setInterval(processOutbox, 30000);
}

// ─────────────────────────────────────────────
// CALC TOTALS (Birlashtirilgan narx, chegirma va soliq hisobi)
// ─────────────────────────────────────────────
function calcTotals(cart = [], discountPct = 0, taxRate = 0) {
 const subtotal = Math.round((cart || []).reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 0), 0));
 const validDiscountPct = Math.min(100, Math.max(0, Number(discountPct) || 0));
 const discount = Math.round(subtotal * (validDiscountPct / 100));
 const taxable = Math.max(0, subtotal - discount);
 const validTaxRate = Math.max(0, Number(taxRate) || 0);
 const tax = Math.round(taxable * (validTaxRate / 100));
 const total = Math.max(0, taxable + tax);
 return { subtotal, discount, taxable, tax, total, discountPercent: validDiscountPct };
}

// Toifalar uchun standart narxlar (bitta mahsulot kiritilganda keyingilar avtomatik narxlanadi)
const DEFAULT_CATEGORY_PRICES = {
 suv_05: 3000,
 suv_10: 5000,
 suv_50: 12000,
 ichimlik: 7000,
 non: 4000,
 shirinlik: 10000,
 sut: 9000,
 oziq: 15000,
 gigiyena: 18000,
 uy: 20000,
 boshqa: 5000,
};

const CATEGORY_NAMES = {
 suv_05: 'Suv 0.5L',
 suv_10: 'Suv 1L - 1.5L',
 suv_50: 'Suv 5L',
 ichimlik: 'Gazli ichimliklar & sharbatlar',
 non: 'Non va pishiriqlar',
 shirinlik: 'Shirinliklar & konfetlar',
 sut: 'Sut mahsulotlari',
 oziq: 'Oziq-ovqat mahsulotlari',
 gigiyena: 'Gigiyena va kosmetika',
 uy: 'Uy-ro\'zg\'or buyumlari',
 boshqa: 'Boshqa mahsulotlar',
};

// ─────────────────────────────────────────────
// SVG ICON SYSTEM (100% haqiqiy SVG piktogrammalar)
// ─────────────────────────────────────────────
const ICONS = {
 edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
 trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
 plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
 x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
 check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
 phone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.95 15 19.79 19.79 0 0 1 1.88 6.43A2 2 0 0 1 3.87 4h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 11a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 17.16z"/></svg>`,
 user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
 dollar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 0 0 7H6"/></svg>`,
 receipt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
 box: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
 barchart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
 clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
 alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
 book: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
 card: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`,
 transfer: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
 water: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>`,
 coffee: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>`,
 bread: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>`,
 candy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9.5" cy="9.5" r="6.5"/><polyline points="14.5 4 22 6 20 13.5"/></svg>`,
 milk: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2h8l1 4H7L8 2z"/><path d="M7 6l-2 14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2L17 6"/></svg>`,
 food: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/></svg>`,
 soap: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="9" width="20" height="12" rx="2"/><path d="M16 9V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4"/><line x1="12" y1="14" x2="12" y2="16"/></svg>`,
 home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
 info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
 link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
 unlink: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-3 3a5 5 0 0 0 .54 7.54"/><path d="M5.16 11.75l-1.72 1.71a5 5 0 0 0 7.07 7.07l3-3a5 5 0 0 0-.54-7.54"/><line x1="8" y1="2" x2="8" y2="5"/><line x1="2" y1="8" x2="5" y2="8"/><line x1="16" y1="19" x2="16" y2="22"/><line x1="19" y1="16" x2="22" y2="16"/></svg>`,
 printer: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>`,
 lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
 undo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>`,
 camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
 cart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>`,
 bolt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
 bag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`,
 egg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C8 2 5 8 5 14a7 7 0 0 0 14 0c0-6-3-12-7-12z"/></svg>`,
 download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
 upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
 smartphone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`,
 globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
 database: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
 trendUp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
 sparkles: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/></svg>`,
 search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
 volume: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`,
 volumeX: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`,
 fileText: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`,
 sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`,
 moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
 star: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
};

// icon(name, size, extraClass) → HTML string
function icon(name, size = 18, cls = '') {
 const svg = ICONS[name];
 if (!svg) return '';
 return svg.replace('<svg ', `<svg width="${size}" height="${size}" class="svg-icon${cls ? ' ' + cls : ''}" `);
}

// Toifa ikonkalari (100% SVG)
const catEmoji = {
 suv_05: () => icon('water', 20),
 suv_10: () => icon('water', 20),
 suv_50: () => icon('water', 20),
 ichimlik: () => icon('coffee', 20),
 non: () => icon('bread', 20),
 shirinlik:() => icon('candy', 20),
 sut: () => icon('milk', 20),
 oziq: () => icon('food', 20),
 uy: () => icon('home', 20),
 gigiyena: () => icon('soap', 20),
 boshqa: () => icon('box', 20),
};
// catIcon(category) → SVG string
function catIcon(cat) {
 return (catEmoji[cat] ? catEmoji[cat]() : icon('box', 20));
}

/**
 * Asl Belgisi / GS1 DataMatrix / Raqamli markirovka QR-kodlaridan
 * mahsulotning asosiy GTIN / EAN-13 kodini ajratib oladi.
 * Natijada har bir idishning seriya raqami har xil bo'lsa ham,
 * asosiy tovar kodi barcha idishlar uchun bir xil bo'ladi!
 */
function extractProductBarcode(raw) {
 if (!raw) return '';
 let str = String(raw).trim();
 // Nazorat belgilarini (ASCII 0-31, 127) tozalash
 str = str.replace(/[\x00-\x1F\x7F]/g, '');

 // 1. Asl Belgisi / GS1 Digital Link URL (masalan: https://aslbelgisi.uz/c/0104780136192003...)
 const urlMatch = str.match(/^(?:https?:\/\/[^\s\/]+(?:\/c|\/01)?)[\/?#](?:01)?(\d{14})/i);
 if (urlMatch) {
 return normalizeGTIN(urlMatch[1]);
 }

 // 2. Qavsli GS1 format: satr boshida (01) + 14 ta raqam
 const parenMatch = str.match(/^(?:\(01\)|01)(\d{14})/);
 if (parenMatch) {
 return normalizeGTIN(parenMatch[1]);
 }

 // 3. FNC1 yoki GS ajratuvchi bilan kelgan GS1 DataMatrix
 const fnc1Match = str.match(/[\x1d\x1e](?:01)?(\d{14})/);
 if (fnc1Match) {
 return normalizeGTIN(fnc1Match[1]);
 }

 // 4. Aynan 14 xonali GTIN bo'lsa
 if (/^\d{14}$/.test(str)) {
 return normalizeGTIN(str);
 }

 return str;
}

function normalizeGTIN(gtin14) {
 // 14 xonali GTIN noldan boshlansa (04780136192003), 13 xonali EAN-13 ga o'tkazish
 if (gtin14.length === 14 && gtin14.startsWith('0')) {
 return gtin14.substring(1);
 }
 return gtin14;
}

function loadCategoryPrices() {
 try {
  const saved = localStorage.getItem(nsKey('scanpos_category_prices'));
 APP.categoryPrices = saved
 ? { ...DEFAULT_CATEGORY_PRICES, ...JSON.parse(saved) }
 : { ...DEFAULT_CATEGORY_PRICES };
 } catch {
 APP.categoryPrices = { ...DEFAULT_CATEGORY_PRICES };
 }
}

function saveCategoryPrices() {
 localStorage.setItem(nsKey('scanpos_category_prices'), JSON.stringify(APP.categoryPrices));
}

// ZXing reader (lazy loaded)
let zxingReader = null;

// ─────────────────────────────────────────────
// GLOBAL PRODUCT LOOKUP (OpenFoodFacts + OpenBeautyFacts)
// ─────────────────────────────────────────────
/**
 * Shtrix-kodni global internet bazalarida qidiradi.
 * OpenFoodFacts (oziq-ovqat) va OpenBeautyFacts (gigiyena) dan ketma-ket so'raydi.
 * @param {string} barcode
 * @returns {Promise<{name, image, category, brand}|null>}
 */
async function lookupBarcodeOnline(barcode) {
 const clean = String(barcode).trim();
 if (!clean) return null;

 // 1. OpenFoodFacts (oziq-ovqat va ichimliklar)
 const reqFood = fetch(
 `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(clean)}.json?fields=product_name,product_name_ru,product_name_en,brands,image_front_url,categories_tags`,
 { signal: AbortSignal.timeout(4500) }
 ).then(async res => {
 if (!res.ok) return null;
 const data = await res.json();
 if (data.status === 1 && data.product) {
 const p = data.product;
 const name = p.product_name_ru || p.product_name || p.product_name_en || p.brands || '';
 if (name) {
 return {
 name: name.trim(),
 brand: p.brands || '',
 image: p.image_front_url || null,
 category: detectCategory(p.categories_tags || [], 'oziq'),
 };
 }
 }
 return null;
 }).catch(() => null);

 // 2. OpenBeautyFacts (gigiyena va kosmetika)
 const reqBeauty = fetch(
 `https://world.openbeautyfacts.org/api/v2/product/${encodeURIComponent(clean)}.json?fields=product_name,brands,image_front_url`,
 { signal: AbortSignal.timeout(4500) }
 ).then(async res => {
 if (!res.ok) return null;
 const data = await res.json();
 if (data.status === 1 && data.product) {
 const p = data.product;
 const name = p.product_name || p.brands || '';
 if (name) {
 return {
 name: name.trim(),
 brand: p.brands || '',
 image: p.image_front_url || null,
 category: 'gigiyena',
 };
 }
 }
 return null;
 }).catch(() => null);

 // 3. UPC Item DB (global EAN/UPC katalogi)
 const reqUpc = fetch(
 `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(clean)}`,
 {
 signal: AbortSignal.timeout(4500),
 headers: { 'Accept': 'application/json' }
 }
 ).then(async res => {
 if (!res.ok) return null;
 const data = await res.json();
 const item = data.items?.[0];
 if (item && item.title) {
 return {
 name: item.title.trim(),
 brand: item.brand || '',
 image: item.images?.[0] || null,
 category: detectCategoryFromName(item.title + ' ' + (item.category || '')),
 };
 }
 return null;
 }).catch(() => null);

 // So'rovlarni ketma-ket emas, parallel (bir vaqtda) yuborish
 const results = await Promise.all([reqFood, reqBeauty, reqUpc]);
 return results.find(r => r && r.name) || null;
}

/** categories_tags massividan kategoriya aniqlaymiz */
function detectCategory(tags, fallback) {
 const str = tags.join(' ').toLowerCase();
 if (/(?:\b(?:water|suv)\b|вода|минералка)/.test(str)) {
 if (/0[.,]5|500/.test(str)) return 'suv_05';
 if (/1[.,]5|1[.,]0|1l/.test(str)) return 'suv_10';
 if (/5l|5000/.test(str)) return 'suv_50';
 return 'suv_05';
 }
 if (/(?:\b(?:beverage|drink|juice|cola|soda|tea|coffee)\b|напиток|сок|чай)/.test(str)) return 'ichimlik';
 if (/(?:\b(?:bread|bakery|flour|non)\b|хлеб|выпечка)/.test(str)) return 'non';
 if (/(?:\b(?:candy|chocolate|sweet|biscuit|snack|chip|crisp)\b|сладости|шоколад|конфеты)/.test(str)) return 'shirinlik';
 if (/(?:\b(?:milk|dairy|cheese|yogurt|sut)\b|молоко|сыр|йогурт)/.test(str)) return 'sut';
 if (/(?:\b(?:rice|pasta|grain|cereal|konserva|oziq)\b|крупа|макароны|консервы)/.test(str)) return 'oziq';
 if (/(?:\b(?:beauty|cosmetic|shampoo|soap|hygiene|gigiyena)\b|гигиена|косметика|мыло)/.test(str)) return 'gigiyena';
 if (/(?:\b(?:cleaning|detergent|household|uy)\b|бытовая химия)/.test(str)) return 'uy';
 return fallback || 'boshqa';
}

/** Mahsulot nomi bo'yicha kategoriya taxmin qilish (\b so'z chegarasi bilan) */
function detectCategoryFromName(name) {
 const n = (name || '').toLowerCase();

 // Suvlar (aniq suv iboralari — nestle va family olib tashlangan!)
 if (/(?:\b(?:water|suv|aqua|chortoq|montella|hydrolife|bonaqua)\b|вода|минералка|минеральная)/i.test(n)) {
 if (/(?:0[.,]5|500\s*ml|0\.5l)/i.test(n)) return 'suv_05';
 if (/(?:1[.,]5|1[.,]0|1\s*l|1\s*л|1500\s*ml)/i.test(n)) return 'suv_10';
 if (/(?:5\s*l|5\s*л|5000\s*ml|5\s*литр)/i.test(n)) return 'suv_50';
 return 'suv_05';
 }

 // Ichimliklar: so'z chegarasi bilan (steak, protean xato tushmasin)
 if (/(?:\b(?:cola|pepsi|sprite|fanta|soda|tea|choy|coffee|energy|redbull|lipton|flash|juice|drink)\b|сок|шарбат|кофе)/i.test(n)) return 'ichimlik';

 // Non mahsulotlari: \bnon\b (canon, economic xato tushmasin)
 if (/(?:\b(?:non|patir|lavash|bread|toast)\b|хлеб|лепешка|батон|булочка)/i.test(n)) return 'non';

 // Shirinliklar
 if (/(?:\b(?:chocolate|candy|biscuit|snack|cookie|wafer|cake|pie)\b|шоколад|конфет|печенье|торт|пирог|вафли|shirinlik)/i.test(n)) return 'shirinlik';

 // Sut mahsulotlari
 if (/(?:\b(?:milk|kefir|yogurt|cheese|dairy)\b|сут|молоко|кефир|йогурт|сыр|творог|сметана|qatiq|qaymoq)/i.test(n)) return 'sut';

 // Oziq-ovqat: \bun\b (sun, sound, funny xato tushmasin)
 if (/(?:\b(?:rice|pasta|macaroni|flour|un|sugar|salt|oil)\b|гуруч|макарон|ун|шакар|туз|масло|консерва)/i.test(n)) return 'oziq';

 // Gigiyena: \bgel\b (angel, bagel xato tushmasin)
 if (/(?:\b(?:shampoo|soap|toothpaste|deodorant|perfume|cream|lotion|gel|balm)\b|шампунь|мыло|крем|гель|бальзам|sovun)/i.test(n)) return 'gigiyena';

 // Uy-ro'zg'or
 if (/(?:\b(?:detergent|bleach|cleaner|sponge|fairy|tide|ariel)\b|порошок|белизна|пакет)/i.test(n)) return 'uy';

 return 'boshqa';
}


// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
window.initApp = async function () {
 if (window._appInited) return;
 window._appInited = true;
 loadSettings();
 loadLocalData();
 loadQuickItems();
 updateFirebaseStatus();

 if (window.useDemo) {
 const demoTag = document.getElementById('demoTag');
 if (demoTag) demoTag.classList.remove('hidden');
 }

 // Splash animatsiya
 setTimeout(() => {
 const splash = document.getElementById('splash');
 if (splash) {
 splash.classList.add('out');
 setTimeout(() => {
 splash.style.display = 'none';
 const appEl = document.getElementById('app');
 if (appEl) appEl.classList.remove('hidden');
 startCamera();
 }, 400);
 } else {
 const appEl = document.getElementById('app');
 if (appEl) appEl.classList.remove('hidden');
 startCamera();
 }
 }, 1200);

 // ZXing CDN dan yuklash (BarcodeDetector yo'q bo'lganda yoki formatlar bo'sh bo'lsa) (5.1)
 if ('BarcodeDetector' in window && typeof BarcodeDetector.getSupportedFormats === 'function') {
 try {
 const supported = await BarcodeDetector.getSupportedFormats();
 const wanted = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code', 'data_matrix', 'itf', 'codabar'];
 const common = wanted.filter(f => supported.includes(f));
 if (common.length > 0) {
 APP.barcodeDetector = new BarcodeDetector({ formats: common });
 console.log(' BarcodeDetector API tayyor:', common);
 } else {
 console.warn('BarcodeDetector formatlar bo\'sh, ZXing ga o\'tilmoqda');
 loadZXing();
 }
 } catch (e) {
 console.warn('BarcodeDetector xato:', e);
 loadZXing();
 }
 } else {
 loadZXing();
 }

 // Firebase real-time listeners
 if (!window.useDemo && window.firebaseDB && window.currentUser) {
  const unsubs = [
   listenFirestoreProducts(),
   listenFirestoreBills(),
   listenFirestoreDebtors(),
   listenFirestoreDebts()
  ].filter(fn => typeof fn === 'function');
  APP._unsubs = (APP._unsubs || []).concat(unsubs);
 } else {
 renderProducts();
   renderBills();
   renderDebtors();
   updateNasiyaStats();
 }

 updateCartUI();
 updateVoiceBtn();
 updateTorchUI();
 updateNetworkStatus();
 renderUserMenu();
};

// ─────────────────────────────────────────────
// SESSIYA BOSHQARUVI (auth.js bilan integratsiya)
// ─────────────────────────────────────────────
async function ensureUserProfile(user) {
 if (!window.firebaseDB || !window.firebaseFns) return;
 try {
  const { doc, getDoc, setDoc } = window.firebaseFns;
  const ref = doc(window.firebaseDB, 'users', user.uid);
  const snap = await getDoc(ref);
  const nowIso = new Date().toISOString();
  const base = {
   uid: user.uid,
   displayName: user.displayName || '',
   email: user.email || '',
   photoURL: user.photoURL || '',
   lastLoginAt: nowIso,
   updatedAt: nowIso
  };
  if (!snap.exists()) {
   const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();
   const profile = {
    ...base,
    shopName: '',
    createdAt: nowIso,
    plan: 'free',
    trialEndsAt,
    subscription: { status: 'trial', plan: '', startedAt: nowIso, expiresAt: '' }
   };
   await setDoc(ref, profile, { merge: true });
   APP.subscriptionData = profile;
  } else {
   await setDoc(ref, base, { merge: true });
   APP.subscriptionData = { ...snap.data(), ...base };
  }
  // Admin bo'lsa, allowlist hujjatini ta'minlaymiz (rules uchun qo'shimcha)
  if (isAdminUser(user) && window.firebaseFns.setDoc) {
   try {
    await setDoc(doc(window.firebaseDB, 'admins', user.uid), { email: user.email, updatedAt: nowIso }, { merge: true });
   } catch (e) { /* rules ruxsat bermasa e'tiborsiz */ }
  }
 } catch (e) {
  console.warn('Profil yangilash xato:', e);
 }
}

async function loadUserMeta() {
 if (!window.firebaseDB || !window.firebaseFns || !window.currentUser) return;
 try {
  const { doc, getDoc } = window.firebaseFns;
  const ref = doc(window.firebaseDB, 'users', window.currentUser.uid, 'meta', 'settings');
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const d = snap.data() || {};
  if (d.settings && typeof d.settings === 'object') {
   APP.settings = d.settings;
   localStorage.setItem(nsKey('scanpos_settings'), JSON.stringify(APP.settings));
  }
  if (d.categoryPrices && typeof d.categoryPrices === 'object') {
   APP.categoryPrices = { ...DEFAULT_CATEGORY_PRICES, ...d.categoryPrices };
 localStorage.setItem(nsKey('scanpos_category_prices'), JSON.stringify(APP.categoryPrices));
 if (typeof saveUserMeta === 'function') saveUserMeta();
  }
  if (Array.isArray(d.quickItems) && d.quickItems.length > 0) {
   APP.quickItems = d.quickItems;
 localStorage.setItem(nsKey('scanpos_quick_items'), JSON.stringify(APP.quickItems));
 if (typeof saveUserMeta === 'function') saveUserMeta();
  }
 } catch (e) {
  console.warn('meta yuklash xato:', e);
 }
}

async function saveUserMeta() {
 if (window.useDemo || !window.firebaseDB || !window.firebaseFns || !window.currentUser) return;
 try {
  const { doc, setDoc } = window.firebaseFns;
  await setDoc(doc(window.firebaseDB, 'users', window.currentUser.uid, 'meta', 'settings'), {
   settings: APP.settings || {},
   categoryPrices: APP.categoryPrices || {},
   quickItems: APP.quickItems || [],
   updatedAt: new Date().toISOString()
  }, { merge: true });
 } catch (e) {
  console.warn('meta saqlash xato:', e);
 }
}

async function loadUserCollections() {
 if (window.useDemo || !window.firebaseDB || !window.firebaseFns || !window.currentUser) return;
 try {
  const { collection, getDocs } = window.firebaseFns;
  const load = async (name, appKey, renderFn) => {
   try {
    const snap = await getDocs(collection(window.firebaseDB, 'users', window.currentUser.uid, name));
    const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (arr.length > 0) {
     APP[appKey] = arr;
     if (typeof renderFn === 'function') renderFn();
    }
   } catch (e) { console.warn(`loadUserCollections(${name}) xato:`, e); }
  };
  await load('expenses', 'expenses', () => { if (APP.currentPage === 'analytics') renderAnalytics(); });
  await load('supplies', 'supplies');
 } catch (e) {
  console.warn('loadUserCollections xato:', e);
 }
}

window.scanposOnLogin = async function (user) {
 window.currentUser = user;
 window.storageNs = 'u_' + user.uid;
 window.useDemo = false;
 window._appInited = false;
 try { await ensureUserProfile(user); } catch (e) {}
 try { await loadUserMeta(); } catch (e) {}
 window.initApp();
 // Firestore'dagi og'ir kolleksiyalarni fonda yuklaymiz
 loadUserCollections();
};

window.scanposOnLogout = function () {
 try {
  (APP._unsubs || []).forEach(fn => { try { fn(); } catch (e) {} });
 } catch (e) {}
 APP._unsubs = [];
 try { stopCamera(); } catch (e) {}
 window.currentUser = null;
 window.storageNs = '';
 window._appInited = false;
 window.useDemo = true;
 // Xotira holatini tozalash (local ma'lumotlar user bo'yicha ajratilgan)
 APP.products = []; APP.bills = []; APP.debtors = []; APP.debts = [];
 APP.cart = []; APP.expenses = []; APP.supplies = []; APP.heldCarts = [];
 const appEl = document.getElementById('app');
 if (appEl) appEl.classList.add('hidden');
};

// ─────────────────────────────────────────────
// USER MENU UI
// ─────────────────────────────────────────────
function renderUserMenu() {
 const wrap = document.getElementById('userMenuWrap');
 const user = window.currentUser;
 if (wrap) {
  if (!user) {
   wrap.classList.add('hidden');
  } else {
   wrap.classList.remove('hidden');

   const name = user.displayName || (user.email ? user.email.split('@')[0] : 'Foydalanuvchi');
   const email = user.email || '';
   const photo = (APP.settings && APP.settings.profilePhoto) || user.photoURL || '';
   const initial = (name.charAt(0) || 'S').toUpperCase();

   const img = document.getElementById('userAvatarImg');
   const initialEl = document.getElementById('userAvatarInitial');
   if (img) {
    if (photo) { img.src = photo; img.classList.remove('hidden'); if (initialEl) initialEl.classList.add('hidden'); }
    else { img.classList.add('hidden'); if (initialEl) { initialEl.textContent = initial; initialEl.classList.remove('hidden'); } }
   }
   const mImg = document.getElementById('userMenuImg');
   if (mImg) { if (photo) { mImg.src = photo; mImg.classList.remove('hidden'); } else { mImg.classList.add('hidden'); } }
   const nameEl = document.getElementById('userMenuName');
   const emailEl = document.getElementById('userMenuEmail');
   if (nameEl) nameEl.textContent = name;
   if (emailEl) emailEl.textContent = email;
  }
 }
 renderSettingsProfile();
 renderSubscriptionUI();
}

function renderSettingsProfile() {
 const user = window.currentUser;
 const shopName = (APP.settings && APP.settings.shopName) || '';
 const fallbackName = shopName || 'Foydalanuvchi';
 const name = user ? (user.displayName || (user.email ? user.email.split('@')[0] : fallbackName)) : fallbackName;
 const email = user ? (user.email || '') : 'Demo rejim (hisobsiz)';
 const photo = (APP.settings && APP.settings.profilePhoto) || (user && user.photoURL) || '';

 const img = document.getElementById('settingsProfileImg');
 const initial = document.getElementById('settingsProfileInitial');
 if (img) {
  if (photo) { img.src = photo; img.classList.remove('hidden'); }
  else { img.classList.add('hidden'); img.removeAttribute('src'); }
 }
 if (initial) {
  if (photo) { initial.classList.add('hidden'); }
  else { initial.textContent = (name.charAt(0) || 'S').toUpperCase(); initial.classList.remove('hidden'); }
 }
 const nameEl = document.getElementById('settingsProfileName');
 const emailEl = document.getElementById('settingsProfileEmail');
 if (nameEl) nameEl.textContent = name;
 if (emailEl) emailEl.textContent = email;
}

function toggleUserMenu(event) {
 if (event) event.stopPropagation();
 const dd = document.getElementById('userMenuDropdown');
 if (!dd) return;
 dd.classList.toggle('hidden');
}

function openProfileSettings() {
 const dd = document.getElementById('userMenuDropdown');
 if (dd) dd.classList.add('hidden');
 if (typeof showPage === 'function') showPage('settings');
}

// ─────────────────────────────────────────────
// PROFILE EDIT (Profilni tahrirlash)
// ─────────────────────────────────────────────
let _profilePhotoData = '';

function _setInputValue(id, val) {
 const el = document.getElementById(id);
 if (el) el.value = (val == null) ? '' : val;
}

function renderProfileAvatar(photo, name) {
 const img = document.getElementById('profileAvatarImg');
 const initial = document.getElementById('profileAvatarInitial');
 const rmBtn = document.getElementById('profileAvatarRemoveBtn');
 if (photo) {
  if (img) { img.src = photo; img.classList.remove('hidden'); }
  if (initial) initial.classList.add('hidden');
  if (rmBtn) rmBtn.style.display = '';
 } else {
  if (img) { img.classList.add('hidden'); img.removeAttribute('src'); }
  if (initial) { initial.textContent = ((name || 'S').charAt(0) || 'S').toUpperCase(); initial.classList.remove('hidden'); }
  if (rmBtn) rmBtn.style.display = 'none';
 }
}

function openProfileModal() {
 const dd = document.getElementById('userMenuDropdown');
 if (dd) dd.classList.add('hidden');
 const user = window.currentUser;
 const name = (user && (user.displayName || (user.email ? user.email.split('@')[0] : ''))) || '';
 const email = (user && user.email) || '';
 const photo = (APP.settings && APP.settings.profilePhoto) || (user && user.photoURL) || '';
 _profilePhotoData = photo;
 _setInputValue('profileName', name);
 _setInputValue('profileEmail', email);
 _setInputValue('profileShopName', APP.settings.shopName || '');
 _setInputValue('profileShopAddress', APP.settings.shopAddress || '');
 _setInputValue('profileShopPhone', APP.settings.shopPhone || '');
 _setInputValue('profileCurrentPassword', '');
 _setInputValue('profileNewPassword', '');
 const pwdHint = document.getElementById('profilePasswordHint');
 if (pwdHint) pwdHint.textContent = '';
 renderProfileAvatar(photo, name);

 const isPwd = Boolean(window.scanposAuth && window.scanposAuth.isPasswordProvider);
 const pwdSection = document.getElementById('profilePasswordSection');
 if (pwdSection) pwdSection.style.display = isPwd ? '' : 'none';

 openModal('profileModal');
}

function triggerProfileAvatar() {
 const input = document.getElementById('profileAvatarInput');
 if (input) input.click();
}

async function handleProfileAvatarFile(event) {
 const file = event && event.target && event.target.files && event.target.files[0];
 if (!file) return;
 try {
  const dataUrl = await compressImage(file, 160, 160, 0.82);
  _profilePhotoData = dataUrl;
  const nameEl = document.getElementById('profileName');
  renderProfileAvatar(_profilePhotoData, nameEl ? nameEl.value : '');
 } catch (e) {
  console.warn('Avatar xato:', e);
  showToast('Rasmni o\'qib bo\'lmadi');
 } finally {
  if (event && event.target) event.target.value = '';
 }
}

function removeProfileAvatar() {
 _profilePhotoData = '';
 const nameEl = document.getElementById('profileName');
 renderProfileAvatar('', nameEl ? nameEl.value : '');
}

async function saveProfile() {
 const name = (document.getElementById('profileName')?.value || '').trim();
 const shopName = (document.getElementById('profileShopName')?.value || '').trim();
 const shopAddress = (document.getElementById('profileShopAddress')?.value || '').trim();
 const shopPhone = (document.getElementById('profileShopPhone')?.value || '').trim();

 if (name && window.scanposAuth && window.scanposAuth.updateDisplayName) {
  try { await window.scanposAuth.updateDisplayName(name); } catch (e) { console.warn(e); }
 }
 if (window.scanposAuth && window.scanposAuth.updatePhotoURL) {
  if (_profilePhotoData && /^https?:\/\//.test(_profilePhotoData)) {
   try { await window.scanposAuth.updatePhotoURL(_profilePhotoData); } catch (e) {}
  }
 }

 if (window.currentUser) {
  if (name) window.currentUser.displayName = name;
  if (_profilePhotoData && /^https?:\/\//.test(_profilePhotoData)) window.currentUser.photoURL = _profilePhotoData;
 }

 APP.settings.shopName = shopName;
 APP.settings.shopAddress = shopAddress;
 APP.settings.shopPhone = shopPhone;
 APP.settings.profilePhoto = _profilePhotoData || '';
 try { localStorage.setItem(nsKey('scanpos_settings'), JSON.stringify(APP.settings)); } catch (e) {}

 _setInputValue('shopName', shopName);
 _setInputValue('shopAddress', shopAddress);
 _setInputValue('shopPhone', shopPhone);

 if (!window.useDemo && window.firebaseDB && window.currentUser && window.firebaseFns) {
  try {
   const { doc, setDoc } = window.firebaseFns;
   await setDoc(doc(window.firebaseDB, 'users', window.currentUser.uid), {
    displayName: name,
    photoData: _profilePhotoData || '',
    shopName, shopAddress, shopPhone,
    updatedAt: new Date().toISOString()
   }, { merge: true });
  } catch (e) { console.warn('Profil saqlash xato:', e); }
 }
 if (typeof saveUserMeta === 'function') saveUserMeta();

 renderUserMenu();
 closeModal('profileModal');
 showToast('Profil saqlandi');
}

async function handleChangePassword() {
 const cur = document.getElementById('profileCurrentPassword')?.value || '';
 const nw = document.getElementById('profileNewPassword')?.value || '';
 const hint = document.getElementById('profilePasswordHint');
 const setHint = (m) => { if (hint) hint.textContent = m; };
 if (!cur || !nw) { setHint('Joriy va yangi parolni kiriting.'); return; }
 if (nw.length < 6) { setHint('Yangi parol kamida 6 belgidan iborat bo\'lishi kerak.'); return; }
 if (!window.scanposAuth || !window.scanposAuth.changePassword) { setHint('Parolni o\'zgartirish mavjud emas.'); return; }
 try {
  await window.scanposAuth.changePassword(cur, nw);
  _setInputValue('profileCurrentPassword', '');
  _setInputValue('profileNewPassword', '');
  setHint('Parol muvaffaqiyatli yangilandi.');
  showToast('Parol yangilandi');
 } catch (e) {
  const code = e && e.code;
  if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') setHint('Joriy parol noto\'g\'ri.');
  else if (code === 'auth/weak-password') setHint('Yangi parol juda kuchsiz.');
  else if (code === 'auth/requires-recent-login') setHint('Xavfsizlik uchun qayta kirib, qayta urinib ko\'ring.');
  else setHint('Parolni yangilab bo\'lmadi. Qayta urinib ko\'ring.');
 }
}

// ─────────────────────────────────────────────
// SUBSCRIPTION UI / PAYWALL
// ─────────────────────────────────────────────
let _selectedPlan = null;

function renderSubscriptionUI() {
 const acc = getAccessState();
 const planNameEl = document.getElementById('subscriptionPlanName');
 const statusEl = document.getElementById('subscriptionStatusText');
 if (planNameEl) planNameEl.textContent = acc.plan.name + ' tarif';
 if (statusEl) {
  if (acc.status === 'trial') statusEl.textContent = `Bepul sinov • ${acc.daysLeft} kun qoldi`;
  else if (acc.status === 'active') statusEl.textContent = acc.subscription.expiresAt ? ('Faol • ' + formatDate(acc.subscription.expiresAt) + ' gacha') : 'Faol';
  else if (acc.status === 'expired') statusEl.textContent = 'Muddati tugagan — yangilang';
  else if (acc.status === 'demo') statusEl.textContent = 'Demo rejim (hisobsiz)';
  else statusEl.textContent = 'Bepul tarif';
 }
 const banner = document.getElementById('subBanner');
 const bText = document.getElementById('subBannerText');
 if (banner && bText) {
  if (acc.status === 'trial') {
   bText.textContent = `Bepul sinov: ${acc.daysLeft} kun qoldi`;
   banner.classList.remove('hidden');
  } else if (acc.status === 'expired') {
   bText.textContent = 'Obuna muddati tugagan — cheklovlar faol';
   banner.classList.remove('hidden');
  } else {
   banner.classList.add('hidden');
  }
 }
}

function renderPaywallPlans() {
 const container = document.getElementById('planCards');
 if (!container) return;
 const acc = getAccessState();
 container.innerHTML = Object.values(PLANS).map(p => {
  const isCurrent = acc.planKey === p.key && acc.status !== 'trial';
  const popular = p.key === 'standard';
  const features = p.features.map(f => `<li>${escHtml(f)}</li>`).join('');
  const btn = p.key === 'free'
   ? `<button type="button" class="btn-secondary" ${isCurrent ? 'disabled' : ''}>${isCurrent ? 'Joriy tarif' : 'Bepul tarif'}</button>`
   : `<button type="button" class="btn-primary" onclick="choosePlan('${p.key}')">${isCurrent ? 'Joriy — uzaytirish' : 'Tanlash'}</button>`;
  return `<div class="plan-card ${isCurrent ? 'current' : ''} ${popular ? 'popular' : ''}">
    ${popular ? '<span class="plan-badge">Mashhur</span>' : ''}
    <div class="plan-card-head"><span class="plan-card-name">${escHtml(p.name)}</span><span class="plan-card-price">${escHtml(p.priceLabel)}</span></div>
    <ul class="plan-card-features">${features}</ul>
    ${btn}
  </div>`;
 }).join('');
}

function openPaywall() {
 renderPaywallPlans();
 _selectedPlan = null;
 const payArea = document.getElementById('paywallPayArea');
 const pending = document.getElementById('paywallPending');
 if (payArea) payArea.classList.add('hidden');
 if (pending) pending.classList.add('hidden');
 openModal('paywallModal');
}

function choosePlan(planKey) {
 const plan = planByKey(planKey);
 if (!plan || plan.price === 0) return;
 _selectedPlan = planKey;
 const area = document.getElementById('paywallPayArea');
 const title = document.getElementById('paywallPayTitle');
 if (title) title.textContent = `${plan.name} — ${plan.priceLabel}`;
 const pl = document.getElementById('paymeLink');
 const cl = document.getElementById('clickLink');
 if (pl) pl.href = PAYMENT_INFO.paymeLink;
 if (cl) cl.href = PAYMENT_INFO.clickLink;
 const cn = document.getElementById('payCardNumber');
 const ch = document.getElementById('payCardHolder');
 if (cn) cn.textContent = PAYMENT_INFO.cardNumber;
 if (ch) ch.textContent = PAYMENT_INFO.cardHolder;
 if (area) { area.classList.remove('hidden'); }
}

async function submitPaymentRequest() {
 if (!_selectedPlan) { showToast('Avval tarif tanlang'); return; }
 const plan = planByKey(_selectedPlan);
 if (!window.currentUser) { showToast("Obuna uchun tizimga kiring", 'warning'); return; }
 const req = {
  uid: window.currentUser.uid,
  email: window.currentUser.email || '',
  displayName: window.currentUser.displayName || '',
  shopName: (APP.settings && APP.settings.shopName) || '',
  plan: plan.key,
  planName: plan.name,
  amount: plan.price,
  method: 'manual',
  status: 'pending',
  createdAt: new Date().toISOString()
 };
 try {
  if (!window.useDemo && window.firebaseDB && window.firebaseFns && window.firebaseFns.addDoc) {
   await window.firebaseFns.addDoc(window.firebaseFns.collection(window.firebaseDB, 'paymentRequests'), req);
  }
  const payArea = document.getElementById('paywallPayArea');
  const pending = document.getElementById('paywallPending');
  if (payArea) payArea.classList.add('hidden');
  if (pending) pending.classList.remove('hidden');
  showToast("To'lov so'rovi yuborildi. Admin tasdiqlaydi.", 'success');
 } catch (e) {
  console.error('paymentRequest xato:', e);
  showToast("So'rov yuborilmadi. Internetni tekshiring.", 'error');
 }
}

if (typeof window !== 'undefined') {
 document.addEventListener('click', (e) => {
  const dd = document.getElementById('userMenuDropdown');
  const wrap = document.getElementById('userMenuWrap');
  if (dd && !dd.classList.contains('hidden') && wrap && !wrap.contains(e.target)) {
   dd.classList.add('hidden');
  }
 });
}

// initApp faqat auth.js (yoki demo rejim) tomonidan chaqiriladi

// ─────────────────────────────────────────────
// ZXING LOADER
// ─────────────────────────────────────────────
function loadZXing() {
 if (APP.barcodeDetector) return; // Native va ZXing bir vaqtda ishlamasligi uchun (5.1)
 if (window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader) {
 zxingReader = new window.ZXingBrowser.BrowserMultiFormatReader();
 console.log(' ZXing tayyor (fallback rejim)');
 return;
 }
 const s = document.createElement('script');
 s.src = 'https://unpkg.com/@zxing/browser@0.1.5/umd/zxing-browser.min.js';
 s.onload = () => {
 if (APP.barcodeDetector) return;
 if (window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader) {
 zxingReader = new window.ZXingBrowser.BrowserMultiFormatReader();
 console.log(' ZXing yuklandi (fallback rejim)');
 }
 };
 s.onerror = () => {
 console.warn('ZXing yuklanmadi');
 showToast('Skaner moduli yuklanmadi, qo\'lda kiriting', 'error');
 openManualInput();
 };
 document.head.appendChild(s);
}

// ─────────────────────────────────────────────
// KAMERA
// ─────────────────────────────────────────────
async function startCamera() {
 const video = document.getElementById('cameraFeed');
 const cameraOff = document.getElementById('cameraOff');

 // HTTPS / isSecureContext tekshiruvi (5.6)
 if (typeof window !== 'undefined' && window.isSecureContext === false) {
 console.warn('Kamera xavfsiz kontekst (HTTPS yoki localhost) talab qiladi');
 showToast('Kamera ishlashi uchun HTTPS kerak!', 'error');
 if (cameraOff) cameraOff.style.display = 'flex';
 if (video) video.style.display = 'none';
 return;
 }

 try {
 if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
 throw new Error('Kamera brauzerda qo\'llab-quvvatlanmaydi yoki HTTPS talab qilinadi.');
 }

 // Orqa kamerani tanlash
 const constraints = {
 video: {
 facingMode: { ideal: 'environment' },
 width: { ideal: 1280 },
 height: { ideal: 720 }
 }
 };

 const stream = await navigator.mediaDevices.getUserMedia(constraints);
 APP.cameraStream = stream;
 if (video) {
 video.srcObject = stream;
 video.style.display = 'block';
 }
 if (cameraOff) cameraOff.style.display = 'none';

 if (video) {
 video.addEventListener('loadedmetadata', () => {
 video.play().catch(e => console.warn('Video play:', e));
 startScanning();
 }, { once: true });
 }
 } catch (err) {
 console.error('Kamera xatosi:', err);
 if (cameraOff) cameraOff.style.display = 'flex';
 if (video) video.style.display = 'none';
 showToast('Kameraga ruxsat berilmadi yoki kamera topilmadi.');
 }
}

function stopCamera() {
 if (APP.cameraStream) {
 if (APP.torchOn) {
 try {
 const track = APP.cameraStream.getVideoTracks()[0];
 track?.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
 } catch (e) {}
 APP.torchOn = false;
 updateTorchUI();
 }
 APP.cameraStream.getTracks().forEach(t => t.stop());
 APP.cameraStream = null;
 }
 if (APP._zxingControls) {
 try {
 APP._zxingControls.stop();
 } catch (e) {}
 APP._zxingControls = null;
 } else if (zxingReader) {
 try { zxingReader.reset(); } catch (e) {}
 }
 APP.scanning = false;
 if (APP.scannerLoop) {
 cancelAnimationFrame(APP.scannerLoop);
 APP.scannerLoop = null;
 }
}

// ── Kamera Fonari (Torch) ──
async function toggleTorch() {
 if (!APP.cameraStream) {
 showToast('Kamera yoqilmagan. Avval kamerani yoqing.');
 return;
 }

 const track = APP.cameraStream.getVideoTracks()[0];
 if (!track) {
 showToast('Kamera oqimi topilmadi');
 return;
 }

 try {
 APP.torchOn = !APP.torchOn;
 await track.applyConstraints({
 advanced: [{ torch: APP.torchOn }]
 });

 updateTorchUI();
 if (typeof SOUNDS !== 'undefined') SOUNDS.pop();
 showToast(APP.torchOn ? ' Fonar yoqildi' : ' Fonar o\'chirildi');
 vibrateDevice([40]);
 } catch (err) {
 console.warn('Torch xatosi:', err);
 APP.torchOn = false;
 updateTorchUI();
 showToast('Ushbu qurilmada kamera fonari mavjud emas');
 }
}

function updateTorchUI() {
 const btn = document.getElementById('torchBtn');
 if (!btn) return;
 if (APP.torchOn) {
 btn.classList.add('active');
 btn.setAttribute('title', 'Fonarni o\'chirish');
 } else {
 btn.classList.remove('active');
 btn.setAttribute('title', 'Fonarni yoqish');
 }
}

// ─────────────────────────────────────────────
// SCANNING ENGINE
// ─────────────────────────────────────────────
function startScanning() {
 if (APP.scanning) return;
 APP.scanning = true;

 if (APP.barcodeDetector) {
 scanWithNativeAPI();
 } else {
 scanWithZXing();
 }
}

// ── Native BarcodeDetector (eng yaxshi usul) ──
async function scanWithNativeAPI() {
 const video = document.getElementById('cameraFeed');
 const THROTTLE_MS = 120;
 let lastDetectTime = 0;

 const loop = (timestamp) => {
 if (!APP.scanning) return;

 if ((timestamp - lastDetectTime) >= THROTTLE_MS && video.readyState === video.HAVE_ENOUGH_DATA) {
 lastDetectTime = timestamp;
 APP.barcodeDetector.detect(video).then((barcodes) => {
 if (barcodes.length > 0 && APP.scanning) {
 handleBarcodeDetected(barcodes[0].rawValue);
 }
 }).catch(() => {});
 }

 APP.scannerLoop = requestAnimationFrame(loop);
 };

 APP.scannerLoop = requestAnimationFrame(loop);
}

// ── ZXing fallback ──
function scanWithZXing() {
 if (!APP.scanning) return;
 const video = document.getElementById('cameraFeed');

 if (zxingReader && video) {
 zxingReader.decodeFromVideoElement(video, (result, err) => {
 if (result && APP.scanning) {
 handleBarcodeDetected(result.getText());
 }
 }).then(controls => {
 APP._zxingControls = controls;
 }).catch(e => console.warn('ZXing xato:', e));
 } else {
 // ZXing hali yuklanmagan bo'lsa kutib turish
 setTimeout(() => {
 if (APP.scanning) scanWithZXing();
 }, 500);
 }
}

// ─────────────────────────────────────────────
// BARCODE HANDLER
// ─────────────────────────────────────────────
function handleBarcodeDetected(rawCode) {
 if (!rawCode) return;

 // Modal ochiq paytda yoki onlayn qidiruv ketayotganda skanerlashni bloklash
 if (!APP._scanForModal && document.querySelector('.modal-overlay.open')) return;
 // Boshqa sahifada skaner savatga qo'shmasin
 if (APP.currentPage !== 'scanner' && !APP._scanForModal) return;

 if (APP.isLookingUpOnline) return;

 rawCode = String(rawCode).trim();
 const code = extractProductBarcode(rawCode);

 const now = Date.now();
 // Cooldown: bir xil kodni qayta o'qimaslik
 if (code === APP.lastScanned && (now - APP.lastScannedTime) < APP.scanCooldown) return;

 APP.lastScanned = code;
 APP.lastScannedTime = now;

 // Flash effekti
 flashScanner();

 // Agar Asl Belgisi QR-kod bo'lsa
 if (code !== rawCode) {
 console.log(` Asl Belgisi QR kod o'qildi: ${rawCode} -> GTIN: ${code}`);
 }

 // ─── Modal uchun skaner rejimi ───
 // scanForModal() chaqirilganda navbatdagi skanlangan kodni modal ga yozamiz
 if (APP._scanForModal) {
  APP._scanForModal = false;
  const barcodeInput = document.getElementById('productBarcode');
  if (barcodeInput) barcodeInput.value = code;
  openModal('addProductModal');
  showToast(`Kod kiritildi: ${code}`);
  updateScanHint('Shtrix-kodni ramka ichiga oling', '');
  return;
 }

 // ─── Tovar kirimi uchun skaner rejimi ───
 if (APP._scanForSupply) {
  APP._scanForSupply = false;
  showPage('products');
  const p = findProductByBarcode(code);
  if (p) {
   openSupplyModal(p.id);
   showToast(`${p.name} kirim uchun tanlandi`);
  } else {
   openSupplyModal();
   const bInput = document.getElementById('supplyBarcode');
   if (bInput) bInput.value = code;
   showToast(`Kod kiritildi: ${code}`);
  }
  updateScanHint('Shtrix-kodni ramka ichiga oling', '');
  return;
 }

 // ─── Ombor sanog'i (reviziya) uchun skaner rejimi ───
 if (APP._scanForAudit) {
  APP._scanForAudit = false;
  showPage('products');
  const p = findProductByBarcode(code);
  if (p) {
   openAuditModal();
   selectAuditProduct(p);
   showToast(`${p.name} sanoq uchun tanlandi`);
  } else {
   openAuditModal();
   const bInput = document.getElementById('auditBarcode');
   if (bInput) bInput.value = code;
   showToast(`Kod: ${code} bazada topilmadi`, 'warning');
  }
  updateScanHint('Shtrix-kodni ramka ichiga oling', '');
  return;
 }

 // Mahsulotni qidirish
 const product = findProductByBarcode(code);

 if (product) {
 // Topildi — savatga qo'sh
 const added = addToCart(product);
 if (added) {
 showScanSuccess(product);
 updateScanHint(`${product.name}`, 'success');
 } else {
 updateScanHint(`${product.name} — omborda qolmagan`, 'error');
 }
 } else {
 // Mahalliy bazada topilmadi — internetdan qidiramiz
 APP.isLookingUpOnline = true;
 SOUNDS.error();
 updateScanHint(`${code} internetdan qidirilmoqda...`, 'success');
 showToast(`Kod: ${code} — qidirilmoqda...`);
 vibrateDevice([100, 50, 100]);

 // Async internet qidiruv
 lookupBarcodeOnline(code).then(result => {
 if (result) {
 // Internet da topildi — modalni avtomatik to'ldirish
 updateScanHint(`Internetdan topildi: ${result.name}`, 'success');
 showToast(`"${result.name}" topildi!`);
 vibrateDevice([80, 40, 80]);
 openAddProductModalWithData(result, code, rawCode);
 } else {
 // Internetda ham topilmadi
 showProductFoundCard(null, code);
 updateScanHint(`Kod: ${code} — yangi mahsulot`, 'error');
 showToast(`"${code}" topilmadi. Yangi mahsulot qo'shing.`);
 openAddProductModalWithData({ name: '', image: null, category: 'boshqa', brand: '' }, code, rawCode);
 }
 }).catch(() => {
 showProductFoundCard(null, code);
 updateScanHint(`Internet yo'q — yangi mahsulot`, 'error');
 openAddProductModalWithData({ name: '', image: null, category: 'boshqa', brand: '' }, code, rawCode);
 }).finally(() => {
 APP.isLookingUpOnline = false;
 });
 }

 // 6 soniyadan keyin hint qaytarish
 setTimeout(() => updateScanHint('Shtrix-kodni ramka ichiga oling', ''), 6000);
}

function findProductByBarcode(code) {
 if (!code) return null;
 const cleanCode = extractProductBarcode(code);
 const rawCode = String(code).trim();
 const noLead0 = cleanCode.replace(/^0+/, '');

 return APP.products.find(p => {
 const pClean = extractProductBarcode(p.barcode);
 const pNoLead0 = pClean ? pClean.replace(/^0+/, '') : '';

 // 1. Asosiy shtrix-kod
 if (p.barcode === cleanCode || p.barcode === rawCode || p.barcode === noLead0) return true;
 if (pClean === cleanCode || pClean === noLead0 || pNoLead0 === noLead0) return true;

 // 2. Biriktirilgan qo'shimcha shtrix-kodlar (multi-barcode)
 if (Array.isArray(p.barcodes) && p.barcodes.length > 0) {
 for (const b of p.barcodes) {
 const bClean = extractProductBarcode(b);
 if (b === cleanCode || b === rawCode || b === noLead0) return true;
 if (bClean === cleanCode || bClean === noLead0) return true;
 }
 }

 return false;
 });
}

function flashScanner() {
 const flash = document.getElementById('scanFlash');
 flash.classList.remove('flash');
 void flash.offsetWidth; // reflow
 flash.classList.add('flash');
 vibrateDevice([80]);
}

function updateScanHint(text, type) {
 const hint = document.getElementById('scanHint');
 if (!hint) return;
 let cleanText = String(text || '').replace(/[\u{1F000}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\uFE0F]/gu, '').trim();
 hint.textContent = cleanText;
 hint.style.color = type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : 'rgba(255,255,255,0.7)';
}

function vibrateDevice(pattern) {
 if ('vibrate' in navigator) {
 navigator.vibrate(pattern);
 }
}

// Manual barcode qidirish
function searchManualBarcode() {
 const input = document.getElementById('manualBarcodeInput');
 const rawCode = input.value.trim();
 if (!rawCode) { showToast('Shtrix-kod kiriting'); return; }

 const code = extractProductBarcode(rawCode);
 const product = findProductByBarcode(code);
 if (product) {
 showProductFoundCard(product, code);
 SOUNDS.tiq();
 } else {
 showToast(`"${code}" — topilmadi`);
 showProductFoundCard(null, code);
 }
}

function showProductFoundCard(product, code) {
 APP.foundProduct = product;
 const card = document.getElementById('productFoundCard');
 const pfBarcode = document.getElementById('pfBarcode');
 const pfName = document.getElementById('pfName');
 const pfPrice = document.getElementById('pfPrice');
 const pfImgWrap = document.getElementById('pfImgWrap');
 const pfImg = document.getElementById('pfImg');

 pfBarcode.textContent = code;
 if (product) {
 pfName.textContent = product.name;
 pfPrice.textContent = formatPrice(product.price);
 card.style.background = 'linear-gradient(135deg, rgba(34,197,94,0.15), rgba(6,182,212,0.1))';
 card.style.borderColor = 'rgba(34,197,94,0.4)';
 if (product.image && pfImg && pfImgWrap) {
 pfImg.src = product.image;
 pfImgWrap.style.display = 'block';
 } else if (pfImgWrap) {
 pfImgWrap.style.display = 'none';
 }
 } else {
 pfName.textContent = 'Mahsulot topilmadi';
 pfPrice.textContent = 'Bazada yo\'q';
 card.style.background = 'linear-gradient(135deg, rgba(239,68,68,0.15), rgba(239,68,68,0.05))';
 card.style.borderColor = 'rgba(239,68,68,0.4)';
 if (pfImgWrap) pfImgWrap.style.display = 'none';
 }
 card.style.display = 'flex';
}

function addFoundProductToCart() {
 if (!APP.foundProduct) return;
 const added = addToCart(APP.foundProduct);
 if (added) {
 showScanSuccess(APP.foundProduct);
 updateScanHint(`${APP.foundProduct.name}`, 'success');
 document.getElementById('productFoundCard').style.display = 'none';
 document.getElementById('manualBarcodeInput').value = '';
 APP.foundProduct = null;
 } else {
 updateScanHint(`${APP.foundProduct.name} — omborda qolmagan`, 'error');
 }
}

// ─────────────────────────────────────────────
// TEZKOR KODSIZ TOVARLAR (QUICK ITEMS)
// ─────────────────────────────────────────────
const DEFAULT_QUICK_ITEMS = [
 { id: 'q_paket_500', name: 'Paket (oddiy)', price: 500, category: 'uy' },
 { id: 'q_paket_1000', name: 'Katta paket', price: 1000, category: 'uy' },
 { id: 'q_non_4000', name: 'Tandir non', price: 4000, category: 'non' },
 { id: 'q_patir_7000', name: 'Patir non', price: 7000, category: 'non' },
 { id: 'q_tuxum_1500', name: 'Tuxum (1 dona)', price: 1500, category: 'oziq' },
 { id: 'q_suv_3000', name: 'Muzdek suv 0.5L', price: 3000, category: 'suv_05' },
 { id: 'q_tarvuz_15000', name: 'Tarvuz (dona)', price: 15000, category: 'oziq' },
 { id: 'q_qovun_18000', name: 'Qovun (dona)', price: 18000, category: 'oziq' }
];

function loadQuickItems() {
 try {
 const raw = localStorage.getItem(nsKey('scanpos_quick_items'));
 if (raw) {
 const parsed = JSON.parse(raw);
 if (Array.isArray(parsed) && parsed.length > 0) {
 APP.quickItems = parsed;
 } else {
 APP.quickItems = [...DEFAULT_QUICK_ITEMS];
 }
 } else {
 APP.quickItems = [...DEFAULT_QUICK_ITEMS];
 }
 } catch (e) {
 APP.quickItems = [...DEFAULT_QUICK_ITEMS];
 }
 renderQuickItems();
}

function saveQuickItems() {
 try {
 localStorage.setItem(nsKey('scanpos_quick_items'), JSON.stringify(APP.quickItems));
 } catch (e) {}
}

function renderQuickItems() {
 const container = document.getElementById('quickItemsScroll');
 if (!container) return;

 if (!APP.quickItems || APP.quickItems.length === 0) {
 APP.quickItems = [...DEFAULT_QUICK_ITEMS];
 }

 const itemsHtml = APP.quickItems.map(item => `
 <div class="quick-item-card" onclick="addQuickItemToCart('${item.id}', event)">
 <div class="quick-item-top">
 <span class="quick-item-emoji">${catIcon(item.category || 'boshqa')}</span>
 <button class="quick-item-del" onclick="event.stopPropagation(); deleteQuickItem('${item.id}')" title="O'chirish">${icon('x', 14)}</button>
 </div>
 <div class="quick-item-name">${escHtml(item.name)}</div>
 <div class="quick-item-price">${formatPriceShort(item.price)} so'm</div>
 </div>
 `).join('');

 const addBtnHtml = `
 <button type="button" class="quick-item-add-card" onclick="openQuickItemModal()" title="Yangi tezkor tovar qo'shish">
 <span class="quick-add-icon">${icon('plus', 18)}</span>
 <span class="quick-add-text">Yangi tovar</span>
 </button>
 `;

 container.innerHTML = itemsHtml + addBtnHtml;
}

function addQuickItemToCart(itemId, event) {
 const item = APP.quickItems.find(q => q.id === itemId);
 if (!item) return;

 const productObj = {
 id: item.id,
 name: item.name,
 price: Number(item.price),
 barcode: '',
 category: item.category || 'boshqa',
 isQuick: true,
 trackStock: false
 };

 const added = addToCart(productObj);
 if (added) {
 showScanSuccess(productObj);
 updateScanHint(`${productObj.name}`, 'success');
 }

 if (event && event.currentTarget) {
 const card = event.currentTarget;
 card.classList.remove('quick-pop-active');
 void card.offsetWidth;
 card.classList.add('quick-pop-active');
 setTimeout(() => card.classList.remove('quick-pop-active'), 250);
 }
}

function openQuickItemModal(item = null) {
 document.getElementById('quickItemName').value = item?.name || '';
 document.getElementById('quickItemPrice').value = item?.price || '';
 const catEl = document.getElementById('quickItemCategory');
 if (catEl) catEl.value = item?.category || 'uy';
 openModal('quickItemModal');
}

function saveQuickItem() {
 const name = document.getElementById('quickItemName').value.trim();
 const price = Number(document.getElementById('quickItemPrice').value);
 const category = document.getElementById('quickItemCategory') ? document.getElementById('quickItemCategory').value : 'boshqa';

 if (!name) {
 showToast('Iltimos, tovar nomini kiriting', 'warning');
 return;
 }
 if (!price || price <= 0) {
 showToast('Iltimos, tovar narxini to\'g\'ri kiriting', 'warning');
 return;
 }

 const newItem = {
 id: 'q_' + Date.now(),
 name,
 price,
 category
 };

 APP.quickItems.push(newItem);
 saveQuickItems();
 renderQuickItems();
 closeModal('quickItemModal');
 if (typeof SOUNDS !== 'undefined') SOUNDS.pop();
 showToast(`"${name}" tezkor tovarlarga qo'shildi!`, 'success');
}

function deleteQuickItem(itemId) {
 const item = APP.quickItems.find(q => q.id === itemId);
 if (!item) return;
 if (!confirm(`"${item.name}" tezkor tovarini o'chirishni xohlaysizmi?`)) return;

 APP.quickItems = APP.quickItems.filter(q => q.id !== itemId);
 saveQuickItems();
 renderQuickItems();
 showToast(`"${item.name}" o'chirildi`, 'info');
}

// ─────────────────────────────────────────────
// CART (SAVAT)
// ─────────────────────────────────────────────
function addToCart(product, qtyToAdd = 1) {
  // Yaroqlilik muddati tekshiruvi (Expiry check)
  if (product && product.expiryDate && typeof getExpiryStatus === 'function') {
    const expInfo = getExpiryStatus(product.expiryDate);
    if (expInfo.status === 'expired') {
      if (typeof SOUNDS !== 'undefined') SOUNDS.error();
      showToast(`DIQQAT! "${product.name}" muddati O'TGAN (${product.expiryDate})!`, 'error');
      const doConfirm = (typeof window !== 'undefined' && typeof window.confirm === 'function') ? window.confirm : (typeof confirm === 'function' ? confirm : () => true);
      const proceed = doConfirm(`DIQQAT! XAVF!\n"${product.name}" mahsulotining yaroqlilik muddati O'TGAN (${product.expiryDate})!\nMuddati o'tgan tovar sotish jarimaga sabab bo'ladi.\nBaribir savatga qo'shilsinmi?`);
      if (!proceed) return false;
    } else if (expInfo.status === 'today' || expInfo.status === 'expiring') {
      showToast(`Diqqat: "${product.name}" muddati ${expInfo.label} (${product.expiryDate})!`, 'warning');
    }
  }

  const shouldTrack = isTracked(product);
 const addAmount = parseFloat(qtyToAdd) || 1;

 // Stock tekshiruvi (faqat trackStock=true bo'lganda)
 if (shouldTrack) {
 const existing = APP.cart.find(i => i.id === product.id);
 const cartQty = existing ? (parseFloat(existing.qty) || 0) : 0;
 const currentStock = parseFloat(product.stock) || 0;
 if (currentStock <= 0) {
 if (typeof SOUNDS !== 'undefined') SOUNDS.error();
 showToast(`Diqqat: ${product.name} — omborda qolmagan!`, 'warning');
 return false;
 }
 if (cartQty + addAmount > currentStock) {
 if (!confirm(`Diqqat: Omborda ${currentStock} ${product.unit || 'ta'} mavjud. ${Math.round((cartQty + addAmount) * 1000) / 1000} ${product.unit || 'ta'} qo'shilsinmi?`)) return false;
 }
 }

 // Tovush berish (Korzinka kassa skaneri "TIQ!" tovushi)
 if (typeof SOUNDS !== 'undefined') SOUNDS.tiq();

 const existing = APP.cart.find(i => i.id === product.id);
 if (existing) {
 existing.qty = Math.round(((parseFloat(existing.qty) || 0) + addAmount) * 1000) / 1000;
 showToast(`${product.name} → ${existing.qty} ${product.unit || 'ta'}`);
 } else {
 APP.cart.push({
 id: product.id,
 barcode: product.barcode,
 name: product.name,
 price: product.price,
 costPrice: product.costPrice || null,
 qty: Math.round(addAmount * 1000) / 1000,
 unit: product.unit || 'dona',
 category: product.category || 'boshqa',
 isQuick: !!product.isQuick,
 trackStock: !!product.trackStock
 });
 showToast(`${product.name} savatga qo'shildi`);
 }
 updateCartUI();
 return true;
}

function removeFromCart(productId) {
 APP.cart = APP.cart.filter(i => i.id !== productId);
 updateCartUI();
}

function changeQty(productId, delta) {
 const item = APP.cart.find(i => i.id === productId);
 if (!item) return;
 const d = parseFloat(delta) || 0;
 const newQty = Math.round(((parseFloat(item.qty) || 0) + d) * 1000) / 1000;
 if (newQty <= 0) {
 APP.cart = APP.cart.filter(i => i.id !== productId);
 } else {
 item.qty = newQty;
 if (typeof SOUNDS !== 'undefined' && d > 0) SOUNDS.pop();
 }
 updateCartUI();
}

function setCartQty(productId, newQty) {
 const item = APP.cart.find(i => i.id === productId);
 if (!item) return;
 const val = parseFloat(newQty);
 if (isNaN(val) || val <= 0) {
 removeFromCart(productId);
 return;
 }
 const prod = APP.products.find(p => p.id === productId);
 if (prod && isTracked(prod)) {
 const curStock = parseFloat(prod.stock) || 0;
 if (val > curStock) {
 if (!confirm(`Diqqat: Omborda ${curStock} ${item.unit || 'ta'} mavjud. ${val} ${item.unit || 'ta'} qo'yilsinmi?`)) {
 updateCartUI();
 return;
 }
 }
 }
 item.qty = Math.round(val * 1000) / 1000;
 updateCartUI();
}

function clearCart() {
 if (APP.cart.length === 0) return;
 if (!confirm('Savatni tozalashni tasdiqlaysizmi?')) return;
 APP.cart = [];
 updateCartUI();
 showToast('Savat tozalandi');
}

function updateCartUI() {
 // Savatni localStorage ga saqlash
 try {
 localStorage.setItem(nsKey('scanpos_cart'), JSON.stringify(APP.cart || []));
 } catch (e) {}

 const cartList = document.getElementById('cartList');
 const emptyCart = document.getElementById('emptyCart');
 const cartFooter = document.getElementById('cartFooter');
 const clearCartBtn = document.getElementById('clearCartBtn');
 const holdCartBtn = document.getElementById('holdCartBtn');
 const heldCartsBtn = document.getElementById('heldCartsBtn');
 const heldCartsCount = document.getElementById('heldCartsCount');
 const cartCount = document.getElementById('cartCount');

 const heldTotal = (APP.heldCarts && APP.heldCarts.length) || 0;
 if (heldCartsBtn) heldCartsBtn.style.display = heldTotal > 0 ? 'inline-flex' : 'none';
 if (heldCartsCount) heldCartsCount.textContent = heldTotal;
 if (holdCartBtn) holdCartBtn.style.display = APP.cart.length > 0 ? 'inline-flex' : 'none';

 const totalQty = APP.cart.reduce((s, i) => s + (Number(i.qty) || 0), 0);
 if (cartCount) cartCount.textContent = totalQty;

 if (APP.cart.length === 0) {
 if (emptyCart) emptyCart.style.display = 'flex';
 if (cartFooter) cartFooter.style.display = 'none';
 if (clearCartBtn) clearCartBtn.style.display = 'none';
 if (cartList) cartList.innerHTML = '';
 return;
 }

 if (emptyCart) emptyCart.style.display = 'none';
 if (cartFooter) cartFooter.style.display = 'block';
 if (clearCartBtn) clearCartBtn.style.display = 'inline-flex';

 // Yagona hisob-kitob (calcTotals)
 const { subtotal, tax, total: grand } = calcTotals(APP.cart, 0, APP.settings.taxRate);

 const totalItemsEl = document.getElementById('totalItems');
 if (totalItemsEl) totalItemsEl.textContent = totalQty + ' ta';
 const subtotalAmtEl = document.getElementById('subtotalAmt');
 if (subtotalAmtEl) subtotalAmtEl.textContent = formatPrice(subtotal);
 const grandTotalEl = document.getElementById('grandTotal');
 if (grandTotalEl) grandTotalEl.textContent = formatPrice(grand);
 const checkoutTotalEl = document.getElementById('checkoutTotal');
 if (checkoutTotalEl) checkoutTotalEl.textContent = formatPrice(grand);

 // QQS qatori
 const discountRow = document.getElementById('discountRow');
 const discountAmt = document.getElementById('discountAmt');
 if (discountRow && discountAmt) {
 if (tax > 0) {
 discountRow.style.display = 'flex';
 discountAmt.textContent = `+${formatPrice(tax)} (QQS)`;
 discountAmt.style.color = '#f59e0b';
 } else {
 discountRow.style.display = 'none';
 }
 }

 // Render items
 if (cartList) {
    cartList.innerHTML = APP.cart.map((item, idx) => `
      <li class="cart-item" id="cart-item-${item.id}">
        <div class="cart-item-header">
          <div class="item-num">${idx + 1}</div>
          <div class="item-thumb-box">
            ${item.image ? `<img src="${escHtml(item.image)}" class="item-thumb-img" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : ''}
            <span class="item-thumb-fallback" style="${item.image ? 'display:none' : 'display:flex'}">${catIcon(item.category)}</span>
          </div>
          <div class="item-info">
            <div class="item-name" title="${escHtml(item.name)}">${escHtml(item.name)}</div>
            <div class="item-meta">
              <span class="item-price-each">${formatPrice(item.price)}/${escHtml(item.unit || 'ta')}</span>
              ${(item.barcode && !item.isQuick && !String(item.barcode).startsWith('QUICK_')) ? `<span class="item-barcode-tag">${escHtml(item.barcode)}</span>` : ''}
            </div>
          </div>
          <button type="button" class="item-remove" onclick="removeFromCart('${item.id}')" title="Savatdan o'chirish" aria-label="O'chirish">${icon('x', 14)}</button>
        </div>
        <div class="cart-item-bottom">
          <div class="item-qty-control">
            <button type="button" class="qty-btn qty-minus" onclick="changeQty('${item.id}', -1)" aria-label="Kamaytirish">−</button>
            <input type="number" inputmode="decimal" step="any" min="0.001" value="${item.qty}" class="cart-qty-input" onchange="setCartQty('${item.id}', this.value)" onfocus="this.select()" aria-label="Miqdor" style="width:46px;min-width:38px;max-width:52px;height:28px;text-align:center;background:var(--bg2,#131626);border:1px solid var(--border,rgba(255,255,255,0.12));border-radius:7px;color:var(--text,#f1f5f9);font-weight:700;font-size:0.85rem;padding:0 4px;box-sizing:border-box;margin:0;" />
            <button type="button" class="qty-btn qty-plus" onclick="changeQty('${item.id}', 1)" aria-label="Ko'paytirish">+</button>
            <span class="qty-unit">${escHtml(item.unit || 'ta')}</span>
          </div>
          <div class="item-price-total">${formatPrice(Math.round(item.price * item.qty))}</div>
        </div>
      </li>
    `).join('');
  }
}

// ─────────────────────────────────────────────
// CHECKOUT (TO'LOV)
// ─────────────────────────────────────────────
function populateCheckoutDebtors() {
 const select = document.getElementById('checkoutDebtorSelect');
 if (!select) return;
 const currentVal = select.value;
 select.innerHTML = '<option value="">-- Mijozni tanlang --</option>' +
 (APP.debtors || []).map(d => `<option value="${d.id}">${escHtml(d.name)} (${escHtml(d.phone || 'tel yo\'q')})</option>`).join('') +
 '<option value="new">+ Yangi mijoz kiritish...</option>';
 if (currentVal) select.value = currentVal;
}

function onCheckoutDebtorChange() {
 const select = document.getElementById('checkoutDebtorSelect');
 const newFields = document.getElementById('newDebtorQuickFields');
 if (select && select.value === 'new') {
 if (newFields) newFields.style.display = 'block';
 } else {
 if (newFields) newFields.style.display = 'none';
 }
}

function proceedToCheckout() {
 if (APP.cart.length === 0) { showToast('Savat bo\'sh'); return; }

 const { total: grand } = calcTotals(APP.cart, 0, APP.settings.taxRate);

 const checkoutAmtEl = document.getElementById('checkoutAmount');
 if (checkoutAmtEl) checkoutAmtEl.textContent = formatPrice(grand);
 const cashGivenInput = document.getElementById('cashGiven');
 if (cashGivenInput) cashGivenInput.value = '';
 const changeDisplay = document.getElementById('changeDisplay');
 if (changeDisplay) changeDisplay.style.display = 'none';
 const discountInput = document.getElementById('discountPercent');
 if (discountInput) discountInput.value = '';

 // Chegirma bo'limi
 const discountSection = document.getElementById('discountSection');
 if (discountSection) {
 discountSection.style.display = APP.settings.discountEnabled ? 'block' : 'none';
 }

 APP.selectedPayment = 'cash';
 selectPayment('cash');

 openModal('checkoutModal');
}

function selectPayment(type) {
 APP.selectedPayment = type;
 ['cash', 'card', 'transfer', 'debt'].forEach(t => {
 const el = document.getElementById(`pm-${t}`);
 if (el) el.classList.toggle('active', t === type);
 });
 const cashSection = document.getElementById('cashChangeSection');
 if (cashSection) cashSection.style.display = type === 'cash' ? 'block' : 'none';
 const debtSection = document.getElementById('debtCustomerSection');
 if (debtSection) {
 debtSection.style.display = type === 'debt' ? 'block' : 'none';
 if (type === 'debt') populateCheckoutDebtors();
 }
}

function calcChange() {
 const discountInput = document.getElementById('discountPercent');
 const rawPct = parseFloat(discountInput ? discountInput.value : 0) || 0;
 const { total: grand } = calcTotals(APP.cart, rawPct, APP.settings.taxRate);

 const cashGivenInput = document.getElementById('cashGiven');
 const given = parseFloat(cashGivenInput ? cashGivenInput.value : 0) || 0;
 const change = given - grand;

 const display = document.getElementById('changeDisplay');
 const changeEl = document.getElementById('changeAmount');

 if (given > 0 && display && changeEl) {
 display.style.display = 'flex';
 if (change >= 0) {
 changeEl.textContent = formatPrice(change);
 changeEl.style.color = '#22c55e';
 } else {
 changeEl.textContent = `Yetishmaydi: ${formatPrice(Math.abs(change))}`;
 changeEl.style.color = '#ef4444';
 }
 } else if (display) {
 display.style.display = 'none';
 }
}

function applyDiscount() {
 const discountInput = document.getElementById('discountPercent');
 let rawPct = parseFloat(discountInput ? discountInput.value : 0) || 0;
 if (rawPct < 0) rawPct = 0;
 if (rawPct > 100) rawPct = 100;
 if (discountInput && discountInput.value !== '' && !isNaN(rawPct)) {
 discountInput.value = rawPct;
 }
 const { total: grand } = calcTotals(APP.cart, rawPct, APP.settings.taxRate);
 const checkoutAmtEl = document.getElementById('checkoutAmount');
 if (checkoutAmtEl) checkoutAmtEl.textContent = formatPrice(grand);
 calcChange();
}

 async function completeSale() {
 if (APP.isCheckingOut) return;
 APP.isCheckingOut = true;

 const confirmBtn = document.querySelector('#checkoutModal .btn-success') || document.querySelector('#checkoutModal button[onclick*="completeSale"]');
 if (confirmBtn) confirmBtn.disabled = true;

 try {
 const rawDiscountPct = parseFloat(document.getElementById('discountPercent')?.value) || 0;
 const { subtotal, discount, taxable, tax, total: grand, discountPercent } = calcTotals(APP.cart, rawDiscountPct, APP.settings.taxRate);

 // Naqd to'lovda yetarlilik tekshiruvi
 const cashGivenVal = parseFloat(document.getElementById('cashGiven')?.value) || 0;
 if (APP.selectedPayment === 'cash' && cashGivenVal > 0 && cashGivenVal < grand) {
 showToast('Yetarli pul kiritilmagan', 'warning');
 return;
 }

 // Nasiya to'lovida mijoz tekshiruvi
 let debtCustomer = null;
 if (APP.selectedPayment === 'debt') {
 const debtorSelect = document.getElementById('checkoutDebtorSelect');
 const debtorVal = debtorSelect ? debtorSelect.value : '';
 if (!debtorVal) {
 showToast('Nasiya uchun mijoz tanlanishi shart!', 'warning');
 return;
 }
 if (debtorVal === 'new') {
 const newName = (document.getElementById('checkoutNewDebtorName')?.value || document.getElementById('newDebtorName')?.value || '').trim();
 const newPhone = (document.getElementById('checkoutNewDebtorPhone')?.value || document.getElementById('newDebtorPhone')?.value || '').trim();
 if (!newName) {
 showToast('Yangi mijoz ismini kiriting!', 'warning');
 return;
 }
 debtCustomer = {
 id: generateId(),
 name: newName,
 phone: newPhone,
 createdAt: new Date().toISOString()
 };
 APP.debtors.unshift(debtCustomer);
 await saveDebtorToDB(debtCustomer);
 } else {
 debtCustomer = APP.debtors.find(d => d.id === debtorVal);
 }
 if (!debtCustomer) {
 showToast('Tanlangan mijoz topilmadi!', 'error');
 return;
 }
 }

 const cashGiven = APP.selectedPayment === 'cash' ? cashGivenVal : 0;
 const change = APP.selectedPayment === 'cash' ? Math.max(0, cashGiven - grand) : 0;

 // 1.3: Chek ichida rasm nusxalanmaydi, faqat qisqa maydonlar va costPrice
 const bill = {
 id: generateId(),
 timestamp: new Date().toISOString(),
 items: APP.cart.map(i => ({
 id: i.id,
 barcode: i.barcode || '',
 name: i.name,
 price: Number(i.price) || 0,
 costPrice: Number(i.costPrice) || 0,
 qty: Math.round((Number(i.qty) || 1) * 1000) / 1000,
 unit: i.unit || 'dona',
 category: i.category || 'boshqa',
 isQuick: Boolean(i.isQuick)
 })),
 subtotal,
 discount,
 discountPercent,
 tax,
 total: grand,
 paymentMethod: APP.selectedPayment,
 debtorId: debtCustomer ? debtCustomer.id : null,
 debtorName: debtCustomer ? debtCustomer.name : null,
 shopName: APP.settings.shopName || 'ScanPOS',
 cashGiven,
 change,
 refunds: []
 };

 // 4: Faqat isTracked tovarlar ombori kamaytiriladi
 const stockUpdates = [];
 for (const item of APP.cart) {
 const prod = APP.products.find(p => p.id === item.id);
 if (prod && isTracked(prod)) {
 const currentStock = parseFloat(prod.stock) || 0;
 const itemQty = parseFloat(item.qty) || 1;
 const newStock = Math.max(0, Math.round((currentStock - itemQty) * 1000) / 1000);
 stockUpdates.push({ prod, qty: itemQty, newStock });
 }
 }

 // 5, 6, 10: Firestore increment va atomik saleBatch
 if (!window.useDemo && window.firebaseDB && window.firebaseFns && navigator.onLine) {
 try {
  const { writeBatch: wb, increment } = window.firebaseFns;
  const batch = wb(window.firebaseDB);
  for (const { prod, newStock, qty } of stockUpdates) {
  const pRef = userDoc('products', prod.id);
  if (typeof increment === 'function') {
  batch.update(pRef, { stock: increment(-qty), updatedAt: new Date().toISOString() });
  } else {
  batch.update(pRef, { stock: newStock, updatedAt: new Date().toISOString() });
  }
  }
  batch.set(userDoc('bills', bill.id), bill);
 await withTimeout(batch.commit(), 10000);

 stockUpdates.forEach(({ prod, newStock }) => {
 prod.stock = newStock;
 prod.updatedAt = new Date().toISOString();
 });
 APP.bills.unshift(bill);
 await saveLocalData();
 renderBills();
 } catch (e) {
 console.warn('Firebase sotuvda xato/timeout, outbox ga olinmoqda:', e);
 stockUpdates.forEach(({ prod, newStock }) => {
 prod.stock = newStock;
 prod.updatedAt = new Date().toISOString();
 });
 await enqueueOutbox({
 action: 'saleBatch',
 bill,
 products: stockUpdates.map(u => ({ id: u.prod.id, qtyChange: -u.qty, stock: u.newStock }))
 });
 APP.bills.unshift(bill);
 await saveLocalData();
 renderBills();
 showToast("Navbatga qo'yildi, internet kelganda yuboriladi", 'warning');
 }
 } else if (!window.useDemo && window.firebaseDB && window.firebaseFns && !navigator.onLine) {
 // Oflayn Firebase: saleBatch outbox
 stockUpdates.forEach(({ prod, newStock }) => {
 prod.stock = newStock;
 prod.updatedAt = new Date().toISOString();
 });
 await enqueueOutbox({
 action: 'saleBatch',
 bill,
 products: stockUpdates.map(u => ({ id: u.prod.id, qtyChange: -u.qty, stock: u.newStock }))
 });
 APP.bills.unshift(bill);
 await saveLocalData();
 renderBills();
 showToast("Navbatga qo'yildi, internet kelganda yuboriladi", 'warning');
 } else {
 // Demo rejim yoki fallback
 stockUpdates.forEach(({ prod, newStock }) => {
 prod.stock = newStock;
 prod.updatedAt = new Date().toISOString();
 });
 if (window.isFirebaseConfigured) {
 await enqueueOutbox({
 action: 'saleBatch',
 bill,
 products: stockUpdates.map(u => ({ id: u.prod.id, qtyChange: -u.qty, stock: u.newStock }))
 });
 }
 APP.bills.unshift(bill);
 await saveLocalData();
 renderBills();
 }

 // Nasiya cheki bo'lsa, qarz yozuvini avtomatik qo'shish (3.2)
 if (debtCustomer) {
 const debtRecord = {
 id: generateId(),
 debtorId: debtCustomer.id,
 billId: bill.id,
 amount: grand,
 paidAmount: 0,
 description: `Chek #${bill.id.slice(-6).toUpperCase()}`,
 dueDate: '',
 createdAt: new Date().toISOString(),
 payments: []
 };
 APP.debts.unshift(debtRecord);
 await saveDebtToDB(debtRecord);
 updateNasiyaBadge();
 }

 updateProductStats();
 renderProducts();

 if (typeof SOUNDS !== 'undefined') SOUNDS.cash();

 closeModal('checkoutModal');
 APP.cart = [];
 updateCartUI();
 showToast(`To'lov qabul qilindi! ${formatPrice(grand)}`);

 setTimeout(() => {
 showPage('bills');
 vibrateDevice([100, 50, 200]);
 }, 800);
 } catch (err) {
 console.error('Sotuvni yakunlashda xato:', err);
 showToast('To\'lovni amalga oshirishda xatolik yuz berdi: ' + (err.message || ''), 'error');
 } finally {
 APP.isCheckingOut = false;
 if (confirmBtn) confirmBtn.disabled = false;
 }
}

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// AUDIO ENGINE (Haqiqiy Korzinka Skaner "TIQ!" Tovushi)
// ─────────────────────────────────────────────
// Korzinka Datalogic/Honeywell 2800Hz 48ms kassa skaneri "TIQ!" signali (Base64 WAV)
const KORZINKA_SCAN_WAV = 'data:audio/wav;base64,UklGRqwQAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YYgQAAAAAN8AEgOGBfUGbAawA1P/gfqK9mT0XfQU9rv4ifsd/qoAywMWCJUNZRPAF24YkhOHCIH4leYj16nOZtA33Q/zUg35JS034jz1NWQkogxA9E7gFtR+0DzUwdxj517yPv2UCB8VxyLpL1I5CTu7MTocmfxL2Cm3hqHYnbWuwdH//3gvulWKau9pBVVkMWQHwN9xwUawpqxUtNbD5NdM7gcGjR7SNmtMZVsDXztTgjYiC6jXuKZzgwGAwIPRqT7hqB5qVZ96/39Ge9BZUit8+UPNIK08nKWaNKa1u+DXwvewGNY33VHxYklnL1wlQcEY1OijuU2UwYDEg5udzMn//9U1LWFSend9NmsQSCAbc+xzw72lmJbtlqqlP8AP48sJrC/AT1hltWzDY8dKwCQ895LJp6NgjDiIQ5jmuU7nmBhVRRtmzXVZcuFcUDmKDWngt7g8nA+PDZOnp+LJsvSdIaZJYWbfcjJtX1b7Mb0Fmdilsf+W1ozElIitQNP//78sd1I7aylzAGlaTmYnQvoEzqCpzZIgjX2Z9LUL3ngLFzcQWuRuTXLDY45FbBzU7u7Dd6Kxj42OO58bvyzp0xbkQMRgcnFOcIhdETwrEZPjcbo8nLKNG5HvpejIh/T0IQtKgmbfcjJtX1b7Mb0Fmdilsf+W1ozElIitQNP//78sd1I7aylzAGlaTmYnQvoEzqCpzZIgjX2Z9LUL3ngLFzcQWuRuTXLDY45FbBzU7u7Dd6Kxj42OO58bvyzp0xbkQMRgcnFOcIhdETwrEZPjcbo8nLKNG5HvpejIh/T0IQtKgmbfcjJtX1b7Mb0Fmdilsf+W1ozElIitQNP//78sd1I7aylzAGlaTmYnQvoEzqCpzZIgjX2Z9LUL3ngLFzcQWuRuTXLDY45FbBzU7u7Dd6Kxj42OO58bvyzp0xbkQMRgcnFOcIhdETwrEZPjcbo8nLKNG5HvpejIh/T0IQtKgmbfcjJtX1b7Mb0Fmdilsf+W1ozElIitQNP//78sd1I7aylzAGlaTmYnQvoEzqCpzZIgjX2Z9LUL3ngLFzcQWuRuTXLDY45FbBzU7u7Dd6Kxj42OO58bvyzp0xbkQMRgcnFOcIhdETwrEZPjcbo8nLKNG5HvpejIh/T0IQtKgmbfcjJtX1b7Mb0Fmdilsf+W1ozElIitQNP//78sd1I7aylzAGlaTmYnQvoEzqCpzZIgjX2Z9LUL3ngLFzcQWuRuTXLDY45FbBzU7u7Dd6Kxj42OO58bvyzp0xbkQMRgcnFOcIhdETwrEZPjcbo8nLKNG5HvpejIh/T0IQtKgmbfcjJtX1b7Mb0Fmdilsf+W1ozElIitQNP//78sd1I7aylzAGlaTmYnQvoEzqCpzZIgjX2Z9LUL3ngLFzcQWuRuTXLDY45FbBzU7u7Dd6Kxj42OO58bvyzp0xbkQMRgcnFOcIhdETwrEZPjcbo8nLKNG5HvpejIh/T0IQtKgmbfcjJtX1b7Mb0Fmdilsf+W1ozElIitQNP//78sd1I7aylzAGlaTmYnQvoEzqCpzZIgjX2Z9LUL3ngLFzcQWuRuTXLDY45FbBzU7u7Dd6Kxj42OO58bvyzp0xbkQMRgcnFOcIhdETwrEZPjcbo8nLKNG5HvpejIh/T0IQtKgmbfcjJtX1b7Mb0Fmdilsf+W1ozElIitQNP//78sd1I7aylzAGlaTmYnQvoEzqCpzZIgjX2Z9LUL3ngLFzcQWuRuTXLDY45FbBzU7u7Dd6Kxj42OO58bvyzp0xbkQMRgcnFOcIhdETwrEZPjcbo8nLKNG5HvpejIh/T0IQtKgmbfcjJtX1b7Mb0Fmdilsf+W1ozElIitQNP//78sd1I7aylzAGlaTmYnQvoEzqCpzZIgjX2Z9LUL3ngLFzcQWuRuTXLDY45FbBzU7u7Dd6Kxj42OO58bvyzp0xbkQMRgcnFOcIhdETwrEZPjcbo8nLKNG5HvpejIh/T0IQtKgmbfcjJtX1b7Mb0Fmdilsf+W1ozElIitQNP//78sd1I7aylzAGlaTmYnQvoEzqCpzZIgjX2Z9LUL3ngLFzcQWuRuTXLDY45FbBzU7u7Dd6Kxj42OO58bvyzp0xbkQMRgcnFOcIhdETwrEZPjcbo8nLKNG5HvpejIh/T0IQtKgmbfcjJtX1b7Mb0Fmdilsf+W1ozElIitQNP//78sd1I7aylzAGlaTmYnQvoEzqCpzZIgjX2Z9LUL3ngLFzcQWuRuTXLDY45FbBzU7u7Dd6Kxj42OO58bvyzp0xbkQMRgcnFOcIhdETwrEZPjcbo8nLKNG5HvpejIh/T0IQtKgmbfcjJtX1b7Mb0Fmdilsf+W1ozElIitQNP//78sd1I7aylzAGlaTmYnQvoEzqCpzZIgjX2Z9LUL3ngLFzcQWuRuTXLDY45FbBzU7u7Dd6Kxj42OO58bvyzp0xbkQMRgcnFOcIhdETwrEZPjcbo8nLKNG5HvpejIh/T0IQtKgmbfcjJtX1b7Mb0Fmdilsf+W1ozElIitQNP//78sd1I7aylzAGlaTmYnQvoEzqCpzZIgjX2Z9LUL3ngLFzcQWuRuTXLDY45FbBzU7u7Dd6Kxj42OO58bvyzp0xbkQMRgcnFOcIhdETwrEZPjcbo8nLKNG5HvpejIh/T0IQtKgmbfcjJtX1b7Mb0Fmdilsf+W1ozElIitQNP//78sd1I7aylzAGlaTmYnQvoEzqCpzZIgjX2Z9LUL3ngLFzcQWuRuTXLDY45FbBzU7u7Dd6Kxj42OO58bvyzp0xbkQMRgcnFOcIhdAzwTEdvjc7sgnmCQNJTaqO/KAPVmIFVG6mAZbEdmhVBgLk0FydtSuGWgpZdKn/u1B9j//5Ynm0j1XWpkHVuoQ9shF/t41d22/qOwn3qqiML0420JDS1IScZZElz0T3Y3jRZy8tTQ7La0qEaojrVWzp/uSRHlMIhIllRMUwJFFSyIDFvrws1TuFGuLrFTwELZ+veeFzkzh0abTlBKdDqkIdcDxuUizOG6nbQyup/KM+P//3kcLjR3QwpIT0F0MDkYffyf4c/LZ75luyPDS9QT7LAG8R/oM4g/GEF5OCMn5Q909s/eo8y0wnbC1Ms73djzFAwgIpEy6jr0OfYvmx6xCLLxOt1yzpfHoMkg1FXlfPo4ECMjVDDMNc0y6ifyF4CJ+6/3BPR48y60OXbi+z//zATHyNaLV4wyitzIDMQp/286zvdW9Rq0p3XCePQ8msEFBU2ItApyCoQJaYZZwrD+VfqiN4e2ATYKN566SP4zAcBFo4g3yUyJbwelRONBeH23OmA4DPcjN0/5Cnvhfw1ChMWTx6uIcAf5xhKDqAB7fQq6v3ideDh4s3pD/T//7sLbRWdG2QdjxqkE8kJlv7P8yDr2uW/5Ofnwu4q+J4CeAwwFJ8YIhm5FQAPEgZe/Gzzm+zy6PLoiOwT84D7dASIDH4SdRUFFVMRAgsdA+b6p/N77iXs8uyx8L32F/6UBQkMeRBBEicRag2sB98AF/pi9J3wU++o8Ff0wPn//xkGGQtBDh4PnQ0ICvsESP/X+X714/Jj8gP0dPci/EkBGgbYCfQLJwx1CjAH5QJG/gz63vYx9T719fYG+u79CQK1BWIIrQluCbsH4wRfAcL9m/pj+Gz30fd2+RH8Mv9XAgQF0waDBwQHcwUZA1kApf1n+/T5f/kP+oT7nf3//0oCIwRGBYwF9ASeA8gBvv/V/Vb8ePtX++/7If22/mwA/QEsA9AD1gNEAzgC4gB6/zn+T/3a/Oj8b/1T/m3/jgCIATgChgJsAvUBNwFWAHX/uP45/gn+Kf6O/ib/1P98AAUBXAF3AVYBAwGQAA8Al/86/wL/9/4V/1T/p////08AiwCqAK0AlABoADEA+f/J/6j/mP+b/63/yP/o/wcAHwAuADMALwAlABYACAD7//P/7v/u//H/9v/6//7/AQABAAEAAQAAAA==';

const SOUNDS = {
 ctx: null,
 audioEl: null,

 init() {
 try {
 const AudioCtx = window.AudioContext || window.webkitAudioContext;
 if (AudioCtx && !this.ctx) {
 this.ctx = new AudioCtx();
 }
 if (this.ctx && this.ctx.state === 'suspended') {
 this.ctx.resume();
 }
 } catch (e) {
 console.warn('AudioContext init error:', e);
 }
 this.initAudioEl();
 },

 initAudioEl() {
 if (!this.audioEl && typeof Audio !== 'undefined') {
 try {
 this.audioEl = new Audio(KORZINKA_SCAN_WAV);
 this.audioEl.preload = 'auto';
 this.audioEl.volume = 1.0;
 } catch (e) {}
 }
 },

 getContext() {
 if (!this.ctx) this.init();
 if (this.ctx && this.ctx.state === 'suspended') {
 this.ctx.resume();
 }
 return this.ctx;
 },

 /**
 * Haqiqiy Korzinka supermarket kassa skaneri "TIQ!" tovushi
 * 2800Hz kristal chastotada 48ms davom etuvchi o'tkir zarbali skaner signali.
 */
 tiq() {
 if (!APP.voiceOn) return;

 let played = false;
 // 1-USUL: Web Audio API (eng yuqori sifat, 0ms kechikish)
 try {
 const ctx = this.getContext();
 if (ctx) {
 const now = ctx.currentTime;

 // Asosiy 2800Hz supermarket skaner toni
 const osc = ctx.createOscillator();
 const gain = ctx.createGain();

 osc.type = 'sine';
 osc.frequency.setValueAtTime(2800, now);

 gain.gain.setValueAtTime(0.001, now);
 gain.gain.linearRampToValueAtTime(0.95, now + 0.002);
 gain.gain.setValueAtTime(0.95, now + 0.038);
 gain.gain.exponentialRampToValueAtTime(0.001, now + 0.048);

 osc.connect(gain);
 gain.connect(ctx.destination);

 // Boshidagi mexanik "T" chertkisi (piezo zarbasi)
 const clickOsc = ctx.createOscillator();
 const clickGain = ctx.createGain();
 clickOsc.type = 'triangle';
 clickOsc.frequency.setValueAtTime(4200, now);
 clickOsc.frequency.exponentialRampToValueAtTime(1200, now + 0.005);
 clickGain.gain.setValueAtTime(0.5, now);
 clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.005);
 clickOsc.connect(clickGain);
 clickGain.connect(ctx.destination);

 clickOsc.start(now);
 clickOsc.stop(now + 0.006);

 osc.start(now);
 osc.stop(now + 0.050);
 played = true;
 }
 } catch (e) {
 console.warn('WebAudio error, trying audio element:', e);
 }

 // 2-USUL: Audio Element (Mobil telefonlarda AudioContext bloklangan bo'lsa kafolatli)
 try {
 this.initAudioEl();
 if (this.audioEl) {
 const clone = this.audioEl.cloneNode();
 clone.volume = 1.0;
 clone.play().catch(() => {});
 }
 } catch (e) {}

 // Taktil titrash (Korzinka apparatlaridagi kabi qo'lda his qilinadi)
 vibrateDevice([40]);
 },

 // beep() ni tiq() ga tenglashtiramiz
 beep() {
 this.tiq();
 },

 /**
 * Savatga mahsulot qo'shilganda yoki miqdor o'zgarganda (Pop/Chime)
 */
 pop() {
 if (!APP.voiceOn) return;
 try {
 const ctx = this.getContext();
 if (!ctx) return;

 const now = ctx.currentTime;
 const osc = ctx.createOscillator();
 const gain = ctx.createGain();

 osc.type = 'sine';
 osc.frequency.setValueAtTime(880, now);
 osc.frequency.exponentialRampToValueAtTime(1320, now + 0.06);

 gain.gain.setValueAtTime(0.35, now);
 gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

 osc.connect(gain);
 gain.connect(ctx.destination);

 osc.start(now);
 osc.stop(now + 0.075);
 } catch (e) { }
 },

 /**
 * To'lov qabul qilinganda ("Ka-ching!" kassa pul qutisi jiringlashi)
 */
 cash() {
 if (!APP.voiceOn) return;
 try {
 const ctx = this.getContext();
 if (!ctx) return;

 const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
 notes.forEach((freq, idx) => {
 const now = ctx.currentTime + (idx * 0.065);
 const osc = ctx.createOscillator();
 const gain = ctx.createGain();

 osc.type = 'triangle';
 osc.frequency.setValueAtTime(freq, now);

 gain.gain.setValueAtTime(0.001, now);
 gain.gain.linearRampToValueAtTime(0.4, now + 0.015);
 gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

 osc.connect(gain);
 gain.connect(ctx.destination);

 osc.start(now);
 osc.stop(now + 0.36);
 });
 } catch (e) { }
 },

 /**
 * Xatolik yoki kod topilmaganda ogohlantirish tovushi
 */
 error() {
 if (!APP.voiceOn) return;
 try {
 const ctx = this.getContext();
 if (!ctx) return;

 const now = ctx.currentTime;
 [0, 0.09].forEach(delay => {
 const t = now + delay;
 const osc = ctx.createOscillator();
 const gain = ctx.createGain();

 osc.type = 'sawtooth';
 osc.frequency.setValueAtTime(260, t);
 osc.frequency.exponentialRampToValueAtTime(180, t + 0.065);

 gain.gain.setValueAtTime(0.25, t);
 gain.gain.exponentialRampToValueAtTime(0.001, t + 0.075);

 osc.connect(gain);
 gain.connect(ctx.destination);

 osc.start(t);
 osc.stop(t + 0.08);
 });
 } catch (e) { }
 }
};

// Mobil qurilmalarda birinchi teginishda audio ruxsatini yechish
['pointerdown', 'touchstart', 'click', 'keydown'].forEach(evt => {
 window.addEventListener(evt, () => {
 SOUNDS.init();
 if (window.speechSynthesis && window.speechSynthesis.paused) {
 window.speechSynthesis.resume();
 }
 }, { once: true, passive: true });
});

// ─────────────────────────────────────────────
// VOICE (GAPIRUVCHI ROBOT OVOZI)
// ─────────────────────────────────────────────
function announceVoice(name, price) {
 // Foydalanuvchi talabiga asosan: skaner qilganda robot ovozi sukut bo'yicha O'CHIRILGAN!
 // Skanerda faqat Karzinkadagi kabi "TIQ!" tovushi chiqadi.
 if (!APP.settings.robotSpeechEnabled) return;
 if (!window.speechSynthesis) return;

 try {
 if (window.speechSynthesis.paused) window.speechSynthesis.resume();
 window.speechSynthesis.cancel();
 } catch (e) { }

 const lang = APP.settings.voiceLang || 'uz-UZ';
 let text;

 if (lang === 'uz-UZ' || lang === 'uz') {
 text = price > 0
 ? `${name}, ${formatPriceVoice(price)}`
 : name;
 } else if (lang === 'ru-RU') {
 text = price > 0
 ? `${name}, ${formatPriceVoice(price)} сум`
 : name;
 } else {
 text = price > 0
 ? `${name}, ${formatPriceVoice(price)} soums`
 : name;
 }

 const utt = new SpeechSynthesisUtterance(text);
 utt.rate = 1.05;
 utt.pitch = 1.0;
 utt.volume = 1.0;

 const voices = window.speechSynthesis.getVoices();
 if (voices && voices.length > 0) {
 const langPrefix = lang.split('-')[0].toLowerCase();
 let match = voices.find(v => v.lang.toLowerCase().startsWith(langPrefix));
 // uz-UZ ovozi tizimda bo'lmasa ru-RU ovoziga o'tish
 if (!match && (langPrefix === 'uz' || lang === 'uz-UZ')) {
 match = voices.find(v => v.lang.toLowerCase().startsWith('ru')) || voices[0];
 }
 if (match) {
 utt.voice = match;
 utt.lang = match.lang;
 } else {
 utt.lang = 'ru-RU';
 }
 } else {
 utt.lang = (lang === 'uz-UZ' || lang === 'uz') ? 'ru-RU' : lang;
 }

 try {
 window.speechSynthesis.speak(utt);
 } catch (e) {
 console.warn('Speech error:', e);
 }
}

function formatPriceVoice(amount) {
 const val = Math.round(Number(amount) || 0);
 if (val <= 0) return "0 so'm";

 if (val >= 1000000) {
 const millions = Math.floor(val / 1000000);
 const thousands = Math.round((val % 1000000) / 1000);
 if (thousands > 0) {
 return `${millions} million ${thousands} ming so'm`;
 }
 return `${millions} million so'm`;
 }

 if (val >= 1000) {
 const thousands = Math.floor(val / 1000);
 const remainder = val % 1000;
 if (remainder > 0) {
 return `${thousands} ming ${remainder} so'm`;
 }
 return `${thousands} ming so'm`;
 }

 return `${val} so'm`;
}

function toggleVoice() {
 APP.voiceOn = !APP.voiceOn;
 APP.settings.voiceEnabled = APP.voiceOn;
 const chk = document.getElementById('voiceEnabled');
 if (chk) chk.checked = APP.voiceOn;
 saveSettings();
 updateVoiceBtn();
 if (APP.voiceOn) {
 SOUNDS.tiq();
 }
 showToast(APP.voiceOn ? ' Skaner "Tiq" ovozi yoqildi' : ' Skaner ovozi o\'chirildi');
}

function updateVoiceBtn() {
 APP.voiceOn = document.getElementById('voiceEnabled')?.checked ?? true;
 const btn = document.getElementById('voiceToggle');
 if (!btn) return;
 if (APP.voiceOn) {
 btn.classList.add('active');
 btn.setAttribute('title', 'Skaner ovozi: Yoqilgan (Tiq!)');
 btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
 <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
 <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
 <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
 </svg>`;
 } else {
 btn.classList.remove('active');
 btn.setAttribute('title', 'Skaner ovozi: O\'chirilgan');
 btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
 <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
 <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
 </svg>`;
 }
}

// Voices boshidan bo'sh bo'lishi mumkin — yuklanganda qayta urinish
window.speechSynthesis?.addEventListener('voiceschanged', () => {
 console.log('Voices loaded:', window.speechSynthesis.getVoices().length);
});

// ─────────────────────────────────────────────
// SCAN SUCCESS OVERLAY
// ─────────────────────────────────────────────
function showScanSuccess(product) {
 const overlay = document.getElementById('scanSuccessOverlay');
 const media = document.getElementById('scanSuccessMedia');
 document.getElementById('scanSuccessName').textContent = product.name;
 document.getElementById('scanSuccessPrice').textContent = formatPrice(product.price);

 if (media) {
 const successIconHtml = `<div class="scan-success-icon">${icon('check', 44, 'icon-green')}</div>`;
 if (product.image) {
 media.innerHTML = `<img src="${escHtml(product.image)}" class="scan-success-img" alt="${escHtml(product.name)}" onerror="this.outerHTML='${successIconHtml.replace(/'/g, "\\'")}'">`;
 } else {
 media.innerHTML = successIconHtml;
 }
 }

 overlay.classList.add('show');
 setTimeout(() => overlay.classList.remove('show'), 2200);
}

// ─────────────────────────────────────────────
// PRODUCTS (MAHSULOTLAR)
// ─────────────────────────────────────────────
function showAddProductModal(product = null) {
 APP.editingProductId = product ? product.id : null;
 document.getElementById('modalTitle').textContent = product ? 'Mahsulotni tahrirlash' : 'Yangi mahsulot';
 document.getElementById('productName').value = product?.name || '';
 document.getElementById('productBarcode').value = product?.barcode || '';
 document.getElementById('productPrice').value = product?.price || '';
 const costInput = document.getElementById('productCostPrice');
 if (costInput) costInput.value = (product && product.costPrice) ? product.costPrice : '';
 document.getElementById('productStock').value = (product && product.stock !== undefined && product.stock !== null) ? product.stock : '';
 const trackCheck = document.getElementById('productTrackStock');
 if (trackCheck) trackCheck.checked = product ? !!product.trackStock : false;
 const cat = product?.category || 'suv_05';
 document.getElementById('productCategory').value = cat;
 const unitSelect = document.getElementById('productUnit');
 if (unitSelect) unitSelect.value = product?.unit || 'dona';
 document.getElementById('editProductId').value = product?.id || '';

 // Rasm holati
 setModalProductImage(product?.image || null);

 // Internet badge ni tozalash
 document.getElementById('onlineBadge')?.remove();

 const priceHintBadge = document.getElementById('priceHintBadge');
 if (priceHintBadge) {
 if (product?.price) {
 priceHintBadge.textContent = `${formatPriceShort(product.price)} so'm`;
 priceHintBadge.style.display = 'inline-block';
 } else {
 priceHintBadge.style.display = 'none';
 }
 }

 // Tahrirlashda shablonlarni yashiramiz, lekin kategoriya sinxronlashni ko'rsatamiz
 const templateSec = document.getElementById('templateChipsSection');
 if (templateSec) templateSec.style.display = 'none';
 const linkBox = document.getElementById('linkExistingBox');
 if (linkBox) linkBox.style.display = 'none';

 updateSyncCategoryUI(cat);

 const expInput = document.getElementById('productExpiryDate');
 if (expInput) expInput.value = product?.expiryDate || '';

 const printBtn = document.getElementById('btnProductPrintLabel');
 if (printBtn) printBtn.style.display = product ? 'inline-flex' : 'none';

 if (typeof renderProductPriceHistory === 'function') {
  renderProductPriceHistory(product);
 }

 openModal('addProductModal');
}

/**
 * Internet bazasidan topilgan yoki yangi shtrix-kod ma'lumotlari bilan modalni ochadi.
 */
function openAddProductModalWithData(onlineData, barcode, rawCode = '') {
 APP.editingProductId = null;
 const cleanCode = extractProductBarcode(barcode);

 const isFound = !!(onlineData.name && onlineData.name.trim());

 document.getElementById('modalTitle').innerHTML = isFound
 ? `${icon('globe', 18, 'icon-cyan')} Internetdan topildi`
 : `${icon('plus', 18)} Yangi mahsulot qo'shish`;

 document.getElementById('productName').value = onlineData.name || '';
 document.getElementById('productBarcode').value = cleanCode || '';
 const costInput = document.getElementById('productCostPrice');
 if (costInput) costInput.value = '';
 document.getElementById('productStock').value = '';
 const trackCheck = document.getElementById('productTrackStock');
 if (trackCheck) trackCheck.checked = false;
 const expInput = document.getElementById('productExpiryDate');
 if (expInput) expInput.value = '';
 const printBtn = document.getElementById('btnProductPrintLabel');
 if (printBtn) printBtn.style.display = 'none';
 if (typeof renderProductPriceHistory === 'function') renderProductPriceHistory(null);
 document.getElementById('editProductId').value = '';

 // Toifani aniqlash: onlayn topilgan toifa bo'lsa uni olamiz (qayta yozilmasin!)
 let cat = 'boshqa';
 if (onlineData.category && onlineData.category !== 'boshqa') {
 cat = onlineData.category;
 } else if (onlineData.name) {
 cat = detectCategoryFromName(onlineData.name);
 }
 document.getElementById('productCategory').value = cat;

 // Narx: noma'lum mahsulotga narx doim bo'sh bo'lsin.
 // Faqat internetdan topilgan va standart narxi mavjud toifalar uchun to'ldiriladi.
 const priceInput = document.getElementById('productPrice');
 const priceHintBadge = document.getElementById('priceHintBadge');

 if (isFound && APP.categoryPrices[cat] && cat !== 'boshqa') {
 const defaultPrice = APP.categoryPrices[cat];
 priceInput.value = defaultPrice;
 if (priceHintBadge) {
 priceHintBadge.textContent = `Standart: ${formatPriceShort(defaultPrice)} so'm`;
 priceHintBadge.style.display = 'inline-block';
 }
 } else {
 priceInput.value = '';
 if (priceHintBadge) priceHintBadge.style.display = 'none';
 }

 // Rasm
 setModalProductImage(onlineData.image || null);

 // Internet badge
 const existingBadge = document.getElementById('onlineBadge');
 if (existingBadge) existingBadge.remove();

 const modalBody = document.querySelector('#addProductModal .modal-body');
 if (modalBody && isFound) {
 const badge = document.createElement('div');
 badge.id = 'onlineBadge';
 badge.style.cssText = 'background:linear-gradient(135deg,rgba(34,197,94,0.2),rgba(6,182,212,0.2));border:1px solid rgba(34,197,94,0.4);border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:0.8rem;color:#22c55e;display:flex;align-items:center;gap:6px';
 badge.innerHTML = `${icon('globe', 14, 'icon-cyan')} <span>Internetdan avtomatik to'ldirildi${onlineData.brand ? ' — ' + escHtml(onlineData.brand) : ''}</span>`;
 modalBody.insertBefore(badge, modalBody.firstChild);
 } else if (modalBody && !isFound) {
 // Topilmadi — sariq ogohlantirish badge
 const badge = document.createElement('div');
 badge.id = 'onlineBadge';
 badge.style.cssText = 'background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35);border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:0.8rem;color:#f59e0b;display:flex;align-items:center;gap:6px';
 badge.innerHTML = `${icon('alert', 14, 'icon-yellow')} <span>Internetda topilmadi. Shablonlardan tanlang yoki nom va narxni kiriting — keyingi skanerlashda avtomatik eslab qoladi!</span>`;
 modalBody.insertBefore(badge, modalBody.firstChild);
 }

 // O'xshash mahsulot shablonlarini yuklash
 renderTemplateChips(onlineData.name, cat);

 // Kategoriya narxini sinxronlash katakchasini yangilash
 updateSyncCategoryUI(cat);

 openModal('addProductModal');

 // Topilmagan bo'lsa nom maydoniga, narx to'ldirilgan bo'lsa miqdorga, aks holda narxga
 setTimeout(() => {
 const focusEl = !isFound
 ? document.getElementById('productName')
 : (!priceInput.value ? priceInput : document.getElementById('productStock'));
 focusEl?.focus();
 }, 350);
}

function renderTemplateChips(name, category) {
 const container = document.getElementById('templateChipsSection');
 const list = document.getElementById('templateChipsList');
 const linkBox = document.getElementById('linkExistingBox');
 const linkBtnText = document.getElementById('btnLinkBarcodeText');
 if (!container || !list) return;

 const templates = getSimilarTemplates(name, category);

 if (templates.length === 0) {
 container.style.display = 'none';
 if (linkBox) linkBox.style.display = 'none';
 return;
 }

 container.style.display = 'block';
 list.innerHTML = templates.map(p => `
 <button type="button" class="template-chip" onclick="applyProductTemplate('${p.id}')">
 <span>${catIcon(p.category)} ${escHtml(p.name)}</span>
 <span class="chip-price">${formatPrice(p.price)}</span>
 </button>
 `).join('');

 // Mavjud mahsulotga biriktirish taklifi
 if (linkBox && linkBtnText && templates.length > 0) {
 const bestMatch = templates[0];
 APP._currentLinkTargetId = bestMatch.id;
 linkBtnText.textContent = `"${bestMatch.name}" ga qo'shimcha kod qilib biriktirish`;
 linkBox.style.display = 'block';
 } else if (linkBox) {
 linkBox.style.display = 'none';
 }
}

function getSimilarTemplates(name, category) {
 const q = (name || '').toLowerCase().trim();
 let matches = [];

 // 1. Agar nom bo'yicha so'zlar mos kelsa
 if (q) {
 const words = q.split(/\s+/).filter(w => w.length > 2);
 matches = APP.products.filter(p => {
 const pn = p.name.toLowerCase();
 return words.some(w => pn.includes(w)) || pn.includes(q) || q.includes(pn);
 });
 }

 // 2. Xuddi shu toifadagi mahsulotlarni qo'shish
 if (matches.length < 4 && category) {
 const catMatches = APP.products.filter(p => p.category === category && !matches.some(m => m.id === p.id));
 matches = matches.concat(catMatches);
 }

 // 3. Agar suv toifasi bo'lsa, boshqa barcha suvlarni qo'shish
 if (matches.length < 4 && (category.startsWith('suv') || /suv|water/i.test(q))) {
 const suvMatches = APP.products.filter(p => /suv|water|0[.,]5/i.test(p.name) && !matches.some(m => m.id === p.id));
 matches = matches.concat(suvMatches);
 }

 // 4. Oxirgi qo'shilgan mahsulotlarni shablon sifatida ko'rsatish
 if (matches.length < 4 && APP.products.length > 0) {
 const recent = APP.products.filter(p => !matches.some(m => m.id === p.id)).slice(0, 4 - matches.length);
 matches = matches.concat(recent);
 }

 return matches.slice(0, 4);
}

function applyProductTemplate(productId) {
 const p = APP.products.find(item => item.id === productId);
 if (!p) return;

 const nameInput = document.getElementById('productName');
 if (!nameInput.value || nameInput.value.trim() === '') {
 nameInput.value = p.name;
 }

 document.getElementById('productPrice').value = p.price;
 document.getElementById('productCategory').value = p.category;

 if (p.image) {
 setModalProductImage(p.image);
 }

 const priceHintBadge = document.getElementById('priceHintBadge');
 if (priceHintBadge) {
 priceHintBadge.textContent = `Shablon: ${formatPriceShort(p.price)} so'm`;
 priceHintBadge.style.display = 'inline-block';
 }

 updateSyncCategoryUI(p.category);
 showToast(`"${p.name}" shablon narxi va ma'lumotlari nusxalandi!`, 'success');
}

function linkCurrentBarcodeToProduct() {
 if (!APP._currentLinkTargetId) return;
 const target = APP.products.find(p => p.id === APP._currentLinkTargetId);
 if (!target) return;

 const barcodeInput = document.getElementById('productBarcode');
 const codeToLink = extractProductBarcode(barcodeInput?.value.trim());

 if (!codeToLink) {
 showToast('Shtrix-kod mavjud emas', 'warning');
 return;
 }

 if (target.barcode === codeToLink) {
 showToast('Bu mahsulotning asosiy kodi bilan bir xil', 'warning');
 return;
 }

 if (!Array.isArray(target.barcodes)) {
 target.barcodes = [];
 }

 if (!target.barcodes.includes(codeToLink)) {
 target.barcodes.push(codeToLink);
 }

 saveProductToDB(target);
 closeModal('addProductModal');
 showToast(`"${codeToLink}" kodi "${target.name}" ga biriktirildi!`, 'success');
}

function updateSyncCategoryUI(category) {
 const wrap = document.getElementById('syncCategoryWrap');
 const label = document.getElementById('syncCategoryLabel');
 if (!wrap || !label) return;

 const currentEditId = document.getElementById('editProductId')?.value;
 const count = APP.products.filter(p => p.category === category && p.id !== currentEditId).length;

 if (count > 0) {
 const catName = CATEGORY_NAMES[category] || category;
 label.textContent = `"${catName}" toifasidagi barcha (${count} ta) mahsulot narxini ham yangilash`;
 wrap.style.display = 'block';
 } else {
 wrap.style.display = 'none';
 }
}

function onCategorySelectChange(category) {
 const priceInput = document.getElementById('productPrice');
 const priceHintBadge = document.getElementById('priceHintBadge');

 if (APP.categoryPrices[category]) {
 const defPrice = APP.categoryPrices[category];
 // Foydalanuvchi kiritgan narxni ustidan yozmaslik — faqat narx bo'sh bo'lsa to'ldirish
 if (!priceInput.value || priceInput.value.trim() === '') {
 priceInput.value = defPrice;
 }
 if (priceHintBadge) {
 priceHintBadge.textContent = `Standart: ${formatPriceShort(defPrice)} so'm`;
 priceHintBadge.style.display = 'inline-block';
 }
 } else if (priceHintBadge) {
 priceHintBadge.style.display = 'none';
 }

 updateSyncCategoryUI(category);
 renderTemplateChips(document.getElementById('productName')?.value, category);
}

function onProductNameInput(name) {
 const cat = detectCategoryFromName(name);
 const catSelect = document.getElementById('productCategory');
 if (catSelect && cat !== 'boshqa' && catSelect.value !== cat) {
 catSelect.value = cat;
 onCategorySelectChange(cat);
 }
}

/** Modal ichidagi mahsulot rasmini o'rnatish va prevyu qilish */
function setModalProductImage(imageUrlOrBase64) {
 const hiddenInput = document.getElementById('productImage');
 const previewArea = document.getElementById('imagePreviewArea');
 const previewImg = document.getElementById('productImagePreviewTag');
 const emptyState = document.getElementById('imageEmptyState');

 if (!hiddenInput || !previewArea || !previewImg || !emptyState) return;

 if (imageUrlOrBase64) {
 hiddenInput.value = imageUrlOrBase64;
 previewImg.src = imageUrlOrBase64;
 previewImg.onerror = () => {
 previewArea.style.display = 'none';
 emptyState.style.display = 'flex';
 hiddenInput.value = '';
 };
 previewArea.style.display = 'block';
 emptyState.style.display = 'none';
 } else {
 hiddenInput.value = '';
 previewImg.src = '';
 previewArea.style.display = 'none';
 emptyState.style.display = 'flex';
 }
}

/** Rasmni olib tashlash */
function removeProductImage() {
 setModalProductImage(null);
 showToast('Rasm olib tashlandi');
}

/** Foydalanuvchi fayl yoki kamera orqali rasm yuklaganda */
async function handleProductImageFile(event) {
 const file = event.target.files?.[0];
 if (!file) return;

 if (!file.type.startsWith('image/')) {
 showToast('Faqat rasm fayllarini yuklash mumkin');
 return;
 }

 showToast('Rasm yuklanmoqda...');
 try {
 const compressedBase64 = await compressImage(file, 320, 320, 0.7);
 setModalProductImage(compressedBase64);
 showToast('Mahsulot rasmi yuklandi');
 } catch (err) {
 console.error('Rasm yuklash xatosi:', err);
 showToast('Rasmni yuklashda xatolik yuz berdi');
 } finally {
 event.target.value = '';
 }
}

/** Rasmni avtomatik qisqartirish (Base64 JPEG) */
function compressImage(file, maxWidth = 320, maxHeight = 320, quality = 0.7) {
 return new Promise((resolve, reject) => {
 const reader = new FileReader();
 reader.onload = (e) => {
 const img = new Image();
 img.onload = () => {
 let width = img.width;
 let height = img.height;
 if (width > height) {
 if (width > maxWidth) {
 height = Math.round((height * maxWidth) / width);
 width = maxWidth;
 }
 } else {
 if (height > maxHeight) {
 width = Math.round((width * maxHeight) / height);
 height = maxHeight;
 }
 }
 const canvas = document.createElement('canvas');
 canvas.width = width;
 canvas.height = height;
 const ctx = canvas.getContext('2d');
 ctx.drawImage(img, 0, 0, width, height);
 resolve(canvas.toDataURL('image/jpeg', quality));
 };
 img.onerror = reject;
 img.src = e.target.result;
 };
 reader.onerror = reject;
 reader.readAsDataURL(file);
 });
}

/** Internet bazasidan haqiqiy fotosurat qidirish */
async function fetchProductImageOnline() {
 const barcode = document.getElementById('productBarcode')?.value.trim();
 const name = document.getElementById('productName')?.value.trim();

 if (!barcode && !name) {
 showToast('Avval shtrix-kod yoki mahsulot nomini kiriting');
 return;
 }

 showToast('Internetdan haqiqiy fotosurat qidirilmoqda...');

 // 1. Shtrix-kod orqali qidiruv
 if (barcode) {
 try {
 const res = await lookupBarcodeOnline(barcode);
 if (res && res.image) {
 setModalProductImage(res.image);
 showToast('Internetdan haqiqiy rasm topildi!');
 return;
 }
 } catch (e) {
 console.warn(e);
 }
 }

 // 2. Nom orqali OpenFoodFacts search
 if (name) {
 try {
 const queryRes = await fetch(
 `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(name)}&search_simple=1&action=process&json=1&page_size=1`,
 { signal: AbortSignal.timeout(5000) }
 );
 if (queryRes.ok) {
 const qData = await queryRes.json();
 const p = qData.products?.[0];
 if (p && (p.image_front_url || p.image_url || p.image_small_url)) {
 const img = p.image_front_url || p.image_url || p.image_small_url;
 setModalProductImage(img);
 showToast(`"${name}" uchun haqiqiy rasm topildi!`);
 return;
 }
 }
 } catch (e) {
 console.warn(e);
 }
 }

 showToast('Internetdan bu mahsulot rasmi topilmadi. Kamera yoki galereyadan yuklang.');
}

async function saveProduct() {
 const name = document.getElementById('productName').value.trim();
 const rawBarcode = document.getElementById('productBarcode').value.trim();
 const barcode = extractProductBarcode(rawBarcode);
 const price = parseFloat(document.getElementById('productPrice').value);
 const costPrice = parseFloat(document.getElementById('productCostPrice')?.value) || 0;
 const trackStock = document.getElementById('productTrackStock')?.checked || false;
 const stockRaw = document.getElementById('productStock').value.trim();
 const stock = trackStock ? (parseFloat(stockRaw) || 0) : (stockRaw ? (parseFloat(stockRaw) || 0) : 0);
 const unit = document.getElementById('productUnit')?.value || 'dona';
 const category = document.getElementById('productCategory').value;
 const image = document.getElementById('productImage')?.value || null;
 const expiryDate = document.getElementById('productExpiryDate')?.value.trim() || null;
 const syncCategory = document.getElementById('syncCategoryCheckbox')?.checked;

 if (!name) { showToast('Mahsulot nomini kiriting'); return; }
 if (!barcode) { showToast('Shtrix-kodni kiriting'); return; }
 if (!price || price <= 0) { showToast('Narxni to\'g\'ri kiriting'); return; }

 // Takroriy shtrix-kod tekshiruvi (tahrirlashdan tashqari)
 const existing = APP.products.find(p =>
 (p.barcode === barcode || (Array.isArray(p.barcodes) && p.barcodes.includes(barcode))) &&
 p.id !== APP.editingProductId
 );
 if (existing) {
 showToast(`Bu shtrix-kod allaqachon: ${existing.name}`);
 return;
 }

 // Obuna limiti (faqat yangi mahsulot qo'shishda)
 if (!APP.editingProductId && typeof canAddProduct === 'function' && !canAddProduct()) {
  const acc = getAccessState();
  showToast(`Bepul tarifda ${acc.productLimit} ta mahsulot chegarasi. Tarifni oshiring.`, 'warning');
  if (typeof openPaywall === 'function') openPaywall();
  return;
 }

 const roundedPrice = Math.round(price);
 const roundedCostPrice = costPrice > 0 ? Math.round(costPrice) : null;
 const prev = APP.editingProductId ? APP.products.find(p => p.id === APP.editingProductId) : null;

 const product = {
 id: APP.editingProductId || generateId(),
 name, barcode,
 price: roundedPrice,
 costPrice: roundedCostPrice,
 stock,
 trackStock,
 unit,
 isQuick: false,
 category,
 image,
 expiryDate: expiryDate || null,
 priceHistory: prev && Array.isArray(prev.priceHistory) ? [...prev.priceHistory] : [],
 updatedAt: new Date().toISOString(),
 };

 // Narx tarixi qayd qilish
 if (prev) {
 if (prev.price !== roundedPrice || (prev.costPrice || null) !== roundedCostPrice) {
 product.priceHistory.unshift({
 date: new Date().toISOString(),
 oldPrice: prev.price,
 newPrice: roundedPrice,
 oldCostPrice: prev.costPrice || null,
 newCostPrice: roundedCostPrice,
 note: 'Qo\'lda tahrirlandi'
 });
 if (product.priceHistory.length > 30) product.priceHistory.pop();
 }
 } else {
 product.priceHistory.unshift({
 date: new Date().toISOString(),
 oldPrice: null,
 newPrice: roundedPrice,
 oldCostPrice: null,
 newCostPrice: roundedCostPrice,
 note: 'Yangi mahsulot'
 });
 }

 // Agar tahrirlanayotgan mahsulotda mavjud barcodes bo'lsa saqlab qolamiz
 if (APP.editingProductId) {
 if (prev && Array.isArray(prev.barcodes)) {
 product.barcodes = prev.barcodes;
 }
 }

 if (!APP.editingProductId) {
 product.createdAt = new Date().toISOString();
 }

 await saveProductToDB(product);

 // Faqat syncCategory tanlangan bo'lsa yoki toifada hali standart narx bo'lmasa eslab qolamiz
 if (syncCategory || !APP.categoryPrices[category]) {
 APP.categoryPrices[category] = roundedPrice;
 saveCategoryPrices();
 }

 // Agar toifadagi barcha mahsulotlar narxini ham yangilash tanlangan bo'lsa
 let syncedCount = 0;
 if (syncCategory) {
 for (const p of APP.products) {
 if (p.id !== product.id && p.category === category) {
 p.priceHistory = Array.isArray(p.priceHistory) ? p.priceHistory : [];
 if (p.price !== roundedPrice) {
 p.priceHistory.unshift({
 date: new Date().toISOString(),
 oldPrice: p.price,
 newPrice: roundedPrice,
 oldCostPrice: p.costPrice || null,
 newCostPrice: p.costPrice || null,
 note: `Toifa sinxroni (${name})`
 });
 if (p.priceHistory.length > 30) p.priceHistory.pop();
 }
 p.price = roundedPrice;
 p.updatedAt = new Date().toISOString();
 await saveProductToDB(p);
 syncedCount++;
 }
 }
 }

 closeModal('addProductModal');

 if (syncedCount > 0) {
 SOUNDS.pop();
 showToast(`${name} saqlandi! Toifadagi ${syncedCount} ta mahsulot narxi ham ${formatPrice(roundedPrice)} ga yangilandi!`);
 } else if (!APP.editingProductId) {
 // Yangi mahsulot — Korzinka skaneri "TIQ!" tovushi
 SOUNDS.tiq();
 showToast(`${name} saqlandi! Endi skanlashda avtomatik taniladi.`);
 } else {
 SOUNDS.pop();
 showToast(`${name} yangilandi`);
 }
}

async function saveProductToDB(product) {
 normalizeProduct(product);
 if (!window.useDemo && window.firebaseDB) {
 if (!navigator.onLine) {
 await enqueueOutbox({ action: 'saveProduct', data: product });
 const idx = APP.products.findIndex(p => p.id === product.id);
 if (idx >= 0) APP.products[idx] = product;
 else APP.products.push(product);
 await saveLocalData();
 renderProducts();
 showToast('Oflayn saqlandi, navbatga qo\'yildi', 'warning');
 return;
 }
 try {
  const { setDoc } = window.firebaseFns;
  await withTimeout(setDoc(userDoc('products', product.id), product), 10000);
  return;
 } catch (e) {
 console.error('Firebase saqlash xato/timeout:', e);
 await enqueueOutbox({ action: 'saveProduct', data: product });
 const idx = APP.products.findIndex(p => p.id === product.id);
 if (idx >= 0) APP.products[idx] = product;
 else APP.products.push(product);
 await saveLocalData();
 renderProducts();
 showToast("Navbatga qo'yildi, internet kelganda yuboriladi", 'warning');
 return;
 }
 }
 if (window.isFirebaseConfigured) {
 await enqueueOutbox({ action: 'saveProduct', data: product });
 }
 // Local/IndexedDB
 const idx = APP.products.findIndex(p => p.id === product.id);
 if (idx >= 0) APP.products[idx] = product;
 else APP.products.push(product);
 await saveLocalData();
 renderProducts();
}

async function deleteProduct(productId) {
 if (!confirm('Mahsulotni o\'chirishni tasdiqlaysizmi?')) return;

 if (!window.useDemo && window.firebaseDB) {
 if (!navigator.onLine) {
 await enqueueOutbox({ action: 'deleteProduct', id: productId });
 APP.products = APP.products.filter(p => p.id !== productId);
 await saveLocalData();
 renderProducts();
 showToast('Oflayn o\'chirildi, navbatga qo\'yildi', 'warning');
 return;
 }
 try {
  const { deleteDoc } = window.firebaseFns;
  await withTimeout(deleteDoc(userDoc('products', productId)), 10000);
  showToast('Mahsulot o\'chirildi');
 return;
 } catch (e) {
 console.error('Firebase o\'chirish xato/timeout:', e);
 await enqueueOutbox({ action: 'deleteProduct', id: productId });
 APP.products = APP.products.filter(p => p.id !== productId);
 await saveLocalData();
 renderProducts();
 showToast("Navbatga qo'yildi, internet kelganda yuboriladi", 'warning');
 return;
 }
 }
 if (window.isFirebaseConfigured) {
 await enqueueOutbox({ action: 'deleteProduct', id: productId });
 }
 APP.products = APP.products.filter(p => p.id !== productId);
 await saveLocalData();
 renderProducts();
 showToast('Mahsulot o\'chirildi');
}

async function saveDebtorToDB(debtor) {
 if (!window.useDemo && window.firebaseDB && window.firebaseFns) {
 if (!navigator.onLine) {
 await enqueueOutbox({ action: 'debtor', type: 'debtor', data: debtor });
 } else {
 try {
  const { setDoc } = window.firebaseFns;
  await withTimeout(setDoc(userDoc('debtors', debtor.id), debtor), 10000);
 } catch (e) {
 console.error('Debtor saqlash xato/timeout:', e);
 await enqueueOutbox({ action: 'debtor', type: 'debtor', data: debtor });
 showToast("Navbatga qo'yildi, internet kelganda yuboriladi", 'warning');
 }
 }
 } else if (window.isFirebaseConfigured) {
 await enqueueOutbox({ action: 'debtor', type: 'debtor', data: debtor });
 }
}

async function deleteDebtorFromDB(debtorId) {
 if (!window.useDemo && window.firebaseDB && window.firebaseFns) {
 if (!navigator.onLine) {
 await enqueueOutbox({ action: 'deleteDebtor', type: 'deleteDebtor', id: debtorId });
 } else {
 try {
  const { deleteDoc } = window.firebaseFns;
  await withTimeout(deleteDoc(userDoc('debtors', debtorId)), 10000);
 } catch (e) {
 console.error('Debtor o\'chirish xato/timeout:', e);
 await enqueueOutbox({ action: 'deleteDebtor', type: 'deleteDebtor', id: debtorId });
 }
 }
 } else if (window.isFirebaseConfigured) {
 await enqueueOutbox({ action: 'deleteDebtor', type: 'deleteDebtor', id: debtorId });
 }
}

async function saveDebtToDB(debt) {
 if (!window.useDemo && window.firebaseDB && window.firebaseFns) {
 if (!navigator.onLine) {
 await enqueueOutbox({ action: 'debt', type: 'debt', data: debt });
 } else {
 try {
  const { setDoc } = window.firebaseFns;
  await withTimeout(setDoc(userDoc('debts', debt.id), debt), 10000);
 } catch (e) {
 console.error('Debt saqlash xato/timeout:', e);
 await enqueueOutbox({ action: 'debt', type: 'debt', data: debt });
 showToast("Navbatga qo'yildi, internet kelganda yuboriladi", 'warning');
 }
 }
 } else if (window.isFirebaseConfigured) {
 await enqueueOutbox({ action: 'debt', type: 'debt', data: debt });
 }
}

async function deleteDebtFromDB(debtId) {
 if (!window.useDemo && window.firebaseDB && window.firebaseFns) {
 if (!navigator.onLine) {
 await enqueueOutbox({ action: 'deleteDebt', type: 'deleteDebt', id: debtId });
 } else {
 try {
  const { deleteDoc } = window.firebaseFns;
  await withTimeout(deleteDoc(userDoc('debts', debtId)), 10000);
 } catch (e) {
 console.error('Debt o\'chirish xato/timeout:', e);
 await enqueueOutbox({ action: 'deleteDebt', type: 'deleteDebt', id: debtId });
 }
 }
 } else if (window.isFirebaseConfigured) {
 await enqueueOutbox({ action: 'deleteDebt', type: 'deleteDebt', id: debtId });
 }
}

function filterProducts(query) {
 const q = query.toLowerCase();
 const filtered = APP.products.filter(p =>
 p.name.toLowerCase().includes(q) ||
 p.barcode.includes(q) ||
 p.category.includes(q)
 );
 renderProductGrid(filtered);
}

function getExpiryStatus(expiryDate) {
 if (!expiryDate) return { status: 'none', days: null, label: '' };
 const today = new Date();
 today.setHours(0, 0, 0, 0);
 const exp = new Date(expiryDate);
 exp.setHours(0, 0, 0, 0);
 if (isNaN(exp.getTime())) return { status: 'none', days: null, label: '' };

 const days = Math.ceil((exp - today) / (1000 * 60 * 60 * 24));
 if (days < 0) {
  return { status: 'expired', days, label: "Muddati o'tgan" };
 } else if (days === 0) {
  return { status: 'today', days: 0, label: 'Bugun tugaydi' };
 } else if (days <= 7) {
  return { status: 'expiring', days, label: `${days} kunda tugaydi` };
 }
 return { status: 'ok', days, label: expiryDate };
}

function getExpiringProducts(maxDays = 7) {
 return (APP.products || []).filter(p => {
  if (!p.expiryDate) return false;
  const st = getExpiryStatus(p.expiryDate);
  return st.status === 'expired' || st.status === 'today' || (st.status === 'expiring' && st.days <= maxDays);
 });
}

function toggleExpiringFilter() {
 APP._filterExpiringStock = !APP._filterExpiringStock;
 if (APP._filterExpiringStock) _filterLowStock = false;
 const card = document.getElementById('expiringStockCard');
 if (card) card.classList.toggle('active', APP._filterExpiringStock);
 const lowCard = document.getElementById('lowStockCard');
 if (lowCard) lowCard.classList.remove('active');
 renderProducts();
 if (APP._filterExpiringStock) showToast("Muddati o'tgan va 7 kunda tugaydigan tovarlar");
}

let _filterLowStock = false;
function toggleLowStockFilter() {
 _filterLowStock = !_filterLowStock;
 if (_filterLowStock) APP._filterExpiringStock = false;
 const card = document.getElementById('lowStockCard');
 if (card) card.classList.toggle('active', _filterLowStock);
 const expCard = document.getElementById('expiringStockCard');
 if (expCard) expCard.classList.remove('active');
 renderProducts();
 if (_filterLowStock) showToast('Faqat kam qolgan tovarlar koʻrsatilmoqda');
}

function renderProducts() {
 const limit = parseInt(APP.settings.lowStockLimit || 5, 10);
 let list = APP.products || [];
 if (APP._filterExpiringStock) {
  list = getExpiringProducts(7);
 } else if (_filterLowStock) {
  list = list.filter(p => p.trackStock !== false && (parseInt(p.stock, 10) || 0) <= limit);
 }
 renderProductGrid(list);
 updateProductStats();
}

function renderProductGrid(products) {
 const grid = document.getElementById('productGrid');
 if (!products || products.length === 0) {
 grid.innerHTML = `<div class="empty-state">
 <div class="empty-icon">${icon('box', 48)}</div>
 <p>Mahsulot yo'q</p>
 <span style="font-size:0.8rem;color:var(--text3)">Yangi mahsulot qo'shish uchun + tugmasini bosing</span>
 </div>`;
 return;
 }

 const limit = parseInt(APP.settings.lowStockLimit || 5, 10);

 grid.innerHTML = products.map(p => {
 const isUntracked = p.trackStock === false;
 const currentStock = parseInt(p.stock, 10) || 0;
 const isLow = !isUntracked && currentStock <= limit;
 const expInfo = getExpiryStatus(p.expiryDate);
 let expBadgeHtml = '';
 if (expInfo.status === 'expired') {
  expBadgeHtml = `<span class="badge-expiry expired" title="Muddati: ${escHtml(p.expiryDate)}">⛔ Muddati o'tgan</span>`;
 } else if (expInfo.status === 'today') {
  expBadgeHtml = `<span class="badge-expiry warning" title="Bugun tugaydi: ${escHtml(p.expiryDate)}">[!] Bugun tugaydi</span>`;
 } else if (expInfo.status === 'expiring') {
  expBadgeHtml = `<span class="badge-expiry warning" title="Muddati tugayapti: ${escHtml(p.expiryDate)}">[!] ${expInfo.days} kunda tugaydi</span>`;
 }

 return `
 <div class="product-card" onclick="editProductById('${p.id}')">
 <div class="product-card-thumb">
 ${p.image ? `<img src="${escHtml(p.image)}" class="product-card-img" alt="${escHtml(p.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : ''}
 <span class="product-emoji" style="${p.image ? 'display:none' : 'display:flex'}">${catIcon(p.category)}</span>
 </div>
 <div class="product-card-info">
 <div class="product-card-name">${escHtml(p.name)}</div>
 <div class="product-card-barcode">${escHtml(p.barcode || '')}</div>
 <div class="product-card-meta" style="flex-wrap:wrap;gap:4px;align-items:center;">
 <span class="product-card-price">${formatPrice(p.price)}</span>
 ${isUntracked
 ? `<span class="product-card-stock" style="color:var(--text3)">Cheksiz</span>`
 : `<span class="product-card-stock" style="${isLow ? 'color:#ef4444;font-weight:700' : ''}">${isLow ? icon('alert', 12, 'icon-red') + ' ' : ''}Ombor: ${currentStock} ${escHtml(p.unit || 'ta')}</span>`
 }
 ${expBadgeHtml}
 </div>
 </div>
 <div class="product-card-actions" onclick="event.stopPropagation()">
 <button class="btn-print-label" onclick="openPrintLabelModal('${p.id}')" title="Yorliq chop etish" style="background:transparent;border:none;color:var(--text2);cursor:pointer;padding:4px;border-radius:4px;display:flex;align-items:center;">${icon('printer', 15)}</button>
 <button class="btn-edit" onclick="editProductById('${p.id}')" title="Tahrirlash">${icon('edit', 16)}</button>
 <button class="btn-del" onclick="deleteProduct('${p.id}')" title="O'chirish">${icon('trash', 16)}</button>
 </div>
 </div>
 `;
 }).join('');
}

function editProduct(product) {
 showAddProductModal(product);
}

function editProductById(productId) {
 const p = APP.products.find(item => item.id === productId);
 if (p) showAddProductModal(p);
}

function updateProductStats() {
 const countEl = document.getElementById('totalProductsCount');
 if (countEl) countEl.textContent = APP.products.length;
 const totalVal = APP.products.reduce((s, p) => s + (p.price * (p.stock || 0)), 0);
 const valEl = document.getElementById('totalStockValue');
 if (valEl) valEl.textContent = formatPriceShort(totalVal);

 const limit = parseInt(APP.settings.lowStockLimit || 5, 10);
 const lowStockCount = (APP.products || []).filter(p => p.trackStock !== false && (parseInt(p.stock, 10) || 0) <= limit).length;
 const lowCountEl = document.getElementById('lowStockCount');
 if (lowCountEl) lowCountEl.textContent = lowStockCount;
 const lowCardEl = document.getElementById('lowStockCard');
 if (lowCardEl) lowCardEl.style.display = lowStockCount > 0 ? 'flex' : 'none';

 const expiringCount = getExpiringProducts(7).length;
 const expCountEl = document.getElementById('expiringStockCount');
 if (expCountEl) expCountEl.textContent = expiringCount;
 const expCardEl = document.getElementById('expiringStockCard');
 if (expCardEl) expCardEl.style.display = expiringCount > 0 ? 'flex' : 'none';
}

// Modal ichidan skaner
function scanForModal() {
 closeModal('addProductModal');
 showPage('scanner');
 APP._scanForModal = true;
 showToast('Shtrix-kodni kameraga ko\'rsating — avtomatik kiritiladi');
 updateScanHint('Modal uchun skanerlash rejimi...', 'success');
}

// ─────────────────────────────────────────────
// FIREBASE REAL-TIME LISTENERS
// ─────────────────────────────────────────────
function listenFirestoreProducts() {
 if (!window.firebaseDB || !window.firebaseFns || !window.firebaseFns.onSnapshot) return;
 const { onSnapshot } = window.firebaseFns;
 const colRef = userCol('products');
 const handler = async (snap) => {
  let prods = snap.docs.map(d => normalizeProduct({ id: d.id, ...d.data() }));
  if (snap.metadata && snap.metadata.hasPendingWrites) {
   const outbox = await getOutboxQueue();
   const prodMap = new Map(prods.map(p => [p.id, p]));
   for (const item of outbox) {
    if ((item.action === 'saveProduct' || item.action === 'product' || item.type === 'product') && item.data) {
     prodMap.set(item.data.id, normalizeProduct({ ...(prodMap.get(item.data.id) || {}), ...item.data }));
    } else if (item.action === 'deleteProduct' && item.id) {
     prodMap.delete(item.id);
    } else if ((item.action === 'saleBatch' || item.action === 'refundBatch') && Array.isArray(item.products)) {
     for (const pUp of item.products) {
      const existing = prodMap.get(pUp.id);
      if (existing) {
       if (pUp.stock !== undefined) {
        existing.stock = pUp.stock;
       } else if (pUp.qtyChange !== undefined) {
        existing.stock = (parseInt(existing.stock, 10) || 0) + pUp.qtyChange;
       }
       prodMap.set(pUp.id, existing);
      }
     }
    }
   }
   prods = Array.from(prodMap.values());
  }
  APP.products = prods;
  renderProducts();
 };
 try {
  return onSnapshot(colRef, { includeMetadataChanges: true }, handler);
 } catch (e) {
  return onSnapshot(colRef, handler);
 }
}

function listenFirestoreBills() {
 if (!window.firebaseDB || !window.firebaseFns || !window.firebaseFns.onSnapshot) return;
 const { onSnapshot } = window.firebaseFns;
 const colRef = userCol('bills');
 const handler = async (snap) => {
  let bills = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (snap.metadata && snap.metadata.hasPendingWrites) {
   const outbox = await getOutboxQueue();
   const billMap = new Map(bills.map(b => [b.id, b]));
   for (const item of outbox) {
    if ((item.action === 'saveBill' || item.action === 'bill' || item.type === 'bill') && item.data) {
     billMap.set(item.data.id, item.data);
    } else if ((item.action === 'saleBatch' || item.action === 'refundBatch') && item.bill) {
     billMap.set(item.bill.id, item.bill);
    }
   }
   bills = Array.from(billMap.values());
  }
  bills.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  APP.bills = bills;
  renderBills();
 };
 try {
  return onSnapshot(colRef, { includeMetadataChanges: true }, handler);
 } catch (e) {
  return onSnapshot(colRef, handler);
 }
}

function listenFirestoreDebtors() {
 if (!window.firebaseDB || !window.firebaseFns || !window.firebaseFns.onSnapshot) return;
 const { onSnapshot } = window.firebaseFns;
 const colRef = userCol('debtors');
 const handler = async (snap) => {
  let debtors = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (snap.metadata && snap.metadata.hasPendingWrites) {
   const outbox = await getOutboxQueue();
   const debtorMap = new Map(debtors.map(d => [d.id, d]));
   for (const item of outbox) {
    if ((item.action === 'saveDebtor' || item.action === 'debtor' || item.type === 'debtor') && item.data) {
     debtorMap.set(item.data.id, item.data);
    } else if (item.action === 'deleteDebtor' && item.id) {
     debtorMap.delete(item.id);
    }
   }
   debtors = Array.from(debtorMap.values());
  }
  APP.debtors = debtors;
  renderDebtors();
  updateNasiyaStats();
 };
 try {
  return onSnapshot(colRef, { includeMetadataChanges: true }, handler);
 } catch (e) {
  return onSnapshot(colRef, handler);
 }
}

function listenFirestoreDebts() {
 if (!window.firebaseDB || !window.firebaseFns || !window.firebaseFns.onSnapshot) return;
 const { onSnapshot } = window.firebaseFns;
 const colRef = userCol('debts');
 const handler = async (snap) => {
  let debts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (snap.metadata && snap.metadata.hasPendingWrites) {
   const outbox = await getOutboxQueue();
   const debtMap = new Map(debts.map(d => [d.id, d]));
   for (const item of outbox) {
    if ((item.action === 'saveDebt' || item.action === 'debt' || item.type === 'debt') && item.data) {
     debtMap.set(item.data.id, item.data);
    } else if (item.action === 'deleteDebt' && item.id) {
     debtMap.delete(item.id);
    } else if ((item.action === 'saleBatch' || item.action === 'refundBatch') && item.debt) {
     debtMap.set(item.debt.id, item.debt);
    }
   }
   debts = Array.from(debtMap.values());
  }
  APP.debts = debts;
  renderDebtors();
  updateNasiyaStats();
  updateNasiyaBadge();
 };
 try {
  return onSnapshot(colRef, { includeMetadataChanges: true }, handler);
 } catch (e) {
  return onSnapshot(colRef, handler);
 }
}

// ─────────────────────────────────────────────
// BILLS (CHEKLAR)
// ─────────────────────────────────────────────
async function saveBill(bill) {
 if (!window.useDemo && window.firebaseDB) {
 if (!navigator.onLine) {
 await enqueueOutbox({ action: 'saveBill', data: bill });
 APP.bills.unshift(bill);
 await saveLocalData();
 renderBills();
 showToast('Chek oflayn saqlandi, navbatga qo\'yildi');
 return;
 }
 try {
  const { setDoc } = window.firebaseFns;
  await setDoc(userDoc('bills', bill.id), bill);
  return;
  } catch (e) {
  console.error('Chek saqlash xato:', e);
 showToast('Chek saqlanmadi, internetni tekshiring', 'error');
 throw e;
 }
 }
 APP.bills.unshift(bill);
 await saveLocalData();
 renderBills();
}

async function updateBillInDB(bill) {
 if (!window.useDemo && window.firebaseDB) {
 if (!navigator.onLine) {
 await enqueueOutbox({ action: 'saveBill', data: bill });
 await saveLocalData();
 renderBills();
 showToast('Chek oflayn saqlandi, navbatga qo\'yildi', 'warning');
 return;
 }
 try {
  const { setDoc } = window.firebaseFns;
  await setDoc(userDoc('bills', bill.id), bill);
  await saveLocalData();
  renderBills();
  return;
  } catch (e) {
  console.error('Chek yangilash xato:', e);
 await enqueueOutbox({ action: 'saveBill', data: bill });
 await saveLocalData();
 renderBills();
 showToast("Navbatga qo'yildi, internet kelganda yuboriladi", 'warning');
 return;
 }
 }
 if (window.isFirebaseConfigured) {
 await enqueueOutbox({ action: 'saveBill', data: bill });
 }
 await saveLocalData();
 renderBills();
}

function renderBills() {
 const list = document.getElementById('billsList');
 const today = new Date().toDateString();

 // Statistika
 const todayBills = APP.bills.filter(b => new Date(b.timestamp).toDateString() === today);
 document.getElementById('totalBillsCount').textContent = APP.bills.length;
 document.getElementById('totalBillsAmount').textContent = formatPriceShort(
 APP.bills.reduce((s, b) => s + b.total, 0)
 );
 document.getElementById('todayBillsCount').textContent = todayBills.length;

 // Badge
 const badge = document.getElementById('billsBadge');
 if (APP.bills.length > 0) {
 badge.textContent = APP.bills.length > 99 ? '99+' : APP.bills.length;
 badge.style.display = 'flex';
 } else {
 badge.style.display = 'none';
 }

 if (APP.bills.length === 0) {
 list.innerHTML = `<div class="empty-state"><div class="empty-icon">${icon('receipt', 48)}</div><p>Hali chek yo'q</p></div>`;
 return;
 }

 const methodLabel = {
 cash: `${icon('dollar', 14)} Naqd`,
 card: `${icon('card', 14)} Karta`,
 transfer: `${icon('transfer', 14)} O'tkazma`
 };

 list.innerHTML = APP.bills.map(bill => `
 <li class="bill-item" onclick="showBillDetail('${bill.id}')">
 <div class="bill-left">
 <div class="bill-id">#${bill.id.slice(-6).toUpperCase()}</div>
 <div class="bill-date">${formatDate(bill.timestamp)}</div>
 <div class="bill-items-count">${bill.items.reduce((s, i) => s + i.qty, 0)} ta mahsulot</div>
 </div>
 <div class="bill-right">
 <div class="bill-total">${formatPrice(bill.total)}</div>
 <span class="bill-method ${bill.paymentMethod}">${methodLabel[bill.paymentMethod] || bill.paymentMethod}</span>
 </div>
 </li>
 `).join('');
}

function showBillDetail(billId) {
 const bill = APP.bills.find(b => b.id === billId);
 if (!bill) return;
 APP.currentBillForPrint = bill;

 const body = document.getElementById('billDetailBody');
 const methodLabel = { cash: 'Naqd pul', card: 'Karta', transfer: "O'tkazma" };

 body.innerHTML = `
 <div class="bill-detail-receipt">
 <div class="bill-detail-header">
 <div class="bill-detail-shop">${escHtml(bill.shopName || 'ScanPOS')}</div>
 <div style="font-size:0.75rem;color:var(--text3);margin-top:4px">${formatDate(bill.timestamp)}</div>
 <div style="font-size:0.7rem;color:var(--text3)">#${bill.id.slice(-8).toUpperCase()}</div>
 </div>
 ${bill.items.map(item => `
 <div class="bill-detail-row">
 <span>${escHtml(item.name)} × ${item.qty}</span>
 <span>${formatPrice(item.price * item.qty)}</span>
 </div>
 `).join('')}
 <div class="bill-detail-row" style="margin-top:8px;color:var(--text3)">
 <span>Oraliq summa</span><span>${formatPrice(bill.subtotal)}</span>
 </div>
 ${bill.discount > 0 ? `<div class="bill-detail-row" style="color:#22c55e"><span>Chegirma</span><span>-${formatPrice(bill.discount)}</span></div>` : ''}
 ${bill.tax > 0 ? `<div class="bill-detail-row" style="color:#f59e0b"><span>QQS</span><span>+${formatPrice(bill.tax)}</span></div>` : ''}
 <div class="bill-detail-row bill-detail-total">
 <span>JAMI</span><span>${formatPrice(bill.total)}</span>
 </div>
 <div class="bill-detail-row" style="margin-top:8px;font-size:0.75rem;color:var(--text3)">
 <span>To'lov usuli</span><span>${methodLabel[bill.paymentMethod] || bill.paymentMethod}</span>
 </div>
 ${bill.cashGiven > 0 ? `
 <div class="bill-detail-row" style="font-size:0.75rem;color:var(--text3)">
 <span>Berildi</span><span>${formatPrice(bill.cashGiven)}</span>
 </div>
 <div class="bill-detail-row" style="font-size:0.75rem;color:#22c55e">
 <span>Qaytim</span><span>${formatPrice(bill.cashGiven - bill.total)}</span>
 </div>
 ` : ''}
 <div style="text-align:center;margin-top:12px;font-size:0.7rem;color:var(--text3)">
 ScanPOS tomonidan yaratildi
 </div>
 </div>
 `;

 openModal('billDetailModal');
}

function printBill() {
 window.print();
}

// ─────────────────────────────────────────────
// REFUND (QAYTARISH / VOZVRAT)
// ─────────────────────────────────────────────
function openRefundModal(billId) {
 const bill = billId ? APP.bills.find(b => b.id === billId) : APP.currentBillForPrint;
 if (!bill) { showToast('Chek topilmadi'); return; }
 APP._currentRefundBill = bill;

 const container = document.getElementById('refundItemsList');
 if (!container) return;

 const refunds = bill.refunds || [];

 container.innerHTML = bill.items.map(item => {
 const alreadyRefunded = refunds
 .filter(r => r.itemId === item.id)
 .reduce((s, r) => s + (Number(r.qty) || 0), 0);
 const available = Math.max(0, item.qty - alreadyRefunded);

 return `
 <div class="refund-item-row" style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
 <div style="flex:1">
 <div style="font-weight:600">${escHtml(item.name)}</div>
 <div style="font-size:0.75rem;color:var(--text3)">${formatPrice(item.price)} × ${item.qty} ta (Qaytarilgan: ${alreadyRefunded} ta)</div>
 </div>
 <div style="display:flex;align-items:center;gap:8px">
 <span style="font-size:0.8rem">Qaytarish:</span>
 <input type="number" id="refund-qty-${item.id}" min="0" max="${available}" value="0" ${available === 0 ? 'disabled' : ''} style="width:60px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);text-align:center;background:var(--bg2);color:var(--text)">
 <span style="font-size:0.75rem;color:var(--text3)">/ ${available} ta</span>
 </div>
 </div>
 `;
 }).join('');

 openModal('refundModal');
}

async function submitRefund() {
 const bill = APP._currentRefundBill;
 if (!bill) return;

 const refunds = bill.refunds || [];
 const toRefund = [];

 for (const item of bill.items) {
 const input = document.getElementById(`refund-qty-${item.id}`);
 const qty = parseInt(input ? input.value : 0, 10) || 0;
 if (qty > 0) {
 const alreadyRefunded = refunds
 .filter(r => r.itemId === item.id)
 .reduce((s, r) => s + (Number(r.qty) || 0), 0);
 const available = Math.max(0, item.qty - alreadyRefunded);
 if (qty > available) {
 showToast(`Diqqat: ${item.name} uchun koʻpi bilan ${available} ta qaytarish mumkin!`, 'warning');
 return;
 }
 toRefund.push({ item, qty });
 }
 }

 if (toRefund.length === 0) {
 showToast('Qaytarish miqdorini kiriting', 'warning');
 return;
 }

 // 14: Xotira nusxasini saqlash (rollback uchun)
 const oldRefunds = JSON.parse(JSON.stringify(bill.refunds || []));
 const oldStockStates = toRefund.map(({ item }) => {
 const prod = APP.products.find(p => p.id === item.id);
 return prod ? { prod, stock: prod.stock, updatedAt: prod.updatedAt } : null;
 }).filter(Boolean);

 let totalRefundAmount = 0;
 bill.refunds = bill.refunds || [];

 for (const { item, qty } of toRefund) {
 const itemRefundAmount = Math.round(item.price * qty);
 totalRefundAmount += itemRefundAmount;
 bill.refunds.push({
 itemId: item.id,
 itemName: item.name,
 qty,
 amount: itemRefundAmount,
 date: new Date().toISOString()
 });
 }

 // 2: Nasiya cheki bo'lsa qarzni topish: faqat billId orqali (|| d.debtorId olib tashlandi)
 let debtToUpdate = null;
 let oldDebtState = null;
 if (bill.paymentMethod === 'debt') {
 const debt = APP.debts.find(d => d.billId === bill.id);
 if (debt) {
 oldDebtState = { amount: debt.amount, paidAmount: debt.paidAmount, payments: [...(debt.payments || [])] };
 const paidAmount = Number(debt.paidAmount) || 0;
 debt.amount = Math.max(paidAmount, (Number(debt.amount) || 0) - totalRefundAmount);
 debt.payments = debt.payments || [];
 debt.payments.push({
 amount: totalRefundAmount,
 note: `Vozvrat: Chek #${bill.id.slice(-6).toUpperCase()}`,
 date: new Date().toISOString()
 });
 debtToUpdate = debt;
 } else {
 showToast('Eski qarz uchun billId topilmadi', 'warning');
 }
 }

 // 10 & 14: Saqlash bosqichi (atomik)
  if (!window.useDemo && window.firebaseDB && window.firebaseFns && navigator.onLine) {
   try {
    const { writeBatch: wb, increment } = window.firebaseFns;
    const batch = wb(window.firebaseDB);

    for (const { item, qty } of toRefund) {
     const prod = APP.products.find(p => p.id === item.id);
     if (prod && isTracked(prod)) {
      const pRef = userDoc('products', prod.id);
      if (typeof increment === 'function') {
       batch.update(pRef, { stock: increment(qty), updatedAt: new Date().toISOString() });
      } else {
       batch.update(pRef, { stock: (parseInt(prod.stock, 10) || 0) + qty, updatedAt: new Date().toISOString() });
      }
     }
    }

    batch.set(userDoc('bills', bill.id), bill);
    if (debtToUpdate) {
     batch.set(userDoc('debts', debtToUpdate.id), debtToUpdate);
    }

    await withTimeout(batch.commit(), 10000);

    for (const { item, qty } of toRefund) {
     const prod = APP.products.find(p => p.id === item.id);
     if (prod && isTracked(prod)) {
      prod.stock = (parseInt(prod.stock, 10) || 0) + qty;
      prod.updatedAt = new Date().toISOString();
     }
    }
    await saveLocalData();
    if (debtToUpdate) await saveNasiyaData();
   } catch (commitErr) {
    console.warn('Firebase qaytarishda commit xatosi, refundBatch outbox ga olinmoqda:', commitErr);
    for (const { item, qty } of toRefund) {
     const prod = APP.products.find(p => p.id === item.id);
     if (prod && isTracked(prod)) {
      prod.stock = (parseInt(prod.stock, 10) || 0) + qty;
      prod.updatedAt = new Date().toISOString();
     }
    }
    await enqueueOutbox({
     action: 'refundBatch',
     type: 'refundBatch',
     bill,
     debt: debtToUpdate,
     products: toRefund
      .filter(({ item }) => {
       const prod = APP.products.find(x => x.id === item.id);
       return prod && isTracked(prod);
      })
      .map(({ item, qty }) => ({
       id: item.id,
       qtyChange: qty,
       stock: (APP.products.find(x => x.id === item.id) || {}).stock
      }))
    });
    await saveLocalData();
    if (debtToUpdate) await saveNasiyaData();
    showToast("Navbatga qo'yildi, internet kelganda yuboriladi", 'warning');
   }
  } else if (!window.useDemo && window.firebaseDB && window.firebaseFns && !navigator.onLine) {
   // Oflayn Firebase: refundBatch outbox yozuvi
   for (const { item, qty } of toRefund) {
    const prod = APP.products.find(p => p.id === item.id);
    if (prod && isTracked(prod)) {
     prod.stock = (parseInt(prod.stock, 10) || 0) + qty;
     prod.updatedAt = new Date().toISOString();
    }
   }
   await enqueueOutbox({
    action: 'refundBatch',
    type: 'refundBatch',
    bill,
    debt: debtToUpdate,
    products: toRefund
     .filter(({ item }) => {
      const prod = APP.products.find(x => x.id === item.id);
      return prod && isTracked(prod);
     })
     .map(({ item, qty }) => ({
      id: item.id,
      qtyChange: qty,
      stock: (APP.products.find(x => x.id === item.id) || {}).stock
     }))
   });
   await saveLocalData();
   if (debtToUpdate) await saveNasiyaData();
   showToast("Navbatga qo'yildi, internet kelganda yuboriladi", 'warning');
  } else {
   // Demo rejim (yoki configured demo fallback)
   for (const { item, qty } of toRefund) {
    const prod = APP.products.find(p => p.id === item.id);
    if (prod && isTracked(prod)) {
     prod.stock = (parseInt(prod.stock, 10) || 0) + qty;
     prod.updatedAt = new Date().toISOString();
    }
   }
   if (window.isFirebaseConfigured) {
    await enqueueOutbox({
     action: 'refundBatch',
     type: 'refundBatch',
     bill,
     debt: debtToUpdate,
     products: toRefund
      .filter(({ item }) => {
       const prod = APP.products.find(x => x.id === item.id);
       return prod && isTracked(prod);
      })
      .map(({ item, qty }) => ({
       id: item.id,
       qtyChange: qty,
       stock: (APP.products.find(x => x.id === item.id) || {}).stock
      }))
    });
   }
   await saveLocalData();
   if (debtToUpdate) await saveNasiyaData();
  }
 
  if (debtToUpdate) updateNasiyaBadge();
 renderBills();
 renderProducts();
 closeModal('refundModal');
 showBillDetail(bill.id);
 showToast(`${formatPrice(totalRefundAmount)} lik tovar qaytarildi!`);
}

// ─────────────────────────────────────────────
// SMENA YOPISH (SHIFT CLOSE)
// ─────────────────────────────────────────────
function openShiftCloseModal() {
 const dateInput = document.getElementById('shiftDateInput');
 if (dateInput && !dateInput.value) {
 dateInput.value = new Date().toISOString().slice(0, 10);
 }
 const dateVal = dateInput ? dateInput.value : new Date().toISOString().slice(0, 10);
 renderShiftStats(dateVal);
 openModal('shiftCloseModal');
}

function onShiftDateChange() {
 const dateInput = document.getElementById('shiftDateInput');
 if (dateInput) renderShiftStats(dateInput.value);
}

function renderShiftStats(dateStr) {
 const targetDate = dateStr ? new Date(dateStr).toDateString() : new Date().toDateString();
 const dayBills = (APP.bills || []).filter(b => new Date(b.timestamp).toDateString() === targetDate);

 let cashTotal = 0;
 let cardTotal = 0;
 let transferTotal = 0;
 let debtTotal = 0;
 let grossTotal = 0;
 let refundTotal = 0;
 let totalProfit = 0;
 let itemsSold = 0;

 for (const b of dayBills) {
 const bRefunds = (b.refunds || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
 refundTotal += bRefunds;
 grossTotal += Number(b.total) || 0;

 if (b.paymentMethod === 'cash') cashTotal += Number(b.total) || 0;
 else if (b.paymentMethod === 'card') cardTotal += Number(b.total) || 0;
 else if (b.paymentMethod === 'transfer') transferTotal += Number(b.total) || 0;
 else if (b.paymentMethod === 'debt') debtTotal += Number(b.total) || 0;

 for (const item of (b.items || [])) {
 itemsSold += Number(item.qty) || 0;
 if (item.costPrice > 0) {
 const refundedQty = (b.refunds || [])
 .filter(r => r.itemId === item.id)
 .reduce((s, r) => s + (Number(r.qty) || 0), 0);
 const netQty = Math.max(0, item.qty - refundedQty);
 totalProfit += (item.price - item.costPrice) * netQty;
 }
 }
 }

 const netTotal = Math.max(0, grossTotal - refundTotal);
 const netCash = Math.max(0, cashTotal - refundTotal);

 APP._currentShiftStats = {
 date: dateStr,
 billsCount: dayBills.length,
 itemsSold,
 cashTotal,
 cardTotal,
 transferTotal,
 debtTotal,
 refundTotal,
 netTotal,
 netCash,
 totalProfit
 };

 const content = document.getElementById('shiftReportContent');
 if (content) {
 content.innerHTML = `
 <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
 <div class="stat-card" style="padding:10px">
 <div style="font-size:0.75rem;color:var(--text3)">Jami cheklar</div>
 <div style="font-size:1.2rem;font-weight:700">${dayBills.length} ta</div>
 </div>
 <div class="stat-card" style="padding:10px">
 <div style="font-size:0.75rem;color:var(--text3)">Sotilgan tovar</div>
 <div style="font-size:1.2rem;font-weight:700">${itemsSold} ta</div>
 </div>
 </div>
 <div style="font-size:0.85rem;line-height:1.8;border-top:1px solid var(--border);padding-top:10px">
 <div style="display:flex;justify-content:space-between"><span>${icon('dollar', 15)} Naqd tushum:</span> <strong>${formatPrice(cashTotal)}</strong></div>
 <div style="display:flex;justify-content:space-between"><span>${icon('card', 15)} Karta tushum:</span> <strong>${formatPrice(cardTotal)}</strong></div>
 <div style="display:flex;justify-content:space-between"><span>${icon('transfer', 15)} O'tkazma:</span> <strong>${formatPrice(transferTotal)}</strong></div>
 <div style="display:flex;justify-content:space-between"><span>${icon('book', 15)} Nasiya:</span> <strong>${formatPrice(debtTotal)}</strong></div>
 <div style="display:flex;justify-content:space-between;color:#ef4444"><span>${icon('undo', 15, 'icon-red')} Qaytarishlar:</span> <strong>-${formatPrice(refundTotal)}</strong></div>
 <div style="display:flex;justify-content:space-between;font-size:1rem;font-weight:700;margin-top:6px;border-top:1px dashed var(--border);padding-top:6px">
 <span>Sof tushum:</span> <span style="color:var(--primary)">${formatPrice(netTotal)}</span>
 </div>
 <div style="display:flex;justify-content:space-between;color:#22c55e"><span>${icon('trendUp', 15, 'icon-green')} Taxminiy sof foyda:</span> <strong>${formatPrice(totalProfit)}</strong></div>
 <div style="display:flex;justify-content:space-between;background:var(--bg2);padding:6px 8px;border-radius:6px;margin-top:6px">
 <span>Kassada kutilayotgan naqd:</span> <strong>${formatPrice(netCash)}</strong>
 </div>
 </div>
 `;
 }

 calculateCashDiscrepancy();
}

function calculateCashDiscrepancy() {
 const input = document.getElementById('actualCashInput');
 const resultEl = document.getElementById('cashDifferenceText');
 if (!resultEl) return;

 const actual = parseFloat(input ? input.value : 0) || 0;
 const expected = APP._currentShiftStats ? APP._currentShiftStats.netCash : 0;

 if (!input || !input.value) {
 resultEl.textContent = 'Kassadagi pulni kiriting';
 resultEl.style.color = 'var(--text3)';
 return;
 }

 const diff = actual - expected;
 if (diff === 0) {
 resultEl.innerHTML = `${icon('check', 16, 'icon-green')} Kassada kamomad yoki ortiqcha yoʻq (0 soʻm)`;
 resultEl.style.color = '#22c55e';
 } else if (diff > 0) {
 resultEl.innerHTML = `${icon('alert', 16, 'icon-yellow')} Kassada ortiqcha pul: +${formatPrice(diff)}`;
 resultEl.style.color = '#f59e0b';
 } else {
 resultEl.innerHTML = `${icon('x', 16, 'icon-red')} Kassada kamomad bor: -${formatPrice(Math.abs(diff))}`;
 resultEl.style.color = '#ef4444';
 }
}

function printShiftReport() {
 window.print();
}

async function clearAllBills() {
 if (APP.bills.length === 0) return;
 if (!confirm('Barcha cheklar tarixini o\'chirishni tasdiqlaysizmi?')) return;

 // Firebase rejimida Firestore'dan ham batch orqali o'chirish
 if (!window.useDemo && window.firebaseDB && window.firebaseFns) {
 try {
  const { getDocs, writeBatch } = window.firebaseFns;
  const snapshot = await getDocs(userCol('bills'));
 if (!snapshot.empty) {
 let batch = writeBatch(window.firebaseDB);
 let count = 0;
 for (const docSnap of snapshot.docs) {
 batch.delete(docSnap.ref);
 count++;
 if (count % 400 === 0) {
 await batch.commit();
 batch = writeBatch(window.firebaseDB);
 }
 }
 await batch.commit();
 }
 } catch (e) {
 console.error('Firestore cheklarni o\'chirish xatosi:', e);
 }
 }

 APP.bills = [];
 saveLocalData();
 renderBills();
 showToast('Cheklar tarixi tozalandi');
}

// ─────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────
function loadSettings() {
 try {
 const saved = localStorage.getItem(nsKey('scanpos_settings'));
 APP.settings = saved ? JSON.parse(saved) : {};
 } catch { APP.settings = {}; }

 // UI ga yuklash
 const el = (id) => document.getElementById(id);
 if (el('shopName')) el('shopName').value = APP.settings.shopName || '';
 if (el('shopAddress')) el('shopAddress').value = APP.settings.shopAddress || '';
 if (el('shopPhone')) el('shopPhone').value = APP.settings.shopPhone || '';
 if (el('taxRate')) el('taxRate').value = APP.settings.taxRate || '0';
 if (el('discountEnabled')) el('discountEnabled').checked = APP.settings.discountEnabled || false;
 if (el('voiceEnabled')) el('voiceEnabled').checked = APP.settings.voiceEnabled !== false;
 if (el('voiceLang')) el('voiceLang').value = APP.settings.voiceLang || 'uz-UZ';
 if (el('settingsLangSelect')) el('settingsLangSelect').value = APP.settings.lang || 'uz';
 if (typeof applyLanguage === 'function') applyLanguage();

 APP.voiceOn = APP.settings.voiceEnabled !== false;
}

function saveSettings() {
 APP.settings = {
 shopName: document.getElementById('shopName')?.value || '',
 shopAddress: document.getElementById('shopAddress')?.value || '',
 shopPhone: document.getElementById('shopPhone')?.value || '',
 taxRate: document.getElementById('taxRate')?.value || '0',
 discountEnabled: document.getElementById('discountEnabled')?.checked || false,
 voiceEnabled: document.getElementById('voiceEnabled')?.checked !== false,
 voiceLang: document.getElementById('voiceLang')?.value || 'uz-UZ',
 lang: APP.settings?.lang || document.getElementById('settingsLangSelect')?.value || 'uz',
 };
 localStorage.setItem(nsKey('scanpos_settings'), JSON.stringify(APP.settings));
 if (typeof saveUserMeta === 'function') saveUserMeta();
 APP.voiceOn = APP.settings.voiceEnabled;
}

function updateFirebaseStatus() {
 const dot = document.getElementById('statusDot');
 const text = document.getElementById('statusText');
 if (!dot || !text) return;

 if (!window.useDemo && window.firebaseDB) {
 dot.className = 'status-dot online';
 text.textContent = 'Firebase ulangan';
 } else {
 dot.className = 'status-dot offline';
 text.textContent = 'Demo rejim (offline)';
 }
}

// ─────────────────────────────────────────────
// LOCAL & INDEXEDDB STORAGE
// ─────────────────────────────────────────────
async function loadLocalData() {
 loadCategoryPrices();
 try {
 // 1. Sinxron fallback (agar hali bo'sh bo'lsa)
 const pSync = localStorage.getItem(nsKey('scanpos_products'));
 const bSync = localStorage.getItem(nsKey('scanpos_bills'));
 const cSync = localStorage.getItem(nsKey('scanpos_cart'));
 if (pSync && (!APP.products || APP.products.length === 0)) {
 try { APP.products = JSON.parse(pSync); } catch (e) {}
 }
 if (bSync && (!APP.bills || APP.bills.length === 0)) {
 try { APP.bills = JSON.parse(bSync); } catch (e) {}
 }
 if (cSync) {
 try {
 APP.cart = JSON.parse(cSync);
 updateCartUI();
 } catch (e) {}
 }

 // 2. ScanDB (IndexedDB) dan o'qish
 const pIDB = await ScanDB.get('scanpos_products');
 if (Array.isArray(pIDB) && pIDB.length > 0) {
 APP.products = pIDB;
 }
 const bIDB = await ScanDB.get('scanpos_bills');
 if (Array.isArray(bIDB) && bIDB.length > 0) {
 APP.bills = bIDB;
 }
 const hIDB = await ScanDB.get('scanpos_held_carts');
 if (Array.isArray(hIDB)) {
 APP.heldCarts = hIDB;
 }
 const sIDB = await ScanDB.get('scanpos_supplies');
 if (Array.isArray(sIDB)) {
 APP.supplies = sIDB;
 }
 const expIDB = await ScanDB.get('scanpos_expenses');
 if (Array.isArray(expIDB)) {
 APP.expenses = expIDB;
 } else {
 try {
   const eSync = localStorage.getItem(nsKey('scanpos_expenses'));
  if (eSync) APP.expenses = JSON.parse(eSync);
 } catch (e) {}
 }

 // 3. Migratsiya: localStorage -> IndexedDB
 if (!localStorage.getItem(nsKey('scanpos_migrated_v1'))) {
 if (APP.products && APP.products.length > 0) {
 await ScanDB.set('scanpos_products', APP.products);
 }
 if (APP.bills && APP.bills.length > 0) {
 await ScanDB.set('scanpos_bills', APP.bills);
 }
 const dSync = localStorage.getItem(nsKey('scanpos_debtors'));
 const tSync = localStorage.getItem(nsKey('scanpos_debts'));
 if (dSync) {
 try { await ScanDB.set('scanpos_debtors', JSON.parse(dSync)); } catch (e) {}
 }
 if (tSync) {
 try { await ScanDB.set('scanpos_debts', JSON.parse(tSync)); } catch (e) {}
 }

 // localStorage dan katta maydonlarni tozalash
 localStorage.removeItem(nsKey('scanpos_products'));
 localStorage.removeItem(nsKey('scanpos_bills'));
 localStorage.removeItem(nsKey('scanpos_debtors'));
 localStorage.removeItem(nsKey('scanpos_debts'));
 localStorage.setItem(nsKey('scanpos_migrated_v1'), 'true');
 console.log(' scanpos_migrated_v1: Maʼlumotlar IndexedDB ga oʻtkazildi');
 }
 } catch (e) {
 console.warn('loadLocalData xato:', e);
 }

 // Migratsiya: normalizeProduct orqali
 if (Array.isArray(APP.products)) {
 APP.products.forEach(prod => normalizeProduct(prod));
 saveLocalData();
 }

 // Nasiya ma'lumotlarini ham yuklash
 await loadNasiyaData();
 updateOutboxUI();
}

async function saveLocalData() {
 try {
 // Faqat savat va sozlamalar localStorage'da qoladi
 localStorage.setItem(nsKey('scanpos_cart'), JSON.stringify(APP.cart || []));

 // Mahsulotlar (rasmlari bilan) va cheklar IndexedDB (ScanDB) da saqlanadi
 const ok1 = await ScanDB.set('scanpos_products', APP.products || []);
 const ok2 = await ScanDB.set('scanpos_bills', APP.bills || []);
 await ScanDB.set('scanpos_expenses', APP.expenses || []);
 try { localStorage.setItem(nsKey('scanpos_expenses'), JSON.stringify(APP.expenses || [])); } catch (e) {}
 if (ok1 === false || ok2 === false) {
 showToast('Xotira to\'ldi yoki saqlanmadi', 'error');
 }
 } catch (e) {
 console.warn('saveLocalData xato:', e);
 showToast('Xotira to\'ldi yoki saqlanmadi', 'error');
 }
}

// ─────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────
function showPage(page) {
 // Eski sahifani yashirish
 document.getElementById(`page-${APP.currentPage}`)?.classList.remove('active');
 document.getElementById(`bnav-${APP.currentPage}`)?.classList.remove('active');

 APP.currentPage = page;

 document.getElementById(`page-${page}`)?.classList.add('active');
 document.getElementById(`bnav-${page}`)?.classList.add('active');

 // Kamera boshqaruvi: boshqa sahifada to'xtatish, skanerda ishga tushirish
 if (page === 'scanner') {
 if (!APP.cameraStream) startCamera();
 else if (!APP.scanning) startScanning();
 } else {
 APP.scanning = false;
 stopCamera();
 }
}

// Sahifa fonga o'tganda (tab alishganda) kamerani to'xtatish, qaytganda tiklash
document.addEventListener('visibilitychange', () => {
 if (document.hidden) {
 if (APP.cameraStream) stopCamera();
 } else {
 if (APP.currentPage === 'scanner' && !APP.cameraStream) {
 startCamera();
 }
 }
});

function showManualInput() {
 const bar = document.getElementById('manualInputBar');
 bar.classList.toggle('open');
 if (bar.classList.contains('open')) {
 setTimeout(() => document.getElementById('manualBarcodeInput')?.focus(), 100);
 }
}

function openModal(id) {
 document.getElementById(id).classList.add('open');
}

function closeModal(id) {
 document.getElementById(id).classList.remove('open');
}

let toastTimer;
function showToast(msg, type = 'info') {
 const toast = document.getElementById('toastMsg');
 if (!toast) return;

 let cleanMsg = String(msg || '');
 let iconHtml = icon('info', 18);

 if (cleanMsg.includes('\u2705') || type === 'success') {
 iconHtml = icon('check', 18, 'icon-green');
 } else if (cleanMsg.includes('\u26A0') || type === 'warning') {
 iconHtml = icon('alert', 18, 'icon-yellow');
 } else if (cleanMsg.includes('\u274C') || type === 'error') {
 iconHtml = icon('x', 18, 'icon-red');
 } else if (cleanMsg.includes('\u{1F310}')) {
 iconHtml = icon('globe', 18, 'icon-cyan');
 } else if (cleanMsg.includes('\u{1F5D1}')) {
 iconHtml = icon('trash', 18, 'icon-red');
 } else if (cleanMsg.includes('\u{1F6D2}')) {
 iconHtml = icon('cart', 18);
 } else if (cleanMsg.includes('\u{1F526}') || cleanMsg.includes('\u26A1')) {
 iconHtml = icon('bolt', 18, 'icon-yellow');
 } else if (cleanMsg.includes('\u{1F50A}') || cleanMsg.includes('\u{1F507}')) {
 iconHtml = icon('volume', 18);
 } else if (cleanMsg.includes('\u{1F4D2}') || cleanMsg.includes('\u{1F4CB}')) {
 iconHtml = icon('book', 18);
 } else if (cleanMsg.includes('\u{1F4B5}') || cleanMsg.includes('\u{1F4B8}')) {
 iconHtml = icon('dollar', 18, 'icon-green');
 }

 // Barcha emojilarni matndan tozalash (100% SVG ikonka bo'lishi uchun)
  cleanMsg = cleanMsg.replace(/[\u{1F000}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/gu, '').trim();

 toast.innerHTML = `<span style="display:inline-flex;align-items:center;margin-right:8px;vertical-align:-3px;">${iconHtml}</span><span>${escHtml(cleanMsg)}</span>`;
 toast.classList.add('show');
 clearTimeout(toastTimer);
 toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

// ─────────────────────────────────────────────
// FORMATTING
// ─────────────────────────────────────────────
function formatPrice(amount) {
 if (isNaN(amount)) return '0 so\'m';
 return new Intl.NumberFormat('uz-UZ').format(Math.round(amount)) + ' so\'m';
}

function formatPriceShort(amount) {
 if (amount >= 1000000000) return (amount / 1000000000).toFixed(1) + ' mlrd';
 if (amount >= 1000000) return (amount / 1000000).toFixed(1) + ' mln';
 if (amount >= 1000) return (amount / 1000).toFixed(0) + ' ming';
 return String(Math.round(amount));
}

function formatDate(isoStr) {
 try {
 const d = new Date(isoStr);
 const now = new Date();
 const isToday = d.toDateString() === now.toDateString();
 const timeStr = d.toLocaleTimeString('uz', { hour: '2-digit', minute: '2-digit' });
 if (isToday) return `Bugun, ${timeStr}`;
 return d.toLocaleDateString('uz', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ` ${timeStr}`;
 } catch { return isoStr; }
}

function generateId() {
 return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escHtml(str) {
 if (!str) return '';
 return String(str)
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;')
 .replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────
// KEYBOARD SHORTCUT (barcode scanner hardware)
// ─────────────────────────────────────────────
// Ba'zi do'konlarda USB/Bluetooth barcode scanner ishlatiladi
// Ular klaviatura kabi matn kiritadi va Enter bilan tugaydi
let hwBuffer = '';
let hwTimer = null;

document.addEventListener('keydown', (e) => {
 // Modal ochiq bo'lsa yoki input/textarea ga fokus bo'lsa — ignore
 if (document.querySelector('.modal-overlay.open')) return;
 const focused = document.activeElement;
 if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.tagName === 'SELECT')) return;

 if (e.key === 'Enter' && hwBuffer.length > 4) {
 handleBarcodeDetected(hwBuffer);
 hwBuffer = '';
 clearTimeout(hwTimer);
 return;
 }

 if (e.key.length === 1 && /[\w\d]/.test(e.key)) {
 hwBuffer += e.key;
 clearTimeout(hwTimer);
 hwTimer = setTimeout(() => { hwBuffer = ''; }, 300);
 }
});

// ─────────────────────────────────────────────
// MODAL OUTSIDE CLICK
// ─────────────────────────────────────────────
document.addEventListener('click', (e) => {
 // Faqat to'g'ridan-to'g'ri overlay ga bosilganda yopilsin (modal ichidagi elementlarga emas)
 if (e.target.classList.contains('modal-overlay') && e.target.id) {
 closeModal(e.target.id);
 }
});

// ─────────────────────────────────────────────
// EXPOSE GLOBALS
// ─────────────────────────────────────────────
window.showPage = showPage;
window.startCamera = startCamera;
window.showManualInput = showManualInput;
window.searchManualBarcode = searchManualBarcode;
window.addFoundProductToCart = addFoundProductToCart;
window.changeQty = changeQty;
window.removeFromCart = removeFromCart;
window.clearCart = clearCart;
window.proceedToCheckout = proceedToCheckout;
window.selectPayment = selectPayment;
window.calcChange = calcChange;
window.applyDiscount = applyDiscount;
window.completeSale = completeSale;
window.toggleVoice = toggleVoice;
window.updateVoiceBtn = updateVoiceBtn;
window.showAddProductModal = showAddProductModal;
window.saveProduct = saveProduct;
window.editProduct = editProduct;
window.editProductById = editProductById;
window.deleteProduct = deleteProduct;
window.filterProducts = filterProducts;
window.scanForModal = scanForModal;
window.lookupBarcodeOnline = lookupBarcodeOnline;
window.openAddProductModalWithData = openAddProductModalWithData;
window.setModalProductImage = setModalProductImage;
window.removeProductImage = removeProductImage;
window.handleProductImageFile = handleProductImageFile;
window.fetchProductImageOnline = fetchProductImageOnline;
window.showBillDetail = showBillDetail;
window.printBill = printBill;
window.clearAllBills = clearAllBills;
window.openModal = openModal;
window.closeModal = closeModal;
window.showToast = showToast;
window.saveSettings = saveSettings;
window.renderBills = renderBills;
window.saveProductToDB = saveProductToDB;
window.saveBill = saveBill;
window.addToCart = addToCart;
window.handleBarcodeDetected = handleBarcodeDetected;
window.saveDebtorToDB = saveDebtorToDB;
window.deleteDebtorFromDB = deleteDebtorFromDB;
window.saveDebtToDB = saveDebtToDB;
window.deleteDebtFromDB = deleteDebtFromDB;
window.updateBillInDB = updateBillInDB;
window.ScanDB = ScanDB;
window.withTimeout = withTimeout;
window.normalizeProduct = normalizeProduct;
window.isTracked = isTracked;
window.sanitizePhone = sanitizePhone;
window.enqueueOutbox = enqueueOutbox;
window.processOutbox = processOutbox;
window.getOutboxQueue = getOutboxQueue;

// ─────────────────────────────────────────────
// ANALYTICS MODULE
// ─────────────────────────────────────────────
const ANALYTICS = {
 period: 'week', // 'week' | 'month'
 charts: {}, // Chart instances
};

/** Davr tugmasini almashtirish */
window.switchAnalyticsPeriod = function (period) {
 ANALYTICS.period = period;
 ['week', 'month'].forEach(p => {
 document.getElementById(`ptab-${p}`)?.classList.toggle('active', p === period);
 });
 renderAnalytics();
};

/** Sahifa ochilganda chaqiriladi */
function renderAnalytics() {
 const days = ANALYTICS.period === 'week' ? 7 : 30;
 const now = new Date();
 const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

 const filtered = APP.bills.filter(b => new Date(b.timestamp) >= cutoff);

 // ── Top stats (3.3 & 3.4) ──
 const grossRevenue = filtered.reduce((s, b) => s + (Number(b.total) || 0), 0);
 const totalRefunds = filtered.reduce((s, b) => s + (b.refunds || []).reduce((sr, r) => sr + (Number(r.amount) || 0), 0), 0);
 const netRevenue = Math.max(0, grossRevenue - totalRefunds);

 const totalBills = filtered.length;
 const totalItems = filtered.reduce((s, b) => s + b.items.reduce((si, i) => si + (Number(i.qty) || 0), 0), 0);
 const avgBill = totalBills > 0 ? netRevenue / totalBills : 0;

 // Foyda hisobi (3.4)
 let totalProfit = 0;
 let itemsWithoutCost = 0;
 for (const b of filtered) {
 for (const item of (b.items || [])) {
 if (item.costPrice && item.costPrice > 0) {
 const refundedQty = (b.refunds || [])
 .filter(r => r.itemId === item.id)
 .reduce((s, r) => s + (Number(r.qty) || 0), 0);
 const netQty = Math.max(0, item.qty - refundedQty);
 totalProfit += (item.price - item.costPrice) * netQty;
 } else {
 itemsWithoutCost++;
 }
 }
 }

 const revEl = document.getElementById('anTotalRevenue');
 if (revEl) revEl.textContent = formatPriceShort(netRevenue) + ' so\'m';
 const billsEl = document.getElementById('anTotalBills');
 if (billsEl) billsEl.textContent = totalBills;
 const itemsEl = document.getElementById('anTotalItems');
 if (itemsEl) itemsEl.textContent = totalItems;
 const avgEl = document.getElementById('anAvgBill');
 if (avgEl) avgEl.textContent = formatPriceShort(avgBill) + ' so\'m';

 // Yangi kartalar: Foyda va Qaytarishlar
 const profitEl = document.getElementById('anTotalProfit');
 if (profitEl) profitEl.textContent = formatPriceShort(totalProfit) + ' so\'m';
 const profitNoteEl = document.getElementById('anProfitNote');
 if (profitNoteEl) {
 if (itemsWithoutCost > 0) {
 profitNoteEl.textContent = `* ${itemsWithoutCost} ta tovar tannarxsiz, hisobga olinmadi`;
 profitNoteEl.style.display = 'block';
 } else {
 profitNoteEl.style.display = 'none';
 }
 }
 const refundsEl = document.getElementById('anTotalRefunds');
 if (refundsEl) refundsEl.textContent = formatPriceShort(totalRefunds) + ' so\'m';

 // Do'kon xarajatlari va Haqiqiy sof foyda hisobi
 const periodExpenses = (APP.expenses || []).filter(e => {
  const d = new Date(e.date || e.createdAt);
  return !isNaN(d.getTime()) && d >= cutoff;
 });
 const totalExpenses = periodExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
 const realNetProfit = totalProfit - totalExpenses;

 const expEl = document.getElementById('anTotalExpenses');
 if (expEl) expEl.textContent = formatPriceShort(totalExpenses) + ' so\'m';

 const netProfitEl = document.getElementById('anNetRealProfit');
 if (netProfitEl) {
  const sign = realNetProfit < 0 ? '-' : '';
  netProfitEl.textContent = sign + formatPriceShort(Math.abs(realNetProfit)) + ' so\'m';
 }
 const netCardEl = document.getElementById('anNetRealProfitCard');
 const netNoteEl = document.getElementById('anNetProfitNote');
 if (netCardEl) {
  if (realNetProfit < 0) {
   netCardEl.style.background = 'linear-gradient(135deg, #b91c1c, #dc2626)';
   if (netNoteEl) netNoteEl.textContent = 'ZARAR! Xarajatlar foydadan oshdi';
  } else {
   netCardEl.style.background = 'linear-gradient(135deg, #0284c7, #0369a1)';
   if (netNoteEl) netNoteEl.textContent = 'Sotuv - Tannarx - Xarajat';
  }
 }

 // ── TOP-5 products ──
 buildTopProducts(filtered);

 // 5.3: Agar Chart.js yuklanmagan bo'lsa "Grafik yuklanmadi" matni chiqsin
 if (typeof Chart === 'undefined') {
 console.warn('Chart.js mavjud emas yoki yuklanmagan');
 ['revenueChart', 'paymentChart', 'hourlyChart'].forEach(canvasId => {
 const cv = document.getElementById(canvasId);
 if (cv && cv.parentElement) {
 const existing = cv.parentElement.querySelector('.chart-fallback-msg');
 if (!existing) {
 const msg = document.createElement('div');
 msg.className = 'chart-fallback-msg';
 msg.style.cssText = 'text-align:center;padding:30px 10px;color:var(--text3);font-size:0.85rem;';
 msg.textContent = 'Grafik yuklanmadi (Internet tarmogʻini tekshiring)';
 cv.style.display = 'none';
 cv.parentElement.appendChild(msg);
 }
 }
 });
 return;
 }

 // ── Revenue chart (kunlik) ──
 buildRevenueChart(filtered, days);

 // ── Payment pie chart ──
 buildPaymentChart(filtered);

 // ── Hourly chart (bugun) ──
 buildHourlyChart();
}

/** Kunlik savdo grafigi (line chart) */
function buildRevenueChart(bills, days) {
 if (typeof Chart === 'undefined') return;
 const labels = [];
 const data = [];

 for (let i = days - 1; i >= 0; i--) {
 const d = new Date();
 d.setDate(d.getDate() - i);
 const dateStr = d.toDateString();
 labels.push(
 i === 0 ? 'Bugun' :
 i === 1 ? 'Kecha' :
 d.toLocaleDateString('uz', { day: '2-digit', month: '2-digit' })
 );
 const dayTotal = bills
 .filter(b => new Date(b.timestamp).toDateString() === dateStr)
 .reduce((s, b) => s + b.total, 0);
 data.push(Math.round(dayTotal / 1000)); // ming so'm
 }

 const ctx = document.getElementById('revenueChart');
 if (!ctx) return;

 if (ANALYTICS.charts.revenue) ANALYTICS.charts.revenue.destroy();

 ANALYTICS.charts.revenue = new Chart(ctx, {
 type: 'line',
 data: {
 labels,
 datasets: [{
 label: 'Daromad (ming so\'m)',
 data,
 borderColor: '#a855f7',
 backgroundColor: 'rgba(168,85,247,0.15)',
 borderWidth: 2.5,
 pointBackgroundColor: '#a855f7',
 pointRadius: 4,
 pointHoverRadius: 7,
 fill: true,
 tension: 0.4,
 }]
 },
 options: {
 responsive: true,
 maintainAspectRatio: false,
 plugins: { legend: { display: false } },
 scales: {
 x: {
 ticks: { color: '#94a3b8', font: { size: 10 } },
 grid: { color: 'rgba(255,255,255,0.05)' },
 },
 y: {
 ticks: { color: '#94a3b8', font: { size: 10 }, callback: v => v + 'K' },
 grid: { color: 'rgba(255,255,255,0.05)' },
 beginAtZero: true,
 }
 }
 }
 });
}

/** To'lov usullari donut chart */
function buildPaymentChart(bills) {
 if (typeof Chart === 'undefined') return;
 const cash = bills.filter(b => b.paymentMethod === 'cash').reduce((s, b) => s + b.total, 0);
 const card = bills.filter(b => b.paymentMethod === 'card').reduce((s, b) => s + b.total, 0);
 const trans = bills.filter(b => b.paymentMethod === 'transfer').reduce((s, b) => s + b.total, 0);

 const ctx = document.getElementById('paymentChart');
 if (!ctx) return;
 if (ANALYTICS.charts.payment) ANALYTICS.charts.payment.destroy();

 const total = cash + card + trans || 1;
 const pct = v => Math.round(v / total * 100);

 ANALYTICS.charts.payment = new Chart(ctx, {
 type: 'doughnut',
 data: {
 labels: ['Naqd', 'Karta', 'O\'tkazma'],
 datasets: [{
 data: [cash, card, trans],
 backgroundColor: ['#22c55e', '#a855f7', '#06b6d4'],
 borderWidth: 0,
 hoverOffset: 6,
 }]
 },
 options: {
 responsive: true,
 maintainAspectRatio: false,
 cutout: '65%',
 plugins: {
 legend: { display: false },
 tooltip: {
 callbacks: {
 label: ctx => ` ${formatPriceShort(ctx.parsed)} so'm (${pct(ctx.parsed)}%)`
 }
 }
 }
 }
 });

 // Custom legend
 const legend = document.getElementById('paymentLegend');
 if (legend) {
 const items = [
 { label: 'Naqd', val: cash, color: '#22c55e', iconName: 'dollar' },
 { label: 'Karta', val: card, color: '#a855f7', iconName: 'card' },
 { label: 'O\'tkazma', val: trans, color: '#06b6d4', iconName: 'transfer' },
 ];
 legend.innerHTML = items.map(it => `
 <div class="pay-legend-item">
 <span class="pay-legend-dot" style="background:${it.color}"></span>
 <span style="display:inline-flex;align-items:center;gap:4px;">${icon(it.iconName, 13)} ${it.label}</span>
 <span class="pay-legend-val">${pct(it.val)}%</span>
 </div>
 `).join('');
 }
}

/** TOP-5 ko'p sotilgan mahsulotlar */
function buildTopProducts(bills) {
 const counter = {};
 bills.forEach(b => b.items.forEach(item => {
 counter[item.name] = (counter[item.name] || 0) + item.qty;
 }));

 const sorted = Object.entries(counter)
 .sort((a, b) => b[1] - a[1])
 .slice(0, 5);

 const list = document.getElementById('topProductsList');
 if (!list) return;

 const maxQty = sorted[0]?.[1] || 1;

 if (sorted.length === 0) {
 list.innerHTML = '<div style="color:var(--text3);text-align:center;padding:20px">Ma\'lumot yo\'q</div>';
 return;
 }

 list.innerHTML = sorted.map(([name, qty], i) => `
 <div class="top-product-row">
 <span class="top-product-medal" style="font-weight:800;color:var(--primary);font-size:0.85rem;min-width:24px;">#${i + 1}</span>
 <div class="top-product-info">
 <div class="top-product-name">${escHtml(name)}</div>
 <div class="top-product-bar-wrap">
 <div class="top-product-bar" style="width:${Math.round(qty/maxQty*100)}%"></div>
 </div>
 </div>
 <span class="top-product-qty">${qty} ta</span>
 </div>
 `).join('');
}

/** Bugungi soatlik savdo (bar chart) */
function buildHourlyChart() {
 if (typeof Chart === 'undefined') return;
 const today = new Date().toDateString();
 const todayBills = APP.bills.filter(b => new Date(b.timestamp).toDateString() === today);

 const hours = Array(24).fill(0);
 todayBills.forEach(b => {
 const h = new Date(b.timestamp).getHours();
 hours[h] += b.total;
 });

 // To'liq 24 soat (00:00–23:00)
 const labels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
 const data = hours.map(v => Math.round(v / 1000));

 const ctx = document.getElementById('hourlyChart');
 if (!ctx) return;
 if (ANALYTICS.charts.hourly) ANALYTICS.charts.hourly.destroy();

 ANALYTICS.charts.hourly = new Chart(ctx, {
 type: 'bar',
 data: {
 labels,
 datasets: [{
 label: 'Daromad (K so\'m)',
 data,
 backgroundColor: ctx2 => {
 const g = ctx2.chart.ctx.createLinearGradient(0, 0, 0, 200);
 g.addColorStop(0, 'rgba(6,182,212,0.8)');
 g.addColorStop(1, 'rgba(6,182,212,0.1)');
 return g;
 },
 borderRadius: 6,
 borderSkipped: false,
 }]
 },
 options: {
 responsive: true,
 maintainAspectRatio: false,
 plugins: { legend: { display: false } },
 scales: {
 x: {
 ticks: { color: '#94a3b8', font: { size: 9 } },
 grid: { display: false },
 },
 y: {
 ticks: { color: '#94a3b8', font: { size: 10 }, callback: v => v + 'K' },
 grid: { color: 'rgba(255,255,255,0.05)' },
 beginAtZero: true,
 }
 }
 }
 });
}

// Analytics showPage hook — sahifa ochilganda render qilish
const _origShowPage = window.showPage;
window.showPage = function (page) {
 _origShowPage(page);
 if (page === 'analytics') {
 setTimeout(renderAnalytics, 50);
 }
};

// Bills yangilanganda analytics ham yangilansin
window.renderAnalyticsIfOpen = function () {
 if (APP.currentPage === 'analytics') renderAnalytics();
};

window.switchAnalyticsPeriod = window.switchAnalyticsPeriod;
window.renderAnalytics = renderAnalytics;

// ═════════════════════════════════════════════
// NASIYA DAFTAR MODULE
// ═════════════════════════════════════════════

// ── Ma'lumotlarni yuklash / saqlash (IndexedDB / ScanDB) ──
async function loadNasiyaData() {
 try {
 const dSync = localStorage.getItem(nsKey('scanpos_debtors'));
 const tSync = localStorage.getItem(nsKey('scanpos_debts'));
 if (dSync && (!APP.debtors || APP.debtors.length === 0)) {
 try { APP.debtors = JSON.parse(dSync); } catch (e) {}
 }
 if (tSync && (!APP.debts || APP.debts.length === 0)) {
 try { APP.debts = JSON.parse(tSync); } catch (e) {}
 }

 const dIDB = await ScanDB.get('scanpos_debtors');
 if (Array.isArray(dIDB)) APP.debtors = dIDB;
 const tIDB = await ScanDB.get('scanpos_debts');
 if (Array.isArray(tIDB)) APP.debts = tIDB;
 } catch (e) { console.warn('Nasiya yuklash xato:', e); }
}

async function saveNasiyaData() {
 try {
 await ScanDB.set('scanpos_debtors', APP.debtors || []);
 await ScanDB.set('scanpos_debts', APP.debts || []);
 } catch (e) { console.warn('Nasiya saqlash xato:', e); }
}

// ── Statistika badge ──
function updateNasiyaBadge() {
 const badge = document.getElementById('nasiyaBadge');
 if (!badge) return;
 const activeDebts = APP.debtors.filter(d => debtorBalance(d.id) > 0);
 if (activeDebts.length > 0) {
 badge.textContent = activeDebts.length > 99 ? '99+' : activeDebts.length;
 badge.style.display = 'flex';
 } else {
 badge.style.display = 'none';
 }
}

// Qazdor uchun qolgan qarz miqdori
function debtorBalance(debtorId) {
 return APP.debts
 .filter(d => d.debtorId === debtorId)
 .reduce((sum, d) => sum + (d.amount - d.paidAmount), 0);
}

// Jami qarzlar (barcha mijozlar)
function totalDebtSum() {
 return APP.debts.reduce((sum, d) => sum + Math.max(0, d.amount - d.paidAmount), 0);
}

// ── Nasiya sahifasi statistikasini yangilash ──
function updateNasiyaStats() {
 const today = new Date().toDateString();
 const totalDebt = totalDebtSum();
 const debtorCount = APP.debtors.filter(d => debtorBalance(d.id) > 0).length;
 const todayPaid = APP.debts.reduce((sum, d) => {
 const todayPayments = (d.payments || []).filter(p =>
 new Date(p.date).toDateString() === today
 );
 return sum + todayPayments.reduce((s, p) => s + p.amount, 0);
 }, 0);

 const el1 = document.getElementById('nasiyaTotalDebt');
 const el2 = document.getElementById('nasiyaDebtorCount');
 const el3 = document.getElementById('nasiyaTodayPaid');
 if (el1) el1.textContent = formatPriceShort(totalDebt);
 if (el2) el2.textContent = debtorCount;
 if (el3) el3.textContent = formatPriceShort(todayPaid);
 updateNasiyaBadge();
}

// ── Qarzdorlar ro'yxatini render qilish ──
function renderDebtors(list) {
 const container = document.getElementById('debtorList');
 if (!container) return;
 const debtors = list || APP.debtors;

 if (debtors.length === 0) {
 container.innerHTML = `
 <div class="empty-state">
 <div class="empty-icon" style="margin:0 auto 12px;">${icon('book', 40)}</div>
 <p>Nasiya daftar bo'sh</p>
 <span style="font-size:0.8rem;color:var(--text3)">"+ Yangi mijoz" tugmasini bosing</span>
 </div>`;
 return;
 }

 container.innerHTML = debtors.map(debtor => {
 const balance = debtorBalance(debtor.id);
 const debtorDebts = APP.debts.filter(d => d.debtorId === debtor.id);
 const totalGiven = debtorDebts.reduce((s, d) => s + d.amount, 0);
 const totalPaid = debtorDebts.reduce((s, d) => s + d.paidAmount, 0);
 const isPaid = balance <= 0;
 const statusClass = isPaid ? 'debtor-paid' : (balance > 100000 ? 'debtor-danger' : 'debtor-warn');

 return `
 <div class="debtor-card ${statusClass}">
 <div class="debtor-card-main" onclick="toggleDebtorDetail('${debtor.id}')">
 <div class="debtor-avatar">${escHtml((debtor.name || '')[0] ? (debtor.name || '')[0].toUpperCase() : '')}</div>
     <div class="debtor-info">
      <div class="debtor-name">${escHtml(debtor.name)}
       <span class="debtor-status-dot ${isPaid ? 'dot-green' : balance > 100000 ? 'dot-red' : 'dot-yellow'}"></span>
      </div>
      <div class="debtor-meta">
       ${debtor.phone
        ? `<a href="tel:${escHtml(sanitizePhone(debtor.phone))}" onclick="event.stopPropagation()">${icon('phone', 13)} ${escHtml(debtor.phone)}</a>`
        : `<span>${icon('user', 13)} Telefon yo'q</span>`}
      </div>
     </div>
 <div class="debtor-balance">
 <div class="debtor-balance-val ${isPaid ? 'debt-zero' : 'debt-active'}">${formatPrice(balance)}</div>
 <div class="debtor-balance-label">qarz</div>
 </div>
 </div>

 <!-- Tafsilot panel -->
 <div class="debtor-detail" id="detail-${debtor.id}" style="display:none">
 <div class="debtor-detail-stats">
 <span>${icon('receipt', 14)} Berildi: <b>${formatPrice(totalGiven)}</b></span>
 <span>${icon('check', 14, 'icon-green')} To'landi: <b>${formatPrice(totalPaid)}</b></span>
 </div>
 <div class="debtor-actions">
 <button class="btn-primary btn-sm" onclick="openAddDebtModal('${debtor.id}'); event.stopPropagation()">
 ${icon('plus', 14)} Nasiya
 </button>
 <button class="btn-secondary btn-sm" onclick="editDebtor('${debtor.id}'); event.stopPropagation()">
 ${icon('edit', 14)} Tahrirlash
 </button>
 <button class="btn-danger btn-sm" onclick="deleteDebtor('${debtor.id}'); event.stopPropagation()">
 ${icon('trash', 14)} O'chirish
 </button>
 </div>
 <!-- Nasiyalar ro'yxati -->
 <div class="debt-items">
 ${debtorDebts.length === 0
 ? `<p style="color:var(--text3);font-size:0.85rem">${icon('info', 14)} Nasiya yo'q</p>`
 : debtorDebts.map(dt => {
 const dtBalance = dt.amount - dt.paidAmount;
 const dtDate = new Date(dt.createdAt).toLocaleDateString('uz-UZ');
 const isOverdue = dt.dueDate && new Date(dt.dueDate) < new Date() && dtBalance > 0;
 return `
 <div class="debt-item ${dtBalance <= 0 ? 'debt-item-paid' : isOverdue ? 'debt-item-overdue' : ''}">
 <div class="debt-item-info">
 <div class="debt-item-desc">${icon('book', 13)} ${escHtml(dt.description || 'Nasiya')}</div>
 <div class="debt-item-date">${dtDate}${dt.dueDate ? ` • Muddat: ${new Date(dt.dueDate).toLocaleDateString('uz-UZ')}${isOverdue ? ` ${icon('alert', 13, 'icon-red')}` : ''}` : ''}</div>
 </div>
 <div class="debt-item-right">
 <div class="debt-item-bal ${dtBalance <= 0 ? 'debt-zero' : ''}">Qoldi: ${formatPrice(dtBalance)}</div>
 ${dtBalance > 0
 ? `<button class="btn-success btn-xs" onclick="openPayDebtModal('${dt.id}'); event.stopPropagation()">${icon('dollar', 13)} To'lash</button>`
 : `<span style="color:var(--success);font-size:0.75rem">${icon('check', 13)} To'langan</span>`}
 </div>
 </div>`;
 }).join('')}
 </div>
 </div>
 </div>`;
 }).join('');
}

function toggleDebtorDetail(debtorId) {
 const el = document.getElementById(`detail-${debtorId}`);
 if (!el) return;
 el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function filterDebtors(query) {
 const q = (query || '').toLowerCase();
 const filtered = q
 ? APP.debtors.filter(d =>
 d.name.toLowerCase().includes(q) ||
 (d.phone || '').includes(q)
 )
 : APP.debtors;
 renderDebtors(filtered);
}

// ── Mijoz (debtor) CRUD ──

async function saveDebtor() {
 const name = document.getElementById('debtorName').value.trim();
 if (!name) { showToast('Ism kiritilishi shart', 'warning'); return; }

 const existingId = document.getElementById('debtorId').value;
 const phone = document.getElementById('debtorPhone').value.trim();
 const note = document.getElementById('debtorNote').value.trim();

 let targetDebtor;
 if (existingId) {
  targetDebtor = APP.debtors.find(x => x.id === existingId);
  if (targetDebtor) { targetDebtor.name = name; targetDebtor.phone = phone; targetDebtor.note = note; }
  showToast(`"${name}" yangilandi`, 'success');
 } else {
  targetDebtor = { id: generateId(), name, phone, note, createdAt: new Date().toISOString() };
  APP.debtors.unshift(targetDebtor);
  showToast(`"${name}" qo'shildi`, 'success');
 }

 if (targetDebtor) {
  await saveDebtorToDB(targetDebtor);
 }

 await saveNasiyaData();
 closeModal('addDebtorModal');
 renderDebtors();
 updateNasiyaStats();
}

function editDebtor(debtorId) {
 const d = APP.debtors.find(x => x.id === debtorId);
 if (!d) return;
 document.getElementById('debtorId').value = d.id;
 document.getElementById('debtorName').value = d.name;
 document.getElementById('debtorPhone').value = d.phone || '';
 document.getElementById('debtorNote').value = d.note || '';
 document.getElementById('debtorModalTitle').textContent = 'Mijozni tahrirlash';
 openModal('addDebtorModal');
}

async function deleteDebtor(debtorId) {
 const d = APP.debtors.find(x => x.id === debtorId);
 if (!d) return;
 if (debtorBalance(debtorId) > 0) {
  if (!confirm(`"${d.name}" da ${formatPrice(debtorBalance(debtorId))} qarz bor! Baribir o'chirishni xohlaysizmi?`)) return;
 } else {
  if (!confirm(`"${d.name}" ni o'chirishni tasdiqlaysizmi?`)) return;
 }
 const relatedDebts = APP.debts.filter(x => x.debtorId === debtorId);
 APP.debtors = APP.debtors.filter(x => x.id !== debtorId);
 APP.debts = APP.debts.filter(x => x.debtorId !== debtorId);

 await deleteDebtorFromDB(debtorId);
 for (const rd of relatedDebts) {
  await deleteDebtFromDB(rd.id);
 }

 await saveNasiyaData();
 renderDebtors();
 updateNasiyaStats();
 showToast('O\'chirildi', 'info');
}

// ── Nasiya CRUD ──
function openAddDebtModal(debtorId) {
 const debtor = APP.debtors.find(d => d.id === debtorId);
 const debtorName = debtor ? debtor.name : '';
 document.getElementById('debtCustomerId').value = debtorId;
 document.getElementById('addDebtTitle').textContent = `Nasiya — ${debtorName}`;
 document.getElementById('debtAmount').value = '';
 document.getElementById('debtDescription').value = '';
 document.getElementById('debtDueDate').value = '';
 openModal('addDebtModal');
}

async function recordDebt() {
 const debtorId = document.getElementById('debtCustomerId').value;
 const amount = parseFloat(document.getElementById('debtAmount').value) || 0;
 if (!debtorId || amount <= 0) { showToast('Miqdor kiritilishi shart', 'warning'); return; }

 const debt = {
  id: generateId(),
  debtorId,
  amount,
  paidAmount: 0,
  description: document.getElementById('debtDescription').value.trim() || 'Nasiya',
  dueDate: document.getElementById('debtDueDate').value || null,
  createdAt: new Date().toISOString(),
  payments: []
 };
 APP.debts.unshift(debt);
 await saveDebtToDB(debt);
 await saveNasiyaData();
 closeModal('addDebtModal');
 renderDebtors();
 updateNasiyaStats();
 const debtor = APP.debtors.find(d => d.id === debtorId);
 showToast(`${debtor ? debtor.name : 'Mijoz'} ga ${formatPrice(amount)} nasiya kiritildi`, 'success');
}

// ── To'lov ──
function openPayDebtModal(debtId) {
 const debt = APP.debts.find(d => d.id === debtId);
 if (!debt) return;
 const debtor = APP.debtors.find(d => d.id === debt.debtorId);
 const balance = debt.amount - debt.paidAmount;
 document.getElementById('payDebtId').value = debtId;
 document.getElementById('payDebtTitle').textContent = `To'lov — ${debtor ? debtor.name : ''}` ;
 document.getElementById('payDebtInfo').innerHTML = `
 <div style="margin-bottom:6px;display:flex;align-items:center;gap:4px;">${icon('receipt', 14)} ${escHtml(debt.description)}</div>
 <div>Jami nasiya: <b>${formatPrice(debt.amount)}</b></div>
 <div>To'landi: <b style="color:var(--success)">${formatPrice(debt.paidAmount)}</b></div>
 <div>Qoldi: <b style="color:var(--danger)">${formatPrice(balance)}</b></div>`;
 document.getElementById('payAmount').value = balance;
 document.getElementById('payNote').value = '';
 openModal('payDebtModal');
}

async function submitPayment() {
 const debtId = document.getElementById('payDebtId').value;
 const amount = parseFloat(document.getElementById('payAmount').value) || 0;
 if (!debtId || amount <= 0) { showToast('To\'lov miqdori kiritilishi shart', 'warning'); return; }

 const debt = APP.debts.find(d => d.id === debtId);
 if (!debt) return;

 const balance = debt.amount - debt.paidAmount;
 const paid = Math.min(amount, balance); // ortiqcha qabul qilmaslik
 debt.paidAmount += paid;
 debt.payments = debt.payments || [];
 debt.payments.push({ amount: paid, note: document.getElementById('payNote').value.trim(), date: new Date().toISOString() });

 await saveDebtToDB(debt);
 await saveNasiyaData();
 if (typeof SOUNDS !== 'undefined') SOUNDS.cash();
 closeModal('payDebtModal');
 renderDebtors();
 updateNasiyaStats();

 const debtor = APP.debtors.find(d => d.id === debt.debtorId);
 const remaining = debt.amount - debt.paidAmount;
 if (remaining <= 0) {
  showToast(`${debtor ? debtor.name : 'Mijoz'} ning qarzi to'liq to'landi!`, 'success');
 } else {
  showToast(`${formatPrice(paid)} qabul qilindi. Qoldi: ${formatPrice(remaining)}`, 'success');
 }
}

// ── showPage hook: nasiya sahifasi ochilganda render ──
const _nasiyaOrigShowPage = window.showPage;
window.showPage = function (page) {
 if (typeof _nasiyaOrigShowPage === 'function') _nasiyaOrigShowPage(page);
 if (page === 'nasiya') {
 renderDebtors();
 updateNasiyaStats();
 }
};



// ─────────────────────────────────────────────
// TOVAR KIRIMI (SUPPLY / STOCK IN)
// ─────────────────────────────────────────────
function openSupplyModal(productId = null) {
 APP.activeSupplyProduct = null;
 const barcodeInput = document.getElementById('supplyBarcode');
 if (barcodeInput) barcodeInput.value = '';
 const searchResults = document.getElementById('supplySearchResults');
 if (searchResults) { searchResults.innerHTML = ''; searchResults.style.display = 'none'; }
 const productCard = document.getElementById('supplyProductCard');
 if (productCard) productCard.style.display = 'none';
 const qtyInput = document.getElementById('supplyQty');
 if (qtyInput) qtyInput.value = '';
 const costInput = document.getElementById('supplyCostPrice');
 if (costInput) costInput.value = '';
 const saleInput = document.getElementById('supplySalePrice');
 if (saleInput) saleInput.value = '';
 const idInput = document.getElementById('supplySelectedProductId');
 if (idInput) idInput.value = '';

 if (productId) {
 const p = APP.products.find(item => item.id === productId);
 if (p) selectSupplyProduct(p);
 }
 openModal('supplyModal');
}

function onSupplySearch(val) {
 const q = (val || '').trim().toLowerCase();
 const resultsDiv = document.getElementById('supplySearchResults');
 if (!resultsDiv) return;
 if (!q) {
 resultsDiv.innerHTML = '';
 resultsDiv.style.display = 'none';
 return;
 }
 const cleanBarcode = extractProductBarcode(q);
 const exact = APP.products.find(p => p.barcode === cleanBarcode || (Array.isArray(p.barcodes) && p.barcodes.includes(cleanBarcode)));
 if (exact) {
 selectSupplyProduct(exact);
 resultsDiv.style.display = 'none';
 return;
 }
 const matches = APP.products.filter(p =>
 (p.name && p.name.toLowerCase().includes(q)) ||
 (p.barcode && p.barcode.includes(q))
 ).slice(0, 8);

 if (matches.length === 0) {
 resultsDiv.innerHTML = '<div style="padding:10px;font-size:0.8rem;color:var(--text3);">Tovar topilmadi</div>';
 resultsDiv.style.display = 'block';
 return;
 }

 resultsDiv.innerHTML = matches.map(p => `
 <div class="supply-search-item" onclick="selectSupplyProductById('${p.id}')">
 <div>
 <div class="supply-search-item-name">${escHtml(p.name)}</div>
 <div class="supply-search-item-meta">${escHtml(p.barcode || '')} • Omborda: ${p.stock || 0} ${escHtml(p.unit || 'ta')}</div>
 </div>
 <div style="font-weight:700;color:var(--cyan);">${formatPrice(p.price)}</div>
 </div>
 `).join('');
 resultsDiv.style.display = 'block';
}

function selectSupplyProductById(id) {
 const p = APP.products.find(item => item.id === id);
 if (p) selectSupplyProduct(p);
}

function selectSupplyProduct(product) {
 APP.activeSupplyProduct = product;
 const resultsDiv = document.getElementById('supplySearchResults');
 if (resultsDiv) resultsDiv.style.display = 'none';
 const idInput = document.getElementById('supplySelectedProductId');
 if (idInput) idInput.value = product.id;
 const barcodeInput = document.getElementById('supplyBarcode');
 if (barcodeInput) barcodeInput.value = product.name;

 const card = document.getElementById('supplyProductCard');
 if (card) {
 card.style.display = 'block';
 const nameEl = document.getElementById('spCardName');
 if (nameEl) nameEl.textContent = product.name;
 const bcEl = document.getElementById('spCardBarcode');
 if (bcEl) bcEl.textContent = 'Kod: ' + (product.barcode || '—');
 const stEl = document.getElementById('spCardStock');
 if (stEl) stEl.textContent = `${parseFloat(product.stock) || 0} ${product.unit || 'ta'}`;
 const costEl = document.getElementById('spCardCost');
 if (costEl) costEl.textContent = product.costPrice ? `${formatPrice(product.costPrice)}/${product.unit || 'ta'}` : 'Belgilanmagan';
 const prEl = document.getElementById('spCardPrice');
 if (prEl) prEl.textContent = `${formatPrice(product.price)}/${product.unit || 'ta'}`;
 }

 const costInput = document.getElementById('supplyCostPrice');
 if (costInput && product.costPrice) costInput.value = product.costPrice;
 const qtyInput = document.getElementById('supplyQty');
 if (qtyInput) qtyInput.focus();
}

function scanForSupply() {
 closeModal('supplyModal');
 showPage('scanner');
 APP._scanForSupply = true;
 showToast('Kirim uchun shtrix-kodni kameraga ko\'rsating');
 updateScanHint('Kirim uchun shtrix-kod skanerlang...', 'success');
}

async function submitSupply() {
 const prodId = document.getElementById('supplySelectedProductId')?.value || APP.activeSupplyProduct?.id;
 if (!prodId) {
 showToast('Tovarni tanlang yoki skanerlang', 'warning');
 return;
 }
 const prod = APP.products.find(p => p.id === prodId);
 if (!prod) {
 showToast('Tovar topilmadi', 'error');
 return;
 }
 const qty = parseFloat(document.getElementById('supplyQty')?.value);
 if (isNaN(qty) || qty <= 0) {
 showToast('Kirim miqdorini to\'g\'ri kiriting', 'warning');
 return;
 }
 const costPrice = parseFloat(document.getElementById('supplyCostPrice')?.value);
 if (isNaN(costPrice) || costPrice < 0) {
 showToast('Kelish narxini to\'g\'ri kiriting', 'warning');
 return;
 }
 const salePriceRaw = parseFloat(document.getElementById('supplySalePrice')?.value);

 const prevStock = parseFloat(prod.stock) || 0;
 const newStock = Math.round((prevStock + qty) * 1000) / 1000;
 prod.stock = newStock;
 prod.trackStock = true;
 prod.costPrice = Math.round(costPrice);
 if (!isNaN(salePriceRaw) && salePriceRaw > 0) {
 prod.price = Math.round(salePriceRaw);
 }
 prod.updatedAt = new Date().toISOString();

 await saveProductToDB(prod);
 await saveLocalData();
 renderProducts();
 updateProductStats();

 const record = {
 id: generateId(),
 productId: prod.id,
 productName: prod.name,
 barcode: prod.barcode || '',
 qty,
 unit: prod.unit || 'ta',
 costPrice: prod.costPrice,
 price: prod.price,
 timestamp: new Date().toISOString()
 };
 if (!Array.isArray(APP.supplies)) APP.supplies = [];
 APP.supplies.unshift(record);
 await ScanDB.set('scanpos_supplies', APP.supplies);
 cloudSet('supplies', record.id, record);

 closeModal('supplyModal');
 if (typeof SOUNDS !== 'undefined') SOUNDS.tiq();
 showToast(`Kirim qabul qilindi: ${prod.name} (+${qty} ${prod.unit || 'ta'}, jami: ${newStock} ${prod.unit || 'ta'})`, 'success');
}

// ─────────────────────────────────────────────
// TOVARLARNI EXCEL / CSV DAN IMPORT QILISH
// ─────────────────────────────────────────────
let _parsedCSVProducts = [];

function openImportCSVModal() {
 _parsedCSVProducts = [];
 const fileInput = document.getElementById('csvFileInput');
 if (fileInput) fileInput.value = '';
 const textInput = document.getElementById('csvTextInput');
 if (textInput) textInput.value = '';
 const preview = document.getElementById('csvPreviewArea');
 if (preview) preview.style.display = 'none';
 const btn = document.getElementById('btnExecuteCSVImport');
 if (btn) btn.disabled = true;
 openModal('importCSVModal');
}

function downloadCSVTemplate() {
 const header = "Nomi,Shtrixkod,Sotish narxi,Kelish narxi,Qoldiq,Birlik,Toifa\r\n";
 const rows = [
 "Coca-Cola 1.5L,4780001234567,14000,11000,24,dona,ichimlik",
 "Mol go'shti,200000000001,95000,80000,18.5,kg,oziq",
 "Qora non,200000000002,4000,3000,50,dona,non",
 "Shakar,200000000003,12000,10000,100,kg,oziq"
 ].join("\r\n");

 const blob = new Blob(["\uFEFF" + header + rows], { type: 'text/csv;charset=utf-8;' });
 const url = URL.createObjectURL(blob);
 const a = document.createElement('a');
 a.href = url;
 a.download = 'scanpos_tovarlar_namuna.csv';
 document.body.appendChild(a);
 a.click();
 document.body.removeChild(a);
 URL.revokeObjectURL(url);
 showToast('Namuna shablon yuklab olindi');
}

function parseCSVLine(line, delimiter) {
 const result = [];
 let current = '';
 let inQuotes = false;
 for (let i = 0; i < line.length; i++) {
 const char = line[i];
 if (char === '"') {
 inQuotes = !inQuotes;
 } else if (char === delimiter && !inQuotes) {
 result.push(current.trim());
 current = '';
 } else {
 current += char;
 }
 }
 result.push(current.trim());
 return result;
}

function parseCSV(text) {
 if (!text || typeof text !== 'string') return [];
 const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
 if (lines.length < 2) return [];

 const firstLine = lines[0];
 let delimiter = ',';
 if (firstLine.includes(';') && (firstLine.split(';').length > firstLine.split(',').length)) {
 delimiter = ';';
 } else if (firstLine.includes('\t')) {
 delimiter = '\t';
 }

 const rawHeaders = parseCSVLine(firstLine, delimiter).map(h => h.toLowerCase().replace(/[^a-z0-9а-яёo'g']/gi, ''));

 let nameIdx = -1, barcodeIdx = -1, priceIdx = -1, costIdx = -1, stockIdx = -1, unitIdx = -1, catIdx = -1;

 rawHeaders.forEach((h, idx) => {
 if (/name|nomi|mahsulot|tovar|товар|наименование/i.test(h)) nameIdx = idx;
 else if (/barcode|shtrix|kod|штрих|код/i.test(h)) barcodeIdx = idx;
 else if (/cost|tannarx|kelish|себестоимость|приход/i.test(h)) costIdx = idx;
 else if (/sotish|price|narx|цена/i.test(h)) priceIdx = idx;
 else if (/stock|qoldiq|soni|miqdor|остаток|колво/i.test(h)) stockIdx = idx;
 else if (/unit|birlik|olchov|ед/i.test(h)) unitIdx = idx;
 else if (/cat|toifa|kategoriya|категория/i.test(h)) catIdx = idx;
 });

 if (nameIdx === -1) nameIdx = 0;
 if (barcodeIdx === -1 && rawHeaders.length > 1) barcodeIdx = 1;
 if (priceIdx === -1 && rawHeaders.length > 2) priceIdx = 2;
 if (costIdx === -1 && rawHeaders.length > 3) costIdx = 3;
 if (stockIdx === -1 && rawHeaders.length > 4) stockIdx = 4;
 if (unitIdx === -1 && rawHeaders.length > 5) unitIdx = 5;

 const products = [];
 for (let i = 1; i < lines.length; i++) {
 const cols = parseCSVLine(lines[i], delimiter);
 const getCol = (idx) => (idx >= 0 && cols[idx] !== undefined && cols[idx] !== null) ? String(cols[idx]).trim() : '';
 const name = getCol(nameIdx);
 if (!name) continue;

 let barcode = getCol(barcodeIdx);
 if (!barcode) {
 barcode = '200' + String(Math.floor(100000000 + Math.random() * 900000000));
 }
 const cleanBarcode = extractProductBarcode(barcode);

 const priceRaw = getCol(priceIdx).replace(/[^0-9.]/g, '');
 const price = parseFloat(priceRaw) || 0;
 if (price <= 0) continue;

 const costRaw = getCol(costIdx).replace(/[^0-9.]/g, '');
 const costPrice = parseFloat(costRaw) || null;

 const stockRaw = getCol(stockIdx).replace(/[^0-9.]/g, '');
 const stock = stockRaw !== '' ? (parseFloat(stockRaw) || 0) : 0;
 const trackStock = stockRaw !== '';

 let unit = getCol(unitIdx).toLowerCase();
 if (!['dona', 'kg', 'g', 'l', 'm'].includes(unit)) {
 if (unit.includes('kg') || unit.includes('кг')) unit = 'kg';
 else if (unit.includes('gram') || unit.includes('гр') || unit === 'g') unit = 'g';
 else if (unit.includes('lit') || unit.includes('лит') || unit === 'l') unit = 'l';
 else if (unit.includes('met') || unit.includes('метр') || unit === 'm') unit = 'm';
 else unit = 'dona';
 }

 const category = getCol(catIdx) || 'boshqa';

 products.push({
 name,
 barcode: cleanBarcode,
 price: Math.round(price),
 costPrice: costPrice ? Math.round(costPrice) : null,
 stock,
 trackStock,
 unit,
 category
 });
 }
 return products;
}

function handleCSVFileSelect(event) {
 const file = event.target.files?.[0];
 if (!file) return;
 const reader = new FileReader();
 reader.onload = function(e) {
 const text = e.target.result;
 const textInput = document.getElementById('csvTextInput');
 if (textInput) textInput.value = text;
 parseCSVFromText(text);
 };
 reader.readAsText(file, 'utf-8');
}

function parseCSVFromText(text) {
 _parsedCSVProducts = parseCSV(text);
 const preview = document.getElementById('csvPreviewArea');
 const summary = document.getElementById('csvSummaryText');
 const list = document.getElementById('csvPreviewList');
 const btn = document.getElementById('btnExecuteCSVImport');

 if (!_parsedCSVProducts || _parsedCSVProducts.length === 0) {
 if (preview) preview.style.display = 'none';
 if (btn) btn.disabled = true;
 return;
 }

 let existingCount = 0;
 let newCount = 0;
 _parsedCSVProducts.forEach(p => {
 const exists = APP.products.some(curr => curr.barcode === p.barcode);
 if (exists) existingCount++;
 else newCount++;
 });

 if (summary) {
 summary.textContent = `Aniqlangan tovarlar: ${_parsedCSVProducts.length} ta (${newCount} ta yangi, ${existingCount} ta mavjud yangilanadi)`;
 }
 if (list) {
 list.innerHTML = _parsedCSVProducts.slice(0, 10).map((p, idx) => `
 <div style="padding:2px 0;">${idx + 1}. <strong>${escHtml(p.name)}</strong> (${escHtml(p.barcode)}) — ${formatPrice(p.price)} so'm [Ombor: ${p.stock} ${escHtml(p.unit)}]</div>
 `).join('') + (_parsedCSVProducts.length > 10 ? `<div style="font-style:italic;margin-top:4px;">... va yana ${_parsedCSVProducts.length - 10} ta tovar</div>` : '');
 }
 if (preview) preview.style.display = 'block';
 if (btn) btn.disabled = false;
}

async function executeCSVImport() {
 if (!_parsedCSVProducts || _parsedCSVProducts.length === 0) {
 showToast('Import qilish uchun tovar topilmadi', 'warning');
 return;
 }
 const count = _parsedCSVProducts.length;
 let updated = 0;
 let created = 0;

 for (const item of _parsedCSVProducts) {
 const idx = APP.products.findIndex(p => p.barcode === item.barcode);
 if (idx >= 0) {
 const curr = APP.products[idx];
 curr.name = item.name;
 curr.price = item.price;
 if (item.costPrice !== null) curr.costPrice = item.costPrice;
 curr.stock = item.stock;
 curr.trackStock = item.trackStock;
 curr.unit = item.unit;
 curr.updatedAt = new Date().toISOString();
 normalizeProduct(curr);
 await saveProductToDB(curr);
 updated++;
 } else {
 const newProd = {
 id: generateId(),
 name: item.name,
 barcode: item.barcode,
 price: item.price,
 costPrice: item.costPrice,
 stock: item.stock,
 trackStock: item.trackStock,
 unit: item.unit,
 category: item.category || 'boshqa',
 isQuick: false,
 createdAt: new Date().toISOString(),
 updatedAt: new Date().toISOString()
 };
 normalizeProduct(newProd);
 await saveProductToDB(newProd);
 created++;
 }
 }

 await saveLocalData();
 renderProducts();
 updateProductStats();
 closeModal('importCSVModal');
 showToast(`${count} ta tovar import qilindi (${created} ta yangi, ${updated} ta yangilandi)!`, 'success');
}

// ─────────────────────────────────────────────
// SAVATNI TO'XTATIB TURISH (HOLD CART)
// ─────────────────────────────────────────────
async function saveHeldCarts() {
 await ScanDB.set('scanpos_held_carts', APP.heldCarts || []);
 try {
 localStorage.setItem(nsKey('scanpos_held_carts'), JSON.stringify(APP.heldCarts || []));
 } catch (e) {}
}

async function holdCurrentCart() {
 if (!APP.cart || APP.cart.length === 0) {
 showToast('Savat bo\'sh!', 'warning');
 return;
 }
 const defaultLabel = `Mijoz #${(APP.heldCarts ? APP.heldCarts.length : 0) + 1}`;
 let label = '';
 try {
 label = prompt('Mijoz haqida qisqa eslatma (ixtiyoriy):', defaultLabel);
 } catch (e) {}
 if (!label || !label.trim()) label = defaultLabel;

 const { total: grand } = calcTotals(APP.cart, 0, APP.settings.taxRate);

 const heldItem = {
 id: generateId(),
 label: label.trim(),
 heldAt: new Date().toISOString(),
 timeStr: new Date().toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' }),
 items: JSON.parse(JSON.stringify(APP.cart)),
 itemCount: APP.cart.reduce((s, i) => s + (Number(i.qty) || 0), 0),
 total: grand
 };

 if (!Array.isArray(APP.heldCarts)) APP.heldCarts = [];
 APP.heldCarts.unshift(heldItem);
 APP.cart = [];
 await saveHeldCarts();
 updateCartUI();
 showToast(`${heldItem.label} savati kutishga qo'yildi`, 'info');
}

function openHeldCartsModal() {
 renderHeldCartsList();
 openModal('heldCartsModal');
}

function renderHeldCartsList() {
 const container = document.getElementById('heldCartsList');
 if (!container) return;

 if (!APP.heldCarts || APP.heldCarts.length === 0) {
 container.innerHTML = `
 <div class="empty-state" style="padding:20px 0;">
 <div class="empty-icon" style="margin:0 auto 8px;">${icon('box', 36)}</div>
 <p style="font-size:0.9rem;">Kutishda savat yo'q</p>
 </div>`;
 return;
 }

 container.innerHTML = APP.heldCarts.map(h => `
 <div class="held-cart-card">
 <div style="display:flex;justify-content:space-between;align-items:flex-start;">
 <div>
 <div style="font-weight:700;font-size:0.95rem;color:var(--text);">${escHtml(h.label)}</div>
 <div style="font-size:0.75rem;color:var(--text3);margin-top:2px;">Vaqt: ${escHtml(h.timeStr || '')} • ${h.items?.length || 0} xil tovar (${h.itemCount || 0} ta)</div>
 </div>
 <div style="font-weight:800;font-size:1rem;color:var(--cyan);">${formatPrice(h.total || 0)}</div>
 </div>
 <div style="font-size:0.8rem;color:var(--text2);line-height:1.3;background:var(--bg2);padding:6px 8px;border-radius:6px;">
 ${(h.items || []).map(i => `${escHtml(i.name)} (${i.qty} ${escHtml(i.unit || 'ta')})`).join(', ')}
 </div>
 <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px;">
 <button type="button" class="btn-danger btn-xs" onclick="deleteHeldCart('${h.id}')" style="padding:5px 10px;font-size:0.75rem;border-radius:6px;">
 O'chirish
 </button>
 <button type="button" class="btn-success btn-xs" onclick="restoreHeldCart('${h.id}')" style="padding:5px 12px;font-size:0.75rem;font-weight:700;border-radius:6px;display:inline-flex;align-items:center;gap:4px;">
 <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="svg-icon">
 <polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>
 </svg>
 Savatga qaytarish
 </button>
 </div>
 </div>
 `).join('');
}

async function restoreHeldCart(heldId) {
 const held = (APP.heldCarts || []).find(h => h.id === heldId);
 if (!held) return;

 if (APP.cart && APP.cart.length > 0) {
 if (!confirm('Hozirgi savatda tovarlar bor! Ularni ham kutishga qo\'yib, bu savatni tiklaysizmi?')) {
 return;
 }
 const autoHeld = {
 id: generateId(),
 label: `Mijoz #${(APP.heldCarts.length) + 1}`,
 heldAt: new Date().toISOString(),
 timeStr: new Date().toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' }),
 items: JSON.parse(JSON.stringify(APP.cart)),
 itemCount: APP.cart.reduce((s, i) => s + (Number(i.qty) || 0), 0),
 total: calcTotals(APP.cart, 0, APP.settings.taxRate).total
 };
 APP.heldCarts.unshift(autoHeld);
 }

 APP.cart = JSON.parse(JSON.stringify(held.items));
 APP.heldCarts = APP.heldCarts.filter(h => h.id !== heldId);
 await saveHeldCarts();
 updateCartUI();
 closeModal('heldCartsModal');
 showToast(`${held.label} savati kassa ekraniga tiklandi!`, 'success');
}

async function deleteHeldCart(heldId) {
 if (!confirm('Ushbu kutishdagi savatni o\'chirishni tasdiqlaysizmi?')) return;
 APP.heldCarts = (APP.heldCarts || []).filter(h => h.id !== heldId);
 await saveHeldCarts();
 renderHeldCartsList();
 updateCartUI();
 showToast('Kutishdagi savat o\'chirildi');
}

async function clearAllHeldCarts() {
 if (!APP.heldCarts || APP.heldCarts.length === 0) return;
 if (!confirm('Barcha kutishdagi savatlarni tozalashni tasdiqlaysizmi?')) return;
 APP.heldCarts = [];
 await saveHeldCarts();
 renderHeldCartsList();
 updateCartUI();
 showToast('Kutishdagi barcha savatlar tozalandi');
}

// ─────────────────────────────────────────────
// OMBOR SANOG'I (REVIZIYA / INVENTARIZATSIYA)
// ─────────────────────────────────────────────
function openAuditModal() {
 APP.activeAuditProduct = null;
 const barcodeInput = document.getElementById('auditBarcode');
 if (barcodeInput) barcodeInput.value = '';
 const searchResults = document.getElementById('auditSearchResults');
 if (searchResults) { searchResults.innerHTML = ''; searchResults.style.display = 'none'; }
 const activeBox = document.getElementById('auditActiveProductBox');
 if (activeBox) activeBox.style.display = 'none';
 renderAuditList();
 openModal('auditModal');
}

function onAuditSearch(val) {
 const q = (val || '').trim().toLowerCase();
 const resultsDiv = document.getElementById('auditSearchResults');
 if (!resultsDiv) return;
 if (!q) {
 resultsDiv.innerHTML = '';
 resultsDiv.style.display = 'none';
 return;
 }
 const cleanBarcode = extractProductBarcode(q);
 const exact = APP.products.find(p => p.barcode === cleanBarcode || (Array.isArray(p.barcodes) && p.barcodes.includes(cleanBarcode)));
 if (exact) {
 selectAuditProduct(exact);
 resultsDiv.style.display = 'none';
 return;
 }
 const matches = APP.products.filter(p =>
 (p.name && p.name.toLowerCase().includes(q)) ||
 (p.barcode && p.barcode.includes(q))
 ).slice(0, 8);

 if (matches.length === 0) {
 resultsDiv.innerHTML = '<div style="padding:10px;font-size:0.8rem;color:var(--text3);">Tovar topilmadi</div>';
 resultsDiv.style.display = 'block';
 return;
 }

 resultsDiv.innerHTML = matches.map(p => `
 <div class="supply-search-item" onclick="selectAuditProductById('${p.id}')">
 <div>
 <div class="supply-search-item-name">${escHtml(p.name)}</div>
 <div class="supply-search-item-meta">${escHtml(p.barcode || '')} • Tizimda: ${parseFloat(p.stock) || 0} ${escHtml(p.unit || 'ta')}</div>
 </div>
 <div style="font-weight:700;color:var(--cyan);">${formatPrice(p.price)}</div>
 </div>
 `).join('');
 resultsDiv.style.display = 'block';
}

function selectAuditProductById(id) {
 const p = APP.products.find(item => item.id === id);
 if (p) selectAuditProduct(p);
}

function selectAuditProduct(product) {
 APP.activeAuditProduct = product;
 const resultsDiv = document.getElementById('auditSearchResults');
 if (resultsDiv) resultsDiv.style.display = 'none';
 const barcodeInput = document.getElementById('auditBarcode');
 if (barcodeInput) barcodeInput.value = product.name;

 const box = document.getElementById('auditActiveProductBox');
 if (box) box.style.display = 'block';
 const nameEl = document.getElementById('auditActiveName');
 if (nameEl) nameEl.textContent = product.name;
 const bcEl = document.getElementById('auditActiveBarcode');
 if (bcEl) bcEl.textContent = 'Kod: ' + (product.barcode || '—');
 const sysEl = document.getElementById('auditActiveSysStock');
 const sysStock = parseFloat(product.stock) || 0;
 if (sysEl) sysEl.textContent = `${sysStock} ${product.unit || 'ta'}`;

 const existingAudit = (APP.auditItems || []).find(i => i.productId === product.id);
 const input = document.getElementById('auditActualInput');
 if (input) {
 input.value = existingAudit ? existingAudit.actualStock : '';
 input.focus();
 }
 calcAuditItemDiff();
}

function calcAuditItemDiff() {
 const badge = document.getElementById('auditActiveDiffBadge');
 if (!badge) return;
 if (!APP.activeAuditProduct) {
 badge.innerHTML = '';
 return;
 }
 const input = document.getElementById('auditActualInput');
 const actualVal = parseFloat(input?.value);
 if (isNaN(actualVal)) {
 badge.innerHTML = '';
 return;
 }
 const sysStock = parseFloat(APP.activeAuditProduct.stock) || 0;
 const diff = Math.round((actualVal - sysStock) * 1000) / 1000;
 const cost = APP.activeAuditProduct.costPrice || APP.activeAuditProduct.price || 0;
 const sum = Math.round(Math.abs(diff) * cost);
 const unit = APP.activeAuditProduct.unit || 'ta';

 if (diff < 0) {
 badge.innerHTML = `<span style="color:var(--red);">Kamomad: ${Math.abs(diff)} ${unit} (-${formatPrice(sum)} so'm)</span>`;
 } else if (diff > 0) {
 badge.innerHTML = `<span style="color:var(--green);">Ortiqcha: +${diff} ${unit} (+${formatPrice(sum)} so'm)</span>`;
 } else {
 badge.innerHTML = `<span style="color:var(--text3);">Farq yo'q (To'liq mos)</span>`;
 }
}

function commitAuditActiveItem() {
 if (!APP.activeAuditProduct) return;
 const input = document.getElementById('auditActualInput');
 const actualVal = parseFloat(input?.value);
 if (isNaN(actualVal) || actualVal < 0) {
 showToast('Haqiqiy sanalgan miqdorni kiriting', 'warning');
 return;
 }
 const p = APP.activeAuditProduct;
 const sysStock = parseFloat(p.stock) || 0;
 const diff = Math.round((actualVal - sysStock) * 1000) / 1000;
 const cost = p.costPrice || p.price || 0;
 const lossAmount = diff < 0 ? Math.round(Math.abs(diff) * cost) : 0;
 const gainAmount = diff > 0 ? Math.round(diff * cost) : 0;

 if (!Array.isArray(APP.auditItems)) APP.auditItems = [];
 const existingIdx = APP.auditItems.findIndex(i => i.productId === p.id);
 const itemData = {
 productId: p.id,
 name: p.name,
 barcode: p.barcode || '',
 unit: p.unit || 'ta',
 systemStock: sysStock,
 actualStock: actualVal,
 diff,
 costPrice: cost,
 lossAmount,
 gainAmount
 };

 if (existingIdx >= 0) {
 APP.auditItems[existingIdx] = itemData;
 } else {
 APP.auditItems.unshift(itemData);
 }

 APP.activeAuditProduct = null;
 const box = document.getElementById('auditActiveProductBox');
 if (box) box.style.display = 'none';
 const barcodeInput = document.getElementById('auditBarcode');
 if (barcodeInput) { barcodeInput.value = ''; barcodeInput.focus(); }

 renderAuditList();
 showToast(`${p.name} sanoqqa kiritildi`);
}

function renderAuditList() {
 const container = document.getElementById('auditItemsList');
 const countEl = document.getElementById('auditCount');
 const lossEl = document.getElementById('auditTotalLoss');
 const gainEl = document.getElementById('auditTotalGain');

 const items = APP.auditItems || [];
 if (countEl) countEl.textContent = items.length;

 let totalLoss = 0;
 let totalGain = 0;
 items.forEach(i => {
 totalLoss += i.lossAmount || 0;
 totalGain += i.gainAmount || 0;
 });

 if (lossEl) lossEl.textContent = `-${formatPrice(totalLoss)}`;
 if (gainEl) gainEl.textContent = `+${formatPrice(totalGain)}`;

 if (!container) return;
 if (items.length === 0) {
 container.innerHTML = '<div style="font-size:0.8rem;color:var(--text3);text-align:center;padding:12px;">Hali hech qanday tovar sanalmadi. Shtrix-kod skanerlang.</div>';
 return;
 }

 container.innerHTML = items.map((i, idx) => `
 <div class="audit-item-card">
 <div style="flex:1;">
 <div style="font-weight:600;font-size:0.85rem;">${idx + 1}. ${escHtml(i.name)}</div>
 <div style="font-size:0.75rem;color:var(--text3);margin-top:2px;">
 Tizimda: <strong>${i.systemStock}</strong> | Fakt: <strong>${i.actualStock}</strong> ${escHtml(i.unit)}
 </div>
 </div>
 <div style="text-align:right;">
 <div style="font-weight:700;font-size:0.85rem;color:${i.diff < 0 ? 'var(--red)' : (i.diff > 0 ? 'var(--green)' : 'var(--text3)')};">
 ${i.diff > 0 ? '+' : ''}${i.diff} ${escHtml(i.unit)}
 </div>
 <div style="font-size:0.7rem;color:var(--text3);">
 ${i.diff < 0 ? `-${formatPrice(i.lossAmount)} so'm` : (i.diff > 0 ? `+${formatPrice(i.gainAmount)} so'm` : 'Mos')}
 </div>
 </div>
 <button type="button" class="item-remove" onclick="removeAuditItem('${i.productId}')" style="margin-left:6px;">${icon('x', 14)}</button>
 </div>
 `).join('');
}

function removeAuditItem(productId) {
 APP.auditItems = (APP.auditItems || []).filter(i => i.productId !== productId);
 renderAuditList();
}

function clearCurrentAudit() {
 if (!APP.auditItems || APP.auditItems.length === 0) return;
 if (!confirm('Sanoq ro\'yxatini tozalashni tasdiqlaysizmi?')) return;
 APP.auditItems = [];
 renderAuditList();
}

function scanForAudit() {
 closeModal('auditModal');
 showPage('scanner');
 APP._scanForAudit = true;
 showToast('Reviziya uchun shtrix-kodni kameraga ko\'rsating');
 updateScanHint('Reviziya uchun shtrix-kod skanerlang...', 'success');
}

async function applyAuditResults() {
 if (!APP.auditItems || APP.auditItems.length === 0) {
 showToast('Sanoq ro\'yxati bo\'sh!', 'warning');
 return;
 }
 const count = APP.auditItems.length;
 const doConfirm = typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm : (typeof confirm === 'function' ? confirm : () => true);
 if (!doConfirm(`Sanoq natijasida ${count} ta tovarning ombordagi qoldiqlari haqiqiy faktik sonlarga o'zgartiriladi. Tasdiqlaysizmi?`)) {
 return;
 }

 for (const item of APP.auditItems) {
 const prod = APP.products.find(p => p.id === item.productId);
 if (prod) {
 prod.stock = item.actualStock;
 prod.trackStock = true;
 prod.updatedAt = new Date().toISOString();
 await saveProductToDB(prod);
 }
 }

 await saveLocalData();
 renderProducts();
 updateProductStats();

 APP.auditItems = [];
 closeModal('auditModal');
 showToast(`Ombor sanog'i muvaffaqiyatli yakunlandi! ${count} ta tovar qoldig'i to'g'rilandi.`, 'success');
}

// ─────────────────────────────────────────────
// 1. EXPENSES MODULE (XARAJATLAR)
// ─────────────────────────────────────────────
async function saveExpense(expense) {
 if (!expense) return;
 if (!expense.id) expense.id = 'exp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
 if (!expense.date) expense.date = new Date().toISOString().slice(0, 10);
 if (!expense.createdAt) expense.createdAt = new Date().toISOString();

 APP.expenses = APP.expenses || [];
 const existingIdx = APP.expenses.findIndex(e => e.id === expense.id);
 if (existingIdx >= 0) {
  APP.expenses[existingIdx] = expense;
 } else {
  APP.expenses.unshift(expense);
 }

 await ScanDB.set('scanpos_expenses', APP.expenses);
 try {
  localStorage.setItem(nsKey('scanpos_expenses'), JSON.stringify(APP.expenses));
 } catch (e) {}
 cloudSet('expenses', expense.id, expense);

 if (APP.currentPage === 'analytics') renderAnalytics();
 return expense;
}

async function deleteExpense(id) {
 if (!id) return;
 APP.expenses = (APP.expenses || []).filter(e => e.id !== id);
 await ScanDB.set('scanpos_expenses', APP.expenses);
 try {
  localStorage.setItem(nsKey('scanpos_expenses'), JSON.stringify(APP.expenses));
 } catch (e) {}
 cloudDelete('expenses', id);
 renderExpensesList();
 if (APP.currentPage === 'analytics') renderAnalytics();
 showToast('Xarajat o\'chirildi');
}

function openExpensesModal() {
 const dateInput = document.getElementById('expenseDate');
 if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
 const amountInput = document.getElementById('expenseAmount');
 if (amountInput) amountInput.value = '';
 const titleInput = document.getElementById('expenseTitle');
 if (titleInput) titleInput.value = '';
 const noteInput = document.getElementById('expenseNote');
 if (noteInput) noteInput.value = '';
 renderExpensesList();
 openModal('expensesModal');
}

function renderExpensesList() {
 const container = document.getElementById('expensesList');
 if (!container) return;
 const list = APP.expenses || [];
 const total = list.reduce((s, e) => s + (Number(e.amount) || 0), 0);
 const sumEl = document.getElementById('expenseListSummary');
 if (sumEl) sumEl.textContent = `Jami: ${formatPrice(total)} so'm`;

 if (list.length === 0) {
  container.innerHTML = `
   <div class="empty-state" style="padding:16px;">
    <p>Hozircha xarajat kiritilmagan</p>
   </div>`;
  return;
 }

 container.innerHTML = list.map(e => `
  <div class="expense-item-row">
   <div style="flex:1;min-width:0;">
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
     <span class="expense-badge ${escHtml(e.category || 'boshqa')}">${escHtml(e.category || 'boshqa')}</span>
     <span style="font-weight:700;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(e.title || 'Xarajat')}</span>
    </div>
    <div style="font-size:0.75rem;color:var(--text3);">${escHtml(e.date || '')} ${e.note ? '• ' + escHtml(e.note) : ''}</div>
   </div>
   <div style="display:flex;align-items:center;gap:8px;">
    <span style="font-weight:800;font-size:0.9rem;color:#f59e0b;">${formatPrice(e.amount || 0)}</span>
    <button type="button" class="btn-del" onclick="deleteExpense('${e.id}')" title="O'chirish" style="background:transparent;border:none;color:var(--danger);cursor:pointer;padding:4px;">${icon('trash', 14)}</button>
   </div>
  </div>
 `).join('');
}

async function addExpenseFromModal() {
 const category = document.getElementById('expenseCategory')?.value || 'boshqa';
 const amount = parseFloat(document.getElementById('expenseAmount')?.value);
 const title = document.getElementById('expenseTitle')?.value.trim();
 const date = document.getElementById('expenseDate')?.value || new Date().toISOString().slice(0, 10);
 const note = document.getElementById('expenseNote')?.value.trim() || '';

 if (!title) {
  showToast('Xarajat nomini kiriting', 'warning');
  return;
 }
 if (!amount || amount <= 0) {
  showToast('Xarajat summasini to\'g\'ri kiriting', 'warning');
  return;
 }

 await saveExpense({
  title,
  category,
  amount: Math.round(amount),
  date,
  note
 });

 document.getElementById('expenseTitle').value = '';
 document.getElementById('expenseAmount').value = '';
 document.getElementById('expenseNote').value = '';
 renderExpensesList();
 showToast('Xarajat muvaffaqiyatli saqlandi!');
}

// ─────────────────────────────────────────────
// 2. PRICE HISTORY & BULK PRICE MODULE
// ─────────────────────────────────────────────
function renderProductPriceHistory(product) {
 const group = document.getElementById('productPriceHistoryGroup');
 const listEl = document.getElementById('productPriceHistoryList');
 const countEl = document.getElementById('priceHistoryCount');
 if (!group || !listEl) return;

 if (!product || !Array.isArray(product.priceHistory) || product.priceHistory.length === 0) {
  group.style.display = 'none';
  return;
 }

 group.style.display = 'block';
 if (countEl) countEl.textContent = `${product.priceHistory.length} ta`;

 listEl.innerHTML = product.priceHistory.map(h => {
  const d = h.date ? new Date(h.date).toLocaleDateString('uz', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '';
  const oldP = h.oldPrice !== null && h.oldPrice !== undefined ? formatPriceShort(h.oldPrice) : '-';
  const newP = formatPriceShort(h.newPrice);
  return `
   <div class="price-history-item">
    <span class="price-history-date">${d} (${escHtml(h.note || 'O\'zgarish')}):</span>
    <span class="price-history-diff">${oldP} -> ${newP} so'm</span>
   </div>`;
 }).join('');
}

function openBulkPriceModal() {
 updateBulkPricePreview();
 openModal('bulkPriceModal');
}

function setBulkPreset(val, type) {
 const valInput = document.getElementById('bulkPriceValue');
 const typeSelect = document.getElementById('bulkPriceType');
 if (valInput) valInput.value = val;
 if (typeSelect) typeSelect.value = type;
 updateBulkPricePreview();
}

function updateBulkPricePreview() {
 const cat = document.getElementById('bulkPriceCategory')?.value || 'all';
 const target = document.getElementById('bulkPriceTarget')?.value || 'price';
 const type = document.getElementById('bulkPriceType')?.value || 'percent';
 const val = parseFloat(document.getElementById('bulkPriceValue')?.value) || 0;
 const unitBadge = document.getElementById('bulkPriceUnitBadge');
 if (unitBadge) unitBadge.textContent = type === 'percent' ? '%' : 'so\'m';

 const prods = (APP.products || []).filter(p => cat === 'all' || p.category === cat);
 const countEl = document.getElementById('bulkPreviewCount');
 if (countEl) countEl.textContent = `${prods.length} ta tovar`;

 const exEl = document.getElementById('bulkPreviewExample');
 if (!exEl) return;

 if (prods.length === 0 || val === 0) {
  exEl.textContent = '-';
  return;
 }

 const sample = prods[0];
 const oldVal = target === 'costPrice' ? (sample.costPrice || sample.price) : sample.price;
 let newVal = oldVal;
 if (type === 'percent') {
  newVal = Math.round(oldVal * (1 + val / 100));
 } else {
  newVal = Math.round(oldVal + val);
 }
 newVal = Math.max(0, newVal);
 exEl.textContent = `${sample.name}: ${formatPriceShort(oldVal)} -> ${formatPriceShort(newVal)} so'm`;
}

async function applyBulkPriceUpdate() {
 const cat = document.getElementById('bulkPriceCategory')?.value || 'all';
 const target = document.getElementById('bulkPriceTarget')?.value || 'price';
 const type = document.getElementById('bulkPriceType')?.value || 'percent';
 const val = parseFloat(document.getElementById('bulkPriceValue')?.value) || 0;

 if (!val || val === 0) {
  showToast('O\'zgartirish qiymatini kiriting', 'warning');
  return;
 }

 const prods = (APP.products || []).filter(p => cat === 'all' || p.category === cat);
 if (prods.length === 0) {
  showToast('Mos keladigan tovarlar topilmadi', 'warning');
  return;
 }

 const doConfirm = typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm : (typeof confirm === 'function' ? confirm : () => true);
 const targetLabel = target === 'costPrice' ? 'tannarxi' : 'sotish narxi';
 const changeDesc = type === 'percent' ? `${val > 0 ? '+' : ''}${val}%` : `${val > 0 ? '+' : ''}${val} so'm`;
 if (!doConfirm(`${prods.length} ta mahsulotning ${targetLabel} ${changeDesc} ga o'zgartirilsinmi?`)) {
  return;
 }

 let updatedCount = 0;
 for (const p of prods) {
  p.priceHistory = Array.isArray(p.priceHistory) ? p.priceHistory : [];
  const oldPrice = p.price;
  const oldCost = p.costPrice || null;

  if (target === 'costPrice') {
   const curCost = p.costPrice || p.price;
   let newCost = type === 'percent' ? Math.round(curCost * (1 + val / 100)) : Math.round(curCost + val);
   newCost = Math.max(0, newCost);
   p.costPrice = newCost;
   p.priceHistory.unshift({
    date: new Date().toISOString(),
    oldPrice,
    newPrice: p.price,
    oldCostPrice: oldCost,
    newCostPrice: newCost,
    note: `Ommaviy tannarx (${changeDesc})`
   });
  } else {
   let newPrice = type === 'percent' ? Math.round(p.price * (1 + val / 100)) : Math.round(p.price + val);
   newPrice = Math.max(0, newPrice);
   p.price = newPrice;
   p.priceHistory.unshift({
    date: new Date().toISOString(),
    oldPrice,
    newPrice,
    oldCostPrice: oldCost,
    newCostPrice: p.costPrice || null,
    note: `Ommaviy narx (${changeDesc})`
   });
  }

  if (p.priceHistory.length > 30) p.priceHistory.pop();
  p.updatedAt = new Date().toISOString();
  await saveProductToDB(p);
  updatedCount++;
 }

 await saveLocalData();
 renderProducts();
 closeModal('bulkPriceModal');
 showToast(`${updatedCount} ta tovar narxi yangilandi!`, 'success');
}

// ─────────────────────────────────────────────
// 3. BARCODE GENERATION & LABEL PRINT MODULE
// ─────────────────────────────────────────────
function generateProductBarcode() {
 const seed = String(Date.now()).slice(-9) + String(Math.floor(Math.random() * 10));
 const raw12 = '20' + seed;
 let sum = 0;
 for (let i = 0; i < 12; i++) {
  const digit = parseInt(raw12[i], 10);
  sum += (i % 2 === 0) ? digit : digit * 3;
 }
 const checksum = (10 - (sum % 10)) % 10;
 return raw12 + checksum;
}

function generateAndSetBarcode() {
 const input = document.getElementById('productBarcode');
 if (input) {
  const code = generateProductBarcode();
  input.value = code;
  showToast(`Yangi shtrix-kod: ${code}`);
 }
}

function drawBarcodeToCanvas(canvas, code) {
 if (!canvas || !code) return;
 const ctx = canvas.getContext('2d');
 if (!ctx) return;

 const str = String(code).trim();
 const width = canvas.width;
 const height = canvas.height;

 ctx.fillStyle = '#ffffff';
 ctx.fillRect(0, 0, width, height);

 let hash = 0;
 for (let i = 0; i < str.length; i++) {
  hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
 }

 const quietZone = 12;
 const usableWidth = width - (quietZone * 2);
 const barCount = 65;
 const barWidth = usableWidth / barCount;

 ctx.fillStyle = '#000000';

 // Start guard
 ctx.fillRect(quietZone, 5, barWidth * 1.5, height - 10);
 ctx.fillRect(quietZone + barWidth * 2.5, 5, barWidth, height - 10);

 // Content bars
 let seed = hash ^ 0x5a5a5a5a;
 for (let b = 5; b < barCount - 5; b++) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  const isDark = (seed % 3) !== 0;
  if (isDark) {
   const x = quietZone + (b * barWidth);
   const w = (seed % 5 === 0) ? barWidth * 1.8 : barWidth;
   ctx.fillRect(x, 5, w, height - 10);
  }
 }

 // End guard
 ctx.fillRect(quietZone + (barCount - 4) * barWidth, 5, barWidth, height - 10);
 ctx.fillRect(quietZone + (barCount - 2) * barWidth, 5, barWidth * 1.5, height - 10);
}

function openPrintLabelModal(productId) {
 const p = APP.products.find(item => item.id === productId);
 if (!p) {
  showToast('Mahsulot topilmadi', 'warning');
  return;
 }

 const shopNameEl = document.getElementById('labelShopName');
 if (shopNameEl) shopNameEl.textContent = APP.settings?.shopName || 'ScanPOS Do\'koni';

 const nameEl = document.getElementById('labelProductName');
 if (nameEl) nameEl.textContent = p.name;

 const priceEl = document.getElementById('labelProductPrice');
 if (priceEl) priceEl.textContent = `${formatPrice(p.price)}`;

 const barcodeTextEl = document.getElementById('labelBarcodeText');
 if (barcodeTextEl) barcodeTextEl.textContent = p.barcode || '';

 const dateTextEl = document.getElementById('labelDateText');
 if (dateTextEl) {
  const todayStr = new Date().toLocaleDateString('uz', { day: '2-digit', month: '2-digit', year: 'numeric' });
  dateTextEl.textContent = `${todayStr}${p.expiryDate ? ' | Yaroqlilik: ' + p.expiryDate : ''}`;
 }

 const canvas = document.getElementById('barcodeCanvas');
 if (canvas) {
  drawBarcodeToCanvas(canvas, p.barcode || '200000000000');
 }

 openModal('printLabelModal');
}

function printCurrentModalProductLabel() {
 if (APP.editingProductId) {
  openPrintLabelModal(APP.editingProductId);
 }
}

function printBarcodeLabel() {
 if (typeof window !== 'undefined' && typeof window.print === 'function') {
  window.print();
 } else {
  showToast('Chop etish rejimi tayyorlandi');
 }
}

// ─────────────────────────────────────────────
// 4. I18N / MULTI-LANGUAGE MODULE (UZ / RU)
// ─────────────────────────────────────────────
const I18N = {
 uz: {
  nav_scanner: 'Skaner',
  nav_products: 'Mahsulotlar',
  nav_bills: 'Cheklar',
  nav_analytics: 'Hisobot',
  nav_nasiya: 'Nasiya',
  nav_settings: 'Sozlamalar',
  cart_title: 'Savat',
  cart_empty: 'Savat bo\'sh',
  cart_total: 'Jami:',
  btn_checkout: 'To\'lov',
  btn_clear: 'Tozalash',
  btn_hold: 'Kutish',
  btn_save: 'Saqlash',
  btn_cancel: 'Bekor qilish',
  btn_delete: 'O\'chirish',
  btn_edit: 'Tahrirlash',
  btn_add_product: 'Yangi tovar',
  btn_supply: 'Kirim',
  btn_audit: 'Reviziya',
  btn_import: 'Import',
  btn_bulk_price: 'Narxlar',
  btn_expenses: 'Xarajatlar',
  btn_print_label: 'Yorliq',
  btn_print: 'Chop etish',
  product_name: 'Mahsulot nomi',
  product_price: 'Sotish narxi',
  product_cost: 'Kelish narxi (tannarx)',
  product_stock: 'Ombordagi miqdor',
  product_expiry: 'Yaroqlilik muddati',
  toast_saved: 'Muvaffaqiyatli saqlandi',
 },
 ru: {
  nav_scanner: 'Сканер',
  nav_products: 'Товары',
  nav_bills: 'Чеки',
  nav_analytics: 'Отчёты',
  nav_nasiya: 'Долги',
  nav_settings: 'Настройки',
  cart_title: 'Корзина',
  cart_empty: 'Корзина пуста',
  cart_total: 'Итого:',
  btn_checkout: 'Оплата',
  btn_clear: 'Очистить',
  btn_hold: 'Отложить',
  btn_save: 'Сохранить',
  btn_cancel: 'Отмена',
  btn_delete: 'Удалить',
  btn_edit: 'Изменить',
  btn_add_product: 'Новый товар',
  btn_supply: 'Приход',
  btn_audit: 'Ревизия',
  btn_import: 'Импорт',
  btn_bulk_price: 'Цены',
  btn_expenses: 'Расходы',
  btn_print_label: 'Ценник',
  btn_print: 'Печать',
  product_name: 'Название товара',
  product_price: 'Цена продажи',
  product_cost: 'Себестоимость',
  product_stock: 'Остаток на складе',
  product_expiry: 'Срок годности',
  toast_saved: 'Успешно сохранено',
 }
};

function t(key, fallback = '') {
 const lang = APP.settings?.lang || 'uz';
 if (I18N[lang] && I18N[lang][key]) return I18N[lang][key];
 if (I18N.uz && I18N.uz[key]) return I18N.uz[key];
 return fallback || key;
}

function changeLanguage(lang) {
 if (lang !== 'uz' && lang !== 'ru') lang = 'uz';
 APP.settings = APP.settings || {};
 APP.settings.lang = lang;
 const sel = document.getElementById('settingsLangSelect');
 if (sel) sel.value = lang;
 applyLanguage();
 saveSettings();
 showToast(lang === 'ru' ? 'Язык изменён: Русский' : 'Til o\'zgartirildi: O\'zbekcha');
}

function toggleLanguage() {
 const cur = APP.settings?.lang || 'uz';
 const next = cur === 'ru' ? 'uz' : 'ru';
 changeLanguage(next);
}

function applyLanguage() {
 const lang = APP.settings?.lang || 'uz';

 const btnToggle = document.getElementById('langToggleBtn');
 if (btnToggle) btnToggle.textContent = lang === 'ru' ? 'RU' : 'UZ';

 const sel = document.getElementById('settingsLangSelect');
 if (sel) sel.value = lang;

 document.querySelectorAll('[data-i18n]').forEach(el => {
  const k = el.getAttribute('data-i18n');
  if (k && I18N[lang] && I18N[lang][k]) {
   el.textContent = I18N[lang][k];
  }
 });

 document.querySelectorAll('[data-i18n-ph]').forEach(el => {
  const k = el.getAttribute('data-i18n-ph');
  if (k && I18N[lang] && I18N[lang][k]) {
   el.placeholder = I18N[lang][k];
  }
 });
}

// Global oynaga yangi modullar funksiyalarini biriktirish
window.calcTotals = calcTotals;
window.openRefundModal = openRefundModal;
window.submitRefund = submitRefund;
window.openShiftCloseModal = openShiftCloseModal;
window.onShiftDateChange = onShiftDateChange;
window.calculateCashDiscrepancy = calculateCashDiscrepancy;
window.printShiftReport = printShiftReport;
window.toggleLowStockFilter = toggleLowStockFilter;
window.onCheckoutDebtorChange = onCheckoutDebtorChange;
window.ScanDB = ScanDB;
window.APP = APP;
window.saveDebtor = saveDebtor;
window.deleteDebtor = deleteDebtor;
window.recordDebt = recordDebt;
window.submitPayment = submitPayment;
window.saveDebtorToDB = saveDebtorToDB;
window.deleteDebtorFromDB = deleteDebtorFromDB;
window.saveDebtToDB = saveDebtToDB;
window.deleteDebtFromDB = deleteDebtFromDB;
window.listenFirestoreProducts = listenFirestoreProducts;
window.listenFirestoreBills = listenFirestoreBills;
window.listenFirestoreDebtors = listenFirestoreDebtors;
window.listenFirestoreDebts = listenFirestoreDebts;
window.renderDebtors = renderDebtors;
window.updateNasiyaStats = updateNasiyaStats;
window.updateScanHint = updateScanHint;
window.openSupplyModal = openSupplyModal;
window.onSupplySearch = onSupplySearch;
window.selectSupplyProductById = selectSupplyProductById;
window.selectSupplyProduct = selectSupplyProduct;
window.scanForSupply = scanForSupply;
window.submitSupply = submitSupply;
window.openImportCSVModal = openImportCSVModal;
window.downloadCSVTemplate = downloadCSVTemplate;
window.parseCSV = parseCSV;
window.handleCSVFileSelect = handleCSVFileSelect;
window.parseCSVFromText = parseCSVFromText;
window.executeCSVImport = executeCSVImport;
window.holdCurrentCart = holdCurrentCart;
window.openHeldCartsModal = openHeldCartsModal;
window.renderHeldCartsList = renderHeldCartsList;
window.restoreHeldCart = restoreHeldCart;
window.deleteHeldCart = deleteHeldCart;
window.clearAllHeldCarts = clearAllHeldCarts;
window.setCartQty = setCartQty;
window.openAuditModal = openAuditModal;
window.onAuditSearch = onAuditSearch;
window.selectAuditProductById = selectAuditProductById;
window.selectAuditProduct = selectAuditProduct;
window.calcAuditItemDiff = calcAuditItemDiff;
window.commitAuditActiveItem = commitAuditActiveItem;
window.renderAuditList = renderAuditList;
window.removeAuditItem = removeAuditItem;
window.clearCurrentAudit = clearCurrentAudit;
window.scanForAudit = scanForAudit;
window.applyAuditResults = applyAuditResults;

// Yangi 5 ta imkoniyat eksportlari
window.getExpiryStatus = getExpiryStatus;
window.getExpiringProducts = getExpiringProducts;
window.toggleExpiringFilter = toggleExpiringFilter;
window.saveExpense = saveExpense;
window.deleteExpense = deleteExpense;
window.openExpensesModal = openExpensesModal;
window.renderExpensesList = renderExpensesList;
window.addExpenseFromModal = addExpenseFromModal;
window.renderProductPriceHistory = renderProductPriceHistory;
window.openBulkPriceModal = openBulkPriceModal;
window.setBulkPreset = setBulkPreset;
window.updateBulkPricePreview = updateBulkPricePreview;
window.applyBulkPriceUpdate = applyBulkPriceUpdate;
window.generateProductBarcode = generateProductBarcode;
window.generateAndSetBarcode = generateAndSetBarcode;
window.drawBarcodeToCanvas = drawBarcodeToCanvas;
window.openPrintLabelModal = openPrintLabelModal;
window.printCurrentModalProductLabel = printCurrentModalProductLabel;
window.printBarcodeLabel = printBarcodeLabel;
window.I18N = I18N;
window.t = t;
window.changeLanguage = changeLanguage;
window.toggleLanguage = toggleLanguage;
window.applyLanguage = applyLanguage;

// Auth / multi-tenant eksportlari
window.renderUserMenu = renderUserMenu;
window.renderSettingsProfile = renderSettingsProfile;
window.toggleUserMenu = toggleUserMenu;
window.openProfileSettings = openProfileSettings;
window.openProfileModal = openProfileModal;
window.triggerProfileAvatar = triggerProfileAvatar;
window.removeProfileAvatar = removeProfileAvatar;
window.handleProfileAvatarFile = handleProfileAvatarFile;
window.saveProfile = saveProfile;
window.handleChangePassword = handleChangePassword;
window.openPaywall = openPaywall;
window.choosePlan = choosePlan;
window.submitPaymentRequest = submitPaymentRequest;
window.renderSubscriptionUI = renderSubscriptionUI;
window.getAccessState = getAccessState;
window.canAddProduct = canAddProduct;
window.isAdminUser = isAdminUser;
window.PLANS = PLANS;
window.saveUserMeta = saveUserMeta;
window.loadUserMeta = loadUserMeta;
window.loadUserCollections = loadUserCollections;
window.ensureUserProfile = ensureUserProfile;
window.userCol = userCol;
window.userDoc = userDoc;
window.cloudSet = cloudSet;
window.cloudDelete = cloudDelete;
window.nsKey = nsKey;
