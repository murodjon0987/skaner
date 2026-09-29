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
  cart: [],             // { id, barcode, name, price, qty, category }
  products: [],         // barcha mahsulotlar
  bills: [],            // cheklar tarixi
  settings: {},         // sozlamalar
  currentPage: 'scanner',
  cameraStream: null,
  scanning: false,
  scannerLoop: null,
  barcodeDetector: null,
  lastScanned: '',
  lastScannedTime: 0,
  scanCooldown: 2000,   // ms — bir xil kodni qayta o'qimaslik
  voiceOn: true,
  selectedPayment: 'cash',
  editingProductId: null,
  foundProduct: null,
  currentBillForPrint: null,
};

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
  // 1. OpenFoodFacts (world.openfoodfacts.org)
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=product_name,brands,image_front_url,categories_tags`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.status === 1 && data.product) {
        const p = data.product;
        const name = p.product_name || p.brands || '';
        if (name) {
          return {
            name: name.trim(),
            brand: p.brands || '',
            image: p.image_front_url || null,
            category: detectCategory(p.categories_tags || [], 'oziq'),
          };
        }
      }
    }
  } catch (e) {
    console.warn('OpenFoodFacts xato:', e.message);
  }

  // 2. OpenBeautyFacts (gigiyena mahsulotlari)
  try {
    const res2 = await fetch(
      `https://world.openbeautyfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=product_name,brands,image_front_url`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (res2.ok) {
      const data2 = await res2.json();
      if (data2.status === 1 && data2.product) {
        const p = data2.product;
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
    }
  } catch (e) {
    console.warn('OpenBeautyFacts xato:', e.message);
  }

  return null;
}

/** categories_tags massividan kategoriya aniqlaymiz */
function detectCategory(tags, fallback) {
  const str = tags.join(' ').toLowerCase();
  if (/beverage|drink|water|juice|cola|soda|tea|coffee/.test(str)) return 'ichimlik';
  if (/milk|dairy|cheese|yogurt/.test(str)) return 'sut';
  if (/candy|chocolate|sweet|biscuit|snack|chip|crisp/.test(str)) return 'shirinlik';
  if (/bread|bakery|cereal|grain|rice|pasta|flour/.test(str)) return 'oziq';
  if (/cleaning|detergent|household/.test(str)) return 'uy';
  if (/beauty|cosmetic|shampoo|soap|hygiene/.test(str)) return 'gigiyena';
  return fallback || 'boshqa';
}


// ─────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────
window.initApp = async function () {
  loadSettings();
  loadLocalData();
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
          'ean_13', 'ean_8', 'upc_a', 'upc_e',
          'code_128', 'code_39', 'qr_code', 'itf', 'codabar'
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
};

// Agar Firebase modul allaqachon yuklangan bo'lsa va initApp chaqirilmagan bo'lsa
if (window.firebaseReady) {
  window.initApp();
} else {
  window.addEventListener('appReady', window.initApp);
}

// ─────────────────────────────────────────────
//  ZXING LOADER
// ─────────────────────────────────────────────
function loadZXing() {
  const s = document.createElement('script');
  s.src = 'https://unpkg.com/@zxing/browser@0.1.5/umd/index.min.js';
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
        height: { ideal: 720 },
        focusMode: { ideal: 'continuous' }
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
    });
  } catch (err) {
    console.error('Kamera xatosi:', err);
    cameraOff.style.display = 'flex';
    video.style.display = 'none';
    showToast('Kameraga ruxsat berilmagan. Brauzer sozlamalarini tekshiring.');
  }
}

function stopCamera() {
  if (APP.cameraStream) {
    APP.cameraStream.getTracks().forEach(t => t.stop());
    APP.cameraStream = null;
  }
  APP.scanning = false;
  if (APP.scannerLoop) {
    cancelAnimationFrame(APP.scannerLoop);
    APP.scannerLoop = null;
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
  const hint = document.getElementById('scanHint');

  const loop = async () => {
    if (!APP.scanning) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      try {
        const barcodes = await APP.barcodeDetector.detect(video);
        if (barcodes.length > 0) {
          const bc = barcodes[0];
          handleBarcodeDetected(bc.rawValue);
        }
      } catch (e) {
        // Ignore frame errors
      }
    }

    APP.scannerLoop = requestAnimationFrame(loop);
  };

  loop();
}

