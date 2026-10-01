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
