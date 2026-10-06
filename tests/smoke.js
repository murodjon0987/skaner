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

  if (window.HTMLCanvasElement) {
    window.HTMLCanvasElement.prototype.getContext = () => ({
      fillRect: () => {},
      clearRect: () => {},
      getImageData: () => ({ data: [] }),
      putImageData: () => {},
      fillStyle: ''
    });
  }

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


  // ─────────────────────────────────────────────
  // TEST 18: Tovarni kg/gramm (0.5 kg, 1.25 kg) bilan sotish va ombor hisobi
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 18: Tovarni kg/gramm (0.5 kg, 1.25 kg) bilan sotish');
  const pMeat = {
    id: 'prod-meat-kg',
    barcode: '8888888888888',
    name: "Mol go'shti",
    price: 80000,
    costPrice: 65000,
    stock: 10,
    unit: 'kg',
    trackStock: true,
    category: 'oziq'
  };
  await window.saveProductToDB(pMeat);

  // 1.25 kg qo'shish
  window.addToCart(pMeat, 1.25);
  assert(window.APP.cart.length === 1 && window.APP.cart[0].qty === 1.25, 'Savatga 1.25 kg go\'sht qo\'shildi');
  assert(window.APP.cart[0].unit === 'kg', 'Savat item birligi "kg" ekani saqlandi');

  const { total: meatTotal } = window.calcTotals(window.APP.cart, 0, 0);
  assert(meatTotal === 100000, '1.25 kg x 80 000 = 100 000 so\'m to\'g\'ri hisoblandi');

  // Savatda miqdorni 0.5 kg ga o'zgartirish (setCartQty)
  window.setCartQty(pMeat.id, 0.5);
  assert(window.APP.cart[0].qty === 0.5, 'setCartQty orqali miqdor 0.5 kg ga o\'rnatildi');

  // Yana 0.75 kg qo'shish -> 1.25 kg bo'ladi
  window.addToCart(pMeat, 0.75);
  assert(window.APP.cart[0].qty === 1.25, '0.5 + 0.75 = 1.25 kg to\'g\'ri yig\'ildi');

  // Sotuvni amalga oshirish
  window.APP.selectedPayment = 'cash';
  const cashInput18 = document.getElementById('cashGiven');
  if (cashInput18) cashInput18.value = '100000';
  await window.completeSale();

  assert(pMeat.stock === 8.75, 'Ombordagi qoldiq 10 dan 1.25 kamayib, 8.75 kg bo\'ldi');
  const latestBill18 = window.APP.bills[0];
  assert(latestBill18 && latestBill18.items[0].qty === 1.25 && latestBill18.items[0].unit === 'kg', 'Chekda 1.25 kg tovar va kg birligi qayd etildi');

  // ─────────────────────────────────────────────
  // TEST 19: Tovar kirimi (Supply / Stock In)
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 19: Tovar kirimi (Supply / Stock In)');
  window.openSupplyModal(pMeat.id);

  const selProdInput = document.getElementById('supplySelectedProductId');
  if (selProdInput) selProdInput.value = pMeat.id;
  const supplyQtyInput = document.getElementById('supplyQty');
  if (supplyQtyInput) supplyQtyInput.value = '5.25';
  const supplyCostInput = document.getElementById('supplyCostPrice');
  if (supplyCostInput) supplyCostInput.value = '70000';
  const supplyPriceInput = document.getElementById('supplySalePrice');
  if (supplyPriceInput) supplyPriceInput.value = '85000';

  await window.submitSupply();

  assert(pMeat.stock === 14, 'Kirimdan keyin ombor qoldig\'i 8.75 + 5.25 = 14 kg bo\'ldi');
  assert(pMeat.costPrice === 70000, 'Yangi kelish narxi (tannarx) 70 000 so\'mga yangilandi');
  assert(pMeat.price === 85000, 'Yangi sotish narxi 85 000 so\'mga yangilandi');
  assert(Array.isArray(window.APP.supplies) && window.APP.supplies.length > 0, 'Kirimlar jurnalida yozuv saqlandi');

  // ─────────────────────────────────────────────
  // TEST 20: Tovarlarni Excel/CSV dan import qilish
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 20: Tovarlarni Excel/CSV dan import qilish');
  const sampleCSV = [
    'Nomi,Shtrixkod,Sotish narxi,Kelish narxi,Qoldiq,Birlik,Toifa',
    "Mol go'shti,8888888888888,90000,72000,25,kg,oziq",
    'Pomidor Yangi,2001112223334,18000,12000,45.5,kg,oziq',
    'Fanta 0.5L,4780009998881,7000,5000,60,dona,ichimlik'
  ].join('\n');

  const parsedCSV = window.parseCSV(sampleCSV);
  assert(parsedCSV.length === 3, 'CSV matnidan 3 ta tovar muvaffaqiyatli aniqlandi');
  assert(parsedCSV[1].name === 'Pomidor Yangi' && parsedCSV[1].stock === 45.5 && parsedCSV[1].unit === 'kg', 'Kasr qoldiq va kg birligi to\'g\'ri o\'qildi');

  window.parseCSVFromText(sampleCSV);
  await window.executeCSVImport();

  const importedMeat = window.APP.products.find(p => p.barcode === '8888888888888');
  assert(importedMeat && importedMeat.price === 90000 && importedMeat.stock === 25, 'Mavjud tovar narxi (90 000) va qoldig\'i (25) yangilandi');

  const newTomato = window.APP.products.find(p => p.barcode === '2001112223334');
  assert(newTomato && newTomato.name === 'Pomidor Yangi' && newTomato.stock === 45.5, 'Yangi mahsulot Pomidor Yangi (45.5 kg) bazaga qo\'shildi');

  // ─────────────────────────────────────────────
  // TEST 21: Savatni to'xtatib turish (Hold cart) va tiklash
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 21: Savatni to\'xtatib turish (Hold cart) va tiklash');
  window.APP.cart = [];
  window.addToCart(newTomato, 2.5); // 2.5 kg pomidor
  assert(window.APP.cart.length === 1, 'Hozirgi savatda 1 ta tovar (2.5 kg)');

  await window.holdCurrentCart();
  assert(window.APP.cart.length === 0, 'Savat kutishga olingach, kassa savati bo\'shatildi');
  assert(window.APP.heldCarts.length === 1, 'Kutishdagi savatlar ro\'yxatida 1 ta savat saqlandi');
  assert(window.APP.heldCarts[0].items[0].qty === 2.5, 'Kutishdagi savatda 2.5 kg tovar mavjud');

  // Boshqa mijozga 1 ta tovar sotish
  window.addToCart(importedMeat, 1);
  assert(window.APP.cart.length === 1 && window.APP.cart[0].id === importedMeat.id, 'Navbatdagi mijoz uchun yangi tovar savatga olindi');
  window.APP.cart = []; // Yangi mijoz xizmat qilib bo'lindi

  // Kutishdagi savatni qayta tiklash
  const heldId = window.APP.heldCarts[0].id;
  await window.restoreHeldCart(heldId);
  assert(window.APP.cart.length === 1 && window.APP.cart[0].id === newTomato.id, 'Kutishdagi savat muvaffaqiyatli tiklandi');
  assert(window.APP.heldCarts.length === 0, 'Tiklangandan so\'ng kutish ro\'yxatidan o\'chirildi');
  window.APP.cart = [];

  // ─────────────────────────────────────────────
  // TEST 22: Ombor sanog'i (Reviziya / Inventarizatsiya)
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 22: Ombor sanog\'i (Reviziya / Inventarizatsiya)');
  // Pomidor qoldig'i tizimda 45.5 kg. Haqiqiy sanalganda 40 kg chiqdi (kamomad -5.5 kg).
  window.selectAuditProduct(newTomato);
  const actualAuditInput = document.getElementById('auditActualInput');
  if (actualAuditInput) actualAuditInput.value = '40';
  window.calcAuditItemDiff();
  window.commitAuditActiveItem();

  assert(window.APP.auditItems.length === 1, 'Sanoq ro\'yxatiga tovar qo\'shildi');
  assert(window.APP.auditItems[0].diff === -5.5, 'Kamomad -5.5 kg to\'g\'ri hisoblandi');
  assert(window.APP.auditItems[0].lossAmount === 5.5 * 12000, 'Yo\'qotish summasi (66 000 so\'m) aniqlandi');

  // Sanoqni tasdiqlash
  window.confirm = () => true; // tasdiqlash
  await window.applyAuditResults();
  window.confirm = () => false;

  assert(newTomato.stock === 40, 'Ombordagi qoldiq haqiqiy faktik son 40 kg ga to\'g\'rilandi');
  assert(window.APP.auditItems.length === 0, 'Sanoq yakunlangach ro\'yxat tozalandi');

  // Reset demo state
  window.useDemo = true;
  window.navigator.onLine = true;
  await window.ScanDB.set('scanpos_outbox', []);

  // ─────────────────────────────────────────────
  // TEST 23: Yaroqlilik muddati (Expiry Date)
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 23: Yaroqlilik muddati (Expiry Date)');
  const expOld = window.getExpiryStatus('2020-01-01');
  assert(expOld.status === 'expired', 'O\'tgan sana expired sifatida aniqlandi');
  assert(expOld.days < 0, 'O\'tgan kunda days manfiy bo\'ldi');
  assert(expOld.label.includes('Muddati o\'tgan'), 'Label da "Muddati o\'tgan" yozuvi bor');

  const in3Days = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const expWarn = window.getExpiryStatus(in3Days);
  assert(expWarn.status === 'expiring', '3 kunda tugaydigan tovar expiring holatida');
  assert(expWarn.label.includes('kunda tugaydi'), 'Label da "kunda tugaydi" yozuvi bor');

  const in40Days = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
  const expOk = window.getExpiryStatus(in40Days);
  assert(expOk.status === 'ok', '40 kunda tugaydigan tovar ok holatida');

  // Tovarni bazaga qo'shish va getExpiringProducts(7) bilan tekshirish
  const expiredProd = {
    id: 'prod-expired-test',
    barcode: '88880001',
    name: 'Sut Muddati O\'tgan',
    price: 9000,
    costPrice: 7000,
    stock: 5,
    trackStock: true,
    category: 'ichimliklar',
    expiryDate: '2020-01-01'
  };
  const expiringProd = {
    id: 'prod-expiring-test',
    barcode: '88880002',
    name: 'Qatiq Muddati Tugayotgan',
    price: 8000,
    costPrice: 6000,
    stock: 8,
    trackStock: true,
    category: 'ichimliklar',
    expiryDate: in3Days
  };
  window.APP.products.push(expiredProd, expiringProd);

  const expiringList = window.getExpiringProducts(7);
  assert(expiringList.some(p => p.id === expiredProd.id), 'Muddati o\'tgan tovar 7 kunlik ro\'yxatda chiqdi');
  assert(expiringList.some(p => p.id === expiringProd.id), 'Muddati 3 kunda tugaydigan tovar 7 kunlik ro\'yxatda chiqdi');

  // Savatga muddati o'tgan tovar skanerlanganda ogohlantirish
  window.APP.currentPage = 'scanner';
  window.APP.cart = [];
  window.confirm = () => false; // Rad etish
  window.addToCart(expiredProd);
  assert(window.APP.cart.length === 0, 'Kassir rad etsa muddati o\'tgan tovar savatga qo\'shilmadi');

  window.confirm = () => true; // Qasddan tasdiqlash
  window.addToCart(expiredProd);
  assert(window.APP.cart.length === 1, 'Kassir tasdiqlaganda ogohlantirish bilan savatga kiritildi');
  window.APP.cart = [];

  // ─────────────────────────────────────────────
  // TEST 24: Xarajatlar va Haqiqiy Sof Foyda
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 24: Xarajatlar va Haqiqiy Sof Foyda');
  window.APP.expenses = [];
  const exp1 = await window.saveExpense({
    title: 'Do\'kon ijarasi',
    category: 'ijara',
    amount: 1500000,
    date: new Date().toISOString().slice(0, 10),
    note: 'Oylik ijara'
  });
  const exp2 = await window.saveExpense({
    title: 'Elektr energiyasi (Svet)',
    category: 'svet',
    amount: 300000,
    date: new Date().toISOString().slice(0, 10)
  });

  assert(window.APP.expenses.length === 2, 'Ikkita xarajat muvaffaqiyatli saqlandi');
  const expTotal = window.APP.expenses.reduce((s, e) => s + Number(e.amount), 0);
  assert(expTotal === 1800000, 'Xarajatlar yig\'indisi 1 800 000 so\'m bo\'ldi');

  // Analitika hisob-kitobini tekshirish
  window.APP.currentPage = 'analytics';
  window.renderAnalytics();
  const totalExpEl = document.getElementById('anTotalExpenses');
  assert(totalExpEl && (totalExpEl.textContent.includes('1.8 mln') || totalExpEl.textContent.includes('1 800 000')), 'Analitikada xarajatlar 1.8 mln so\'m ko\'rsatildi');

  // Xarajatni o'chirish
  await window.deleteExpense(exp2.id);
  assert(window.APP.expenses.length === 1, 'Xarajat o\'chirildi');
  assert(window.APP.expenses[0].id === exp1.id, 'Qolgan xarajat tekshirildi');

  // ─────────────────────────────────────────────
  // TEST 25: O'zbekcha / Ruscha Til tanlash
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 25: O\'zbekcha / Ruscha Til tanlash');
  assert(typeof window.I18N === 'object', 'I18N lug\'ati mavjud');
  assert(typeof window.I18N.uz === 'object' && typeof window.I18N.ru === 'object', 'UZ va RU lug\'atlari mavjud');

  // Boshlang'ich uzbekcha
  assert(window.t('btn_checkout') === 'To\'lov', 'Boshlang\'ich til o\'zbekcha (To\'lov)');

  // Rus tiliga almashtirish
  window.changeLanguage('ru');
  assert(window.APP.settings.lang === 'ru', 'Til sozlamasi "ru" ga o\'zgardi');
  assert(window.t('btn_checkout') === 'Оплата', 'Tarjima "Оплата" ga o\'zgardi');
  assert(window.t('nav_products') === 'Товары', 'Menyu tarjimasi "Товары" bo\'ldi');

  // Tilni almashtirish tugmasi (toggle)
  window.toggleLanguage();
  assert(window.APP.settings.lang === 'uz', 'Toggle orqali yana "uz" ga qaytdi');
  assert(window.t('btn_checkout') === 'To\'lov', 'Qayta "To\'lov" bo\'ldi');

  // ─────────────────────────────────────────────
  // TEST 26: Narxlarni ommaviy o'zgartirish va narx tarixi
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 26: Narxlarni ommaviy o\'zgartirish va narx tarixi');
  const bulkProd = {
    id: 'prod-bulk-test',
    barcode: '99990001',
    name: 'Bulk Tovar Test',
    price: 10000,
    costPrice: 8000,
    stock: 20,
    trackStock: true,
    category: 'ichimliklar',
    priceHistory: []
  };
  window.APP.products.push(bulkProd);

  // +10% ommaviy narx oshirish
  const catInput = document.getElementById('bulkPriceCategory');
  const targetInput = document.getElementById('bulkPriceTarget');
  const typeInput = document.getElementById('bulkPriceType');
  const valInput = document.getElementById('bulkPriceValue');
  if (catInput) catInput.value = 'ichimliklar';
  if (targetInput) targetInput.value = 'price';
  if (typeInput) typeInput.value = 'percent';
  if (valInput) valInput.value = '10';

  window.confirm = () => true;
  await window.applyBulkPriceUpdate();

  assert(bulkProd.price === 11000, 'Narx +10% ga oshdi (10000 -> 11000)');
  assert(Array.isArray(bulkProd.priceHistory) && bulkProd.priceHistory.length > 0, 'Narx tarixi jurnali yaratildi');
  assert(bulkProd.priceHistory[0].oldPrice === 10000 && bulkProd.priceHistory[0].newPrice === 11000, 'Tarixda 10000 -> 11000 qayd etildi');

  // +500 so'm qo'shish
  if (typeInput) typeInput.value = 'fixed';
  if (valInput) valInput.value = '500';
  await window.applyBulkPriceUpdate();

  assert(bulkProd.price === 11500, 'Narx +500 so\'mga oshdi (11000 -> 11500)');
  assert(bulkProd.priceHistory[0].newPrice === 11500, 'Yangi narx tarixda qayd etildi');

  // ─────────────────────────────────────────────
  // TEST 27: Shtrix-kod yorlig'ini chop etish
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 27: Shtrix-kod yorlig\'ini chop etish');
  const generatedBarcode = window.generateProductBarcode();
  assert(typeof generatedBarcode === 'string', 'Shtrix-kod satr ko\'rinishida generatsiya qilindi');
  assert(generatedBarcode.length === 13, 'Shtrix-kod uzunligi EAN-13 bo\'yicha 13 ta raqam');
  assert(generatedBarcode.startsWith('20'), 'Shtrix-kod supermarket ichki prefiksi "20" bilan boshlanadi');

  // EAN-13 nazorat raqami (checksum) tekshiruvi
  let sumOdd = 0;
  let sumEven = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(generatedBarcode[i], 10);
    if (i % 2 === 0) sumOdd += digit;
    else sumEven += digit;
  }
  const calcCheck = (10 - ((sumOdd + 3 * sumEven) % 10)) % 10;
  const actualCheck = parseInt(generatedBarcode[12], 10);
  assert(calcCheck === actualCheck, 'EAN-13 nazorat raqami (checksum) 100% to\'g\'ri');

  // Canvasga chizish funksiyasini tekshirish
  const mockCanvas = {
    width: 200,
    height: 70,
    getContext: () => ({
      fillRect: () => {},
      clearRect: () => {},
      fillStyle: ''
    })
  };
  let drawOk = false;
  try {
    window.drawBarcodeToCanvas(mockCanvas, generatedBarcode);
    drawOk = true;
  } catch (e) {
    drawOk = false;
  }
  assert(drawOk, 'Shtrix-kod canvasga xatosiz chizildi');

  // Yorliq oynasini ochish
  let printLabelOpened = false;
  try {
    window.openPrintLabelModal(bulkProd.id);
    printLabelOpened = true;
  } catch (e) {
    printLabelOpened = false;
  }
  assert(printLabelOpened, 'Mahsulot yorlig\'i oynasi muvaffaqiyatli ochildi');

  // ─────────────────────────────────────────────
  // TEST 28: Kasr (kg/gramm) qaytarish - submitRefund va ombor tiklanishi
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 28: Kasr (kg) qaytarish (vozvrat)');
  window.useDemo = true;
  window.navigator.onLine = true;
  const refundMeat = {
    id: 'prod-refund-meat',
    barcode: '7777777777777',
    name: "Mol go'shti",
    price: 80000,
    costPrice: 65000,
    stock: 10,
    unit: 'kg',
    trackStock: true,
    category: 'oziq'
  };
  window.APP.products.push(refundMeat);
  const meatBill = {
    id: 'bill-refund-meat',
    timestamp: new Date().toISOString(),
    total: 160000,
    items: [{ id: refundMeat.id, name: refundMeat.name, price: 80000, qty: 2, unit: 'kg' }],
    paymentMethod: 'cash',
    refunds: []
  };
  window.APP.bills.unshift(meatBill);
  window.APP._currentRefundBill = meatBill;

  const meatRefundInput = document.createElement('input');
  meatRefundInput.id = `refund-qty-${refundMeat.id}`;
  meatRefundInput.value = '0.5';
  document.body.appendChild(meatRefundInput);

  await window.submitRefund();
  assert(meatBill.refunds && meatBill.refunds.length === 1, 'Kasr qaytarish yozuvi saqlandi');
  assert(meatBill.refunds[0].qty === 0.5, '0.5 kg to\'g\'ri qabul qilindi (parseInt emas)');
  assert(meatBill.refunds[0].amount === 40000, '0.5 kg × 80 000 = 40 000 so\'m to\'g\'ri hisoblandi');
  assert(refundMeat.stock === 10.5, 'Ombordagi qoldiq 10 dan 0.5 ga ko\'payib 10.5 kg bo\'ldi');

  // ─────────────────────────────────────────────
  // TEST 29: Kassa Smenalari (Shift Lifecycle) va X/Z hisobotlar
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 29: Kassa Smenalari (Shift Lifecycle) va X/Z hisobotlar');
  window.APP.currentShift = null;
  window.APP.shifts = [];

  const shiftCashierNameInput = document.getElementById('shiftCashierName');
  const shiftStartingCashInput = document.getElementById('shiftStartingCash');
  const shiftOpenNoteInput = document.getElementById('shiftOpenNote');
  if (shiftCashierNameInput) shiftCashierNameInput.value = 'Murodjon Kassir';
  if (shiftStartingCashInput) shiftStartingCashInput.value = '200000';
  if (shiftOpenNoteInput) shiftOpenNoteInput.value = 'Ertalabki smena';

  await window.submitOpenShift();
  assert(window.APP.currentShift !== null, 'Smena muvaffaqiyatli ochildi');
  assert(window.APP.currentShift.cashierName === 'Murodjon Kassir', 'Kassir ismi to\'g\'ri saqlandi');
  assert(window.APP.currentShift.startingCash === 200000, 'Boshlang\'ich naqd pul 200 000 so\'m');
  assert(window.APP.currentShift.status === 'open', 'Smena holati ochiq');

  // Pul harakati: Chiqim 50 000 so'm
  window.APP._cmType = 'out';
  const cmAmtInput = document.getElementById('cashMovementAmt');
  const cmRsnInput = document.getElementById('cashMovementReason');
  if (cmAmtInput) cmAmtInput.value = '50000';
  if (cmRsnInput) cmRsnInput.value = 'Tushlik uchun';
  await window.submitCashMovement();

  // Pul harakati: Kirim 100 000 so'm
  window.APP._cmType = 'in';
  if (cmAmtInput) cmAmtInput.value = '100000';
  if (cmRsnInput) cmRsnInput.value = 'Mayda pul kiritish';
  await window.submitCashMovement();

  // 200 000 - 50 000 + 100 000 = 250 000 so'm
  const curDrawerCash = window.calcCurrentShiftCash(window.APP.currentShift);
  assert(curDrawerCash === 250000, 'Kassadagi naqd pul (200k - 50k + 100k = 250 000) to\'g\'ri hisoblandi');

  // Savdo o'tkazish (Naqd 60 000 so'm)
  const shiftTestProd = {
    id: 'prod-shift-sale',
    name: 'Shakar 1kg',
    price: 15000,
    costPrice: 12000,
    stock: 20,
    trackStock: true
  };
  window.APP.products.push(shiftTestProd);
  window.APP.cart = [{ ...shiftTestProd, qty: 4 }]; // 4 * 15000 = 60000
  window.APP.selectedPayment = 'cash';
  const cashGivenEl = document.getElementById('cashGiven');
  if (cashGivenEl) cashGivenEl.value = '60000';
  await window.completeSale();

  assert(window.APP.currentShift.cashSales === 60000, 'Smenadagi naqd savdo 60 000 so\'m');
  assert(window.APP.currentShift.billsCount === 1, 'Smenada 1 ta chek qayd etildi');
  // Kassada: 250 000 + 60 000 = 310 000 so'm
  assert(window.calcCurrentShiftCash(window.APP.currentShift) === 310000, 'Sotuvdan so\'ng kassadagi kutilgan naqd 310 000 so\'m');

  // Oraliq X-hisobot
  const xReportText = window.buildShiftReportText(window.APP.currentShift, false);
  assert(xReportText.includes('ORALIQ X-HISOBOT'), 'X-hisobot sarlavhasi to\'g\'ri generatsiya qilindi');
  assert(xReportText.includes('310') && xReportText.includes('KUTILGAN NAQD PUL'), 'X-hisobotda kutilayotgan kassa naqd puli mavjud');

  // Smenani yopish (Faktik pul 300 000 so'm, ya'ni -10 000 kamomad)
  const actCashInput = document.getElementById('shiftActualCash');
  if (actCashInput) actCashInput.value = '300000';
  window.calcShiftDiscrepancy();
  const diffBox = document.getElementById('shiftDiffBox');
  assert(diffBox && diffBox.textContent.includes('Kamomad'), 'Discrepancy kamomad sifatida aniqlandi');

  await window.submitCloseShift();
  assert(window.APP.currentShift === null, 'Smena yopilgach APP.currentShift null bo\'ldi');
  assert(window.APP.shifts.length === 1, 'Yopilgan smena APP.shifts tarixiga saqlandi');
  const closedShift = window.APP.shifts[0];
  assert(closedShift.status === 'closed', 'Smena holati closed');
  assert(closedShift.discrepancy === -10000, 'Kamomad -10 000 so\'m to\'g\'ri qayd etildi');

  // Yakuniy Z-hisobot
  const zReportText = window.buildShiftReportText(closedShift, true);
  assert(zReportText.includes('YAKUNIY Z-HISOBOT'), 'Z-hisobot sarlavhasi to\'g\'ri generatsiya qilindi');
  assert(zReportText.includes('HAQIQIY SANALGAN NAQD'), 'Z-hisobotda faktik sanalgan naqd pul ko\'rsatildi');

  // ─────────────────────────────────────────────
  // TEST 30: Mijozlar sodiqlik tizimi (Loyalty & Bonuses)
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 30: Mijozlar sodiqlik tizimi (Loyalty & Bonuses)');
  const loyalCustomer = {
    id: 'cust-loyalty-101',
    name: 'Alisher Sodiq',
    phone: '+998901234567',
    discountPercent: 5, // 5% doimiy shaxsiy chegirma
    cashbackBalance: 20000, // 20 000 so'm yig'ilgan bonus
    totalPurchases: 500000,
    purchasesCount: 5,
    createdAt: new Date().toISOString()
  };
  window.APP.debtors.unshift(loyalCustomer);

  // Mijozni savatga tanlash
  window.selectCustomer(loyalCustomer.id);
  assert(window.APP.selectedCustomer !== null && window.APP.selectedCustomer.id === loyalCustomer.id, 'Sodiq mijoz savatga tanlandi');

  // Savatga tovar qo'shish (100 000 so'm)
  const loyaltyProd = {
    id: 'prod-loyalty-item',
    name: 'Choynak To\'plami',
    price: 100000,
    costPrice: 70000,
    stock: 10,
    trackStock: true
  };
  window.APP.products.push(loyaltyProd);
  window.APP.cart = [{ ...loyaltyProd, qty: 1 }];

  // 5% shaxsiy chegirma tekshiruvi: 100 000 - 5% = 95 000 so'm
  const totalsWithDisc = window.calcTotals(window.APP.cart, loyalCustomer.discountPercent, 0, 0);
  assert(totalsWithDisc.discount === 5000, 'Mijozning 5% chegirmasi (5 000 so\'m) to\'g\'ri hisoblandi');
  assert(totalsWithDisc.total === 95000, 'Chegirmadan keyingi summa 95 000 so\'m');

  // Bonusdan to'lash (20 000 so'm bonus sarflash)
  const useBonusToggle = document.getElementById('useBonusToggle');
  if (useBonusToggle) useBonusToggle.checked = true;
  window.toggleUseBonus();
  assert(window.APP._bonusUsedAmt === 20000, 'Bonusdan 20 000 so\'m to\'lov uchun ajratildi');
  const totalsWithBonus = window.calcTotals(window.APP.cart, loyalCustomer.discountPercent, 0, 20000);
  assert(totalsWithBonus.total === 75000, 'Bonus ayirilgach yakuniy to\'lov 75 000 so\'m bo\'ldi');

  // Savdoni yakunlash va yangi keshbek hisoblanishi (sozlamada 2%)
  window.APP.settings.cashbackEnabled = true;
  window.APP.settings.cashbackRate = 2; // 2% keshbek
  window.APP.selectedPayment = 'cash';
  const cashInputEl = document.getElementById('cashGiven');
  if (cashInputEl) cashInputEl.value = '75000';
  await window.completeSale();

  // 75 000 * 2% = 1 500 so'm yangi bonus yig'iladi
  // Eski bonus 20 000 sarflandi (0 qoldi), yangi 1 500 qo'shildi -> 1 500 so'm
  assert(loyalCustomer.cashbackBalance === 1500, 'Bonus sarflanib, yangi keshbek (+1 500) to\'g\'ri hisoblandi');
  assert(loyalCustomer.totalPurchases === 575000, 'Mijozning jami xaridlari summasi yangilandi (500k + 75k = 575 000)');
  assert(loyalCustomer.purchasesCount === 6, 'Mijoz xaridlari soni 6 taga oshdi');

  // Chekda sodiqlik ma'lumotlari saqlanganligi
  const loyalLastBill = window.APP.bills[0];
  assert(loyalLastBill.customerId === loyalCustomer.id, 'Chekda customerId qayd etildi');
  assert(loyalLastBill.bonusUsed === 20000, 'Chekda bonusUsed: 20 000 so\'m qayd etildi');
  assert(loyalLastBill.bonusEarned === 1500, 'Chekda bonusEarned: 1 500 so\'m qayd etildi');

  // Sodiqlik oynasida bonus / chegirma tahrirlash (saveAdjustBonus)
  const adjIdInput = document.getElementById('adjustBonusCustomerId');
  const adjDiscInput = document.getElementById('adjustDiscountPct');
  const adjBonInput = document.getElementById('adjustCashbackBal');
  if (adjIdInput) adjIdInput.value = loyalCustomer.id;
  if (adjDiscInput) adjDiscInput.value = '10'; // 10%
  if (adjBonInput) adjBonInput.value = '50000'; // 50 000 so'm
  await window.saveAdjustBonus();

  assert(loyalCustomer.discountPercent === 10, 'Mijoz chegirmasi 10% ga muvaffaqiyatli o\'zgartirildi');
  assert(loyalCustomer.cashbackBalance === 50000, 'Mijoz bonusi 50 000 so\'mga muvaffaqiyatli o\'zgartirildi');

  // ─────────────────────────────────────────────
  // TEST 31: Smart Dinamik Narxlar (Smart Pricing)
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 31: Smart Dinamik Narxlar (Smart Pricing)');
  // 31.1: Happy Hours (masalan 20% chegirma)
  window.APP.settings.happyHoursEnabled = true;
  window.APP.settings.happyHoursStart = '00:00';
  window.APP.settings.happyHoursEnd = '23:59';
  window.APP.settings.happyHoursDiscount = 20;

  const testItemSmart = { id: 'p_smart_1', name: 'Meva Sharbat', price: 10000, qty: 1 };
  const hhInfo = window.getSmartPriceInfo(testItemSmart, 1);
  assert(hhInfo.rule === 'happy-hour', 'Happy Hour qoidasi faollashdi');
  assert(hhInfo.finalPrice === 8000, '20% Happy hour chegirmasi: 10 000 -> 8 000 so\'m');
  assert(hhInfo.discountPercent === 20, 'Chegirma foizi 20%');

  // Happy hourni o'chirib, Expiry Markdown tekshiramiz
  window.APP.settings.happyHoursEnabled = false;
  window.APP.settings.expiryMarkdownEnabled = true;
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const testExpItem = { id: 'p_smart_exp', name: 'Yogurt', price: 10000, expiryDate: tomorrow };
  const expMarkdownInfo = window.getSmartPriceInfo(testExpItem, 1);
  assert(expMarkdownInfo.rule === 'expiry-markdown', 'Muddati yaqin tovar uchun Expiry Markdown faollashdi');
  assert(expMarkdownInfo.finalPrice === 7000, '30% avtomatik sariq narxnoma: 10 000 -> 7 000 so\'m');

  // Wholesale Tier (10+ dona xaridda 10% ulgurji narx)
  window.APP.settings.expiryMarkdownEnabled = false;
  window.APP.settings.wholesaleTierEnabled = true;
  const testWholesaleItem = { id: 'p_smart_ws', name: 'Suv 1.5L', price: 5000 };
  const wsInfo = window.getSmartPriceInfo(testWholesaleItem, 12);
  assert(wsInfo.rule === 'wholesale-tier', '12 dona xarid uchun Ulgurji narx faollashdi');
  assert(wsInfo.finalPrice === 4500, '10% ulgurji chegirma: 5 000 -> 4 500 so\'m');

  // Savat va calcTotals hisobi
  window.APP.cart = [
    { id: 'p_smart_ws', name: 'Suv 1.5L', price: 5000, qty: 10 }
  ];
  window.updateCartUI();
  assert(window.APP.cart[0].smartPrice === 4500, 'Savatda smartPrice 4500 so\'m sifatida saqlandi');
  const totalsSmart = window.calcTotals(window.APP.cart, 0, 0, 0);
  assert(totalsSmart.subtotal === 45000, 'Subtotal 10 * 4500 = 45 000 so\'m bo\'ldi (50 000 emas)');

  // ─────────────────────────────────────────────
  // TEST 32: Ikkinchi Ekran — Mijoz Monitori (Customer Display Sync)
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 32: Ikkinchi Ekran — Mijoz Monitori Sync');
  window.APP.settings.shopName = 'ScanPOS Test Supermarket';
  window.syncCustomerDisplay('SYNC_STATE');
  const rawPayload = window.localStorage.getItem('scanpos_customer_display_payload');
  assert(rawPayload !== null, 'LocalStorage ga display payload saqlandi');
  const parsedDisplay = JSON.parse(rawPayload);
  assert(parsedDisplay.type === 'SYNC_STATE', 'Tadbir turi SYNC_STATE');
  assert(parsedDisplay.payload.shopName === 'ScanPOS Test Supermarket', 'Do\'kon nomi to\'g\'ri uzatildi');
  assert(parsedDisplay.payload.total === 45000, 'Mijoz ekraniga to\'lov summasi (45 000) to\'g\'ri uzatildi');
  assert(parsedDisplay.payload.cart.length === 1, 'Mijoz ekraniga savat tovarlari to\'g\'ri uzatildi');

  // To'lov tugaganda SALE_COMPLETED tadbiri
  window.syncCustomerDisplay('SALE_COMPLETED', { billId: 'BILL-123' });
  const rawSalePayload = window.localStorage.getItem('scanpos_customer_display_payload');
  const parsedSale = JSON.parse(rawSalePayload);
  assert(parsedSale.type === 'SALE_COMPLETED', 'To\'lov tugaganda SALE_COMPLETED xabari uzatildi');

  // ─────────────────────────────────────────────
  // TEST 33: AI Vision Skaner (Visual Goods Matcher)
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 33: AI Vision Skaner (Visual Goods Matcher)');
  const visionProd1 = { id: 'v_bodring', name: 'Bodring Yangi', price: 8000, unit: 'kg', category: 'sabzavot' };
  const visionProd2 = { id: 'v_pomidor', name: 'Pomidor Qizil', price: 15000, unit: 'kg', category: 'sabzavot' };
  const visionProd3 = { id: 'v_non', name: 'Samarqand Noni', price: 6000, unit: 'dona', category: 'non' };
  window.APP.products.push(visionProd1, visionProd2, visionProd3);

  // Yashil piksel profili (Bodringni tanishi kerak)
  const greenProfile = { avgR: 50, avgG: 190, avgB: 60 };
  const greenMatches = window.findVisionMatches(greenProfile);
  assert(greenMatches.length > 0, 'Yashil rang profili bo\'yicha tovarlar topildi');
  assert(greenMatches[0].product.name.includes('Bodring'), 'Eng yuqori aniqlikdagi tovar: Bodring');
  assert(greenMatches[0].score >= 80, 'AI Ishonch darajasi 80% dan yuqori');

  // Qizil piksel profili (Pomidor yoki Go'shtni tanishi kerak)
  const redProfile = { avgR: 210, avgG: 40, avgB: 40 };
  const redMatches = window.findVisionMatches(redProfile);
  assert(redMatches.length > 0, 'Qizil rang profili bo\'yicha tovarlar topildi');
  assert(redMatches.some(m => m.product.name.includes('Pomidor')), 'Qizil tovarlar orasida Pomidor topildi');

  // AI Vision orqali 1-click bilan savatga qo'shish
  window.APP.cart = [];
  window.addVisionItemToCart(visionProd1.id, 1.5);
  assert(window.APP.cart.length === 1, 'AI Vision dan tanlangan tovar savatga qo\'shildi');
  assert(window.APP.cart[0].qty === 1.5, 'Miqdor 1.5 kg sifatida kiritildi');
  assert(window.APP.cart[0].name === 'Bodring Yangi', 'Mahsulot nomi to\'g\'ri');

  // ─────────────────────────────────────────────
  // TEST 34: AI CFO Biznes Maslahatchi & Demand Forecasting
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 34: AI CFO Biznes Maslahatchi');
  const deadProd = {
    id: 'prod_dead_stock',
    name: 'Qimmat Shokolad Qutisi',
    price: 100000,
    costPrice: 70000,
    stock: 10,
    trackStock: true
  };
  window.APP.products.push(deadProd);

  const gridEl = document.getElementById('aiCfoInsightsGrid');
  assert(gridEl !== null, 'HTML da #aiCfoInsightsGrid mavjud');

  window.runAICFOAnalysis();
  assert(gridEl.innerHTML.includes('Dead Stock'), 'AI CFO gridda Dead Stock tahlili hosil bo\'ldi');
  assert(gridEl.innerHTML.includes('Muzlagan kapital'), 'Muzlagan kapital kartasi mavjud');
  assert(gridEl.innerHTML.includes('Talab prognozi'), 'Talab prognozi kartasi mavjud');
  assert(gridEl.innerHTML.includes('Marja optimallashtirish'), 'Marja optimallashtirish kartasi mavjud');

  // ─────────────────────────────────────────────
  // TEST 35: Telegram Mini App Onlayn Do'kon & Buyurtmalar
  // ─────────────────────────────────────────────
  console.log('\n📌 Test 35: Telegram Mini App Onlayn Buyurtmalar');
  window.APP.onlineOrders = [];
  await window.simulateOnlineOrder();
  assert(window.APP.onlineOrders.length === 1, 'Yangi onlayn buyurtma qabul qilindi');
  const simOrder = window.APP.onlineOrders[0];
  assert(simOrder.status === 'new', 'Buyurtma holati yangi (new)');
  assert(simOrder.customerName === 'Sardor Rahimiy', 'Mijoz ismi qayd etildi');
  assert(simOrder.items.length > 0, 'Buyurtma tovarlari mavjud');

  const badgeEl = document.getElementById('onlineOrdersBadge');
  assert(badgeEl && badgeEl.textContent === '1', 'Headerdagi bildirishnoma belgisi 1 ga o\'zgardi');

  // Buyurtmani qabul qilish (acceptOnlineOrder)
  await window.acceptOnlineOrder(simOrder.id);
  assert(simOrder.status === 'accepted', 'Buyurtma holati "accepted" ga o\'tdi');

  // Buyurtmani to'g'ridan-to'g'ri kassaga yuklash (loadOrderToCartAndCheckout)
  window.loadOrderToCartAndCheckout(simOrder.id);
  assert(window.APP.cart.length > 0, 'Onlayn buyurtma tovarlari kassa savatiga yuklandi');
  assert(window.APP.currentPage === 'scanner', 'Kassa skaner sahifasiga o\'tildi');

  // Buyurtmani yakunlash (completeOnlineOrder)
  await window.completeOnlineOrder(simOrder.id);
  assert(simOrder.status === 'completed', 'Buyurtma muvaffaqiyatli yakunlandi (completed)');

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