// ── ZXing fallback ──
function scanWithZXing() {
  const video = document.getElementById('cameraFeed');

  const loop = () => {
    if (!APP.scanning) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA && zxingReader) {
      const canvas = document.getElementById('scanCanvas');
      const ctx = canvas.getContext('2d');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Faqat ramka sohasini skanerlash (aniqroq)
      const frameX = Math.floor(canvas.width * 0.1);
      const frameY = Math.floor(canvas.height * 0.3);
      const frameW = Math.floor(canvas.width * 0.8);
      const frameH = Math.floor(canvas.height * 0.4);
      const imageData = ctx.getImageData(frameX, frameY, frameW, frameH);

      try {
        const luminanceSource = new window.ZXingBrowser.HTMLCanvasElementLuminanceSource(canvas);
        const hints = new Map();
        const formats = [
          window.ZXing.BarcodeFormat.EAN_13,
          window.ZXing.BarcodeFormat.EAN_8,
          window.ZXing.BarcodeFormat.UPC_A,
          window.ZXing.BarcodeFormat.CODE_128,
        ];
        hints.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
        hints.set(window.ZXing.DecodeHintType.TRY_HARDER, true);
      } catch (e) { /* ignore */ }
    }

    APP.scannerLoop = requestAnimationFrame(loop);
  };

  // ZXing bilan to'g'ri ishlash
  if (zxingReader) {
    const video = document.getElementById('cameraFeed');
    zxingReader.decodeFromVideoElement(video, (result, err) => {
      if (result) {
        handleBarcodeDetected(result.getText());
      }
    }).catch(e => console.warn('ZXing xato:', e));
  } else {
    // ZXing hali yuklanmagan — kutib tur
    setTimeout(() => scanWithZXing(), 1000);
  }
}

// ─────────────────────────────────────────────
//  BARCODE HANDLER
// ─────────────────────────────────────────────
function handleBarcodeDetected(code) {
  if (!code) return;
  code = code.trim();

  const now = Date.now();
  // Cooldown: bir xil kodni qayta o'qimaslik
  if (code === APP.lastScanned && (now - APP.lastScannedTime) < APP.scanCooldown) return;

  APP.lastScanned = code;
  APP.lastScannedTime = now;

  // Flash effekti
  flashScanner();

  // Mahsulotni qidirish
  const product = findProductByBarcode(code);

  if (product) {
    // ✅ Topildi — savatga qo'sh
    addToCart(product);
    showScanSuccess(product);
    announceVoice(product.name, product.price);
    updateScanHint(`✅ ${product.name}`, 'success');
  } else {
    // ❌ Mahalliy bazada topilmadi — internetdan qidiramiz
    updateScanHint(`🌐 Internet dan qidirilmoqda...`, 'success');
    showToast(`🌐 Kod: ${code} — internet bazasidan qidirilmoqda...`);
    vibrateDevice([100, 50, 100]);

    // Async internet qidiruv
    lookupBarcodeOnline(code).then(result => {
      if (result) {
        // ✅ Internet da topildi — modalni avtomatik to'ldirish
        updateScanHint(`✅ Internetdan topildi: ${result.name}`, 'success');
        showToast(`✅ "${result.name}" topildi! Narxni kiriting.`);
        vibrateDevice([80, 40, 80]);
        // Modalni ochib, ma'lumotlarni to'ldirish
        openAddProductModalWithData(result, code);
      } else {
        // ❌ Internetda ham topilmadi
        showProductFoundCard(null, code);
        updateScanHint(`❌ Kod: ${code} — hech qayerda topilmadi`, 'error');
        showToast(`❌ "${code}" topilmadi. Qo'lda kiriting.`);
        // Yangi mahsulot qo'shish modali
        openAddProductModalWithData({ name: '', image: null, category: 'boshqa', brand: '' }, code);
      }
    }).catch(() => {
      showProductFoundCard(null, code);
      updateScanHint(`❌ Internet yo'q — qo'lda kiriting`, 'error');
    });
  }

  // 2 soniyadan keyin hint qaytarish
  setTimeout(() => updateScanHint('Shtrix-kodni ramka ichiga oling', ''), 6000);
}

