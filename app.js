/**
 * ScanPOS – app.js
 * ================
 * Texnologiyalar:
 *  - BarcodeDetector API (native Chrome/Android) — 100% aniq skaner
 *  - ZXing (@zxing/browser) — BarcodeDetector yo'q bo'lsa fallback
 *  - Firebase Firestore — real vaqt ma'lumotlar bazasi
 *  - Web Speech API (SpeechSynthesis) — ovozli e'lon
 *  - localStorage — offline/demo rejim
 */

'use strict';

// ─────────────────────────────────────────────
//  GLOBAL STATE
// ─────────────────────────────────────────────
const APP = {
  cart: [],             // { id, barcode, barcodes:[], name, price, qty, category }
  products: [],         // barcha mahsulotlar
  bills: [],            // cheklar tarixi
  settings: {},         // sozlamalar
  categoryPrices: {},   // toifalar bo‘yicha standart narxlar (avtomatik eslab qolish)
  debtors: [],          // { id, name, phone, note, createdAt }
  debts: [],            // { id, debtorId, amount, paidAmount, description, dueDate, createdAt, payments:[] }
  currentPage: 'scanner',
  cameraStream: null,
  scanning: false,
  scannerLoop: null,
  barcodeDetector: null,
  lastScanned: '',
  lastScannedTime: 0,
  scanCooldown: 2000,   // ms — bir xil kodni qayta o‘qimaslik
  voiceOn: true,
  selectedPayment: 'cash',
  editingProductId: null,
  foundProduct: null,
  torchOn: false,       // Kamera fonari (torch)
  quickItems: [],       // Tezkor kodsiz tovarlar ro‘yxati
  currentBillForPrint: null,
  _currentLinkTargetId: null,
};

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
  suv_05: '💧 Suv 0.5L',
  suv_10: '💧 Suv 1L - 1.5L',
  suv_50: '💧 Suv 5L',
  ichimlik: '🥤 Gazli ichimliklar & sharbatlar',
  non: '🍞 Non va pishiriqlar',
  shirinlik: '🍫 Shirinliklar & konfetlar',
  sut: '🥛 Sut mahsulotlari',
  oziq: '🥫 Oziq-ovqat mahsulotlari',
  gigiyena: '🧼 Gigiyena va kosmetika',
  uy: '🏠 Uy-ro\'zg\'or buyumlari',
  boshqa: '📦 Boshqa mahsulotlar',
};

const catEmoji = {
  suv_05: '💧',
  suv_10: '💧',
  suv_50: '💧',
  ichimlik: '🥤',
  non: '🍞',
  shirinlik: '🍫',
  sut: '🥛',
  oziq: '🥫',
  uy: '🏠',
  gigiyena: '🧼',
  boshqa: '📦',
};

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
    const saved = localStorage.getItem('scanpos_category_prices');
    APP.categoryPrices = saved
      ? { ...DEFAULT_CATEGORY_PRICES, ...JSON.parse(saved) }
      : { ...DEFAULT_CATEGORY_PRICES };
  } catch {
    APP.categoryPrices = { ...DEFAULT_CATEGORY_PRICES };
  }
}

function saveCategoryPrices() {
  localStorage.setItem('scanpos_category_prices', JSON.stringify(APP.categoryPrices));
}

// ZXing reader (lazy loaded)
let zxingReader = null;

// ─────────────────────────────────────────────
//  GLOBAL PRODUCT LOOKUP (OpenFoodFacts + OpenBeautyFacts)
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
//  INIT
// ─────────────────────────────────────────────
window.initApp = async function () {
  if (window._appInited) return;
  window._appInited = true;
  loadSettings();
  loadLocalData();
  loadQuickItems();
  updateFirebaseStatus();

  if (window.useDemo) {
    document.getElementById('demoTag').classList.remove('hidden');
  }

  // Splash animatsiya
  setTimeout(() => {
    const splash = document.getElementById('splash');
    splash.classList.add('out');
    setTimeout(() => {
      splash.style.display = 'none';
      document.getElementById('app').classList.remove('hidden');
      startCamera();
    }, 500);
  }, 1800);

  // ZXing CDN dan yuklash (BarcodeDetector yo'q bo'lganda)
  if (!('BarcodeDetector' in window)) {
    loadZXing();
  } else {
    try {
      APP.barcodeDetector = new BarcodeDetector({
        formats: [
          'data_matrix', 'qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e',
          'code_128', 'code_39', 'itf', 'codabar'
        ]
      });
      console.log('✅ BarcodeDetector API tayyor');
    } catch (e) {
      console.warn('BarcodeDetector xato:', e);
      loadZXing();
    }
  }

  // Firebase real-time listeners
  if (!window.useDemo && window.firebaseDB) {
    listenFirestoreProducts();
    listenFirestoreBills();
  } else {
    renderProducts();
    renderBills();
  }

  updateCartUI();
  updateVoiceBtn();
  updateTorchUI();
};

// initApp faqat initFirebase() finally blokidan chaqiriladi (index.html)

// ─────────────────────────────────────────────
//  ZXING LOADER
// ─────────────────────────────────────────────
function loadZXing() {
  const s = document.createElement('script');
  s.src = 'https://unpkg.com/@zxing/browser@0.1.5/umd/zxing-browser.min.js';
  s.onload = () => {
    if (window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader) {
      zxingReader = new window.ZXingBrowser.BrowserMultiFormatReader();
      console.log('✅ ZXing yuklandi (fallback rejim)');
    }
  };
  s.onerror = () => console.warn('ZXing yuklanmadi');
  document.head.appendChild(s);
}

