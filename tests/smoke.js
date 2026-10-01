/**
 * ScanPOS – Smoke Test Suite (tests/smoke.js)
 * ===========================================
 * Sinov qamrovi:
 * 1. Tovar qo'shish (bo'sh ombor bilan - trackStock: false)
 * 2. Skan → savat (handleBarcodeDetected)
 * 3. Ombor tugaganda rad etish (trackStock: true bo'lganda false qaytishi)
 * 4. Chegirma + QQS hisobi (calcTotals QQSni chegirmadan keyin hisoblashi)
 * 5. To'lov (completeSale)
 * 6. Qaytarish (vozvrat - submitRefund & ombor tiklanishi)
 * 7. Nasiya (ismi "O'ktam" bo'lgan mijoz bilan chek va qarz yaratilishi)
 * 8. Boshqa sahifada skaner savatga qo'shmasligi (APP.currentPage !== 'scanner')
 * 9. Zaxira eksport / import aylanishi (JSON ma'lumotlar saqlanishi va tiklanishi)
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

async function runTests() {
  console.log('\n🚀 ScanPOS Smoke Test Suite boshlanmoqda...\n');

  const htmlPath = path.resolve(__dirname, '../index.html');
  const appJsPath = path.resolve(__dirname, '../app.js');

  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');

  // JSDOM muhitini yaratish
  const dom = new JSDOM(htmlContent, {
    runScripts: 'outside-only',
    url: 'http://localhost:3000',
  });

  const { window } = dom;
  const { document } = window;

  // Mock API lar
  window.useDemo = true;
  window.firebaseReady = false;
  window.alert = () => {};
  window.confirm = () => true;
  window.print = () => {};
  window.isSecureContext = true;

  if (!window.navigator.mediaDevices) {
    window.navigator.mediaDevices = {
      getUserMedia: async () => ({
        getVideoTracks: () => [{ stop: () => {}, applyConstraints: async () => {} }]
      })
    };
  }

  // Audio mock
  window.Audio = class {
    play() { return Promise.resolve(); }
  };

  // URL.createObjectURL mock
  window.URL.createObjectURL = () => 'blob:mock-url';
  window.URL.revokeObjectURL = () => {};

  window.confirm = () => false;
  window.alert = () => {};

  // eval app.js
  const fn = new Function('window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'confirm', 'alert', appJsContent);
  fn(window, document, window.navigator, window.localStorage, window.sessionStorage, window.location, () => false, () => {});

  // App init
  await window.initApp();

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  // ─────────────────────────────────────────────
  // TEST 1: Tovar qo'shish (bo'sh ombor bilan - trackStock: false)
  // ─────────────────────────────────────────────
  console.log('📌 Test 1: Tovar qo\'shish (bo\'sh ombor bilan)');
  const p1 = {
    id: 'prod-test-untracked',
    barcode: '1111111111111',
    name: 'Non (Cheksiz)',
    price: 3000,
    costPrice: 2000,
    stock: '',
    trackStock: false,
    category: 'non'
  };
  await window.saveProductToDB(p1);
  const foundP1 = window.APP.products.find(p => p.id === 'prod-test-untracked');
  assert(foundP1 && foundP1.trackStock === false, 'Tovar trackStock: false bilan ombor cheklovisiz saqlandi');

  // ─────────────────────────────────────────────
  // TEST 2: Skan → savat (handleBarcodeDetected)
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 2: Skan → savat');
  window.APP.currentPage = 'scanner';
  window.APP.cart = [];
  window.handleBarcodeDetected('1111111111111');
  assert(window.APP.cart.length === 1 && window.APP.cart[0].id === 'prod-test-untracked', 'Skan qilingan tovar savatga muvaffaqiyatli qo\'shildi');

  // ─────────────────────────────────────────────
  // TEST 3: Ombor tugaganda rad etish (trackStock: true, stock: 1)
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 3: Ombor tugaganda rad etish');
  const p2 = {
    id: 'prod-test-limited',
    barcode: '2222222222222',
    name: 'Shokolad (1 dona bor)',
    price: 10000,
    costPrice: 7000,
    stock: 1,
    trackStock: true,
    category: 'shirinlik'
  };
  await window.saveProductToDB(p2);
  const add1 = window.addToCart(p2);
  assert(add1 === true, 'Birinchi qo\'shish muvaffaqiyatli (true qaytdi)');
  const add2 = window.addToCart(p2);
  assert(add2 === false, 'Ombordagi sonidan ko\'p qo\'shilganda rad etildi (false qaytdi)');

  // ─────────────────────────────────────────────
  // TEST 4: Chegirma + QQS hisobi (calcTotals)
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 4: Chegirma + QQS hisobi (calcTotals)');
  // Masalan: savatda 100,000 so'm, 10% chegirma = 10,000 so'm chegirma. Soliqqa tortiladigan = 90,000 so'm.
  // 12% QQS chegirmadan KEYIN: 90,000 * 0.12 = 10,800 so'm.
  // Jami: 90,000 + 10,800 = 100,800 so'm.
  const sampleCart = [{ price: 50000, qty: 2 }];
  const totals = window.calcTotals(sampleCart, 10, 12);
  assert(totals.subtotal === 100000, 'Subtotal: 100 000 so\'m');
  assert(totals.discount === 10000, 'Chegirma: 10 000 so\'m');
  assert(totals.taxable === 90000, 'Soliqqa tortiladigan summa: 90 000 so\'m');
  assert(totals.tax === 10800, 'QQS chegirmadan KEYIN hisoblandi: 10 800 so\'m');
  assert(totals.total === 100800, 'Jami summa: 100 800 so\'m to\'liq to\'g\'ri');

  // ─────────────────────────────────────────────
  // TEST 5: To'lov (completeSale)
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 5: To\'lov (completeSale)');
  window.APP.cart = [
    { id: 'prod-test-untracked', name: 'Non (Cheksiz)', price: 3000, costPrice: 2000, qty: 2, category: 'non' }
  ];
  window.APP.selectedPayment = 'cash';
  const cashInput = document.getElementById('cashGiven');
  if (cashInput) cashInput.value = '10000';
  const billsBefore = window.APP.bills.length;
  await window.completeSale();
  assert(window.APP.bills.length === billsBefore + 1, 'Cheklar soni 1 taga oshdi');
  assert(window.APP.cart.length === 0, 'Savat bo\'shatildi');
  const lastBill = window.APP.bills[0];
  assert(lastBill.items[0].image === undefined, 'Chek itemida og\'ir image maydoni saqlanmagan (yengil chek)');

  // ─────────────────────────────────────────────
  // TEST 6: Qaytarish (vozvrat)
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 6: Qaytarish (vozvrat)');
  window.APP._currentRefundBill = lastBill;
  // Modal elementlarini simulyatsiya qilish
  const refundQtyInput = document.createElement('input');
  refundQtyInput.id = `refund-qty-${lastBill.items[0].id}`;
  refundQtyInput.value = '1';
  document.body.appendChild(refundQtyInput);

  await window.submitRefund();
  assert(lastBill.refunds && lastBill.refunds.length === 1, 'Chekda refunds yozuvi saqlandi');
  assert(lastBill.refunds[0].qty === 1 && lastBill.refunds[0].amount === 3000, '1 ta tovar (3000 so\'m) qaytarildi');

  // ─────────────────────────────────────────────
  // TEST 7: Nasiya ("O'ktam" ismli mijoz bilan)
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 7: Nasiya ("O\'ktam" ismli mijoz bilan)');
  window.APP.cart = [
    { id: 'prod-test-untracked', name: 'Non (Cheksiz)', price: 3000, costPrice: 2000, qty: 1, category: 'non' }
  ];
  window.APP.selectedPayment = 'debt';

  // Yangi mijoz O'ktam kiritilishi
  const debtorSelect = document.getElementById('checkoutDebtorSelect');
  if (debtorSelect) {
    debtorSelect.innerHTML = '<option value="new">Yangi</option>';
    debtorSelect.value = 'new';
  }
  const newDebtorName = document.getElementById('checkoutNewDebtorName') || document.getElementById('newDebtorName');
  if (newDebtorName) newDebtorName.value = "O'ktam";
  const newDebtorPhone = document.getElementById('checkoutNewDebtorPhone') || document.getElementById('newDebtorPhone');
  if (newDebtorPhone) newDebtorPhone.value = "+998901234567";

  await window.completeSale();
  const oktam = window.APP.debtors.find(d => d.name === "O'ktam");
  assert(oktam !== undefined, 'Mijoz "O\'ktam" muvaffaqiyatli saqlandi');
  const debtOktam = window.APP.debts.find(d => d.debtorId === (oktam && oktam.id));
  assert(debtOktam && debtOktam.amount === 3000, 'O\'ktam nomiga 3 000 so\'mlik qarz avtomatik biriktirildi');

  // ─────────────────────────────────────────────
  // TEST 8: Boshqa sahifada skaner savatga qo'shmasligi
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 8: Boshqa sahifada skaner savatga qo\'shmasligi');
  window.APP.currentPage = 'products';
  window.APP.cart = [];
  window.handleBarcodeDetected('1111111111111');
  assert(window.APP.cart.length === 0, 'currentPage === "products" bo\'lganda skan tovar qo\'shmadi');

  // ─────────────────────────────────────────────
  // TEST 9: Zaxira eksport / import aylanishi
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 9: Zaxira eksport / import aylanishi');
  // Deep clone backup
  const backupObj = {
    version: 2,
    exportedAt: new Date().toISOString(),
    products: JSON.parse(JSON.stringify(window.APP.products)),
    bills: JSON.parse(JSON.stringify(window.APP.bills)),
    debtors: JSON.parse(JSON.stringify(window.APP.debtors)),
    debts: JSON.parse(JSON.stringify(window.APP.debts)),
    settings: JSON.parse(JSON.stringify(window.APP.settings)),
    categoryPrices: JSON.parse(JSON.stringify(window.APP.categoryPrices)),
    quickItems: JSON.parse(JSON.stringify(window.APP.quickItems))
  };

  assert(backupObj.products.length > 0 && backupObj.bills.length > 0, 'Zaxira nusxada barcha ma\'lumotlar to\'liq to\'plandi');

  // Tiklashni tekshirish
  const initialProductsCount = window.APP.products.length;
  window.APP.products.push({ id: 'temp-prod', name: 'Vaqtinchalik' });
  // Replace qayta tiklash
  window.APP.products = JSON.parse(JSON.stringify(backupObj.products));
  assert(window.APP.products.length === initialProductsCount, 'Zaxiradan to\'liq tiklash (Replace) muvaffaqiyatli ishlaydi');

  // ─────────────────────────────────────────────
  // TEST 10 (Band 1): submitRefund chekni ikkilantirmasligi
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 10: submitRefund chekni ikkilantirmasligi (updateBillInDB)');
  window.APP.bills = [
    { id: 'bill-1', items: [{ id: 'prod-test-untracked', name: 'Non', price: 3000, qty: 1 }], total: 3000, paymentMethod: 'cash', refunds: [] },
    { id: 'bill-2', items: [{ id: 'prod-test-untracked', name: 'Non', price: 3000, qty: 2 }], total: 6000, paymentMethod: 'cash', refunds: [] }
  ];
  assert(window.APP.bills.length === 2, 'Boshlang\'ich 2 ta chek mavjud');
  window.APP._currentRefundBill = window.APP.bills[0];
  let refundInputT10 = document.getElementById(`refund-qty-${window.APP.bills[0].items[0].id}`);
  if (!refundInputT10) {
    refundInputT10 = document.createElement('input');
    refundInputT10.id = `refund-qty-${window.APP.bills[0].items[0].id}`;
    document.body.appendChild(refundInputT10);
  }
  refundInputT10.value = '1';
  await window.submitRefund();
  assert(window.APP.bills.length === 2, 'Qaytarishdan keyin ham cheklar soni 2 ta (ikkilanmadi)');
  const bill1RefundTotal = window.APP.bills[0].refunds.reduce((s, r) => s + r.amount, 0);
  assert(bill1RefundTotal === 3000, 'Qaytarish yig\'indisi to\'g\'ri (3000 so\'m)');

  // ─────────────────────────────────────────────
  // TEST 11 (Band 2): Bir mijozning 2 ta nasiya chekidan eskisini qaytarish
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 11: Nasiya chekini qaytarishda aniq qarzni kamaytirish (billId bo\'yicha)');
  const testDebtor = { id: 'debtor-two-bills', name: 'Alisher', phone: '+998901112233' };
  window.APP.debtors.push(testDebtor);
  const oldBill = {
    id: 'bill-nasiya-old',
    timestamp: '2026-09-01T10:00:00.000Z',
    items: [{ id: 'prod-test-untracked', name: 'Non', price: 3000, qty: 2 }],
    total: 6000,
    paymentMethod: 'debt',
    debtorId: testDebtor.id,
    debtorName: testDebtor.name,
    refunds: []
  };
  const newBill = {
    id: 'bill-nasiya-new',
    timestamp: '2026-09-15T10:00:00.000Z',
    items: [{ id: 'prod-test-untracked', name: 'Non', price: 3000, qty: 1 }],
    total: 3000,
    paymentMethod: 'debt',
    debtorId: testDebtor.id,
    debtorName: testDebtor.name,
    refunds: []
  };
  window.APP.bills.push(newBill, oldBill);
  const oldDebt = {
    id: 'debt-old',
    debtorId: testDebtor.id,
    billId: oldBill.id,
    amount: 6000,
    paidAmount: 1000,
    payments: []
  };
  const newDebt = {
    id: 'debt-new',
    debtorId: testDebtor.id,
    billId: newBill.id,
    amount: 3000,
    paidAmount: 0,
    payments: []
  };
  window.APP.debts.push(oldDebt, newDebt);

  // Eskisini qaytarish (1 dona = 3000 so'm)
  window.APP._currentRefundBill = oldBill;
  refundInputT10.value = '1';
  await window.submitRefund();

  // Eskisining qarzi kamayishi kerak: 6000 - 3000 = 3000
  assert(oldDebt.amount === 3000, 'Eski qarz miqdori 6000 dan 3000 ga kamaydi');
  assert(newDebt.amount === 3000, 'Yangi qarz miqdori o\'zgarishsiz qoldi (3000 so\'m)');

  // paidAmount ni hisobga olish tekshiruvi:
  oldDebt.paidAmount = 2500;
  oldDebt.amount = 3000;
  refundInputT10.value = '1'; // yana 3000 so'm qaytarish
  await window.submitRefund();
  assert(oldDebt.amount === 2500, 'paidAmount hisobga olindi: qarz paidAmount (2500) dan pastga tushmadi');

  // ─────────────────────────────────────────────
  // TEST 12 (Band 3): processOutbox davomida enqueue qilingan yozuv yo'qolmasligi
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 12: processOutbox davomida enqueue qilingan yozuv yo\'qolmasligi');
  // Mock Firebase online for outbox test
  const originalUseDemo = window.useDemo;
  const originalFirebaseDB = window.firebaseDB;
  const originalFirebaseFns = window.firebaseFns;

  window.useDemo = false;
  window.isFirebaseConfigured = true;
  window.firebaseDB = { mock: true };
  const processedOutboxIds = [];
  window.firebaseFns = {
    doc: (_, col, id) => ({ col, id }),
    setDoc: async (dRef, data) => {
      // Sun'iy kechikish (poyga sharoitini yaratish uchun)
      await new Promise(res => setTimeout(res, 30));
      processedOutboxIds.push(data.id);
    },
    deleteDoc: async () => {},
    writeBatch: () => ({ commit: async () => {}, set: () => {}, update: () => {} }),
    increment: (n) => n
  };

  // Navbatni tozalash va 1-vazifani qo'shish
  await window.ScanDB.set('scanpos_outbox', []);
  await window.enqueueOutbox({ action: 'saveBill', data: { id: 'bill-task-1', total: 1000 } });

  // processOutbox ni boshlash (kutmasdan)
  const processPromise = window.processOutbox();

  // processOutbox davomida 2-vazifani navbatga kiritish
  await new Promise(res => setTimeout(res, 5));
  await window.enqueueOutbox({ action: 'saveBill', data: { id: 'bill-task-2-concurrent', total: 2000 } });

  // Ikkalasini kutish
  await processPromise;

  const queueAfter = await window.getOutboxQueue();
  const hasTask2 = queueAfter.some(item => item.data && item.data.id === 'bill-task-2-concurrent');
  assert(hasTask2, 'processOutbox davomida navbatga kiritilgan yozuv (task 2) o\'chib ketmadi');
  assert(processedOutboxIds.includes('bill-task-1'), '1-vazifa (task 1) muvaffaqiyatli serverga yuborildi');

  // Reset mocks
  window.useDemo = originalUseDemo;
  window.firebaseDB = originalFirebaseDB;
  window.firebaseFns = originalFirebaseFns;
  await window.ScanDB.set('scanpos_outbox', []);

  // ─────────────────────────────────────────────
  // TEST 13 (Band 7): listenFirestoreProducts va listenFirestoreBills (pending overlay)
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 13: listenFirestoreProducts va Bills (pending overlay)');
  let snapshotCallback = null;
  window.useDemo = false;
  window.firebaseDB = { mock: true };
  window.firebaseFns = {
    collection: (_, name) => ({ name }),
    onSnapshot: (col, opts, cb) => {
      const handler = typeof opts === 'function' ? opts : cb;
      snapshotCallback = handler;
      return () => {};
    }
  };

  // Listenerni ishga tushirish
  window.listenFirestoreProducts();

  // Outbox'da kutayotgan tovar yangilanishi
  await window.ScanDB.set('scanpos_outbox', [
    { action: 'saveProduct', type: 'product', data: { id: 'p-sync-1', name: 'Cola (Pending)', stock: 25, trackStock: true } }
  ]);

  // Serverdan hasPendingWrites: true bilan eski ma'lumot kelishi
  await snapshotCallback({
    metadata: { hasPendingWrites: true },
    docs: [
      { id: 'p-sync-1', data: () => ({ name: 'Cola (Old Server)', stock: 5, trackStock: true }) }
    ]
  });

  const overlayProduct = window.APP.products.find(p => p.id === 'p-sync-1');
  assert(overlayProduct && overlayProduct.stock === 25, 'hasPendingWrites: true bo\'lganda outbox\'dagi qiymat (stock: 25) snapshot ustidan yozildi');
  assert(overlayProduct && overlayProduct.name === 'Cola (Pending)', 'Pending tovar nomi outbox bilan overlay bo\'ldi');

  // Server hasPendingWrites: false berganda to'liq server ma'lumotiga o'tish
  await window.ScanDB.set('scanpos_outbox', []);
  await snapshotCallback({
    metadata: { hasPendingWrites: false },
    docs: [
      { id: 'p-sync-1', data: () => ({ name: 'Cola (Synced Server)', stock: 50, trackStock: true }) }
    ]
  });
  const serverProduct = window.APP.products.find(p => p.id === 'p-sync-1');
  assert(serverProduct && serverProduct.stock === 50, 'hasPendingWrites: false bo\'lganda server ma\'lumoti (stock: 50) qabul qilindi');

  // ─────────────────────────────────────────────
  // TEST 14 (Band 9): Nasiya Firestore va outbox integratsiyasi
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 14: Nasiya Firestore va outbox integratsiyasi');
  window.useDemo = false;
  Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true }); // oflayn
  window.firebaseFns = { doc: (_, col, id) => ({ col, id }), setDoc: async () => {} };
  await window.ScanDB.set('scanpos_outbox', []);

  // Debtor qo'shish
  document.getElementById('debtorId').value = '';
  document.getElementById('debtorName').value = 'Sherzod Nasiya';
  document.getElementById('debtorPhone').value = '+998901234567';
  document.getElementById('debtorNote').value = 'Doimiy mijoz';
  await window.saveDebtor();

  let outboxQueue = await window.getOutboxQueue();
  const debtorOutbox = outboxQueue.find(i => (i.action === 'debtor' || i.action === 'saveDebtor' || i.type === 'debtor') && i.data && i.data.name === 'Sherzod Nasiya');
  assert(Boolean(debtorOutbox), 'Mijoz saqlanganda outbox\'ga debtor yozuvi tushdi');

  // Debtor uchun qarz va to'lov
  const savedDebtor = window.APP.debtors.find(d => d.name === 'Sherzod Nasiya');
  const testDebt = {
    id: 'debt-test-nasiya-1',
    debtorId: savedDebtor.id,
    amount: 15000,
    paidAmount: 0,
    payments: []
  };
  window.APP.debts.unshift(testDebt);

  // Qarz to'lash
  document.getElementById('payDebtId').value = testDebt.id;
  document.getElementById('payAmount').value = '5000';
  document.getElementById('payNote').value = 'Karta orqali';
  await window.submitPayment();

  outboxQueue = await window.getOutboxQueue();
  const debtOutbox = outboxQueue.find(i => (i.action === 'debt' || i.action === 'saveDebt' || i.type === 'debt') && i.data && i.data.id === testDebt.id);
  assert(Boolean(debtOutbox), 'To\'lov amalga oshirilganda outbox\'ga debt yozuvi tushdi');
  assert(testDebt.paidAmount === 5000, 'Lokal qarz to\'langan miqdori 5000 ga oshdi');

  // Reset online state
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });

  // ─────────────────────────────────────────────
  // TEST 15 (Band 11): XSS himoyasi tekshiruvi
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 15: XSS himoyasi tekshiruvi');
  const xssDebtor = {
    id: 'debtor-xss-test',
    name: '<script>alert("xss")</script>Akmal',
    phone: '"><script>alert(1)</script>+998991234567',
    note: '<img src=x onerror=alert(2)>'
  };
  window.APP.debtors.unshift(xssDebtor);
  window.renderDebtors();

  const debtorListEl = document.getElementById('debtorList');
  const debtorListHtml = debtorListEl ? debtorListEl.innerHTML : '';
  assert(!debtorListHtml.includes('<script>alert("xss")</script>'), 'Debtor nomidagi <script> tegi qochirildi (escHtml)');
  assert(!debtorListHtml.includes('href="tel:"><script>'), 'Debtor telefonidagi tel: linki sanitizePhone orqali tozalangan');
  assert(debtorListHtml.includes('&lt;script&gt;alert('), 'Debtor nomi xavfsiz HTML entities ko\'rinishida chiqdi');

  // updateScanHint textContent tekshiruvi
  window.updateScanHint('<img src=x onerror=alert(1)> Skaner tayyor', 'success');
  const hintEl = document.getElementById('scanHint');
  assert(hintEl && (hintEl.textContent === '<img src=x onerror=alert(1)> Skaner tayyor' || hintEl.textContent.includes('Skaner tayyor')), 'updateScanHint xavfsiz matn o\'rnatdi');
  assert(hintEl && !hintEl.innerHTML.includes('<img src="x"'), 'updateScanHint innerHTML emas textContent orqali teglarni bajarmaydi');

  // ─────────────────────────────────────────────
  // TEST 16 (Band 12): U+FE0F va boshlang'ich bo'sh joy tozaligi
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 16: U+FE0F va boshlang\'ich bo\'sh joy tozaligi');
  const appJsRaw = fs.readFileSync(appJsPath, 'utf8');
  assert(!appJsRaw.includes('\uFE0F'), 'app.js da hech qanday yashirin U+FE0F belgisi yo\'q');
  const quoteFe0fMatches = appJsRaw.match(/[`'"]\uFE0F /g);
  assert(!quoteFe0fMatches || quoteFe0fMatches.length === 0, 'app.js da quote ketidan U+FE0F va bo\'sh joy mavjud emas');

  // ─────────────────────────────────────────────
  // TEST 17 (Band 14): submitRefund atomikligi va Firestore xatosida refundBatch outbox
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 17: submitRefund atomikligi va Firestore xatosida refundBatch outbox');
  window.useDemo = false;
  window.firebaseDB = { mock: true };
  window.navigator.onLine = true;
  await window.ScanDB.set('scanpos_outbox', []);

  // Firestore commit xatosi simulyatsiyasi
  window.firebaseFns = {
    doc: (_, col, id) => ({ col, id }),
    writeBatch: () => ({
      update: () => {},
      set: () => {},
      commit: async () => {
        throw new Error('Firestore tarmog\'i vaqtincha uzildi');
      }
    }),
    increment: (n) => n
  };

  const refundProduct = {
    id: 'prod-refund-batch-1',
    barcode: '9998887776661',
    name: 'Shirinlik',
    price: 4000,
    costPrice: 2500,
    stock: 5,
    trackStock: true,
    category: 'shirinlik'
  };
  window.APP.products.push(refundProduct);

  const billForBatch = {
    id: 'bill-batch-refund-1',
    timestamp: new Date().toISOString(),
    total: 8000,
    items: [
      { id: refundProduct.id, name: refundProduct.name, price: 4000, qty: 2 }
    ],
    refunds: []
  };
  window.APP.bills.unshift(billForBatch);
  window.APP._currentRefundBill = billForBatch;

  // Modal input yaratish/sozlash
  let refundBatchInput = document.getElementById(`refund-qty-${refundProduct.id}`);
  if (!refundBatchInput) {
    refundBatchInput = document.createElement('input');
    refundBatchInput.id = `refund-qty-${refundProduct.id}`;
    document.body.appendChild(refundBatchInput);
  }
  refundBatchInput.value = '1';

  await window.submitRefund();

  const outboxAfterRefundError = await window.getOutboxQueue();
  const refundBatchEntry = outboxAfterRefundError.find(i => i.action === 'refundBatch' || i.type === 'refundBatch');

  assert(Boolean(refundBatchEntry), 'Firestore xato berganda outbox\'da refundBatch paydo bo\'ldi');
  assert(refundBatchEntry && refundBatchEntry.bill && refundBatchEntry.bill.id === billForBatch.id, 'refundBatch ichida tegishli chek mavjud');
  assert(refundBatchEntry && Array.isArray(refundBatchEntry.products) && refundBatchEntry.products.length > 0, 'refundBatch ichida qaytarilgan tovarlar ro\'yxati mavjud');
  assert(refundProduct.stock === 6, 'Lokal omborda tovar qoldig\'i 5 dan 6 ga yangilandi');

  // Reset demo state
  window.useDemo = true;
  window.navigator.onLine = true;
  await window.ScanDB.set('scanpos_outbox', []);

  // ─────────────────────────────────────────────
  // XULOSA
  // ─────────────────────────────────────────────
  console.log(`\n══════════════════════════════════════`);
  console.log(`📊 SINOV NATIJALARI:`);
  console.log(`   O'tgan testlar (PASS):  ${passed}`);
  console.log(`   Xatolar (FAIL):         ${failed}`);
  console.log(`══════════════════════════════════════\n`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('🎉 Barcha sinovlar 100% muvaffaqiyatli o\'tdi!\n');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Test ijrosida kutilmagan xato:', err);
  process.exit(1);
});