function findProductByBarcode(code) {
  return APP.products.find(p =>
    p.barcode === code ||
    p.barcode === code.replace(/^0+/, '') // leading zero ni olib tashlash
  );
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
  const code = input.value.trim();
  if (!code) { showToast('Shtrix-kod kiriting'); return; }

  const product = findProductByBarcode(code);
  if (product) {
    showProductFoundCard(product, code);
    announceVoice(product.name, product.price);
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
//  CART (SAVAT)
// ─────────────────────────────────────────────
function addToCart(product) {
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
  if (item.qty <= 0) {
    APP.cart = APP.cart.filter(i => i.id !== productId);
  }
  updateCartUI();
}

function clearCart() {
  if (APP.cart.length === 0) return;
  APP.cart = [];
  updateCartUI();
  showToast('Savat tozalandi');
}

function updateCartUI() {
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

  const catEmoji = {
    ichimlik: '🥤', oziq: '🍞', shirinlik: '🍬',
    sut: '🥛', uy: '🏠', gigiyena: '🧴', boshqa: '📦'
  };

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
    document.getElementById(`pm-${t}`).classList.toggle('active', t === type);
  });
  document.getElementById('cashChangeSection').style.display = type === 'cash' ? 'block' : 'none';
}

function calcChange() {
  const subtotal = APP.cart.reduce((s, i) => s + i.price * i.qty, 0);
  const tax = subtotal * (parseFloat(APP.settings.taxRate || 0) / 100);
  const grand = subtotal + tax;
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
  const pct = parseFloat(document.getElementById('discountPercent').value) || 0;
  const subtotal = APP.cart.reduce((s, i) => s + i.price * i.qty, 0);
  const discount = subtotal * (pct / 100);
  const tax = subtotal * (parseFloat(APP.settings.taxRate || 0) / 100);
  const grand = subtotal - discount + tax;
  document.getElementById('checkoutAmount').textContent = formatPrice(Math.max(grand, 0));
}

async function completeSale() {
  const subtotal = APP.cart.reduce((s, i) => s + i.price * i.qty, 0);
  const discountPct = parseFloat(document.getElementById('discountPercent').value) || 0;
  const discount = subtotal * (discountPct / 100);
  const tax = subtotal * (parseFloat(APP.settings.taxRate || 0) / 100);
  const grand = Math.max(subtotal - discount + tax, 0);

  // Naqd to'lovda yetarlilik tekshiruvi
  if (APP.selectedPayment === 'cash') {
    const given = parseFloat(document.getElementById('cashGiven').value) || 0;
    if (given > 0 && given < grand) {
      showToast('Yetarli pul kiritilmagan');
      return;
    }
  }

  const bill = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    items: APP.cart.map(i => ({ ...i })),
    subtotal,
    discount,
    tax,
    total: grand,
    paymentMethod: APP.selectedPayment,
    shopName: APP.settings.shopName || 'ScanPOS',
    cashGiven: APP.selectedPayment === 'cash' ? (parseFloat(document.getElementById('cashGiven').value) || 0) : 0,
  };

  // Firebase yoki localStorage ga saqlash
  await saveBill(bill);

  // Ovozli e'lon
  announceVoice(`Jami ${formatPriceVoice(grand)}. To'lov qabul qilindi!`, 0);

  closeModal('checkoutModal');
  APP.cart = [];
  updateCartUI();
  showToast(`✅ To'lov qabul qilindi! ${formatPrice(grand)}`);

  // Chek sahifasiga o'tish
  setTimeout(() => {
    showPage('bills');
    vibrateDevice([100, 50, 200]);
  }, 800);
}