// ─────────────────────────────────────────────
//  KAMERA
// ─────────────────────────────────────────────
async function startCamera() {
  const video = document.getElementById('cameraFeed');
  const cameraOff = document.getElementById('cameraOff');

  try {
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
    video.srcObject = stream;
    video.style.display = 'block';
    cameraOff.style.display = 'none';

    video.addEventListener('loadedmetadata', () => {
      video.play();
      startScanning();
    }, { once: true });
  } catch (err) {
    console.error('Kamera xatosi:', err);
    cameraOff.style.display = 'flex';
    video.style.display = 'none';
    showToast('Kameraga ruxsat berilmagan. Brauzer sozlamalarini tekshiring.');
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
    showToast(APP.torchOn ? '🔦 Fonar yoqildi' : '🔦 Fonar o\'chirildi');
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
//  SCANNING ENGINE
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
//  BARCODE HANDLER
// ─────────────────────────────────────────────
function handleBarcodeDetected(rawCode) {
  if (!rawCode) return;

  // Modal ochiq paytda yoki onlayn qidiruv ketayotganda skanerlashni bloklash
  if (!APP._scanForModal && document.querySelector('.modal-overlay.open')) return;
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
    console.log(`📦 Asl Belgisi QR kod o'qildi: ${rawCode} -> GTIN: ${code}`);
  }

  // ─── Modal uchun skaner rejimi ───
  // scanForModal() chaqirilganda navbatdagi skanlangan kodni modal ga yozamiz
  if (APP._scanForModal) {
    APP._scanForModal = false;
    const barcodeInput = document.getElementById('productBarcode');
    if (barcodeInput) barcodeInput.value = code;
    openModal('addProductModal');
    showToast(`✅ Kod kiritildi: ${code}`);
    updateScanHint('Shtrix-kodni ramka ichiga oling', '');
    return;
  }

  // Mahsulotni qidirish
  const product = findProductByBarcode(code);

  if (product) {
    // ✅ Topildi — savatga qo'sh (addToCart o'zi SOUNDS.tiq() tovushini beradi)
    addToCart(product);
    showScanSuccess(product);
    updateScanHint(`✅ ${product.name}`, 'success');
  } else {
    // ❌ Mahalliy bazada topilmadi — internetdan qidiramiz
    APP.isLookingUpOnline = true;
    SOUNDS.error();
    updateScanHint(`🌐 ${code} internetdan qidirilmoqda...`, 'success');
    showToast(`🌐 Kod: ${code} — qidirilmoqda...`);
    vibrateDevice([100, 50, 100]);

    // Async internet qidiruv
    lookupBarcodeOnline(code).then(result => {
      if (result) {
        // ✅ Internet da topildi — modalni avtomatik to'ldirish
        updateScanHint(`✅ Internetdan topildi: ${result.name}`, 'success');
        showToast(`✅ "${result.name}" topildi!`);
        vibrateDevice([80, 40, 80]);
        openAddProductModalWithData(result, code, rawCode);
      } else {
        // ❌ Internetda ham topilmadi
        showProductFoundCard(null, code);
        updateScanHint(`❌ Kod: ${code} — yangi mahsulot`, 'error');
        showToast(`❌ "${code}" topilmadi. Yangi mahsulot qo'shing.`);
        openAddProductModalWithData({ name: '', image: null, category: 'boshqa', brand: '' }, code, rawCode);
      }
    }).catch(() => {
      showProductFoundCard(null, code);
      updateScanHint(`❌ Internet yo'q — yangi mahsulot`, 'error');
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
  hint.textContent = text;
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
  addToCart(APP.foundProduct);
  document.getElementById('productFoundCard').style.display = 'none';
  document.getElementById('manualBarcodeInput').value = '';
  APP.foundProduct = null;
}

// ─────────────────────────────────────────────
//  TEZKOR KODSIZ TOVARLAR (QUICK ITEMS)
// ─────────────────────────────────────────────
const DEFAULT_QUICK_ITEMS = [
  { id: 'q_paket_500', name: 'Paket (oddiy)', price: 500, emoji: '🛍️', category: 'uy' },
  { id: 'q_paket_1000', name: 'Katta paket', price: 1000, emoji: '🛍️', category: 'uy' },
  { id: 'q_non_4000', name: 'Tandir non', price: 4000, emoji: '🍞', category: 'non' },
  { id: 'q_patir_7000', name: 'Patir non', price: 7000, emoji: '🥖', category: 'non' },
  { id: 'q_tuxum_1500', name: 'Tuxum (1 dona)', price: 1500, emoji: '🥚', category: 'oziq' },
  { id: 'q_suv_3000', name: 'Muzdek suv 0.5L', price: 3000, emoji: '💧', category: 'suv_05' },
  { id: 'q_tarvuz_15000', name: 'Tarvuz (dona)', price: 15000, emoji: '🍉', category: 'oziq' },
  { id: 'q_qovun_18000', name: 'Qovun (dona)', price: 18000, emoji: '🍈', category: 'oziq' }
];

function loadQuickItems() {
  try {
    const raw = localStorage.getItem('scanpos_quick_items');
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
    localStorage.setItem('scanpos_quick_items', JSON.stringify(APP.quickItems));
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
        <span class="quick-item-emoji">${item.emoji || '⚡'}</span>
        <button class="quick-item-del" onclick="event.stopPropagation(); deleteQuickItem('${item.id}')" title="O'chirish">✕</button>
      </div>
      <div class="quick-item-name">${escHtml(item.name)}</div>
      <div class="quick-item-price">${formatPriceShort(item.price)} so'm</div>
    </div>
  `).join('');

  const addBtnHtml = `
    <button type="button" class="quick-item-add-card" onclick="openQuickItemModal()" title="Yangi tezkor tovar qo'shish">
      <span class="quick-add-icon">＋</span>
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
    barcode: item.barcode || ('QUICK_' + item.id),
    category: item.category || 'boshqa',
    stock: 999
  };

  addToCart(productObj);

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
  document.getElementById('quickItemEmoji').value = item?.emoji || '🛍️';
  document.getElementById('quickItemCategory').value = item?.category || 'uy';
  openModal('quickItemModal');
}

function saveQuickItem() {
  const name = document.getElementById('quickItemName').value.trim();
  const price = Number(document.getElementById('quickItemPrice').value);
  const emoji = document.getElementById('quickItemEmoji').value;
  const category = document.getElementById('quickItemCategory').value;

  if (!name) {
    showToast('Iltimos, tovar nomini kiriting');
    return;
  }
  if (!price || price <= 0) {
    showToast('Iltimos, tovar narxini to\'g\'ri kiriting');
    return;
  }

  const newItem = {
    id: 'q_' + Date.now(),
    name,
    price,
    emoji,
    category
  };

  APP.quickItems.push(newItem);
  saveQuickItems();
  renderQuickItems();
  closeModal('quickItemModal');
  if (typeof SOUNDS !== 'undefined') SOUNDS.pop();
  showToast(`✅ "${name}" tezkor tovarlarga qo'shildi!`);
}

function deleteQuickItem(itemId) {
  const item = APP.quickItems.find(q => q.id === itemId);
  if (!item) return;
  if (!confirm(`"${item.name}" tezkor tovarini o'chirishni xohlaysizmi?`)) return;

  APP.quickItems = APP.quickItems.filter(q => q.id !== itemId);
  saveQuickItems();
  renderQuickItems();
  showToast(`🗑️ "${item.name}" o'chirildi`);
}

// ─────────────────────────────────────────────
//  CART (SAVAT)
// ─────────────────────────────────────────────
function addToCart(product) {
  const isQuick = product.stock === 999; // Tezkor kodsiz tovar — cheklanmagan

  // Stock tekshiruvi (tezkor tovarlar bundan mustasno)
  if (!isQuick) {
    const existing = APP.cart.find(i => i.id === product.id);
    const cartQty = existing ? existing.qty : 0;
    if (product.stock <= 0) {
      if (typeof SOUNDS !== 'undefined') SOUNDS.error();
      showToast(`⚠️ ${product.name} — omborda qolmagan!`);
      return;
    }
    if (cartQty + 1 > product.stock) {
      if (!confirm(`⚠️ Omborda ${product.stock} ta mavjud. ${cartQty + 1} ta qo'shilsinmi?`)) return;
    }
  }

  // Tovush berish (Korzinka kassa skaneri "TIQ!" tovushi)
  if (typeof SOUNDS !== 'undefined') SOUNDS.tiq();

  const existing = APP.cart.find(i => i.id === product.id);
  if (existing) {
    existing.qty++;
    showToast(`${product.name} → ${existing.qty} ta`);
  } else {
    APP.cart.push({ ...product, qty: 1 });
    showToast(`${product.name} savatga qo'shildi`);
  }
  updateCartUI();
}

function removeFromCart(productId) {
  APP.cart = APP.cart.filter(i => i.id !== productId);
  updateCartUI();
}

function changeQty(productId, delta) {
  const item = APP.cart.find(i => i.id === productId);
  if (!item) return;
  item.qty += delta;
  if (typeof SOUNDS !== 'undefined' && delta > 0) SOUNDS.pop();
  if (item.qty <= 0) {
    APP.cart = APP.cart.filter(i => i.id !== productId);
  }
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
  // Savatni localStorage ga saqlash (reload bo'lganda yo'qolmasligi uchun)
  try {
    localStorage.setItem('scanpos_cart', JSON.stringify(APP.cart || []));
  } catch (e) {}

  const cartList = document.getElementById('cartList');
  const emptyCart = document.getElementById('emptyCart');
  const cartFooter = document.getElementById('cartFooter');
  const clearCartBtn = document.getElementById('clearCartBtn');
  const cartCount = document.getElementById('cartCount');

  cartCount.textContent = APP.cart.reduce((s, i) => s + i.qty, 0);

  if (APP.cart.length === 0) {
    emptyCart.style.display = 'flex';
    cartFooter.style.display = 'none';
    clearCartBtn.style.display = 'none';
    cartList.innerHTML = '';
    return;
  }

  emptyCart.style.display = 'none';
  cartFooter.style.display = 'block';
  clearCartBtn.style.display = 'inline-flex';

  // Subtotal
  const subtotal = APP.cart.reduce((s, i) => s + i.price * i.qty, 0);
  const tax = subtotal * (parseFloat(APP.settings.taxRate || 0) / 100);
  const grand = subtotal + tax;

  document.getElementById('totalItems').textContent = APP.cart.reduce((s, i) => s + i.qty, 0) + ' ta';
  document.getElementById('subtotalAmt').textContent = formatPrice(subtotal);
  document.getElementById('grandTotal').textContent = formatPrice(grand);
  document.getElementById('checkoutTotal').textContent = formatPrice(grand);

  // Tax row
  if (tax > 0) {
    document.getElementById('discountRow').style.display = 'flex';
    document.getElementById('discountAmt').textContent = `+${formatPrice(tax)} (QQS)`;
    document.getElementById('discountAmt').style.color = '#f59e0b';
  } else {
    document.getElementById('discountRow').style.display = 'none';
  }

  // Render items
  cartList.innerHTML = APP.cart.map((item, idx) => `
    <li class="cart-item" id="cart-item-${item.id}">
      <div class="item-num">${idx + 1}</div>
      <div class="item-thumb-box">
        ${item.image ? `<img src="${escHtml(item.image)}" class="item-thumb-img" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : ''}
        <span class="item-thumb-fallback" style="${item.image ? 'display:none' : 'display:flex'}">${catEmoji[item.category] || '📦'}</span>
      </div>
      <div class="item-info">
        <div class="item-name">${escHtml(item.name)}</div>
        <div class="item-barcode">${escHtml(item.barcode)}</div>
      </div>
      <div class="item-qty-control">
        <button class="qty-btn" onclick="changeQty('${item.id}', -1)">−</button>
        <span class="qty-num">${item.qty}</span>
        <button class="qty-btn" onclick="changeQty('${item.id}', 1)">+</button>
      </div>
      <div class="item-price">
        <div class="item-price-each">${formatPrice(item.price)}/ta</div>
        <div class="item-price-total">${formatPrice(item.price * item.qty)}</div>
      </div>
      <button class="item-remove" onclick="removeFromCart('${item.id}')">✕</button>
    </li>
  `).join('');
}

// ─────────────────────────────────────────────
//  CHECKOUT (TO'LOV)
// ─────────────────────────────────────────────
function proceedToCheckout() {
  if (APP.cart.length === 0) { showToast('Savat bo\'sh'); return; }

  const subtotal = APP.cart.reduce((s, i) => s + i.price * i.qty, 0);
  const tax = subtotal * (parseFloat(APP.settings.taxRate || 0) / 100);
  const grand = subtotal + tax;

  document.getElementById('checkoutAmount').textContent = formatPrice(grand);
  document.getElementById('cashGiven').value = '';
  document.getElementById('changeDisplay').style.display = 'none';
  document.getElementById('discountPercent').value = '';

  // Chegirma bo'limi
  const discountSection = document.getElementById('discountSection');
  discountSection.style.display = APP.settings.discountEnabled ? 'block' : 'none';

  APP.selectedPayment = 'cash';
  selectPayment('cash');

  openModal('checkoutModal');
}

function selectPayment(type) {
  APP.selectedPayment = type;
  ['cash', 'card', 'transfer'].forEach(t => {
    const el = document.getElementById(`pm-${t}`);
    if (el) el.classList.toggle('active', t === type);
  });
  const cashSection = document.getElementById('cashChangeSection');
  if (cashSection) cashSection.style.display = type === 'cash' ? 'block' : 'none';
}

function calcChange() {
  const subtotal = APP.cart.reduce((s, i) => s + i.price * i.qty, 0);
  const discountInput = document.getElementById('discountPercent');
  const rawPct = parseFloat(discountInput ? discountInput.value : 0) || 0;
  const pct = Math.min(100, Math.max(0, rawPct));
  const discount = subtotal * (pct / 100);
  const tax = subtotal * (parseFloat(APP.settings.taxRate || 0) / 100);
  const grand = Math.max(subtotal - discount + tax, 0);
  const given = parseFloat(document.getElementById('cashGiven').value) || 0;
  const change = given - grand;

  const display = document.getElementById('changeDisplay');
  const changeEl = document.getElementById('changeAmount');

  if (given > 0) {
    display.style.display = 'flex';
    if (change >= 0) {
      changeEl.textContent = formatPrice(change);
      changeEl.style.color = '#22c55e';
    } else {
      changeEl.textContent = `Yetishmaydi: ${formatPrice(Math.abs(change))}`;
      changeEl.style.color = '#ef4444';
    }
  } else {
    display.style.display = 'none';
  }
}

function applyDiscount() {
  const discountInput = document.getElementById('discountPercent');
  let rawPct = parseFloat(discountInput.value) || 0;
  // 0–100% oralig'ida cheklash
  if (rawPct < 0) rawPct = 0;
  if (rawPct > 100) rawPct = 100;
  if (discountInput.value !== '' && !isNaN(rawPct)) {
    discountInput.value = rawPct;
  }
  const pct = rawPct;
  const subtotal = APP.cart.reduce((s, i) => s + i.price * i.qty, 0);
  const discount = subtotal * (pct / 100);
  const tax = subtotal * (parseFloat(APP.settings.taxRate || 0) / 100);
  const grand = Math.max(subtotal - discount + tax, 0);
  document.getElementById('checkoutAmount').textContent = formatPrice(grand);
  // Chegirma o'zgarganda qaytimni ham qayta hisoblash
  calcChange();
}

async function completeSale() {
  // Ikki marta bosishdan himoya
  if (APP.isCheckingOut) return;
  APP.isCheckingOut = true;

  const confirmBtn = document.querySelector('#checkoutModal .btn-success') || document.querySelector('#checkoutModal button[onclick*="completeSale"]');
  if (confirmBtn) confirmBtn.disabled = true;

  try {
    const subtotal = APP.cart.reduce((s, i) => s + i.price * i.qty, 0);
    const rawDiscountPct = parseFloat(document.getElementById('discountPercent').value) || 0;
    const discountPct = Math.min(100, Math.max(0, rawDiscountPct));
    const discount = subtotal * (discountPct / 100);
    const tax = subtotal * (parseFloat(APP.settings.taxRate || 0) / 100);
    const grand = Math.max(subtotal - discount + tax, 0);

    // Naqd to'lovda yetarlilik tekshiruvi
    const cashGivenVal = parseFloat(document.getElementById('cashGiven').value) || 0;
    if (APP.selectedPayment === 'cash' && cashGivenVal > 0 && cashGivenVal < grand) {
      showToast('Yetarli pul kiritilmagan');
      return;
    }

    const cashGiven = APP.selectedPayment === 'cash' ? cashGivenVal : 0;
    const change = APP.selectedPayment === 'cash' ? Math.max(0, cashGiven - grand) : 0;

    const bill = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      items: APP.cart.map(i => ({ ...i })),
      subtotal,
      discount,
      discountPercent: discountPct,
      tax,
      total: grand,
      paymentMethod: APP.selectedPayment,
      shopName: APP.settings.shopName || 'ScanPOS',
      cashGiven,
      change,
    };

    // ── Atomik yozuv: stock kamaytirish + chek saqlash ──
    if (!window.useDemo && window.firebaseDB && window.firebaseFns) {
      // Firebase: bitta writeBatch ichida barcha o'zgarishlar
      const { doc, writeBatch: wb } = window.firebaseFns;
      const batch = wb(window.firebaseDB);
      for (const item of APP.cart) {
        const prod = APP.products.find(p => p.id === item.id);
        if (prod) {
          const currentStock = parseInt(prod.stock, 10) || 0;
          prod.stock = Math.max(0, currentStock - item.qty);
          prod.updatedAt = new Date().toISOString();
          batch.set(doc(window.firebaseDB, 'products', prod.id), prod);
        }
      }
      batch.set(doc(window.firebaseDB, 'bills', bill.id), bill);
      await batch.commit(); // Muvaffaqiyatsiz bo'lsa catch blokiga o'tadi
    } else {
      // Demo/localStorage rejim: barcha o'zgarishlarni bir safar saqlash
      for (const item of APP.cart) {
        const prod = APP.products.find(p => p.id === item.id);
        if (prod) {
          const currentStock = parseInt(prod.stock, 10) || 0;
          prod.stock = Math.max(0, currentStock - item.qty);
          prod.updatedAt = new Date().toISOString();
        }
      }
      APP.bills.unshift(bill);
      saveLocalData();
      renderBills();
    }
    updateProductStats();
    renderProducts();

    // Kassa pul qutisi jiringlashi
    SOUNDS.cash();

    closeModal('checkoutModal');
    APP.cart = [];
    updateCartUI();
    showToast(`✅ To'lov qabul qilindi! ${formatPrice(grand)}`);

    // Chek sahifasiga o'tish
    setTimeout(() => {
      showPage('bills');
      vibrateDevice([100, 50, 200]);
    }, 800);
  } catch (err) {
    console.error('Sotuvni yakunlashda xato:', err);
    showToast('To\'lovni amalga oshirishda xatolik yuz berdi');
  } finally {
    APP.isCheckingOut = false;
    if (confirmBtn) confirmBtn.disabled = false;
  }
}

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
//  AUDIO ENGINE (Haqiqiy Korzinka Skaner "TIQ!" Tovushi)
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
//  VOICE (GAPIRUVCHI ROBOT OVOZI)
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
  showToast(APP.voiceOn ? '🔊 Skaner "Tiq" ovozi yoqildi' : '🔇 Skaner ovozi o\'chirildi');
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
//  SCAN SUCCESS OVERLAY
// ─────────────────────────────────────────────
function showScanSuccess(product) {
  const overlay = document.getElementById('scanSuccessOverlay');
  const media = document.getElementById('scanSuccessMedia');
  document.getElementById('scanSuccessName').textContent = product.name;
  document.getElementById('scanSuccessPrice').textContent = formatPrice(product.price);

  if (media) {
    if (product.image) {
      media.innerHTML = `<img src="${escHtml(product.image)}" class="scan-success-img" alt="${escHtml(product.name)}" onerror="this.outerHTML='<div class=\\'scan-success-icon\\'>✅</div>'">`;
    } else {
      media.innerHTML = `<div class="scan-success-icon">✅</div>`;
    }
  }

  overlay.classList.add('show');
  setTimeout(() => overlay.classList.remove('show'), 2200);
}

// ─────────────────────────────────────────────
//  PRODUCTS (MAHSULOTLAR)
// ─────────────────────────────────────────────
function showAddProductModal(product = null) {
  APP.editingProductId = product ? product.id : null;
  document.getElementById('modalTitle').textContent = product ? 'Mahsulotni tahrirlash' : 'Yangi mahsulot';
  document.getElementById('productName').value = product?.name || '';
  document.getElementById('productBarcode').value = product?.barcode || '';
  document.getElementById('productPrice').value = product?.price || '';
  document.getElementById('productStock').value = product?.stock || '0';
  const cat = product?.category || 'suv_05';
  document.getElementById('productCategory').value = cat;
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

  openModal('addProductModal');
}

/**
 * Internet bazasidan topilgan yoki yangi shtrix-kod ma'lumotlari bilan modalni ochadi.
 */
function openAddProductModalWithData(onlineData, barcode, rawCode = '') {
  APP.editingProductId = null;
  const cleanCode = extractProductBarcode(barcode);

  const isFound = !!(onlineData.name && onlineData.name.trim());

  document.getElementById('modalTitle').textContent = isFound
    ? '🌐 Internetdan topildi'
    : '➕ Yangi mahsulot qo\'shish';

  document.getElementById('productName').value = onlineData.name || '';
  document.getElementById('productBarcode').value = cleanCode || '';
  document.getElementById('productStock').value = '0';
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
      priceHintBadge.textContent = `⚡ Standart: ${formatPriceShort(defaultPrice)} so'm`;
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
    badge.innerHTML = `🌐 <span>Internetdan avtomatik to'ldirildi${onlineData.brand ? ' — ' + escHtml(onlineData.brand) : ''}</span>`;
    modalBody.insertBefore(badge, modalBody.firstChild);
  } else if (modalBody && !isFound) {
    // Topilmadi — sariq ogohlantirish badge
    const badge = document.createElement('div');
    badge.id = 'onlineBadge';
    badge.style.cssText = 'background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35);border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:0.8rem;color:#f59e0b;display:flex;align-items:center;gap:6px';
    badge.innerHTML = `⚠️ <span>Internetda topilmadi. Shablonlardan tanlang yoki nom va narxni kiriting — keyingi skanerlashda avtomatik eslab qoladi!</span>`;
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
      <span>${catEmoji[p.category] || '📦'} ${escHtml(p.name)}</span>
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
    priceHintBadge.textContent = `⚡ Shablon: ${formatPriceShort(p.price)} so'm`;
    priceHintBadge.style.display = 'inline-block';
  }

  updateSyncCategoryUI(p.category);
  showToast(`✅ "${p.name}" shablon narxi va ma'lumotlari nusxalandi!`);
}

function linkCurrentBarcodeToProduct() {
  if (!APP._currentLinkTargetId) return;
  const target = APP.products.find(p => p.id === APP._currentLinkTargetId);
  if (!target) return;

  const barcodeInput = document.getElementById('productBarcode');
  const codeToLink = extractProductBarcode(barcodeInput?.value.trim());

  if (!codeToLink) {
    showToast('Shtrix-kod mavjud emas');
    return;
  }

  if (target.barcode === codeToLink) {
    showToast('Bu mahsulotning asosiy kodi bilan bir xil');
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
  showToast(`✅ "${codeToLink}" kodi "${target.name}" ga biriktirildi!`);
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
      priceHintBadge.textContent = `⚡ Standart: ${formatPriceShort(defPrice)} so'm`;
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
    const compressedBase64 = await compressImage(file, 480, 480, 0.82);
    setModalProductImage(compressedBase64);
    showToast('✅ Mahsulot rasmi yuklandi');
  } catch (err) {
    console.error('Rasm yuklash xatosi:', err);
    showToast('Rasmni yuklashda xatolik yuz berdi');
  } finally {
    event.target.value = '';
  }
}

/** Rasmni avtomatik qisqartirish (Base64 JPEG) */
function compressImage(file, maxWidth = 480, maxHeight = 480, quality = 0.82) {
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

  showToast('🌐 Internetdan haqiqiy fotosurat qidirilmoqda...');

  // 1. Shtrix-kod orqali qidiruv
  if (barcode) {
    try {
      const res = await lookupBarcodeOnline(barcode);
      if (res && res.image) {
        setModalProductImage(res.image);
        showToast('✅ Internetdan haqiqiy rasm topildi!');
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
          showToast(`✅ "${name}" uchun haqiqiy rasm topildi!`);
          return;
        }
      }
    } catch (e) {
      console.warn(e);
    }
  }

  showToast('❌ Internetdan bu mahsulot rasmi topilmadi. Kamera yoki galereyadan yuklang.');
}

async function saveProduct() {
  const name = document.getElementById('productName').value.trim();
  const rawBarcode = document.getElementById('productBarcode').value.trim();
  const barcode = extractProductBarcode(rawBarcode);
  const price = parseFloat(document.getElementById('productPrice').value);
  const stock = parseInt(document.getElementById('productStock').value) || 0;
  const category = document.getElementById('productCategory').value;
  const image = document.getElementById('productImage')?.value || null;
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

  const roundedPrice = Math.round(price);

  const product = {
    id: APP.editingProductId || generateId(),
    name, barcode,
    price: roundedPrice,
    stock,
    category,
    image,
    updatedAt: new Date().toISOString(),
  };

  // Agar tahrirlanayotgan mahsulotda mavjud barcodes bo'lsa saqlab qolamiz
  if (APP.editingProductId) {
    const prev = APP.products.find(p => p.id === APP.editingProductId);
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
    showToast(`✅ ${name} saqlandi! Toifadagi ${syncedCount} ta mahsulot narxi ham ${formatPrice(roundedPrice)} ga yangilandi!`);
  } else if (!APP.editingProductId) {
    // Yangi mahsulot — Korzinka skaneri "TIQ!" tovushi
    SOUNDS.tiq();
    showToast(`✅ ${name} saqlandi! Endi skanlashda avtomatik taniladi.`);
  } else {
    SOUNDS.pop();
    showToast(`✅ ${name} yangilandi`);
  }
}

async function saveProductToDB(product) {
  if (!window.useDemo && window.firebaseDB) {
    try {
      const { doc, setDoc } = window.firebaseFns;
      await setDoc(doc(window.firebaseDB, 'products', product.id), product);
      return;
    } catch (e) {
      console.error('Firebase saqlash xato:', e);
    }
  }
  // localStorage fallback
  const idx = APP.products.findIndex(p => p.id === product.id);
  if (idx >= 0) APP.products[idx] = product;
  else APP.products.push(product);
  saveLocalData();
  renderProducts();
}

async function deleteProduct(productId) {
  if (!confirm('Mahsulotni o\'chirishni tasdiqlaysizmi?')) return;

  if (!window.useDemo && window.firebaseDB) {
    try {
      const { doc, deleteDoc } = window.firebaseFns;
      await deleteDoc(doc(window.firebaseDB, 'products', productId));
      showToast('Mahsulot o\'chirildi');
      return;
    } catch (e) {
      console.error('Firebase o\'chirish xato:', e);
    }
  }
  APP.products = APP.products.filter(p => p.id !== productId);
  saveLocalData();
  renderProducts();
  showToast('Mahsulot o\'chirildi');
}

async function deleteAllProducts() {
  if (!confirm('BARCHA mahsulotlarni o\'chirishni tasdiqlaysizmi?')) return;

  // Firebase rejimida Firestore'dan ham batch orqali o'chirish
  if (!window.useDemo && window.firebaseDB && window.firebaseFns) {
    try {
      const { collection, getDocs, writeBatch } = window.firebaseFns;
      const snapshot = await getDocs(collection(window.firebaseDB, 'products'));
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
      console.error('Firestore mahsulotlarni o\'chirish xatosi:', e);
    }
  }

  APP.products = [];
  saveLocalData();
  renderProducts();
  showToast('Barcha mahsulotlar o\'chirildi');
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

function renderProducts() {
  renderProductGrid(APP.products);
  updateProductStats();
}

function renderProductGrid(products) {
  const grid = document.getElementById('productGrid');
  if (!products || products.length === 0) {
    grid.innerHTML = `<div class="empty-state">
      <div style="font-size:3rem;">📦</div>
      <p>Mahsulot yo'q</p>
      <span style="font-size:0.8rem;color:var(--text3)">Yangi mahsulot qo'shish uchun + tugmasini bosing</span>
    </div>`;
    return;
  }

  grid.innerHTML = products.map(p => `
    <div class="product-card" onclick="editProductById('${p.id}')">
      <div class="product-card-thumb">
        ${p.image ? `<img src="${escHtml(p.image)}" class="product-card-img" alt="${escHtml(p.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : ''}
        <span class="product-emoji" style="${p.image ? 'display:none' : 'display:flex'}">${catEmoji[p.category] || '📦'}</span>
      </div>
      <div class="product-card-info">
        <div class="product-card-name">${escHtml(p.name)}</div>
        <div class="product-card-barcode">${escHtml(p.barcode)}</div>
        <div class="product-card-meta">
          <span class="product-card-price">${formatPrice(p.price)}</span>
          <span class="product-card-stock">Ombor: ${p.stock} ta</span>
        </div>
      </div>
      <div class="product-card-actions" onclick="event.stopPropagation()">
        <button class="btn-edit" onclick="editProductById('${p.id}')" title="Tahrirlash">✏️</button>
        <button class="btn-del" onclick="deleteProduct('${p.id}')" title="O'chirish">🗑️</button>
      </div>
    </div>
  `).join('');
}

function editProduct(product) {
  showAddProductModal(product);
}

function editProductById(productId) {
  const p = APP.products.find(item => item.id === productId);
  if (p) showAddProductModal(p);
}

function updateProductStats() {
  document.getElementById('totalProductsCount').textContent = APP.products.length;
  const totalVal = APP.products.reduce((s, p) => s + (p.price * (p.stock || 0)), 0);
  document.getElementById('totalStockValue').textContent = formatPriceShort(totalVal);
}

// Modal ichidan skaner
function scanForModal() {
  closeModal('addProductModal');
  showPage('scanner');
  APP._scanForModal = true;
  showToast('📷 Shtrix-kodni kameraga ko\'rsating — avtomatik kiritiladi');
  updateScanHint('📋 Modal uchun skanerlash rejimi...', 'success');
}

// ─────────────────────────────────────────────
//  FIREBASE REAL-TIME LISTENERS
// ─────────────────────────────────────────────
function listenFirestoreProducts() {
  const { collection, onSnapshot } = window.firebaseFns;
  onSnapshot(collection(window.firebaseDB, 'products'), (snap) => {
    APP.products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderProducts();
  });
}

function listenFirestoreBills() {
  const { collection, onSnapshot } = window.firebaseFns;
  onSnapshot(collection(window.firebaseDB, 'bills'), (snap) => {
    APP.bills = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    renderBills();
  });
}

// ─────────────────────────────────────────────
//  BILLS (CHEKLAR)
// ─────────────────────────────────────────────
async function saveBill(bill) {
  if (!window.useDemo && window.firebaseDB) {
    try {
      const { doc, setDoc } = window.firebaseFns;
      await setDoc(doc(window.firebaseDB, 'bills', bill.id), bill);
      return;
    } catch (e) {
      console.error('Chek saqlash xato:', e);
    }
  }
  APP.bills.unshift(bill);
  saveLocalData();
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
    list.innerHTML = `<div class="empty-state"><div style="font-size:3rem;">🧾</div><p>Hali chek yo'q</p></div>`;
    return;
  }

  const methodLabel = { cash: '💵 Naqd', card: '💳 Karta', transfer: '📲 O\'tkazma' };

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

async function clearAllBills() {
  if (APP.bills.length === 0) return;
  if (!confirm('Barcha cheklar tarixini o\'chirishni tasdiqlaysizmi?')) return;

  // Firebase rejimida Firestore'dan ham batch orqali o'chirish
  if (!window.useDemo && window.firebaseDB && window.firebaseFns) {
    try {
      const { collection, getDocs, writeBatch } = window.firebaseFns;
      const snapshot = await getDocs(collection(window.firebaseDB, 'bills'));
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
//  DEMO PRODUCTS
// ─────────────────────────────────────────────
async function loadDemoProducts() {
  const demoProducts = [
    { id: generateId(), name: 'Coca-Cola 500ml', barcode: '5449000000996', price: 8000, stock: 48, category: 'ichimlik', image: 'https://images.openfoodfacts.org/images/products/544/900/000/0996/front_en.1129.400.jpg', createdAt: new Date().toISOString() },
    { id: generateId(), name: 'Pepsi Cola Can', barcode: '0012000000133', price: 9000, stock: 35, category: 'ichimlik', image: 'https://images.openfoodfacts.org/images/products/001/200/000/0133/front_fr.16.400.jpg', createdAt: new Date().toISOString() },
    { id: generateId(), name: 'Snickers 50g', barcode: '5000159461122', price: 7000, stock: 60, category: 'shirinlik', image: 'https://images.openfoodfacts.org/images/products/500/015/946/1122/front_en.357.400.jpg', createdAt: new Date().toISOString() },
    { id: generateId(), name: 'Lay\'s Original 75g', barcode: '0028400064088', price: 15000, stock: 25, category: 'shirinlik', image: 'https://images.openfoodfacts.org/images/products/002/840/006/4088/front_en.17.400.jpg', createdAt: new Date().toISOString() },
    { id: generateId(), name: 'Nutella 400g', barcode: '3017620422003', price: 38000, stock: 20, category: 'shirinlik', image: 'https://images.openfoodfacts.org/images/products/301/762/042/2003/front_en.879.400.jpg', createdAt: new Date().toISOString() },
    { id: generateId(), name: 'Red Bull 250ml', barcode: '9002490100070', price: 18000, stock: 30, category: 'ichimlik', image: 'https://images.openfoodfacts.org/images/products/900/249/010/0070/front_en.245.400.jpg', createdAt: new Date().toISOString() },
    { id: generateId(), name: 'Oreo Prince 300g', barcode: '7622210449283', price: 16000, stock: 40, category: 'shirinlik', image: 'https://images.openfoodfacts.org/images/products/762/221/044/9283/front_en.605.400.jpg', createdAt: new Date().toISOString() },
    { id: generateId(), name: 'Tog\' Suvi 1.5L', barcode: '3274080005003', price: 4000, stock: 100, category: 'ichimlik', image: 'https://images.openfoodfacts.org/images/products/327/408/000/5003/front_en.797.400.jpg', createdAt: new Date().toISOString() },
    { id: generateId(), name: 'Non (1 dona)', barcode: '4607086563499', price: 3000, stock: 20, category: 'oziq', image: null, createdAt: new Date().toISOString() },
    { id: generateId(), name: 'Tuxum (10 dona)', barcode: '4607086563001', price: 28000, stock: 15, category: 'oziq', image: null, createdAt: new Date().toISOString() },
    { id: generateId(), name: 'Sut 1L', barcode: '4607006750018', price: 12000, stock: 30, category: 'sut', image: null, createdAt: new Date().toISOString() },
    { id: generateId(), name: 'Ariel Kapsula', barcode: '8001090544179', price: 75000, stock: 10, category: 'uy', image: null, createdAt: new Date().toISOString() },
  ];

  for (const p of demoProducts) {
    await saveProductToDB(p);
  }
  showToast(`${demoProducts.length} ta demo mahsulot haqiqiy rasmlari bilan yuklandi ✅`);
}

// ─────────────────────────────────────────────
//  SETTINGS
// ─────────────────────────────────────────────
function loadSettings() {
  try {
    const saved = localStorage.getItem('scanpos_settings');
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
  };
  localStorage.setItem('scanpos_settings', JSON.stringify(APP.settings));
  APP.voiceOn = APP.settings.voiceEnabled;
}

function updateFirebaseStatus() {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  if (!dot || !text) return;

  if (!window.useDemo && window.firebaseDB) {
    dot.className = 'status-dot online';
    text.textContent = 'Firebase ulangan ✅';
  } else {
    dot.className = 'status-dot offline';
    text.textContent = 'Demo rejim (offline) ⚠️';
  }
}

// ─────────────────────────────────────────────
//  LOCAL STORAGE
// ─────────────────────────────────────────────
function loadLocalData() {
  loadCategoryPrices();
  try {
    const p = localStorage.getItem('scanpos_products');
    const b = localStorage.getItem('scanpos_bills');
    const c = localStorage.getItem('scanpos_cart');
    if (p) APP.products = JSON.parse(p);
    if (b) APP.bills = JSON.parse(b);
    if (c) {
      APP.cart = JSON.parse(c);
      updateCartUI();
    }
  } catch (e) {
    console.warn('loadLocalData xato:', e);
  }
  // Nasiya ma'lumotlarini ham yuklash
  loadNasiyaData();
}

function saveLocalData() {
  try {
    localStorage.setItem('scanpos_products', JSON.stringify(APP.products));
    localStorage.setItem('scanpos_bills', JSON.stringify(APP.bills));
    localStorage.setItem('scanpos_cart', JSON.stringify(APP.cart || []));
  } catch (e) {
    console.warn('LocalStorage quota to\'ldi yoki xato berdi, fallback qo\'llanmoqda:', e);
    try {
      // Base64 rasmlar kvotani to'ldirgan bo'lsa, rasmlarsiz yengil nusxasini saqlash
      const slimProducts = (APP.products || []).map(p => {
        if (p.image && p.image.startsWith('data:')) {
          const { image, ...rest } = p;
          return rest;
        }
        return p;
      });
      localStorage.setItem('scanpos_products', JSON.stringify(slimProducts));
      localStorage.setItem('scanpos_bills', JSON.stringify((APP.bills || []).slice(0, 100)));
      localStorage.setItem('scanpos_cart', JSON.stringify(APP.cart || []));
    } catch (err) {
      console.error('LocalStorage ga saqlab bo\'lmadi:', err);
    }
  }
}

// ─────────────────────────────────────────────
//  UI HELPERS
// ─────────────────────────────────────────────
function showPage(page) {
  // Eski sahifani yashirish
  document.getElementById(`page-${APP.currentPage}`)?.classList.remove('active');
  document.getElementById(`bnav-${APP.currentPage}`)?.classList.remove('active');

  APP.currentPage = page;

  document.getElementById(`page-${page}`)?.classList.add('active');
  document.getElementById(`bnav-${page}`)?.classList.add('active');

  // Kamera boshqaruvi
  if (page === 'scanner') {
    if (!APP.cameraStream) startCamera();
    else if (!APP.scanning) startScanning();
  } else {
    // Kamerani to'xtatmaymiz — faqat loop ni to'xtatamiz (optimallashtirish uchun)
    // stopCamera() // kamera sahifalar orasida ham yoqiq qolsin
  }
}

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
function showToast(msg) {
  const toast = document.getElementById('toastMsg');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

// ─────────────────────────────────────────────
//  FORMATTING
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
    .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────
//  KEYBOARD SHORTCUT (barcode scanner hardware)
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
//  MODAL OUTSIDE CLICK
// ─────────────────────────────────────────────
document.addEventListener('click', (e) => {
  // Faqat to'g'ridan-to'g'ri overlay ga bosilganda yopilsin (modal ichidagi elementlarga emas)
  if (e.target.classList.contains('modal-overlay') && e.target.id) {
    closeModal(e.target.id);
  }
});

// ─────────────────────────────────────────────
//  EXPOSE GLOBALS
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
window.deleteAllProducts = deleteAllProducts;
window.filterProducts = filterProducts;
window.loadDemoProducts = loadDemoProducts;
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

// ─────────────────────────────────────────────
//  ANALYTICS MODULE
// ─────────────────────────────────────────────
const ANALYTICS = {
  period: 'week',   // 'week' | 'month'
  charts: {},       // Chart instances
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

  // ── Top stats ──
  const totalRevenue = filtered.reduce((s, b) => s + b.total, 0);
  const totalBills = filtered.length;
  const totalItems = filtered.reduce((s, b) => s + b.items.reduce((si, i) => si + i.qty, 0), 0);
  const avgBill = totalBills > 0 ? totalRevenue / totalBills : 0;

  document.getElementById('anTotalRevenue').textContent = formatPriceShort(totalRevenue) + ' so\'m';
  document.getElementById('anTotalBills').textContent = totalBills;
  document.getElementById('anTotalItems').textContent = totalItems;
  document.getElementById('anAvgBill').textContent = formatPriceShort(avgBill) + ' so\'m';

  // ── TOP-5 products (Chart.js ga bog'liq emas) ──
  buildTopProducts(filtered);

  // Agar Chart.js yuklanmagan bo'lsa xatolik bermay to'xtash
  if (typeof Chart === 'undefined') {
    console.warn('Chart.js mavjud emas yoki yuklanmagan');
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
  const cash  = bills.filter(b => b.paymentMethod === 'cash').reduce((s, b) => s + b.total, 0);
  const card  = bills.filter(b => b.paymentMethod === 'card').reduce((s, b) => s + b.total, 0);
  const trans = bills.filter(b => b.paymentMethod === 'transfer').reduce((s, b) => s + b.total, 0);

  const ctx = document.getElementById('paymentChart');
  if (!ctx) return;
  if (ANALYTICS.charts.payment) ANALYTICS.charts.payment.destroy();

  const total = cash + card + trans || 1;
  const pct = v => Math.round(v / total * 100);

  ANALYTICS.charts.payment = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['💵 Naqd', '💳 Karta', '📲 O\'tkazma'],
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
      { label: '💵 Naqd', val: cash, color: '#22c55e' },
      { label: '💳 Karta', val: card, color: '#a855f7' },
      { label: '📲 O\'tkazma', val: trans, color: '#06b6d4' },
    ];
    legend.innerHTML = items.map(it => `
      <div class="pay-legend-item">
        <span class="pay-legend-dot" style="background:${it.color}"></span>
        <span>${it.label}</span>
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
  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

  if (sorted.length === 0) {
    list.innerHTML = '<div style="color:var(--text3);text-align:center;padding:20px">Ma\'lumot yo\'q</div>';
    return;
  }

  list.innerHTML = sorted.map(([name, qty], i) => `
    <div class="top-product-row">
      <span class="top-product-medal">${medals[i]}</span>
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
//  NASIYA DAFTAR MODULE
// ═════════════════════════════════════════════

// ── Ma'lumotlarni yuklash / saqlash ──
function loadNasiyaData() {
  try {
    const d = localStorage.getItem('scanpos_debtors');
    const t = localStorage.getItem('scanpos_debts');
    if (d) APP.debtors = JSON.parse(d);
    if (t) APP.debts = JSON.parse(t);
  } catch (e) { console.warn('Nasiya yuklash xato:', e); }
}

function saveNasiyaData() {
  try {
    localStorage.setItem('scanpos_debtors', JSON.stringify(APP.debtors));
    localStorage.setItem('scanpos_debts', JSON.stringify(APP.debts));
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
        <div style="font-size:3rem">📒</div>
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
    const statusEmoji = isPaid ? '✅' : '🔴';

    return `
    <div class="debtor-card ${statusClass}">
      <div class="debtor-card-main" onclick="toggleDebtorDetail('${debtor.id}')">
        <div class="debtor-avatar">${debtor.name[0].toUpperCase()}</div>
        <div class="debtor-info">
          <div class="debtor-name">${escHtml(debtor.name)} <span class="debtor-status">${statusEmoji}</span></div>
          <div class="debtor-meta">
            ${debtor.phone ? `<a href="tel:${debtor.phone}" onclick="event.stopPropagation()">📞 ${debtor.phone}</a>` : '👤 Telefon yo\'q'}
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
          <span>💸 Berildi: <b>${formatPrice(totalGiven)}</b></span>
          <span>✅ To'landi: <b>${formatPrice(totalPaid)}</b></span>
        </div>
        <div class="debtor-actions">
          <button class="btn-primary btn-sm" onclick="openAddDebtModal('${debtor.id}', '${escHtml(debtor.name)}'); event.stopPropagation()">
            + Nasiya
          </button>
          <button class="btn-secondary btn-sm" onclick="editDebtor('${debtor.id}'); event.stopPropagation()">
            ✏️ Tahrirlash
          </button>
          <button class="btn-danger btn-sm" onclick="deleteDebtor('${debtor.id}'); event.stopPropagation()">
            🗑️ O'chirish
          </button>
        </div>
        <!-- Nasiyalar ro'yxati -->
        <div class="debt-items">
          ${debtorDebts.length === 0 ? '<p style="color:var(--text3);font-size:0.85rem">Nasiya yo\'q</p>' : debtorDebts.map(dt => {
            const dtBalance = dt.amount - dt.paidAmount;
            const dtDate = new Date(dt.createdAt).toLocaleDateString('uz-UZ');
            const isOverdue = dt.dueDate && new Date(dt.dueDate) < new Date() && dtBalance > 0;
            return `
            <div class="debt-item ${dtBalance <= 0 ? 'debt-item-paid' : isOverdue ? 'debt-item-overdue' : ''}">
              <div class="debt-item-info">
                <div class="debt-item-desc">${escHtml(dt.description || 'Nasiya')}</div>
                <div class="debt-item-date">${dtDate}${dt.dueDate ? ` • Muddat: ${new Date(dt.dueDate).toLocaleDateString('uz-UZ')}${isOverdue ? ' ⚠️' : ''}` : ''}</div>
              </div>
              <div class="debt-item-right">
                <div class="debt-item-bal ${dtBalance <= 0 ? 'debt-zero' : ''}">Qoldi: ${formatPrice(dtBalance)}</div>
                ${dtBalance > 0 ? `<button class="btn-success btn-xs" onclick="openPayDebtModal('${dt.id}'); event.stopPropagation()">💵 To'lash</button>` : '<span style="color:var(--success);font-size:0.75rem">✅ To\'langan</span>'}
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

function saveDebtor() {
  const name = document.getElementById('debtorName').value.trim();
  if (!name) { showToast('⚠️ Ism kiritilishi shart'); return; }

  const existingId = document.getElementById('debtorId').value;
  const phone = document.getElementById('debtorPhone').value.trim();
  const note = document.getElementById('debtorNote').value.trim();

  if (existingId) {
    const d = APP.debtors.find(x => x.id === existingId);
    if (d) { d.name = name; d.phone = phone; d.note = note; }
    showToast(`✅ ${name} yangilandi`);
  } else {
    APP.debtors.unshift({ id: generateId(), name, phone, note, createdAt: new Date().toISOString() });
    showToast(`✅ ${name} qo'shildi`);
  }

  saveNasiyaData();
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

function deleteDebtor(debtorId) {
  const d = APP.debtors.find(x => x.id === debtorId);
  if (!d) return;
  if (debtorBalance(debtorId) > 0) {
    if (!confirm(`⚠️ "${d.name}" da ${formatPrice(debtorBalance(debtorId))} qarz bor! Baribir o'chirishni xohlaysizmi?`)) return;
  } else {
    if (!confirm(`"${d.name}" ni o'chirishni tasdiqlaysizmi?`)) return;
  }
  APP.debtors = APP.debtors.filter(x => x.id !== debtorId);
  APP.debts = APP.debts.filter(x => x.debtorId !== debtorId);
  saveNasiyaData();
  renderDebtors();
  updateNasiyaStats();
  showToast('🗑️ O\'chirildi');
}

// ── Nasiya CRUD ──
function openAddDebtModal(debtorId, debtorName) {
  document.getElementById('debtCustomerId').value = debtorId;
  document.getElementById('addDebtTitle').textContent = `💸 Nasiya — ${debtorName}`;
  document.getElementById('debtAmount').value = '';
  document.getElementById('debtDescription').value = '';
  document.getElementById('debtDueDate').value = '';
  openModal('addDebtModal');
}

function recordDebt() {
  const debtorId = document.getElementById('debtCustomerId').value;
  const amount = parseFloat(document.getElementById('debtAmount').value) || 0;
  if (!debtorId || amount <= 0) { showToast('⚠️ Miqdor kiritilishi shart'); return; }

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
  saveNasiyaData();
  closeModal('addDebtModal');
  renderDebtors();
  updateNasiyaStats();
  const debtor = APP.debtors.find(d => d.id === debtorId);
  showToast(`📒 ${debtor ? debtor.name : 'Mijoz'} ga ${formatPrice(amount)} nasiya kiritildi`);
}

// ── To'lov ──
function openPayDebtModal(debtId) {
  const debt = APP.debts.find(d => d.id === debtId);
  if (!debt) return;
  const debtor = APP.debtors.find(d => d.id === debt.debtorId);
  const balance = debt.amount - debt.paidAmount;
  document.getElementById('payDebtId').value = debtId;
  document.getElementById('payDebtTitle').textContent = `💵 To'lov — ${debtor ? debtor.name : ''}` ;
  document.getElementById('payDebtInfo').innerHTML = `
    <div style="margin-bottom:6px">📝 ${escHtml(debt.description)}</div>
    <div>Jami nasiya: <b>${formatPrice(debt.amount)}</b></div>
    <div>To'landi: <b style="color:var(--success)">${formatPrice(debt.paidAmount)}</b></div>
    <div>Qoldi: <b style="color:var(--danger)">${formatPrice(balance)}</b></div>`;
  document.getElementById('payAmount').value = balance;
  document.getElementById('payNote').value = '';
  openModal('payDebtModal');
}

function submitPayment() {
  const debtId = document.getElementById('payDebtId').value;
  const amount = parseFloat(document.getElementById('payAmount').value) || 0;
  if (!debtId || amount <= 0) { showToast('⚠️ To\'lov miqdori kiritilishi shart'); return; }

  const debt = APP.debts.find(d => d.id === debtId);
  if (!debt) return;

  const balance = debt.amount - debt.paidAmount;
  const paid = Math.min(amount, balance); // ortiqcha qabul qilmaslik
  debt.paidAmount += paid;
  debt.payments = debt.payments || [];
  debt.payments.push({ amount: paid, note: document.getElementById('payNote').value.trim(), date: new Date().toISOString() });

  saveNasiyaData();
  if (typeof SOUNDS !== 'undefined') SOUNDS.cash();
  closeModal('payDebtModal');
  renderDebtors();
  updateNasiyaStats();

  const debtor = APP.debtors.find(d => d.id === debt.debtorId);
  const remaining = debt.amount - debt.paidAmount;
  if (remaining <= 0) {
    showToast(`✅ ${debtor ? debtor.name : 'Mijoz'} ning qarzi to'liq to'landi!`);
  } else {
    showToast(`✅ ${formatPrice(paid)} qabul qilindi. Qoldi: ${formatPrice(remaining)}`);
  }
}

// ── showPage hook: nasiya sahifasi ochilganda render ──
const _nasiyaOrigShowPage = window.showPage;
window.showPage = function (page) {
  _nasiyaOrigShowPage(page);
  if (page === 'nasiya') {
    renderDebtors();
    updateNasiyaStats();
  }
};