// ─────────────────────────────────────────────
//  VOICE (OVOZLI E'LON)
// ─────────────────────────────────────────────
function announceVoice(name, price) {
  if (!APP.voiceOn) return;
  if (!window.speechSynthesis) return;

  window.speechSynthesis.cancel();

  const lang = APP.settings.voiceLang || 'uz-UZ';
  let text;

  if (lang === 'uz-UZ' || lang === 'uz') {
    text = price > 0
      ? `${name}, narxi ${formatPriceVoice(price)}`
      : name;
  } else if (lang === 'ru-RU') {
    text = price > 0
      ? `${name}, цена ${formatPriceVoice(price)} сумов`
      : name;
  } else {
    text = price > 0
      ? `${name}, price ${formatPriceVoice(price)} soums`
      : name;
  }

  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = lang;
  utt.rate = 1.1;
  utt.pitch = 1.0;
  utt.volume = 1.0;

  // Mavjud ovozlardan mos tilni tanlash
  const voices = window.speechSynthesis.getVoices();
  const match = voices.find(v => v.lang.startsWith(lang.split('-')[0]));
  if (match) utt.voice = match;

  window.speechSynthesis.speak(utt);
}

function formatPriceVoice(amount) {
  if (amount >= 1000000) return `${(amount / 1000000).toFixed(1)} million so'm`;
  if (amount >= 1000) return `${Math.round(amount / 1000)} ming so'm`;
  return `${Math.round(amount)} so'm`;
}

function toggleVoice() {
  APP.voiceOn = !APP.voiceOn;
  APP.settings.voiceEnabled = APP.voiceOn;
  document.getElementById('voiceEnabled').checked = APP.voiceOn;
  saveSettings();
  updateVoiceBtn();
  showToast(APP.voiceOn ? '🔊 Ovoz yoqildi' : '🔇 Ovoz o\'chirildi');
}

function updateVoiceBtn() {
  APP.voiceOn = document.getElementById('voiceEnabled')?.checked ?? true;
  const btn = document.getElementById('voiceToggle');
  if (!btn) return;
  if (APP.voiceOn) {
    btn.classList.add('active');
    btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
    </svg>`;
  } else {
    btn.classList.remove('active');
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
  document.getElementById('productCategory').value = product?.category || 'boshqa';
  document.getElementById('editProductId').value = product?.id || '';

  // Rasm holati
  setModalProductImage(product?.image || null);

  // Internet badge ni tozalash
  document.getElementById('onlineBadge')?.remove();
  openModal('addProductModal');
}

/**
 * Internet bazasidan topilgan ma'lumotlar bilan modalni ochadi.
 * Foydalanuvchi faqat narxni kiritadi.
 */
function openAddProductModalWithData(onlineData, barcode) {
  APP.editingProductId = null;
  document.getElementById('modalTitle').textContent = '🌐 Internetdan topildi';
  document.getElementById('productName').value = onlineData.name || '';
  document.getElementById('productBarcode').value = barcode || '';
  document.getElementById('productPrice').value = '';
  document.getElementById('productStock').value = '0';
  document.getElementById('productCategory').value = onlineData.category || 'boshqa';
  document.getElementById('editProductId').value = '';

  // Haqiqiy topilgan rasm
  setModalProductImage(onlineData.image || null);

  // "Internet dan topildi" badge
  const existingBadge = document.getElementById('onlineBadge');
  if (existingBadge) existingBadge.remove();
  if (onlineData.name) {
    const badge = document.createElement('div');
    badge.id = 'onlineBadge';
    badge.style.cssText = 'background:linear-gradient(135deg,rgba(34,197,94,0.2),rgba(6,182,212,0.2));border:1px solid rgba(34,197,94,0.4);border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:0.8rem;color:#22c55e;display:flex;align-items:center;gap:6px';
    badge.innerHTML = `🌐 <span>Ma'lumot internetdan avtomatik to'ldirildi${onlineData.brand ? ' — ' + escHtml(onlineData.brand) : ''}</span>`;
    const modalBody = document.querySelector('#addProductModal .modal-body');
    if (modalBody) modalBody.insertBefore(badge, modalBody.firstChild);
  }

  // Narx maydoniga focus
  openModal('addProductModal');
  setTimeout(() => document.getElementById('productPrice')?.focus(), 300);
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
  const barcode = document.getElementById('productBarcode').value.trim();
  const price = parseFloat(document.getElementById('productPrice').value);
  const stock = parseInt(document.getElementById('productStock').value) || 0;
  const category = document.getElementById('productCategory').value;
  const image = document.getElementById('productImage')?.value || null;

  if (!name) { showToast('Mahsulot nomini kiriting'); return; }
  if (!barcode) { showToast('Shtrix-kodni kiriting'); return; }
  if (!price || price <= 0) { showToast('Narxni to\'g\'ri kiriting'); return; }

  // Takroriy shtrix-kod tekshiruvi (tahrirlashdan tashqari)
  const existing = APP.products.find(p => p.barcode === barcode && p.id !== APP.editingProductId);
  if (existing) {
    showToast(`Bu shtrix-kod allaqachon: ${existing.name}`);
    return;
  }

  const product = {
    id: APP.editingProductId || generateId(),
    name, barcode,
    price: Math.round(price),
    stock,
    category,
    image,
    updatedAt: new Date().toISOString(),
  };

  if (!APP.editingProductId) {
    product.createdAt = new Date().toISOString();
  }

  await saveProductToDB(product);
  closeModal('addProductModal');
  showToast(APP.editingProductId ? `${name} yangilandi` : `${name} qo'shildi ✅`);
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

  const catEmoji = {
    ichimlik: '🥤', oziq: '🍞', shirinlik: '🍬',
    sut: '🥛', uy: '🏠', gigiyena: '🧴', boshqa: '📦'
  };

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
  showToast('Shtrix-kodni skanerlang — u avtomatik kiritiladi');
  // Keyingi skanlashda barcode ni modal input ga yozish
  APP._scanForModal = true;
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
  try {
    const p = localStorage.getItem('scanpos_products');
    const b = localStorage.getItem('scanpos_bills');
    if (p) APP.products = JSON.parse(p);
    if (b) APP.bills = JSON.parse(b);
  } catch { }
}

function saveLocalData() {
  localStorage.setItem('scanpos_products', JSON.stringify(APP.products));
  localStorage.setItem('scanpos_bills', JSON.stringify(APP.bills));
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
  // Modal ochiq bo'lsa — ignore
  if (document.querySelector('.modal-overlay.open')) return;

  if (e.key === 'Enter' && hwBuffer.length > 4) {
    handleBarcodeDetected(hwBuffer);
    hwBuffer = '';
    clearTimeout(hwTimer);
    return;
  }

  if (e.key.length === 1) {
    hwBuffer += e.key;
    clearTimeout(hwTimer);
    hwTimer = setTimeout(() => { hwBuffer = ''; }, 300);
  }
});

// ─────────────────────────────────────────────
//  MODAL OUTSIDE CLICK
// ─────────────────────────────────────────────
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
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

  // ── Revenue chart (kunlik) ──
  buildRevenueChart(filtered, days);

  // ── Payment pie chart ──
  buildPaymentChart(filtered);

  // ── TOP-5 products ──
  buildTopProducts(filtered);

  // ── Hourly chart (bugun) ──
  buildHourlyChart();
}

/** Kunlik savdo grafigi (line chart) */
function buildRevenueChart(bills, days) {
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
  const today = new Date().toDateString();
  const todayBills = APP.bills.filter(b => new Date(b.timestamp).toDateString() === today);

  const hours = Array(24).fill(0);
  todayBills.forEach(b => {
    const h = new Date(b.timestamp).getHours();
    hours[h] += b.total;
  });

  // Faqat 6:00–23:00 ni ko'rsat
  const labels = Array.from({ length: 18 }, (_, i) => `${i + 6}:00`);
  const data = hours.slice(6, 24).map(v => Math.round(v / 1000));

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
const _origRenderBills = window.renderBills || (() => {});
window.renderAnalyticsIfOpen = function () {
  if (APP.currentPage === 'analytics') renderAnalytics();
};

window.switchAnalyticsPeriod = window.switchAnalyticsPeriod;
window.renderAnalytics = renderAnalytics;

